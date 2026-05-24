// AudioWorklet that converts incoming Float32 mic samples to Int16 PCM and
// batches them into ~100ms chunks before posting back to the main thread.
// Runs inside an AudioContext created at 24kHz, so no resampling needed here.

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(2400); // 100ms at 24kHz
    this.idx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0]; // mono — first channel only
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.idx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.idx === this.buf.length) {
        const out = new Int16Array(this.buf);
        this.port.postMessage(out.buffer, [out.buffer]);
        this.idx = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
