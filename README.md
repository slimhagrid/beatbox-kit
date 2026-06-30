# Beatbox Kit

Beatbox Kit is a growing suite browser-based audio tools built for beatboxers — analyze your timing, sample your routines, sequence grains, and patch together modular beatbox chains, all without installing anything.

All tools run client-side and work with uploaded audio files or live mic recordings (up to 2 minutes).

## Tools

### Baudit — Timing Audit
Upload or record your beatbox routine to see exactly where your timing is on point and where it drifts.
- Automatic BPM detection from your waveform
- Beat-by-beat timing drift analysis
- Too-fast / too-slow markers on a timeline
- Quick-listen to any flagged moment
- Compare two takes side-by-side

**How to use it:** Open [`/baudit`](baudit/), upload an audio file or hit Record to capture from your mic, and wait for analysis to finish. Your average BPM, timing issue count, and max drift appear above the timeline. Click any flagged marker to jump to and preview that moment. Toggle Compare Mode to upload or record a second take and audit them side-by-side.

### Bampler — Beatbox Sampler
Slice your beatbox audio into 16 playable pads and perform with your keyboard.
- Play 16 reassignable pads with your keyboard
- One-Shot and Lock per pad
- Sample length editing
- Auto Chop feature
- Record from your mic directly to a pad
- Export all loaded pads as WAV files in a zip

**How to use it:** Open [`/bampler`](bampler/), upload or record audio, then either click **Auto Chop** to randomly slice it across the pads, or turn on **Sample Mode**, select a pad, and drag on the waveform to set that pad's region manually. Click a pad (or press its assigned key) to trigger it. Click a pad's key label to remap it. Use **Record to Pad** to capture mic input or your own keyboard performance straight onto a pad, and **Export Pads** to download everything as a zip.

### Branular — Granular Synthesizer
Grab tiny grains from your audio and sequence them in a step tracker, then morph them with onboard effects.
- 16-step tracker sequencer with percussion-biased random grains
- Up to 3 audio tracks, gathered and locked independently
- Scrub Mode — drag the waveform to scan and spray grains live
- Per-step Lock, FX toggle, and copy/paste between steps
- Built-in reverb and delay effects board, adjustable BPM, and record-to-file

**How to use it:** Open [`/branular`](branular/), upload or record audio (you can add up to 3 tracks total with the **+** button). Click **Select Grains** to fill the step grid with random grains, or turn on **Scrub Mode** and drag across the waveform to spray grains live. Lock steps you want to keep with **LK**, press **L** to add another row, **G** to group rows together, and **▶** to play the sequence. Press **1** to open the Effects panel and dial in reverb/delay.

### Bodular — Modular Beatbox Board
Build a modular synth-style rack out of your beatbox samples using patch cables.
- Source modules: Sample Player, LFO, Noise, Clock
- Processing modules: VCA, VCF, Delay, Attenuverter, Envelope (ADSR)
- Utility modules: Mult, Arpeggiator
- Output modules: Mixer, Output
- Visual module: Oscilloscope
- Cable-based patching with a toggleable cable view, and record-to-file

**How to use it:** Open [`/bodular`](bodular/), click **+ Add Module** and pick modules from Sources, Processing, Utility, Output, or Visuals to drop them on the rack. Upload a beatbox sample into a Sample Player module, then drag between module jacks to patch them together — patch a source into an Output module to hear sound. Press **C** (or the **Show Cables** button) to toggle cable visibility, and use **⏺** to record your patch to a file.

### Bid2Baud — Video to Audio
Convert a video of your beatbox routine into a clean MP3, fully on-device.
- Converts MP4, MOV, or WebM video into a downloadable MP3, fully on-device
- Lightweight mode: small download, decodes and encodes audio directly in the browser
- Fast mode: loads ffmpeg.wasm for quicker processing on a good connection
- Max 2 minutes per video

**How to use it:** Open [`/bid2baud`](bid2baud/), choose **Lightweight** (smaller download, good for slow connections) or **Fast** (bigger download, faster processing) under Processing, then drag in or upload your video. Preview the result and **Download MP3** once it's ready.

## Status

All tools are actively in development — you may run into glitches or rough edges. Feedback and bug reports are welcome.

## About

Beatbox Kit by [Adam Not Cheese](https://www.notcheese.lol).
