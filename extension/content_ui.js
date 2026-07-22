// Isolated-world UI and the only bridge between the page hook and extension APIs.
(() => {
  const BUTTON_ID = 'nova-download-btn';
  const TO_HOOK = '__nova_to_hook';
  const FROM_HOOK = '__nova_from_hook';
  const TO_UI = '__nova_to_ui';
  const FROM_UI = '__nova_from_ui';
  const RELAYED_MESSAGES = new Set(['nova-log', 'nova-fetch-caption']);
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;

  let requestSequence = 1;
  let menu;
  let menuOpening = false;
  let downloadInProgress = false;
  let toastHideTimer;
  let buttonFrame;
  const pendingRequests = new Map();

  function postToPage(payload) {
    window.postMessage(payload, location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || !event.data) return;
    const data = event.data;

    if (data[TO_UI] === true) {
      const { reqId, msg } = data;
      if (!msg || !RELAYED_MESSAGES.has(msg.t)) return;
      chrome.runtime.sendMessage(msg)
        .then((response) => {
          if (Number.isSafeInteger(reqId)) postToPage({ [FROM_UI]: true, reqId, ok: true, resp: response });
        })
        .catch((error) => {
          if (Number.isSafeInteger(reqId)) {
            postToPage({ [FROM_UI]: true, reqId, ok: false, error: String(error?.message || error) });
          }
        });
      return;
    }

    if (data[FROM_HOOK] !== true) return;
    const pending = pendingRequests.get(data.reqId);
    if (!pending) return;
    if (data.progress != null && !data.done) {
      pending.onProgress?.(data);
      return;
    }
    pendingRequests.delete(data.reqId);
    clearTimeout(pending.timeout);
    if (data.ok === false) pending.reject(new Error(data.error || 'page hook failed'));
    else pending.resolve(data);
  });

  function callHook(cmd, payload = {}, onProgress) {
    return new Promise((resolve, reject) => {
      const reqId = requestSequence++;
      const timeoutMs = cmd === 'download' ? 0 : (cmd === 'subtitles' ? 120_000 : 15_000);
      const timeout = timeoutMs ? setTimeout(() => {
        pendingRequests.delete(reqId);
        reject(new Error(`page hook timed out (${cmd})`));
      }, timeoutMs) : undefined;
      pendingRequests.set(reqId, { resolve, reject, onProgress, timeout });
      postToPage({ [TO_HOOK]: true, cmd, reqId, ...payload });
    });
  }

  async function reportError(context, error, details) {
    const text = String(error?.stack || error?.message || error);
    console.error('[Nova Youtube Downloader]', error);
    return chrome.runtime.sendMessage({ t: 'nova-error', context, error: text, details }).catch(() => null);
  }

  function sendRuntimeMessage(message, timeoutMs) {
    if (!timeoutMs) return chrome.runtime.sendMessage(message);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`extension message timed out (${message.t})`)), timeoutMs);
    });
    return Promise.race([chrome.runtime.sendMessage(message), timeout]).finally(() => clearTimeout(timer));
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function createDownloadIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M5 3h14l-7 8z M5 12h14l-7 9z');
    svg.append(path);
    return svg;
  }

  function createButton() {
    const button = createElement('button', 'ytp-button nova-download-btn');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'NYD (Nova Youtube Downloader)';
    button.setAttribute('aria-label', button.title);
    button.append(createDownloadIcon());
    button.addEventListener('click', openMenu);
    return button;
  }

  function ensureButton() {
    if (location.pathname !== '/watch' || document.getElementById(BUTTON_ID)) return;
    const controls = document.querySelector('.ytp-right-controls');
    if (controls) controls.prepend(createButton());
  }

  function scheduleButton() {
    if (buttonFrame) return;
    buttonFrame = requestAnimationFrame(() => {
      buttonFrame = undefined;
      ensureButton();
    });
  }

  function closeMenu() {
    menu?.remove();
    menu = undefined;
    document.removeEventListener('click', closeMenuOnOutsideClick, true);
  }

  function closeMenuOnOutsideClick(event) {
    if (menu && !menu.contains(event.target) && !event.target.closest?.(`#${BUTTON_ID}`)) closeMenu();
  }

  function createHeading(text) {
    return createElement('div', 'nova-menu-head', text);
  }

  function createBrandHeading() {
    const heading = createElement('div', 'nova-menu-head nova-brand-head');
    const label = createElement('span');
    const version = chrome.runtime.getManifest().version;
    const link = createElement('a', null, 't.me/nova_txt');
    link.href = 'https://t.me/nova_txt';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', () => closeMenu());
    label.append(`Nova Youtube Downloader v${version} | `, link);
    heading.append(label);
    return heading;
  }

  function setItemLabel(item, title, description) {
    item.append(createElement('b', null, title));
    if (description) item.append(' ', createElement('span', 'nova-ext', description));
  }

  function addDownloadItems(info) {
    menu.append(createHeading('Качество видео (MP4 / MP3)'));
    const heights = [...new Set(info.heights || [])].sort((a, b) => b - a);
    for (const height of heights) {
      const item = createElement('div', 'nova-menu-item');
      setItemLabel(item, `${height}p`, 'MP4 video');
      item.addEventListener('click', () => {
        closeMenu();
        startDownload({ format: 'mp4', height }, info);
      });
      menu.append(item);
    }

    const mp3 = createElement('div', 'nova-menu-item');
    setItemLabel(mp3, 'MP3', 'звук (аудиодорожка)');
    mp3.addEventListener('click', () => {
      closeMenu();
      startDownload({ format: 'mp3', height: null }, info);
    });
    menu.append(mp3);
  }

  function addSubtitleItems(info, availability) {
    menu.append(createHeading('Субтитры'));
    if (!availability?.available) {
      const item = createElement('div', 'nova-menu-item disabled');
      setItemLabel(item, '.srt', 'недоступны');
      item.title = 'Субтитры недоступны для этого видео';
      menu.append(item);
      return;
    }

    const language = availability.lang || 'доступный';
    const formats = [
      ['.srt', 'srt', 'SRT (с тайм-кодами)'],
      ['.vtt', 'vtt', 'VTT (с тайм-кодами)'],
      ['.txt', 'txt', 'простой текст (без тайм-кодов)'],
    ];
    for (const [extension, format, description] of formats) {
      const item = createElement('div', 'nova-menu-item');
      setItemLabel(item, extension, `${language} · ${description}`);
      item.addEventListener('click', () => {
        closeMenu();
        downloadSubtitles(info, format);
      });
      menu.append(item);
    }
  }

  function addFormatSelector(transcode) {
    menu.append(createHeading('Формат видео'));
    const formats = [
      { value: false, title: 'Современный кодек (VP9)', note: 'быстро, без перекодирования' },
      { value: true, title: 'Кодек H.264 (перекодирование)', note: 'медленно, но совместимо с устаревшими плеерами' },
    ];
    let selected = Boolean(transcode);
    const rows = formats.map((format) => {
      const row = createElement('div', `nova-menu-radio${selected === format.value ? ' sel' : ''}`);
      const text = createElement('span', 'nova-radio-txt');
      text.append(createElement('b', null, format.title), createElement('i', null, format.note));
      row.append(createElement('span', 'nova-dot'), text);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        selected = format.value;
        chrome.storage.local.set({ transcode: selected }).catch((error) => reportError('ui/settings', error));
        rows.forEach((item, index) => item.classList.toggle('sel', formats[index].value === selected));
      });
      return row;
    });
    menu.append(...rows);
  }

  async function openMenu(event) {
    event.stopPropagation();
    if (menu) {
      closeMenu();
      return;
    }
    if (menuOpening) return;
    menuOpening = true;

    try {
      const [info, availability, settings] = await Promise.all([
        callHook('info'),
        callHook('subs-available'),
        chrome.storage.local.get('transcode'),
      ]);
      menu = createElement('div', 'nova-menu');
      menu.append(createBrandHeading());
      addDownloadItems(info);
      addSubtitleItems(info, availability);
      addFormatSelector(settings.transcode);
      document.body.append(menu);

      const buttonRect = document.getElementById(BUTTON_ID)?.getBoundingClientRect();
      if (buttonRect) {
        menu.style.right = `${Math.max(8, window.innerWidth - buttonRect.right)}px`;
        menu.style.bottom = `${window.innerHeight - buttonRect.top + 8}px`;
      }
      setTimeout(() => document.addEventListener('click', closeMenuOnOutsideClick, true));
    } catch (error) {
      const notification = getToast();
      notification.set(`Ошибка: ${error.message || error}`, 1);
      notification.hide(6000);
      await reportError('ui/menu', error);
    } finally {
      menuOpening = false;
    }
  }

  function getToast() {
    let box = document.getElementById('nova-toast');
    if (!box) {
      box = createElement('div');
      box.id = 'nova-toast';
      const bar = createElement('div', 'nova-toast-bar');
      bar.append(createElement('i'));
      box.append(bar, createElement('span', 'nova-toast-txt'));
      document.body.append(box);
    }
    const text = box.querySelector('.nova-toast-txt');
    const progress = box.querySelector('.nova-toast-bar i');
    return {
      set(message, fraction = 0) {
        clearTimeout(toastHideTimer);
        text.textContent = message;
        progress.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
        box.classList.add('show');
      },
      hide(delay = 0) {
        clearTimeout(toastHideTimer);
        toastHideTimer = setTimeout(() => box.classList.remove('show'), delay);
      },
    };
  }

  function safeFilename(value) {
    return (value || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function formatCueTime(seconds, separator) {
    const value = Math.max(0, seconds);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const wholeSeconds = Math.floor(value % 60);
    const milliseconds = Math.floor((value - Math.floor(value)) * 1000);
    const pad = (number, length = 2) => String(number).padStart(length, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}${separator}${pad(milliseconds, 3)}`;
  }

  function normalizeCues(cues) {
    if (!Array.isArray(cues)) return [];
    const sorted = cues
      .filter((cue) => cue?.text?.trim())
      .map((cue) => ({ start: Number(cue.start) || 0, end: Number(cue.end) || 0, text: cue.text.trim() }))
      .sort((a, b) => a.start - b.start);

    return sorted.map((cue, index) => {
      const next = sorted[index + 1];
      const minimumDuration = Math.max(1.2, Math.min(6, cue.text.length * 0.07));
      if (next && next.start <= cue.start) next.start = cue.start + 0.5;
      const end = next
        ? Math.max(cue.start + minimumDuration, Math.min(next.start, cue.start + 5))
        : Math.max(cue.start + minimumDuration, cue.end || cue.start + 4);
      return { ...cue, end };
    });
  }

  function buildTimedSubtitles(cues, format) {
    const lines = format === 'vtt' ? ['WEBVTT', ''] : [];
    normalizeCues(cues).forEach((cue, index) => {
      if (format !== 'vtt') lines.push(String(index + 1));
      const separator = format === 'vtt' ? '.' : ',';
      lines.push(`${formatCueTime(cue.start, separator)} --> ${formatCueTime(cue.end, separator)}`);
      lines.push(cue.text, '');
    });
    return `${lines.join('\r\n').replace(/(\r?\n)+$/, '')}\r\n`;
  }

  const SUBTITLE_OUTPUTS = Object.freeze({
    srt: { extension: 'srt', mime: 'application/x-subrip', timed: true },
    vtt: { extension: 'vtt', mime: 'text/vtt', timed: true },
    txt: { extension: 'txt', mime: 'text/plain', timed: false },
  });

  async function downloadSubtitles(info, format) {
    const notification = getToast();
    notification.set(`Загружаю субтитры (${format || 'txt'})…`, 0.3);
    try {
      const output = SUBTITLE_OUTPUTS[format];
      if (!output) throw new Error(`неизвестный формат субтитров: ${format}`);
      const response = await callHook('subtitles');
      const language = response.lang || 'txt';
      if (output.timed && !response.cues?.length) {
        throw new Error(`не удалось сформировать .${output.extension}: отсутствуют таймкоды`);
      }
      const content = output.timed ? buildTimedSubtitles(response.cues, output.extension) : response.text;
      const filename = `${safeFilename(info.title)} [${language}].${output.extension}`;
      const url = `data:${output.mime};charset=utf-8,${encodeURIComponent(`\uFEFF${content}`)}`;
      const saved = await chrome.runtime.sendMessage({ t: 'nova-save', url, filename });
      if (!saved?.ok) throw new Error(saved?.error || 'не удалось сохранить субтитры');
      notification.set(`Готово: ${filename}`, 1);
      notification.hide(4000);
    } catch (error) {
      notification.set(`Ошибка: ${error.message || error}`, 1);
      notification.hide(6000);
      await reportError('ui/subtitles', error, { format, videoId: info.videoId });
    }
  }

  async function startDownload({ format, height }, info) {
    const notification = getToast();
    if (downloadInProgress) {
      notification.set('Другая загрузка уже выполняется', 1);
      notification.hide(4000);
      return;
    }
    downloadInProgress = true;

    const isMp3 = format === 'mp3';
    const label = isMp3 ? 'MP3' : `${height}p`;
    notification.set(`Загружаю ${label} в фоне (без прерывания просмотра)…`, 0.02);
    let scaleMismatch = false;
    const jobId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

    const onFfmpegProgress = (message) => {
      if (message?.t !== 'nova-progress' || message.jobId !== jobId) return;
      const value = Math.max(0, Math.min(1, message.value || 0));
      const percent = Number.isFinite(message.percent) ? message.percent : value * 100;
      const percentText = `${Math.max(0, Math.min(100, percent)).toFixed(percent < 100 ? 1 : 0)}%`;
      const fallback = isMp3
        ? 'Кодирование MP3…'
        : (scaleMismatch ? 'Масштабирование видео…' : 'Перекодирование в H.264/AAC…');
      notification.set(`${message.status || fallback} ${percentText}`, value);
    };
    chrome.runtime.onMessage.addListener(onFfmpegProgress);

    try {
      const { transcode = false } = await chrome.storage.local.get('transcode');
      const captured = await callHook('download', { height, format, end: Math.floor(info.duration || 0) }, (message) => {
        notification.set(`Загрузка сегментов ${label}… ${Math.round(message.progress * 100)}%`, message.progress * 0.4);
      });

      scaleMismatch = !isMp3 && captured.actualHeight && captured.actualHeight !== height;
      const shouldTranscode = isMp3 || Boolean(transcode) || scaleMismatch;
      const status = isMp3
        ? 'Кодирование MP3…'
        : (scaleMismatch ? 'Масштабирование видео…' : (shouldTranscode ? 'Перекодирование в H.264/AAC…' : 'Склейка дорожек…'));
      notification.set(status, 0);

      const extension = isMp3 ? '.mp3' : '.mp4';
      const filename = `${safeFilename(info.title)}${isMp3 ? '' : ` [${height}p]`}${extension}`;
      const result = await muxViaOffscreen({
        jobId,
        format,
        video: isMp3 ? null : captured._v,
        audio: captured._a,
        videoMime: captured.video?.mime,
        audioMime: captured.audio?.mime,
        filename,
        transcode: shouldTranscode,
        scaleHeight: scaleMismatch ? height : 0,
        duration: Number(captured.duration) || Number(info.duration) || 0,
      });
      if (!result?.ok) {
        const error = new Error(result?.error || 'не удалось собрать файл');
        error.logged = Boolean(result?.logged);
        throw error;
      }
      notification.set(`Готово: ${result.filename || filename}`, 1);
      notification.hide(4000);
    } catch (error) {
      const detail = String(error?.stack || error?.message || error);
      notification.set(`Ошибка: ${detail.split('\n').slice(0, 3).join(' ').slice(0, 280)}`, 1);
      notification.hide(9000);
      if (!error?.logged) await reportError('ui/download', error, { format, height, videoId: info.videoId });
    } finally {
      chrome.runtime.onMessage.removeListener(onFfmpegProgress);
      downloadInProgress = false;
    }
  }

  function encodeBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
    }
    return btoa(binary);
  }

  async function muxViaOffscreen(job) {
    const jobId = job.jobId;
    let begun = false;
    try {
      const ensured = await sendRuntimeMessage({ t: 'nova-ensure' }, 30_000);
      if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');

      const registration = await sendRuntimeMessage({ t: 'nova-register-job', jobId }, 10_000);
      if (!registration?.ok || !Number.isInteger(registration.tabId)) {
        throw new Error(registration?.error || 'не удалось определить вкладку загрузки');
      }

      const started = await sendRuntimeMessage({
        t: 'nova-begin', jobId, tabId: registration.tabId,
        filename: job.filename, format: job.format,
        videoMime: job.videoMime, audioMime: job.audioMime,
        transcode: job.transcode, scaleHeight: job.scaleHeight, duration: job.duration,
      }, 30_000);
      if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');
      begun = true;

      const sendTrack = async (track, buffer) => {
        if (!buffer) return;
        const bytes = new Uint8Array(buffer);
        for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
          const chunk = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
          const response = await sendRuntimeMessage({
            t: 'nova-chunk', jobId, track, b64: encodeBase64(chunk),
          }, 60_000);
          if (!response?.ok) throw new Error(response?.error || `передача данных прервалась (${track})`);
        }
      };

      await sendTrack('video', job.video);
      await sendTrack('audio', job.audio);
      return await sendRuntimeMessage({ t: 'nova-finalize', jobId }, 2 * 60 * 60_000);
    } catch (error) {
      if (begun) await sendRuntimeMessage({ t: 'nova-abort', jobId }, 10_000).catch(() => {});
      throw error;
    }
  }

  new MutationObserver(scheduleButton).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', scheduleButton);
  scheduleButton();
})();
