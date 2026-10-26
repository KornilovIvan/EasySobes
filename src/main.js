const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  screen,
  dialog,
  nativeImage,
  systemPreferences,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { systemPrompt } = require('./prompts');
const setupAudio = require('./audio-main');
const setupStealth = require('./stealth');
const { readResume, EXTENSIONS } = require('./resume');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  // Older builds stored one URL and one key for everything. Those two fields remain the
  // fallback when a channel below is still empty.
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  // Speech, text and images can each use a different OpenAI-compatible server.
  speechBaseUrl: '',
  speechApiKey: '',
  textBaseUrl: '',
  textApiKey: '',
  visionBaseUrl: '',
  visionApiKey: '',
  // Text answers use the strongest public Groq model. Screen questions stay on Qwen:
  // it is the public model that accepts images. Speech picks a Whisper size in transcribe().
  chatModel: 'openai/gpt-oss-120b',
  visionModel: 'qwen/qwen3.8-27b',
  sttModel: 'whisper-large-v3-turbo',
  context: '',
  contextLimit: 16000,
  language: 'auto', // auto | en | ru | hi | hinglish — what the other people speak
};

// Earlier builds stored this as the chat model. Text now goes to gpt-oss; vision stays on Qwen.
const PREVIOUS_CHAT_MODEL = 'qwen/qwen3.8-27b';

function contextLimitOf(settings) {
  const n = Math.round(Number(settings && settings.contextLimit));
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.contextLimit;
  return Math.min(4000000, Math.max(500, n));
}

function isGroqUrl(url) {
  return /api\.groq\.com/i.test(String(url || ''));
}

// An empty channel inherits the old shared URL and key, so existing setups keep working.
function fillEndpoints(merged) {
  const url = String(merged.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/$/, '');
  const key = String(merged.apiKey || '');
  for (const kind of ['speech', 'text', 'vision']) {
    const urlKey = `${kind}BaseUrl`;
    const keyKey = `${kind}ApiKey`;
    if (!String(merged[urlKey] || '').trim()) merged[urlKey] = url;
    if (!String(merged[keyKey] || '').trim()) merged[keyKey] = key;
    merged[urlKey] = String(merged[urlKey]).replace(/\/$/, '');
  }
  return merged;
}

function endpoint(settings, kind) {
  const url = String(settings[`${kind}BaseUrl`] || '').replace(/\/$/, '');
  const key = String(settings[`${kind}ApiKey`] || '');
  return { url, key, groq: isGroqUrl(url) };
}

let win;

// One EasySobes at a time: two copies fight over the system-audio capture.
if (!app.requestSingleInstanceLock()) {
  app.exit(0); // immediately, before any window or hotkey is created
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });
}
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const merged = fillEndpoints({ ...DEFAULT_SETTINGS, ...saved });
    let dirty = false;
    // One-time move off the old stock chat model. chatUpgraded lets a later manual edit stick.
    if (isGroqUrl(merged.textBaseUrl) && !saved.chatUpgraded && saved.chatModel === PREVIOUS_CHAT_MODEL) {
      merged.chatModel = DEFAULT_SETTINGS.chatModel;
      merged.chatUpgraded = true;
      dirty = true;
    }
    // Chats and the shrink-to-bar height are gone.
    if (merged.sessions || merged.activeSessionId || merged.expandedHeight != null) {
      delete merged.sessions;
      delete merged.activeSessionId;
      delete merged.expandedHeight;
      dirty = true;
    }
    merged.contextLimit = contextLimitOf(merged);
    if (dirty) {
      try {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        const tmp = `${SETTINGS_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
        fs.renameSync(tmp, SETTINGS_FILE);
      } catch {}
    }
    return merged;
  } catch {
    return fillEndpoints({ ...DEFAULT_SETTINGS });
  }
}

// Always merges into the file on disk: a partial patch can never drop other keys (e.g. the API key).
function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch };
  merged.contextLimit = contextLimitOf(merged);
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE); // atomic: a crash mid-write can't truncate settings
  return merged;
}

function logLine(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'easysobes.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 780,
    height: 460,
    x: width - 800,
    y: 40,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The key part: excludes this window from screenshots and screen sharing
  // (NSWindowSharingNone on macOS, WDA_EXCLUDEFROMCAPTURE on Windows).
  // Diagnostics: renderer errors and failures land in userData/easysobes.log for debugging.
  const LOG = path.join(app.getPath('userData'), 'easysobes.log');
  const log = (...parts) => {
    try {
      fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
    } catch {}
  };
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log(`console.${e.level}:`, e.message);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone:', JSON.stringify(d)));
  process.on('uncaughtException', (err) => log('main uncaught:', err.stack || err.message));
  ipcMain.on('log', (_e, msg) => log('renderer:', msg));
  log('--- started ---');

  win.setContentProtection(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function moveWindow(dx, dy) {
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

// ---------- Screen capture (ONLY on an explicit ask: ⌘⇧Return or the 🖥 button) ----------
// Nothing here runs on a timer or from live listening. The image lives only in memory for
// the one request and is never written into history, settings or the log.

// One desktopCapturer.getSources() at a time. The live-audio handler (audio-main.js) and
// the stealth self-test also call it; overlapping calls can fail with "Failed to get sources."
let captureChain = Promise.resolve();
function getScreenSources(opts) {
  const run = async () => {
    try {
      return await desktopCapturer.getSources(opts);
    } catch (err) {
      await new Promise((r) => setTimeout(r, 400)); // transient ScreenCaptureKit failure: try once more
      return desktopCapturer.getSources(opts);
    }
  };
  const p = captureChain.then(run, run);
  captureChain = p.catch(() => {});
  return p;
}

// Which app macOS asks about: when started with `npm start` it is the terminal, not EasySobes.
function captureAppName() {
  if (app.isPackaged) return 'EasySobes';
  const t = process.env.TERM_PROGRAM || '';
  if (/vscode/i.test(t)) return 'Visual Studio Code';
  if (/Apple_Terminal/i.test(t)) return 'Terminal';
  if (/iTerm/i.test(t)) return 'iTerm';
  if (t) return t;
  return 'the app you started EasySobes from (Terminal, VS Code…)';
}

function screenPermissionError() {
  const who = captureAppName();
  return new Error(
    `EasySobes can't see your screen yet. Open System Settings → Privacy & Security → ` +
      `Screen & System Audio Recording, turn on "${who}", then quit EasySobes (⌘⇧Q) and open it again.`
  );
}

function screenPermission() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

// Last resort on macOS: the built-in screencapture tool into a private temp file, deleted at once.
// It honours content protection, so the EasySobes window is left out here too.
function captureWithScreencaptureTool() {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easysobes-'));
    const file = path.join(dir, 'screen.jpg');
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    execFile('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', file], { timeout: 10000 }, (err) => {
      try {
        if (err) throw err;
        const img = nativeImage.createFromBuffer(fs.readFileSync(file));
        if (img.isEmpty()) throw new Error('screencapture returned an empty image');
        resolve(img);
      } catch (e) {
        reject(e);
      } finally {
        cleanup();
      }
    });
  });
}

// Groq shrinks every image to a fixed pixel budget, so on a busy screen the question becomes
// tiny text. Cropping to the window the user is working in gives the question more detail
// (and costs fewer tokens: ~1.4k instead of ~2.5k for a typical browser window).
const SCREEN_MAX = 1600; // longest side sent to the API
const CAPTURE_MAX = 2560; // longest side captured, so a crop keeps enough detail

// macOS: bounds (in screen points) of the frontmost normal window that isn't EasySobes.
// CGWindowListCopyWindowInfo lists on-screen windows front to back, and reading bounds
// needs no Accessibility permission.
const FRONT_WINDOW_JXA = `
ObjC.import('CoreGraphics');
const pid = Number($.NSProcessInfo.processInfo.environment.objectForKey('SOBES_PID').js);
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
const w = list.find((w) => w.kCGWindowLayer === 0 && w.kCGWindowAlpha > 0 && w.kCGWindowOwnerPID !== pid &&
  w.kCGWindowBounds.Width >= 300 && w.kCGWindowBounds.Height >= 200);
JSON.stringify(w ? { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width,
  height: w.kCGWindowBounds.Height, app: w.kCGWindowOwnerName } : null);`;

function frontWindowBounds() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', FRONT_WINDOW_JXA],
      { timeout: 2000, env: { ...process.env, SOBES_PID: String(process.pid) } },
      (err, out) => {
        try {
          resolve(err ? null : JSON.parse(out));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Crop img (a capture of `display`) to the front window. Small windows (a Zoom thumbnail,
// a mini player) are not worth trusting, so they keep the whole screen.
function cropToWindow(img, display, win) {
  if (!win) return null;
  const d = display.bounds;
  const x0 = Math.max(win.x, d.x);
  const y0 = Math.max(win.y, d.y);
  const x1 = Math.min(win.x + win.width, d.x + d.width);
  const y1 = Math.min(win.y + win.height, d.y + d.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const share = ((x1 - x0) * (y1 - y0)) / (d.width * d.height);
  if (share < 0.2 || share > 0.95) return null;
  const { width, height } = img.getSize();
  const sx = width / d.width;
  const sy = height / d.height;
  const rect = {
    x: Math.round((x0 - d.x) * sx),
    y: Math.round((y0 - d.y) * sy),
    width: Math.round((x1 - x0) * sx),
    height: Math.round((y1 - y0) * sy),
  };
  rect.width = Math.min(rect.width, width - rect.x);
  rect.height = Math.min(rect.height, height - rect.y);
  return img.crop(rect);
}

async function captureScreen() {
  const permission = screenPermission();
  if (permission === 'denied' || permission === 'restricted') throw screenPermissionError();

  // The display the user is working on (where the mouse is), not always the primary one.
  let display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const frontWindow = frontWindowBounds(); // runs while the screen is captured
  let img = null;
  let firstError = null;
  try {
    // Ask for the size we need directly: a full-size Retina thumbnail can be ~5k×3k and slow to make.
    const pixels = Math.min(CAPTURE_MAX, Math.max(display.size.width, display.size.height) * display.scaleFactor);
    const sources = await getScreenSources({
      types: ['screen'],
      thumbnailSize: { width: pixels, height: pixels },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (source && !source.thumbnail.isEmpty()) img = source.thumbnail;
  } catch (err) {
    firstError = err;
  }
  if (!img && process.platform === 'darwin') {
    try {
      img = await captureWithScreencaptureTool();
      display = screen.getPrimaryDisplay(); // screencapture -m takes the main display
      logLine(`screen: desktopCapturer failed (${firstError ? firstError.message : 'no source'}), used screencapture`);
    } catch (err) {
      logLine(`screen: capture failed: ${firstError ? firstError.message : 'no source'} / ${err.message}`);
    }
  }
  if (!img) {
    if (screenPermission() !== 'granted') throw screenPermissionError();
    throw new Error(
      "Couldn't capture the screen just now. Try again in a moment. If it keeps failing, quit EasySobes (⌘⇧Q) and open it again."
    );
  }
  const win = await frontWindow;
  const cropped = cropToWindow(img, display, win);
  if (cropped && !cropped.isEmpty()) img = cropped;
  logLine(`screen: ${cropped ? `cropped to ${win.app} window` : 'whole screen'} ${img.getSize().width}×${img.getSize().height}`);
  const { width, height } = img.getSize();
  if (Math.max(width, height) > SCREEN_MAX) {
    img = img.resize(width >= height ? { width: SCREEN_MAX, quality: 'good' } : { height: SCREEN_MAX, quality: 'good' });
  }
  return `data:image/jpeg;base64,${img.toJPEG(75).toString('base64')}`;
}

// The default ask when the user didn't type anything. A busy screen has many question-like
// things (chat, comments, ads, emails), so tell the model to find the one that matters.
const SCREEN_ASK =
  'This is a screenshot of my screen. Find the ONE question or task I need to answer right now. ' +
  'It is usually the main, biggest or most central question: an interview question, a test or quiz question, ' +
  'or a coding problem. Ignore everything else on the screen: menus, tabs, sidebars, chat messages, comments, ' +
  'ads, emails, unrelated code and other windows. Do not describe the screen or list what you see. ' +
  'Read that question and any options, examples or constraints carefully, then answer it. ' +
  'If it is multiple choice, say which option is right and why. ' +
  'If there is no question at all, say in one short line what is on the screen.';

// Appended only when the request includes the live transcript (both sides).
const DIALOGUE =
  'DIALOGUE: The user message includes a live transcript labeled Interviewer and Candidate. ' +
  'Treat it as what was actually said. Stay consistent with the candidate and do not repeat an answer they already gave. ' +
  'If the note says the candidate just asked a clarifying question, reply with one or two spoken sentences: ' +
  'a clearer version of their question when the interviewer was ambiguous, otherwise the answer they should give. ' +
  'If the note says the interviewer just spoke, reply with the words the candidate should say next. ' +
  'If that question asks them to write or fix code, add the code after one or two spoken sentences.';

// A screen question drops the resume: the image is the expensive part.
function buildMessages(userContent, settings, dialogue) {
  const hasImage = Array.isArray(userContent);
  let content = systemPrompt(hasImage ? { ...settings, context: '' } : settings);
  if (dialogue) content += `\n\n${DIALOGUE}`;
  return [
    { role: 'system', content },
    { role: 'user', content: userContent },
  ];
}

function currentSettings() {
  return loadSettings();
}

// "Please try again in 13.02s" -> 13020. Groq does not always say, so fall back to a fixed wait.
const DEFAULT_RETRY_MS = 12000;
function retryDelay(body) {
  const m = /try again in ([\d.]+)\s*s/i.exec(body);
  return m ? Math.min(25000, Math.ceil(parseFloat(m[1]) * 1000) + 400) : DEFAULT_RETRY_MS;
}

// Completion budget. gpt-oss counts its hidden reasoning inside the same cap, and a short
// Russian answer was cut mid-sentence ("…код без.") when only a few hundred tokens were left
// for the visible text. These ceilings are large enough to finish; the prompt still asks for
// a short answer. A per-minute limit, if the account still has one, is handled by the 429 retry.
function needsCodeRoom(userContent) {
  // A screenshot hides the task in the image, so leave room for a real solution.
  if (Array.isArray(userContent) && userContent.some((part) => part && part.type === 'image_url')) return true;
  const text = typeof userContent === 'string'
    ? userContent
    : Array.isArray(userContent)
      ? userContent.map((part) => (part && part.type === 'text' ? part.text : '')).join('\n')
      : '';
  // Only the latest ask counts. An older coding question must not enlarge every later reply.
  const tail = text.slice(-800);
  return /\b(write|implement|debug)\b.{0,48}\b(function|class|method|program|algorithm|solution|code)\b|\b(leetcode|coding (problem|task|question))\b|напиш\p{L}{0,6}\s+(код|функц|класс|программ|алгоритм)|реализуй|реализуйте|исправ\p{L}{0,4}\s+код/iu.test(
    tail
  );
}

function maxTokensFor(settings, model, roomy) {
  const n = Number(settings.maxTokens);
  if (Number.isFinite(n) && n >= 50) return Math.round(n);
  // A spoken answer is short. A requested solution needs room for a whole code block.
  let budget = roomy ? 5000 : 1600;
  // Devanagari and Cyrillic use more tokens than the same sentence in English.
  if (settings.language === 'hi' || settings.language === 'ru' || settings.language === 'auto') {
    budget = Math.max(budget, 2000);
  }
  // Low reasoning still spends well over a thousand tokens before the answer starts.
  if (/gpt-oss/i.test(String(model || ''))) budget += 2500;
  return budget;
}

// gpt-oss rejects reasoning_effort "none" (low | medium | high only). Qwen accepts "none".
// include_reasoning is gpt-oss-only: the trace stays in its own field and out of the overlay.
function reasoningOptions(model, roomy) {
  const id = String(model || '');
  if (/gpt-oss/i.test(id)) return { reasoning_effort: 'low', include_reasoning: false };
  if (/qwen/i.test(id)) return { reasoning_effort: roomy ? 'low' : 'none' };
  return {};
}

// Groq-only fields must not be sent to other servers. DeepSeek thinks before the first word
// unless the request turns that off.
function providerOptions(model, ep, roomy) {
  if (ep.groq) return reasoningOptions(model, roomy);
  if (/api\.deepseek\.com/i.test(ep.url)) return { thinking: { type: 'disabled' } };
  return {};
}

const CHANNEL_NAME = { speech: 'speech', text: 'text', vision: 'image' };
function missingKey(kind) {
  return `Add the ${CHANNEL_NAME[kind] || kind} API key in Settings (⚙).`;
}

// "OTPM: Limit 1000, Used 600, Requested 900" -> a smaller max_tokens that fits now (or 0).
function outputBudgetLeft(body, current) {
  if (!/output tokens per minute|OTPM/i.test(body)) return 0;
  const limit = Number((/Limit (\d+)/i.exec(body) || [])[1]);
  const used = Number((/Used (\d+)/i.exec(body) || [])[1]) || 0;
  if (!limit) return 0;
  const room = Math.min(limit - used - 20, current - 1);
  return room >= 200 ? room : 0;
}

function friendlyError(status, body, groq = true) {
  if (status === 429) {
    if (!groq) {
      const wait = retryDelay(body);
      return (
        'Rate limit reached. ' +
        (wait ? `Wait about ${Math.ceil(wait / 1000)} seconds and try again.` : 'Wait a minute and try again.')
      );
    }
    if (/output tokens per minute|OTPM/i.test(body)) {
      return (
        'Groq free limit reached (1,000 answer tokens per minute). ' +
        'Wait about a minute and try again.'
      );
    }
    if (/request too large/i.test(body)) {
      return 'That question is too big for the Groq free tier. Shorten your background text in ⚙ and try again.';
    }
    const wait = retryDelay(body);
    return (
      'Groq free limit reached (8,000 input tokens per minute). ' +
      (wait ? `Wait about ${Math.ceil(wait / 1000)} seconds and try again. ` : 'Wait a minute and try again. ') +
      'Screen questions cost the most, so use them less often, or shorten your background text in ⚙.'
    );
  }
  if (status === 401) return 'That API key was rejected. Check the key for this request in ⚙ Settings.';
  if (status === 413) return 'That request was too large. Try a smaller screenshot or a shorter background text.';
  try {
    const msg = JSON.parse(body)?.error?.message;
    if (msg) return `API error ${status}: ${msg}`;
  } catch {}
  return `API error ${status}: ${body.slice(0, 300)}`;
}

async function streamChat(userContent, model, dialogue, kind = 'text') {
  const settings = currentSettings();
  const ep = endpoint(settings, kind);
  if (!ep.key) throw new Error(missingKey(kind));

  const messages = buildMessages(userContent, settings, dialogue);
  const url = `${ep.url}/chat/completions`;
  const chatModel = model || (kind === 'vision' ? settings.visionModel : settings.chatModel);
  const roomy = needsCodeRoom(userContent);
  let maxTokens = maxTokensFor(settings, chatModel, roomy);
  const post = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify({
        model: chatModel,
        messages,
        stream: true,
        temperature: 0.3,
        // Groq's current name is max_completion_tokens (max_tokens is the old alias).
        // Other OpenAI-compatible servers still read max_tokens.
        ...(ep.groq ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        ...providerOptions(chatModel, ep, roomy),
      }),
    });

  // Free-tier per-minute limits. If only the answer budget is too big, shrink it and retry at
  // once; otherwise wait out the window and retry, twice at most. A 429 that waiting can't fix
  // ("Request too large") is reported straight away.
  let res = await post();
  let shrinks = 0;
  let waits = 0;
  while (res.status === 429) {
    const body = await res.text();
    const fits = shrinks < 2 ? outputBudgetLeft(body, maxTokens) : 0;
    if (fits) {
      shrinks++;
      maxTokens = fits;
      res = await post();
      continue;
    }
    if (waits >= 2 || /request too large/i.test(body)) throw new Error(friendlyError(429, body, ep.groq));
    waits++;
    const wait = retryDelay(body);
    const limitName = ep.groq ? 'Groq free limit' : 'Rate limit';
    for (let left = Math.ceil(wait / 1000); left > 0; left--) {
      win.webContents.send('answer-status', `${limitName} reached — retrying in ${left}s…`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    win.webContents.send('answer-status', 'Retrying…');
    res = await post();
  }
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), ep.groq));

  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data: /, '').trim();
      if (!data || data === '[DONE]') continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          answer += delta;
          win.webContents.send('answer-chunk', delta);
        }
      } catch {
        // partial or keep-alive line
      }
    }
  }

  return answer;
}

function readAsk(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return String(payload.text || '');
  return String(payload || '');
}

const CHATS_FILE = path.join(app.getPath('userData'), 'chats.json');

function cleanChat(raw) {
  const messages = Array.isArray(raw?.messages) ? raw.messages : [];
  const turns = Array.isArray(raw?.turns) ? raw.turns : [];
  return {
    id: String(raw?.id || '').slice(0, 40),
    title: String(raw?.title || 'New chat').slice(0, 80) || 'New chat',
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    summary: String(raw?.summary || '').slice(0, 4000),
    messages: messages.slice(-250).map((m) => ({
      kind: m?.kind === 'bot' || m?.kind === 'error' ? m.kind : 'user',
      text: String(m?.text || '').slice(0, 16000),
    })),
    turns: turns.slice(-40).map((t) => ({
      role: t?.role === 'me' ? 'me' : 'interviewer',
      text: String(t?.text || '').slice(0, 2000),
    })),
    context: String(raw?.context || '').slice(0, contextLimitOf(currentSettings())),
  };
}

function loadChats() {
  try {
    const data = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'));
    const chats = (Array.isArray(data?.chats) ? data.chats : []).map(cleanChat).filter((c) => c.id);
    return { activeId: String(data?.activeId || ''), chats: chats.slice(0, 60) };
  } catch {
    return { activeId: '', chats: [] };
  }
}

function saveChats(data) {
  const chats = (Array.isArray(data?.chats) ? data.chats : []).map(cleanChat).filter((c) => c.id).slice(0, 60);
  const activeId = String(data?.activeId || '');
  const payload = { activeId: chats.some((c) => c.id === activeId) ? activeId : chats[0]?.id || '', chats };
  fs.mkdirSync(path.dirname(CHATS_FILE), { recursive: true });
  const tmp = `${CHATS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, CHATS_FILE);
  return payload;
}

ipcMain.handle('chats-load', () => loadChats());
ipcMain.handle('chats-save', (_e, data) => saveChats(data));

ipcMain.handle('get-settings', () => currentSettings());
ipcMain.handle('save-settings', (_e, settings) => saveSettings(settings));

ipcMain.handle('pick-resume', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose your resume',
    properties: ['openFile'],
    filters: [
      { name: 'Resume', extensions: EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths.length) return null;
  return readResume(filePaths[0]);
});

ipcMain.handle('ask', async (_e, payload) => streamChat(readAsk(payload), null, !!(payload && payload.dialogue)));

// The ONLY path that sends the screen anywhere. It runs when the user asks (⌘⇧Return / 🖥).
ipcMain.handle('ask-screen', async (_e, payload) => {
  const text = readAsk(payload);
  const t0 = Date.now();
  const image = await captureScreen();
  logLine(`screen: captured on request in ${Date.now() - t0}ms`);
  const settings = currentSettings();
  return streamChat(
    [
      { type: 'text', text: text || SCREEN_ASK },
      { type: 'image_url', image_url: { url: image } },
    ],
    settings.visionModel,
    !!(payload && payload.dialogue),
    'vision'
  );
});

// Fold older turns into a short memory so each answer stays inside the free-tier token budget.
async function completeChat(messages, maxTokens) {
  const settings = currentSettings();
  const ep = endpoint(settings, 'text');
  if (!ep.key) throw new Error(missingKey('text'));
  const chatModel = settings.chatModel;
  const res = await fetch(`${ep.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
    body: JSON.stringify({
      model: chatModel,
      messages,
      stream: false,
      temperature: 0.2,
      ...(ep.groq ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...providerOptions(chatModel, ep, false),
    }),
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), ep.groq));
  const text = (await res.json()).choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new Error('empty summary');
  return String(text).trim();
}

ipcMain.handle('summarize-turns', async (_e, payload) => {
  const turns = Array.isArray(payload?.turns) ? payload.turns : [];
  const prior = String(payload?.summary || '').trim();
  const body = turns
    .map((t) => `${t.role === 'me' ? 'Candidate' : 'Interviewer'}: ${String(t.text || '').trim()}`)
    .filter((line) => !line.endsWith(':'))
    .join('\n');
  if (!body) return prior;
  return completeChat(
    [
      {
        role: 'system',
        content:
          'Compress an interview into at most 120 words. Keep what the candidate already said, which questions were answered, ' +
          'and what the interviewer cared about. No advice. No quotes longer than one sentence.',
      },
      { role: 'user', content: `${prior ? `Earlier summary:\n${prior}\n\n` : ''}New lines:\n${body}` },
    ],
    1500
  );
});

ipcMain.handle('ensure-mic', async () => {
  if (process.platform !== 'darwin') return true;
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    if (status === 'denied' || status === 'restricted') return false;
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (err) {
    console.error('[audio] microphone permission:', err);
    return false;
  }
});

ipcMain.handle('transcribe', async (_e, audioBuffer) => {
  const settings = loadSettings();
  const ep = endpoint(settings, 'speech');
  if (!ep.key) throw new Error(missingKey('speech'));
  const form = new FormData();
  // The renderer sends 16 kHz WAV (it no longer uses MediaRecorder); keep webm as a fallback.
  const isWav = Buffer.from(audioBuffer.slice(0, 4)).toString('ascii') === 'RIFF';
  form.append(
    'file',
    new Blob([audioBuffer], { type: isWav ? 'audio/wav' : 'audio/webm' }),
    isWav ? 'audio.wav' : 'audio.webm'
  );
  // Large v3 hears Russian more accurately than turbo. English, Hindi and Hinglish keep the
  // faster model from settings. Auto does not lock a language, so it uses large v3 too.
  const sttModel =
    ep.groq && (settings.language === 'ru' || settings.language === 'auto')
      ? 'whisper-large-v3'
      : settings.sttModel;
  form.append('model', sttModel);
  // Whisper's prompt steers spelling and script. A Hinglish-only hint pulls Russian into Latin
  // letters, so Auto gets a neutral line with a Russian example and does not set a language.
  const HINGLISH_HINT = 'Interview. Tell me about yourself. Aap apne baare mein batao. Aapka project kya tha?';
  const AUTO_HINT = 'Interview. Tell me about yourself. Расскажите о себе. Какой у вас опыт? Aap apne baare mein batao.';
  if (settings.language === 'en') form.append('language', 'en');
  else if (settings.language === 'ru') {
    form.append('language', 'ru');
    form.append('prompt', 'Интервью. Расскажите о себе. Какой у вас опыт? Чем вы занимались?');
  } else if (settings.language === 'hinglish') form.append('prompt', HINGLISH_HINT);
  else if (settings.language === 'hi') {
    form.append('language', 'hi');
    form.append('prompt', 'इंटरव्यू। अपने बारे में बताइए। आपका प्रोजेक्ट क्या था?');
  } else form.append('prompt', AUTO_HINT);
  const res = await fetch(`${ep.url}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ep.key}` },
    body: form,
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), ep.groq));
  return (await res.json()).text;
});

ipcMain.on('hide', () => win.hide());

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide(); // no Dock icon, not in Cmd+Tab
  createWindow();
  // Both modules share one serialized getSources() with main.js (see getScreenSources).
  setupAudio({ win, ipcMain, loadSettings, getSources: getScreenSources });
  setupStealth({ win, app, globalShortcut, ipcMain, getSources: getScreenSources });

  const log = (msg) => {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'easysobes.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  };
  const send = (channel) => () => {
    log(`hotkey -> ${channel}`);
    if (!win.isVisible()) win.showInactive();
    win.webContents.send(channel);
  };
  // A shortcut another app already owns silently fails to register, so record the result.
  const register = (accel, fn) => {
    const ok = globalShortcut.register(accel, fn);
    if (!ok) log(`SHORTCUT NOT AVAILABLE: ${accel} (another app has it)`);
    return ok;
  };
  register('CommandOrControl+Shift+Space', toggleWindow);
  register('CommandOrControl+Shift+Return', send('hotkey-screen'));
  register('CommandOrControl+Shift+R', send('hotkey-record'));
  register('CommandOrControl+Shift+K', send('hotkey-clear'));
  register('CommandOrControl+Shift+I', () => {
    win.show();
    win.focus();
    win.webContents.send('hotkey-focus');
  });
  register('CommandOrControl+Shift+Up', () => moveWindow(0, -40));
  register('CommandOrControl+Shift+Down', () => moveWindow(0, 40));
  register('CommandOrControl+Shift+Left', () => moveWindow(-40, 0));
  register('CommandOrControl+Shift+Right', () => moveWindow(40, 0));
  register('CommandOrControl+Shift+Q', () => app.quit());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
