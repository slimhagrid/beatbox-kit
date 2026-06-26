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
  if (isCompare) { colors.fill(3); return colors; }
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
