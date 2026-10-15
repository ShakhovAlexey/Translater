// Синхронный переводчик иврит → русский.
// Распознавание: Web Speech API (he-IL), перевод: Google / MyMemory / Claude, озвучка: speechSynthesis (ru-RU).

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'translater.settings.v1';
const defaults = {
  provider: 'google',
  model: 'claude-opus-5-5',
  apiKey: '',
  fontSize: 30,
  speak: false,
  muteWhileSpeaking: false,
  showHebrew: true,
  rate: 1.1,
};

function loadSettings() {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...defaults }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* приватный режим */ }
}

const settings = loadSettings();

// ---------------------------------------------------------------- перевод

const INTERIM_THROTTLE_MS = 300;
const CONTEXT_LINES = 4;

async function translateGoogle(text, signal) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=iw&tl=ru&dt=t&q='
    + encodeURIComponent(text);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Google Translate: HTTP ' + res.status);
  const data = await res.json();
  return data[0].map((part) => part[0]).join('');
}

async function translateMyMemory(text, signal) {
  const url = 'https://api.mymemory.translated.net/get?langpair=he|ru&q=' + encodeURIComponent(text);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('MyMemory: HTTP ' + res.status);
  const data = await res.json();
  return data.responseData.translatedText;
}

// Быстрый перевод для черновиков: Google, при ошибке — MyMemory.
async function translateFast(text, signal) {
  try { return await translateGoogle(text, signal); }
  catch (err) {
    if (err.name === 'AbortError') throw err;
    return translateMyMemory(text, signal);
  }
}

let anthropicClient = null;
let anthropicClientKey = null;

async function getClaude() {
  if (!settings.apiKey) throw new Error('Не указан API-ключ Anthropic (Настройки ⚙️)');
  if (!anthropicClient || anthropicClientKey !== settings.apiKey) {
    const { default: Anthropic } = await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm');
    anthropicClient = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
    anthropicClientKey = settings.apiKey;
  }
  return anthropicClient;
}

const CLAUDE_SYSTEM = `Ты синхронный переводчик с иврита на русский.
Тебе приходит расшифровка живой речи, полученная автоматическим распознаванием — в ней бывают ошибки, нет пунктуации, фразы могут обрываться.
Переведи последнюю реплику на естественный разговорный русский, восстанавливая смысл по контексту.
Имена, названия и числа передавай точно. Ответь только переводом, без пояснений и кавычек.`;

// Перевод законченной фразы через Claude со стримингом: onPartial получает текст по мере генерации.
async function translateClaude(text, context, onPartial) {
  const client = await getClaude();
  const prompt = (context.length
    ? 'Предыдущие реплики собеседника (для контекста):\n' + context.join('\n') + '\n\n'
    : '') + 'Переведи реплику:\n' + text;

  const params = {
    model: settings.model,
    max_tokens: 2048,
    system: CLAUDE_SYSTEM,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }],
  };
  // Opus 5.5 / Sonnet 5.5: при отказе классификатора сервер сам повторит запрос на другой модели.
  const useFallbacks = settings.model !== 'claude-haiku-5-5';
  const stream = useFallbacks
    ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : client.messages.stream(params);

  let acc = '';
  stream.on('text', (delta) => { acc += delta; onPartial(acc); });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude отказался переводить фразу');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function translateFinal(text, context, onPartial) {
  switch (settings.provider) {
    case 'claude':
      try { return await translateClaude(text, context, onPartial); }
      catch (err) {
        showError(err.message);
        return translateFast(text);
      }
    case 'mymemory':
      return translateMyMemory(text);
    default:
      return translateFast(text);
  }
}

// ---------------------------------------------------------------- озвучка

let ruVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ru'));
  ruVoice = voices.find((v) => /google|siri|natural|premium|enhanced/i.test(v.name)) || voices[0] || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener('voiceschanged', pickVoice);
}

function speak(text) {
  if (!settings.speak || !('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ru-RU';
  if (ruVoice) u.voice = ruVoice;
  u.rate = Number(settings.rate);
  if (settings.muteWhileSpeaking) {
    u.onstart = () => pauseRecognition(true);
    u.onend = u.onerror = () => { if (!speechSynthesis.pending) pauseRecognition(false); };
  }
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- распознавание речи

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;   // пользователь включил прослушивание
let paused = false;      // временно выключено на время озвучки
let wakeLock = null;

function createRecognition() {
  const rec = new SpeechRecognition();
  rec.lang = 'he-IL';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      const t = r[0].transcript.trim();
      if (!t) continue;
      if (r.isFinal) onFinal(t);
      else interim += (interim ? ' ' : '') + t;
    }
    onInterim(interim);
  };

  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      showError('Нет доступа к микрофону. Разрешите его в настройках браузера.');
      stopListening();
      return;
    }
    if (e.error === 'language-not-supported') {
      showError('Браузер не поддерживает распознавание иврита. Используйте Google Chrome.');
      stopListening();
      return;
    }
    showError('Ошибка распознавания: ' + e.error);
  };

  // Браузер периодически завершает сессию распознавания — сразу перезапускаем.
  rec.onend = () => {
    if (listening && !paused) {
      try { rec.start(); } catch { setTimeout(() => { try { rec.start(); } catch {} }, 250); }
    }
  };
  return rec;
}

async function startListening() {
  if (!SpeechRecognition) return;
  recognition ||= createRecognition();
  listening = true;
  paused = false;
  try { recognition.start(); } catch { /* уже запущено */ }
  setStatus('listening', 'Слушаю…');
  $('micBtn').setAttribute('aria-pressed', 'true');
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* не критично */ }
}

function stopListening() {
  listening = false;
  recognition?.abort();
  setStatus('idle', 'Остановлен');
  $('micBtn').setAttribute('aria-pressed', 'false');
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function pauseRecognition(on) {
  if (!listening) return;
  paused = on;
  if (on) { recognition.abort(); setStatus('idle', 'Озвучиваю…'); }
  else { try { recognition.start(); } catch {} setStatus('listening', 'Слушаю…'); }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && listening && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

// ---------------------------------------------------------------- логика перевода в реальном времени

const history = [];           // { he, ru }
let interimSeq = 0;
let interimTimer = null;
let interimAbort = null;
let lastInterimText = '';
let liveFinalRu = '';         // перевод последней законченной фразы, пока нет новой речи

function onInterim(text) {
  if (text === lastInterimText) return;
  lastInterimText = text;
  renderLiveHe(text);
  if (!text) return;
  if (interimTimer) return;   // троттлинг: не чаще раза в INTERIM_THROTTLE_MS
  interimTimer = setTimeout(runInterimTranslation, INTERIM_THROTTLE_MS);
}

async function runInterimTranslation() {
  interimTimer = null;
  const text = lastInterimText;
  if (!text) return;
  const seq = ++interimSeq;
  interimAbort?.abort();
  interimAbort = new AbortController();
  try {
    const ru = await translateFast(text, interimAbort.signal);
    if (seq === interimSeq && lastInterimText) renderLiveRu(ru, true);
  } catch (err) {
    if (err.name !== 'AbortError') console.warn(err);
  }
}

async function onFinal(he) {
  // Черновик больше не нужен.
  interimSeq++;
  interimAbort?.abort();
  clearTimeout(interimTimer);
  interimTimer = null;
  lastInterimText = '';

  const entry = { he, ru: '' };
  const context = history.slice(-CONTEXT_LINES).map((e) => e.he);
  history.push(entry);
  const el = addHistoryEntry(entry);
  renderLiveHe(he);

  try {
    entry.ru = await translateFinal(he, context, (partial) => {
      updateHistoryEntry(el, { he, ru: partial }, true);
      if (!lastInterimText) renderLiveRu(partial, false);
    });
  } catch (err) {
    showError(err.message);
    entry.ru = '⚠️ не удалось перевести';
  }
  updateHistoryEntry(el, entry, false);
  liveFinalRu = entry.ru;
  if (!lastInterimText) renderLiveRu(entry.ru, false);
  speak(entry.ru);
}

// ---------------------------------------------------------------- UI

function setStatus(state, text) {
  const s = $('status');
  s.dataset.state = state;
  s.textContent = text;
}

let errorTimer = null;
function showError(msg) {
  console.warn(msg);
  setStatus('error', msg);
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    if (listening && !paused) setStatus('listening', 'Слушаю…');
    else if (!listening) setStatus('idle', 'Остановлен');
  }, 5000);
}

function renderLiveRu(text, draft) {
  const box = $('liveRu');
  box.textContent = '';
  const span = document.createElement('span');
  if (draft) span.className = 'draft';
  span.textContent = text;
  box.appendChild(span);
}

function renderLiveHe(text) {
  $('liveHe').textContent = text;
}

function addHistoryEntry(entry) {
  const el = document.createElement('div');
  el.className = 'entry pending';
  el.innerHTML = '<div class="ru"></div><div class="he" dir="rtl" lang="he"></div><div class="meta"></div>';
  el.querySelector('.he').textContent = entry.he;
  el.querySelector('.ru').textContent = '…';
  el.querySelector('.meta').textContent = new Date().toLocaleTimeString('ru-RU');
  $('history').prepend(el);
  return el;
}

function updateHistoryEntry(el, entry, pending) {
  el.classList.toggle('pending', pending);
  el.querySelector('.ru').textContent = entry.ru || '…';
}

function applySettings() {
  document.documentElement.style.setProperty('--font', settings.fontSize + 'px');
  document.body.classList.toggle('hide-he', !settings.showHebrew);
  $('claudeOpts').hidden = settings.provider !== 'claude';
  const sb = $('speakBtn');
  sb.setAttribute('aria-pressed', String(settings.speak));
  sb.firstChild.textContent = settings.speak ? '🔊' : '🔇';
}

function bindSettings() {
  const fields = ['provider', 'model', 'apiKey', 'fontSize', 'rate'];
  for (const f of fields) {
    $(f).value = settings[f];
    $(f).addEventListener('input', () => {
      settings[f] = f === 'fontSize' ? Number($(f).value) : $(f).value.trim();
      saveSettings();
      applySettings();
    });
  }
  for (const f of ['muteWhileSpeaking', 'showHebrew']) {
    $(f).checked = settings[f];
    $(f).addEventListener('change', () => {
      settings[f] = $(f).checked;
      saveSettings();
      applySettings();
    });
  }
}

function init() {
  bindSettings();
  applySettings();

  if (!SpeechRecognition) {
    $('unsupported').hidden = false;
    $('micBtn').disabled = true;
  }

  $('micBtn').addEventListener('click', () => (listening ? stopListening() : startListening()));

  $('speakBtn').addEventListener('click', () => {
    settings.speak = !settings.speak;
    if (!settings.speak) window.speechSynthesis?.cancel();
    else window.speechSynthesis?.speak(new SpeechSynthesisUtterance('')); // разблокировка звука на iOS
    saveSettings();
    applySettings();
  });

  $('clearBtn').addEventListener('click', () => {
    history.length = 0;
    $('history').textContent = '';
    $('liveHe').textContent = '';
    $('liveRu').innerHTML = '<span class="placeholder">История очищена</span>';
  });

  $('settingsBtn').addEventListener('click', () => $('settings').showModal());

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
