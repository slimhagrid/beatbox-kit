/* branular-stuff.js — Branular granular synth engine
   16-step tracker grid (one or more rows) sourced from percussive grains,
   waveform source + scrub mode, reverb + delay effects
*/

(function () {
  'use strict';

  const STEPS_PER_ROW = 16;
  const STEP_SKIP_PROB = 0.3; // chance a step gets left empty on (re)assignment

  // One color per row — used for waveform grain markers
  const ROW_COLORS = [
    '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
  ];

  const GRAIN_MIN = 0.04, GRAIN_MAX = 0.15; // seconds — typical granular-synthesis grain length
  const POSITION_JITTER = 0.15;  // ±15% of grain length — randomizes scan position each repeat
  const DETUNE_JITTER_CENTS = 12; // ± cents of pitch jitter per grain, for organic texture
  const ONSET_BIAS_PROB = 0.5;   // chance a pick lands near a detected onset vs. anywhere in the buffer
  const ONSET_JITTER_SEC = 0.05; // ±50ms around the onset — wide enough that repeated picks near the
                                  // same hit don't all land on near-identical samples
  const MAX_REC_SECS = 120;

  // Scrub mode — drag directly on the waveform to scan/spray grains live.
  // X = scan position, Y = grain size (top = short/glitchy, bottom = long/smooth).
  const SCRUB_GRAIN_MIN = 0.03, SCRUB_GRAIN_MAX = 0.35;
  const SCRUB_DENSITY = 5;          // more overlapping grains per window — denser cloud
  const SCRUB_SPREAD_FACTOR = 3;    // spray radius = grain length × this, around the cursor
  const SCRUB_TRAIL_LIFE = 550;     // ms a fired grain's visual mark stays on the waveform

  // ── STATE ──────────────────────────────────────────────────────────────────
  let audioCtx = null, masterGain = null, dryGain = null;
  let reverbSendGain = null, reverbConvolver = null, reverbReturnGain = null;
  let delaySendGain = null, delayNode = null, delayFeedbackGain = null, delayReturnGain = null;

  let masterBuffer  = null;
  let waveformPeaks = null;
  let initDone      = false;
  let detectedOnsets = []; // seconds — transient positions, biases percussive grain picks

  // Multiple source audio files — masterBuffer/detectedOnsets always mirror
  // audioSlots[activeSlotIdx], so the waveform/scrub/playback code below can
  // keep reading those two globals unchanged. Each slot: { buffer, fullBuffer
  // (original pre-trim buffer, or null), trimOffset, name, onsets }.
  const MAX_TRACKS = 3;
  const audioSlots = [null, null, null];
  let activeSlotIdx = 0;
  let pendingSlotIdx = -1; // slot index [+] is currently uploading into, or -1

  // Tracker: rows[].steps[] — each step: { hasGrain, startNorm, endNorm, locked, fxOn, slot }
  const rows = [];
  let isPlaying  = false;
  let currentStep = 0;
  let bpm = 120;
  let playTimeoutId = null;

  // Step left-click-drag selection + right-click copy/paste
  let copiedGrains = []; // [{ hasGrain, startNorm, endNorm }, ...] — order = paste order
  let ctxMenuTarget = null; // { rowIdx, stepIdx } | null — paste anchor
  let selectDragActive = false;
  let selectDragStartFlat = -1;
  const selectedCells = new Set(); // flattened step indices (rowIdx * STEPS_PER_ROW + stepIdx)

  // Row-delete mode — armed via [X], rows are marked by clicking their label
  let deleteModeOn = false;
  const markedForDelete = new Set(); // rowIdx values

  // Row-group mode — armed via [G], 2+ rows marked by clicking their label
  // play their steps simultaneously instead of one after another.
  let groupModeOn = false;
  const pendingGroupRows = new Set(); // rowIdx values being built into a group
  let nextGroupId = 1; // internal unique id — displayed numbers (G1, G2…) are recomputed fresh

  // Tracker output recording — [●] arms it, then ▶ starts capture
  const TRACKER_REC_MAX_SECS = 60;
  let trackerRecState = 'idle'; // 'idle' | 'armed' | 'recording'
  let trackerMediaRecorder = null;
  let trackerRecChunks = [];
  let trackerRecDestNode = null;
  let trackerRecAutoStopId = null;

  // 2-minute trim selection — only engaged when an uploaded file runs long.
  // wave-play-btn doubles as the confirm (✓) button while this is active.
  // fullBuffer/fullBufferName/trimOffsetSec are transient — they describe
  // whichever trim is in progress right now; the per-slot record (so [~] can
  // re-open it later) lives on audioSlots[slot].fullBuffer/.trimOffset.
  let fullBuffer = null;     // full-length decoded buffer awaiting a trim choice
  let fullBufferName = '';
  let trimOffsetSec = 0;     // chosen start of the MAX_REC_SECS window within fullBuffer
  let trimTargetSlot = 0;    // which audioSlots index this trim will commit to
  let trimModeOn = false;
  let trimDragActive = false;
  let trimDragStartX = 0;
  let trimDragStartOffsetSec = 0;
  let trimPeaks = null;      // waveform peaks for the full (untrimmed) buffer
  let trimAdjustBtnEl = null; // the dynamically-created [~] button, or null if not needed

  // Scrub state
  let scrubModeOn = false;
  const scrubState = { stopped: true, posNorm: 0, sizeNorm: 0.3, timeoutId: null };
  let scrubTrail = []; // { posNorm, firedAt } — recent grain fires, drawn fading out
  let scrubRafHandle = null;

  // Waveform playback
  let wavePlayback = { playing: false, startedAt: 0, offsetSec: 0, source: null };
  let playheadNorm = 0;
  let rafHandle = null;

  // Recording
  let isRecording = false;
  let recState = null;
  let recInterval = null;
  let recSeconds = 0;

  // Effects state
  const fx = {
    reverbMix: 0.3,
    reverbDecay: 1.8,
    delayTime: 0.25,
    delayFeedback: 0.35,
  };
  const FX_PARAMS = ['reverbMix', 'reverbDecay', 'delayTime', 'delayFeedback'];
  const FX_RANGES = {
    reverbMix:     { min: 0,   max: 1,   step: 0.02, fmt: v => `${Math.round(v * 100)}%` },
    reverbDecay:   { min: 0.2, max: 5,   step: 0.1,  fmt: v => `${v.toFixed(1)}s` },
    delayTime:     { min: 0,   max: 1,   step: 0.02, fmt: v => `${Math.round(v * 1000)}ms` },
    delayFeedback: { min: 0,   max: 0.9, step: 0.02, fmt: v => `${Math.round(v * 100)}%` },
  };
  let fxMenuOpen = false;
  let fxFocusIdx = 0;

  // ── AUDIO CONTEXT + EFFECT CHAIN ──────────────────────────────────────────
  function buildImpulse(decaySec) {
    const rate = audioCtx.sampleRate;
    const len  = Math.max(1, Math.floor(rate * decaySec));
    const impulse = audioCtx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      }
    }
    return impulse;
  }

  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.connect(audioCtx.destination);

      dryGain = audioCtx.createGain();
      dryGain.gain.value = 1;
      dryGain.connect(masterGain);

      reverbSendGain  = audioCtx.createGain();
      reverbSendGain.gain.value = fx.reverbMix;
      reverbConvolver = audioCtx.createConvolver();
      reverbConvolver.buffer = buildImpulse(fx.reverbDecay);
      reverbReturnGain = audioCtx.createGain();
      reverbSendGain.connect(reverbConvolver);
      reverbConvolver.connect(reverbReturnGain);
      reverbReturnGain.connect(masterGain);

      delaySendGain = audioCtx.createGain();
      delaySendGain.gain.value = 0.5;
      delayNode = audioCtx.createDelay(1.0);
      delayNode.delayTime.value = fx.delayTime;
      delayFeedbackGain = audioCtx.createGain();
      delayFeedbackGain.gain.value = fx.delayFeedback;
      delayReturnGain = audioCtx.createGain();

      delaySendGain.connect(delayNode);
      delayNode.connect(delayFeedbackGain);
      delayFeedbackGain.connect(delayNode);
      delayNode.connect(delayReturnGain);
      delayReturnGain.connect(masterGain);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function setReverbMix(v)     { fx.reverbMix = v;     if (reverbSendGain) reverbSendGain.gain.value = v; }
  function setReverbDecay(v)   { fx.reverbDecay = v;   if (audioCtx && reverbConvolver) reverbConvolver.buffer = buildImpulse(v); }
  function setDelayTime(v)     { fx.delayTime = v;      if (delayNode) delayNode.delayTime.value = v; }
  function setDelayFeedback(v) { fx.delayFeedback = v;  if (delayFeedbackGain) delayFeedbackGain.gain.value = v; }

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function fmtTime(sec) {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${ss.toString().padStart(2, '0')}`;
  }

  function setStatus(text) {
    const el = document.getElementById('shell-status');
    if (el) el.textContent = text;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ── ONSET DETECTION ────────────────────────────────────────────────────────
  // Lightweight energy-based transient detector: chunks the buffer into 10ms
  // windows, flags windows whose RMS jumps well above their recent average.
  // Used to bias random grain picks toward percussive hits in the source.
  function detectOnsets(buffer) {
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const winSize = Math.max(1, Math.floor(sr * 0.01));
    const energies = [];
    for (let i = 0; i + winSize <= data.length; i += winSize) {
      let sum = 0;
      for (let j = i; j < i + winSize; j++) sum += data[j] * data[j];
      energies.push(Math.sqrt(sum / winSize));
    }

    const lookback = 4;
    const onsets = [];
    for (let i = lookback; i < energies.length; i++) {
      let avgPrev = 0;
      for (let k = i - lookback; k < i; k++) avgPrev += energies[k];
      avgPrev /= lookback;
      if (energies[i] > avgPrev * 1.5 + 0.01 && energies[i] > 0.02) {
        onsets.push((i * winSize) / sr);
      }
    }

    const filtered = [];
    onsets.forEach((t) => {
      if (!filtered.length || t - filtered[filtered.length - 1] > 0.06) filtered.push(t);
    });
    return filtered;
  }

  // ── WAVEFORM PEAKS + RENDER ────────────────────────────────────────────────
  function computePeaks(buffer, width) {
    const data = buffer.getChannelData(0);
    const N = data.length;
    const out = [];
    for (let x = 0; x < width; x++) {
      const s = Math.floor(x / width * N);
      const e = Math.floor((x + 1) / width * N);
      let mn = 0, mx = 0;
      for (let i = s; i < e; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
      out.push({ min: mn, max: mx });
    }
    return out;
  }

  function resizeWaveCanvas() {
    const canvas = document.getElementById('branular-wave-canvas');
    if (!canvas) return;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight || 100;
    if (!W) return;
    canvas.width = W;
    canvas.height = H;
    if (masterBuffer) {
      waveformPeaks = computePeaks(masterBuffer, W);
      renderWave(playheadNorm);
    }
  }

  function renderWave(phNorm) {
    const canvas = document.getElementById('branular-wave-canvas');
    if (!canvas) return;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const ctx = canvas.getContext('2d');
    const mid = H / 2;

    ctx.fillStyle = '#f5f4ef';
    ctx.fillRect(0, 0, W, H);

    // Grain region markers — one color per row, one band per assigned step.
    // Only steps sourced from the slot currently on screen are shown; a
    // step pulled from another track has no meaningful position here.
    rows.forEach((row, rowIdx) => {
      const color = ROW_COLORS[rowIdx % ROW_COLORS.length];
      row.steps.forEach((step) => {
        if (!step.hasGrain || step.slot !== activeSlotIdx) return;
        const sx = Math.floor(step.startNorm * W);
        const ex = Math.ceil(step.endNorm * W);
        const w  = Math.max(1, ex - sx);
        ctx.fillStyle = hexToRgba(color, 0.18);
        ctx.fillRect(sx, 0, w, H);
        ctx.fillStyle = hexToRgba(color, 0.85);
        ctx.fillRect(sx, 0, w, 4);
      });
    });

    // Grain trail — one fading translucent mark per scrub grain actually
    // fired, at the position it actually sampled (post-spread).
    if (scrubModeOn && scrubTrail.length && masterBuffer) {
      const now = performance.now();
      const grainLen = SCRUB_GRAIN_MIN + scrubState.sizeNorm * (SCRUB_GRAIN_MAX - SCRUB_GRAIN_MIN);
      const halfWidthPx = Math.max(1, (grainLen / masterBuffer.duration) * W / 2);
      scrubTrail.forEach((t) => {
        const age = now - t.firedAt;
        if (age >= SCRUB_TRAIL_LIFE) return;
        const alpha = 0.55 * (1 - age / SCRUB_TRAIL_LIFE);
        const cx = t.posNorm * W;
        ctx.fillStyle = hexToRgba('#4de8ff', alpha);
        ctx.fillRect(cx - halfWidthPx, 0, halfWidthPx * 2, H);
        ctx.fillStyle = hexToRgba('#1aa8c4', alpha + 0.2);
        ctx.fillRect(cx - halfWidthPx, 0, halfWidthPx * 2, 4);
      });
    }

    if (waveformPeaks) {
      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      for (let x = 0; x < W && x < waveformPeaks.length; x++) {
        const { min, max } = waveformPeaks[x];
        const yT = mid - max * mid * 0.9;
        const yB = mid - min * mid * 0.9;
        ctx.fillRect(x, yT, 1, Math.max(1, yB - yT));
      }
    }

    // Scrub cursor line — drawn above the waveform bars so it stays visible
    if (scrubModeOn && !scrubState.stopped && masterBuffer) {
      const cx = Math.floor(scrubState.posNorm * W);
      ctx.strokeStyle = '#1aa8c4';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
    }

    if (phNorm > 0 && phNorm < 1) {
      const px = Math.floor(phNorm * W);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }
  }

  function updateRuler(duration) {
    const ticks = document.querySelectorAll('#wave-ruler .ruler-tick');
    if (ticks.length >= 5) {
      ticks[0].textContent = '0:00';
      ticks[1].textContent = fmtTime(duration * 0.25);
      ticks[2].textContent = fmtTime(duration * 0.5);
      ticks[3].textContent = fmtTime(duration * 0.75);
      ticks[4].textContent = fmtTime(duration);
    }
    const el = document.getElementById('wave-time-tot');
    if (el) el.textContent = fmtTime(duration);
  }

  // ── WAVEFORM INTERACTION + PLAYBACK ───────────────────────────────────────
  function waveNorm(clientX) {
    const canvas = document.getElementById('branular-wave-canvas');
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function waveNormY(clientY) {
    const canvas = document.getElementById('branular-wave-canvas');
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  }

  function initWaveInteraction() {
    const canvas = document.getElementById('branular-wave-canvas');
    if (!canvas) return;
    canvas.addEventListener('mousedown', (e) => {
      if (trimModeOn) { startTrimDrag(e); return; }
      if (!masterBuffer || deleteModeOn) return;
      if (scrubModeOn) {
        startScrub(e);
      } else {
        seekWave(waveNorm(e.clientX));
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (trimModeOn && trimDragActive) { updateTrimDrag(e); return; }
      if (scrubModeOn && !scrubState.stopped) updateScrub(e);
    });
  }

  function seekWave(norm) {
    wavePlayback.offsetSec = norm * masterBuffer.duration;
    playheadNorm = norm;
    if (wavePlayback.playing) {
      if (wavePlayback.source) { wavePlayback.source.onended = null; try { wavePlayback.source.stop(); } catch (_) {} }
      wavePlayback.source = null;
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
    wavePlayback.source = src;
    wavePlayback.startedAt = ctx.currentTime;
    wavePlayback.playing = true;
    document.getElementById('wave-play-btn').textContent = '■';

    src.onended = () => {
      if (!wavePlayback.playing) return;
      wavePlayback.playing = false;
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
    playheadNorm = Math.min(1, elapsed / masterBuffer.duration);
    renderWave(playheadNorm);
    const el = document.getElementById('wave-time-cur');
    if (el) el.textContent = fmtTime(elapsed);
    if (playheadNorm < 1) rafHandle = requestAnimationFrame(tickWaveHead);
  }

  // ── GRAIN PRIMITIVE ────────────────────────────────────────────────────────
  // Low-level granular-synthesis unit: a short windowed slice of the given
  // source buffer, pitch-shifted via playbackRate. startSec/grainLen are in
  // buffer time; rate decouples pitch from the grain's emission rate. Takes
  // an explicit buffer (rather than reading masterBuffer) so a step can
  // always play from whichever track it was actually assigned from, even
  // while a different track is the one currently on screen.
  function fireGrain(buffer, startSec, grainLen, rate, useFx = true) {
    if (!buffer || grainLen < 0.005) return;
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const offset = Math.max(0, Math.min(buffer.duration - grainLen, startSec));

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;

    // Wall-clock playback time shrinks/grows with playbackRate — envelope
    // and stop() need to use this, not the buffer-time grain length.
    const playDur = grainLen / rate;
    const attack  = Math.min(0.012, playDur * 0.3);
    const release = Math.min(0.025, playDur * 0.3);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + attack);
    env.gain.setValueAtTime(1, Math.max(now + attack, now + playDur - release));
    env.gain.linearRampToValueAtTime(0, now + playDur);

    src.connect(env);
    env.connect(dryGain);
    if (useFx) {
      env.connect(reverbSendGain);
      env.connect(delaySendGain);
    }

    src.start(now, offset, grainLen);
    src.stop(now + playDur + 0.05);
  }

  // ── TRACKER GRID ───────────────────────────────────────────────────────────
  function makeEmptyStep() {
    return { hasGrain: false, startNorm: 0, endNorm: 0, locked: false, fxOn: false, slot: 0 };
  }

  function makeEmptyRow() {
    return { steps: Array.from({ length: STEPS_PER_ROW }, makeEmptyStep), groupId: null };
  }

  // Picks a grain start point. Only biases toward a detected percussive
  // onset some of the time (ONSET_BIAS_PROB) — always preferring onsets
  // would mean a track with just a handful of hits (or none, e.g. sustained
  // strings/keys) keeps landing on the same few spots across every row.
  // The rest of the time it scans anywhere in the buffer, so melodic/sustained
  // material still gets explored instead of being starved out.
  function randomPercussiveLayer(dur) {
    const len = GRAIN_MIN + Math.random() * (GRAIN_MAX - GRAIN_MIN);
    let startSec;
    if (detectedOnsets.length && Math.random() < ONSET_BIAS_PROB) {
      const base = detectedOnsets[Math.floor(Math.random() * detectedOnsets.length)];
      const jitterSec = (Math.random() * 2 - 1) * ONSET_JITTER_SEC;
      startSec = Math.max(0, Math.min(Math.max(0, dur - len), base + jitterSec));
    } else {
      startSec = Math.random() * Math.max(0, dur - len);
    }
    return {
      startNorm: startSec / dur,
      endNorm: Math.min(1, (startSec + len) / dur),
    };
  }

  function buildTrackerRow() {
    const row = makeEmptyRow();
    rows.push(row);
    renderTrackerRow(row, rows.length - 1);
    return row;
  }

  // Full re-render of every row from the `rows` array — used after a
  // deletion since removing a row from the middle shifts every index after
  // it, and the simplest way to keep dataset.row/closures correct is to
  // throw away the DOM and rebuild it fresh.
  function rebuildTrackerDOM() {
    const wrap = document.getElementById('tracker-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    rows.forEach((row, i) => renderTrackerRow(row, i));
  }

  // ── ROW GROUPING (rows that play their steps simultaneously) ──────────────
  // Display numbers (G1, G2…) are recomputed from current row order each
  // time, rather than stored, so dissolving a group never leaves a gap.
  function getGroupDisplayNumber(groupId) {
    if (groupId == null) return null;
    const seen = [];
    rows.forEach((r) => { if (r.groupId != null && !seen.includes(r.groupId)) seen.push(r.groupId); });
    const idx = seen.indexOf(groupId);
    return idx === -1 ? null : idx + 1;
  }

  function setRowLabelText(label, row, rowIdx) {
    label.textContent = row.groupId != null ? `G${getGroupDisplayNumber(row.groupId)}` : String(rowIdx + 1);
  }

  // Clicking an ungrouped row adds just that row to the pending selection;
  // clicking a row that's already in a group pulls in all of its groupmates
  // too, so re-clicking individual members lets you peel them back out.
  function toggleGroupPending(rowIdx) {
    const row = rows[rowIdx];
    if (pendingGroupRows.has(rowIdx)) {
      pendingGroupRows.delete(rowIdx);
    } else {
      pendingGroupRows.add(rowIdx);
      if (row.groupId != null) {
        rows.forEach((r, i) => { if (r.groupId === row.groupId) pendingGroupRows.add(i); });
      }
    }
    refreshGroupPendingVisuals();
  }

  function refreshGroupPendingVisuals() {
    document.querySelectorAll('.tracker-row-label.group-pending').forEach((el) => el.classList.remove('group-pending'));
    pendingGroupRows.forEach((idx) => {
      const el = document.querySelector(`.tracker-row[data-row="${idx}"] .tracker-row-label`);
      if (el) el.classList.add('group-pending');
    });
  }

  function setToolInertExceptGroup(on) {
    ['btn-upload', 'btn-record', 'wave-play-btn', 'btn-reset', 'scrub-mode-toggle', 'btn-trim-adjust', 'btn-add-track',
     'btn-select-grains', 'btn-play-tracker', 'btn-record-tracker', 'btn-layer-grains', 'btn-reset-grains', 'btn-delete-rows', 'bpm-slider']
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = on;
      });
    const wrap = document.getElementById('tracker-wrap');
    if (wrap) wrap.classList.toggle('group-mode', on);
  }

  function enterGroupMode() {
    if (!masterBuffer || groupModeOn) return;
    exitDeleteMode(false);
    groupModeOn = true;
    pendingGroupRows.clear();
    stopPlayback();
    stopScrub();
    closeFxMenu();
    closeStepContextMenu();
    clearSelection();
    selectDragActive = false;
    setToolInertExceptGroup(true);
    const btn = document.getElementById('btn-group-rows');
    if (btn) { btn.classList.add('armed-group'); btn.title = 'Click 2+ row numbers to group, click G again to confirm'; }
    setStatus('SELECT ROWS TO GROUP');
  }

  function exitGroupMode(commit) {
    if (!groupModeOn) return;
    if (commit && pendingGroupRows.size >= 2) {
      const memberSet = new Set(pendingGroupRows);

      // A row left out of this new selection but sharing an old group with
      // one that IS included loses that membership; if that leaves the old
      // group with fewer than 2 members, dissolve it entirely.
      const oldGroupIds = new Set();
      memberSet.forEach((idx) => { if (rows[idx].groupId != null) oldGroupIds.add(rows[idx].groupId); });
      oldGroupIds.forEach((gid) => {
        const remaining = rows.filter((r, i) => r.groupId === gid && !memberSet.has(i)).length;
        if (remaining < 2) {
          rows.forEach((r) => { if (r.groupId === gid) r.groupId = null; });
        }
      });

      const newId = nextGroupId++;
      memberSet.forEach((idx) => { rows[idx].groupId = newId; });
      rebuildTrackerDOM();
      renderWave(playheadNorm);
    }
    pendingGroupRows.clear();
    groupModeOn = false;
    setToolInertExceptGroup(false);
    const btn = document.getElementById('btn-group-rows');
    if (btn) { btn.classList.remove('armed-group'); btn.title = 'Group 2+ rows to play together'; }
    if (masterBuffer) setStatus('LOADED');
  }

  function toggleGroupMode() {
    groupModeOn ? exitGroupMode(true) : enterGroupMode();
  }

  // ── STEP SELECTION (drag-highlight a run of steps for multi-copy) ─────────
  function flatIndex(rowIdx, stepIdx) {
    return rowIdx * STEPS_PER_ROW + stepIdx;
  }
  function cellAtFlatIndex(flat) {
    return { rowIdx: Math.floor(flat / STEPS_PER_ROW), stepIdx: flat % STEPS_PER_ROW };
  }

  function updateSelectionRange(aFlat, bFlat) {
    const lo = Math.min(aFlat, bFlat), hi = Math.max(aFlat, bFlat);
    selectedCells.clear();
    for (let f = lo; f <= hi; f++) selectedCells.add(f);
    document.querySelectorAll('.tracker-cell.selected').forEach((el) => el.classList.remove('selected'));
    selectedCells.forEach((f) => {
      const { rowIdx, stepIdx } = cellAtFlatIndex(f);
      const cell = document.querySelector(`.tracker-cell[data-row="${rowIdx}"][data-step="${stepIdx}"]`);
      if (cell) cell.classList.add('selected');
    });
  }

  function clearSelection() {
    selectedCells.clear();
    document.querySelectorAll('.tracker-cell.selected').forEach((el) => el.classList.remove('selected'));
  }

  // Returns every step a per-cell control button should act on: the whole
  // drag-highlighted selection when one is active, otherwise just the
  // clicked cell.
  function getSelectionTargets(rowIdx, stepIdx) {
    if (selectedCells.size > 1) return Array.from(selectedCells).map(cellAtFlatIndex);
    return [{ rowIdx, stepIdx }];
  }

  function renderTrackerRow(row, rowIdx) {
    const wrap = document.getElementById('tracker-wrap');
    if (!wrap) return;

    const rowEl = document.createElement('div');
    rowEl.className = 'tracker-row';
    rowEl.dataset.row = rowIdx;
    // Same color this row's grains are marked with on the waveform —
    // squares and waveform tabs read as the same row at a glance.
    rowEl.style.setProperty('--row-color', ROW_COLORS[rowIdx % ROW_COLORS.length]);

    const label = document.createElement('span');
    label.className = 'tracker-row-label';
    setRowLabelText(label, row, rowIdx);
    if (row.groupId != null) label.classList.add('grouped');
    label.addEventListener('click', (e) => {
      if (groupModeOn) {
        e.stopPropagation();
        toggleGroupPending(Number(rowEl.dataset.row));
        return;
      }
      if (!deleteModeOn) return;
      e.stopPropagation();
      const idx = Number(rowEl.dataset.row);
      if (markedForDelete.has(idx)) {
        markedForDelete.delete(idx);
        label.textContent = String(idx + 1);
        label.classList.remove('marked-delete');
      } else {
        markedForDelete.add(idx);
        label.textContent = '✕';
        label.classList.add('marked-delete');
      }
    });
    rowEl.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'tracker-row-grid';

    row.steps.forEach((step, i) => {
      const cell = document.createElement('div');
      cell.className = 'tracker-cell';
      cell.dataset.row = rowIdx;
      cell.dataset.step = i;
      cell.innerHTML = `
        <div class="tracker-cell-controls">
          <button class="cell-clear-btn" title="Remove this step's grain">✕</button>
          <button class="cell-fx-btn" title="Toggle FX (reverb/delay) send for this step">FX</button>
          <button class="cell-lock-btn" title="Lock: skip this square on Select Grains">LK</button>
        </div>`;

      // Left-click + drag highlights a run of steps (for multi-copy); a plain
      // click with no movement just previews the step, as before.
      cell.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('.tracker-cell-controls')) return;
        e.preventDefault();
        selectDragActive = true;
        selectDragStartFlat = flatIndex(rowIdx, i);
        updateSelectionRange(selectDragStartFlat, selectDragStartFlat);
      });
      cell.addEventListener('mouseenter', () => {
        if (!selectDragActive) return;
        updateSelectionRange(selectDragStartFlat, flatIndex(rowIdx, i));
      });

      const lockBtn  = cell.querySelector('.cell-lock-btn');
      const fxBtn    = cell.querySelector('.cell-fx-btn');
      const clearBtn = cell.querySelector('.cell-clear-btn');

      // Restore this step's existing state — matters on rebuilds (e.g. after
      // deleting a row), where cells are recreated fresh from `rows` data.
      cell.classList.toggle('has-grain', step.hasGrain);
      cell.classList.toggle('locked', step.locked);
      lockBtn.classList.toggle('active', step.locked);
      fxBtn.classList.toggle('active', step.fxOn);

      // When multiple steps are selected, these buttons apply to the whole
      // selection (using the clicked step's own new value as the target),
      // not just the one cell that was clicked.
      lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newVal = !step.locked;
        getSelectionTargets(rowIdx, i).forEach(({ rowIdx: r, stepIdx: s }) => {
          const st = rows[r].steps[s];
          st.locked = newVal;
          const cellEl = document.querySelector(`.tracker-cell[data-row="${r}"][data-step="${s}"]`);
          if (cellEl) {
            cellEl.classList.toggle('locked', newVal);
            const btn = cellEl.querySelector('.cell-lock-btn');
            if (btn) btn.classList.toggle('active', newVal);
          }
        });
      });

      fxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newVal = !step.fxOn;
        getSelectionTargets(rowIdx, i).forEach(({ rowIdx: r, stepIdx: s }) => {
          const st = rows[r].steps[s];
          st.fxOn = newVal;
          const cellEl = document.querySelector(`.tracker-cell[data-row="${r}"][data-step="${s}"]`);
          const btn = cellEl && cellEl.querySelector('.cell-fx-btn');
          if (btn) btn.classList.toggle('active', newVal);
        });
      });

      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        getSelectionTargets(rowIdx, i).forEach(({ rowIdx: r, stepIdx: s }) => {
          rows[r].steps[s].hasGrain = false;
          updateCellVisual(r, s);
        });
        renderWave(playheadNorm);
      });

      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openStepContextMenu(e, rowIdx, i);
      });

      grid.appendChild(cell);
    });

    rowEl.appendChild(grid);
    wrap.appendChild(rowEl);
  }

  function updateCellVisual(rowIdx, stepIdx) {
    const cell = document.querySelector(`.tracker-cell[data-row="${rowIdx}"][data-step="${stepIdx}"]`);
    if (cell) cell.classList.toggle('has-grain', rows[rowIdx].steps[stepIdx].hasGrain);
  }

  // ── STEP CONTEXT MENU (copy/paste audio between steps) ────────────────────
  // Copy acts on the current drag-highlighted selection when one exists
  // (multi-step copy); otherwise it falls back to just the right-clicked
  // step. Paste always lands starting at the right-clicked step, in the
  // same order the steps were copied.
  function openStepContextMenu(e, rowIdx, stepIdx) {
    ctxMenuTarget = { rowIdx, stepIdx };
    const menu = document.getElementById('step-context-menu');
    const copyBtn = document.getElementById('ctx-copy');
    const pasteBtn = document.getElementById('ctx-paste');

    copyBtn.textContent = selectedCells.size > 1 ? `Copy Steps (${selectedCells.size})` : 'Copy Grain';
    pasteBtn.textContent = copiedGrains.length > 1 ? `Paste Steps (${copiedGrains.length})` : 'Paste Grain';
    pasteBtn.disabled = copiedGrains.length === 0;

    menu.style.display = 'flex';
    const menuW = menu.offsetWidth, menuH = menu.offsetHeight;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 4);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 4);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
  }

  function closeStepContextMenu() {
    const menu = document.getElementById('step-context-menu');
    if (menu) menu.style.display = 'none';
    ctxMenuTarget = null;
  }

  function stepToClipboardEntry(step) {
    return step.hasGrain
      ? { hasGrain: true, startNorm: step.startNorm, endNorm: step.endNorm, slot: step.slot }
      : { hasGrain: false, startNorm: 0, endNorm: 0, slot: 0 };
  }

  function copyTargetStep() {
    if (selectedCells.size > 1) {
      copiedGrains = Array.from(selectedCells).sort((a, b) => a - b).map((f) => {
        const { rowIdx, stepIdx } = cellAtFlatIndex(f);
        return stepToClipboardEntry(rows[rowIdx].steps[stepIdx]);
      });
      clearSelection();
    } else if (ctxMenuTarget) {
      copiedGrains = [stepToClipboardEntry(rows[ctxMenuTarget.rowIdx].steps[ctxMenuTarget.stepIdx])];
    }
    closeStepContextMenu();
  }

  // Pastes only the audio (start/end/hasGrain) onto each target step in
  // sequence, starting at the right-clicked anchor — locks and FX-send
  // settings on the destination steps are left alone. Runs that would
  // overflow past the last step are silently truncated.
  function pasteIntoTargetStep() {
    if (!ctxMenuTarget || !copiedGrains.length) return;
    const totalSteps = rows.length * STEPS_PER_ROW;
    const startFlat = flatIndex(ctxMenuTarget.rowIdx, ctxMenuTarget.stepIdx);

    copiedGrains.forEach((g, offset) => {
      const flat = startFlat + offset;
      if (flat >= totalSteps) return;
      const { rowIdx, stepIdx } = cellAtFlatIndex(flat);
      const step = rows[rowIdx].steps[stepIdx];
      step.hasGrain = g.hasGrain;
      step.startNorm = g.startNorm;
      step.endNorm = g.endNorm;
      step.slot = g.slot;
      updateCellVisual(rowIdx, stepIdx);
    });

    renderWave(playheadNorm);
    closeStepContextMenu();
  }

  // rowIdxs is an array so every row in a playing group can be highlighted
  // together for the same step column.
  function setActiveCells(rowIdxs, stepIdx) {
    document.querySelectorAll('.tracker-cell.step-active').forEach((el) => el.classList.remove('step-active'));
    rowIdxs.forEach((rowIdx) => {
      const cell = document.querySelector(`.tracker-cell[data-row="${rowIdx}"][data-step="${stepIdx}"]`);
      if (cell) cell.classList.add('step-active');
    });
  }

  function clearActiveCell() {
    document.querySelectorAll('.tracker-cell.step-active').forEach((el) => el.classList.remove('step-active'));
  }

  // Re-randomizes every unlocked step across all rows. Some steps land empty
  // on purpose — that's the "spontaneous" part of the tracker.
  function selectGrains() {
    if (!masterBuffer) return;
    const dur = masterBuffer.duration;
    rows.forEach((row, rowIdx) => {
      row.steps.forEach((step, i) => {
        if (step.locked) return;
        if (Math.random() < STEP_SKIP_PROB) {
          step.hasGrain = false;
        } else {
          const layer = randomPercussiveLayer(dur);
          step.startNorm = layer.startNorm;
          step.endNorm = layer.endNorm;
          step.hasGrain = true;
          step.slot = activeSlotIdx;
        }
        updateCellVisual(rowIdx, i);
      });
    });
    renderWave(playheadNorm);
    setStatus('GRAINS READY');
  }

  // [L] — adds a brand-new row of 16 steps, pre-filled with fresh grains.
  function addRow() {
    if (!masterBuffer) return;
    const dur = masterBuffer.duration;
    const row = buildTrackerRow();
    const rowIdx = rows.length - 1;
    row.steps.forEach((step, i) => {
      if (Math.random() < STEP_SKIP_PROB) return;
      const layer = randomPercussiveLayer(dur);
      step.startNorm = layer.startNorm;
      step.endNorm = layer.endNorm;
      step.hasGrain = true;
      step.slot = activeSlotIdx;
      updateCellVisual(rowIdx, i);
    });
    renderWave(playheadNorm);
    setStatus('ROW ADDED');
  }

  // Click a square outside playback to audition its grain.
  function previewStep(rowIdx, stepIdx) {
    const step = rows[rowIdx] && rows[rowIdx].steps[stepIdx];
    const slot = step && audioSlots[step.slot];
    if (!step || !step.hasGrain || !slot) return;
    const buf = slot.buffer;
    const grainLen = (step.endNorm - step.startNorm) * buf.duration;
    const detuneCents = (Math.random() * 2 - 1) * DETUNE_JITTER_CENTS;
    const rate = Math.pow(2, detuneCents / 1200);
    fireGrain(buf, step.startNorm * buf.duration, grainLen, rate, step.fxOn);
  }

  // [↺] — back to a single empty row.
  function resetTracker() {
    stopPlayback();
    hardStopTrackerRecording();
    closeStepContextMenu();
    exitDeleteMode(false);
    exitGroupMode(false);
    clearSelection();
    selectDragActive = false;
    rows.length = 0;
    const wrap = document.getElementById('tracker-wrap');
    if (wrap) wrap.innerHTML = '';
    buildTrackerRow();
    renderWave(playheadNorm);
    if (masterBuffer) setStatus('LOADED');
  }

  // ── ROW DELETE MODE ────────────────────────────────────────────────────────
  // [X] arms the tool: row labels become clickable (turning into ✕ when
  // marked) and everything else goes inert until [X] is pressed again, which
  // removes the marked rows and exits the mode. Pressing [X] twice with
  // nothing marked is a no-op.
  function setToolInertExceptDelete(on) {
    ['btn-upload', 'btn-record', 'wave-play-btn', 'btn-reset', 'scrub-mode-toggle', 'btn-trim-adjust', 'btn-add-track',
     'btn-select-grains', 'btn-play-tracker', 'btn-record-tracker', 'btn-layer-grains', 'btn-group-rows', 'btn-reset-grains', 'bpm-slider']
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = on;
      });
    const wrap = document.getElementById('tracker-wrap');
    if (wrap) wrap.classList.toggle('delete-mode', on);
  }

  function enterDeleteMode() {
    if (!masterBuffer || deleteModeOn) return;
    exitGroupMode(false);
    deleteModeOn = true;
    markedForDelete.clear();
    stopPlayback();
    stopScrub();
    closeFxMenu();
    closeStepContextMenu();
    clearSelection();
    selectDragActive = false;
    setToolInertExceptDelete(true);
    const btn = document.getElementById('btn-delete-rows');
    if (btn) { btn.classList.add('active'); btn.title = 'Click a row number to mark it, click ✕ again to remove marked rows'; }
    setStatus('SELECT ROWS TO DELETE');
  }

  function exitDeleteMode(commit) {
    if (!deleteModeOn) return;
    if (commit && markedForDelete.size) {
      Array.from(markedForDelete).sort((a, b) => b - a).forEach((idx) => rows.splice(idx, 1));
      if (!rows.length) rows.push(makeEmptyRow());
      rebuildTrackerDOM();
      renderWave(playheadNorm);
    }
    markedForDelete.clear();
    deleteModeOn = false;
    setToolInertExceptDelete(false);
    const btn = document.getElementById('btn-delete-rows');
    if (btn) { btn.classList.remove('active'); btn.title = 'Select rows to delete'; }
    if (masterBuffer) setStatus('LOADED');
  }

  function toggleDeleteMode() {
    deleteModeOn ? exitDeleteMode(true) : enterDeleteMode();
  }

  // ── TRACKER PLAYBACK ───────────────────────────────────────────────────────
  // One playhead moves through every row's steps in sequence — adding a row
  // with [L] appends 16 more steps to the same linear sequence, it does not
  // add another simultaneous track. Grouped rows are the one exception:
  // they're bundled into a single 16-step "unit" so their steps fire
  // together, then playback continues to whatever comes after the group.
  function buildPlayUnits() {
    const seen = new Set();
    const units = [];
    rows.forEach((row, idx) => {
      if (seen.has(idx)) return;
      if (row.groupId != null) {
        const members = [];
        rows.forEach((r2, idx2) => {
          if (r2.groupId === row.groupId) { members.push(idx2); seen.add(idx2); }
        });
        units.push(members);
      } else {
        units.push([idx]);
        seen.add(idx);
      }
    });
    return units;
  }

  function stepTick() {
    if (!isPlaying) return;
    const units = buildPlayUnits();
    const totalSteps = units.length * STEPS_PER_ROW;
    if (totalSteps === 0) { stopPlayback(); return; }

    const unitIdx = Math.floor(currentStep / STEPS_PER_ROW);
    const localStep = currentStep % STEPS_PER_ROW;
    const memberRows = units[unitIdx];

    memberRows.forEach((rowIdx) => {
      const step = rows[rowIdx].steps[localStep];
      const slot = audioSlots[step.slot];
      if (!step.hasGrain || !slot) return;
      const buf = slot.buffer;
      const grainLen = (step.endNorm - step.startNorm) * buf.duration;
      const jitterSec = (Math.random() * 2 - 1) * POSITION_JITTER * grainLen;
      const detuneCents = (Math.random() * 2 - 1) * DETUNE_JITTER_CENTS;
      const rate = Math.pow(2, detuneCents / 1200);
      fireGrain(buf, step.startNorm * buf.duration + jitterSec, grainLen, rate, step.fxOn);
    });

    setActiveCells(memberRows, localStep);
    currentStep = (currentStep + 1) % totalSteps;

    const stepMs = (60000 / bpm) / 4; // 16 steps = one bar of 16th notes
    playTimeoutId = setTimeout(stepTick, stepMs);
  }

  function startPlayback() {
    if (!masterBuffer || isPlaying) return;
    getAudioCtx();
    isPlaying = true;
    currentStep = 0;
    const btn = document.getElementById('btn-play-tracker');
    if (btn) btn.textContent = '■';
    if (trackerRecState === 'armed') startTrackerRecording();
    stepTick();
  }

  function stopPlayback() {
    if (!isPlaying) return;
    isPlaying = false;
    clearTimeout(playTimeoutId);
    clearActiveCell();
    const btn = document.getElementById('btn-play-tracker');
    if (btn) btn.textContent = '▶';
  }

  function togglePlayback() {
    isPlaying ? stopPlayback() : startPlayback();
  }

  // ── TRACKER OUTPUT RECORDING ──────────────────────────────────────────────
  // [●] arms recording; the next ▶ press starts capturing the master output
  // to a file. Pressing [●] again while recording stops it early; otherwise
  // it auto-stops at TRACKER_REC_MAX_SECS.
  function updateRecordBtnVisual() {
    const btn = document.getElementById('btn-record-tracker');
    if (!btn) return;
    btn.classList.toggle('armed', trackerRecState === 'armed');
    btn.classList.toggle('recording', trackerRecState === 'recording');
  }

  function toggleRecordArm() {
    if (trackerRecState === 'recording') {
      stopTrackerRecording();
    } else if (trackerRecState === 'armed') {
      trackerRecState = 'idle';
      updateRecordBtnVisual();
    } else if (masterBuffer) {
      trackerRecState = 'armed';
      updateRecordBtnVisual();
      setStatus('ARMED — PRESS ▶ TO RECORD');
    }
  }

  function startTrackerRecording() {
    const ctx = getAudioCtx();
    trackerRecDestNode = ctx.createMediaStreamDestination();
    masterGain.connect(trackerRecDestNode);

    trackerMediaRecorder = new MediaRecorder(trackerRecDestNode.stream, { mimeType: 'audio/webm' });
    trackerRecChunks = [];
    trackerMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) trackerRecChunks.push(e.data); };
    trackerMediaRecorder.onstop = finalizeTrackerRecording;
    trackerMediaRecorder.start();

    trackerRecState = 'recording';
    updateRecordBtnVisual();
    setStatus('RECORDING');

    trackerRecAutoStopId = setTimeout(() => {
      if (trackerRecState === 'recording') stopTrackerRecording();
    }, TRACKER_REC_MAX_SECS * 1000);
  }

  function stopTrackerRecording() {
    if (trackerRecState !== 'recording' || !trackerMediaRecorder) return;
    clearTimeout(trackerRecAutoStopId);
    trackerMediaRecorder.stop();
  }

  function finalizeTrackerRecording() {
    try { masterGain.disconnect(trackerRecDestNode); } catch (_) {}
    trackerRecDestNode = null;

    const blob = new Blob(trackerRecChunks, { type: 'audio/webm' });
    trackerRecChunks = [];

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `branular-tune_${ts}.webm`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    trackerMediaRecorder = null;
    trackerRecState = 'idle';
    updateRecordBtnVisual();
    setStatus(masterBuffer ? 'LOADED' : 'READY');
  }

  // Cleanup used when resetting the tracker/session — discards without saving.
  function hardStopTrackerRecording() {
    clearTimeout(trackerRecAutoStopId);
    if (trackerMediaRecorder && trackerRecState === 'recording') {
      trackerMediaRecorder.onstop = null;
      try { trackerMediaRecorder.stop(); } catch (_) {}
      try { masterGain.disconnect(trackerRecDestNode); } catch (_) {}
    }
    trackerMediaRecorder = null;
    trackerRecDestNode = null;
    trackerRecChunks = [];
    trackerRecState = 'idle';
    updateRecordBtnVisual();
  }

  // ── SCRUB MODE ─────────────────────────────────────────────────────────────
  // Drag directly on the waveform to scan/spray grains live, the classic
  // granular-synth playing style: X = scan position, Y = grain size.
  function setScrubMode(on) {
    scrubModeOn = on;
    const label = document.getElementById('scrub-mode-label');
    const canvas = document.getElementById('branular-wave-canvas');
    const hint = document.getElementById('wave-hint');
    if (label) label.innerHTML = `Scrub Mode: <strong>${on ? 'ON' : 'OFF'}</strong>`;
    if (canvas) canvas.classList.toggle('scrub-cursor', on);
    if (hint) {
      hint.style.display = on ? '' : 'none';
      if (on) hint.textContent = 'Drag across the waveform to scan grains live — X = position, Y = grain size (top = glitchy, bottom = smooth)';
    }
    if (!on) stopScrub();
  }

  function scrubPosFromEvent(e) {
    return { x: waveNorm(e.clientX), y: waveNormY(e.clientY) };
  }

  function updateScrubHint() {
    const hint = document.getElementById('wave-hint');
    if (!hint || !masterBuffer) return;
    const grainLen = SCRUB_GRAIN_MIN + scrubState.sizeNorm * (SCRUB_GRAIN_MAX - SCRUB_GRAIN_MIN);
    const timeSec = scrubState.posNorm * masterBuffer.duration;
    hint.textContent = `Scanning ${timeSec.toFixed(2)}s · grain ${Math.round(grainLen * 1000)}ms`;
  }

  // Fires one grain near the cursor, but spread across a real spray radius
  // (±grainLen × SCRUB_SPREAD_FACTOR, triangular-weighted toward the center)
  // rather than almost on top of the cursor — this is what gives scrubbing
  // its "grabbing a cloud of grains" character instead of repeating one spot.
  function playScrubGrainInstance(cursorPosNorm, grainLen) {
    const spreadSec = (Math.random() + Math.random() - 1) * grainLen * SCRUB_SPREAD_FACTOR;
    const fineJitterSec = (Math.random() * 2 - 1) * POSITION_JITTER * grainLen;
    const startSec = cursorPosNorm * masterBuffer.duration - grainLen / 2 + spreadSec + fineJitterSec;
    const detuneCents = (Math.random() * 2 - 1) * DETUNE_JITTER_CENTS;
    const rate = Math.pow(2, detuneCents / 1200);
    fireGrain(masterBuffer, startSec, grainLen, rate);

    const grainPosNorm = Math.max(0, Math.min(1, (startSec + grainLen / 2) / masterBuffer.duration));
    scrubTrail.push({ posNorm: grainPosNorm, firedAt: performance.now() });
  }

  function scheduleScrubGrain() {
    if (scrubState.stopped || !masterBuffer) return;
    const grainLen = SCRUB_GRAIN_MIN + scrubState.sizeNorm * (SCRUB_GRAIN_MAX - SCRUB_GRAIN_MIN);
    playScrubGrainInstance(scrubState.posNorm, grainLen);

    const baseInterval = Math.max(0.02, grainLen / SCRUB_DENSITY);
    const timingJitter = (Math.random() * 0.3 - 0.15) * baseInterval;
    scrubState.timeoutId = setTimeout(scheduleScrubGrain, Math.max(15, (baseInterval + timingJitter) * 1000));
  }

  // Continuously redraws while scrubbing so the grain trail fades smoothly
  // even between grain fires, instead of only updating on mouse move.
  function tickScrubTrail() {
    if (scrubState.stopped) { scrubRafHandle = null; return; }
    const now = performance.now();
    scrubTrail = scrubTrail.filter(t => now - t.firedAt < SCRUB_TRAIL_LIFE);
    renderWave(playheadNorm);
    scrubRafHandle = requestAnimationFrame(tickScrubTrail);
  }

  function startScrub(e) {
    if (!masterBuffer) return;
    const { x, y } = scrubPosFromEvent(e);
    scrubState.posNorm = x;
    scrubState.sizeNorm = y;
    scrubState.stopped = false;
    updateScrubHint();
    scheduleScrubGrain();
    if (!scrubRafHandle) scrubRafHandle = requestAnimationFrame(tickScrubTrail);
  }

  function updateScrub(e) {
    if (scrubState.stopped) return;
    const { x, y } = scrubPosFromEvent(e);
    scrubState.posNorm = x;
    scrubState.sizeNorm = y;
    updateScrubHint();
  }

  function stopScrub() {
    if (scrubState.stopped) return;
    scrubState.stopped = true;
    clearTimeout(scrubState.timeoutId);
    cancelAnimationFrame(scrubRafHandle);
    scrubRafHandle = null;
    scrubTrail = [];
    renderWave(playheadNorm);
    if (scrubModeOn) {
      const hint = document.getElementById('wave-hint');
      if (hint) hint.textContent = 'Drag across the waveform to scan grains live — X = position, Y = grain size (top = glitchy, bottom = smooth)';
    }
  }

  // ── PCM ASSEMBLY ───────────────────────────────────────────────────────────
  function buildPcmBuffer(chunks, sampleRate, maxSecs) {
    const maxSamples = Math.floor(maxSecs * sampleRate);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const finalLen = Math.min(total, maxSamples);
    const pcm = new Float32Array(finalLen);
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
        hideProcessing();
        const name = file.name.replace(/\.[^.]+$/, '');
        const targetSlot = pendingSlotIdx >= 0 ? pendingSlotIdx : 0;
        pendingSlotIdx = -1;
        if (buf.duration > MAX_REC_SECS) {
          fullBuffer = buf;
          fullBufferName = name;
          trimOffsetSec = 0;
          trimTargetSlot = targetSlot;
          enterTrimMode();
        } else {
          commitBufferToSlot(targetSlot, buf, name);
        }
      }).catch(err => {
        hideProcessing();
        console.error('Decode error', err);
      });
    };
    reader.readAsArrayBuffer(file);
  }

  // ── TRIM SELECTION (uploads longer than MAX_REC_SECS) ─────────────────────
  // Shows the full waveform with a draggable MAX_REC_SECS-wide window; the
  // wave-play-btn becomes a ✓ to confirm. fullBuffer/trimOffsetSec describe
  // whichever trim is currently in progress; once confirmed, the chosen
  // buffer plus the original fullBuffer/offset are stored on the target
  // slot so [~] can reopen the same adjustment later for that track.
  function ensureTrimAdjustButton() {
    if (trimAdjustBtnEl) return;
    const playBtn = document.getElementById('wave-play-btn');
    const btn = document.createElement('button');
    btn.className = 'wave-play-btn btn-trim-adjust';
    btn.id = 'btn-trim-adjust';
    btn.title = 'Re-pick the 2-minute span for this track';
    btn.textContent = '~';
    btn.addEventListener('click', () => {
      if (trimModeOn) return;
      const slot = audioSlots[activeSlotIdx];
      if (!slot || !slot.fullBuffer) return;
      fullBuffer = slot.fullBuffer;
      fullBufferName = slot.name;
      trimOffsetSec = slot.trimOffset || 0;
      trimTargetSlot = activeSlotIdx;
      enterTrimMode();
    });
    playBtn.insertAdjacentElement('afterend', btn);
    trimAdjustBtnEl = btn;
  }

  function removeTrimAdjustButton() {
    if (trimAdjustBtnEl) { trimAdjustBtnEl.remove(); trimAdjustBtnEl = null; }
  }

  // Shows/hides [~] based on whether the slot currently on screen actually
  // has an original untrimmed buffer to re-pick from.
  function updateTrimAdjustButtonVisibility() {
    const slot = audioSlots[activeSlotIdx];
    if (slot && slot.fullBuffer) ensureTrimAdjustButton();
    else removeTrimAdjustButton();
  }

  function setTrimUIInert(on) {
    ['scrub-mode-toggle', 'btn-reset', 'btn-add-track'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = on;
    });
    if (trimAdjustBtnEl) trimAdjustBtnEl.disabled = on;
  }

  function enterTrimMode() {
    if (!fullBuffer) return;
    waveStopPlay();
    stopScrub();
    stopPlayback();
    trimModeOn = true;

    document.getElementById('upload-panel').style.display = 'none';
    document.getElementById('wave-panel').style.display = '';
    document.getElementById('grain-controls-row').style.display = 'none';
    document.getElementById('tracker-wrap').style.display = 'none';
    document.getElementById('tracker-hint').style.display = 'none';

    setTrimUIInert(true);

    const playBtn = document.getElementById('wave-play-btn');
    playBtn.textContent = '✓';
    playBtn.title = 'Confirm this 2-minute selection';

    const hint = document.getElementById('wave-hint');
    hint.style.display = '';
    hint.textContent = `Drag the waveform to choose which ${fmtTime(MAX_REC_SECS)} to use for Track ${trimTargetSlot + 1}, then click ✓ to confirm`;

    setStatus(`CHOOSE 2:00 SPAN — TRACK ${trimTargetSlot + 1}`);
    setTimeout(resizeTrimCanvas, 50);
  }

  function resizeTrimCanvas() {
    const canvas = document.getElementById('branular-wave-canvas');
    if (!canvas || !fullBuffer) return;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight || 100;
    if (!W) return;
    canvas.width = W;
    canvas.height = H;
    trimPeaks = computePeaks(fullBuffer, W);
    renderTrimWave();
  }

  function renderTrimWave() {
    const canvas = document.getElementById('branular-wave-canvas');
    if (!canvas || !fullBuffer) return;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const ctx = canvas.getContext('2d');
    const mid = H / 2;

    ctx.fillStyle = '#f5f4ef';
    ctx.fillRect(0, 0, W, H);

    const bandStartNorm = trimOffsetSec / fullBuffer.duration;
    const bandWidthNorm = Math.min(1, MAX_REC_SECS / fullBuffer.duration);
    const bx = bandStartNorm * W, bw = Math.max(1, bandWidthNorm * W);
    ctx.fillStyle = hexToRgba('#4de8ff', 0.32);
    ctx.fillRect(bx, 0, bw, H);
    ctx.strokeStyle = '#1aa8c4';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + 1, 1, Math.max(1, bw - 2), H - 2);

    if (trimPeaks) {
      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      for (let x = 0; x < W && x < trimPeaks.length; x++) {
        const { min, max } = trimPeaks[x];
        const yT = mid - max * mid * 0.9;
        const yB = mid - min * mid * 0.9;
        ctx.fillRect(x, yT, 1, Math.max(1, yB - yT));
      }
    }
  }

  function startTrimDrag(e) {
    trimDragActive = true;
    trimDragStartX = e.clientX;
    trimDragStartOffsetSec = trimOffsetSec;
  }

  function updateTrimDrag(e) {
    const canvas = document.getElementById('branular-wave-canvas');
    if (!canvas || !fullBuffer) return;
    const W = canvas.getBoundingClientRect().width;
    const deltaSec = ((e.clientX - trimDragStartX) / W) * fullBuffer.duration;
    const maxOffset = Math.max(0, fullBuffer.duration - MAX_REC_SECS);
    trimOffsetSec = Math.max(0, Math.min(maxOffset, trimDragStartOffsetSec + deltaSec));
    renderTrimWave();
  }

  function confirmTrimSelection() {
    if (!fullBuffer) return;
    const ctx = getAudioCtx();
    const sampleRate = fullBuffer.sampleRate;
    const startSample = Math.floor(trimOffsetSec * sampleRate);
    const lenSamples = Math.min(fullBuffer.length - startSample, Math.floor(MAX_REC_SECS * sampleRate));
    const trimmed = ctx.createBuffer(1, lenSamples, sampleRate);
    trimmed.getChannelData(0).set(fullBuffer.getChannelData(0).subarray(startSample, startSample + lenSamples));

    trimModeOn = false;
    setTrimUIInert(false);

    const playBtn = document.getElementById('wave-play-btn');
    playBtn.textContent = '▶';
    playBtn.title = 'Play / Pause (Space)';
    document.getElementById('wave-hint').style.display = 'none';

    commitBufferToSlot(trimTargetSlot, trimmed, fullBufferName, fullBuffer, trimOffsetSec);
    fullBuffer = null;
    fullBufferName = '';
  }

  // ── RECORDING ──────────────────────────────────────────────────────────────
  function startRecording() {
    if (isRecording) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const ctx = getAudioCtx();
      const chunks = [];
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        if (isRecording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(ctx.destination);
      isRecording = true;
      recState = { src, proc, stream, sampleRate: ctx.sampleRate, chunks };
      recSeconds = 0;
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
    try { src.disconnect(); } catch (_) {}
    try { proc.disconnect(); } catch (_) {}
    stream.getTracks().forEach(t => t.stop());

    if (discard || !chunks.length) return;
    showProcessing('Building audio…');
    setTimeout(() => {
      const buf = buildPcmBuffer(chunks, sampleRate, MAX_REC_SECS);
      hideProcessing();
      // Live recording only happens before any track is loaded (the record
      // button lives on the upload panel, which is hidden once a track
      // exists) — it's always the first/primary track, slot 0.
      commitBufferToSlot(0, buf, 'recording');
    }, 0);
  }

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

  function showProcessing(msg) {
    const ind = document.getElementById('processing-indicator');
    const m = document.getElementById('processing-msg');
    if (ind) ind.style.display = '';
    if (m && msg) m.textContent = msg;
    setStatus((msg || 'PROCESSING').toUpperCase());
  }
  function hideProcessing() {
    const ind = document.getElementById('processing-indicator');
    if (ind) ind.style.display = 'none';
  }

  // ── MULTI-TRACK SLOTS ──────────────────────────────────────────────────────
  // Commits a decoded (and possibly already-trimmed) buffer into a track
  // slot. The very first track loaded in a session resets the tracker grid
  // (fresh start); a second or third track is added alongside whatever rows
  // already exist, so grains gathered from earlier tracks aren't lost.
  function commitBufferToSlot(slotIdx, buf, name, sourceFullBuffer, trimOffset) {
    const isFirstTrack = !audioSlots.some(Boolean);

    audioSlots[slotIdx] = {
      buffer: buf,
      fullBuffer: sourceFullBuffer || null,
      trimOffset: trimOffset || 0,
      name,
      onsets: detectOnsets(buf),
    };

    activeSlotIdx = slotIdx;
    masterBuffer = buf;
    detectedOnsets = audioSlots[slotIdx].onsets;

    waveStopPlay();
    cancelAnimationFrame(rafHandle);
    wavePlayback.offsetSec = 0;
    playheadNorm = 0;

    document.getElementById('upload-panel').style.display = 'none';
    document.getElementById('wave-panel').style.display = '';
    document.getElementById('grain-controls-row').style.display = '';
    document.getElementById('tracker-wrap').style.display = '';
    document.getElementById('tracker-hint').style.display = '';

    if (isFirstTrack) resetTracker();

    setTimeout(() => {
      resizeWaveCanvas();
      updateRuler(masterBuffer.duration);
    }, 50);

    document.getElementById('session-name').textContent = name || 'session';
    document.getElementById('wave-play-btn').textContent = '▶';
    document.getElementById('wave-time-cur').textContent = '0:00';
    setStatus('LOADED');

    updateSlotButtons();
    updateAddTrackVisibility();
    updateTrimAdjustButtonVisibility();
  }

  // Switches which track's waveform/onsets are on screen — does not touch
  // the tracker grid or sequencer playback, which read each step's own slot.
  function switchToSlot(idx) {
    if (idx === activeSlotIdx || !audioSlots[idx]) return;
    waveStopPlay();
    stopScrub();

    activeSlotIdx = idx;
    masterBuffer = audioSlots[idx].buffer;
    detectedOnsets = audioSlots[idx].onsets;
    document.getElementById('session-name').textContent = audioSlots[idx].name;
    document.getElementById('wave-time-cur').textContent = '0:00';

    setTimeout(() => {
      resizeWaveCanvas();
      updateRuler(masterBuffer.duration);
    }, 50);

    updateSlotButtons();
    updateTrimAdjustButtonVisibility();
  }

  // [1]/[2]/[3] only ever appear once a second track exists — with a single
  // track there's nothing to switch between, so no buttons render at all.
  function updateSlotButtons() {
    const wrap = document.getElementById('slot-buttons-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const filledCount = audioSlots.filter(Boolean).length;
    if (filledCount <= 1) return;

    audioSlots.forEach((slot, idx) => {
      if (!slot) return;
      const btn = document.createElement('button');
      btn.className = 'shell-slot-btn' + (idx === activeSlotIdx ? ' active' : '');
      btn.textContent = String(idx + 1);
      btn.title = slot.name;
      btn.addEventListener('click', () => switchToSlot(idx));
      wrap.appendChild(btn);
    });
  }

  function updateAddTrackVisibility() {
    const btn = document.getElementById('btn-add-track');
    if (!btn) return;
    const filledCount = audioSlots.filter(Boolean).length;
    btn.style.display = (filledCount >= 1 && filledCount < MAX_TRACKS) ? '' : 'none';
  }

  // ── RESET SESSION ──────────────────────────────────────────────────────────
  function resetSession() {
    waveStopPlay();
    stopRecording(true);
    cancelAnimationFrame(rafHandle);
    stopPlayback();
    stopScrub();

    masterBuffer = null;
    waveformPeaks = null;
    playheadNorm = 0;
    detectedOnsets = [];

    audioSlots[0] = audioSlots[1] = audioSlots[2] = null;
    activeSlotIdx = 0;
    pendingSlotIdx = -1;

    trimModeOn = false;
    trimDragActive = false;
    fullBuffer = null;
    fullBufferName = '';
    trimOffsetSec = 0;
    trimTargetSlot = 0;
    trimPeaks = null;
    setTrimUIInert(false);
    removeTrimAdjustButton();

    resetTracker();

    document.getElementById('upload-panel').style.display = '';
    document.getElementById('wave-panel').style.display = 'none';
    document.getElementById('grain-controls-row').style.display = 'none';
    document.getElementById('tracker-wrap').style.display = 'none';
    document.getElementById('tracker-hint').style.display = 'none';
    document.getElementById('wave-play-btn').textContent = '▶';
    document.getElementById('wave-play-btn').title = 'Play / Pause (Space)';
    document.getElementById('wave-hint').style.display = 'none';

    document.getElementById('session-name').textContent = 'no session loaded';
    setStatus('READY');

    updateSlotButtons();
    updateAddTrackVisibility();
  }

  // ── EFFECTS MENU ───────────────────────────────────────────────────────────
  function fxNormFor(param) {
    const r = FX_RANGES[param];
    return (fx[param] - r.min) / (r.max - r.min);
  }

  function updateFxKnob(param) {
    const norm = Math.max(0, Math.min(1, fxNormFor(param)));
    const angle = -135 + norm * 270;
    const knob = document.querySelector(`.fx-knob[data-param="${param}"]`);
    if (!knob) return;
    const indicator = knob.querySelector('.fx-knob-indicator');
    if (indicator) indicator.style.transform = `translateX(-50%) rotate(${angle}deg)`;
    const valEl = document.getElementById(`fx-val-${param}`);
    if (valEl) valEl.textContent = FX_RANGES[param].fmt(fx[param]);
  }

  function updateAllFxKnobs() {
    FX_PARAMS.forEach(updateFxKnob);
  }

  function setFxFocus(idx) {
    fxFocusIdx = ((idx % FX_PARAMS.length) + FX_PARAMS.length) % FX_PARAMS.length;
    document.querySelectorAll('.fx-knob').forEach((el) => {
      el.classList.toggle('focused', el.dataset.param === FX_PARAMS[fxFocusIdx]);
    });
  }

  function adjustFxParam(param, dir) {
    const r = FX_RANGES[param];
    let v = fx[param] + dir * r.step;
    v = Math.max(r.min, Math.min(r.max, v));
    fx[param] = v;
    if (param === 'reverbMix') setReverbMix(v);
    else if (param === 'reverbDecay') setReverbDecay(v);
    else if (param === 'delayTime') setDelayTime(v);
    else if (param === 'delayFeedback') setDelayFeedback(v);
    updateFxKnob(param);
  }

  function openFxMenu() {
    getAudioCtx();
    fxMenuOpen = true;
    document.getElementById('fx-overlay').style.display = '';
    setFxFocus(fxFocusIdx);
    updateAllFxKnobs();
  }
  function closeFxMenu() {
    fxMenuOpen = false;
    document.getElementById('fx-overlay').style.display = 'none';
  }
  function toggleFxMenu() {
    fxMenuOpen ? closeFxMenu() : openFxMenu();
  }

  // ── INIT ───────────────────────────────────────────────────────────────────
  function init() {
    if (initDone) return;
    initDone = true;

    const fileInput = document.getElementById('file-input');
    document.getElementById('btn-upload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) loadFile(e.target.files[0]);
      e.target.value = '';
    });

    document.getElementById('btn-add-track').addEventListener('click', () => {
      const nextEmpty = audioSlots.findIndex((s) => !s);
      if (nextEmpty === -1) return;
      pendingSlotIdx = nextEmpty;
      fileInput.click();
    });

    const panel = document.getElementById('upload-panel');
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('dragging'); });
    panel.addEventListener('dragleave', () => panel.classList.remove('dragging'));
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('dragging');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('audio/')) loadFile(file);
    });

    document.getElementById('btn-record').addEventListener('click', () => {
      isRecording ? stopRecording(false) : startRecording();
    });

    document.getElementById('btn-reset').addEventListener('click', resetSession);
    document.getElementById('wave-play-btn').addEventListener('click', () => {
      if (trimModeOn) { confirmTrimSelection(); return; }
      waveTogglePlay();
    });

    document.getElementById('btn-select-grains').addEventListener('click', selectGrains);
    document.getElementById('btn-play-tracker').addEventListener('click', togglePlayback);
    document.getElementById('btn-record-tracker').addEventListener('click', toggleRecordArm);
    document.getElementById('btn-layer-grains').addEventListener('click', addRow);
    document.getElementById('btn-reset-grains').addEventListener('click', resetTracker);
    document.getElementById('btn-delete-rows').addEventListener('click', toggleDeleteMode);
    document.getElementById('btn-group-rows').addEventListener('click', toggleGroupMode);

    const bpmSlider = document.getElementById('bpm-slider');
    bpmSlider.addEventListener('input', (e) => {
      bpm = parseInt(e.target.value, 10);
      document.getElementById('bpm-value').textContent = bpm;
    });

    document.getElementById('scrub-mode-toggle').addEventListener('change', (e) => {
      setScrubMode(e.target.checked);
    });

    document.getElementById('ctx-copy').addEventListener('click', copyTargetStep);
    document.getElementById('ctx-paste').addEventListener('click', pasteIntoTargetStep);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#step-context-menu')) closeStepContextMenu();
    });
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.tracker-cell')) closeStepContextMenu();
    });

    initWaveInteraction();

    document.querySelectorAll('.fx-knob').forEach((el) => {
      el.addEventListener('click', () => setFxFocus(FX_PARAMS.indexOf(el.dataset.param)));
    });

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (trimModeOn) return; // only dragging + the ✓ button are active while choosing the span

      if (e.key === 'Escape' && ctxMenuTarget) {
        closeStepContextMenu();
        return;
      }

      if (deleteModeOn) {
        if (e.key === 'Escape') exitDeleteMode(false);
        return; // every other shortcut is inert while selecting rows to delete
      }

      if (groupModeOn) {
        if (e.key === 'Escape') exitGroupMode(false);
        return; // every other shortcut is inert while selecting rows to group
      }

      if (!e.repeat && e.key === ' ') {
        e.preventDefault();
        waveTogglePlay();
        return;
      }

      if (!e.repeat && e.key === '1') {
        e.preventDefault();
        toggleFxMenu();
        return;
      }

      if (fxMenuOpen) {
        if (e.key === 'Tab') {
          e.preventDefault();
          setFxFocus(fxFocusIdx + (e.shiftKey ? -1 : 1));
          return;
        }
        if (e.key === 'ArrowUp') { e.preventDefault(); adjustFxParam(FX_PARAMS[fxFocusIdx], 1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); adjustFxParam(FX_PARAMS[fxFocusIdx], -1); return; }
        return;
      }
    });

    window.addEventListener('mouseup', () => {
      if (trimDragActive) trimDragActive = false;
      if (scrubModeOn) stopScrub();

      if (selectDragActive) {
        selectDragActive = false;
        if (selectedCells.size <= 1) {
          const only = selectedCells.size === 1 ? cellAtFlatIndex([...selectedCells][0]) : null;
          clearSelection();
          if (only) previewStep(only.rowIdx, only.stepIdx);
        }
        // else: leave the multi-selection highlighted, ready for Copy Steps
      }
    });

    window.addEventListener('resize', () => {
      if (trimModeOn) resizeTrimCanvas(); else resizeWaveCanvas();
    });

    updateAllFxKnobs();
    setFxFocus(0);
  }

  window.Branular = { init };
})();
