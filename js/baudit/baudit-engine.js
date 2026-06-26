// baudit-engine.js — Baudit analysis engine, playback, recording, waveform draw, UI
// Depends on: baudit-worker.js (loaded as a separate Worker file)

// Worker is inlined as a blob URL so it works on file:// and any server
const _WORKER_SRC = `
'use strict';

function monoDecimate(channelArrays, totalLen) {
  const step = 4, outLen = Math.ceil(totalLen / step);
  const mono = new Float32Array(outLen), nCh = channelArrays.length;
  for (let i = 0; i < outLen; i++) {
    let v = 0;
    for (let c = 0; c < nCh; c++) v += channelArrays[c][i * step] || 0;
    mono[i] = v / nCh;
  }
  return mono;
}

function buildEnvelope(mono, srDec) {
  const fs = 256, hs = 128, N = mono.length;
  const nF = Math.floor((N - fs) / hs);
  const env = new Float32Array(nF);
  let prevE = 0;
  for (let f = 0; f < nF; f++) {
    const s = f * hs; let e = 0;
    for (let i = s; i < s + fs; i++) e += mono[i] * mono[i];
    e /= fs; env[f] = Math.max(0, e - prevE); prevE = e;
  }
  const sm = new Float32Array(nF), W = 2;
  let sum = 0;
  for (let i = 0; i < Math.min(W, nF); i++) sum += env[i];
  for (let i = 0; i < nF; i++) {
    if (i + W < nF) sum += env[i + W];
    if (i - W - 1 >= 0) sum -= env[i - W - 1];
    sm[i] = sum / Math.min(2*W+1, nF);
  }
  return { envelope: sm, fps: srDec / hs, hopSize: hs };
}

// ── BPM ESTIMATION — harmonic-weighted autocorrelation ──
// Root cause of the >75s bug: raw autocorrelation scores are nearly identical
// across many lags for complex beatbox audio (differences in the 5th decimal place).
// A tiny noise accumulation difference between 75s and 80s files was enough to
// flip the winner from lag=59 (88 BPM, correct) to lag=29 (178 BPM, wrong).
//
// Fix: harmonic weighting. For each candidate lag L, the score is boosted by
// how well its half-period (L/2) and double-period (L*2) also score.
// The correct tempo's harmonics reinforce each other; spurious peaks don't.
// This makes the correct lag win by a much larger margin, stably across any duration.
// Also normalises the envelope to unit std-dev so absolute energy doesn't skew results,
// and caps analysis to first 45s (always enough beats, avoids late-file noise).
function estimateBPM(envelope, fps) {
  const N = envelope.length;
  const minL = Math.floor(fps / 4);    // 240 BPM ceiling
  const maxL = Math.min(Math.ceil(fps / 0.8), Math.floor(N / 2)); // 48 BPM floor

  // Cap to first 45 seconds — enough for 45+ beats at any tempo
  const af = Math.min(N, Math.round(fps * 45));

  // Normalise envelope to unit std-dev so energy level doesn't bias scores
  let mean = 0, sq = 0;
  for (let i = 0; i < af; i++) mean += envelope[i];
  mean /= af;
  for (let i = 0; i < af; i++) { const d = envelope[i] - mean; sq += d*d; }
  const std = Math.sqrt(sq / af) || 1;
  const ev = new Float32Array(af);
  for (let i = 0; i < af; i++) ev[i] = (envelope[i] - mean) / std;

  // Base autocorrelation scores
  const base = new Float64Array(maxL + 1);
  for (let lag = minL; lag <= maxL; lag++) {
    const Nl = af - lag;
    if (Nl < 10) continue;
    let s = 0;
    for (let i = 0; i < Nl; i += 2) s += ev[i] * ev[i + lag];
    base[lag] = s / (Nl / 2);
  }

  // Harmonic-enhanced scores: reward lags whose harmonics also score well
  let bestL = minL, best = -Infinity;
  for (let lag = minL; lag <= maxL; lag++) {
    let score = base[lag];
    // Double-period (half tempo — sub-beat emphasis)
    const h2 = lag * 2;
    if (h2 <= maxL) score += 0.5 * base[h2];
    // Half-period (double tempo — super-beat)
    const hHalf = Math.round(lag / 2);
    if (hHalf >= minL) score += 0.5 * base[hHalf];
    if (score > best) { best = score; bestL = lag; }
  }

  let bpm = (fps / bestL) * 60;
  while (bpm < 60)  bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return bpm;
}

// ── ADAPTIVE BEAT TRACKING ──
// Predicts each beat from the LAST DETECTED beat + period,
// so phase shifts after tempo wobbles don't break tracking.
function trackBeats(envelope, fps, bpm) {
  const period = fps * 60 / bpm;
  const N = envelope.length;
  const half = Math.max(2, Math.floor(period * 0.35));

  let mean = 0;
  for (let i = 0; i < N; i++) mean += envelope[i];
  mean /= N;
  const silenceThresh = mean * 0.4;

  // Seed: strongest peak in the first 2 periods
  let seedI = -1, seedV = silenceThresh;
  const seedEnd = Math.min(N, Math.ceil(period * 2));
  for (let i = 1; i < seedEnd - 1; i++) {
    if (envelope[i] > seedV && envelope[i] >= envelope[i-1] && envelope[i] >= envelope[i+1]) {
      seedV = envelope[i]; seedI = i;
    }
  }
  if (seedI < 0) return [];

  const beats = [{ frame: seedI, slot: 0, strength: envelope[seedI], real: true }];
  let expected = seedI + period;
  let slot = 1;

  while (expected < N - 1) {
    const center = Math.round(expected);
    const lo = Math.max(0, center - half);
    const hi = Math.min(N - 1, center + half);
    let bi = -1, bv = silenceThresh;
    for (let i = lo; i <= hi; i++) {
      if (envelope[i] > bv && envelope[i] >= envelope[Math.max(0,i-1)] && envelope[i] >= envelope[Math.min(N-1,i+1)]) {
        bv = envelope[i]; bi = i;
      }
    }
    if (bi >= 0) {
      beats.push({ frame: bi, slot, strength: bv, real: true });
      expected = bi + period;   // adaptive: follow the actual beat
    } else {
      expected += period;       // silence — advance grid virtually
    }
    slot++;
  }
  return beats;
}

// ── DRIFT DETECTION from consecutive-beat intervals ──
function findIssues(beats, fps, bpm, duration) {
  const issues = [];
  if (beats.length < 3) return issues;
  const beatSec = 60 / bpm;
  const tolSec = Math.max(0.025, beatSec * 0.08);

  const flags = [];
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i-1], cur = beats[i];
    const slotGap = cur.slot - prev.slot;
    if (slotGap > 2) continue;
    const target = slotGap * beatSec;
    const actual = (cur.frame - prev.frame) / fps;
    const dev = actual - target;
    if (Math.abs(dev) > tolSec) {
      flags.push({ start: prev.frame/fps, end: cur.frame/fps, type: dev < 0 ? 'fast' : 'slow', devSec: Math.abs(dev) });
    }
  }

  let idx = 1, i = 0;
  while (i < flags.length) {
    const f = flags[i];
    let end = f.end, maxDev = f.devSec;
    while (i + 1 < flags.length && flags[i+1].type === f.type && flags[i+1].start <= end + beatSec * 0.6) {
      i++; end = flags[i].end;
      if (flags[i].devSec > maxDev) maxDev = flags[i].devSec;
    }
    issues.push({
      id: '#' + String(idx++).padStart(3,'0'),
      start: f.start, end, duration: end - f.start,
      type: f.type, devMs: Math.round(maxDev*1000),
      startNorm: f.start/duration, endNorm: end/duration
    });
    i++;
  }
  return issues;
}

function buildWaveData(channelArrays, totalLen, N) {
  const step = totalLen / N, nCh = channelArrays.length;
  const data = new Float32Array(N);
  for (let b = 0; b < N; b++) {
    const s = Math.floor(b*step), e = Math.floor((b+1)*step);
    let peak = 0;
    for (let c = 0; c < nCh; c++) { const ch=channelArrays[c]; for(let i=s;i<e;i++){const v=Math.abs(ch[i]);if(v>peak)peak=v;} }
    data[b] = peak;
  }
  return data;
}

function bakeColors(N, issues, duration, isCompare) {
  const colors = new Uint8Array(N);
  issues.forEach(iss => {
    const s = Math.round(iss.startNorm*N), e = Math.round(iss.endNorm*N);
    const v = iss.type==='fast' ? 1 : 2;
    for (let i=s; i<=Math.min(e,N-1); i++) colors[i]=v;
  });
  return colors;
}

self.onmessage = function(e) {
  const {channelArrays: rawBuffers, totalLen, SR, isCompare} = e.data;
  const post = pct => self.postMessage({type:'progress', pct});

  // Wrap transferred ArrayBuffers into typed array views
  const channelArrays = rawBuffers.map(b => new Float32Array(b));

  post(10);
  const mono = monoDecimate(channelArrays, totalLen);
  post(25);
  const {envelope, fps, hopSize} = buildEnvelope(mono, SR/4);
  post(45);
  const bpmF = estimateBPM(envelope, fps);
  post(55);
  const beats = trackBeats(envelope, fps, bpmF);
  post(65);
  const duration = totalLen / SR;
  const issues = findIssues(beats, fps, bpmF, duration);
  const maxDev = issues.length ? Math.max(...issues.map(x=>x.devMs)) : 0;
  const beatSecs = beats.map(b => (b.frame * hopSize * 4) / SR);
  post(80);
  const waveData = buildWaveData(channelArrays, totalLen, 600);
  post(92);
  const colorIndex = bakeColors(600, issues, duration, isCompare);
  post(100);
  self.postMessage({
    type:'done',
    result:{bpm: Math.round(bpmF), beats: beatSecs, issues, duration, maxDev},
    waveData: waveData.buffer,
    colorIndex: colorIndex.buffer
  }, [waveData.buffer, colorIndex.buffer]);
};
`;
const WORKER_URL = URL.createObjectURL(new Blob([_WORKER_SRC], {type:'text/javascript'}));
// ══════════════════════════════════════════════════════════
//  BAUDIT ENGINE
// ══════════════════════════════════════════════════════════
const Baudit = (() => {
  let audioCtx=null, primaryBuffer=null, compareBuffer=null;
  let primarySource=null, startTime=0, startOffset=0, isPlaying=false;
  let analysisResult=null, compareResult=null;
  let recInterval=null, recSeconds=0, recState=null;
  let isRecording=false, snippetBtn=null;
  let compareSource=null;
  let primaryFilename='session', compareFilename='';
  let primaryIssues=[], compareIssuesData=[], currentIssuesPage=1;
  let cmpIsRecording=false, cmpRecState=null, cmpRecSeconds=0, cmpRecInterval=null;
  const MAX_REC_SECS=120;

  const tlCanvas  = document.getElementById('timeline-canvas');
  const cmpCanvas = document.getElementById('compare-canvas');
  const DPR = Math.min(window.devicePixelRatio||1,2);

  let primaryWaveData=null, primaryColors=null;
  let compareWaveData=null, compareColors=null;
  let tlDims=null, cmpDims=null;

  // ── SINGLE RAF HANDLE — prevents stacking loops ──
  let animRafId = null;
  let primaryPlayheadNorm = 0, comparePlayheadNorm = 0;
  let lastPrimaryNorm = -1, lastCmpNorm = -1;
  let sensitivityThreshold = 0;
  let filteredPrimaryIssues, filteredCompareIssues;

  const PALETTE_BRIGHT=['rgba(0,245,212,0.85)','rgba(255,51,102,0.9)','rgba(255,200,50,0.9)','rgba(140,100,255,0.85)'];
  const PALETTE_DIM   =['rgba(0,245,212,0.18)','rgba(255,51,102,0.25)','rgba(255,200,50,0.22)','rgba(140,100,255,0.18)'];

  function getAudioCtx() {
    if (!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    return audioCtx;
  }
  function fmt(sec) {
    sec=Math.max(0,sec);
    return Math.floor(sec/60)+':'+String(Math.floor(sec%60)).padStart(2,'0');
  }
  function setProgress(pct,msg) {
    const f=document.getElementById('progress-fill'), m=document.getElementById('processing-msg');
    if(f) f.style.width=pct+'%';
    if(m&&msg) m.textContent=msg;
  }

  // ── CANVAS DIMS — cached, only reset on resize ──
  function getDims(canvas, cached) {
    if (cached && cached.dW) return cached;
    const r=canvas.getBoundingClientRect();
    if (!r.width) return {dW:0,dH:0};
    canvas.width=Math.floor(r.width*DPR);
    canvas.height=Math.floor(r.height*DPR);
    return {dW:r.width, dH:r.height};
  }
  window.addEventListener('resize',()=>{
    tlDims=null; cmpDims=null; lastPrimaryNorm=-1; lastCmpNorm=-1;
    if (analysisResult&&primaryWaveData) drawCanvas(tlCanvas,primaryWaveData,primaryColors,primaryPlayheadNorm,filteredPrimaryIssues);
    if (compareResult&&compareWaveData)  drawCanvas(cmpCanvas,compareWaveData,compareColors,comparePlayheadNorm,filteredCompareIssues);
  },{passive:true});

  // Re-bake color array on the main thread when sensitivity threshold changes.
  // Issues below threshold get bucket 4 (dim teal); others keep fast/slow coloring.
  function rebakeColors(issues, thresholdMs) {
    const N = 600;
    const colors = new Uint8Array(N);
    issues.forEach(iss => {
      const s = Math.round(iss.startNorm * N);
      const e = Math.min(Math.round(iss.endNorm * N), N - 1);
      if (iss.devMs < thresholdMs) {
        for (let i = s; i <= e; i++) colors[i] = 0; // bright teal (PALETTE_BRIGHT[0])
      } else {
        const v = iss.type === 'fast' ? 1 : 2;
        for (let i = s; i <= e; i++) colors[i] = v;
      }
    });
    return colors;
  }

  // ══════════════════════════════════════════════════════
  //  DRAW WAVEFORM — bars BATCHED by color (8 paths max)
  //  This replaces 600 individual ctx.fill() calls with
  //  at most 8 batched fills — ~75× fewer GPU draw calls.
  // ══════════════════════════════════════════════════════
  function drawCanvas(canvas, waveData, colorIndex, playheadNorm, issuesOverride) {
    if (!canvas||!waveData||!colorIndex) return;
    const ctx=canvas.getContext('2d');
    const dims = canvas===tlCanvas
      ? (tlDims  = getDims(canvas, tlDims))
      : (cmpDims = getDims(canvas, cmpDims));
    if (!dims.dW) return;

    const {dW,dH}=dims;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.save(); ctx.scale(DPR,DPR);

    const N=waveData.length;
    const bW=Math.max(0.8, dW/N - 0.5);
    const mid=dH/2;
    const ph=playheadNorm!==null ? playheadNorm : 1;
    const res=canvas===tlCanvas ? analysisResult : compareResult;

    // Beat grid — ONE batched path for all lines
    if (res&&res.beats&&res.duration) {
      ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
      ctx.beginPath();
      res.beats.forEach(b=>{const x=(b/res.duration)*dW; ctx.moveTo(x,0); ctx.lineTo(x,dH);});
      ctx.stroke();
    }

    // ── BATCHED BAR DRAWING ──
    // Group bars into 8 buckets: [bright0,bright1,bright2,bright3, dim0,dim1,dim2,dim3]
    // Build one Path2D (or just one beginPath sequence) per bucket, then fill once.
    const buckets = Array.from({length:8}, ()=>[]);
    for (let i=0;i<N;i++) {
      const xNorm=i/N;
      const x=xNorm*dW;
      const barH=Math.max(2,waveData[i]*dH*0.85);
      const ci=colorIndex[i];
      const bucket = ci;
      buckets[bucket].push({x:x+0.3, y:mid-barH/2, w:Math.max(0.8,bW), h:barH});
    }
    buckets.forEach((bars,bi)=>{
      if (!bars.length) return;
      ctx.fillStyle = bi<4 ? PALETTE_BRIGHT[bi] : PALETTE_DIM[bi-4];
      ctx.beginPath();
      bars.forEach(b=>ctx.rect(b.x,b.y,b.w,b.h));
      ctx.fill();
    });

    // Issue top markers — use issuesOverride when sensitivity filtering is active
    const displayIssues = issuesOverride !== undefined ? issuesOverride : (res ? res.issues : []);
    displayIssues.forEach(iss=>{
      const x1=iss.startNorm*dW, x2=iss.endNorm*dW;
      const c=iss.type==='fast'?'255,51,102':'255,200,50';
      ctx.fillStyle=`rgba(${c},0.4)`; ctx.fillRect(x1,0,x2-x1,5);
      ctx.fillStyle=`rgba(${c},1)`;   ctx.fillRect(x1,0,2,5); ctx.fillRect(x2-2,0,2,5);
    });

    // Playhead
    if (playheadNorm!==null) {
      const px=playheadNorm*dW;
      ctx.strokeStyle='rgba(255,255,255,0.9)'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px,dH); ctx.stroke();
      ctx.fillStyle='#fff';
      ctx.beginPath(); ctx.moveTo(px-6,0); ctx.lineTo(px+6,0); ctx.lineTo(px,8); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // ── PLAYBACK ──
  function resetSnippetBtn() {
    if (snippetBtn) {
      snippetBtn.classList.remove('issue-btn-playing');
      const icon = snippetBtn.querySelector('.issue-btn-icon');
      if (icon) icon.textContent = '▷';
      snippetBtn = null;
    }
  }
  // Pause: captures the current position so resume continues from the same spot.
  // capturePos=false is used internally when we're about to start a new source.
  function stopPlayback(capturePos = true) {
    if (isPlaying && capturePos) startOffset = getCurrentSec();
    if (primarySource) {
      primarySource.onended = null;
      try { primarySource.stop(); } catch(e) {}
      primarySource = null;
    }
    if (compareSource) {
      compareSource.onended = null;
      try { compareSource.stop(); } catch(e) {}
      compareSource = null;
    }
    isPlaying = false;
    resetSnippetBtn();
    const btn = document.getElementById('play-btn');
    if (btn) btn.textContent = '▶';
  }
  function startPlayback(offsetSec) {
    if (!primaryBuffer && !compareBuffer) return;
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    stopPlayback(false);
    const t1El = document.getElementById('play-track-1');
    const t2El = document.getElementById('play-track-2');
    const doPrimary = !!primaryBuffer && (!t1El || t1El.checked);
    const doCompare = !!compareBuffer && !!(t2El && t2El.checked);
    if (!doPrimary && !doCompare) return;
    const refBuf = doPrimary ? primaryBuffer : compareBuffer;
    let off = Math.max(0, offsetSec);
    if (off >= refBuf.duration - 0.05) off = 0;
    if (doPrimary) {
      const pOff = Math.min(off, primaryBuffer.duration - 0.05);
      primarySource = ctx.createBufferSource();
      primarySource.buffer = primaryBuffer;
      primarySource.connect(ctx.destination);
      primarySource.start(0, pOff);
      primarySource.onended = () => {
        isPlaying = false; primarySource = null; startOffset = 0;
        if (compareSource) { try { compareSource.stop(); } catch(e){} compareSource = null; }
        const b = document.getElementById('play-btn'); if (b) b.textContent = '▶';
      };
    }
    if (doCompare) {
      const cOff = Math.min(off, compareBuffer.duration - 0.05);
      compareSource = ctx.createBufferSource();
      compareSource.buffer = compareBuffer;
      compareSource.connect(ctx.destination);
      compareSource.start(0, cOff);
      if (!doPrimary) {
        compareSource.onended = () => {
          isPlaying = false; compareSource = null; startOffset = 0;
          const b = document.getElementById('play-btn'); if (b) b.textContent = '▶';
        };
      } else {
        compareSource.onended = () => { compareSource = null; };
      }
    }
    startTime = ctx.currentTime; startOffset = off; isPlaying = true;
    const btn = document.getElementById('play-btn'); if (btn) btn.textContent = '⏸';
  }
  // Plays ONLY the issue span: start(when, offset, duration) auto-stops at the end of the snippet.
  function playSnippet(startSec, durSec, btn) {
    const snippetBuf = (currentIssuesPage === 2 && compareBuffer) ? compareBuffer : primaryBuffer;
    if (!snippetBuf) return;
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    stopPlayback(false);
    primarySource = ctx.createBufferSource();
    primarySource.buffer = snippetBuf;
    primarySource.connect(ctx.destination);
    primarySource.start(0, startSec, durSec);
    primarySource.onended = () => {
      isPlaying = false; primarySource = null;
      startOffset = startSec + durSec;  // park playhead at snippet end
      const b = document.getElementById('play-btn'); if (b) b.textContent = '▶';
      resetSnippetBtn();
    };
    startTime = ctx.currentTime; startOffset = startSec; isPlaying = true;
    const playBtn = document.getElementById('play-btn'); if (playBtn) playBtn.textContent = '⏸';
    snippetBtn = btn;
    btn.classList.add('issue-btn-playing');
    const icon = btn.querySelector('.issue-btn-icon');
    if (icon) icon.textContent = '◼';
  }
  function getCurrentSec() {
    if (!isPlaying || !audioCtx) return startOffset;
    return startOffset + (audioCtx.currentTime - startTime);
  }

  // ── ANIMATION LOOP — single handle, never double-started ──
  function startAnimLoop() {
    if (animRafId!==null) cancelAnimationFrame(animRafId);
    lastPrimaryNorm=-1; lastCmpNorm=-1;

    function tick() {
      if (!analysisResult) { animRafId=null; return; }
      const cur=getCurrentSec();
      const selVisible=document.getElementById('track-selector')?.style.display!=='none';
      const t1El=document.getElementById('play-track-1');
      const t2El=document.getElementById('play-track-2');
      const t1Active=!selVisible||!t1El||t1El.checked;
      const t2Active=selVisible&&!!(t2El&&t2El.checked)&&!!compareResult;

      // Only advance a track's playhead while it is actively playing
      if (isPlaying&&t1Active) primaryPlayheadNorm=Math.min(1,cur/analysisResult.duration);
      if (isPlaying&&t2Active) comparePlayheadNorm=Math.min(1,cur/compareResult.duration);

      const threshold=0.5/(tlDims?tlDims.dW:800);
      if (Math.abs(primaryPlayheadNorm-lastPrimaryNorm)>=threshold||Math.abs(comparePlayheadNorm-lastCmpNorm)>=threshold) {
        lastPrimaryNorm=primaryPlayheadNorm; lastCmpNorm=comparePlayheadNorm;
        const phEl=document.getElementById('playhead-time');
        if(phEl) phEl.textContent=fmt(Math.min(cur,analysisResult.duration));
        drawCanvas(tlCanvas,primaryWaveData,primaryColors,primaryPlayheadNorm,filteredPrimaryIssues);
        const cmpWrap=document.getElementById('compare-wave-wrap');
        if(compareResult&&compareWaveData&&cmpWrap&&cmpWrap.style.display!=='none') {
          drawCanvas(cmpCanvas,compareWaveData,compareColors,comparePlayheadNorm,filteredCompareIssues);
          const cphEl=document.getElementById('cmp-playhead-time');
          if(cphEl) cphEl.textContent=fmt(Math.min(cur,compareResult.duration));
        }
      }
      animRafId=requestAnimationFrame(tick);
    }
    animRafId=requestAnimationFrame(tick);
  }

  // ── RENDER ISSUES GRID ──
  function renderIssues(issues, totalCount) {
    const grid=document.getElementById('issues-grid');
    const noIssEl=document.getElementById('no-issues-msg');
    const countEl=document.getElementById('issues-count-label');
    const total = totalCount !== undefined ? totalCount : issues.length;
    grid.innerHTML='';
    if (!issues.length) {
      noIssEl.style.display='block';
      noIssEl.textContent = total > 0
        ? `No issues above ${sensitivityThreshold}ms threshold`
        : '✓ No timing issues — your groove is locked in!';
      if(countEl) countEl.textContent = total > 0
        ? `0 / ${total} issues`
        : 'No issues found';
    } else {
      noIssEl.style.display='none';
      if(countEl) countEl.textContent = total !== issues.length
        ? `${issues.length} / ${total} issues`
        : `${issues.length} issue${issues.length!==1?'s':''} found`;
      const frag=document.createDocumentFragment();
      issues.forEach(iss=>{
        const fast=iss.type==='fast';
        const btn=document.createElement('button');
        btn.className=`issue-btn ${fast?'issue-btn-fast':'issue-btn-slow'}`;
        btn.dataset.start=iss.start;
        btn.dataset.dur=iss.duration;
        btn.innerHTML=`
          <div class="issue-btn-top">
            <span class="issue-btn-id">${iss.id}</span>
            <span class="issue-btn-icon">▷</span>
          </div>
          <div class="issue-btn-time">${fmt(iss.start)}</div>
          <div class="issue-btn-meta">
            <span class="issue-btn-dur">${iss.duration.toFixed(1)}s</span>
            <span class="issue-btn-type">${fast?'FAST':'SLOW'}</span>
          </div>
          <div class="issue-btn-dev ${fast?'over':'under'}">${fast?'+':'−'}${iss.devMs}ms</div>`;
        btn.addEventListener('click',function(){
          if (snippetBtn === this && isPlaying) { stopPlayback(false); return; }
          playSnippet(parseFloat(this.dataset.start), parseFloat(this.dataset.dur), this);
        });
        frag.appendChild(btn);
      });
      grid.appendChild(frag);
    }
  }

  // ── SENSITIVITY ──
  function updateSensitivity(threshold) {
    sensitivityThreshold = threshold;
    const valEl = document.getElementById('sensitivity-val');
    if (valEl) valEl.textContent = threshold;

    if (analysisResult && primaryWaveData) {
      primaryColors = threshold > 0 ? rebakeColors(primaryIssues, threshold) : rebakeColors(primaryIssues, 0);
      filteredPrimaryIssues = threshold > 0 ? primaryIssues.filter(i => i.devMs >= threshold) : undefined;
      drawCanvas(tlCanvas, primaryWaveData, primaryColors, primaryPlayheadNorm, filteredPrimaryIssues);
    }
    if (compareResult && compareWaveData) {
      compareColors = threshold > 0 ? rebakeColors(compareIssuesData, threshold) : rebakeColors(compareIssuesData, 0);
      filteredCompareIssues = threshold > 0 ? compareIssuesData.filter(i => i.devMs >= threshold) : undefined;
      const cmpWrap = document.getElementById('compare-wave-wrap');
      if (cmpWrap && cmpWrap.style.display !== 'none')
        drawCanvas(cmpCanvas, compareWaveData, compareColors, comparePlayheadNorm, filteredCompareIssues);
    }

    const allIssues = currentIssuesPage === 2 ? compareIssuesData : primaryIssues;
    const filtered = filteredPrimaryIssues !== undefined && currentIssuesPage === 1
      ? filteredPrimaryIssues
      : filteredCompareIssues !== undefined && currentIssuesPage === 2
        ? filteredCompareIssues
        : allIssues;
    renderIssues(filtered, allIssues.length);
  }

  // ── SHOW RESULTS ──
  function showResults(result, waveData, colorIndex, filename) {
    analysisResult=result; primaryWaveData=waveData; primaryColors=colorIndex;
    primaryFilename=filename||'session';
    primaryIssues=result.issues;
    const sn=document.getElementById('session-name');
    if(sn) sn.textContent=primaryFilename+(compareFilename?' · '+compareFilename:'');
    document.getElementById('stat-bpm').textContent    =result.bpm;
    document.getElementById('stat-issues').textContent =result.issues.length;
    document.getElementById('stat-drift').textContent  =result.maxDev?`±${result.maxDev}ms`:'—';
    const dur=result.duration;
    document.getElementById('total-time').textContent    =fmt(dur);
    document.getElementById('playhead-time').textContent ='0:00';
    document.getElementById('ruler-q1').textContent  =fmt(dur*0.25);
    document.getElementById('ruler-mid').textContent =fmt(dur*0.5);
    document.getElementById('ruler-q3').textContent  =fmt(dur*0.75);
    document.getElementById('ruler-end').textContent =fmt(dur);
    currentIssuesPage=1;
    sensitivityThreshold=0; filteredPrimaryIssues=undefined; filteredCompareIssues=undefined;
    // Init sensitivity slider range from primary issues
    const maxDev = primaryIssues.length ? Math.max(...primaryIssues.map(i=>i.devMs)) : 0;
    const slider = document.getElementById('sensitivity-slider');
    if (slider) { slider.max = maxDev; slider.value = 0; }
    const senVal = document.getElementById('sensitivity-val');
    if (senVal) senVal.textContent = '0';
    const senWrap = document.getElementById('sensitivity-wrap');
    if (senWrap) senWrap.style.display = primaryIssues.length > 0 ? '' : 'none';
    renderIssues(primaryIssues);
    ['stats-row','timeline-panel','table-panel','compare-toggle-row'].forEach(id=>{
      document.getElementById(id).style.display='';
    });
    tlDims=null; primaryPlayheadNorm=0; comparePlayheadNorm=0; lastPrimaryNorm=-1; lastCmpNorm=-1;
    setTimeout(()=>{ drawCanvas(tlCanvas,primaryWaveData,primaryColors,0,undefined); startAnimLoop(); },60);
  }

  // ── LOAD FILE VIA WORKER ──
  // ── WORKER DISPATCH — shared by file uploads and PCM recordings ──
  function dispatchToWorker(buffer, isCompare, name) {
    const channelArrays=[], transferList=[];
    for(let c=0;c<buffer.numberOfChannels;c++){
      const copy=new Float32Array(buffer.length);
      copy.set(buffer.getChannelData(c));
      channelArrays.push(copy.buffer); transferList.push(copy.buffer);
    }
    const worker=new Worker(WORKER_URL);
    worker.postMessage({channelArrays,totalLen:buffer.length,SR:buffer.sampleRate,isCompare},transferList);
    worker.onmessage=ev=>{
      const {type,pct,result,waveData,colorIndex}=ev.data;
      if(type==='progress'){
        setProgress(pct, pct<50?'Detecting beats…':pct<80?'Analysing drift…':'Building waveform…');
        return;
      }
      worker.terminate();
      const wave=new Float32Array(waveData), colors=new Uint8Array(colorIndex);
      showProcessing(false);
      if(isCompare){
        compareBuffer=buffer; compareResult=result; compareWaveData=wave; compareColors=colors;
        compareFilename=name||'comparison';
        compareIssuesData=result.issues;
        cmpDims=null;
        const cmpDur=result.duration;
        document.getElementById('cmp-total-time').textContent   =fmt(cmpDur);
        document.getElementById('cmp-playhead-time').textContent='0:00';
        document.getElementById('cmp-ruler-q1').textContent =fmt(cmpDur*0.25);
        document.getElementById('cmp-ruler-mid').textContent=fmt(cmpDur*0.5);
        document.getElementById('cmp-ruler-q3').textContent =fmt(cmpDur*0.75);
        document.getElementById('cmp-ruler-end').textContent=fmt(cmpDur);
        document.getElementById('cmp-stat-bpm').textContent   =result.bpm;
        document.getElementById('cmp-stat-issues').textContent=result.issues.length;
        document.getElementById('cmp-stat-drift').textContent =result.maxDev?`±${result.maxDev}ms`:'—';
        document.getElementById('compare-stats-row').style.display='';
        const sn=document.getElementById('session-name');
        if(sn) sn.textContent=primaryFilename+' · '+compareFilename;
        document.getElementById('issues-pager').style.display='flex';
        document.getElementById('track-selector').style.display='flex';
        const allDevMs=[...primaryIssues,...result.issues].map(i=>i.devMs);
        const newMax=allDevMs.length?Math.max(...allDevMs):0;
        const sliderEl=document.getElementById('sensitivity-slider');
        if(sliderEl){sliderEl.max=newMax;sliderEl.value=0;}
        const svEl=document.getElementById('sensitivity-val');
        if(svEl) svEl.textContent='0';
        sensitivityThreshold=0; filteredPrimaryIssues=undefined; filteredCompareIssues=undefined;
        primaryColors=rebakeColors(primaryIssues,0);
        const senWrapEl=document.getElementById('sensitivity-wrap');
        if(senWrapEl) senWrapEl.style.display='';
        const wrap=document.getElementById('compare-wave-wrap');
        if(wrap) wrap.style.display='';
        setTimeout(()=>drawCanvas(cmpCanvas,compareWaveData,compareColors,0,undefined),60);
      } else {
        stopPlayback(); primaryBuffer=buffer;
        showResults(result,wave,colors,name||'recording');
      }
    };
    worker.onerror=err=>{ worker.terminate(); showProcessing(false); console.error(err); alert('Analysis failed. Try another file.'); };
  }

  // ── LOAD FILE (upload path) ──
  async function loadFile(file, isCompare) {
    showProcessing(true, isCompare?'Decoding baseline…':'Decoding audio…');
    setProgress(5,'');
    const ctx=getAudioCtx();
    let arrayBuf;
    try { arrayBuf=await file.arrayBuffer(); } catch(e){ showProcessing(false); alert('Could not read file.'); return; }
    let decoded;
    try { decoded=await ctx.decodeAudioData(arrayBuf); } catch(e){ showProcessing(false); alert('Could not decode audio. Try MP3, WAV or OGG.'); return; }
    let buffer=decoded;
    if (decoded.duration>MAX_REC_SECS) {
      const maxS=Math.floor(MAX_REC_SECS*decoded.sampleRate);
      const t=ctx.createBuffer(decoded.numberOfChannels,maxS,decoded.sampleRate);
      for(let c=0;c<decoded.numberOfChannels;c++) t.getChannelData(c).set(decoded.getChannelData(c).subarray(0,maxS));
      buffer=t;
    }
    dispatchToWorker(buffer, isCompare, file.name||(isCompare?'comparison':'recording'));
  }

  // ── RECORDING UI LOCK — prevents overlapping records/uploads ──
  function lockRecordingUI(keep) {
    // keep = id of the active record button (stays enabled as a Stop btn)
    ['btn-upload','btn-record','compare-record-btn','compare-upload-btn','compare-toggle','file-input','compare-file-input'].forEach(id=>{
      if (id===keep) return;
      const el=document.getElementById(id);
      if(el) el.disabled=true;
    });
  }
  function unlockRecordingUI() {
    ['btn-upload','btn-record','compare-record-btn','compare-upload-btn','compare-toggle','file-input','compare-file-input'].forEach(id=>{
      const el=document.getElementById(id);
      if(el) el.disabled=false;
    });
  }

  // ── RECORDING (raw PCM via ScriptProcessorNode — no WebM decode truncation) ──
  function _buildPcmBuffer(pcmChunks, sampleRate, maxSecs) {
    const maxSamples = Math.floor(maxSecs * sampleRate);
    const totalSamples = pcmChunks.reduce((s,c)=>s+c.length, 0);
    const finalLen = Math.min(totalSamples, maxSamples);
    const pcm = new Float32Array(finalLen);
    let offset = 0;
    for (const chunk of pcmChunks) {
      const take = Math.min(chunk.length, finalLen - offset);
      pcm.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= finalLen) break;
    }
    const ctx = getAudioCtx();
    const buf = ctx.createBuffer(1, finalLen, sampleRate);
    buf.getChannelData(0).set(pcm);
    return buf;
  }

  async function startRecording() {
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const ctx=getAudioCtx();
      if(ctx.state==='suspended') await ctx.resume();
      const pcmChunks=[];
      const source=ctx.createMediaStreamSource(stream);
      const processor=ctx.createScriptProcessor(4096,1,1);
      processor.onaudioprocess=e=>{
        if(!isRecording) return;
        pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination); // outputBuffer stays zeroed → silent
      recState={source,processor,stream,sampleRate:ctx.sampleRate,pcmChunks};
      recSeconds=0; isRecording=true;
      lockRecordingUI('btn-record');
      document.getElementById('rec-timer').style.display='block';
      document.getElementById('rec-label').textContent='Stop';
      document.getElementById('btn-record').classList.add('recording');
      document.getElementById('upload-title').textContent='Recording… tap Stop when done';
      document.getElementById('upload-sub').textContent='Max 2 minutes';
      recInterval=setInterval(()=>{
        recSeconds++;
        document.getElementById('rec-time-display').textContent=fmt(recSeconds);
        if(recSeconds>=MAX_REC_SECS) stopRecording();
      },1000);
    } catch(e){ alert('Microphone access denied. Please allow mic access and try again.'); }
  }

  function stopRecording(discard) {
    if(!isRecording) return;
    isRecording=false;
    clearInterval(recInterval);
    unlockRecordingUI();
    document.getElementById('rec-timer').style.display='none';
    document.getElementById('rec-label').textContent='Record';
    document.getElementById('btn-record').classList.remove('recording');
    if(!recState) return;
    const {source,processor,stream,sampleRate,pcmChunks}=recState;
    recState=null;
    try{source.disconnect();}catch(e){}
    try{processor.disconnect();}catch(e){}
    stream.getTracks().forEach(t=>t.stop());
    if(discard||!pcmChunks.length) return;
    document.getElementById('upload-title').textContent='Processing recording…';
    document.getElementById('upload-sub').textContent='';
    showProcessing(true,'Building waveform…');
    const buffer=_buildPcmBuffer(pcmChunks, sampleRate, MAX_REC_SECS);
    dispatchToWorker(buffer, false, 'recording');
  }

  // ── COMPARE RECORDING ──
  async function startCmpRecording() {
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const ctx=getAudioCtx();
      if(ctx.state==='suspended') await ctx.resume();
      const pcmChunks=[];
      const source=ctx.createMediaStreamSource(stream);
      const processor=ctx.createScriptProcessor(4096,1,1);
      processor.onaudioprocess=e=>{
        if(!cmpIsRecording) return;
        pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      cmpRecState={source,processor,stream,sampleRate:ctx.sampleRate,pcmChunks};
      cmpRecSeconds=0; cmpIsRecording=true;
      lockRecordingUI('compare-record-btn');
      document.getElementById('cmp-rec-timer').style.display='inline';
      document.getElementById('cmp-rec-label').textContent='Stop';
      document.getElementById('compare-record-btn').classList.add('recording');
      cmpRecInterval=setInterval(()=>{
        cmpRecSeconds++;
        document.getElementById('cmp-rec-time').textContent=fmt(cmpRecSeconds);
        if(cmpRecSeconds>=MAX_REC_SECS) stopCmpRecording();
      },1000);
    } catch(e){ alert('Microphone access denied. Please allow mic access and try again.'); }
  }

  function stopCmpRecording(discard) {
    if(!cmpIsRecording) return;
    cmpIsRecording=false;
    clearInterval(cmpRecInterval);
    unlockRecordingUI();
    document.getElementById('cmp-rec-timer').style.display='none';
    document.getElementById('cmp-rec-label').textContent='Record';
    document.getElementById('compare-record-btn').classList.remove('recording');
    if(!cmpRecState) return;
    const {source,processor,stream,sampleRate,pcmChunks}=cmpRecState;
    cmpRecState=null;
    try{source.disconnect();}catch(e){}
    try{processor.disconnect();}catch(e){}
    stream.getTracks().forEach(t=>t.stop());
    if(discard||!pcmChunks.length) return;
    showProcessing(true,'Analysing comparison…');
    const buffer=_buildPcmBuffer(pcmChunks, sampleRate, MAX_REC_SECS);
    dispatchToWorker(buffer, true, 'comparison');
  }

  function showProcessing(show,msg) {
    const ind=document.getElementById('processing-indicator');
    if(!ind) return;
    ind.style.display=show?'block':'none';
    if(show){ setProgress(0,msg||'Analysing…'); }
    else { document.getElementById('upload-title').textContent='Analysis complete!'; document.getElementById('upload-sub').textContent='Drop another file to re-analyse'; }
  }

  // ── RESET / START OVER ──
  function resetSession() {
    stopPlayback(false);
    if (animRafId !== null) { cancelAnimationFrame(animRafId); animRafId = null; }
    // Abort in-progress recordings without analysing
    if (isRecording) stopRecording(true);
    if (cmpIsRecording) stopCmpRecording(true);
    primaryBuffer=null; compareBuffer=null;
    analysisResult=null; compareResult=null;
    primaryWaveData=null; primaryColors=null; compareWaveData=null; compareColors=null;
    primaryFilename='session'; compareFilename='';
    primaryIssues=[]; compareIssuesData=[]; currentIssuesPage=1;
    sensitivityThreshold=0; filteredPrimaryIssues=undefined; filteredCompareIssues=undefined;
    const sliderReset=document.getElementById('sensitivity-slider');
    if(sliderReset){sliderReset.value=0; sliderReset.max=500;}
    const senValReset=document.getElementById('sensitivity-val');
    if(senValReset) senValReset.textContent='0';
    const senWrapReset=document.getElementById('sensitivity-wrap');
    if(senWrapReset) senWrapReset.style.display='none';
    tlDims=null; cmpDims=null; primaryPlayheadNorm=0; comparePlayheadNorm=0; lastPrimaryNorm=-1; lastCmpNorm=-1; startOffset=0;
    ['stats-row','compare-stats-row','timeline-panel','table-panel','compare-toggle-row'].forEach(id=>{
      document.getElementById(id).style.display='none';
    });
    document.getElementById('compare-wave-wrap').style.display='none';
    document.getElementById('issues-pager').style.display='none';
    document.getElementById('track-selector').style.display='none';
    const pg1r=document.getElementById('issues-page-1');
    const pg2r=document.getElementById('issues-page-2');
    if(pg1r) pg1r.classList.add('active');
    if(pg2r) pg2r.classList.remove('active');
    const tgl=document.getElementById('compare-toggle');
    tgl.checked=false;
    const badge=document.getElementById('compare-badge');
    badge.textContent='Disabled'; badge.style.cssText='';
    const cb=document.getElementById('compare-upload-btn');
    if (cb) cb.style.display='none';
    const crb=document.getElementById('compare-record-btn');
    if (crb) crb.style.display='none';
    document.getElementById('processing-indicator').style.display='none';
    document.getElementById('upload-title').textContent='Drop your beat here — or record live';
    document.getElementById('upload-sub').textContent='Supports MP3, WAV, OGG · Max 2 minutes';
    document.getElementById('session-name').textContent='no session loaded';
    document.getElementById('issues-grid').innerHTML='';
    document.getElementById('playhead-time').textContent='0:00';
    document.getElementById('total-time').textContent='0:00';
    document.getElementById('cmp-playhead-time').textContent='0:00';
    document.getElementById('cmp-total-time').textContent='0:00';
    document.getElementById('file-input').value='';
    document.getElementById('compare-file-input').value='';
  }

  // ── INIT ──
  function init() {
    const fileInput=document.getElementById('file-input');
    document.getElementById('btn-upload').addEventListener('click',()=>fileInput.click());
    fileInput.addEventListener('change',e=>{if(e.target.files[0])loadFile(e.target.files[0],false);});

    const cmpInput=document.getElementById('compare-file-input');
    const cmpBtn=document.getElementById('compare-upload-btn');
    if(cmpBtn) cmpBtn.addEventListener('click',()=>cmpInput.click());
    cmpInput.addEventListener('change',e=>{if(e.target.files[0])loadFile(e.target.files[0],true);});

    document.getElementById('btn-record').addEventListener('click',()=>{
      if (isRecording) stopRecording(); else startRecording();
    });
    document.getElementById('btn-reset').addEventListener('click', resetSession);
    document.getElementById('play-btn').addEventListener('click',()=>{
      if(!primaryBuffer&&!compareBuffer)return; isPlaying?stopPlayback():startPlayback(getCurrentSec());
    });

    [tlCanvas,cmpCanvas].forEach(cv=>{
      if(!cv)return;
      cv.addEventListener('click',e=>{
        if(!analysisResult)return;
        const r=cv.getBoundingClientRect();
        const clickNorm=(e.clientX-r.left)/r.width;
        const res=cv===tlCanvas?analysisResult:compareResult;
        if(!res)return;
        // startOffset is wall-clock elapsed seconds shared by both tracks
        startOffset=Math.max(0,Math.min(clickNorm*res.duration,res.duration));
        primaryPlayheadNorm=Math.min(1,startOffset/analysisResult.duration);
        comparePlayheadNorm=compareResult?Math.min(1,startOffset/compareResult.duration):0;
        lastPrimaryNorm=-1; lastCmpNorm=-1;
        drawCanvas(tlCanvas,primaryWaveData,primaryColors,primaryPlayheadNorm,filteredPrimaryIssues);
        const cmpWrapR=document.getElementById('compare-wave-wrap');
        if(compareResult&&compareWaveData&&cmpWrapR&&cmpWrapR.style.display!=='none')
          drawCanvas(cmpCanvas,compareWaveData,compareColors,comparePlayheadNorm,filteredCompareIssues);
        if(isPlaying)startPlayback(startOffset);
      });
    });

    const restartBtn=document.getElementById('timeline-restart-btn');
    if(restartBtn) restartBtn.addEventListener('click',()=>{
      stopPlayback(false);
      startOffset=0;
      primaryPlayheadNorm=0; comparePlayheadNorm=0; lastPrimaryNorm=-1; lastCmpNorm=-1;
      drawCanvas(tlCanvas,primaryWaveData,primaryColors,0,filteredPrimaryIssues);
      const cmpWrapR=document.getElementById('compare-wave-wrap');
      if(compareResult&&compareWaveData&&cmpWrapR&&cmpWrapR.style.display!=='none')
        drawCanvas(cmpCanvas,compareWaveData,compareColors,0,filteredCompareIssues);
      const phEl=document.getElementById('playhead-time'); if(phEl) phEl.textContent='0:00';
    });

    const panel=document.getElementById('upload-panel');
    panel.addEventListener('dragover',e=>{e.preventDefault();panel.style.borderColor='var(--teal)';panel.style.background='rgba(0,245,212,0.04)';},{passive:false});
    panel.addEventListener('dragleave',()=>{panel.style.borderColor='';panel.style.background='';});
    panel.addEventListener('drop',e=>{e.preventDefault();panel.style.borderColor='';panel.style.background='';const f=e.dataTransfer.files[0];if(f&&f.type.startsWith('audio/'))loadFile(f,false);});

    const cmpRecBtn=document.getElementById('compare-record-btn');
    if(cmpRecBtn) cmpRecBtn.addEventListener('click',()=>{
      if(cmpIsRecording) stopCmpRecording(); else startCmpRecording();
    });

    const pg1=document.getElementById('issues-page-1');
    const pg2=document.getElementById('issues-page-2');
    if(pg1) pg1.addEventListener('click',()=>{
      currentIssuesPage=1;
      pg1.classList.add('active'); pg2.classList.remove('active');
      updateSensitivity(sensitivityThreshold);
    });
    if(pg2) pg2.addEventListener('click',()=>{
      currentIssuesPage=2;
      pg2.classList.add('active'); pg1.classList.remove('active');
      updateSensitivity(sensitivityThreshold);
    });

    const toggle=document.getElementById('compare-toggle');
    const badge=document.getElementById('compare-badge');
    const cmpWrap=document.getElementById('compare-wave-wrap');
    toggle.addEventListener('change',function(){
      if(this.checked){
        badge.textContent='Enabled'; badge.style.cssText='color:var(--bk-ok);background:rgba(58,125,68,0.08)';
        if(cmpBtn) cmpBtn.style.display='inline-flex';
        if(cmpRecBtn) cmpRecBtn.style.display='inline-flex';
        if(compareBuffer){
          if(cmpWrap){cmpWrap.style.display='';cmpDims=null;setTimeout(()=>drawCanvas(cmpCanvas,compareWaveData,compareColors,0,filteredCompareIssues),60);}
          document.getElementById('compare-stats-row').style.display='';
          document.getElementById('issues-pager').style.display='flex';
          document.getElementById('track-selector').style.display='flex';
        }
      } else {
        badge.textContent='Disabled'; badge.style.cssText='';
        if(cmpBtn) cmpBtn.style.display='none';
        if(cmpRecBtn) cmpRecBtn.style.display='none';
        if(cmpWrap) cmpWrap.style.display='none';
        document.getElementById('compare-stats-row').style.display='none';
        document.getElementById('issues-pager').style.display='none';
        document.getElementById('track-selector').style.display='none';
        // Reset to primary issues page
        currentIssuesPage=1;
        if(pg1) pg1.classList.add('active');
        if(pg2) pg2.classList.remove('active');
        renderIssues(primaryIssues);
      }
    });

    const sensitivitySlider=document.getElementById('sensitivity-slider');
    if(sensitivitySlider) sensitivitySlider.addEventListener('input',()=>{
      updateSensitivity(parseInt(sensitivitySlider.value,10));
    });

    document.addEventListener('keydown',e=>{
      if(e.code==='Space'&&e.target.tagName!=='INPUT'&&e.target.tagName!=='BUTTON'){
        e.preventDefault(); document.getElementById('play-btn').click();
      }
    });
  }

  return {init};
})();
