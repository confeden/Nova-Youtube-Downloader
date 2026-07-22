// Service worker: owns the offscreen document, persistent diagnostics and
// browser downloads. ffmpeg.wasm itself runs in offscreen.html.

const LOG_KEY = 'nova_logs';
const LOG_LIMIT = 200;
const LOG_ENTRY_LIMIT = 4_000;
const ERROR_DETAIL_LIMIT = 50_000;
const ERROR_LOG_FILENAME = 'NYD-debug.txt';
const HANDLED_MESSAGES = new Set([
  'nova-log',
  'nova-error',
  'nova-ensure',
  'nova-save',
  'nova-fetch-caption',
  'nova-register-job',
  'nova-progress',
]);

let offscreenCreation;
let logWrite = Promise.resolve();

function serialize(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function truncate(value, limit) {
  const text = serialize(value) || '';
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toISOString();
}

function appendLog(entry) {
  // Serialize read-modify-write operations so concurrent content-script logs
  // cannot overwrite one another in chrome.storage.local.
  logWrite = logWrite
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(LOG_KEY);
      const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      logs.push(entry);
      await chrome.storage.local.set({ [LOG_KEY]: logs.slice(-LOG_LIMIT) });
    });
  return logWrite;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Run ffmpeg.wasm to assemble captured media tracks.',
    }).finally(() => { offscreenCreation = undefined; });
  }
  await offscreenCreation;
}

async function saveDownload(url, filename) {
  if (typeof url !== 'string' || !url) throw new Error('download URL is missing');
  if (typeof filename !== 'string' || !filename) throw new Error('download filename is missing');
  return chrome.downloads.download({ url, filename, saveAs: false });
}

function validateCaptionUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/api/timedtext') {
    throw new Error('caption URL is not allowed');
  }
  return url.href;
}

async function downloadErrorLog(message, sender) {
  await logWrite.catch(() => {});
  const stored = await chrome.storage.local.get(LOG_KEY).catch(() => ({}));
  const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  const report = [
    'Nova Youtube Downloader error report',
    `Time: ${new Date().toISOString()}`,
    `Context: ${message.context || 'unknown'}`,
    `Page: ${sender?.tab?.url || 'extension'}`,
    '',
    truncate(message.error || 'Unknown error', ERROR_DETAIL_LIMIT),
    message.details ? `\nDetails:\n${truncate(message.details, ERROR_DETAIL_LIMIT)}` : '',
    logs.length ? `\nRecent logs:\n${logs.map((entry) =>
      `[${formatTimestamp(entry?.ts)}] [${entry?.tag || 'log'}] ${entry?.text || ''}`
    ).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(`\uFEFF${report}\n`)}`;
  const id = await saveDownload(url, ERROR_LOG_FILENAME);
  return { ok: true, id, filename: ERROR_LOG_FILENAME };
}

async function handleMessage(message, sender) {
  switch (message.t) {
    case 'nova-log':
      await appendLog({
        ts: Date.now(),
        tag: message.tag,
        text: truncate(message.text, LOG_ENTRY_LIMIT),
        tab: sender?.tab?.id,
        frame: sender?.frameId,
      });
      return { ok: true };

    case 'nova-error':
      return downloadErrorLog(message, sender);

    case 'nova-ensure':
      await ensureOffscreen();
      return { ok: true };

    case 'nova-save': {
      const id = await saveDownload(message.url, message.filename);
      return { ok: true, id };
    }

    case 'nova-fetch-caption': {
      const response = await fetch(validateCaptionUrl(message.url), {
        credentials: 'include',
        referrer: 'https://www.youtube.com/',
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, len: text.length, text };
    }

    case 'nova-register-job':
      if (!Number.isInteger(sender?.tab?.id)) throw new Error('download tab is unavailable');
      return { ok: true, tabId: sender.tab.id };

    case 'nova-progress': {
      if (sender?.url !== chrome.runtime.getURL('offscreen.html')) {
        throw new Error('progress messages are only accepted from the media processor');
      }
      if (!Number.isInteger(message.tabId)) throw new Error('progress tab is unavailable');
      await chrome.tabs.sendMessage(message.tabId, {
        t: 'nova-progress',
        jobId: message.jobId,
        value: message.value,
        percent: message.percent,
        ...(message.status ? { status: message.status } : {}),
      });
      return { ok: true };
    }

    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !HANDLED_MESSAGES.has(message.t)) return false;

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: serialize(error?.stack || error) }));
  return true;
});
