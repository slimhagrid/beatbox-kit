// bixer-ffmpeg.js — lazy-loaded ffmpeg.wasm wrapper. Reuses Bid2baud's
// self-hosted ffmpeg.wasm vendor bundle (js/bid2baud/vendor/) rather than
// shipping a second copy — see bid2baud-stuff.js's getFfmpeg() for the
// original lazy-load pattern this mirrors.
//
// Used for two things: extracting audio out of an uploaded video/recording
// (extractAudioToWav — called on upload, replacing what used to be a
// real-time-bound <video> playback capture) and, at export time, encoding
// the mixed result back into the original extension/container
// (transcodeAudioOnly / remuxVideoWithAudio). Because both paths now share
// one ffmpeg instance, the very first video interaction in a session pays
// the ~30MB wasm download once, rather than paying it again at export.
window.BixerFFmpeg = (function () {
  const FFMPEG_VENDOR = '../js/bid2baud/vendor/';
  const MAX_SECS = 120; // matches the 2-minute cap used everywhere else in the kit
  let ffmpegLoadPromise = null;
  // The load promise is memoized (so the wasm is only fetched once), but
  // callers each want their own progress callback — this lets the single
  // 'progress' listener registered at load time dispatch to whichever
  // caller is currently running an exec.
  let currentOnProgress = null;

  function abs(path) { return new URL(path, document.baseURI).href; }

  function getFfmpeg() {
    if (ffmpegLoadPromise) return ffmpegLoadPromise;
    ffmpegLoadPromise = (async () => {
      const { FFmpeg } = await import(abs(FFMPEG_VENDOR + 'classes.js'));
      const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }) => {
        if (currentOnProgress) currentOnProgress(Math.min(100, Math.max(0, Math.round((progress || 0) * 100))));
      });
      // ffmpeg's own stderr output — a wasm crash otherwise surfaces as an
      // opaque "memory access out of bounds" with no indication of what
      // ffmpeg was actually doing when it happened. This gets the real
      // reason into devtools instead.
      ffmpeg.on('log', ({ message }) => console.log('[ffmpeg]', message));
      await ffmpeg.load({
        coreURL: abs(FFMPEG_VENDOR + 'ffmpeg-core.esm.js'),
        wasmURL: abs(FFMPEG_VENDOR + 'ffmpeg-core.wasm'),
      });
      return ffmpeg;
    })();
    ffmpegLoadPromise.catch(() => { ffmpegLoadPromise = null; });
    return ffmpegLoadPromise;
  }

  // Demuxes audio straight out of a video/recording blob — no real-time
  // playback involved, so a long file doesn't take as long to process as
  // it does to watch. -t caps how much of the input ffmpeg even bothers
  // decoding, keeping this fast regardless of the source's actual length.
  async function extractAudioToWav(blob, ext, onProgress) {
    currentOnProgress = onProgress || null;
    const ffmpeg = await getFfmpeg();
    const inName = 'source.' + ext;
    const outName = 'extracted.wav';
    await ffmpeg.writeFile(inName, new Uint8Array(await blob.arrayBuffer()));
    try {
      await ffmpeg.exec([
        '-probesize', '50M',
        '-analyzeduration', '100M',
        '-i', inName,
        '-t', String(MAX_SECS),
        '-vn', '-ac', '2', '-ar', '44100',
        outName,
      ]);
      const out = await ffmpeg.readFile(outName);
      return new Blob([out.buffer], { type: 'audio/wav' });
    } finally {
      await ffmpeg.deleteFile(inName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
      currentOnProgress = null;
    }
  }

  // Ported from Quick Mix's server-side src/lib/ffmpeg.ts (AUDIO_CODEC_BY_EXT).
  const AUDIO_CODEC_BY_EXT = {
    mp3: 'libmp3lame',
    wav: 'pcm_s16le',
    m4a: 'aac',
    aac: 'aac',
    ogg: 'libvorbis',
    flac: 'flac',
  };

  // Ported from Quick Mix's VIDEO_AUDIO_CODEC_BY_EXT.
  const VIDEO_AUDIO_CODEC_BY_EXT = {
    mp4: 'aac',
    mov: 'aac',
    m4v: 'aac',
    webm: 'libopus',
    mkv: 'aac',
  };

  // Transcodes the rendered wav into the requested audio-only extension.
  // Ported from transcodeAudioOnly() in ffmpeg.ts.
  async function transcodeAudioOnly(wavBlob, ext, onProgress) {
    currentOnProgress = onProgress || null;
    const ffmpeg = await getFfmpeg();
    const codec = AUDIO_CODEC_BY_EXT[ext.toLowerCase()] || 'aac';
    const inName = 'rendered.wav';
    const outName = 'output.' + ext;
    await ffmpeg.writeFile(inName, new Uint8Array(await wavBlob.arrayBuffer()));
    try {
      await ffmpeg.exec(['-i', inName, '-c:a', codec, outName]);
      const out = await ffmpeg.readFile(outName);
      return new Blob([out.buffer], { type: mimeForExt(ext) });
    } finally {
      await ffmpeg.deleteFile(inName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
      currentOnProgress = null;
    }
  }

  // Replaces the audio track of a video file with the rendered wav, keeping
  // the original video stream untouched (-c:v copy). Ported from
  // remuxVideoWithAudio() in ffmpeg.ts. Only ever called for real uploaded
  // video files — Bixer's recording feature is mic-only, so there's no
  // MediaRecorder-produced video to worry about here.
  async function remuxVideoWithAudio(originalBlob, originalExt, wavBlob, outExt, onProgress) {
    currentOnProgress = onProgress || null;
    const ffmpeg = await getFfmpeg();
    const audioCodec = VIDEO_AUDIO_CODEC_BY_EXT[outExt.toLowerCase()] || 'aac';
    const inVideoName = 'original.' + originalExt;
    const inAudioName = 'rendered.wav';
    const outName = 'output.' + outExt;
    await ffmpeg.writeFile(inVideoName, new Uint8Array(await originalBlob.arrayBuffer()));
    await ffmpeg.writeFile(inAudioName, new Uint8Array(await wavBlob.arrayBuffer()));
    try {
      await ffmpeg.exec([
        '-i', inVideoName,
        '-i', inAudioName,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', audioCodec,
        '-shortest',
        outName,
      ]);
      const out = await ffmpeg.readFile(outName);
      return new Blob([out.buffer], { type: mimeForExt(outExt) });
    } finally {
      await ffmpeg.deleteFile(inVideoName).catch(() => {});
      await ffmpeg.deleteFile(inAudioName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
      currentOnProgress = null;
    }
  }

  function mimeForExt(ext) {
    const map = {
      mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
      ogg: 'audio/ogg', flac: 'audio/flac',
      mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
      webm: 'video/webm', mkv: 'video/x-matroska',
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
  }

  return { extractAudioToWav, transcodeAudioOnly, remuxVideoWithAudio };
})();
