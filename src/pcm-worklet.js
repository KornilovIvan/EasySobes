// Runs on the audio thread. Mixes to mono and holds PCM until the renderer asks for it.
const MAX_BUFFER_S = 300;

class PcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'take') {
        const all = new Float32Array(this.length);
        let o = 0;
        for (const c of this.chunks) {
          all.set(c, o);
          o += c.length;
        }
        this.chunks = [];
        this.length = 0;
        this.port.postMessage({ id: msg.id, samples: all }, [all.buffer]);
        return;
      }
      if (msg.type === 'clear') {
        const keep = Math.round(sampleRate * (msg.keepS || 0));
        while (this.chunks.length && this.length - this.chunks[0].length >= keep) {
          this.length -= this.chunks.shift().length;
        }
        if (!keep) {
          this.chunks = [];
          this.length = 0;
        }
      }
    };
  }

  process(inputs) {
    const chans = inputs[0];
    if (!chans || !chans[0] || !chans[0].length) return true;
    const n = chans[0].length;
    const nch = chans.length;
    const out = new Float32Array(n);
    if (nch === 1) out.set(chans[0]);
    else {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < nch; c++) s += chans[c][i];
        out[i] = s / nch;
      }
    }
    this.chunks.push(out);
    this.length += n;
    const max = sampleRate * MAX_BUFFER_S;
    while (this.chunks.length && this.length > max) this.length -= this.chunks.shift().length;
    return true;
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
