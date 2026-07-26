// bixer-stuff.js — Bixer audio mixer logic
// Ported from a standalone Next.js/React mixer (audio-chain engine + UI) into
// a single vanilla-JS module matching the rest of Beatbox Kit's per-tool
// convention (IIFE, DOM refs grabbed once in init(), no framework/build step).
//
// Pipeline: decode (Web Audio for audio files, a hidden <video>/<audio> tap
// for video files and recordings — see extractAudioFromMedia, ported from
// Bid2baud's extractAudio()) -> live mix-graph preview (Web Audio nodes,
// rebuilt on structural changes) -> export (OfflineAudioContext render to
// WAV, then handed to bixer-ffmpeg.js only if the output needs to be
// something other than WAV — see renderAndExport).
(function () {
  const MAX_SECS = 120; // 2 minutes, matching the rest of the kit
  const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];
  const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];

  // ── MIX ENGINE (ported near-verbatim from audio-chain/types.ts + nodes.ts + graph.ts) ──
  const MODULE_LABELS = { gain: 'gain', eq: 'eq', compressor: 'compressor', saturation: 'saturation', limiter: 'limiter' };

  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());
  }

  const MODULE_DEFAULTS = {
    gain: () => ({ gainDb: 0 }),
    eq: () => ({
      bands: [
        { id: uid(), type: 'highpass', freq: 80, gainDb: 0, q: 0.7 },
        { id: uid(), type: 'peaking', freq: 1000, gainDb: 0, q: 1 },
        { id: uid(), type: 'highshelf', freq: 8000, gainDb: 0, q: 0.7 },
      ],
    }),
    compressor: () => ({ thresholdDb: -24, ratio: 3, attackMs: 10, releaseMs: 150, kneeDb: 6, makeupDb: 0 }),
    saturation: () => ({ drive: 0.2, mix: 0.5 }),
    limiter: () => ({ thresholdDb: -3, releaseMs: 80, ceilingDb: -0.3 }),
  };

  function createModule(type) {
    return { id: uid(), type, label: MODULE_LABELS[type], bypassed: false, params: MODULE_DEFAULTS[type]() };
  }

  function dbToGain(db) { return Math.pow(10, db / 20); }

  function buildGain(ctx, params) {
    const node = ctx.createGain();
    node.gain.value = dbToGain(params.gainDb);
    return { input: node, output: node, update: p => { node.gain.value = dbToGain(p.gainDb); } };
  }

  function buildEQ(ctx, params) {
    const filters = params.bands.map(band => {
      const f = ctx.createBiquadFilter();
      f.type = band.type; f.frequency.value = band.freq; f.gain.value = band.gainDb; f.Q.value = band.q;
      return f;
    });
    for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
    return {
      input: filters[0],
      output: filters[filters.length - 1],
      update: p => {
        p.bands.forEach((band, i) => {
          const f = filters[i];
          if (!f) return;
          f.type = band.type; f.frequency.value = band.freq; f.gain.value = band.gainDb; f.Q.value = band.q;
        });
      },
    };
  }

  function applyCompressorParams(comp, params) {
    comp.threshold.value = params.thresholdDb;
    comp.ratio.value = params.ratio;
    comp.attack.value = params.attackMs / 1000;
    comp.release.value = params.releaseMs / 1000;
    comp.knee.value = params.kneeDb;
  }

  function buildCompressor(ctx, params) {
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    applyCompressorParams(comp, params);
    makeup.gain.value = dbToGain(params.makeupDb);
    comp.connect(makeup);
    return {
      input: comp, output: makeup,
      update: p => { applyCompressorParams(comp, p); makeup.gain.value = dbToGain(p.makeupDb); },
    };
  }

  function makeSaturationCurve(drive) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const amount = 1 + drive * 40;
    for (let i = 0; i < samples; i++) {
      const x = (i / (samples - 1)) * 2 - 1;
      curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  function buildSaturation(ctx, params) {
    const shaper = ctx.createWaveShaper();
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();
    const input = ctx.createGain();
    const output = ctx.createGain();
    shaper.curve = makeSaturationCurve(params.drive);
    shaper.oversample = '4x';
    input.connect(dryGain);
    input.connect(shaper);
    shaper.connect(wetGain);
    dryGain.connect(output);
    wetGain.connect(output);
    dryGain.gain.value = 1 - params.mix;
    wetGain.gain.value = params.mix;
    return {
      input, output,
      update: p => {
        shaper.curve = makeSaturationCurve(p.drive);
        dryGain.gain.value = 1 - p.mix;
        wetGain.gain.value = p.mix;
      },
    };
  }

  function applyLimiterParams(comp, params) {
    comp.threshold.value = params.thresholdDb;
    comp.ratio.value = 20;
    comp.attack.value = 0.001;
    comp.release.value = params.releaseMs / 1000;
    comp.knee.value = 0;
  }

  function buildLimiter(ctx, params) {
    const comp = ctx.createDynamicsCompressor();
    const ceiling = ctx.createGain();
    applyLimiterParams(comp, params);
    ceiling.gain.value = dbToGain(params.ceilingDb);
    comp.connect(ceiling);
    return {
      input: comp, output: ceiling,
      update: p => { applyLimiterParams(comp, p); ceiling.gain.value = dbToGain(p.ceilingDb); },
    };
  }

  function buildModuleNodes(ctx, mod) {
    switch (mod.type) {
      case 'gain': return buildGain(ctx, mod.params);
      case 'eq': return buildEQ(ctx, mod.params);
      case 'compressor': return buildCompressor(ctx, mod.params);
      case 'saturation': return buildSaturation(ctx, mod.params);
      case 'limiter': return buildLimiter(ctx, mod.params);
    }
  }

  // Connects source -> active (non-bypassed) modules in order -> destination.
  // Rebuild on any structural change (add/remove/reorder/bypass); param-only
  // tweaks go through updateModule instead of rebuilding.
  function buildMixGraph(ctx, modules, source, destination) {
    const active = modules.filter(m => !m.bypassed);
    const built = active.map(mod => ({ id: mod.id, node: buildModuleNodes(ctx, mod) }));
    let prev = source;
    for (const { node } of built) { prev.connect(node.input); prev = node.output; }
    prev.connect(destination);
    const byId = new Map(built.map(b => [b.id, b.node]));
    return {
      updateModule: (id, params) => { byId.get(id)?.update(params); },
      disconnect: () => { source.disconnect(); for (const { node } of built) node.output.disconnect(); },
    };
  }

  // ── WAV ENCODE (ported near-verbatim from wav-encode.ts; self-contained
  // per the kit's existing convention of each tool having its own encoder) ──
  function audioBufferToWavBlob(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const numFrames = buffer.length;
    const dataSize = numFrames * blockAlign;

    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(buffer.getChannelData(ch));

    let offset = 44;
    for (let frame = 0; frame < numFrames; frame++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channelData[ch][frame]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  // ── DOM REFS + STATE ──
  let fileInput, uploadPanel, btnUpload, btnRecord, recLabel,
      recTimer, recTimeDisplay,
      processingIndicator, processingMsg, errorMsg, sessionName, shellStatus,
      wavePanel, waveFilenameEl, waveFilesizeEl, waveCanvas, waveCtx,
      btnReset, playerPlayBtn, playerScrubTrack, playerScrubFill,
      playerScrubHandle, playerCurrentTimeEl, playerTotalTimeEl,
      rackPanel, rackList, rackEmpty, resultPanel, resultFormatBadge,
      btnRender, btnDownloadLink, renderError;

  function $(id) { return document.getElementById(id); }

  // Source state
  let audioCtx = null;
  let sourceKind = null;       // 'audio' | 'video'
  let sourceExt = null;        // lowercase extension without dot
  let sourceBlob = null;       // original File/Blob — kept for video remux at export
  let sourceBaseName = 'mix';  // filename without extension
  let audioBuffer = null;      // decoded AudioBuffer used for preview + render
  let modules = [];

  // Playback state
  let sourceNode = null;
  let mixGraph = null;
  let isPlaying = false;
  let currentTime = 0;
  let playStartCtxTime = 0;
  let playStartOffset = 0;
  let rafId = null;
  let playGeneration = 0;

  // Recording state
  let recActive = false;
  let recTimerInterval = null;
  let recSeconds = 0;
  let micRecState = null;      // { src, proc, stream, sampleRate, chunks }
  let activeRecordCancel = null;

  let downloadObjectUrl = null;
  let initDone = false;

  // Mix-chain preview state: a background OfflineAudioContext render of the
  // current chain, redrawn as a second waveform trace so tweaking a module
  // shows what actually changed rather than just hearing it. Debounced and
  // token-guarded so rapid slider drags don't pile up overlapping renders.
  let processedBuffer = null;
  let previewRenderToken = 0;
  let previewDebounceTimer = null;

  function scheduleProcessedPreview() {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(renderProcessedPreview, 150);
  }

  async function renderProcessedPreview() {
    if (!audioBuffer) { processedBuffer = null; return; }
    const token = ++previewRenderToken;
    try {
      const offlineCtx = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      buildMixGraph(offlineCtx, modules, source, offlineCtx.destination);
      source.start(0);
      const rendered = await offlineCtx.startRendering();
      if (token !== previewRenderToken) return; // superseded by a newer edit
      processedBuffer = rendered;
    } catch (err) {
      console.error('Mix preview render failed', err);
    }
  }

  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + String(sec).padStart(2, '0');
  }
  function fmtSize(bytes) {
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  }
  function extOf(filename) {
    const m = /\.([^.]+)$/.exec(filename || '');
    return m ? m[1].toLowerCase() : '';
  }
  function baseNameOf(filename) {
    return (filename || 'mix').replace(/\.[^.]+$/, '');
  }

  function showError(msg) { errorMsg.textContent = msg; errorMsg.style.display = ''; }
  function clearError() { errorMsg.style.display = 'none'; }
  function setShellStatus(text) { if (shellStatus) shellStatus.textContent = text; }
  function showProcessing(msg) {
    processingIndicator.style.display = '';
    if (msg) processingMsg.textContent = msg;
  }
  function hideProcessing() { processingIndicator.style.display = 'none'; }

  // ── INIT ──
  function init() {
    // bixer-init.js can trigger this twice (DOMContentLoaded + an
    // immediate fallback for when the script runs after that event has
    // already fired) — without this guard every listener below gets
    // registered twice, so a single click fires its handler twice too.
    if (initDone) return;
    initDone = true;

    fileInput = $('file-input');
    uploadPanel = $('upload-panel');
    btnUpload = $('btn-upload');
    btnRecord = $('btn-record');
    recLabel = $('rec-label');
    recTimer = $('rec-timer');
    recTimeDisplay = $('rec-time-display');
    processingIndicator = $('processing-indicator');
    processingMsg = $('processing-msg');
    errorMsg = $('error-msg');
    sessionName = $('session-name');
    shellStatus = $('shell-status');
    wavePanel = $('wave-panel');
    waveFilenameEl = $('wave-filename');
    waveFilesizeEl = $('wave-filesize');
    waveCanvas = $('wave-canvas');
    waveCtx = waveCanvas.getContext('2d');
    btnReset = $('btn-reset');
    playerPlayBtn = $('player-play-btn');
    playerScrubTrack = $('player-scrub-track');
    playerScrubFill = $('player-scrub-fill');
    playerScrubHandle = $('player-scrub-handle');
    playerCurrentTimeEl = $('player-current-time');
    playerTotalTimeEl = $('player-total-time');
    rackPanel = $('rack-panel');
    rackList = $('rack-list');
    rackEmpty = $('rack-empty');
    resultPanel = $('result-panel');
    resultFormatBadge = $('result-format-badge');
    btnRender = $('btn-render');
    btnDownloadLink = $('btn-download-link');
    renderError = $('render-error');

    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

    uploadPanel.addEventListener('dragover', e => { e.preventDefault(); uploadPanel.classList.add('dragging'); });
    uploadPanel.addEventListener('dragleave', () => uploadPanel.classList.remove('dragging'));
    uploadPanel.addEventListener('drop', e => {
      e.preventDefault();
      uploadPanel.classList.remove('dragging');
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    btnRecord.addEventListener('click', () => {
      recActive ? stopRecording(false) : startRecording();
    });

    btnReset.addEventListener('click', resetAll);

    playerPlayBtn.addEventListener('click', togglePlay);
    initScrub();

    btnRender.addEventListener('click', renderAndExport);

    requestAnimationFrame(waveDrawLoop);
  }

  // ── FILE LOAD ──
  function handleFile(file) {
    clearError();
    const ext = extOf(file.name);
    const kind = AUDIO_EXTS.includes(ext) ? 'audio' : VIDEO_EXTS.includes(ext) ? 'video' : null;
    if (!kind) {
      showError('Unsupported file type: .' + ext);
      return;
    }
    resetPlaybackOnly();
    setShellStatus('LOADING');
    showProcessing('Loading ' + file.name + '… 0%');

    const onProgress = pct => showProcessing((kind === 'audio' ? 'Loading ' : 'Extracting audio ') + file.name + '… ' + pct + '%');
    const load = kind === 'audio' ? decodeAudioFile(file, onProgress) : extractAudioViaFfmpeg(file, ext, onProgress);
    load.then(buf => {
      hideProcessing();
      commitSource(buf, file, ext, kind, baseNameOf(file.name));
      setShellStatus('LOADED');
    }).catch(err => {
      hideProcessing();
      console.error(err);
      showError(err.message || 'Could not load this file.');
      setShellStatus('ERROR');
    });
  }

  function readFileWithProgress(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = e => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
      reader.readAsArrayBuffer(file);
    });
  }

  function decodeAudioFile(file, onProgress) {
    return readFileWithProgress(file, onProgress)
      .then(buf => {
        if (onProgress) onProgress(100);
        showProcessing('Decoding ' + file.name + '…');
        return getAudioCtx().decodeAudioData(buf.slice(0));
      })
      .then(buf => capAtMax(buf))
      // Some audio containers (ogg/flac in particular) aren't decodable via
      // decodeAudioData in every browser — fall back to ffmpeg.wasm, which
      // handles a much broader set of containers/codecs.
      .catch(() => extractAudioViaFfmpeg(file, extOf(file.name), onProgress));
  }

  function capAtMax(buf) {
    if (buf.duration <= MAX_SECS) return buf;
    const ctx = getAudioCtx();
    const maxSamples = Math.floor(MAX_SECS * buf.sampleRate);
    const trimmed = ctx.createBuffer(buf.numberOfChannels, maxSamples, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      trimmed.getChannelData(ch).set(buf.getChannelData(ch).subarray(0, maxSamples));
    }
    return trimmed;
  }

  // Demuxes audio out of a video/recording blob via ffmpeg.wasm instead of
  // playing it back in real time — a 90-second video no longer takes ~90
  // seconds to extract, since ffmpeg processes the file directly rather
  // than being bound to playback speed. Falls back to the real-time
  // media-element tap (extractAudioFromMedia, below) if ffmpeg.wasm fails
  // to load (e.g. blocked by network conditions).
  function extractAudioViaFfmpeg(blob, ext, onProgress) {
    return window.BixerFFmpeg.extractAudioToWav(blob, ext, onProgress)
      .then(wavBlob => wavBlob.arrayBuffer())
      .then(buf => getAudioCtx().decodeAudioData(buf))
      .then(buf => capAtMax(buf))
      .catch(err => {
        console.error('ffmpeg extraction failed, falling back to real-time capture', err);
        return extractAudioFromMedia(blob, onProgress);
      });
  }

  // Extracts raw PCM out of a video/audio Blob by actually playing it through
  // a hidden media element and tapping the output with an AudioWorklet — the
  // same technique Bid2baud uses (createMediaElementSource + a silent tap),
  // which works for any container/codec the browser can natively play back,
  // not just what decodeAudioData supports.
  function extractAudioFromMedia(blob, onProgress) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const mediaEl = document.createElement(blob.type.startsWith('audio') ? 'audio' : 'video');
      mediaEl.src = url;
      mediaEl.playsInline = true;
      mediaEl.preload = 'auto';

      let settled = false;
      let cleanup = null;
      function fail(msg) {
        if (settled) return;
        settled = true;
        if (cleanup) cleanup();
        URL.revokeObjectURL(url);
        reject(new Error(msg));
      }
      activeRecordCancel = () => fail('Cancelled.');

      mediaEl.addEventListener('error', () => fail('Could not read this file. The codec may be unsupported.'));
      mediaEl.addEventListener('loadedmetadata', () => {
        resolveDuration(mediaEl, duration => {
          if (settled) return;
          if (!isFinite(duration) || duration <= 0) { fail('Could not determine duration.'); return; }
          const capped = Math.min(duration, MAX_SECS);
          startCapture(mediaEl, capped).catch(err => fail(err.message));
        });
      });

      async function startCapture(mediaEl, duration) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        await ctx.audioWorklet.addModule('../js/bid2baud/bid2baud-capture-worklet.js');
        if (settled) { ctx.close(); return; }

        const source = ctx.createMediaElementSource(mediaEl);
        const captureNode = new AudioWorkletNode(ctx, 'bid2baud-capture');
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;

        cleanup = () => {
          try { mediaEl.pause(); } catch (_) {}
          try { captureNode.disconnect(); } catch (_) {}
          try { source.disconnect(); } catch (_) {}
          try { ctx.close(); } catch (_) {}
        };

        const chunksL = [], chunksR = [];
        let numChannels = 1;
        let totalSamples = 0;

        captureNode.port.onmessage = e => {
          const { left, right } = e.data;
          numChannels = right ? 2 : 1;
          chunksL.push(left);
          if (right) chunksR.push(right);
          totalSamples += left.length;
        };

        source.connect(captureNode);
        captureNode.connect(silentGain);
        silentGain.connect(ctx.destination);

        const stopAt = duration;
        function finish() {
          if (settled) return;
          settled = true;
          captureNode.port.postMessage('flush');
          setTimeout(() => {
            captureNode.disconnect();
            source.disconnect();
            ctx.close();
            URL.revokeObjectURL(url);

            const left = mergeChunks(chunksL, totalSamples);
            const right = numChannels > 1 ? mergeChunks(chunksR, totalSamples) : left;
            const out = ctx.sampleRate ? buildBufferFromChannels(left, right, numChannels, ctx.sampleRate) : null;
            resolve(out);
          }, 50);
        }

        mediaEl.addEventListener('ended', finish);
        mediaEl.addEventListener('timeupdate', () => {
          if (onProgress) onProgress(Math.min(100, Math.round((mediaEl.currentTime / stopAt) * 100)));
          if (mediaEl.currentTime >= stopAt) finish();
        });
        // Do NOT mute the element — once routed through
        // createMediaElementSource, muting also zeroes the signal reaching
        // this graph in most browsers. silentGain above keeps it inaudible.
        await mediaEl.play();
      }
    });
  }

  function resolveDuration(mediaEl, cb) {
    if (isFinite(mediaEl.duration) && mediaEl.duration > 0) { cb(mediaEl.duration); return; }
    const onChange = () => {
      mediaEl.removeEventListener('durationchange', onChange);
      mediaEl.currentTime = 0;
      cb(mediaEl.duration);
    };
    mediaEl.addEventListener('durationchange', onChange);
    mediaEl.currentTime = 1e9;
  }

  function mergeChunks(chunks, totalSamples) {
    const out = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  function buildBufferFromChannels(left, right, numChannels, sampleRate) {
    const ctx = getAudioCtx();
    const buf = ctx.createBuffer(numChannels, left.length, sampleRate);
    buf.getChannelData(0).set(left);
    if (numChannels > 1) buf.getChannelData(1).set(right);
    return buf;
  }

  // ── COMMIT SOURCE ──
  function commitSource(buf, blob, ext, kind, baseName) {
    audioBuffer = buf;
    sourceBlob = blob;
    sourceExt = ext;
    sourceKind = kind;
    sourceBaseName = baseName;
    modules = [createModule('eq'), createModule('compressor'), createModule('limiter')];

    sessionName.textContent = baseName + '.' + ext;
    waveFilenameEl.textContent = baseName + '.' + ext;
    waveFilesizeEl.textContent = fmtSize(blob.size || 0);
    wavePanel.style.display = '';
    rackPanel.style.display = '';
    resultPanel.style.display = '';
    resultFormatBadge.textContent = ext.toUpperCase();
    downloadReset();

    currentTime = 0;
    updatePlayerProgress();
    playerTotalTimeEl.textContent = fmtTime(audioBuffer.duration);
    renderRack();
    processedBuffer = null;
    scheduleProcessedPreview();
  }

  function resetPlaybackOnly() {
    stopSource();
    currentTime = 0;
    isPlaying = false;
  }

  function resetAll() {
    stopSource();
    if (recActive) stopRecording(true);
    audioBuffer = null;
    sourceBlob = null;
    sourceExt = null;
    sourceKind = null;
    modules = [];
    currentTime = 0;
    isPlaying = false;
    processedBuffer = null;
    clearTimeout(previewDebounceTimer);
    previewRenderToken++;

    fileInput.value = '';
    wavePanel.style.display = 'none';
    rackPanel.style.display = 'none';
    resultPanel.style.display = 'none';
    clearError();
    sessionName.textContent = 'no file loaded';
    setShellStatus('READY');
    downloadReset();
  }

  function downloadReset() {
    if (downloadObjectUrl) { URL.revokeObjectURL(downloadObjectUrl); downloadObjectUrl = null; }
    btnDownloadLink.style.display = 'none';
    btnRender.style.display = '';
    renderError.style.display = 'none';
  }

  // ── PLAYBACK ──
  function stopSource() {
    if (sourceNode) {
      sourceNode.onended = null;
      try { sourceNode.stop(); } catch (_) {}
      sourceNode = null;
    }
    if (mixGraph) { mixGraph.disconnect(); mixGraph = null; }
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function playFrom(offset) {
    if (!audioBuffer) return;
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    stopSource();

    const generation = ++playGeneration;
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    const graph = buildMixGraph(ctx, modules, source, ctx.destination);
    source.onended = () => {
      if (playGeneration !== generation) return;
      isPlaying = false;
      currentTime = 0;
      updatePlayIcon();
      updatePlayerProgress();
    };
    source.start(0, offset);

    sourceNode = source;
    mixGraph = graph;
    playStartCtxTime = ctx.currentTime;
    playStartOffset = offset;

    const tick = () => {
      if (!isPlaying) return;
      const c = audioCtx;
      if (!c) return;
      const elapsed = playStartOffset + (c.currentTime - playStartCtxTime);
      currentTime = Math.min(elapsed, audioBuffer.duration);
      updatePlayerProgress();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (!audioBuffer) return;
    if (isPlaying) {
      stopSource();
      isPlaying = false;
    } else {
      isPlaying = true;
      playFrom(currentTime);
    }
    updatePlayIcon();
  }

  function seek(time) {
    currentTime = Math.max(0, Math.min(time, audioBuffer ? audioBuffer.duration : 0));
    updatePlayerProgress();
    if (isPlaying) playFrom(currentTime);
  }

  function restartIfPlaying() { if (isPlaying) playFrom(currentTime); }

  function updatePlayIcon() { playerPlayBtn.textContent = isPlaying ? '❙❙' : '▶'; }

  function updatePlayerProgress() {
    const dur = audioBuffer ? audioBuffer.duration : 0;
    const pct = dur ? (currentTime / dur) * 100 : 0;
    playerScrubFill.style.width = pct + '%';
    playerScrubHandle.style.left = pct + '%';
    playerCurrentTimeEl.textContent = fmtTime(currentTime);
  }

  function initScrub() {
    let dragging = false;
    function seekFromEvent(e) {
      const rect = playerScrubTrack.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      if (audioBuffer) seek(pct * audioBuffer.duration);
    }
    playerScrubTrack.addEventListener('pointerdown', e => {
      dragging = true;
      playerScrubTrack.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    playerScrubTrack.addEventListener('pointermove', e => { if (dragging) seekFromEvent(e); });
    playerScrubTrack.addEventListener('pointerup', e => {
      dragging = false;
      playerScrubTrack.releasePointerCapture(e.pointerId);
    });

    waveCanvas.addEventListener('click', e => {
      if (!audioBuffer) return;
      const rect = waveCanvas.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      seek(ratio * audioBuffer.duration);
    });
  }

  // ── WAVEFORM DRAW ──
  function resizeWaveCanvas() {
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const r = waveCanvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const w = Math.floor(r.width * DPR), h = Math.floor(r.height * DPR);
    if (waveCanvas.width !== w || waveCanvas.height !== h) { waveCanvas.width = w; waveCanvas.height = h; }
    return { dW: r.width, dH: r.height, DPR };
  }

  function drawTrace(buffer, dW, mid, color) {
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.ceil(data.length / dW));
    waveCtx.strokeStyle = color;
    waveCtx.lineWidth = 1;
    for (let x = 0; x < dW; x++) {
      let min = 1, max = -1;
      const start = x * step;
      for (let i = 0; i < step; i++) {
        const v = data[start + i] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      waveCtx.beginPath();
      waveCtx.moveTo(x + 0.5, mid + min * mid);
      waveCtx.lineTo(x + 0.5, mid + max * mid);
      waveCtx.stroke();
    }
  }

  function drawWave() {
    const dims = resizeWaveCanvas();
    if (!dims) return;
    const { dW, dH, DPR } = dims;
    waveCtx.save();
    waveCtx.scale(DPR, DPR);
    waveCtx.clearRect(0, 0, dW, dH);

    if (!audioBuffer) { waveCtx.restore(); return; }

    const mid = dH / 2;

    // Original underneath, muted — the mixed trace on top is what actually
    // changed, so the original only needs to read as a faint reference.
    drawTrace(audioBuffer, dW, mid, 'rgba(200,200,200,0.55)');
    if (processedBuffer) drawTrace(processedBuffer, dW, mid, 'rgba(77,139,255,0.6)');
    else drawTrace(audioBuffer, dW, mid, 'rgba(77,139,255,0.6)');

    const progress = audioBuffer.duration ? currentTime / audioBuffer.duration : 0;
    waveCtx.strokeStyle = '#ffffff';
    waveCtx.beginPath();
    waveCtx.moveTo(progress * dW, 0);
    waveCtx.lineTo(progress * dW, dH);
    waveCtx.stroke();
    waveCtx.restore();
  }

  function waveDrawLoop() {
    requestAnimationFrame(waveDrawLoop);
    if (wavePanel.style.display === 'none') return;
    drawWave();
  }

  // ── MODULE RACK UI ──
  function updateModuleParams(id, params) {
    const mod = modules.find(m => m.id === id);
    if (!mod) return;
    mod.params = params;
    mixGraph?.updateModule(id, params);
    scheduleProcessedPreview();
  }

  function addModule(type) {
    modules = [...modules, createModule(type)];
    renderRack();
    restartIfPlaying();
    scheduleProcessedPreview();
  }

  function removeModule(id) {
    modules = modules.filter(m => m.id !== id);
    renderRack();
    restartIfPlaying();
    scheduleProcessedPreview();
  }

  function toggleBypass(id) {
    modules = modules.map(m => (m.id === id ? { ...m, bypassed: !m.bypassed } : m));
    renderRack();
    restartIfPlaying();
    scheduleProcessedPreview();
  }

  function moveModule(id, dir) {
    const idx = modules.findIndex(m => m.id === id);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= modules.length) return;
    const next = modules.slice();
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    modules = next;
    renderRack();
    restartIfPlaying();
    scheduleProcessedPreview();
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function sliderField(label, value, min, max, step, unit, onChange) {
    const field = el('div', 'slider-field');
    const row = el('div', 'slider-label-row');
    const labelEl = el('span', null, label);
    const valueEl = el('span', 'slider-value', value.toFixed(step < 1 ? 2 : 0) + (unit || ''));
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = value;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      valueEl.textContent = v.toFixed(step < 1 ? 2 : 0) + (unit || '');
      onChange(v);
    });
    field.appendChild(row);
    field.appendChild(input);
    return field;
  }

  const EQ_BAND_TYPES = ['highpass', 'lowshelf', 'peaking', 'highshelf', 'lowpass'];

  function buildModuleParamsUI(mod) {
    const wrap = el('div', 'module-card-params');
    const p = mod.params;

    function change(next) {
      updateModuleParams(mod.id, next);
    }

    switch (mod.type) {
      case 'gain':
        wrap.appendChild(sliderField('gain', p.gainDb, -24, 24, 0.5, ' db', v => change({ gainDb: v })));
        break;
      case 'eq':
        p.bands.forEach((band, i) => {
          const row = el('div', 'module-eq-band');
          const select = document.createElement('select');
          select.className = 'eq-band-select';
          EQ_BAND_TYPES.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t; opt.textContent = t;
            if (t === band.type) opt.selected = true;
            select.appendChild(opt);
          });
          select.addEventListener('change', () => {
            const bands = p.bands.map((b, j) => (j === i ? { ...b, type: select.value } : b));
            change({ bands });
          });
          row.appendChild(select);
          row.appendChild(sliderField('freq', band.freq, 20, 20000, 10, ' hz', v => {
            change({ bands: p.bands.map((b, j) => (j === i ? { ...b, freq: v } : b)) });
          }));
          row.appendChild(sliderField('gain', band.gainDb, -24, 24, 0.5, ' db', v => {
            change({ bands: p.bands.map((b, j) => (j === i ? { ...b, gainDb: v } : b)) });
          }));
          row.appendChild(sliderField('q', band.q, 0.1, 10, 0.1, '', v => {
            change({ bands: p.bands.map((b, j) => (j === i ? { ...b, q: v } : b)) });
          }));
          wrap.appendChild(row);
        });
        break;
      case 'compressor':
        wrap.appendChild(sliderField('threshold', p.thresholdDb, -60, 0, 1, ' db', v => change({ ...p, thresholdDb: v })));
        wrap.appendChild(sliderField('ratio', p.ratio, 1, 20, 0.5, ':1', v => change({ ...p, ratio: v })));
        wrap.appendChild(sliderField('attack', p.attackMs, 0, 200, 1, ' ms', v => change({ ...p, attackMs: v })));
        wrap.appendChild(sliderField('release', p.releaseMs, 10, 1000, 5, ' ms', v => change({ ...p, releaseMs: v })));
        wrap.appendChild(sliderField('knee', p.kneeDb, 0, 40, 1, ' db', v => change({ ...p, kneeDb: v })));
        wrap.appendChild(sliderField('makeup', p.makeupDb, 0, 24, 0.5, ' db', v => change({ ...p, makeupDb: v })));
        break;
      case 'saturation':
        wrap.appendChild(sliderField('drive', p.drive, 0, 1, 0.01, '', v => change({ ...p, drive: v })));
        wrap.appendChild(sliderField('mix', p.mix, 0, 1, 0.01, '', v => change({ ...p, mix: v })));
        break;
      case 'limiter':
        wrap.appendChild(sliderField('threshold', p.thresholdDb, -24, 0, 0.5, ' db', v => change({ ...p, thresholdDb: v })));
        wrap.appendChild(sliderField('release', p.releaseMs, 10, 500, 5, ' ms', v => change({ ...p, releaseMs: v })));
        wrap.appendChild(sliderField('ceiling', p.ceilingDb, -6, 0, 0.1, ' db', v => change({ ...p, ceilingDb: v })));
        break;
    }
    return wrap;
  }

  function renderRack() {
    rackList.innerHTML = '';
    rackEmpty.style.display = modules.length === 0 ? '' : 'none';

    modules.forEach((mod, idx) => {
      const card = el('div', 'module-card' + (mod.bypassed ? ' bypassed' : ''));
      const head = el('div', 'module-card-head');

      const upBtn = el('button', 'module-card-order-btn', '▲');
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', () => moveModule(mod.id, -1));

      const downBtn = el('button', 'module-card-order-btn', '▼');
      downBtn.disabled = idx === modules.length - 1;
      downBtn.addEventListener('click', () => moveModule(mod.id, 1));

      const label = el('span', 'module-card-label', mod.label);

      const bypassBtn = el('button', 'module-card-icon-btn', mod.bypassed ? 'bypassed' : 'on');
      bypassBtn.addEventListener('click', () => toggleBypass(mod.id));

      const removeBtn = el('button', 'module-card-icon-btn', 'remove');
      removeBtn.addEventListener('click', () => removeModule(mod.id));

      head.appendChild(upBtn);
      head.appendChild(downBtn);
      head.appendChild(label);
      head.appendChild(bypassBtn);
      head.appendChild(removeBtn);

      card.appendChild(head);
      card.appendChild(buildModuleParamsUI(mod));
      rackList.appendChild(card);
    });
  }

  document.querySelectorAll('.rack-add-btn').forEach(btn => {
    btn.addEventListener('click', () => addModule(btn.dataset.type));
  });

  // ── RECORDING: MIC ONLY (ported from Bampler's startRecording()) ──
  function startMicRecording() {
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const ctx = getAudioCtx();
      const chunks = [];
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = e => { if (recActive) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(proc);
      proc.connect(ctx.destination);
      micRecState = { src, proc, stream, sampleRate: ctx.sampleRate, chunks };
      activeRecordCancel = () => stopRecording(true);
    });
  }

  function finishMicRecording() {
    const { src, proc, stream, sampleRate, chunks } = micRecState;
    micRecState = null;
    try { src.disconnect(); } catch (_) {}
    try { proc.disconnect(); } catch (_) {}
    stream.getTracks().forEach(t => t.stop());
    if (!chunks.length) return null;

    let totalSamples = 0;
    for (const c of chunks) totalSamples += c.length;
    const maxSamples = Math.floor(MAX_SECS * sampleRate);
    const finalLen = Math.min(totalSamples, maxSamples);
    const pcm = new Float32Array(finalLen);
    let offset = 0;
    for (const c of chunks) {
      if (offset >= finalLen) break;
      const n = Math.min(c.length, finalLen - offset);
      pcm.set(c.subarray(0, n), offset);
      offset += n;
    }
    const buf = getAudioCtx().createBuffer(1, finalLen, sampleRate);
    buf.getChannelData(0).set(pcm);
    return buf;
  }

  function startRecording() {
    if (recActive) return;
    setShellStatus('RECORDING');
    startMicRecording().then(() => {
      recActive = true;
      recSeconds = 0;
      btnRecord.classList.add('recording');
      recLabel.textContent = '■ Stop';
      btnUpload.disabled = true;
      recTimer.style.display = '';
      recTimeDisplay.textContent = '0:00';
      recTimerInterval = setInterval(() => {
        recSeconds++;
        recTimeDisplay.textContent = fmtTime(recSeconds);
        if (recSeconds >= MAX_SECS) stopRecording(false);
      }, 1000);
    }).catch(err => {
      console.error(err);
      showError('Could not access mic. Check permissions.');
      setShellStatus('ERROR');
    });
  }

  function stopRecording(discard) {
    if (!recActive) return;
    recActive = false;
    activeRecordCancel = null;
    clearInterval(recTimerInterval);
    btnRecord.classList.remove('recording');
    recLabel.textContent = 'Record';
    btnUpload.disabled = false;
    recTimer.style.display = 'none';

    const buf = finishMicRecording();
    if (discard || !buf) { setShellStatus('READY'); return; }
    showProcessing('Building audio…');
    setTimeout(() => {
      hideProcessing();
      commitSource(buf, new Blob(), 'wav', 'audio', 'recording');
      setShellStatus('LOADED');
    }, 0);
  }

  // ── EXPORT ──
  async function renderAndExport() {
    if (!audioBuffer) return;
    clearError();
    renderError.style.display = 'none';
    btnRender.disabled = true;
    btnRender.textContent = 'Rendering…';
    setShellStatus('RENDERING');

    try {
      const offlineCtx = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      buildMixGraph(offlineCtx, modules, source, offlineCtx.destination);
      source.start(0);
      const rendered = await offlineCtx.startRendering();
      const wavBlob = audioBufferToWavBlob(rendered);

      let outBlob = wavBlob;
      let outExt = sourceExt;

      if (sourceExt !== 'wav') {
        btnRender.textContent = 'Encoding…';
        setShellStatus('ENCODING');
        if (sourceKind === 'video') {
          outBlob = await window.BixerFFmpeg.remuxVideoWithAudio(sourceBlob, sourceExt, wavBlob, sourceExt, pct => {
            btnRender.textContent = 'Encoding… ' + pct + '%';
          });
        } else {
          outBlob = await window.BixerFFmpeg.transcodeAudioOnly(wavBlob, sourceExt, pct => {
            btnRender.textContent = 'Encoding… ' + pct + '%';
          });
        }
        outExt = sourceExt;
      }

      if (downloadObjectUrl) URL.revokeObjectURL(downloadObjectUrl);
      downloadObjectUrl = URL.createObjectURL(outBlob);
      const filename = sourceBaseName + '-mixed.' + outExt;

      // Fires the download itself — the button already says "Render +
      // Download", so it shouldn't take a second click to actually get the
      // file. Same temporary-anchor pattern Bampler uses for its zip export.
      const a = document.createElement('a');
      a.href = downloadObjectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Left visible as a fallback (a popup/download blocker could swallow
      // the auto-click above) and so the file stays downloadable again
      // without re-rendering.
      btnDownloadLink.href = downloadObjectUrl;
      btnDownloadLink.download = filename;
      btnDownloadLink.textContent = '⬇ Download again';
      btnDownloadLink.style.display = '';
      setShellStatus('READY');
    } catch (err) {
      console.error(err);
      renderError.textContent = err.message || 'Render failed.';
      renderError.style.display = '';
      setShellStatus('ERROR');
    } finally {
      btnRender.disabled = false;
      btnRender.textContent = '⬇ Render + Download';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Bixer = { init };
})();
