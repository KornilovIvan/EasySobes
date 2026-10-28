// Renderer-side audio capture. Owned by the audio workstream (Phase 2A).
// Uses shared helpers from renderer.js via window.app.
//
// Two sources at once. System audio (getDisplayMedia loopback from audio-main.js) is the
// interviewer. The microphone is the candidate. They stay separate so each line in the
// conversation log has a speaker. There is no fallback from one to the other.
// Modes:
//   ⌘⇧R  manual push-to-record (window.audio.toggleRecording)
//   ⌘⇧L  continuous listen: voice-activity detection cuts segments on silence,
//        transcribes them, and auto-answers questions. The interviewer waits 2.5s
//        so a pause inside a question stays one piece. ⌘⇧R sends that piece now.
(() => {
  const { $, run, addMessage, setStatus, escapeHtml } = window.app;
  const app = window.app;

  // VAD tuning
  const SILENCE_MS = 1200; // candidate: a short pause already ends their turn
  const INTERVIEWER_SILENCE_MS = 2500; // interviewer: a pause inside a question is not the end
  const MIN_SPEECH_MS = 400; // ignore clicks/coughs shorter than this
  const MAX_SEGMENT_MS = 30000; // force a cut on very long monologues
  const IDLE_ROTATE_MS = 10000; // start a fresh segment if nobody talks, to drop dead air
  const TICK_MS = 50;
  const MIN_THRESHOLD = 0.006; // RMS floor for "speech" (loopback silence is ~0; quiet browser voices sit near 0.01)

  // ---------- mic state broadcast ----------
  // The UI listens for window 'audio-state' events. mode: off | starting | recording | live.
  // phase: idle | speech | transcribing. level: 0..1 loudness for the meter.
  const micState = { mode: 'off', phase: 'idle', source: null, level: 0, since: 0 };
  function emit(patch) {
    Object.assign(micState, patch);
    window.dispatchEvent(new CustomEvent('audio-state', { detail: { ...micState } }));
  }

  // Scale RMS (~0.005 quiet … ~0.2 loud) into 0..1 on a log curve for a readable meter.
  const meterLevel = (r) => Math.max(0, Math.min(1, (Math.log10(Math.max(r, 1e-4)) + 2.6) / 2));

  // ---------- source selection ----------

  function getSource() {
    if (live && !live.hasMic) return 'system';
    return 'both';
  }

  // Live listen always hears both sides. The button and the settings row only report that.
  function setSource() {
    try {
      localStorage.removeItem('audioSource');
    } catch {}
    emit({ source: getSource() });
  }

  function cycleSource() {
    setSource();
    return getSource();
  }

  async function getSystemStream() {
    // Chromium requires video for getDisplayMedia; audio-main grants it and we drop it.
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    display.getVideoTracks().forEach((t) => {
      t.stop();
      display.removeTrack(t);
    });
    if (!display.getAudioTracks().length) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error('no system audio track was provided');
    }
    return new MediaStream(display.getAudioTracks());
  }

  // Returns { stream, source, stop() } for system audio. Never falls back to the mic.
  async function openSource(quiet = false) {
    let system;
    try {
      system = await getSystemStream();
    } catch (err) {
      if (!quiet) addMessage('error', escapeHtml(
        `System audio capture failed (${err.message || err.name}). ` +
        'On macOS, allow the app that starts EasySobes (Terminal or VS Code) under System Settings → Privacy & Security → Screen & System Audio Recording.'
      ));
      throw new Error('system audio unavailable');
    }
    const stop = () => system.getTracks().forEach((t) => t.stop());
    return { stream: system, source: 'system', stop };
  }

  // ---------- shared answer flow ----------

  function answer(transcript, role) {
    const label = `${role === 'me' ? '🎤' : '🎧'} ${transcript}`;
    const text = dialogueText(role);
    return run(label, () => window.sobes.ask({ text, dialogue: true, label }));
  }

  // ---------- manual push-to-record (⌘⇧R) ----------

  // ---------- raw PCM capture (no MediaRecorder) ----------
  // MediaRecorder on the macOS loopback track keeps failing on the owner's Mac
  // ("There was an error starting the MediaRecorder"), so we never use it. Web Audio
  // collects the samples and each segment goes to Whisper as a 16 kHz mono WAV.

  const MAX_BUFFER_S = 300; // hard cap on buffered audio (manual recording)

  function pcmTap(ctx, stream) {
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // the node only runs while connected to the output; keep it silent
    let chunks = [];
    let length = 0;
    node.onaudioprocess = (e) => {
      const input = e.inputBuffer;
      const out = new Float32Array(input.length);
      for (let c = 0; c < input.numberOfChannels; c++) {
        const d = input.getChannelData(c);
        for (let i = 0; i < d.length; i++) out[i] += d[i] / input.numberOfChannels;
      }
      chunks.push(out);
      length += out.length;
      while (length > ctx.sampleRate * MAX_BUFFER_S) length -= chunks.shift().length;
    };
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    return {
      src,
      seconds: () => length / ctx.sampleRate,
      take() {
        const all = new Float32Array(length);
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.length;
        }
        chunks = [];
        length = 0;
        return all;
      },
      // Drop old audio but keep the last `keepS` seconds, so a word that starts
      // right at a segment boundary isn't clipped.
      clear(keepS = 0) {
        const keep = Math.round(ctx.sampleRate * keepS);
        while (chunks.length && length - chunks[0].length >= keep) length -= chunks.shift().length;
        if (!keep) {
          chunks = [];
          length = 0;
        }
      },
      stop() {
        node.onaudioprocess = null;
        src.disconnect();
        node.disconnect();
        mute.disconnect();
      },
    };
  }

  function toWav(samples, rate) {
    const TARGET = 16000;
    const ratio = rate / TARGET;
    const n = Math.floor(samples.length / ratio);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, t) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, TARGET, true);
    v.setUint32(28, TARGET * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      // Average each window: a cheap low-pass so downsampling doesn't alias.
      const a = Math.floor(i * ratio);
      const b = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < b; j++) sum += samples[j];
      const x = Math.max(-1, Math.min(1, sum / (b - a || 1)));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return buf;
  }

  // ---------- manual push-to-record (⌘⇧R) ----------

  let manual = null; // { capture, ctx, tap, timer } while manually recording

  async function transcribeAndAnswer(buffer) {
    emit({ mode: 'off', phase: 'transcribing', level: 0, source: getSource() });
    try {
      const transcript = ((await window.sobes.transcribe(buffer)) || '').trim();
      emit({ phase: 'idle' });
      if (!transcript) return setStatus('No speech detected');
      remember('interviewer', transcript);
      answer(transcript, 'interviewer');
    } catch (err) {
      emit({ phase: 'idle' });
      addMessage('error', escapeHtml(err.message));
      setStatus('');
    }
  }

  function stopManual() {
    const m = manual;
    manual = null;
    clearInterval(m.timer);
    const samples = m.tap.take();
    m.tap.stop();
    m.ctx.close().catch(() => {});
    m.capture.stop();
    if (samples.length < m.ctx.sampleRate * 0.3) {
      emit({ mode: 'off', phase: 'idle', level: 0, source: getSource() });
      return setStatus('Nothing recorded');
    }
    transcribeAndAnswer(toWav(samples, m.ctx.sampleRate));
  }

  async function toggleRecording() {
    if (live) {
      // In live mode ⌘⇧R means "answer what the interviewer just said, now".
      const ear = live.ears.find((e) => e.role === 'interviewer') || live.ears[0];
      if (ear) {
        ear.forceCut = true;
        cutEar(ear);
      }
      return;
    }
    if (manual) return stopManual();
    if (app.isBusy() || micState.mode === 'starting') return;
    emit({ mode: 'starting', level: 0 });
    let capture;
    try {
      capture = await openSource();
    } catch {
      emit({ mode: 'off', level: 0, source: getSource() });
      return;
    }
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const tap = pcmTap(ctx, capture.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    tap.src.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const r = Math.sqrt(sum / data.length);
      emit({ level: meterLevel(r), phase: r > MIN_THRESHOLD ? 'speech' : 'idle' });
    }, 80);
    manual = { capture, ctx, tap, timer };
    emit({ mode: 'recording', phase: 'idle', source: getSource(), since: Date.now() });
  }

  // ---------- conversation memory ----------
  // Both sides are kept for this sitting. Clear (⌘⇧K) drops it. Older turns are
  // compressed so a long interview still fits in the free-tier token budget.

  // The last 10 lines go with every answer. Anything older is folded into a short summary.
  const KEEP_RAW = 10;
  const SUMMARIZE_AT = 10;
  const conversation = { turns: [], summary: '' };
  let generation = 0;
  let summarizing = false;
  let summaryFailedAt = 0;

  function clearConversation() {
    generation++;
    conversation.turns = [];
    conversation.summary = '';
    summarizing = false;
    publishMemory();
  }

  function getMemory() {
    return {
      turns: conversation.turns.map((t) => ({ role: t.role, text: t.text })),
      summary: conversation.summary,
    };
  }

  // Switching chats replaces the live memory. A summary still in flight belongs to the previous chat.
  function setMemory(mem) {
    generation++;
    summarizing = false;
    conversation.turns = Array.isArray(mem?.turns)
      ? mem.turns.map((t) => ({ role: t.role === 'me' ? 'me' : 'interviewer', text: String(t.text || '') }))
      : [];
    conversation.summary = String(mem?.summary || '');
  }

  function publishMemory() {
    try {
      window.app?.onMemoryChanged?.();
    } catch {}
  }

  function remember(role, text) {
    const line = String(text || '').trim();
    if (!line) return;
    const last = conversation.turns[conversation.turns.length - 1];
    if (last && last.role === role && last.text === line) return;
    conversation.turns.push({ role, text: line });
    publishMemory();
    maybeSummarize();
  }

  function clip(text) {
    return text.length > 700 ? `${text.slice(0, 700)}…` : text;
  }

  function turnsForModel() {
    const from = conversation.turns.length > KEEP_RAW ? conversation.turns.length - KEEP_RAW : 0;
    return conversation.turns.slice(from).map((t) => ({ role: t.role, text: clip(t.text) }));
  }

  function who(role) {
    return role === 'me' ? 'Candidate' : 'Interviewer';
  }

  function contextBlock() {
    let body = '';
    try {
      body = String(window.app?.chatContext?.() || '').trim();
    } catch {}
    if (!body) return '';
    let max = 16000;
    try {
      const n = Number(window.app?.contextLimit?.());
      if (Number.isFinite(n) && n >= 500) max = n;
    } catch {}
    if (body.length > max) body = body.slice(0, max);
    return (
      'Background the candidate added for this chat:\n' +
      body +
      '\n\nRely on this background in every answer. Do not contradict it.'
    );
  }

  function dialogueText(role) {
    const lines = [];
    const context = contextBlock();
    if (context) lines.push(context);
    if (conversation.summary) lines.push(`Earlier in this interview:\n${conversation.summary}`);
    const turns = turnsForModel();
    if (turns.length) {
      lines.push('Conversation:');
      for (const t of turns) lines.push(`${who(t.role)}: ${t.text}`);
    }
    if (role === 'me') {
      lines.push(
        '',
        'The candidate just asked a clarifying question (the last Candidate line). ' +
          'Give one or two spoken sentences they can say now: a clearer version of their question if the interviewer was ambiguous, ' +
          'otherwise the answer they should give. Stay consistent with what the candidate already said.'
      );
    } else {
      lines.push(
        '',
        'The interviewer just spoke (the last Interviewer line). Give the answer the candidate should say next. ' +
          'If they asked for code, add it after one or two spoken sentences. ' +
          'Stay consistent with what the candidate already said, and do not repeat it.'
      );
    }
    return lines.join('\n');
  }

  // For typed questions and screen asks: the transcript without a "who just spoke" instruction.
  function dialoguePrefix() {
    const lines = [];
    const context = contextBlock();
    if (context) lines.push(context);
    if (conversation.summary) lines.push(`Earlier in this interview:\n${conversation.summary}`);
    const turns = turnsForModel();
    if (!context && !conversation.summary && !turns.length) return '';
    if (turns.length) {
      lines.push('Conversation so far:');
      for (const t of turns) lines.push(`${who(t.role)}: ${t.text}`);
    }
    lines.push('', 'Use this conversation when you answer. Do not contradict the candidate or repeat what they already said.');
    return lines.join('\n');
  }

  function maybeSummarize() {
    if (summarizing || Date.now() - summaryFailedAt < 60000) return;
    if (conversation.turns.length <= SUMMARIZE_AT) return;
    const end = conversation.turns.length - KEEP_RAW;
    if (end <= 0) return;
    const slice = conversation.turns.slice(0, end).map((t) => ({ role: t.role, text: clip(t.text) }));
    const prior = conversation.summary;
    const gen = generation;
    summarizing = true;
    window.sobes
      .invoke('summarize-turns', { summary: prior, turns: slice })
      .then((summary) => {
        if (gen !== generation) return;
        const text = String(summary || '').trim();
        if (!text) throw new Error('empty summary');
        conversation.summary = text;
        conversation.turns.splice(0, end);
        publishMemory();
      })
      .catch((err) => {
        summaryFailedAt = Date.now();
        diag(`summary failed: ${err && err.message ? err.message : err}`);
      })
      .finally(() => {
        summarizing = false;
      });
  }

  function normalize(s) {
    return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  // The mic often hears the interviewer through speakers. Drop that copy.
  function isEcho(role, text) {
    if (role !== 'me') return false;
    const n = normalize(text);
    if (n.length < 8) return false;
    return conversation.turns.slice(-4).some((t) => {
      if (t.role !== 'interviewer') return false;
      const o = normalize(t.text);
      if (!o) return false;
      if (o === n) return true;
      const shorter = o.length < n.length ? o : n;
      const longer = o.length < n.length ? n : o;
      return shorter.length > 24 && longer.includes(shorter);
    });
  }

  // ---------- continuous listen mode (⌘⇧L) ----------

  let live = null; // { ctx, ears, system, micStream, hasMic, timer } while live mode is on
  let starting = false;
  const segmentQueue = [];
  let processing = false;
  let transcribing = false;

  // wantLive = the user turned Live on (the button or ⌘⇧L). While it is true,
  // any capture failure reconnects on its own instead of turning live off,
  // because the owner can't press anything during an interview.
  let wantLive = false;
  let retries = 0;
  let retryTimer = null;
  let micWarned = false;
  const RETRY_MS = [500, 1000, 2000, 4000, 8000]; // then every 8s, forever

  function recover(why) {
    if (!wantLive) return;
    stopLive(true);
    clearTimeout(retryTimer);
    const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
    retries++;
    window.sobes.send?.('log', `live: reconnecting (${why}), attempt ${retries}`);
    emit({ mode: 'starting', level: 0 });
    retryTimer = setTimeout(() => startLive(true), wait);
  }

  async function openMic() {
    const allowed = await window.sobes.invoke('ensure-mic');
    if (!allowed) throw new Error('permission denied');
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
  }

  function makeEar(role, stream, ctx) {
    const tap = pcmTap(ctx, stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    tap.src.connect(analyser);
    return {
      role,
      tap,
      analyser,
      data: new Float32Array(analyser.fftSize),
      rate: ctx.sampleRate,
      noise: 0.005,
      recStart: 0,
      speechMs: 0,
      speaking: false,
      lastVoice: 0,
      forceCut: false,
      peak: 0,
    };
  }

  async function startLive(quiet = false) {
    if (live || starting) return;
    wantLive = true;
    if (manual) stopManual();
    starting = true;
    emit({ mode: 'starting', level: 0, source: 'both' });
    let system;
    try {
      system = await openSource(quiet);
    } catch {
      starting = false;
      recover('no system audio');
      return;
    }
    starting = false;
    if (!wantLive) return system.stop();

    let micStream = null;
    try {
      micStream = await openMic();
    } catch (err) {
      diag(`mic unavailable: ${err.message || err}`);
      if (!quiet && !micWarned) {
        micWarned = true;
        addMessage('error', escapeHtml(
          'Your microphone is off, so your own answers are not in the conversation. ' +
          'Allow the microphone for the app that starts EasySobes (Terminal or VS Code) under System Settings → Privacy & Security → Microphone, then turn Live off and on.'
        ));
      }
    }
    if (!wantLive) {
      system.stop();
      micStream?.getTracks().forEach((t) => t.stop());
      return;
    }

    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const ears = [makeEar('interviewer', system.stream, ctx)];
    if (micStream) ears.push(makeEar('me', micStream, ctx));
    const l = { ctx, ears, system, micStream, hasMic: !!micStream, timer: null };
    live = l;
    system.stream.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => {
        if (live === l) recover('audio track ended');
      })
    );
    if (micStream) {
      micStream.getAudioTracks().forEach((t) =>
        t.addEventListener('ended', () => {
          if (live !== l) return;
          const ear = l.ears.find((e) => e.role === 'me');
          if (ear) ear.tap.stop();
          l.ears = l.ears.filter((e) => e.role !== 'me');
          l.hasMic = false;
          emit({ source: 'system' });
          addMessage('error', escapeHtml(
            'Microphone stopped. The interviewer is still heard; your voice is no longer added to the conversation.'
          ));
        })
      );
    }
    ears.forEach(newSegment);
    l.timer = setInterval(tick, TICK_MS);
    if (retries) window.sobes.send?.('log', 'live: reconnected');
    retries = 0;
    emit({
      mode: 'live',
      phase: transcribing ? 'transcribing' : 'idle',
      source: l.hasMic ? 'both' : 'system',
      since: Date.now(),
    });
  }

  function stopLive(reconnecting = false) {
    if (!reconnecting) {
      wantLive = false;
      clearTimeout(retryTimer);
      retries = 0;
      micWarned = false;
    }
    if (!live) {
      if (!reconnecting) emit({ mode: 'off', level: 0, source: 'both' });
      return;
    }
    const l = live;
    live = null;
    clearInterval(l.timer);
    l.ears.forEach((e) => e.tap.stop());
    l.ctx.close().catch(() => {});
    l.system.stop();
    l.micStream?.getTracks().forEach((t) => t.stop());
    if (reconnecting) return;
    emit({ mode: 'off', phase: transcribing ? 'transcribing' : 'idle', level: 0, source: 'both' });
  }

  function toggleLive() {
    if (starting) return;
    if (live || wantLive) stopLive();
    else startLive();
  }

  // Live-mode diagnostics in userData/easysobes.log, so "it heard nothing" can be told
  // apart from "it heard it but chose not to answer".
  const diag = (msg) => window.sobes.send?.('log', `live: ${msg}`);

  function newSegment(ear) {
    ear.peak = 0;
    ear.recStart = performance.now();
    ear.speechMs = 0;
    ear.speaking = false;
  }

  function earRms(ear) {
    ear.analyser.getFloatTimeDomainData(ear.data);
    let sum = 0;
    for (let i = 0; i < ear.data.length; i++) sum += ear.data[i] * ear.data[i];
    return Math.sqrt(sum / ear.data.length);
  }

  // Hand this speaker's current segment off (if someone spoke) and start the next one.
  function cutEar(ear) {
    if (!live || !live.ears.includes(ear)) return;
    const hadSpeech = ear.speechMs >= MIN_SPEECH_MS;
    const force = ear.forceCut;
    ear.forceCut = false;
    const secs = ((performance.now() - ear.recStart) / 1000).toFixed(1);
    if (ear.peak > 0.002 || hadSpeech || force) {
      diag(
        `${ear.role} segment ${secs}s speech=${ear.speechMs}ms peak=${ear.peak.toFixed(3)} → ${
          hadSpeech || force ? 'sent to Whisper' : 'dropped (too little speech)'
        }`
      );
    }
    if (hadSpeech || force) {
      const samples = ear.tap.take();
      if (samples.length >= ear.rate * 0.3) enqueue({ buffer: toWav(samples, ear.rate), role: ear.role, force });
    } else {
      ear.tap.clear(0.5);
    }
    newSegment(ear);
  }

  function tick() {
    const l = live;
    if (!l) return;
    const now = performance.now();
    let loud = 0;
    let anyVoice = false;
    for (const ear of l.ears) {
      const level = earRms(ear);
      if (level > loud) loud = level;
      if (level > ear.peak) ear.peak = level;
      const threshold = Math.max(MIN_THRESHOLD, ear.noise * 3);
      const voiced = level > threshold;
      if (voiced || ear.speaking) anyVoice = true;
      if (voiced) {
        ear.lastVoice = now;
        ear.speechMs += TICK_MS;
        if (!ear.speaking && ear.speechMs >= MIN_SPEECH_MS) ear.speaking = true;
      } else {
        ear.noise = level < ear.noise ? level : ear.noise * 0.995 + level * 0.005;
      }
      const segAge = now - ear.recStart;
      const silenceMs = ear.role === 'interviewer' ? INTERVIEWER_SILENCE_MS : SILENCE_MS;
      if (ear.speaking && now - ear.lastVoice >= silenceMs) cutEar(ear);
      else if (segAge >= MAX_SEGMENT_MS && ear.speechMs > 0) cutEar(ear);
      else if (!ear.speaking && segAge >= IDLE_ROTATE_MS && now - ear.lastVoice >= silenceMs) cutEar(ear);
    }
    const phase = transcribing ? 'transcribing' : anyVoice ? 'speech' : 'idle';
    l.ticks = (l.ticks || 0) + 1;
    if (l.ticks % 2 === 0 || phase !== micState.phase) emit({ level: meterLevel(loud), phase });
  }

  // ---------- segment queue ----------
  // Whisper runs one phrase at a time, in order. It does not wait while a suggestion
  // prints: that work happens alongside, and the next question starts its own suggestion.
  // The cap only matters if recognition itself falls behind.

  function enqueue(item) {
    segmentQueue.push(item);
    if (segmentQueue.length > 40) {
      segmentQueue.shift();
      diag('queue overflow, dropped oldest segment');
    }
    pump();
  }

  function showTranscript(role, text) {
    if (role === 'me') {
      const words = text.trim().split(/\s+/).filter(Boolean);
      if (words.length < 4 && !candidateQuestion(text)) return;
    }
    addMessage('user', escapeHtml(`${role === 'me' ? '🎤' : '🎧'} ${text}`));
  }

  function cleanErr(err) {
    return String(err && err.message ? err.message : err).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      ''
    );
  }

  async function pump() {
    if (processing) return;
    processing = true;
    let deferred = null;
    const showDeferred = () => {
      if (!deferred) return;
      showTranscript(deferred.role, deferred.transcript);
      deferred = null;
    };
    try {
      while (segmentQueue.length) {
        const item = segmentQueue.shift();
        transcribing = true;
        emit({ phase: 'transcribing' });
        let transcript = '';
        try {
          transcript = ((await window.sobes.transcribe(item.buffer)) || '').trim();
        } catch (err) {
          addMessage('error', escapeHtml(cleanErr(err)));
          continue;
        } finally {
          transcribing = false;
        }
        const action = classify(item.role, transcript, item.force);
        diag(`${item.role} "${transcript.slice(0, 180)}" → ${action}`);
        if (action === 'drop') continue;
        remember(item.role, transcript);
        // The interviewer's question still gets a suggestion when your line is already
        // queued. Your words stay in the log and are part of that suggestion.
        if (action === 'answer' && item.role === 'interviewer') {
          if (deferred) showTranscript(deferred.role, deferred.transcript);
          deferred = { role: item.role, transcript };
        } else if (deferred && deferred.role === 'interviewer') {
          showTranscript(item.role, transcript);
        } else if (action === 'answer') {
          showDeferred();
          deferred = { role: item.role, transcript };
        } else {
          showDeferred();
          showTranscript(item.role, transcript);
        }
      }
      // The suggestion prints on its own. Recognition is free to take the next phrase,
      // and a later question becomes the next suggestion instead of waiting in a pile.
      if (deferred) {
        const pending = deferred;
        deferred = null;
        answer(pending.transcript, pending.role);
      }
    } finally {
      transcribing = false;
      processing = false;
      if (micState.phase === 'transcribing') emit({ phase: 'idle' });
      if (segmentQueue.length) pump();
    }
  }

  // Whisper often "hears" these in silence or music. A short "yes" from the candidate
  // is a real answer, so the mic channel only drops the obvious hallucinations.
  const HALLUCINATION =
    /^(thank you|thanks( for watching)?|bye|♪+|субтитры.*|редактор субтитров.*|продолжение следует|धन्यवाद|शुक्रिया|dhanyavaad|shukriya)[.!?।…\s]*$/i;
  const NOISE =
    /^(thank you|thanks( for watching)?|you|bye|okay|ok|ок|uh+|um+|hmm+|\.+|♪+|धन्यवाद|शुक्रिया|dhanyavaad|shukriya|ji|haan|спасибо( за просмотр)?|субтитры.*|редактор субтитров.*|продолжение следует|угу|ага|эм+|мм+)[.!?।…\s]*$/i;
  function isNoise(t, role) {
    const s = t.trim();
    if (!s) return true;
    if (HALLUCINATION.test(s)) return true;
    if (role === 'me') return false;
    return NOISE.test(s);
  }

  const PROMPT_START =
    /^(what|why|how|when|where|who|which|whose|can|could|would|will|should|do|does|did|is|are|was|were|have|has|tell|explain|describe|walk|give|write|implement|design|compare|talk|share|define|list|name|solve|build|show|imagine|suppose|let's|lets|so,? (what|how|why|tell|can))\b/i;
  // Interview asks that don't start with a question word ("Great. Now please introduce
  // yourself", "Okay, so walk me through your project").
  const ASKS =
    /\b(tell (me|us)|introduce yourself|describe|explain|walk (me|us) through|what|why|how|which|can you|could you|would you|do you|did you|have you|are you|share|give (me|us)|talk (about|me)|your (experience|projects?|strengths?|weakness(es)?|role|background|skills|goals?))\b/i;
  // Hindi / Hinglish asks, in Roman and Devanagari script ("aap apne baare mein batao",
  // "आपका प्रोजेक्ट क्या था", "kya aap explain kar sakte ho").
  const HINDI_ASKS =
    /(^|[\s,.])(kya|kyu|kyun|kyon|kaise|kaisa|kaisi|kab|kahan|kaha|kaun|kon|kitna|kitne|kitni|konsa|kaunsa|batao|bataiye|bataye|samjhao|samjhaiye|sunao|dikhao|likho|baare mein|bare me|sakte ho|sakti ho|sakte hain|kijiye|kariye|karo|क्या|क्यों|कैसे|कैसा|कब|कहाँ|कहां|कौन|कितना|कितने|कौनसा|बताइए|बताइये|बताओ|बताएं|समझाइए|समझाओ|सुनाइए|बारे में|सकते हैं|सकते हो|कीजिए)(?=$|[\s,.?!।])/i;
  // \b does not see Cyrillic, so Russian words are matched as whole tokens the same way Hindi is.
  const RU_ASKS =
    /(^|[\s,.(])(что|почему|зачем|как|какой|какая|какое|какие|когда|где|куда|откуда|кто|кого|сколько|чем|чего|расскажите|расскажи|объясните|объясни|опишите|опиши|представьтесь|назовите|скажите|уточните|уточни)(?=$|[\s,.?!…:;])/i;
  // A candidate's own answer often contains "как" or "что" in the middle. Only treat it as
  // a clarifying question when it is marked as one, or when it starts like one.
  const CANDIDATE_Q =
    /^(what|why|how|when|where|who|which|can|could|would|do|does|did|is|are|tell|explain|describe|clarify|что|почему|зачем|как|какой|какая|какое|какие|когда|где|куда|кто|сколько|расскажите|расскажи|объясните|объясни|уточните|уточни|можно|kya|kyu|kyun|kaise|batao|bataiye)(?=$|[\s,.?!…:;])/i;
  function looksLikeQuestion(t) {
    if (!t || !t.trim()) return false;
    const text = t.trim();
    if (/[?؟]/.test(text)) return true;
    return PROMPT_START.test(text) || ASKS.test(text) || HINDI_ASKS.test(text) || RU_ASKS.test(text);
  }
  function candidateQuestion(text) {
    const line = String(text || '').trim();
    if (!line) return false;
    if (/[?؟]/.test(line) || CANDIDATE_Q.test(line)) return true;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length > 14) return false;
    return /(уточн|поясн|имеете в виду|what do you mean|could you clarify|can you clarify|can you repeat|не расслышал)/i.test(line);
  }
  function looksLikePrompt(t) {
    if (isNoise(t, 'interviewer')) return false;
    if (looksLikeQuestion(t)) return true;
    const words = t.trim().split(/\s+/).filter(Boolean);
    return words.length >= 10; // long statements from the interviewer are usually prompts
  }

  function classify(role, transcript, force) {
    const text = String(transcript || '').trim();
    if (!text) return 'drop';
    if (isEcho(role, text)) return 'drop';
    if (force && role === 'interviewer') return isNoise(text, role) ? 'drop' : 'answer';
    if (isNoise(text, role)) return 'drop';
    if (role === 'me') return candidateQuestion(text) ? 'answer' : 'note';
    return looksLikePrompt(text) ? 'answer' : 'note';
  }

  window.sobes.on('audio-toggle-live', toggleLive);

  micState.source = getSource();

  window.audio = {
    toggleRecording,
    toggleLive,
    isLive: () => !!live,
    getState: () => ({ ...micState }),
    cycleSource,
    getSource,
    setSource,
    clearConversation,
    getMemory,
    setMemory,
    dialoguePrefix,
  };
})();
