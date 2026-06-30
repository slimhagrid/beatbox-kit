// bid2baud-stuff.js — video-to-MP3 conversion logic
// Runs fully client-side: decodes the video's audio track via a hidden
// <video> element + Web Audio (captured on an AudioWorklet, off the main
// thread, to avoid dropouts), then encodes the PCM to MP3 with lamejs.
(function () {
  const MAX_SECS = 120; // 2 minutes
  const MP3_KBPS = 320; // max standard MP3 bitrate — decode side is already lossless, so don't bottleneck on encode
  const WAVE_BARS = 600; // matches Baudit's resolution for a comparably tight waveform
  const MODE_DESCRIPTIONS = {
    slow: '<strong>Lightweight:</strong> ~100kb download, takes the video full length to process. Good for slow data.',
    fast: '<strong>Fast:</strong> ~30MB download, fast processing once done. Good for WiFi connections.',
  };

  let fileInput, uploadPanel, btnUpload, btnReset, processingIndicator,
      processingMsg, resultPanel, resultAudio, btnDownload,
      btnConvertAnother, resultSizeBadge, errorMsg, sessionName, shellStatus,
      wavePanel, waveCanvas, waveCtx, waveEncodingOverlay, waveFilenameEl,
      waveFilesizeEl, waveCurrentTimeEl, waveTotalTimeEl, waveRulerQ1,
      waveRulerMid, waveRulerQ3, waveRulerEnd, playerPlayBtn, playerScrubTrack,
      playerScrubFill, playerScrubHandle, playerCurrentTimeEl, playerTotalTimeEl,
      modeToggleDesc, modeRadios;

  let resultObjectUrl = null;
  // Set while a file's audio is being captured; read by the persistent
  // draw loop so the waveform keeps rendering/resizing correctly even
  // between worklet messages.
  let waveState = null;
  // Whichever conversion path is currently running registers a function
  // here that actually stops the work (pausing/closing the audio graph, or
  // terminating the ffmpeg worker) — "Start Over" calls it instead of just
  // hiding the UI and leaving the old conversion grinding away in the
  // background.
  let activeCancel = null;
  let cancelling = false;

  function $(id) { return document.getElementById(id); }

  function init() {
    fileInput = $('file-input');
    uploadPanel = $('upload-panel');
    btnUpload = $('btn-upload');
    btnReset = $('btn-reset');
    processingIndicator = $('processing-indicator');
    processingMsg = $('processing-msg');
    resultPanel = $('result-panel');
    resultAudio = $('result-audio');
    btnDownload = $('btn-download');
    btnConvertAnother = $('btn-convert-another');
    resultSizeBadge = $('result-size-badge');
    errorMsg = $('error-msg');
    sessionName = $('session-name');
    shellStatus = $('shell-status');
    wavePanel = $('wave-panel');
    waveCanvas = $('wave-canvas');
    waveCtx = waveCanvas.getContext('2d');
    waveEncodingOverlay = $('wave-encoding-overlay');
    waveFilenameEl = $('wave-filename');
    waveFilesizeEl = $('wave-filesize');
    waveCurrentTimeEl = $('wave-current-time');
    waveTotalTimeEl = $('wave-total-time');
    waveRulerQ1 = $('wave-ruler-q1');
    waveRulerMid = $('wave-ruler-mid');
    waveRulerQ3 = $('wave-ruler-q3');
    waveRulerEnd = $('wave-ruler-end');
    playerPlayBtn = $('player-play-btn');
    playerScrubTrack = $('player-scrub-track');
    playerScrubFill = $('player-scrub-fill');
    playerScrubHandle = $('player-scrub-handle');
    playerCurrentTimeEl = $('player-current-time');
    playerTotalTimeEl = $('player-total-time');
    modeToggleDesc = $('mode-toggle-desc');
    modeRadios = document.querySelectorAll('input[name="convert-mode"]');

    initPlayer();
    updateModeDesc();
    modeRadios.forEach(r => r.addEventListener('change', updateModeDesc));

    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) handleFile(e.target.files[0]);
    });
    btnReset.addEventListener('click', reset);
    btnConvertAnother.addEventListener('click', reset);

    uploadPanel.addEventListener('dragover', e => {
      e.preventDefault();
      uploadPanel.classList.add('dragging');
    });
    uploadPanel.addEventListener('dragleave', () => uploadPanel.classList.remove('dragging'));
    uploadPanel.addEventListener('drop', e => {
      e.preventDefault();
      uploadPanel.classList.remove('dragging');
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    requestAnimationFrame(waveDrawLoop);
  }

  function setShellStatus(text) {
    if (shellStatus) shellStatus.textContent = text;
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = '';
  }
  function clearError() {
    errorMsg.style.display = 'none';
  }

  function showProcessing(on, msg) {
    processingIndicator.style.display = on ? '' : 'none';
    if (on && msg) processingMsg.textContent = msg;
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + String(sec).padStart(2, '0');
  }
  function fmtSize(bytes) {
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  }

  function getMode() {
    const checked = document.querySelector('input[name="convert-mode"]:checked');
    return checked ? checked.value : 'slow';
  }

  function updateModeDesc() {
    modeToggleDesc.innerHTML = MODE_DESCRIPTIONS[getMode()];
  }

  async function handleFile(file) {
    clearError();
    const okType = /^video\/(mp4|quicktime|webm)$/.test(file.type) || /\.(mp4|mov|webm)$/i.test(file.name);
    if (!okType) {
      showError('Unsupported file. Please upload an MP4, MOV, or WebM video.');
      return;
    }
    const mode = getMode();
    if (mode === 'slow' && typeof lamejs === 'undefined') {
      showError('MP3 encoder failed to load. Check your connection and reload the page.');
      return;
    }

    sessionName.textContent = file.name;
    resultPanel.style.display = 'none';
    wavePanel.style.display = 'none';
    waveEncodingOverlay.style.display = 'none';
    waveState = null;

    btnUpload.disabled = true;
    setShellStatus('LOADING');

    try {
      let mp3Blob;
      if (mode === 'fast') {
        showProcessing(true, 'Loading converter…');
        mp3Blob = await convertWithFfmpeg(file);
      } else {
        waveFilenameEl.textContent = file.name;
        waveFilesizeEl.textContent = fmtSize(file.size);
        showProcessing(true, 'Reading video…');
        const { left, right, numChannels, sampleRate } = await extractAudio(file);
        waveEncodingOverlay.style.display = 'flex';
        setShellStatus('ENCODING');
        // Yield a frame so the overlay actually paints before the (synchronous,
        // CPU-bound) MP3 encode loop blocks the main thread.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        mp3Blob = encodeMp3(left, right, numChannels, sampleRate);
      }
      showResult(file.name, mp3Blob);
      setShellStatus('CONVERTED');
    } catch (err) {
      console.error(err);
      // "Start Over" cancels by rejecting/erroring the in-flight operation on
      // purpose — that's not a failure worth surfacing as one.
      if (!cancelling) {
        showError(err.message || 'Could not convert this file. Try a different video.');
        setShellStatus('ERROR');
      }
      wavePanel.style.display = 'none';
      waveState = null;
    } finally {
      cancelling = false;
      activeCancel = null;
      showProcessing(false);
      waveEncodingOverlay.style.display = 'none';
      btnUpload.disabled = false;
    }
  }

  // ── FAST PATH (ffmpeg.wasm) ──
  // Lazy-loaded only on this page, and only the first time someone actually
  // picks "Fast" mode — most visitors never pay for this ~30MB download.
  // Demuxes/decodes the container directly (no real-time playback needed),
  // so it isn't bound to the video's wall-clock duration like the Web Audio
  // path is.
  //
  // Self-hosted (not jsdelivr) and loaded via the ESM build, not UMD: the
  // package's own class always spawns its worker as `{type: "module"}`,
  // and module workers don't support importScripts() at all — only the ESM
  // worker (which uses dynamic import()) and an ESM-flavored core script
  // (which has a real `export default`) actually work with that. The UMD
  // build's worker chunk hits this exact mismatch when used standalone.
  const FFMPEG_VENDOR = '../js/bid2baud/vendor/';
  let ffmpegLoadPromise = null;

  function abs(path) {
    return new URL(path, document.baseURI).href;
  }

  function getFfmpeg() {
    if (ffmpegLoadPromise) return ffmpegLoadPromise;
    ffmpegLoadPromise = (async () => {
      const { FFmpeg } = await import(abs(FFMPEG_VENDOR + 'classes.js'));
      const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }) => {
        const pct = Math.min(100, Math.max(0, Math.round((progress || 0) * 100)));
        showProcessing(true, 'Converting… ' + pct + '%');
      });
      await ffmpeg.load({
        coreURL: abs(FFMPEG_VENDOR + 'ffmpeg-core.esm.js'),
        wasmURL: abs(FFMPEG_VENDOR + 'ffmpeg-core.wasm'),
      });
      return ffmpeg;
    })();
    // Don't leave future attempts permanently stuck on a one-off network blip.
    ffmpegLoadPromise.catch(() => { ffmpegLoadPromise = null; });
    return ffmpegLoadPromise;
  }

  async function convertWithFfmpeg(file) {
    const duration = await getVideoDuration(file);
    if (!isFinite(duration) || duration <= 0) {
      throw new Error('Could not determine video duration.');
    }
    if (duration > MAX_SECS) {
      throw new Error('Video is too long. Max length is 2 minutes.');
    }

    // terminate() kills the worker outright (actually stopping the wasm
    // computation), not just abandoning our promise — an AbortSignal would
    // leave the worker grinding away in the background, which isn't what
    // "Start Over" should mean.
    activeCancel = async () => {
      const ff = await getFfmpeg().catch(() => null);
      if (ff) ff.terminate();
      ffmpegLoadPromise = null;
    };
    const ffmpeg = await getFfmpeg();
    showProcessing(true, 'Converting…');
    const ext = (file.name.match(/\.[^.]+$/) || ['.mp4'])[0];
    const inName = 'input' + ext;
    const outName = 'output.mp3';
    const data = new Uint8Array(await file.arrayBuffer());
    await ffmpeg.writeFile(inName, data);
    try {
      await ffmpeg.exec(['-i', inName, '-vn', '-b:a', '320k', outName]);
      const out = await ffmpeg.readFile(outName);
      return new Blob([out.buffer], { type: 'audio/mpeg' });
    } finally {
      await ffmpeg.deleteFile(inName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
    }
  }

  function extractAudio(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const videoEl = document.createElement('video');
      videoEl.src = url;
      videoEl.playsInline = true;
      videoEl.preload = 'auto';

      let settled = false;
      // Set once startCapture has real audio-graph resources to tear down;
      // fail() runs it so cancelling mid-capture doesn't leave the video
      // playing and the worklet capturing in the background.
      let cleanupCapture = null;
      function fail(msg) {
        if (settled) return;
        settled = true;
        if (cleanupCapture) cleanupCapture();
        URL.revokeObjectURL(url);
        reject(new Error(msg));
      }
      activeCancel = () => fail('Cancelled.');

      videoEl.addEventListener('error', () => fail('Could not read this video file. The codec may be unsupported.'));

      videoEl.addEventListener('loadedmetadata', () => {
        resolveDuration(videoEl, duration => {
          if (settled) return;
          if (!isFinite(duration) || duration <= 0) {
            fail('Could not determine video duration.');
            return;
          }
          if (duration > MAX_SECS) {
            fail('Video is too long. Max length is 2 minutes.');
            return;
          }
          startCapture(videoEl, duration).catch(err => fail(err.message));
        });
      });

      async function startCapture(videoEl, duration) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        await ctx.audioWorklet.addModule('../js/bid2baud/bid2baud-capture-worklet.js');
        if (settled) { ctx.close(); return; }

        const source = ctx.createMediaElementSource(videoEl);
        const captureNode = new AudioWorkletNode(ctx, 'bid2baud-capture');
        // Silent tap: keeps the graph flowing without playing audio out loud
        // — the user only hears the finished MP3.
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;

        cleanupCapture = () => {
          try { videoEl.pause(); } catch {}
          try { captureNode.disconnect(); } catch {}
          try { source.disconnect(); } catch {}
          try { ctx.close(); } catch {}
        };

        const chunksL = [];
        const chunksR = [];
        let numChannels = 1;
        let totalSamples = 0;

        // Reveal the waveform panel and prime the ruler/time labels now that
        // we know the real duration.
        showProcessing(false);
        waveTotalTimeEl.textContent = fmtTime(duration);
        waveRulerQ1.textContent = fmtTime(duration * 0.25);
        waveRulerMid.textContent = fmtTime(duration * 0.5);
        waveRulerQ3.textContent = fmtTime(duration * 0.75);
        waveRulerEnd.textContent = fmtTime(duration);
        wavePanel.style.display = '';
        waveState = { bars: new Float32Array(WAVE_BARS), currentBucket: -1, duration, videoEl };

        captureNode.port.onmessage = e => {
          const { left, right } = e.data;
          numChannels = right ? 2 : 1;
          chunksL.push(left);
          if (right) chunksR.push(right);
          totalSamples += left.length;

          if (waveState) {
            let peak = 0;
            for (let i = 0; i < left.length; i++) {
              const v = Math.abs(left[i]);
              if (v > peak) peak = v;
            }
            const bucket = Math.min(WAVE_BARS - 1, Math.floor((videoEl.currentTime / duration) * WAVE_BARS));
            if (bucket > waveState.currentBucket) waveState.currentBucket = bucket;
            if (peak > waveState.bars[bucket]) waveState.bars[bucket] = peak;
          }
        };

        source.connect(captureNode);
        captureNode.connect(silentGain);
        silentGain.connect(ctx.destination);

        function finish() {
          if (settled) return;
          settled = true;
          captureNode.port.postMessage('flush');
          // Give the final flush message a moment to arrive before tearing
          // down the graph and resolving.
          setTimeout(() => {
            captureNode.disconnect();
            source.disconnect();
            ctx.close();
            URL.revokeObjectURL(url);

            if (waveState) {
              waveState.currentBucket = WAVE_BARS - 1;
              waveState.videoEl = null;
            }

            const left = mergeChunks(chunksL, totalSamples);
            const right = numChannels > 1 ? mergeChunks(chunksR, totalSamples) : left;
            resolve({ left, right, numChannels, sampleRate: ctx.sampleRate, duration });
          }, 50);
        }

        videoEl.addEventListener('ended', finish);
        // Do NOT set videoEl.muted — once routed through createMediaElementSource,
        // muting the element also zeroes the signal reaching this graph in most
        // browsers. The silentGain node above is what keeps it inaudible.
        // NOTE: extraction runs at normal (1x) speed on purpose. Playing back
        // faster with pitch-preservation off forces the browser to actually
        // downsample/decimate the audio to fit more content into less wall-clock
        // time — that's real, unrecoverable quality loss, not just compression.
        await videoEl.play();
      }
    });
  }

  // Some browsers report Infinity for duration on certain containers until
  // the media is seeked once. Work around it before trusting the value.
  // Quick metadata-only duration probe — used by the fast path, which
  // otherwise has no reason to ever touch a <video>/Web Audio at all.
  function getVideoDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const videoEl = document.createElement('video');
      videoEl.preload = 'metadata';
      videoEl.src = url;
      videoEl.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read this video file. The codec may be unsupported.'));
      });
      videoEl.addEventListener('loadedmetadata', () => {
        resolveDuration(videoEl, duration => {
          URL.revokeObjectURL(url);
          resolve(duration);
        });
      });
    });
  }

  function resolveDuration(videoEl, cb) {
    if (isFinite(videoEl.duration) && videoEl.duration > 0) {
      cb(videoEl.duration);
      return;
    }
    const onChange = () => {
      videoEl.removeEventListener('durationchange', onChange);
      videoEl.currentTime = 0;
      cb(videoEl.duration);
    };
    videoEl.addEventListener('durationchange', onChange);
    videoEl.currentTime = 1e9;
  }

  function mergeChunks(chunks, totalSamples) {
    const out = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  // Phone/video audio codecs commonly decode with brief "true peak" overshoot
  // past +/-1.0 — harmless on a normal player with headroom, but a hard clamp
  // here would flatten those peaks and sound like clipping. Scale the whole
  // buffer down instead, only if it's actually needed, so dynamics survive.
  function findPeak(left, right, numChannels) {
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      const v = Math.abs(left[i]);
      if (v > peak) peak = v;
    }
    if (numChannels > 1) {
      for (let i = 0; i < right.length; i++) {
        const v = Math.abs(right[i]);
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  function floatTo16BitPCM(float32Array, scale) {
    const out = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i] * scale));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function encodeMp3(left, right, numChannels, sampleRate) {
    const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, MP3_KBPS);
    const blockSize = 1152;
    const mp3Data = [];
    const peak = findPeak(left, right, numChannels);
    const scale = peak > 1 ? 0.999 / peak : 1;
    const leftPCM = floatTo16BitPCM(left, scale);
    const rightPCM = numChannels > 1 ? floatTo16BitPCM(right, scale) : null;

    for (let i = 0; i < leftPCM.length; i += blockSize) {
      const leftChunk = leftPCM.subarray(i, i + blockSize);
      let buf;
      if (numChannels > 1) {
        buf = encoder.encodeBuffer(leftChunk, rightPCM.subarray(i, i + blockSize));
      } else {
        buf = encoder.encodeBuffer(leftChunk);
      }
      if (buf.length > 0) mp3Data.push(buf);
    }
    const end = encoder.flush();
    if (end.length > 0) mp3Data.push(end);
    return new Blob(mp3Data, { type: 'audio/mpeg' });
  }

  // ── WAVEFORM DRAW LOOP ──
  // Single persistent rAF loop (like the rest of the site's canvases) that
  // renders the in-progress waveform: bars already captured are drawn pink,
  // the current bucket highlighted, and everything not yet reached stays a
  // dim placeholder track — that boundary IS the extraction progress. Bars
  // are batched into a handful of fill() calls (like Baudit's timeline) so
  // 600 bars stay cheap to redraw every frame.
  function resizeWaveCanvas() {
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const r = waveCanvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const w = Math.floor(r.width * DPR), h = Math.floor(r.height * DPR);
    if (waveCanvas.width !== w || waveCanvas.height !== h) {
      waveCanvas.width = w;
      waveCanvas.height = h;
    }
    return { dW: r.width, dH: r.height, DPR };
  }

  function drawWave(bars, currentBucket) {
    const dims = resizeWaveCanvas();
    if (!dims) return;
    const { dW, dH, DPR } = dims;
    waveCtx.save();
    waveCtx.scale(DPR, DPR);
    waveCtx.clearRect(0, 0, dW, dH);
    const mid = dH / 2;
    const bW = Math.max(0.8, dW / WAVE_BARS - 0.5);

    // Pending (not yet captured) — thin placeholder track, one batched fill.
    waveCtx.fillStyle = 'rgba(255,255,255,0.12)';
    waveCtx.beginPath();
    for (let i = currentBucket + 1; i < WAVE_BARS; i++) {
      waveCtx.rect((i / WAVE_BARS) * dW, mid - 1.5, bW, 3);
    }
    waveCtx.fill();

    // Captured — real amplitude bars, one batched fill.
    waveCtx.fillStyle = 'rgba(255,77,141,0.85)';
    waveCtx.beginPath();
    for (let i = 0; i <= currentBucket; i++) {
      if (i === currentBucket) continue; // drawn separately, brighter
      const barH = Math.max(2, bars[i] * dH * 0.85);
      waveCtx.rect((i / WAVE_BARS) * dW, mid - barH / 2, bW, barH);
    }
    waveCtx.fill();

    // Current bucket — bright highlight on top.
    if (currentBucket >= 0 && currentBucket < WAVE_BARS) {
      const barH = Math.max(2, bars[currentBucket] * dH * 0.85);
      waveCtx.fillStyle = '#ffd1e3';
      waveCtx.fillRect((currentBucket / WAVE_BARS) * dW, mid - barH / 2, bW, barH);
    }
    waveCtx.restore();
  }

  function waveDrawLoop() {
    requestAnimationFrame(waveDrawLoop);
    if (!waveState || wavePanel.style.display === 'none') return;
    const t = waveState.videoEl ? Math.min(waveState.videoEl.currentTime, waveState.duration) : waveState.duration;
    waveCurrentTimeEl.textContent = fmtTime(t);
    drawWave(waveState.bars, waveState.currentBucket);
  }

  // ── CUSTOM AUDIO PLAYER ──
  // Native <audio controls> can't be styled consistently across browsers, so
  // a hidden <audio> element supplies playback while this drives an on-brand
  // play button + scrubber.
  function initPlayer() {
    playerPlayBtn.addEventListener('click', () => {
      if (resultAudio.paused) resultAudio.play(); else resultAudio.pause();
    });
    resultAudio.addEventListener('play', () => { playerPlayBtn.textContent = '❙❙'; });
    resultAudio.addEventListener('pause', () => { playerPlayBtn.textContent = '▶'; });
    resultAudio.addEventListener('ended', () => {
      playerPlayBtn.textContent = '▶';
      resultAudio.currentTime = 0;
    });
    resultAudio.addEventListener('loadedmetadata', () => {
      playerTotalTimeEl.textContent = fmtTime(resultAudio.duration);
    });
    resultAudio.addEventListener('timeupdate', updatePlayerProgress);

    let dragging = false;
    function seekFromEvent(e) {
      const rect = playerScrubTrack.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      if (isFinite(resultAudio.duration) && resultAudio.duration > 0) {
        resultAudio.currentTime = pct * resultAudio.duration;
      }
      updatePlayerProgress();
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
  }

  function updatePlayerProgress() {
    const dur = resultAudio.duration;
    const cur = resultAudio.currentTime;
    const pct = dur ? (cur / dur) * 100 : 0;
    playerScrubFill.style.width = pct + '%';
    playerScrubHandle.style.left = pct + '%';
    playerCurrentTimeEl.textContent = fmtTime(cur);
  }

  function resetPlayerUI() {
    playerPlayBtn.textContent = '▶';
    playerScrubFill.style.width = '0%';
    playerScrubHandle.style.left = '0%';
    playerCurrentTimeEl.textContent = '0:00';
    playerTotalTimeEl.textContent = '0:00';
  }

  function showResult(filename, blob) {
    if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
    resultAudio.pause();
    resetPlayerUI();
    resultObjectUrl = URL.createObjectURL(blob);
    resultAudio.src = resultObjectUrl;
    const base = filename.replace(/\.[^.]+$/, '') || 'audio';
    btnDownload.href = resultObjectUrl;
    btnDownload.download = base + '.mp3';
    resultSizeBadge.textContent = fmtSize(blob.size);
    resultPanel.style.display = '';
  }

  function reset() {
    if (activeCancel) {
      cancelling = true;
      const cancel = activeCancel;
      activeCancel = null;
      cancel();
    }
    showProcessing(false);
    btnUpload.disabled = false;

    fileInput.value = '';
    wavePanel.style.display = 'none';
    waveEncodingOverlay.style.display = 'none';
    waveState = null;
    resultPanel.style.display = 'none';
    clearError();
    sessionName.textContent = 'no file loaded';
    setShellStatus('READY');
    resultAudio.pause();
    resetPlayerUI();
    if (resultObjectUrl) {
      URL.revokeObjectURL(resultObjectUrl);
      resultObjectUrl = null;
    }
    resultAudio.removeAttribute('src');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
