const $ = (id) => document.getElementById(id);
const output = $('output');
const hintHTML = output.innerHTML;
const input = $('input');
const SETTING_KEYS = [
  'speechBaseUrl',
  'speechApiKey',
  'textBaseUrl',
  'textApiKey',
  'visionBaseUrl',
  'visionApiKey',
  'chatModel',
  'visionModel',
  'sttModel',
  'language',
  'contextLimit',
];
// Hotkey labels are written Mac-style (⌘⇧R). On Windows/Linux, rewrite every label to Ctrl+Shift+R,
// including text that other modules set later.
if (!navigator.userAgent.includes('Macintosh')) {
  const winKeys = (s) => s.replace(/⌘⇧/g, 'Ctrl+Shift+').replace(/↩/g, 'Enter');
  const fix = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.data.includes('⌘')) node.data = winKeys(node.data);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.title?.includes('⌘')) node.title = winKeys(node.title);
    if (node.placeholder?.includes('⌘')) node.placeholder = winKeys(node.placeholder);
    node.childNodes.forEach(fix);
  };
  fix(document.body);
  new MutationObserver((changes) =>
    changes.forEach((c) => (c.type === 'childList' ? c.addedNodes.forEach(fix) : fix(c.target)))
  ).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder'] });
}

let answerEpoch = 0;
let answerSerial = 0;
let currentBot = null;
let currentText = '';
let shownSolution = '';
let solutionDismissed = false;
const solutionByMsg = new WeakMap();

// The model puts words to say before this line, and code or a design after it.
const SOLUTION_MARK = '<<<SOLUTION>>>';

function splitAnswer(raw) {
  const text = String(raw || '');
  const at = text.indexOf(SOLUTION_MARK);
  if (at >= 0) {
    return {
      say: text.slice(0, at).trim(),
      solution: text.slice(at + SOLUTION_MARK.length).replace(/^\s*\n/, ''),
    };
  }
  return { say: stripPartialMark(text).trimEnd(), solution: '' };
}

function stripPartialMark(text) {
  const heads = [SOLUTION_MARK, `\n${SOLUTION_MARK}`];
  let cut = 0;
  for (const head of heads) {
    const max = Math.min(head.length - 1, text.length);
    for (let n = max; n >= 3; n--) {
      if (text.endsWith(head.slice(0, n))) {
        cut = Math.max(cut, n);
        break;
      }
    }
  }
  return cut ? text.slice(0, -cut) : text;
}

// Notices that used to sit in the header. The speech line stays put; the hint line
// shows the notice, then returns. A "busy" notice stays until the work finishes.
let micNotice = '';
let micNoticeTimer = 0;
let lastMicState = { mode: 'off', phase: 'idle', source: 'system' };

function setStatus(text, cls = '') {
  clearTimeout(micNoticeTimer);
  micNotice = String(text || '');
  const sub = $('mic-sub');
  if (!sub) return;
  if (!micNotice) {
    sub.className = 'mic-sub';
    sub.textContent = micTexts(lastMicState)[1];
    return;
  }
  sub.textContent = micNotice;
  sub.className = `mic-sub notice${cls ? ` ${cls}` : ''}`;
  if (cls !== 'busy') micNoticeTimer = setTimeout(() => setStatus(''), 4500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Markdown (dependency-free, XSS-safe: every text run is escaped before formatting) ----------

function renderInline(text) {
  const codes = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<u>$1</u>'); // links shown as text; nothing clickable
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[i]);
}

function renderBlocks(text) {
  let html = '';
  let para = [];
  const lists = []; // stack of { type: 'ul' | 'ol', indent }

  let sayOpen = false; // inside the "Say it" card
  const closeSay = () => {
    if (sayOpen) html += '</div>';
    sayOpen = false;
  };
  const flushPara = () => {
    // A line that is only **Bold** (optionally with ":") is a section label, e.g. "Talking points".
    while (para.length) {
      const label = para[0].match(/^\*\*([^*]{1,40})\*\*:?$/);
      if (!label) break;
      closeSay();
      html += `<div class="section">${renderInline(label[1])}</div>`;
      if (/^say it|^sample answer|^answer$/i.test(label[1].trim())) {
        html += '<div class="say">';
        sayOpen = true;
      }
      para.shift();
    }
    if (para.length) html += `<p>${para.map(renderInline).join('<br>')}</p>`;
    para = [];
  };
  const closeList = () => (html += `</li></${lists.pop().type}>`);
  const closeLists = () => {
    while (lists.length) closeList();
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara(); // lists stay open across blank lines ("1. a\n\n2. b")
      continue;
    }

    const item = line.match(/^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, '    ').length;
      const type = /\d/.test(item[2]) ? 'ol' : 'ul';
      let top = lists[lists.length - 1];
      while (top && (top.indent > indent || (top.indent === indent && top.type !== type))) {
        closeList();
        top = lists[lists.length - 1];
      }
      if (top && top.indent === indent) {
        html += '</li><li>';
      } else {
        const start = type === 'ol' ? parseInt(item[2], 10) : 1;
        html += type === 'ol' && start !== 1 ? `<ol start="${start}"><li>` : `<${type}><li>`;
        lists.push({ type, indent });
      }
      html += renderInline(item[3]);
      continue;
    }

    // Indented continuation of a list item.
    if (lists.length && /^\s+\S/.test(line)) {
      html += `<br>${renderInline(line.trim())}`;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) {
      flushPara();
      closeLists();
      closeSay();
      html += `<div class="h h${heading[1].length}">${renderInline(heading[2])}</div>`;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}$/.test(line)) {
      flushPara();
      closeLists();
      html += '<hr>';
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      closeLists();
      html += `<blockquote>${renderInline(quote[1])}</blockquote>`;
      continue;
    }

    closeLists();
    // A bold label line starts a new section even without a blank line before it.
    if (para.length && /^\*\*[^*]{1,40}\*\*:?$/.test(line.trim())) flushPara();
    para.push(line.trim());
  }
  flushPara();
  closeLists();
  closeSay();
  return html;
}

function renderMarkdown(md) {
  // Odd parts are fenced code. An unclosed fence while streaming still renders as code.
  return md
    .split(/^\s*```/m)
    .map((part, i) => {
      if (i % 2 === 0) return renderBlocks(part);
      const lang = (part.match(/^[\w+#.-]*/) || [''])[0];
      const code = part.replace(/^[\w+#.-]*[^\n]*\n?/, '').replace(/\n$/, '');
      return (
        '<div class="code-wrap">' +
        (lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '') +
        `<pre><code>${escapeHtml(code)}</code></pre></div>`
      );
    })
    .join('');
}

// ---------- Messages ----------

// A new question sits at the top of the transcript. The answer grows under it.
// The scroll stops at the last line: no blank tail under the chat.
let followQuestion = false;
let pinning = false;

function questionScrollTop(question) {
  const pad = parseFloat(getComputedStyle(output).paddingTop) || 0;
  const delta = question.getBoundingClientRect().top - (output.getBoundingClientRect().top + output.clientTop + pad);
  return Math.max(0, output.scrollTop + delta);
}

function pinLatestQuestion() {
  output.querySelector('.pin-spacer')?.remove();
  const questions = output.querySelectorAll('.msg.user');
  const question = questions[questions.length - 1];
  if (!question) return;
  const limit = Math.max(0, output.scrollHeight - output.clientHeight);
  const top = Math.min(questionScrollTop(question), limit);
  pinning = true;
  output.scrollTop = top;
  pinning = false;
}

output.addEventListener('scroll', () => {
  if (pinning || !followQuestion) return;
  const questions = output.querySelectorAll('.msg.user');
  const question = questions[questions.length - 1];
  if (!question) return;
  const limit = Math.max(0, output.scrollHeight - output.clientHeight);
  const top = Math.min(questionScrollTop(question), limit);
  if (Math.abs(output.scrollTop - top) > 2) followQuestion = false;
});

let restoring = false;

function addMessage(cls, html) {
  if (cls.includes('error')) {
    try { window.sobes.send('log', `shown error: ${String(html).slice(0, 400)}`); } catch {}
  }
  output.querySelector('.hint')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  const talk = cls.includes('user') || cls.includes('bot');
  if (talk) {
    el.classList.add('talk');
    const mark = document.createElement('span');
    mark.className = cls.includes('user') ? 'qa q' : 'qa a';
    mark.textContent = cls.includes('user') ? 'Q:' : 'A:';
    const body = document.createElement('div');
    body.className = 'qa-body';
    body.innerHTML = html;
    el.append(mark, body);
  } else {
    el.innerHTML = html;
  }
  output.appendChild(el);
  if (!restoring && (cls.includes('user') || cls.includes('bot'))) {
    followQuestion = true;
    pinLatestQuestion();
  }
  if (!restoring && (cls.includes('user') || cls.includes('error'))) {
    const body = el.querySelector('.qa-body');
    rememberVisible(cls.includes('error') ? 'error' : 'user', (body || el).textContent);
  }
  return el;
}

function finalizeBot(msg, text) {
  const parts = splitAnswer(text);
  if (parts.solution) solutionByMsg.set(msg, parts.solution);
  if (!restoring) rememberVisible('bot', text);
  const host = msg.querySelector('.qa-body') || msg;
  if (parts.solution && !host.querySelector('.open-solution')) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open-solution';
    open.textContent = 'Solution';
    host.appendChild(open);
  }
}

const stage = $('stage');

function setTab(name) {
  stage.dataset.tab = name;
  stage.querySelectorAll('.stage-tabs button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.tab === name);
  });
}

function showSolution(markdown, opts = {}) {
  shownSolution = markdown;
  $('artifact-body').innerHTML = renderMarkdown(markdown);
  if (opts.force) solutionDismissed = false;
  if (solutionDismissed) return;
  const opening = !stage.classList.contains('has-solution');
  stage.classList.add('has-solution');
  if (opening) window.sobes.invoke('fit-solution', true).catch(() => {});
}

function clearSolution() {
  shownSolution = '';
  solutionDismissed = false;
  $('artifact-body').innerHTML = '';
  stage.classList.remove('has-solution');
  setTab('talk');
  window.sobes.invoke('fit-solution', false).catch(() => {});
}

function paintLive(raw) {
  if (!currentBot) return;
  const parts = splitAnswer(raw);
  currentBot.innerHTML = parts.say
    ? renderMarkdown(parts.say)
    : parts.solution
      ? '<p>The solution is in the panel.</p>'
      : '<span class="dots"><i></i><i></i><i></i></span>';
  if (parts.solution) showSolution(parts.solution);
  if (followQuestion) pinLatestQuestion();
}

new ResizeObserver(() => {
  stage.classList.toggle('narrow', stage.clientWidth < 680);
}).observe(stage);

$('stage-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn?.dataset.tab) setTab(btn.dataset.tab);
});

$('artifact-close').addEventListener('click', () => {
  solutionDismissed = true;
  stage.classList.remove('has-solution');
  setTab('talk');
  window.sobes.invoke('fit-solution', false).catch(() => {});
});

stage.addEventListener('click', (e) => {
  const open = e.target.closest('.open-solution');
  if (!open) return;
  const sol = solutionByMsg.get(open.closest('.msg'));
  if (!sol) return;
  showSolution(sol, { force: true });
  if (stage.classList.contains('narrow')) setTab('solution');
});

function answerPayload(payload) {
  const id = payload && typeof payload === 'object' ? payload.id : null;
  const text = typeof payload === 'string' ? payload : payload && (payload.delta || payload.text);
  return { id, text };
}

window.sobes.on('answer-status', (payload) => {
  const { id, text } = answerPayload(payload);
  if (id != null && id !== answerEpoch) return;
  setStatus(text, 'busy');
  if (currentBot && !currentText) currentBot.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> ${escapeHtml(text)}`;
});

window.sobes.on('answer-chunk', (payload) => {
  const { id, text } = answerPayload(payload);
  if (!currentBot || !text) return;
  if (id != null && id !== answerEpoch) return;
  currentText += text;
  paintLive(currentText);
});

// A request that arrives mid-answer waits its turn. Three can wait.
// A fourth is shown in the chat and is not described as queued.
const queue = [];
async function run(label, fn) {
  if (busy) {
    if (queue.length < 3) {
      queue.push([label, fn]);
      setStatus('Queued — answering after this one', 'busy');
    } else {
      const note = 'Not queued — three questions are already waiting';
      addMessage('error', escapeHtml(label ? `${note}: ${label}` : note));
      setStatus(note, 'busy');
    }
    return;
  }
  busy = true;
  const epoch = ++answerSerial;
  answerEpoch = epoch;
  setStatus('Thinking…', 'busy');
  solutionDismissed = false;
  if (label) addMessage('user', escapeHtml(label));
  currentText = '';
  const msg = addMessage('bot streaming', '<div class="md"><span class="dots"><i></i><i></i><i></i></span></div>');
  currentBot = msg.querySelector('.md');
  try {
    const answer = await fn(epoch);
    if (!currentText && typeof answer === 'string' && answer) {
      currentText = answer;
      paintLive(answer);
    }
    if (currentText) finalizeBot(msg, currentText);
    if (!splitAnswer(currentText).solution) clearSolution();
    msg.classList.remove('streaming');
    setStatus('');
  } catch (err) {
    const text = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    const stalled = /Couldn't finish this answer|didn't start in time/.test(text);
    if (stalled && currentText) {
      msg.classList.remove('streaming');
      finalizeBot(msg, currentText);
      (msg.querySelector('.qa-body') || msg).append(retryNote(label, fn));
      window.sobes.send('log', `run stalled with partial: ${text}`);
      setStatus('');
    } else {
      msg.remove();
      if (!stalled) clearSolution();
      const el = addMessage('error', escapeHtml(text));
      if (stalled) el.append(retryNote(label, fn));
      window.sobes.send('log', `run failed: ${err && err.stack ? err.stack : err}`);
      setStatus('');
    }
  } finally {
    currentBot = null;
    busy = false;
    if (queue.length) run(...queue.shift());
  }
}

function retryNote(label, fn) {
  const note = document.createElement('div');
  note.className = 'stall-note';
  note.textContent = "Couldn't finish this answer";
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'retry-answer';
  btn.textContent = 'Answer';
  btn.addEventListener('click', () => {
    note.remove();
    run(label, fn);
  });
  note.append(btn);
  return note;
}

function askText(text) {
  text = text.trim();
  if (!text) return;
  const heard = window.audio?.dialoguePrefix?.() || '';
  const payload = heard
    ? { text: `${heard}\n\nThe candidate typed this request:\n${text}`, dialogue: true }
    : { text, dialogue: false };
  run(text, (id) => window.sobes.ask({ ...payload, label: text, id }));
}

function askScreen() {
  const text = input.value.trim();
  input.value = '';
  const label = text || 'Reading screen…';
  const heard = window.audio?.dialoguePrefix?.() || '';
  const body = heard
    ? `${heard}\n\n${text || 'Find the one question on the screen and answer it using the conversation above.'}`
    : text;
  run(label, (id) => window.sobes.askScreen({ text: body, label, dialogue: !!heard, id }));
}

function clearAll() {
  output.innerHTML = hintHTML;
  clearSolution();
  setStatus('');
  if (activeChat) {
    activeChat.messages = [];
    activeChat.turns = [];
    activeChat.summary = '';
    activeChat.context = '';
    activeChat.title = 'New chat';
    activeChat.updatedAt = Date.now();
    renderChatList();
  }
  window.audio?.clearConversation?.();
}

// ---------- Chats (one history and one spoken memory each) ----------

let chats = [];
let activeChat = null;
let chatSaveTimer = 0;
let pendingDelete = null;
let pendingRename = null;

function blankChat() {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: 'New chat',
    updatedAt: Date.now(),
    messages: [],
    turns: [],
    summary: '',
    context: '',
  };
}

function shownAsk(text) {
  return String(text || '').replace(/^[🎧🎤🖥]\s*/, '');
}

function titleFrom(text) {
  const clean = shownAsk(text).replace(/\s+/g, ' ').trim();
  if (!clean || clean === 'Reading screen…') return '';
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
}

function rememberVisible(kind, text) {
  if (!activeChat) return;
  activeChat.messages.push({ kind, text: String(text || '').slice(0, 16000) });
  if (activeChat.messages.length > 250) activeChat.messages.splice(0, activeChat.messages.length - 250);
  const title = kind === 'user' ? titleFrom(text) : '';
  if (title && activeChat.title === 'New chat') activeChat.title = title;
  activeChat.updatedAt = Date.now();
  renderChatList();
  persistSoon();
}

function snapshotMemory() {
  const mem = window.audio?.getMemory?.();
  if (!activeChat || !mem) return;
  activeChat.turns = mem.turns;
  activeChat.summary = mem.summary;
}

function persistSoon() {
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(saveChats, 250);
}

function saveChats() {
  snapshotMemory();
  if (!activeChat) return;
  window.sobes.invoke('chats-save', { activeId: activeChat.id, chats }).catch(() => {});
}

let contextChatId = '';
let contextCharLimit = 16000;

function setContextCharLimit(n) {
  const value = Math.round(Number(n));
  contextCharLimit = Number.isFinite(value) ? Math.min(4000000, Math.max(500, value)) : 16000;
  const field = $('context-text');
  if (field) field.maxLength = contextCharLimit;
}

function renderContextCount() {
  const field = $('context-text');
  const max = contextCharLimit;
  const n = field.value.length;
  const el = $('context-count');
  el.textContent = `${n.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`;
  el.classList.toggle('long', n > 4000);
}

function openContext(id) {
  const chat = chats.find((c) => c.id === id) || activeChat;
  if (!chat) return;
  contextChatId = chat.id;
  $('context-title').textContent = chat.title && chat.title !== 'New chat' ? chat.title : 'Context for this chat';
  const field = $('context-text');
  field.maxLength = contextCharLimit;
  field.value = String(chat.context || '').slice(0, contextCharLimit);
  renderContextCount();
  $('context-modal').classList.remove('hidden');
  $('context-text').focus();
}

function closeContext() {
  contextChatId = '';
  $('context-modal').classList.add('hidden');
}

function saveContext(e) {
  if (e) e.preventDefault();
  const chat = chats.find((c) => c.id === contextChatId);
  if (!chat) return closeContext();
  chat.context = $('context-text').value.trim().slice(0, contextCharLimit);
  chat.updatedAt = Date.now();
  closeContext();
  renderChatList();
  persistSoon();
  setStatus(chat.context ? 'Context saved for this chat' : 'Context cleared');
}

function renderChatList() {
  hideChatTip();
  const list = $('chat-list');
  if (!list) return;
  const sorted = chats.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  let html = '';
  for (const chat of sorted) {
    const on = chat.id === activeChat?.id ? ' active' : '';
    const id = escapeHtml(chat.id);
    if (chat.id === pendingDelete) {
      html += `<div class="chat-row confirm${on}" data-id="${id}">` +
        `<span class="chat-ask">Delete?</span>` +
        `<button type="button" class="chat-del-yes">Delete</button>` +
        `<button type="button" class="chat-del-no">Cancel</button></div>`;
    } else if (chat.id === pendingRename) {
      html += `<div class="chat-row${on}" data-id="${id}">` +
        `<input class="chat-rename" maxlength="80" value="${escapeHtml(chat.title || 'New chat')}" /></div>`;
    } else {
      html += `<div class="chat-row${on}" data-id="${id}">` +
        `<button type="button" class="chat-open">${escapeHtml(chat.title || 'New chat')}</button>` +
        `<button type="button" class="chat-rename-btn" aria-label="Rename">✎</button>` +
        `<button type="button" class="chat-del" aria-label="Delete">×</button></div>`;
    }
  }
  list.innerHTML = html;
  const field = list.querySelector('.chat-rename');
  if (!field) return;
  const rowId = field.closest('.chat-row').dataset.id;
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      field.dataset.save = '1';
      field.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      field.dataset.save = '0';
      field.blur();
    }
  });
  field.addEventListener('blur', () => {
    if (pendingRename !== rowId) return;
    const save = field.dataset.save !== '0';
    pendingRename = null;
    if (save) {
      const chat = chats.find((c) => c.id === rowId);
      const title = field.value.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (chat && title) {
        chat.title = title;
        persistSoon();
      }
    }
    renderChatList();
  });
  field.focus();
  field.select();
}

function paintChat(chat) {
  restoring = true;
  solutionDismissed = false;
  output.innerHTML = '';
  if (!chat.messages.length) output.innerHTML = hintHTML;
  let lastSolution = '';
  for (const m of chat.messages) {
    if (m.kind === 'bot') {
      const parts = splitAnswer(m.text);
      const spoken = parts.say || (parts.solution ? 'The solution is in the panel.' : m.text);
      const el = addMessage('bot', `<div class="md">${renderMarkdown(spoken)}</div>`);
      finalizeBot(el, m.text);
      if (parts.solution) lastSolution = parts.solution;
    } else if (m.kind === 'error') addMessage('error', escapeHtml(m.text));
    else addMessage('user', escapeHtml(shownAsk(m.text)));
  }
  if (lastSolution) showSolution(lastSolution);
  else clearSolution();
  restoring = false;
  followQuestion = false;
  pinLatestQuestion();
}

function openChat(id) {
  if (busy) return setStatus('Wait for the answer to finish');
  const next = chats.find((c) => c.id === id);
  if (!next || next === activeChat) return;
  snapshotMemory();
  activeChat = next;
  window.audio?.setMemory?.({ turns: next.turns, summary: next.summary });
  paintChat(next);
  renderChatList();
  persistSoon();
}

function newChat() {
  if (busy) return setStatus('Wait for the answer to finish');
  snapshotMemory();
  if (activeChat && activeChat.title === 'New chat' && !activeChat.messages.length && !(activeChat.turns || []).length && !String(activeChat.context || '').trim()) return;
  const chat = blankChat();
  chats.unshift(chat);
  activeChat = chat;
  window.audio?.setMemory?.({ turns: [], summary: '' });
  paintChat(chat);
  renderChatList();
  persistSoon();
}

function deleteChat(id) {
  if (busy && id === activeChat?.id) return setStatus('Wait for the answer to finish');
  const index = chats.findIndex((c) => c.id === id);
  if (index < 0) return;
  const wasActive = chats[index] === activeChat;
  chats.splice(index, 1);
  if (!chats.length) chats.push(blankChat());
  if (wasActive) {
    activeChat = chats[Math.min(index, chats.length - 1)];
    window.audio?.setMemory?.({ turns: activeChat.turns, summary: activeChat.summary });
    paintChat(activeChat);
  }
  renderChatList();
  persistSoon();
}

function setChatsOpen(open) {
  $('panel').dataset.chats = open ? 'open' : 'closed';
  try { localStorage.setItem('chatsOpen', open ? 'open' : 'closed'); } catch {}
}

async function initChats() {
  let saved = { activeId: '', chats: [] };
  try { saved = await window.sobes.invoke('chats-load'); } catch {}
  chats = Array.isArray(saved.chats) && saved.chats.length ? saved.chats : [blankChat()];
  activeChat = chats.find((c) => c.id === saved.activeId) || chats[0];
  window.audio?.setMemory?.({ turns: activeChat.turns || [], summary: activeChat.summary || '' });
  paintChat(activeChat);
  renderChatList();
  let open = true;
  try { open = localStorage.getItem('chatsOpen') !== 'closed'; } catch {}
  setChatsOpen(open);
}

// ---------- Font size (per-device, localStorage) ----------

const FONT_MIN = 10;
const FONT_MAX = 26;
let fontSize = 16;

function applyFontSize(px) {
  fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  document.documentElement.style.setProperty('--fs', `${fontSize}px`);
  $('font-size-val').textContent = `${fontSize}px`;
  try {
    localStorage.setItem('answerFontSize', String(fontSize));
  } catch {}
}

try {
  const saved = parseInt(localStorage.getItem('answerFontSize'), 10);
  if (saved) fontSize = saved;
} catch {}
applyFontSize(fontSize);
$('btn-font-down').onclick = () => applyFontSize(fontSize - 1);
$('btn-font-up').onclick = () => applyFontSize(fontSize + 1);

// ---------- Stealth ----------

async function checkHidden() {
  closeSettings();
  setStatus('Capturing…', 'busy');
  try {
    const res = await window.sobes.invoke('stealth-check');
    const url = res && typeof res.dataUrl === 'string' ? res.dataUrl : '';
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(url)) throw new Error('No image returned');
    const b = res.bounds;
    const size = b ? ` (${Math.round(b.width)}×${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)})` : '';
    addMessage(
      'check',
      `<div class="check-title">What screen-share viewers see here${escapeHtml(size)}</div>` +
        `<img src="${escapeHtml(url)}" alt="Capture of the area behind this window" />` +
        (res.contentProtection === false
          ? '<div class="check-warn">Content protection is OFF — this window may be visible to viewers.</div>'
          : '') +
        '<div class="check-note">If you can’t see this overlay in the image, it is hidden from screen sharing.</div>'
    );
    setStatus('');
  } catch (err) {
    const msg = /no handler registered/i.test(err.message)
      ? 'Hidden check is not available in this build yet.'
      : `Hidden check failed: ${err.message}`;
    addMessage('error', escapeHtml(msg));
    setStatus('');
  }
}

function showStealthStatus(s = {}) {
  document.querySelector('.panel').classList.toggle('click-through', !!s.clickThrough);
  const el = $('stealth-ind');
  const parts = [];
  if (s.clickThrough) parts.push('🖱✕');
  if (typeof s.opacity === 'number' && s.opacity < 0.999) parts.push(`${Math.round(s.opacity * 100)}%`);
  el.textContent = parts.join(' ');
  el.title = `${s.clickThrough ? 'Click-through ON (clicks pass through)' : 'Click-through off'}` +
    (typeof s.opacity === 'number' ? ` · opacity ${Math.round(s.opacity * 100)}%` : '');
  el.title += s.clickThrough ? ' — press ⌘⇧T to turn off' : '';
  el.classList.toggle('hidden', !parts.length);
}
window.sobes.on('stealth-status', showStealthStatus);
window.sobes
  .invoke('stealth-get-status')
  .then((s) => s && showStealthStatus(s))
  .catch(() => {});

// ---------- Audio source / live listen ----------

function toggleLive() {
  if (typeof window.audio?.toggleLive !== 'function') return setStatus('Live listen not available yet');
  window.audio.toggleLive();
}

// ---------- Mic status bar ----------

let micSince = 0;

function micTexts({ mode, phase }) {
  if (mode === 'starting') return ['Starting…', 'Opening system audio'];
  if (mode === 'recording')
    return [phase === 'speech' ? 'Recording · hearing sound' : 'Recording', 'Interviewer · press ⌘⇧R to stop and answer'];
  if (mode === 'live') {
    const label = phase === 'transcribing' ? 'Listening · transcribing…' : phase === 'speech' ? 'Listening · hearing speech' : 'Listening';
    return [label, 'Interviewer · ⌘⇧L to stop'];
  }
  if (phase === 'transcribing') return ['Transcribing…', 'Turning speech into text'];
  return ['Not listening', '⌘⇧L live listen · ⌘⇧R record'];
}

function renderMic(st) {
  lastMicState = st;
  const bar = $('micbar');
  bar.dataset.mode = st.mode;
  bar.dataset.phase = st.phase;
  document.querySelector('.panel').dataset.mic = st.mode;
  const [label, sub] = micTexts(st);
  $('mic-label').textContent = label;
  if (!micNotice) $('mic-sub').textContent = sub;

  const on = st.mode === 'recording' || st.mode === 'live';
  const bars = $('meter').children;
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('lit', on && st.level > (i + 0.5) / bars.length);
  micSince = on ? st.since : 0;
  renderMicTime();

  const liveBtn = $('btn-live');
  liveBtn.classList.toggle('on', st.mode === 'live');
  liveBtn.querySelector('.lbl').textContent = st.mode === 'live' ? 'Stop' : 'Live';
}

function renderMicTime() {
  const el = $('mic-time');
  if (!micSince) return (el.textContent = '');
  const sec = Math.max(0, Math.floor((Date.now() - micSince) / 1000));
  el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
setInterval(renderMicTime, 1000);
window.addEventListener('audio-state', (e) => renderMic(e.detail));

// ---------- Settings ----------

function closeSettings() {
  $('settings').classList.add('hidden');
}

async function openSettings() {
  const panel = $('settings');
  if (!panel.classList.contains('hidden')) return closeSettings();
  panel.classList.remove('hidden');
  const settings = await window.sobes.getSettings();
  SETTING_KEYS.forEach((k) => {
    const el = $(`s-${k}`);
    el.value = settings[k] || '';
    if (el.tagName === 'SELECT' && el.selectedIndex < 0) el.selectedIndex = 0; // e.g. no language saved yet → Auto
  });
  $('s-theme').value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('theme', next);
  } catch {}
}

async function saveSettings() {
  const settings = {};
  SETTING_KEYS.forEach((k) => (settings[k] = $(`s-${k}`).value.trim()));
  const saved = await window.sobes.saveSettings(settings);
  setContextCharLimit(saved?.contextLimit);
  closeSettings();
  setStatus('Settings saved');
}

// ---------- Wiring ----------

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    askText(input.value);
    input.value = '';
  } else if (e.key === 'Escape') {
    input.blur();
  }
});

$('s-theme').onchange = () => applyTheme($('s-theme').value);
$('btn-chat-context').onclick = () => openContext(activeChat?.id);
$('context-form').onsubmit = saveContext;
$('context-cancel').onclick = closeContext;
$('context-close').onclick = closeContext;
$('context-modal').onclick = (e) => {
  if (e.target === $('context-modal')) closeContext();
};
$('context-text').addEventListener('input', renderContextCount);
$('context-text').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeContext();
  }
});
$('btn-live').onclick = toggleLive;
$('btn-screen').onclick = () => askScreen();
$('btn-settings').onclick = openSettings;
$('btn-settings-back').onclick = () => closeSettings();
$('btn-save').onclick = saveSettings;
$('btn-check-hidden').onclick = checkHidden;
$('btn-hide').onclick = () => window.sobes.hide();
$('btn-chat-new').onclick = newChat;
$('btn-chats-hide').onclick = () => setChatsOpen(false);
$('btn-chats-show').onclick = () => setChatsOpen(true);
let chatTipTimer = 0;
let chatTip = null;

function hideChatTip() {
  clearTimeout(chatTipTimer);
  chatTip?.remove();
  chatTip = null;
}

function showChatTip(btn) {
  hideChatTip();
  const text = btn.getAttribute('aria-label');
  if (!text) return;
  const tip = document.createElement('div');
  tip.className = 'hover-tip';
  tip.textContent = text;
  document.body.appendChild(tip);
  const rect = btn.getBoundingClientRect();
  tip.style.left = `${rect.left + rect.width / 2}px`;
  tip.style.top = `${rect.bottom + 6}px`;
  chatTip = tip;
}

$('chat-list').addEventListener('mouseover', (e) => {
  const btn = e.target.closest('.chat-rename-btn, .chat-del');
  if (!btn || btn.contains(e.relatedTarget)) return;
  clearTimeout(chatTipTimer);
  chatTipTimer = setTimeout(() => showChatTip(btn), 600);
});
$('chat-list').addEventListener('mouseout', (e) => {
  const btn = e.target.closest('.chat-rename-btn, .chat-del');
  if (!btn || btn.contains(e.relatedTarget)) return;
  hideChatTip();
});

$('chat-list').onclick = (e) => {
  const row = e.target.closest('.chat-row');
  if (!row) return;
  if (e.target.closest('.chat-del-yes')) {
    const id = row.dataset.id;
    pendingDelete = null;
    deleteChat(id);
    return;
  }
  if (e.target.closest('.chat-del-no')) {
    pendingDelete = null;
    renderChatList();
    return;
  }
  if (e.target.closest('.chat-del')) {
    pendingRename = null;
    pendingDelete = row.dataset.id;
    renderChatList();
    return;
  }
  if (e.target.closest('.chat-rename-btn')) {
    pendingDelete = null;
    pendingRename = row.dataset.id;
    renderChatList();
    return;
  }
  if (e.target.closest('.chat-rename')) return;
  pendingDelete = null;
  pendingRename = null;
  openChat(row.dataset.id);
};
$('chat-list').ondblclick = (e) => {
  const open = e.target.closest('.chat-open');
  if (!open) return;
  pendingDelete = null;
  pendingRename = open.closest('.chat-row').dataset.id;
  renderChatList();
};

window.sobes.on('hotkey-record', () => window.audio.toggleRecording());
window.sobes.on('hotkey-screen', askScreen);
window.sobes.on('hotkey-clear', clearAll);
window.sobes.on('hotkey-focus', () => input.focus());

// audio-renderer.js loads after this file, so read the source once everything is parsed.
window.addEventListener('DOMContentLoaded', async () => {
  if (window.audio?.getState) renderMic(window.audio.getState());
  await initChats();
  try {
    const s = await window.sobes.getSettings();
    setContextCharLimit(s.contextLimit);
    if (!s.textApiKey && !s.speechApiKey) {
      addMessage('error', 'No API key yet. Open Settings and paste a key for speech and for text, then click Save.');
      openSettings();
    }
  } catch {}
});

// Shared helpers for feature modules (audio-renderer.js etc.).
window.app = {
  $,
  run,
  addMessage,
  setStatus,
  escapeHtml,
  isBusy: () => busy,
  onMemoryChanged: persistSoon,
  chatContext: () => String(activeChat?.context || ''),
  contextLimit: () => contextCharLimit,
};
