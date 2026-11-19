// Runs on the audio thread. Mixes to mono, reports RMS, and holds PCM only while
// the renderer says someone is speaking. Idle audio stays in a fixed pre-roll ring
// so the start of a word is not clipped and silence does not allocate.
const MAX_BUFFER_S = 300;
const PRE_ROLL_S = 0.4;
const LEVEL_S = 0.05;

class PcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunks = [];
    this.length = 0;
    this.pre = new Float32Array(Math.max(1, Math.round(sampleRate * PRE_ROLL_S)));
    this.prePos = 0;
    this.preFilled = 0;
    this.scratch = null;
    this.ss = 0;
    this.nn = 0;
    this.levelLeft = Math.round(sampleRate * LEVEL_S);
    this.port.onmessage = (e) => this.onMessage(e.data || {});
  }

  onMessage(msg) {
    if (msg.type === 'record') {
      this.setRecording(!!msg.on);
      return;
    }
    if (msg.type === 'take') {
      if (!this.recording) this.dumpPre();
      const all = new Float32Array(this.length);
      let o = 0;
      for (const c of this.chunks) {
        all.set(c, o);
        o += c.length;
      }
      this.chunks = [];
      this.length = 0;
      this.recording = false;
      this.port.postMessage({ id: msg.id, samples: all }, [all.buffer]);
      return;
    }
    if (msg.type === 'clear') {
      this.chunks = [];
      this.length = 0;
      this.recording = false;
    }
  }

  setRecording(on) {
    if (on && !this.recording) this.dumpPre();
    this.recording = on;
  }

  dumpPre() {
    const n = this.preFilled;
    if (!n) return;
    const out = new Float32Array(n);
    const cap = this.pre.length;
    const start = (this.prePos - n + cap) % cap;
    const first = Math.min(n, cap - start);
    out.set(this.pre.subarray(start, start + first));
    if (first < n) out.set(this.pre.subarray(0, n - first), first);
    this.chunks.push(out);
    this.length += n;
    this.preFilled = 0;
    this.prePos = 0;
  }

  writePre(src, n) {
    const pre = this.pre;
    const cap = pre.length;
    if (n >= cap) {
      pre.set(src.subarray(n - cap));
      this.prePos = 0;
      this.preFilled = cap;
      return;
    }
    const first = Math.min(n, cap - this.prePos);
    pre.set(src.subarray(0, first), this.prePos);
    if (first < n) pre.set(src.subarray(first), 0);
    this.prePos = (this.prePos + n) % cap;
    this.preFilled = Math.min(cap, this.preFilled + n);
  }

  process(inputs) {
    const chans = inputs[0];
    if (!chans || !chans[0] || !chans[0].length) return true;
    const n = chans[0].length;
    const nch = chans.length;
    if (!this.scratch || this.scratch.length < n) this.scratch = new Float32Array(n);
    const out = this.scratch;
    let ss = 0;
    if (nch === 1) {
      const d = chans[0];
      for (let i = 0; i < n; i++) {
        const s = d[i];
        out[i] = s;
        ss += s * s;
      }
    } else {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < nch; c++) s += chans[c][i];
        s /= nch;
        out[i] = s;
        ss += s * s;
      }
    }
    this.ss += ss;
    this.nn += n;
    this.levelLeft -= n;
    if (this.levelLeft <= 0) {
      this.port.postMessage({ type: 'level', rms: this.nn ? Math.sqrt(this.ss / this.nn) : 0 });
      this.ss = 0;
      this.nn = 0;
      this.levelLeft = Math.round(sampleRate * LEVEL_S);
    }
    if (this.recording) {
      const copy = new Float32Array(n);
      copy.set(out.subarray(0, n));
      this.chunks.push(copy);
      this.length += n;
      const max = sampleRate * MAX_BUFFER_S;
      while (this.chunks.length && this.length > max) this.length -= this.chunks.shift().length;
    } else {
      this.writePre(out, n);
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
