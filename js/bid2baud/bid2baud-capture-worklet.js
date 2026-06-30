// bid2baud-capture-worklet.js — runs on the audio rendering thread, not the
// main thread. ScriptProcessorNode (the old API) calls back into main-thread
// JS for every buffer, so anything else happening on the page (even our own
// waveform redraw) could stall it and drop/garble samples — audible as pops
// and clicks that aren't in the source file. AudioWorklet processors run in
// a dedicated realtime thread and are immune to that.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.writeIdx = 0;
    this.stereo = false;
    // Main thread asks for a final flush once the video ends, since the
    // last partial buffer (< size samples) wouldn't trigger one on its own.
    this.port.onmessage = e => {
      if (e.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.writeIdx === 0) return;
    const left = this.left.slice(0, this.writeIdx);
    const transfer = [left.buffer];
    const payload = { left };
    if (this.stereo) {
      const right = this.right.slice(0, this.writeIdx);
      payload.right = right;
      transfer.push(right.buffer);
    }
    this.port.postMessage(payload, transfer);
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.writeIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const inL = input[0];
    const inR = input.length > 1 ? input[1] : null;
    this.stereo = !!inR;
    for (let i = 0; i < inL.length; i++) {
      this.left[this.writeIdx] = inL[i];
      if (inR) this.right[this.writeIdx] = inR[i];
      this.writeIdx++;
      if (this.writeIdx >= this.size) this.flush();
    }
    return true;
  }
}

registerProcessor('bid2baud-capture', CaptureProcessor);
