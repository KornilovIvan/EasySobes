// Settings panel: API fields, theme, and text size.
// Loaded after renderer.js so it can use $, setStatus, and setContextCharLimit.

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
  $('key-check').textContent = '';
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

async function checkKeys() {
  const btn = $('btn-check-keys');
  const out = $('key-check');
  const patch = {};
  SETTING_KEYS.forEach((k) => (patch[k] = $(`s-${k}`).value.trim()));
  btn.disabled = true;
  out.textContent = 'Checking…';
  try {
    const lines = await window.sobes.invoke('check-keys', patch);
    out.innerHTML = '';
    for (const line of lines || []) {
      const row = document.createElement('span');
      row.className = line.ok ? '' : 'bad';
      row.textContent = `${line.label}: ${line.message}`;
      out.append(row);
    }
  } catch (err) {
    out.textContent = '';
    const row = document.createElement('span');
    row.className = 'bad';
    row.textContent = err.message || 'Check failed';
    out.append(row);
  } finally {
    btn.disabled = false;
  }
}

$('s-theme').onchange = () => applyTheme($('s-theme').value);
$('btn-settings').onclick = openSettings;
$('btn-settings-back').onclick = () => closeSettings();
$('btn-save').onclick = saveSettings;
$('btn-check-keys').onclick = checkKeys;
