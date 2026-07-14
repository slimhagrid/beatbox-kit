/* bampler-stuff.js — Bampler sampler engine
   16 pads, waveform slicing, keyboard playback, record-to-pad
*/

(function () {
  'use strict';

  // ── CONSTANTS ──────────────────────────────────────────────────────────────
  const TOTAL_PADS  = 16;
  const MAX_REC_SECS = 120;
  const DEFAULT_KEYS = ['a','s','d','f','j','k','l',';','z','x','c','v','n','m',',','.'];
  const ZOOM_LEVELS  = [1, 3, 5, 10];

  // One distinct color per pad — used for waveform regions + mini-waveforms
  const PAD_COLORS = [
    '#ef4444','#f97316','#eab308','#22c55e',
    '#14b8a6','#3b82f6','#8b5cf6','#ec4899',
    '#f87171','#fb923c','#fbbf24','#4ade80',
    '#34d399','#60a5fa','#a78bfa','#f472b6',
  ];

  // ── STATE ──────────────────────────────────────────────────────────────────
  let audioCtx   = null;
  let masterGain = null;
  let waveformPeaks  = null;  // { min, max }[] per canvas pixel column
  let padGridBuilt   = false;
  let initDone       = false;

  // Multiple source audio files (up to 3). masterBuffer always mirrors
  // tracks[activeTrackIdx].buffer so the waveform/scrub/playback code below
  // can keep reading that one global unchanged — it only ever reflects
  // whichever track is currently on screen. Each track: { buffer, name }.
  // A pad's OWN audio is resolved via padSourceBuffer(pad), which follows
  // pad.trackIdx — NOT masterBuffer — so a pad keeps playing correctly even
  // after the user switches to a different track on screen.
  const MAX_TRACKS = 3;
  const tracks = [null, null, null];
  let activeTrackIdx = 0;
  let pendingTrackIdx = -1; // track slot [+] is currently uploading into, or -1
  let masterBuffer = null;  // mirrors tracks[activeTrackIdx].buffer

  // 16 pad data objects
  const pads = Array.from({ length: TOTAL_PADS }, (_, i) => ({
    type: 'slice',   // 'slice' = references tracks[trackIdx].buffer, 'buffer' = owns its AudioBuffer
    startNorm: 0,
    endNorm:   0,
    hasSlice:  false,
    buffer:    null,  // AudioBuffer when type === 'buffer'
    trackIdx:  0,      // which tracks[] slot a 'slice' pad was chopped from
    keyBinding: DEFAULT_KEYS[i],
    oneShot: false,  // true = plays to end on release; false = stops on key/click release
    locked: false,   // true = auto-chop / auto-trim skip this pad
    // Fixed light envelope on every pad — just enough to kill click/clipping
    // noise at the start/end of a slice, not a user-tunable feature.
    adsr: { attack: 0.08, decay: 0.08, sustain: 1, release: 0.08 },
    // Mini-waveform zoom/pan (view is always == [startNorm,endNorm] at zoomIdx 0)
    zoomIdx: 0, viewStart: 0, viewSpan: 1,
  }));

  // Sample mode
  let sampleModeOn = false;
  let selectedPad  = -1;
  let dragTarget   = null;   // 'start' | 'end' | 'new'
  let dragAnchor   = 0;      // norm position where 'new' drag started

  // Waveform playback
  let wavePlayback = { playing: false, startedAt: 0, offsetSec: 0, source: null };
  let playheadNorm = 0;
  let rafHandle    = null;

  // Main (source-load) recording
  let isRecording = false;
  let recState    = null;
  let recInterval = null;
  let recSeconds  = 0;

  // Pad recording (mic or live keyboard performance → assign to pad)
  let isPadRecording = false;
  let padRecState    = null;
  let padRecInterval = null;
  let padRecSeconds  = 0;
  let padRecSource   = 'mic'; // 'mic' | 'keyboard'
  let pendingPadBuffer = null; // AudioBuffer awaiting pad assignment

  // Active playing sources per pad: padIdx → { source, startedAt }
  const activeSources = {};

  // Keys currently held down during pad play (key string → padIdx)
  const heldPadKeys = new Map();

  // RAF handle for live pad time + playhead tick
  let padRafHandle = null;

  // Mini-waveform edge-drag / pan state (sample mode)
  let miniDragPad     = -1;
  let miniDragTarget  = null; // 'start' | 'end' | 'pan-pending' | 'pan'
  let miniDragOriginX = 0;
  let miniDragOrigStart = 0;
  let miniDragOrigEnd   = 0;
  let miniDragViewSpan  = 0;  // pad's view span at drag start — scales px deltas either way
  let miniDragViewStartOrigin = 0;
  let miniDragWidth   = 0;

  // Main waveform zoom/pan
  let waveZoomIdx = 0;
  let waveViewStart = 0;
  let waveViewSpan  = 1;
  let waveDragPending = false; // possible pan (non-sample-mode drag) awaiting movement threshold
  let waveDragOriginX = 0;
  let waveDragOriginViewStart = 0;
  let waveDragMoved = false;

  // Main waveform scrollbar drag
  let scrollbarDragging = false;
  let scrollbarDragOriginX = 0;
  let scrollbarDragOriginStart = 0;

  // ADSR envelope popup
  let envActivePad = -1;       // pad the popup is currently open for (-1 = closed)
  let envScope = 'this';       // 'this' | 'all' — which pads Save/Reset apply to
  let envDraft = { attack: 0.08, decay: 0.08, sustain: 1, release: 0.08 }; // scratch values while dragging

  // Pad right-click context menu (copy/paste sample content between pads)
  let copiedPadData = null;   // clipboard entry, or null if nothing copied yet
  let ctxMenuTargetPad = -1;  // pad the menu is currently open for, or -1

  // ── AUDIO CONTEXT ──────────────────────────────────────────────────────────
  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function fmtTime(sec) {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${ss.toString().padStart(2, '0')}`;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function setStatus(text) {
    const el = document.getElementById('shell-status');
    if (el) el.textContent = text;
  }

  // Resolves the AudioBuffer a pad's audio actually comes from — for a
  // 'buffer' pad that's its own recording; for a 'slice' pad it's whichever
  // TRACK it was chopped from (pad.trackIdx), NOT necessarily the track
  // currently on screen (masterBuffer). Keeps every pad playing correctly
  // regardless of which track the user has since switched to.
  function padSourceBuffer(pad) {
    if (pad.type === 'buffer') return pad.buffer;
    const t = tracks[pad.trackIdx];
    return t ? t.buffer : null;
  }

  function getPadDuration(padIdx) {
    const pad = pads[padIdx];
    if (!pad.hasSlice) return 0;
    const buf = padSourceBuffer(pad);
    return buf ? (pad.endNorm - pad.startNorm) * buf.duration : 0;
  }

  function resetPadTimeDisplay(padIdx) {
    const dur = getPadDuration(padIdx);
    const el  = document.getElementById(`pad-time-${padIdx}`);
    if (el) el.textContent = dur > 0 ? `0.0 / ${dur.toFixed(1)}` : '';
  }

  function tickPads() {
    if (!audioCtx) { padRafHandle = null; return; }
    const now = audioCtx.currentTime;
    let anyActive = false;
    Object.entries(activeSources).forEach(([idxStr, info]) => {
      const padIdx  = +idxStr;
      const dur     = getPadDuration(padIdx);
      const elapsed = dur > 0 ? Math.min(now - info.startedAt, dur) : 0;
      const phNorm  = dur > 0 ? elapsed / dur : 0;
      const timeEl  = document.getElementById(`pad-time-${padIdx}`);
      if (timeEl) timeEl.textContent = `${elapsed.toFixed(1)} / ${dur.toFixed(1)}`;
      renderPadMiniWave(padIdx, phNorm);
      anyActive = true;
    });
    padRafHandle = anyActive ? requestAnimationFrame(tickPads) : null;
  }

  // ── WAVEFORM PEAKS ─────────────────────────────────────────────────────────
  // startNorm/endNorm let this compute peaks for just the current zoomed view.
  function computePeaks(buffer, width, startNorm = 0, endNorm = 1) {
    const data = buffer.getChannelData(0);
    const N    = data.length;
    const s0   = Math.floor(startNorm * N);
    const s1   = Math.floor(endNorm   * N);
    const span = Math.max(1, s1 - s0);
    const out  = [];
    for (let x = 0; x < width; x++) {
      const s = s0 + Math.floor(x / width * span);
      const e = s0 + Math.floor((x + 1) / width * span);
      let mn = 0, mx = 0;
      for (let i = s; i < e && i < N; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
      out.push({ min: mn, max: mx });
    }
    return out;
  }

  function waveMapNormToPx(norm, width) {
    return ((norm - waveViewStart) / waveViewSpan) * width;
  }

  function resizeWaveCanvas() {
    const canvas = document.getElementById('bampler-wave-canvas');
    if (!canvas) return;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight || 100;
    if (!W) return;
    canvas.width  = W;
    canvas.height = H;
    if (masterBuffer) {
      waveformPeaks = computePeaks(masterBuffer, W, waveViewStart, waveViewStart + waveViewSpan);
      renderWave(playheadNorm);
    }
  }

  // Recomputes peaks + redraws for the current zoom/pan window — call whenever
  // waveViewStart/waveViewSpan change (zoom button, drag-pan, scrollbar).
  function refreshWaveView() {
    const canvas = document.getElementById('bampler-wave-canvas');
    if (!canvas || !masterBuffer) return;
    const W = canvas.width;
    if (!W) return;
    waveformPeaks = computePeaks(masterBuffer, W, waveViewStart, waveViewStart + waveViewSpan);
    renderWave(playheadNorm);
    updateRulerForView();
    renderWaveScrollbar();
  }

  function renderWaveScrollbar() {
    const track = document.getElementById('wave-scrollbar');
    const thumb = document.getElementById('wave-scrollbar-thumb');
    if (!track || !thumb) return;
    if (waveZoomIdx === 0) { track.style.display = 'none'; return; }
    track.style.display = '';
    thumb.style.left  = (waveViewStart * 100) + '%';
    thumb.style.width = (waveViewSpan  * 100) + '%';
  }

  function cycleWaveZoom() {
    if (!masterBuffer) return;
    waveZoomIdx = (waveZoomIdx + 1) % ZOOM_LEVELS.length;
    const level = ZOOM_LEVELS[waveZoomIdx];
    if (level === 1) {
      waveViewStart = 0;
      waveViewSpan  = 1;
    } else {
      const newSpan = 1 / level;
      const curCenter = waveViewStart + waveViewSpan / 2;
      waveViewStart = Math.max(0, Math.min(curCenter - newSpan / 2, 1 - newSpan));
      waveViewSpan  = newSpan;
    }
    const btn = document.getElementById('wave-zoom-btn');
    if (btn) btn.textContent = `${level}X`;
    refreshWaveView();
  }

  // Drag the scrollbar thumb (or click the track) to pan while zoomed —
  // works regardless of Sample Mode, since dragging the waveform itself is
  // reserved for region-editing while in Sample Mode.
  function initWaveScrollbar() {
    const track = document.getElementById('wave-scrollbar');
    const thumb = document.getElementById('wave-scrollbar-thumb');
    if (!track || !thumb) return;

    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      scrollbarDragging = true;
      scrollbarDragOriginX = e.clientX;
      scrollbarDragOriginStart = waveViewStart;
    });
    track.addEventListener('mousedown', (e) => {
      if (e.target === thumb || waveZoomIdx === 0) return;
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      waveViewStart = Math.max(0, Math.min(frac - waveViewSpan / 2, 1 - waveViewSpan));
      refreshWaveView();
    });
    window.addEventListener('mousemove', (e) => {
      if (!scrollbarDragging) return;
      const rect = track.getBoundingClientRect();
      const normDelta = (e.clientX - scrollbarDragOriginX) / rect.width;
      waveViewStart = Math.max(0, Math.min(scrollbarDragOriginStart + normDelta, 1 - waveViewSpan));
      refreshWaveView();
    });
    window.addEventListener('mouseup', () => { scrollbarDragging = false; });
  }

  // ── WAVEFORM RENDER ────────────────────────────────────────────────────────
  function renderWave(phNorm) {
    const canvas = document.getElementById('bampler-wave-canvas');
    if (!canvas) return;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const ctx = canvas.getContext('2d');
    const mid = H / 2;

    // Background
    ctx.fillStyle = '#f5f4ef';
    ctx.fillRect(0, 0, W, H);

    const mapX = (norm) => waveMapNormToPx(norm, W);

    // Pad regions — only pads chopped from the TRACK currently on screen;
    // pads from other tracks aren't shown here (their bounds don't correspond
    // to this timeline).
    pads.forEach((pad, i) => {
      if (!pad.hasSlice || pad.type !== 'slice' || pad.trackIdx !== activeTrackIdx) return;
      const isSel  = sampleModeOn && i === selectedPad;
      const color  = PAD_COLORS[i];
      const sx = mapX(pad.startNorm);
      const ex = mapX(pad.endNorm);
      if (ex < 0 || sx > W) return; // fully outside current view
      const csx = Math.max(0, sx), cex = Math.min(W, ex);
      const w = Math.max(0, cex - csx);
      if (w <= 0) return;
      ctx.fillStyle = hexToRgba(color, isSel ? 0.28 : 0.16);
      ctx.fillRect(csx, 0, w, H);
      // Top color bar
      ctx.fillStyle = hexToRgba(color, isSel ? 1.0 : 0.65);
      ctx.fillRect(csx, 0, w, 4);
    });

    // Waveform amplitude bars — peaks are already computed for the current view
    if (waveformPeaks) {
      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      for (let x = 0; x < W && x < waveformPeaks.length; x++) {
        const { min, max } = waveformPeaks[x];
        const yT = mid - max * mid * 0.9;
        const yB = mid - min * mid * 0.9;
        ctx.fillRect(x, yT, 1, Math.max(1, yB - yT));
      }
    }

    // Sample-mode markers for the selected pad — only meaningful for a 'slice'
    // pad whose sample (if any) actually belongs to the track on screen.
    // ('buffer' pads own their own recording and aren't edited here.)
    const selPad = selectedPad >= 0 ? pads[selectedPad] : null;
    if (sampleModeOn && selPad && selPad.type === 'slice' && (!selPad.hasSlice || selPad.trackIdx === activeTrackIdx)) {
      const pad = selPad;
      const sx  = mapX(pad.startNorm);

      // Start marker — green
      if (sx >= -10 && sx <= W + 10) {
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
        ctx.fillStyle   = '#22c55e';
        ctx.fillRect(sx - 5, 0, 10, 8);
      }

      // End marker — red (show while dragging 'new' or when slice exists)
      if (pad.hasSlice || dragTarget === 'new') {
        const ex = mapX(pad.endNorm);
        if (ex >= -10 && ex <= W + 10) {
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth   = 2;
          ctx.beginPath(); ctx.moveTo(ex, 0); ctx.lineTo(ex, H); ctx.stroke();
          ctx.fillStyle   = '#ef4444';
          ctx.fillRect(ex - 5, 0, 10, 8);
        }
      }
    }

    // Playhead
    if (phNorm > 0 && phNorm < 1) {
      const px = mapX(phNorm);
      if (px >= 0 && px <= W) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth   = 1;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
      }
    }
  }

  // Sets the total-time readout — called once when audio loads (unaffected by zoom).
  function updateRuler(duration) {
    const el = document.getElementById('wave-time-tot');
    if (el) el.textContent = fmtTime(duration);
  }

  // Sets the 5 ruler tick labels to the CURRENT zoomed/panned view's time range.
  function updateRulerForView() {
    if (!masterBuffer) return;
    const dur   = masterBuffer.duration;
    const t0    = waveViewStart * dur;
    const t1    = (waveViewStart + waveViewSpan) * dur;
    const span  = t1 - t0;
    const ticks = document.querySelectorAll('.wave-ruler .ruler-tick');
    if (ticks.length >= 5) {
      ticks[0].textContent = fmtTime(t0);
      ticks[1].textContent = fmtTime(t0 + span * 0.25);
      ticks[2].textContent = fmtTime(t0 + span * 0.5);
      ticks[3].textContent = fmtTime(t0 + span * 0.75);
      ticks[4].textContent = fmtTime(t1);
    }
  }

  // ── PAD MINI-WAVEFORM ──────────────────────────────────────────────────────
  // playheadFrac (0..1) is the position WITHIN THE SLICE (elapsed/dur, as tickPads
  // computes it); it gets converted to an absolute source position, then mapped
  // through the pad's current view (which may be zoomed/panned away from 1:1).
  function renderPadMiniWave(padIdx, playheadFrac = null) {
    const pad = pads[padIdx];
    const el  = document.getElementById(`pad-${padIdx}`);
    if (!el || !pad.hasSlice) return;
    const canvas = el.querySelector('.pad-mini-wave');
    if (!canvas) return;

    canvas.width  = canvas.offsetWidth  || 80;
    canvas.height = canvas.offsetHeight || 30;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const srcBuf = padSourceBuffer(pad);
    if (!srcBuf) return;
    const data = srcBuf.getChannelData(0);
    const N = data.length;

    // At zoomIdx 0 the view is always exactly the slice — keep it in sync
    // automatically so edits (edge-drag, autochop, etc.) never go stale.
    if (pad.zoomIdx === 0) {
      pad.viewStart = pad.startNorm;
      pad.viewSpan  = Math.max(0.0001, pad.endNorm - pad.startNorm);
    }

    const viewStart  = pad.viewStart;
    const viewSpan   = pad.viewSpan || 1;
    const startSample = Math.floor(viewStart * N);
    const endSample   = Math.floor(Math.min(1, viewStart + viewSpan) * N);
    const viewLen = endSample - startSample;
    if (viewLen <= 0) return;

    const color = PAD_COLORS[padIdx];
    const mid   = H / 2;
    const mapX  = (norm) => ((norm - viewStart) / viewSpan) * W;

    for (let x = 0; x < W; x++) {
      const s = Math.floor(x / W * viewLen) + startSample;
      const e = Math.min(Math.floor((x + 1) / W * viewLen) + startSample, endSample);
      let mn = 0, mx = 0;
      for (let i = s; i < e; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
      // Dim the parts of the view outside the actual slice bounds (context)
      const xNorm = viewStart + (x / W) * viewSpan;
      const inSlice = xNorm >= pad.startNorm && xNorm <= pad.endNorm;
      const yT = mid - mx * mid * 0.85;
      const yB = mid - mn * mid * 0.85;
      ctx.fillStyle = inSlice ? color : hexToRgba(color, 0.3);
      ctx.fillRect(x, yT, 1, Math.max(1, yB - yT));
    }

    // Playhead — convert slice-relative fraction to an absolute position, then view-map it
    if (playheadFrac !== null && playheadFrac >= 0 && playheadFrac <= 1) {
      const absNorm = pad.startNorm + playheadFrac * (pad.endNorm - pad.startNorm);
      const px = mapX(absNorm);
      if (px >= 0 && px <= W) {
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth   = 1.5;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
      }
    }

    // Edge markers (sample mode only — matches main waveform's green/red style)
    if (sampleModeOn) {
      const sx = mapX(pad.startNorm);
      if (sx >= -6 && sx <= W + 6) {
        ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
      }
      const ex = mapX(pad.endNorm);
      if (ex >= -6 && ex <= W + 6) {
        ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ex, 0); ctx.lineTo(ex, H); ctx.stroke();
      }
    }
  }

  // Resets a pad's mini-wave zoom/pan back to 1X (view == its current slice bounds).
  function resetPadZoom(padIdx) {
    const pad = pads[padIdx];
    pad.zoomIdx   = 0;
    pad.viewStart = pad.startNorm;
    pad.viewSpan  = Math.max(0.0001, pad.endNorm - pad.startNorm);
    const btn = document.getElementById(`pad-${padIdx}`)?.querySelector('.pad-zoom-btn');
    if (btn) btn.textContent = '1X';
  }

  function cyclePadZoom(padIdx) {
    const pad = pads[padIdx];
    pad.zoomIdx = (pad.zoomIdx + 1) % ZOOM_LEVELS.length;
    const level = ZOOM_LEVELS[pad.zoomIdx];
    const sliceSpan = Math.max(0.0001, pad.endNorm - pad.startNorm);
    if (level === 1) {
      pad.viewStart = pad.startNorm;
      pad.viewSpan  = sliceSpan;
    } else {
      const newSpan = sliceSpan / level;
      const curCenter = pad.viewStart + pad.viewSpan / 2;
      pad.viewStart = Math.max(0, Math.min(curCenter - newSpan / 2, 1 - newSpan));
      pad.viewSpan  = newSpan;
    }
    const btn = document.getElementById(`pad-${padIdx}`)?.querySelector('.pad-zoom-btn');
    if (btn) btn.textContent = `${level}X`;
    renderPadMiniWave(padIdx);
  }

  // ── ADSR ENVELOPE POPUP ────────────────────────────────────────────────────
  function envDefault() {
    return { attack: 0.08, decay: 0.08, sustain: 1, release: 0.08 };
  }

  function isDefaultEnv(env) {
    const d = envDefault();
    return Math.abs(env.attack - d.attack) < 0.001
      && Math.abs(env.decay - d.decay) < 0.001
      && Math.abs(env.sustain - d.sustain) < 0.001
      && Math.abs(env.release - d.release) < 0.001;
  }

  function updateEnvBtnState(padIdx) {
    const btn = document.getElementById(`pad-${padIdx}`)?.querySelector('.pad-env-btn');
    if (btn) btn.classList.toggle('active', !isDefaultEnv(pads[padIdx].adsr));
  }

  function updateEnvLabels() {
    document.getElementById('env-attack-val').textContent  = `${document.getElementById('env-attack').value}ms`;
    document.getElementById('env-decay-val').textContent   = `${document.getElementById('env-decay').value}ms`;
    document.getElementById('env-sustain-val').textContent = `${document.getElementById('env-sustain').value}%`;
    document.getElementById('env-release-val').textContent = `${document.getElementById('env-release').value}ms`;
  }

  function readEnvDraftFromSliders() {
    envDraft = {
      attack:  +document.getElementById('env-attack').value  / 1000,
      decay:   +document.getElementById('env-decay').value   / 1000,
      sustain: +document.getElementById('env-sustain').value / 100,
      release: +document.getElementById('env-release').value / 1000,
    };
  }

  function setEnvSlidersFromDraft() {
    document.getElementById('env-attack').value  = Math.round(envDraft.attack * 1000);
    document.getElementById('env-decay').value   = Math.round(envDraft.decay * 1000);
    document.getElementById('env-sustain').value = Math.round(envDraft.sustain * 100);
    document.getElementById('env-release').value = Math.round(envDraft.release * 1000);
    updateEnvLabels();
    drawEnvCanvas();
  }

  // Draws the ADSR SHAPE only (not audio) — a fixed-width visual "hold" segment
  // stands in for sustain's indefinite hold, scaled against A/D/R in the same units.
  function drawEnvCanvas() {
    const canvas = document.getElementById('env-canvas');
    if (!canvas) return;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const padTop = 10, padBottom = 10;
    const top = padTop, bottom = H - padBottom;

    const aMs = envDraft.attack * 1000;
    const dMs = envDraft.decay * 1000;
    const rMs = envDraft.release * 1000;
    const holdMs = 300; // fixed visual sustain-hold width
    const totalMs = Math.max(1, aMs + dMs + holdMs + rMs);

    const x0 = 0;
    const x1 = (aMs / totalMs) * W;
    const x2 = x1 + (dMs / totalMs) * W;
    const x3 = x2 + (holdMs / totalMs) * W;
    const x4 = x3 + (rMs / totalMs) * W;
    const sustainY = bottom - envDraft.sustain * (bottom - top);

    // Background grid
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    for (let gy = 0; gy <= 4; gy++) {
      const y = top + (gy / 4) * (bottom - top);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Fill under curve
    ctx.beginPath();
    ctx.moveTo(x0, bottom);
    ctx.lineTo(x1, top);
    ctx.lineTo(x2, sustainY);
    ctx.lineTo(x3, sustainY);
    ctx.lineTo(x4, bottom);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,140,66,0.25)';
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    ctx.moveTo(x0, bottom);
    ctx.lineTo(x1, top);
    ctx.lineTo(x2, sustainY);
    ctx.lineTo(x3, sustainY);
    ctx.lineTo(x4, bottom);
    ctx.strokeStyle = '#ff8c42';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Breakpoint markers
    ctx.fillStyle = '#000';
    [[x1, top], [x2, sustainY], [x3, sustainY]].forEach(([x, y]) => {
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
    });
  }

  function openEnvModal(padIdx) {
    envActivePad = padIdx;
    envDraft = { ...pads[padIdx].adsr };
    const titleEl = document.getElementById('env-modal-title');
    if (titleEl) titleEl.textContent = `ENVELOPE — PAD ${padIdx + 1}`;
    setEnvSlidersFromDraft();
    const overlay = document.getElementById('env-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
  }

  function closeEnvModal() {
    const overlay = document.getElementById('env-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    envActivePad = -1;
  }

  function saveEnvelope() {
    if (envActivePad < 0) return;
    readEnvDraftFromSliders();
    if (envScope === 'all') {
      pads.forEach((p, i) => { p.adsr = { ...envDraft }; updateEnvBtnState(i); });
    } else {
      pads[envActivePad].adsr = { ...envDraft };
      updateEnvBtnState(envActivePad);
    }
    closeEnvModal();
  }

  function resetEnvelope() {
    if (envActivePad < 0) return;
    const def = envDefault();
    if (envScope === 'all') {
      pads.forEach((p, i) => { p.adsr = { ...def }; updateEnvBtnState(i); });
    } else {
      pads[envActivePad].adsr = { ...def };
      updateEnvBtnState(envActivePad);
    }
    envDraft = { ...def };
    setEnvSlidersFromDraft();
    closeEnvModal();
  }

  // ── PAD GRID BUILD ─────────────────────────────────────────────────────────
  function buildPadGrid() {
    const grid = document.getElementById('pad-grid');
    if (!grid) return;
    grid.innerHTML = '';

    pads.forEach((pad, i) => {
      const el    = document.createElement('div');
      el.className = 'pad';
      el.id        = `pad-${i}`;
      el.dataset.pad = i;

      el.innerHTML = `
        <div class="pad-top-row">
          <span class="pad-num">${i + 1}</span>
          <div class="pad-top-right">
            <span class="pad-time" id="pad-time-${i}"></span>
            <span class="pad-dot"></span>
          </div>
        </div>
        <canvas class="pad-mini-wave"></canvas>
        <div class="pad-bottom-row">
          <div class="pad-toggle-group">
            <button class="pad-oneshot-btn" title="One-shot: plays full sample on press (hold pad key + 1 to toggle)">1S</button>
            <button class="pad-lock-btn" title="Lock: skip this pad on Auto Chop (hold pad key + 2 to toggle)">LK</button>
            <button class="pad-env-btn" title="Adjust the ADSR envelope">ENV</button>
            <button class="pad-zoom-btn" title="Cycle zoom level — drag the waveform in Sample Mode to pan">1X</button>
          </div>
          <input class="pad-key-input" type="text" value="${pad.keyBinding.toUpperCase()}"
                 maxlength="1" title="Click to remap keyboard shortcut" autocomplete="off">
        </div>`;

      // Pad click (play / select / assign)
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.classList.contains('pad-key-input')) return;
        if (e.target.classList.contains('pad-oneshot-btn')) return;
        if (e.target.classList.contains('pad-lock-btn')) return;
        if (e.target.classList.contains('pad-zoom-btn')) return;
        if (e.target.classList.contains('pad-env-btn')) return;
        handlePadClick(i);
      });

      // Right-click: copy/paste sample content between pads
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPadContextMenu(e, i);
      });

      // Key remapping input
      const keyInput = el.querySelector('.pad-key-input');
      const oneShotBtn = el.querySelector('.pad-oneshot-btn');
      const lockBtn    = el.querySelector('.pad-lock-btn');

      keyInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || e.key === 'Enter') { keyInput.blur(); return; }
        if (e.key.length === 1) {
          e.preventDefault();
          pad.keyBinding = e.key.toLowerCase();
          keyInput.value = e.key.toUpperCase();
          keyInput.blur();
        }
      });
      keyInput.addEventListener('focus', () => keyInput.select());
      keyInput.addEventListener('mousedown', (e) => e.stopPropagation());

      // One-shot toggle
      oneShotBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pad.oneShot = !pad.oneShot;
        oneShotBtn.classList.toggle('active', pad.oneShot);
      });
      oneShotBtn.addEventListener('mousedown', (e) => e.stopPropagation());

      // Lock toggle
      lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pad.locked = !pad.locked;
        lockBtn.classList.toggle('active', pad.locked);
        el.classList.toggle('pad-locked', pad.locked);
      });
      lockBtn.addEventListener('mousedown', (e) => e.stopPropagation());

      // Zoom toggle
      const zoomBtn = el.querySelector('.pad-zoom-btn');
      zoomBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cyclePadZoom(i);
      });
      zoomBtn.addEventListener('mousedown', (e) => e.stopPropagation());

      // Envelope popup
      const envBtn = el.querySelector('.pad-env-btn');
      envBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEnvModal(i);
      });
      envBtn.addEventListener('mousedown', (e) => e.stopPropagation());

      // Mini-wave edge drag / pan (sample mode only; works for slice pads and recorded buffer pads)
      const miniCanvas = el.querySelector('.pad-mini-wave');
      // Maps pad.startNorm/endNorm into the pad's CURRENT view (accounts for zoom/pan)
      function miniEdgePx(norm, width) {
        return ((norm - pad.viewStart) / (pad.viewSpan || 1)) * width;
      }
      miniCanvas.addEventListener('mousemove', (ev) => {
        if (!sampleModeOn || !pad.hasSlice) { miniCanvas.style.cursor = ''; return; }
        const rect   = miniCanvas.getBoundingClientRect();
        const cx     = ev.clientX - rect.left;
        const thresh = Math.min(10, rect.width * 0.2);
        const startPx = miniEdgePx(pad.startNorm, rect.width);
        const endPx   = miniEdgePx(pad.endNorm, rect.width);
        const nearEdge = Math.abs(cx - startPx) < thresh || Math.abs(cx - endPx) < thresh;
        miniCanvas.style.cursor = nearEdge ? 'ew-resize' : (pad.zoomIdx > 0 ? 'grab' : '');
      });
      miniCanvas.addEventListener('mouseleave', () => { miniCanvas.style.cursor = ''; });
      miniCanvas.addEventListener('mousedown', (ev) => {
        if (!sampleModeOn || !pad.hasSlice) return;
        const rect   = miniCanvas.getBoundingClientRect();
        const cx     = ev.clientX - rect.left;
        const thresh = Math.min(10, rect.width * 0.2);
        const startPx = miniEdgePx(pad.startNorm, rect.width);
        const endPx   = miniEdgePx(pad.endNorm, rect.width);
        const nearStart = Math.abs(cx - startPx) < thresh;
        const nearEnd   = Math.abs(cx - endPx) < thresh;

        if (nearStart) {
          miniDragTarget = 'start';
        } else if (nearEnd) {
          miniDragTarget = 'end';
        } else if (pad.zoomIdx > 0) {
          // Possible pan — don't stop propagation, so a plain click (no real
          // movement) still bubbles up and selects the pad as normal.
          miniDragPad = i;
          miniDragTarget = 'pan-pending';
          miniDragOriginX = ev.clientX;
          miniDragViewStartOrigin = pad.viewStart;
          miniDragViewSpan = pad.viewSpan || 1;
          miniDragWidth = rect.width;
          return;
        } else {
          return; // middle, not zoomed → bubble to pad click (select)
        }

        ev.stopPropagation();
        ev.preventDefault();
        miniDragPad       = i;
        miniDragOriginX   = ev.clientX;
        miniDragOrigStart = pad.startNorm;
        miniDragOrigEnd   = pad.endNorm;
        miniDragViewSpan  = pad.viewSpan || 1;
        miniDragWidth     = rect.width;
      });

      grid.appendChild(el);
    });
  }

  function updatePadUI(padIdx) {
    const pad = pads[padIdx];
    const el  = document.getElementById(`pad-${padIdx}`);
    if (!el) return;
    el.classList.toggle('pad-loaded', pad.hasSlice);
    if (pad.hasSlice) {
      const c = el.querySelector('.pad-mini-wave');
      if (c) { c.width = c.offsetWidth || 80; c.height = c.offsetHeight || 30; }
      renderPadMiniWave(padIdx);
      resetPadTimeDisplay(padIdx);
    } else {
      const c = el.querySelector('.pad-mini-wave');
      if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
      const timeEl = document.getElementById(`pad-time-${padIdx}`);
      if (timeEl) timeEl.textContent = '';
    }
  }

  // ── PAD ACTIONS ────────────────────────────────────────────────────────────
  function handlePadClick(padIdx) {
    if (pendingPadBuffer !== null) {
      assignToPad(padIdx);
    } else if (sampleModeOn) {
      // Select for editing AND preview it — lets you hear a pad while
      // dragging its start/end markers to dial in the right length.
      selectPad(padIdx);
      triggerPad(padIdx);
    } else {
      triggerPad(padIdx);
    }
  }

  function selectPad(padIdx) {
    if (selectedPad >= 0) {
      document.getElementById(`pad-${selectedPad}`)?.classList.remove('pad-selected');
    }
    selectedPad = padIdx;
    document.getElementById(`pad-${padIdx}`)?.classList.add('pad-selected');

    const hint = document.getElementById('wave-hint');
    if (hint) {
      hint.textContent = pads[padIdx].hasSlice
        ? `Pad ${padIdx + 1} selected — drag the markers to adjust sample region`
        : `Pad ${padIdx + 1} selected — drag on the waveform to set a sample region`;
    }
    renderWave(playheadNorm);
  }

  // ── PAD CONTEXT MENU (copy/paste sample content between pads) ─────────────
  function openPadContextMenu(e, padIdx) {
    ctxMenuTargetPad = padIdx;
    const menu = document.getElementById('pad-context-menu');
    const pasteBtn = document.getElementById('pad-ctx-paste');
    if (!menu || !pasteBtn) return;
    pasteBtn.disabled = !copiedPadData;

    menu.style.display = 'flex';
    const menuW = menu.offsetWidth, menuH = menu.offsetHeight;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 4);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 4);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top  = `${Math.max(4, y)}px`;
  }

  function closePadContextMenu() {
    const menu = document.getElementById('pad-context-menu');
    if (menu) menu.style.display = 'none';
    ctxMenuTargetPad = -1;
  }

  // Copies only the sample CONTENT (what plays and from where) — playback
  // settings the user has configured for that physical pad slot (lock,
  // one-shot, envelope, key) are left on the destination untouched.
  function padToClipboardEntry(pad) {
    return pad.hasSlice
      ? { hasSlice: true, type: pad.type, buffer: pad.buffer, startNorm: pad.startNorm, endNorm: pad.endNorm, trackIdx: pad.trackIdx }
      : { hasSlice: false };
  }

  function copyTargetPad() {
    if (ctxMenuTargetPad < 0) return;
    copiedPadData = padToClipboardEntry(pads[ctxMenuTargetPad]);
    closePadContextMenu();
  }

  function pasteIntoTargetPad() {
    if (ctxMenuTargetPad < 0 || !copiedPadData) return;
    const pad = pads[ctxMenuTargetPad];
    if (copiedPadData.hasSlice) {
      pad.type      = copiedPadData.type;
      pad.buffer    = copiedPadData.buffer;
      pad.startNorm = copiedPadData.startNorm;
      pad.endNorm   = copiedPadData.endNorm;
      pad.trackIdx  = copiedPadData.trackIdx;
      pad.hasSlice  = true;
    } else {
      pad.hasSlice  = false;
      pad.startNorm = 0;
      pad.endNorm   = 0;
    }
    resetPadZoom(ctxMenuTargetPad);
    updatePadUI(ctxMenuTargetPad);
    updateAutoTrimBtnState();
    renderWave(playheadNorm);
    closePadContextMenu();
  }

  // Schedules an attack→decay→sustain→release ramp on a GainNode's gain param,
  // sized to fit within totalDur (A/D/R are scaled down proportionally if they
  // don't fit so the envelope always resolves to 0 by the sample's natural end).
  function applyEnvelope(gainParam, env, now, totalDur) {
    const a = Math.max(0, env.attack);
    const d = Math.max(0, env.decay);
    const s = Math.min(1, Math.max(0, env.sustain));
    const r = Math.max(0, env.release);

    let sa = a, sd = d, sr = r;
    const sum = a + d + r;
    if (sum > totalDur && sum > 0.0001) {
      const scale = totalDur / sum;
      sa = a * scale; sd = d * scale; sr = r * scale;
    }

    gainParam.cancelScheduledValues(now);
    gainParam.setValueAtTime(0, now);
    if (sa > 0.001) gainParam.linearRampToValueAtTime(1, now + sa);
    else gainParam.setValueAtTime(1, now);

    const decayEnd = now + sa + sd;
    if (sd > 0.001) gainParam.linearRampToValueAtTime(s, decayEnd);
    else gainParam.setValueAtTime(s, decayEnd);

    const releaseStart = Math.max(decayEnd, now + totalDur - sr);
    gainParam.setValueAtTime(s, releaseStart);
    if (sr > 0.001) gainParam.linearRampToValueAtTime(0, releaseStart + sr);
    else gainParam.setValueAtTime(0, releaseStart);
  }

  function triggerPad(padIdx) {
    const pad = pads[padIdx];
    if (!pad.hasSlice) return;

    const ctx = getAudioCtx();
    const buf = padSourceBuffer(pad);
    if (!buf) return;
    const offset = pad.startNorm * buf.duration;
    const dur    = (pad.endNorm - pad.startNorm) * buf.duration;

    if (dur < 0.001) return;

    const now = ctx.currentTime;

    // Cut any currently-playing instance with a quick fade to avoid a click
    if (activeSources[padIdx]) {
      const prev = activeSources[padIdx];
      try {
        prev.gainNode.gain.cancelScheduledValues(now);
        prev.gainNode.gain.setValueAtTime(prev.gainNode.gain.value, now);
        prev.gainNode.gain.linearRampToValueAtTime(0, now + 0.005);
      } catch (_) {}
      prev.source.onended = null;
      try { prev.source.stop(now + 0.006); } catch (_) {}
      delete activeSources[padIdx];
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gainNode = ctx.createGain();
    src.connect(gainNode);
    gainNode.connect(masterGain);

    applyEnvelope(gainNode.gain, pad.adsr, now, dur);
    src.start(0, offset, dur);

    activeSources[padIdx] = { source: src, gainNode, startedAt: now };

    const el = document.getElementById(`pad-${padIdx}`);
    if (el) el.classList.add('pad-active');

    src.onended = () => {
      delete activeSources[padIdx];
      el?.classList.remove('pad-active');
      resetPadTimeDisplay(padIdx);
      renderPadMiniWave(padIdx);
    };

    if (!padRafHandle) padRafHandle = requestAnimationFrame(tickPads);
  }

  // Fades the currently-playing instance out over its release time, then
  // stops it once the fade completes (cleanup happens via src.onended as usual).
  function releasePad(padIdx) {
    const info = activeSources[padIdx];
    if (!info) return;
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const r   = Math.max(0.01, pads[padIdx].adsr.release);
    const g   = info.gainNode.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + r);
    try { info.source.stop(now + r + 0.01); } catch (_) {}
  }

  function stopPad(padIdx) {
    if (pads[padIdx].oneShot) return;
    releasePad(padIdx);
  }

  // ── PAD ASSIGN ─────────────────────────────────────────────────────────────
  function assignToPad(padIdx) {
    if (!pendingPadBuffer) return;
    const pad  = pads[padIdx];
    pad.type      = 'buffer';
    pad.buffer    = pendingPadBuffer;
    pad.startNorm = 0;
    pad.endNorm   = 1;
    pad.hasSlice  = true;
    pendingPadBuffer = null;
    resetPadZoom(padIdx);
    hideAssignBar();
    updatePadUI(padIdx);
    updateAutoTrimBtnState();
  }

  function showAssignBar() {
    document.getElementById('assign-bar').style.display = '';
    document.querySelectorAll('.pad').forEach(el => el.classList.add('pad-assign-mode'));
  }

  function hideAssignBar() {
    document.getElementById('assign-bar').style.display = 'none';
    document.querySelectorAll('.pad').forEach(el => el.classList.remove('pad-assign-mode'));
  }

  // ── WAVEFORM INTERACTION ───────────────────────────────────────────────────
  function initWaveInteraction() {
    const canvas = document.getElementById('bampler-wave-canvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', onWaveDown);
    window.addEventListener('mousemove', onWaveMove);
    window.addEventListener('mouseup',   onWaveUp);
  }

  // Returns an ABSOLUTE (full-buffer) normalized position for a clientX,
  // accounting for the current zoom/pan view.
  function waveNorm(clientX) {
    const canvas = document.getElementById('bampler-wave-canvas');
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return waveViewStart + frac * waveViewSpan;
  }

  function onWaveDown(e) {
    if (!masterBuffer) return;

    if (!sampleModeOn) {
      if (waveZoomIdx > 0) {
        // Possible pan — resolved to a seek-on-click in onWaveUp if it turns
        // out the mouse never moved past the drag threshold.
        waveDragPending = true;
        waveDragOriginX = e.clientX;
        waveDragOriginViewStart = waveViewStart;
        waveDragMoved = false;
        return;
      }
      // Seek on click
      seekWave(waveNorm(e.clientX));
      return;
    }

    if (selectedPad < 0) return;

    const norm  = waveNorm(e.clientX);
    const rect  = document.getElementById('bampler-wave-canvas').getBoundingClientRect();
    const xPx   = e.clientX - rect.left;
    const W     = rect.width;
    const pad   = pads[selectedPad];
    const startX = waveMapNormToPx(pad.startNorm, W);
    const endX   = waveMapNormToPx(pad.endNorm, W);

    // Existing start/end handles are only grabbable for a 'slice' pad whose
    // sample actually belongs to the track on screen — otherwise the drawn
    // markers (and thus these coordinates) don't correspond to anything real.
    const sameTrack = pad.type === 'slice' && pad.hasSlice && pad.trackIdx === activeTrackIdx;
    if (sameTrack && Math.abs(xPx - startX) < 10) {
      dragTarget = 'start';
    } else if (sameTrack && Math.abs(xPx - endX) < 10) {
      dragTarget = 'end';
    } else {
      dragTarget  = 'new';
      dragAnchor  = norm;
      pad.startNorm = norm;
      pad.endNorm   = norm;
      pad.hasSlice  = false;
    }

    e.preventDefault();
    renderWave(playheadNorm);
  }

  function onWaveMove(e) {
    if (waveDragPending) {
      const dx = e.clientX - waveDragOriginX;
      if (Math.abs(dx) > 3) {
        waveDragMoved = true;
        const canvas = document.getElementById('bampler-wave-canvas');
        const W = canvas.getBoundingClientRect().width;
        const normDelta = (dx / W) * waveViewSpan;
        waveViewStart = Math.max(0, Math.min(waveDragOriginViewStart - normDelta, 1 - waveViewSpan));
        refreshWaveView();
      }
      return;
    }

    if (!dragTarget || selectedPad < 0) return;
    const norm = waveNorm(e.clientX);
    const pad  = pads[selectedPad];

    if (dragTarget === 'start') {
      pad.startNorm = Math.min(norm, pad.endNorm - 0.002);
    } else if (dragTarget === 'end') {
      pad.endNorm = Math.max(norm, pad.startNorm + 0.002);
    } else {
      // 'new' drag — keep start ≤ end
      if (norm >= dragAnchor) {
        pad.startNorm = dragAnchor;
        pad.endNorm   = norm;
      } else {
        pad.startNorm = norm;
        pad.endNorm   = dragAnchor;
      }
    }

    renderWave(playheadNorm);
  }

  function onWaveUp(e) {
    if (waveDragPending) {
      if (!waveDragMoved) seekWave(waveNorm(e.clientX));
      waveDragPending = false;
      waveDragMoved = false;
      return;
    }

    if (!dragTarget) return;

    if (dragTarget === 'new') {
      const pad = pads[selectedPad];
      if (pad.endNorm - pad.startNorm > 0.001) {
        pad.type      = 'slice';
        pad.buffer    = null;
        pad.trackIdx  = activeTrackIdx;
        pad.hasSlice  = true;
        resetPadZoom(selectedPad);
        updatePadUI(selectedPad);
        updateAutoTrimBtnState();
        const hint = document.getElementById('wave-hint');
        if (hint) hint.textContent = `Pad ${selectedPad + 1} selected — drag the markers to adjust sample region`;
      }
    }

    dragTarget = null;
    renderWave(playheadNorm);
  }

  // ── WAVEFORM PLAYBACK ──────────────────────────────────────────────────────
  function seekWave(norm) {
    wavePlayback.offsetSec = norm * masterBuffer.duration;
    playheadNorm = norm;
    if (wavePlayback.playing) {
      if (wavePlayback.source) { wavePlayback.source.onended = null; try { wavePlayback.source.stop(); } catch (_) {} }
      wavePlayback.source  = null;
      wavePlayback.playing = false;
      waveStartPlay();
    } else {
      renderWave(norm);
      const el = document.getElementById('wave-time-cur');
      if (el) el.textContent = fmtTime(wavePlayback.offsetSec);
    }
  }

  function waveTogglePlay() {
    if (!masterBuffer) return;
    wavePlayback.playing ? waveStopPlay() : waveStartPlay();
  }

  function waveStartPlay() {
    const ctx = getAudioCtx();
    const src = ctx.createBufferSource();
    src.buffer = masterBuffer;
    src.connect(masterGain);
    src.start(0, wavePlayback.offsetSec);
    wavePlayback.source    = src;
    wavePlayback.startedAt = ctx.currentTime;
    wavePlayback.playing   = true;
    document.getElementById('wave-play-btn').textContent = '■';

    src.onended = () => {
      if (!wavePlayback.playing) return;
      wavePlayback.playing   = false;
      wavePlayback.offsetSec = 0;
      playheadNorm = 0;
      cancelAnimationFrame(rafHandle);
      document.getElementById('wave-play-btn').textContent = '▶';
      const el = document.getElementById('wave-time-cur');
      if (el) el.textContent = '0:00';
      renderWave(0);
    };

    tickWaveHead();
  }

  function waveStopPlay() {
    if (!wavePlayback.playing) return;
    wavePlayback.offsetSec += getAudioCtx().currentTime - wavePlayback.startedAt;
    if (wavePlayback.source) { wavePlayback.source.onended = null; try { wavePlayback.source.stop(); } catch (_) {} wavePlayback.source = null; }
    wavePlayback.playing = false;
    cancelAnimationFrame(rafHandle);
    document.getElementById('wave-play-btn').textContent = '▶';
  }

  function tickWaveHead() {
    if (!wavePlayback.playing) return;
    const elapsed = wavePlayback.offsetSec + (getAudioCtx().currentTime - wavePlayback.startedAt);
    playheadNorm  = Math.min(1, elapsed / masterBuffer.duration);
    renderWave(playheadNorm);
    const el = document.getElementById('wave-time-cur');
    if (el) el.textContent = fmtTime(elapsed);
    if (playheadNorm < 1) rafHandle = requestAnimationFrame(tickWaveHead);
  }

  // ── PCM ASSEMBLY ───────────────────────────────────────────────────────────
  function buildPcmBuffer(chunks, sampleRate, maxSecs) {
    const maxSamples = Math.floor(maxSecs * sampleRate);
    const total      = chunks.reduce((s, c) => s + c.length, 0);
    const finalLen   = Math.min(total, maxSamples);
    const pcm        = new Float32Array(finalLen);
    let offset = 0;
    for (const chunk of chunks) {
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

  // ── AUDIO FILE LOAD ────────────────────────────────────────────────────────
  function loadFile(file) {
    if (!file) return;
    showProcessing(`Loading ${file.name}…`);
    const reader = new FileReader();
    reader.onload = (e) => {
      getAudioCtx().decodeAudioData(e.target.result.slice(0)).then(buf => {
        let final = buf;
        if (buf.duration > MAX_REC_SECS) {
          const ctx        = getAudioCtx();
          const maxSamples = Math.floor(MAX_REC_SECS * buf.sampleRate);
          final            = ctx.createBuffer(1, maxSamples, buf.sampleRate);
          final.getChannelData(0).set(buf.getChannelData(0).subarray(0, maxSamples));
        }
        hideProcessing();
        const targetTrack = pendingTrackIdx >= 0 ? pendingTrackIdx : 0;
        pendingTrackIdx = -1;
        commitBufferToTrack(targetTrack, final, file.name.replace(/\.[^.]+$/, ''));
      }).catch(err => {
        hideProcessing();
        pendingTrackIdx = -1;
        console.error('Decode error', err);
      });
    };
    reader.readAsArrayBuffer(file);
  }

  // ── MAIN RECORDING (source load) ──────────────────────────────────────────
  function startRecording() {
    if (isRecording || isPadRecording) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const ctx   = getAudioCtx();
      const chunks = [];
      const src  = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        if (isRecording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(ctx.destination);
      isRecording = true;
      recState    = { src, proc, stream, sampleRate: ctx.sampleRate, chunks };
      recSeconds  = 0;
      lockLoadUI('btn-record');

      document.getElementById('btn-record').classList.add('recording');
      document.getElementById('rec-label').textContent = '■ Stop';
      document.getElementById('rec-timer').style.display = '';

      recInterval = setInterval(() => {
        recSeconds++;
        document.getElementById('rec-time-display').textContent = fmtTime(recSeconds);
        if (recSeconds >= MAX_REC_SECS) stopRecording(false);
      }, 1000);
    }).catch(err => console.error('Mic denied:', err));
  }

  function stopRecording(discard) {
    if (!isRecording) return;
    isRecording = false;
    clearInterval(recInterval);
    unlockLoadUI();

    document.getElementById('btn-record').classList.remove('recording');
    document.getElementById('rec-label').textContent = 'Record';
    document.getElementById('rec-timer').style.display = 'none';
    document.getElementById('rec-time-display').textContent = '0:00';

    const { src, proc, stream, sampleRate, chunks } = recState;
    recState = null;
    try { src.disconnect(); }  catch (_) {}
    try { proc.disconnect(); } catch (_) {}
    stream.getTracks().forEach(t => t.stop());

    if (discard || !chunks.length) return;
    showProcessing('Building audio…');
    setTimeout(() => {
      const buf = buildPcmBuffer(chunks, sampleRate, MAX_REC_SECS);
      hideProcessing();
      // Live recording only ever happens before any track is loaded — the
      // record button lives on the upload panel, hidden once a track exists —
      // so this always lands in slot 0.
      commitBufferToTrack(0, buf, 'recording');
    }, 0);
  }

  // ── PAD RECORDING (mic or live keyboard performance → assign to pad) ──────
  function startPadRecording() {
    if (isPadRecording || isRecording) return;
    if (padRecSource === 'keyboard') startKeyboardPadCapture();
    else startMicPadCapture();
  }

  function onPadRecordingStarted() {
    padRecSeconds = 0;
    const btn = document.getElementById('btn-pad-record');
    btn.classList.add('recording');
    btn.textContent = '■ Stop Recording';
    document.getElementById('pad-rec-timer').style.display = '';
    document.getElementById('rec-source-toggle')?.classList.add('disabled');

    padRecInterval = setInterval(() => {
      padRecSeconds++;
      document.getElementById('pad-rec-time').textContent = fmtTime(padRecSeconds);
      if (padRecSeconds >= MAX_REC_SECS) stopPadRecording(false);
    }, 1000);
  }

  function startMicPadCapture() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const ctx    = getAudioCtx();
      const chunks = [];
      const src  = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        if (isPadRecording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(ctx.destination);
      isPadRecording = true;
      padRecState     = { kind: 'mic', src, proc, stream, sampleRate: ctx.sampleRate, chunks };
      onPadRecordingStarted();
    }).catch(err => console.error('Mic denied:', err));
  }

  // Taps masterGain (the pads' output bus) so playing pads gets captured as a
  // new sample. The tap's output buffer is never written to, so it stays
  // silent and doesn't double up the audio already routed to destination.
  function startKeyboardPadCapture() {
    const ctx    = getAudioCtx();
    const chunks = [];
    const proc   = ctx.createScriptProcessor(4096, 2, 2);
    proc.onaudioprocess = (e) => {
      if (!isPadRecording) return;
      const inBuf = e.inputBuffer;
      const ch0 = inBuf.getChannelData(0);
      if (inBuf.numberOfChannels > 1) {
        const ch1 = inBuf.getChannelData(1);
        const mono = new Float32Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
        chunks.push(mono);
      } else {
        chunks.push(new Float32Array(ch0));
      }
    };
    masterGain.connect(proc);
    proc.connect(ctx.destination);
    isPadRecording = true;
    padRecState     = { kind: 'keyboard', proc, sampleRate: ctx.sampleRate, chunks };
    onPadRecordingStarted();
  }

  function stopPadRecording(discard) {
    if (!isPadRecording) return;
    isPadRecording = false;
    clearInterval(padRecInterval);

    const btn = document.getElementById('btn-pad-record');
    btn.classList.remove('recording');
    btn.textContent = 'Record to Pad';
    document.getElementById('pad-rec-timer').style.display = 'none';
    document.getElementById('pad-rec-time').textContent = '0:00';
    document.getElementById('rec-source-toggle')?.classList.remove('disabled');

    const state = padRecState;
    padRecState = null;
    if (!state) return;

    if (state.kind === 'mic') {
      try { state.src.disconnect(); }  catch (_) {}
      try { state.proc.disconnect(); } catch (_) {}
      state.stream.getTracks().forEach(t => t.stop());
    } else {
      try { masterGain.disconnect(state.proc); } catch (_) {}
      try { state.proc.disconnect(); } catch (_) {}
    }

    if (discard || !state.chunks.length) return;
    pendingPadBuffer = buildPcmBuffer(state.chunks, state.sampleRate, MAX_REC_SECS);
    showAssignBar();
  }

  // ── LOAD UI LOCK ───────────────────────────────────────────────────────────
  function lockLoadUI(keep) {
    ['btn-upload', 'btn-record'].forEach(id => {
      if (id === keep) return;
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
  }
  function unlockLoadUI() {
    ['btn-upload', 'btn-record'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });
  }

  // ── PROCESSING INDICATOR ───────────────────────────────────────────────────
  function showProcessing(msg) {
    const ind = document.getElementById('processing-indicator');
    const m   = document.getElementById('processing-msg');
    if (ind) ind.style.display = '';
    if (m && msg) m.textContent = msg;
    setStatus((msg || 'PROCESSING').toUpperCase());
  }
  function hideProcessing() {
    const ind = document.getElementById('processing-indicator');
    if (ind) ind.style.display = 'none';
  }

  // ── MULTI-TRACK SLOTS ──────────────────────────────────────────────────────
  // Commits a decoded buffer into a track slot. The very first track loaded
  // in a session resets the pad grid (fresh start); a second or third track
  // is added alongside whatever pads already exist, so samples chopped from
  // earlier tracks aren't lost — only pads still pointing at THIS slot's old
  // content ever needed resetting, and slice-type pads are always tied to
  // whichever track they were actually chopped from via pad.trackIdx.
  function commitBufferToTrack(trackIdx, buf, name) {
    const isFirstTrack = !tracks.some(Boolean);

    tracks[trackIdx] = { buffer: buf, name };
    activeTrackIdx = trackIdx;
    masterBuffer = buf;

    // Stop any in-progress playback
    waveStopPlay();
    cancelAnimationFrame(rafHandle);
    wavePlayback.offsetSec = 0;
    playheadNorm = 0;

    // Reset main waveform zoom/pan for the newly displayed track
    waveZoomIdx = 0; waveViewStart = 0; waveViewSpan = 1;
    const zoomBtnMain = document.getElementById('wave-zoom-btn');
    if (zoomBtnMain) zoomBtnMain.textContent = '1X';

    // Fresh session only: reset slice-type pads (buffer-type pads, from
    // Record-to-Pad, are independent of tracks and are always left alone)
    if (isFirstTrack) {
      pads.forEach(p => {
        if (p.type === 'slice') { p.hasSlice = false; p.startNorm = 0; p.endNorm = 0; }
      });
    }

    // Show wave panel + pad UI
    document.getElementById('upload-panel').style.display       = 'none';
    document.getElementById('wave-panel').style.display         = '';
    document.getElementById('pad-controls-row').style.display   = '';
    document.getElementById('pad-grid').style.display           = '';
    document.getElementById('pad-key-hint').style.display       = '';

    if (!padGridBuilt) {
      buildPadGrid();
      padGridBuilt = true;
    }

    pads.forEach((_, i) => updatePadUI(i));
    updateAutoTrimBtnState();

    // Compute waveform after layout paint
    setTimeout(() => {
      resizeWaveCanvas();
      updateRuler(masterBuffer.duration);
      updateRulerForView();
      renderWaveScrollbar();
      // Resize all pad mini-wave canvases now that they're visible
      pads.forEach((_, i) => { if (pads[i].hasSlice) renderPadMiniWave(i); });
    }, 50);

    document.getElementById('session-name').textContent = name || 'session';
    document.getElementById('wave-play-btn').textContent = '▶';
    document.getElementById('wave-time-cur').textContent = '0:00';
    setStatus('LOADED');

    updateSlotButtons();
    updateAddTrackVisibility();
  }

  // Switches which track's waveform is on screen — does not touch any pad's
  // content, which always keeps playing from whichever track it was actually
  // chopped from (pad.trackIdx), regardless of what's currently displayed.
  function switchToTrack(idx) {
    if (idx === activeTrackIdx || !tracks[idx]) return;
    waveStopPlay();

    activeTrackIdx = idx;
    masterBuffer = tracks[idx].buffer;
    document.getElementById('session-name').textContent = tracks[idx].name;
    document.getElementById('wave-time-cur').textContent = '0:00';

    waveZoomIdx = 0; waveViewStart = 0; waveViewSpan = 1;
    const zoomBtnMain = document.getElementById('wave-zoom-btn');
    if (zoomBtnMain) zoomBtnMain.textContent = '1X';

    // A pad selected from a different track no longer has meaningful markers
    // on this waveform — deselect so nothing stale is shown.
    if (selectedPad >= 0 && pads[selectedPad].trackIdx !== idx) {
      document.getElementById(`pad-${selectedPad}`)?.classList.remove('pad-selected');
      selectedPad = -1;
    }

    setTimeout(() => {
      resizeWaveCanvas();
      updateRuler(masterBuffer.duration);
      updateRulerForView();
      renderWaveScrollbar();
    }, 50);

    updateSlotButtons();
    renderWave(playheadNorm);
  }

  // [1]/[2]/[3] only ever appear once a second track exists — with a single
  // track there's nothing to switch between, so no buttons render at all.
  function updateSlotButtons() {
    const wrap = document.getElementById('slot-buttons-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const filledCount = tracks.filter(Boolean).length;
    if (filledCount <= 1) return;

    tracks.forEach((t, idx) => {
      if (!t) return;
      const btn = document.createElement('button');
      btn.className = 'shell-slot-btn' + (idx === activeTrackIdx ? ' active' : '');
      btn.textContent = String(idx + 1);
      btn.title = t.name;
      btn.addEventListener('click', () => switchToTrack(idx));
      wrap.appendChild(btn);
    });
  }

  function updateAddTrackVisibility() {
    const btn = document.getElementById('btn-add-track');
    if (!btn) return;
    const filledCount = tracks.filter(Boolean).length;
    btn.style.display = (filledCount >= 1 && filledCount < MAX_TRACKS) ? '' : 'none';
  }

  // ── SAMPLE MODE ────────────────────────────────────────────────────────────
  function setSampleMode(on) {
    sampleModeOn = on;
    const hint  = document.getElementById('wave-hint');
    const label = document.getElementById('sample-mode-label');
    const canvas = document.getElementById('bampler-wave-canvas');

    if (on) {
      if (hint)  { hint.textContent = 'Select a pad below, then drag on the waveform to set its sample region'; hint.style.display = ''; }
      if (label) label.innerHTML = 'Sample Mode: <strong>ON</strong>';
      if (canvas) canvas.style.cursor = 'crosshair';
    } else {
      if (hint)  hint.style.display = 'none';
      if (label) label.innerHTML = 'Sample Mode: <strong>OFF</strong>';
      if (canvas) canvas.style.cursor = 'pointer';
      if (selectedPad >= 0) {
        document.getElementById(`pad-${selectedPad}`)?.classList.remove('pad-selected');
        selectedPad = -1;
      }
    }
    renderWave(playheadNorm);
    // Refresh mini-waves so edge handles appear/disappear
    pads.forEach((_, i) => { if (pads[i].hasSlice) renderPadMiniWave(i); });
  }

  // ── AUTO CHOP ──────────────────────────────────────────────────────────────
  function autoChop() {
    if (!masterBuffer) return;
    const dur = masterBuffer.duration;
    if (dur < 1) return;

    // Slice lengths: min 1s, max 30% of duration capped at 5s
    const minLen = 1.0;
    const maxLen = Math.max(minLen, Math.min(5.0, dur * 0.3));

    pads.forEach((pad, i) => {
      if (pad.locked) return;

      const len      = minLen + Math.random() * (maxLen - minLen);
      const maxStart = Math.max(0, dur - len);
      const startSec = Math.random() * maxStart;

      pad.type      = 'slice';
      pad.buffer    = null;
      pad.trackIdx  = activeTrackIdx;
      pad.startNorm = startSec / dur;
      pad.endNorm   = Math.min(1, (startSec + len) / dur);
      pad.hasSlice  = true;
      resetPadZoom(i);

      updatePadUI(i);
    });

    renderWave(playheadNorm);
    updateAutoTrimBtnState();
  }

  // ── AUTO TRIM ──────────────────────────────────────────────────────────────
  // Enabled once at least one pad has a sample loaded.
  function updateAutoTrimBtnState() {
    const btn = document.getElementById('btn-auto-trim');
    if (!btn) return;
    btn.disabled = !pads.some(p => p.hasSlice);
  }

  // Shortens every unlocked, loaded pad's sample to a random new length that's
  // always shorter than its CURRENT length, staying fully within its current
  // [startNorm, endNorm] bounds (never reaches back into audio outside the
  // pad's existing chop).
  function autoTrim() {
    let trimmedAny = false;

    pads.forEach((pad, i) => {
      if (!pad.hasSlice || pad.locked) return;

      const srcBuf = padSourceBuffer(pad);
      const refDuration = srcBuf ? srcBuf.duration : 0;
      if (!refDuration) return;

      const curSpan   = pad.endNorm - pad.startNorm;
      const curLenSec = curSpan * refDuration;

      const minLenSec = Math.max(0.05, curLenSec * 0.1); // at least 50ms, or 10% of current
      const maxLenSec = curLenSec * 0.9;                  // always at least 10% shorter
      if (minLenSec >= maxLenSec) return; // already too short to usefully trim further

      const newLenSec = minLenSec + Math.random() * (maxLenSec - minLenSec);
      const newSpan   = newLenSec / refDuration;
      const maxStartOffset = curSpan - newSpan; // keeps the new trim fully inside the current bounds
      const newStart  = pad.startNorm + Math.random() * maxStartOffset;

      pad.startNorm = newStart;
      pad.endNorm   = newStart + newSpan;
      resetPadZoom(i);
      updatePadUI(i);
      trimmedAny = true;
    });

    if (trimmedAny) renderWave(playheadNorm);
  }

  // ── EXPORT PADS (WAV files bundled in a zip) ───────────────────────────────
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Encodes a mono Float32Array (-1..1) as a 16-bit PCM WAV file.
  function encodeWavMono16(float32, sampleRate) {
    const numSamples = float32.length;
    const dataSize    = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view   = new DataView(buffer);
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);            // block align
    view.setUint16(34, 16, true);           // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let off = 44;
    for (let i = 0; i < numSamples; i++) {
      const v = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      off += 2;
    }
    return new Uint8Array(buffer);
  }

  // Minimal store-only (uncompressed) ZIP writer — no external dependency needed.
  function buildZip(files) {
    const localChunks   = [];
    const centralChunks = [];
    const records = [];
    let offset = 0;

    files.forEach(f => {
      const nameBytes = new TextEncoder().encode(f.name);
      const data = f.data;
      const crc  = crc32(data);

      const header = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(header.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true);   // store, no compression
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true); // 1980-01-01 placeholder date
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      header.set(nameBytes, 30);

      localChunks.push(header, data);
      records.push({ nameBytes, crc, size: data.length, offset });
      offset += header.length + data.length;
    });

    const centralOffset = offset;
    let centralSize = 0;
    records.forEach(rec => {
      const central = new Uint8Array(46 + rec.nameBytes.length);
      const dv = new DataView(central.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint16(14, 0x21, true);
      dv.setUint32(16, rec.crc, true);
      dv.setUint32(20, rec.size, true);
      dv.setUint32(24, rec.size, true);
      dv.setUint16(28, rec.nameBytes.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, rec.offset, true);
      central.set(rec.nameBytes, 46);
      centralChunks.push(central);
      centralSize += central.length;
    });

    const end = new Uint8Array(22);
    const dvEnd = new DataView(end.buffer);
    dvEnd.setUint32(0, 0x06054b50, true);
    dvEnd.setUint16(8, records.length, true);
    dvEnd.setUint16(10, records.length, true);
    dvEnd.setUint32(12, centralSize, true);
    dvEnd.setUint32(16, centralOffset, true);

    return new Blob([...localChunks, ...centralChunks, end], { type: 'application/zip' });
  }

  function exportPads() {
    const entries = [];
    pads.forEach((pad, i) => {
      if (!pad.hasSlice) return;

      const srcBuf = padSourceBuffer(pad);
      if (!srcBuf) return;
      const full = srcBuf.getChannelData(0);
      const sampleRate = srcBuf.sampleRate;

      const N = full.length;
      const s = Math.floor(pad.startNorm * N);
      const e = Math.floor(pad.endNorm * N);
      if (e - s < 1) return;

      const wav = encodeWavMono16(full.subarray(s, e), sampleRate);
      entries.push({ name: `sample${i + 1}.wav`, data: wav });
    });

    if (!entries.length) { alert('No pads loaded to export.'); return; }

    const zipBlob = buildZip(entries);
    const now    = new Date();
    const hour12 = String(now.getHours() % 12 || 12).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const day    = String(now.getDate()).padStart(2, '0');
    const month  = String(now.getMonth() + 1).padStart(2, '0');

    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bampler-samples-${hour12}${minute}-${day}-${month}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── RESET SESSION ──────────────────────────────────────────────────────────
  function resetSession() {
    waveStopPlay();
    stopRecording(true);
    stopPadRecording(true);
    cancelAnimationFrame(rafHandle);

    tracks[0] = tracks[1] = tracks[2] = null;
    activeTrackIdx = 0;
    pendingTrackIdx = -1;
    masterBuffer   = null;
    waveformPeaks  = null;
    playheadNorm   = 0;
    sampleModeOn   = false;
    selectedPad    = -1;
    dragTarget     = null;
    pendingPadBuffer = null;
    heldPadKeys.clear();
    copiedPadData = null;
    closePadContextMenu();

    Object.values(activeSources).forEach(s => { try { s.source.stop(); } catch (_) {} });
    Object.keys(activeSources).forEach(k => delete activeSources[k]);
    if (padRafHandle) { cancelAnimationFrame(padRafHandle); padRafHandle = null; }
    miniDragPad = -1; miniDragTarget = null;

    // Reset main waveform zoom/pan
    waveZoomIdx = 0; waveViewStart = 0; waveViewSpan = 1;
    waveDragPending = false; waveDragMoved = false; scrollbarDragging = false;
    const zoomBtnMain = document.getElementById('wave-zoom-btn');
    if (zoomBtnMain) zoomBtnMain.textContent = '1X';
    renderWaveScrollbar();

    // Reset ADSR envelope popup state
    closeEnvModal();
    envScope = 'this';
    document.querySelectorAll('.env-scope-btn').forEach(b => b.classList.toggle('active', b.dataset.scope === 'this'));

    pads.forEach((pad, i) => {
      pad.type      = 'slice';
      pad.startNorm = 0;
      pad.endNorm   = 0;
      pad.hasSlice  = false;
      pad.buffer    = null;
      pad.trackIdx  = 0;
      pad.oneShot   = false;
      pad.locked    = false;
      pad.adsr      = { attack: 0.08, decay: 0.08, sustain: 1, release: 0.08 };
      pad.zoomIdx   = 0;
      pad.viewStart = 0;
      pad.viewSpan  = 1;
      const el = document.getElementById(`pad-${i}`);
      if (el) el.className = 'pad';
      el?.querySelector('.pad-oneshot-btn')?.classList.remove('active');
      el?.querySelector('.pad-lock-btn')?.classList.remove('active');
      el?.querySelector('.pad-env-btn')?.classList.remove('active');
      const zEl = el?.querySelector('.pad-zoom-btn');
      if (zEl) zEl.textContent = '1X';
      const timeEl = document.getElementById(`pad-time-${i}`);
      if (timeEl) timeEl.textContent = '';
      const c = el?.querySelector('.pad-mini-wave');
      if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    });

    document.getElementById('upload-panel').style.display     = '';
    document.getElementById('wave-panel').style.display       = 'none';
    document.getElementById('pad-controls-row').style.display = 'none';
    document.getElementById('pad-grid').style.display         = 'none';
    document.getElementById('pad-key-hint').style.display     = 'none';
    document.getElementById('assign-bar').style.display       = 'none';
    document.getElementById('wave-play-btn').textContent = '▶';

    const toggle = document.getElementById('sample-mode-toggle');
    if (toggle) toggle.checked = false;
    setSampleMode(false);

    document.getElementById('session-name').textContent = 'no session loaded';
    setStatus('READY');
    updateAutoTrimBtnState();
    updateSlotButtons();
    updateAddTrackVisibility();
  }

  // ── INIT ───────────────────────────────────────────────────────────────────
  function init() {
    if (initDone) return;
    initDone = true;

    // File upload
    const fileInput = document.getElementById('file-input');
    document.getElementById('btn-upload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) loadFile(e.target.files[0]);
      e.target.value = '';
    });

    // Add Track — up to MAX_TRACKS audio files to gather samples from
    document.getElementById('btn-add-track')?.addEventListener('click', () => {
      const nextEmpty = tracks.findIndex(t => !t);
      if (nextEmpty === -1) return;
      pendingTrackIdx = nextEmpty;
      fileInput.click();
    });

    // Drag & drop on upload panel
    const panel = document.getElementById('upload-panel');
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('dragging'); });
    panel.addEventListener('dragleave', () => panel.classList.remove('dragging'));
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('dragging');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('audio/')) loadFile(file);
    });

    // Main record button
    document.getElementById('btn-record').addEventListener('click', () => {
      isRecording ? stopRecording(false) : startRecording();
    });

    // Reset
    document.getElementById('btn-reset').addEventListener('click', resetSession);

    // Wave play
    document.getElementById('wave-play-btn').addEventListener('click', waveTogglePlay);

    // Sample mode toggle
    document.getElementById('sample-mode-toggle').addEventListener('change', (e) => {
      setSampleMode(e.target.checked);
    });

    // Pad record button
    document.getElementById('btn-pad-record').addEventListener('click', () => {
      isPadRecording ? stopPadRecording(false) : startPadRecording();
    });

    // Pad record source toggle (Mic / Keyboard)
    const micBtn = document.getElementById('rec-source-mic');
    const kbdBtn = document.getElementById('rec-source-kbd');
    [micBtn, kbdBtn].forEach(btn => {
      btn?.addEventListener('click', () => {
        if (isPadRecording) return; // can't switch mid-recording
        padRecSource = btn.dataset.source;
        micBtn.classList.toggle('active', padRecSource === 'mic');
        kbdBtn.classList.toggle('active', padRecSource === 'keyboard');
      });
    });

    // Assign discard
    document.getElementById('assign-discard-btn').addEventListener('click', () => {
      pendingPadBuffer = null;
      hideAssignBar();
    });

    // Auto Chop
    document.getElementById('btn-auto-chop').addEventListener('click', autoChop);

    // Auto Trim
    document.getElementById('btn-auto-trim').addEventListener('click', autoTrim);

    // Export Pads
    document.getElementById('btn-export-pads').addEventListener('click', exportPads);

    // Waveform zoom
    document.getElementById('wave-zoom-btn')?.addEventListener('click', cycleWaveZoom);
    initWaveScrollbar();

    // ADSR envelope popup
    document.getElementById('env-modal-close')?.addEventListener('click', closeEnvModal);
    document.getElementById('env-modal-overlay')?.addEventListener('mousedown', (e) => {
      if (e.target.id === 'env-modal-overlay') closeEnvModal();
    });
    ['env-attack', 'env-decay', 'env-sustain', 'env-release'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => {
        readEnvDraftFromSliders();
        updateEnvLabels();
        drawEnvCanvas();
      });
    });
    document.querySelectorAll('.env-scope-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        envScope = btn.dataset.scope;
        document.querySelectorAll('.env-scope-btn').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
    document.getElementById('env-save-btn')?.addEventListener('click', saveEnvelope);
    document.getElementById('env-reset-btn')?.addEventListener('click', resetEnvelope);

    // Pad context menu (right-click copy/paste)
    document.getElementById('pad-ctx-copy')?.addEventListener('click', copyTargetPad);
    document.getElementById('pad-ctx-paste')?.addEventListener('click', pasteIntoTargetPad);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#pad-context-menu')) closePadContextMenu();
    });
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.pad')) closePadContextMenu();
    });

    // Waveform canvas interaction
    initWaveInteraction();

    // Mini-waveform edge drag / pan (sample mode) — works for slice pads
    // (against whichever track they were chopped from) and recorded buffer
    // pads (against their own buffer), via padSourceBuffer().
    window.addEventListener('mousemove', (ev) => {
      if (miniDragPad < 0) return;
      const pad = pads[miniDragPad];

      if (miniDragTarget === 'pan-pending') {
        if (Math.abs(ev.clientX - miniDragOriginX) <= 4) return; // not yet a real drag
        miniDragTarget = 'pan';
      }

      if (miniDragTarget === 'pan') {
        const deltaPx   = ev.clientX - miniDragOriginX;
        const normDelta = (deltaPx / miniDragWidth) * miniDragViewSpan;
        pad.viewStart = Math.max(0, Math.min(miniDragViewStartOrigin - normDelta, 1 - miniDragViewSpan));
        renderPadMiniWave(miniDragPad);
        return;
      }

      const srcBuf = padSourceBuffer(pad);
      const refDuration = srcBuf ? srcBuf.duration : 0;
      if (!refDuration) return;
      const delta     = ev.clientX - miniDragOriginX;
      const normDelta = (delta / miniDragWidth) * miniDragViewSpan;
      const minSpan   = 0.05 / refDuration; // 50ms minimum slice
      if (miniDragTarget === 'start') {
        pad.startNorm = Math.max(0, Math.min(miniDragOrigStart + normDelta, miniDragOrigEnd - minSpan));
      } else if (miniDragTarget === 'end') {
        pad.endNorm = Math.min(1, Math.max(miniDragOrigEnd + normDelta, miniDragOrigStart + minSpan));
      }
      renderPadMiniWave(miniDragPad);
      resetPadTimeDisplay(miniDragPad);
      renderWave(playheadNorm);
    });
    window.addEventListener('mouseup', () => {
      if (miniDragPad >= 0) { miniDragPad = -1; miniDragTarget = null; }
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Escape' && ctxMenuTargetPad >= 0) {
        closePadContextMenu();
        return;
      }

      // Space = toggle waveform playback (always available)
      if (!e.repeat && e.key === ' ') {
        e.preventDefault();
        waveTogglePlay();
        return;
      }

      if (pendingPadBuffer !== null) return;
      if (e.repeat) return;

      const key = e.key.toLowerCase();

      // Combo: pad key held + 1 → toggle one-shot; pad key held + 2 → toggle lock
      // (not while adjusting sample bounds — those digits are free to type elsewhere)
      if (!sampleModeOn && (key === '1' || key === '2') && heldPadKeys.size > 0) {
        heldPadKeys.forEach((padIdx) => {
          const pad = pads[padIdx];
          const el  = document.getElementById(`pad-${padIdx}`);
          if (key === '1') {
            pad.oneShot = !pad.oneShot;
            el?.querySelector('.pad-oneshot-btn')?.classList.toggle('active', pad.oneShot);
          } else {
            pad.locked = !pad.locked;
            el?.querySelector('.pad-lock-btn')?.classList.toggle('active', pad.locked);
            el?.classList.toggle('pad-locked', pad.locked);
          }
        });
        return;
      }

      const idx = pads.findIndex(p => p.keyBinding.toLowerCase() === key);
      if (idx >= 0) {
        heldPadKeys.set(key, idx);
        if (sampleModeOn) selectPad(idx); // keep the edited pad in sync with what's being previewed
        triggerPad(idx);
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (pendingPadBuffer !== null) return;
      const key = e.key.toLowerCase();
      if (heldPadKeys.has(key)) {
        const idx = heldPadKeys.get(key);
        heldPadKeys.delete(key);
        stopPad(idx);
      }
    });

    // Resize
    window.addEventListener('resize', resizeWaveCanvas);
  }

  window.Bampler = { init };
})();
