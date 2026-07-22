// content_hook.js — runs in the PAGE (MAIN world) at document_start.
// Modern YouTube streams separate SABR tracks. This hook passively captures the
// player's ordered media bytes from SourceBuffer, then briefly advances
// the buffer edge only when the requested tail has not been loaded yet.

(function () {
  if (window.__novaHookInstalled) return;
  window.__novaHookInstalled = true;

  const TO_UI = '__nova_to_ui';
  const FROM_UI = '__nova_from_ui';
  const TO_HOOK = '__nova_to_hook';
  const FROM_HOOK = '__nova_from_hook';
  let backgroundRequestSequence = 1;
  const backgroundRequests = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data[FROM_UI] !== true) return;
    const request = backgroundRequests.get(ev.data.reqId);
    if (request) {
      backgroundRequests.delete(ev.data.reqId);
      clearTimeout(request.timeout);
      if (ev.data.ok === false) request.reject(new Error(ev.data.error || 'extension bridge failed'));
      else request.resolve(ev.data.resp);
    }
  });

  function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      const reqId = backgroundRequestSequence++;
      const timeout = setTimeout(() => {
        backgroundRequests.delete(reqId);
        reject(new Error('extension bridge timed out'));
      }, 30_000);
      backgroundRequests.set(reqId, { resolve, reject, timeout });
      window.postMessage({ [TO_UI]: true, reqId, msg }, location.origin);
    });
  }

  function sendLog(msg) {
    window.postMessage({ [TO_UI]: true, msg }, location.origin);
  }

  function log(tag, ...args) {
    try {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      console.log('[NOVA ' + tag + '] ' + text);
      sendLog({ t: 'nova-log', tag, text });
    } catch (e) {}
  }

  const store = {
    videoId: null,
    capturing: false,
    tracks: Object.create(null),
    _lastInit: Object.create(null),
    _pendingInit: Object.create(null),
  };

  function vidId() {
    try {
      const q = new URLSearchParams(location.search).get('v');
      if (q) return q;
      // embed / watch URLs: /embed/VIDEO_ID or /shorts/VIDEO_ID
      const m = location.pathname.match(/\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }
  function resetCapture() {
    store.tracks = Object.create(null);
    store._lastInit = Object.create(null);
    store._pendingInit = Object.create(null);
  }

  const isAv1 = (s) => typeof s === 'string' && /av01|av1\b/i.test(s);
  try {
    const origITS = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) => (isAv1(type) ? false : origITS(type));
  } catch (e) {}
  try {
    const proto = HTMLMediaElement.prototype;
    const origCPT = proto.canPlayType;
    proto.canPlayType = function (type) { return isAv1(type) ? '' : origCPT.call(this, type); };
  } catch (e) {}

  function u8of(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }
  function startsWithInit(u8) {
    if (u8.length >= 4 && u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) return true;
    if (u8.length >= 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return true;
    return false;
  }
  function rememberTimedText(text) {
    if (!text || text.length <= 5) return;
    const captured = window.__nova_captured_timedtext ||= [];
    captured.push(text);
    if (captured.length > 20) captured.splice(0, captured.length - 20);
  }

  function rememberTranscriptParams(text) {
    if (!text) return;
    const params = window.__nova_next_params ||= [];
    const pattern = /"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/g;
    for (const match of text.matchAll(pattern)) params.push(match[1]);
    if (params.length > 50) params.splice(0, params.length - 50);
  }

  async function inspectFetchResponse(response, url) {
    try {
      if (/youtube\.com\/api\/timedtext/.test(url)) {
        rememberTimedText(await response.clone().text());
      } else if (/youtubei\/v1\/(?:next|engage)/.test(url)) {
        rememberTranscriptParams(await response.clone().text());
      }
    } catch (e) {}
  }

  const OrigFetch = window.fetch ? window.fetch.bind(window) : null;
  if (OrigFetch) {
    window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      return OrigFetch(input, init).then((response) => {
        inspectFetchResponse(response, url);
        return response;
      });
    };
  }

  try {
    const xhrUrl = Symbol('novaUrl');
    const xhrWrapped = Symbol('novaWrapped');
    const OrigXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (!this[xhrWrapped]) {
        this.addEventListener('load', function () {
          const url = this[xhrUrl] || this.responseURL || '';
          try {
            if (/youtube\.com\/api\/timedtext/.test(url)) {
              rememberTimedText(this.responseText);
            } else if (/youtubei\/v1\/(?:next|engage)/.test(url)) {
              rememberTranscriptParams(this.responseText);
            }
          } catch (e) {}
        });
        this[xhrWrapped] = true;
      }
      return OrigXHRSend.apply(this, arguments);
    };
    const OrigXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (_method, url) {
      this[xhrUrl] = String(url || '');
      return OrigXHROpen.apply(this, arguments);
    };
  } catch (e) {}

  // ---- ordered media capture -------------------------------------------------
  const OrigAddSB = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = OrigAddSB.call(this, mime);
    try {
      sb.__novaMime = mime;
      sb.__novaKind = /audio/i.test(mime) ? 'audio' : (/video/i.test(mime) ? 'video' : null);
    } catch (e) {}
    return sb;
  };
  const OrigAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const kind = this.__novaKind;
      if ((kind === 'video' || kind === 'audio') && store.capturing) {
        const u8 = u8of(data);
        if (u8 && u8.length) {
          const init = startsWithInit(u8);
          const mime = this.__novaMime || '';
          if (init) {
            const bytes = u8.slice();
            store._lastInit[kind] = { bytes, mime };
            if (store.tracks[kind]) {
              // Keep the complete previous representation until the first media
              // fragment for the new one arrives; an init-only file is unusable.
              store._pendingInit[kind] = { bytes, mime };
            } else {
              store.tracks[kind] = { mime, parts: [bytes] };
            }
          } else {
            const pendingInit = store._pendingInit[kind];
            let t;
            if (pendingInit) {
              // Atomically switch representations so bytes from different fMP4
              // tracks never share one output file.
              t = store.tracks[kind] = { mime: mime || pendingInit.mime, parts: [pendingInit.bytes, u8.slice()] };
              delete store._pendingInit[kind];
            } else {
              t = store.tracks[kind];
            }
            if (!t) {
              const savedInit = store._lastInit[kind];
              if (savedInit) t = store.tracks[kind] = { mime: mime || savedInit.mime, parts: [savedInit.bytes, u8.slice()] };
            } else if (!pendingInit) t.parts.push(u8.slice());
          }
        }
      }
    } catch (e) {}
    return OrigAppend.apply(this, arguments);
  };

  function assemble() {
    const out = {};
    for (const kind of ['audio', 'video']) {
      const t = store.tracks[kind];
      if (!t || !t.parts.length) continue;
      let initIndex = -1;
      for (let index = 0; index < t.parts.length; index++) {
        if (startsWithInit(t.parts[index])) initIndex = index;
      }
      let parts = initIndex >= 0 ? t.parts.slice(initIndex) : t.parts;
      if (!startsWithInit(parts[0]) && store._lastInit[kind]) {
        parts = [store._lastInit[kind].bytes, ...parts];
      }
      if (!startsWithInit(parts[0])) {
        throw new Error(`дорожка ${kind} не содержит инициализационный сегмент`);
      }
      let n = 0; for (const p of parts) n += p.length;
      const buf = new Uint8Array(n);
      let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
      out[kind] = { bytes: buf, mime: t.mime };
    }
    return out;
  }

  // ---- player helpers ------------------------------------------------------
  function player() { return document.getElementById('movie_player'); }
  function video() { return document.querySelector('video'); }
  const QUALITY_BY_HEIGHT = { 2160: 'hd2160', 1440: 'hd1440', 1080: 'hd1080', 720: 'hd720', 480: 'large', 360: 'medium', 240: 'small', 144: 'tiny' };
  const HEIGHT_BY_QUALITY = Object.fromEntries(Object.entries(QUALITY_BY_HEIGHT).map(([height, quality]) => [quality, Number(height)]));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function setQualityRaw(q) {
    const p = player();
    try { p.setPlaybackQualityRange && p.setPlaybackQualityRange(q, q); } catch (e) {}
    try { p.setPlaybackQuality && p.setPlaybackQuality(q); } catch (e) {}
  }
  function availableHeights() {
    try {
      return (player().getAvailableQualityLevels() || []).map((quality) => HEIGHT_BY_QUALITY[quality]).filter(Boolean);
    } catch (e) { return []; }
  }
  function currentQuality() {
    try {
      const quality = player().getPlaybackQuality?.();
      return HEIGHT_BY_QUALITY[quality] || null;
    } catch (e) { return null; }
  }
  function keepAutoplayOff() {
    try {
      const btn = document.querySelector('.ytp-autonav-toggle-button');
      if (!btn) return false;
      if (btn.getAttribute('aria-checked') === 'true') btn.click();
      return true;
    } catch (e) { return false; }
  }

  // ---- capture ---------------------------------------------------------------
  // Strategy: the appendBuffer hook captures bytes as the YouTube player buffers.
  // We turn capturing ON at page load, so simply WATCHING the video passively
  // accumulates the stream into store.tracks. On download we only need to pull
  // whatever the user hasn't buffered yet — via a single gentle seek-fill on the
  // visible player. If the whole video is already buffered (e.g. user watched it),
  // there is NO seek at all -> zero interruption.
  async function captureBackground(opts, onProgress) {
    const isMp3 = opts.isMp3;
    const targetQ = opts.targetQ;
    const needVideo = !isMp3;
    const capId = vidId();
    log('capture', 'start; mp3=', isMp3, 'q=', targetQ, 'ctx=', (location.pathname.indexOf('/embed/') === 0 ? 'embed' : 'page'));
    const v = video();
    if (!v) throw new Error('video element not found');
    let dur = v.duration;
    if (!isFinite(dur) || dur <= 0) {
      await new Promise((res) => {
        const done = () => { if (v) { v.removeEventListener('loadedmetadata', done); v.removeEventListener('durationchange', done); } res(); };
        if (v) { v.addEventListener('loadedmetadata', done, { once: true }); v.addEventListener('durationchange', done, { once: true }); }
        setTimeout(res, 4000);
      });
      dur = v && v.duration;
    }
    if (!isFinite(dur) || dur <= 0) throw new Error('duration unknown');
    const capEnd = Math.min(opts.end && opts.end > 0 ? opts.end : dur, dur);

    store.capturing = true; // passive + active capture via appendBuffer hook
    keepAutoplayOff();
    // Request target quality so the captured track is the desired one.
    setQualityRaw(targetQ);
    // SABR often ignores setPlaybackQuality; wait (up to ~6s) for the player to
    // actually switch to the requested quality before we start capturing.
    const wantQ = QUALITY_BY_HEIGHT[opts.height] || null;
    if (wantQ && needVideo) {
      for (let i = 0; i < 30; i++) {
        if (currentQuality() === opts.height) break;
        await sleep(200);
      }
      const got = currentQuality();
      if (got && got !== opts.height) {
        log('capture', 'requested ' + opts.height + 'p but player is on ' + got + 'p (SABR ignored request)');
      }
    }
    // Wait for the init segment(s) of the track(s) we need.
    for (let i = 0; i < 40; i++) {
      const okA = !!store.tracks.audio;
      const okV = needVideo ? !!store.tracks.video : true;
      if (okA && okV) break;
      await sleep(150);
    }

    // Contiguous buffered end measured from 0 (handles a single forward buffer).
    const bufferedEnd = () => {
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= end + 0.5) end = Math.max(end, v.buffered.end(i));
      }
      return end;
    };

    // Snapshot where the user was, restore it at the very end.
    const prev = { paused: v.paused, rate: v.playbackRate, time: v.currentTime, muted: v.muted };

    // Already fully buffered up to the capture end? Nothing to fetch -> no seek.
    if (bufferedEnd() >= capEnd - 1.0) {
      onProgress(1);
      return { actualHeight: currentQuality(), duration: capEnd };
    }

    // Only seek-fill the NOT-yet-buffered tail (from the buffered edge to the
    // end). Everything already buffered was captured passively and is kept in
    // store.tracks, so we never re-fetch the beginning. This keeps the seek
    // pass as short as possible.
    const seekTo = (sec) => { try { const p = player(); if (p && p.seekTo) { p.seekTo(sec, true); return; } } catch (e) {} try { v.currentTime = sec; } catch (e) {} };
    let cursor = bufferedEnd();
    try { v.muted = true; } catch (e) {}

    try {
      while (true) {
        await sleep(350);
        if (vidId() !== capId) throw new Error('видео переключилось');
        try { if (!v.paused) v.pause(); } catch (e) {}
        const edge = bufferedEnd();
        onProgress(Math.min(0.99, edge / capEnd));
        if (edge >= capEnd - 0.6) break;
        if (edge > cursor + 0.3) { cursor = edge; seekTo(Math.min(cursor, capEnd - 0.1)); }
        else if (cursor < capEnd - 0.5) { seekTo(Math.min(cursor + 0.5, capEnd - 0.1)); }
        else break;
      }
    } finally {
      // Restore the user's exact position and play state immediately.
      try { v.playbackRate = prev.rate; } catch (e) {}
      seekTo(prev.time);
      try { v.muted = prev.muted; } catch (e) {}
      if (!prev.paused) { try { v.play(); } catch (e) {} }
    }
    onProgress(1);
    return { actualHeight: currentQuality(), duration: capEnd };
  }

  // ---- subtitles ------------------------------------------------------------
  function playerResponse() {
    try {
      const p = player();
      const r = p && p.getPlayerResponse && p.getPlayerResponse();
      if (r && r.captions) return r;  // live response with captions — best
      if (r && r.streamingData) return r;  // live response with streaming — ok
    } catch (e) {}
    return window.ytInitialPlayerResponse || null;
  }
  function captionTracks() {
    const pr = playerResponse();
    const tl = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    if (tl && Array.isArray(tl.captionTracks) && tl.captionTracks.length) {
      return tl.captionTracks;
    }
    const initPr = window.ytInitialPlayerResponse;
    const initTl = initPr && initPr.captions && initPr.captions.playerCaptionsTracklistRenderer;
    if (initTl && Array.isArray(initTl.captionTracks) && initTl.captionTracks.length) {
      return initTl.captionTracks;
    }
    try {
      const p = player();
      if (p && p.getOption) {
        const list = p.getOption('captions', 'tracklist');
        if (Array.isArray(list) && list.length) return list;
      }
    } catch (e) {}
    return [];
  }
  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const matches = (t, code, asr) => {
      const l = getTrackLang(t).toLowerCase();
      const k = getTrackKind(t);
      const isAsr = k === 'asr';
      const langMatch = l === code.toLowerCase() || l.startsWith(code.toLowerCase() + '-');
      return langMatch && (asr === null || isAsr === asr);
    };

    return tracks.find(t => matches(t, 'ru', false)) ||
           tracks.find(t => matches(t, 'ru', true)) ||
           tracks.find(t => matches(t, 'en', false)) ||
           tracks.find(t => matches(t, 'en', true)) ||
           tracks.find(t => matches(t, 'ru', null)) ||
           tracks.find(t => matches(t, 'en', null)) ||
           tracks[0];
  }
  function parseJson3(j) {
    const lines = []; let buf = '';
    for (const ev of (j.events || [])) {
      if (!ev.segs) continue;
      const piece = ev.segs.map(s => s.utf8 || '').join(' ').replace(/\n/g, ' ').trim();
      if (!piece) { if (buf) { lines.push(buf); buf = ''; } continue; }
      buf = buf ? buf + ' ' + piece : piece;
    }
    if (buf) lines.push(buf);
    return lines.filter(Boolean);
  }
  // Parse json3 into timed cues (start/end in seconds, text). Returns [] if the
  // payload has no timing info. This is what lets us emit SRT/VTT.
  function parseJson3Cues(j) {
    const cues = [];
    for (const ev of (j.events || [])) {
      if (!ev.segs) continue;
      const piece = ev.segs.map(s => s.utf8 || '').join(' ').replace(/\n/g, ' ').trim();
      if (!piece) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const end = ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000;
      cues.push({ start, end, text: piece });
    }
    return cues;
  }
  function parseVttOrSrt(text) {
    if (!text || (!text.includes('-->') && !text.includes('WEBVTT'))) return null;
    const lines = text.split(/\r?\n/);
    const cues = [];
    const plainLines = [];
    let i = 0;
    const timeRe = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;
    const toSec = (h, m, s, ms) => (parseInt(h || '0', 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10) + (parseInt(ms, 10) / 1000);

    while (i < lines.length) {
      const line = lines[i].trim();
      const m = timeRe.exec(line);
      if (m) {
        const start = toSec(m[1], m[2], m[3], m[4]);
        const end = toSec(m[5], m[6], m[7], m[8]);
        i++;
        const textParts = [];
        while (i < lines.length && lines[i].trim() !== '') {
          const t = lines[i].replace(/<[^>]+>/g, '').trim();
          if (t) textParts.push(t);
          i++;
        }
        if (textParts.length) {
          const cueText = textParts.join(' ');
          cues.push({ start, end, text: cueText });
          plainLines.push(cueText);
        }
      } else {
        i++;
      }
    }
    return cues.length ? { cues, lines: plainLines } : null;
  }

  function parseXmlCues(text) {
    if (!text || (!text.includes('<text') && !text.includes('<p') && !text.includes('<s '))) return null;
    const cues = [];
    const plainLines = [];

    const re = /<(text|p|s)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m;
    const parseTimeAttr = (val) => {
      if (!val) return 0;
      if (val.includes(':')) {
        const parts = val.split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
      }
      const num = parseFloat(val.replace('s', ''));
      return Number.isNaN(num) ? 0 : num;
    };

    while ((m = re.exec(text)) !== null) {
      const attrs = m[2];
      const rawText = m[3].replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/\s+/g, ' ').trim();
      if (!rawText) continue;

      let start = 0, end = 0;
      const startMatch = /start="([^"]+)"/i.exec(attrs) || /begin="([^"]+)"/i.exec(attrs) || /t="([^"]+)"/i.exec(attrs);
      const durMatch = /dur="([^"]+)"/i.exec(attrs) || /d="([^"]+)"/i.exec(attrs);
      const endMatch = /end="([^"]+)"/i.exec(attrs);

      if (startMatch) {
        start = parseTimeAttr(startMatch[1]);
        if (startMatch[0].startsWith('t=')) start = start / 1000;
      }
      if (durMatch) {
        let dur = parseTimeAttr(durMatch[1]);
        if (durMatch[0].startsWith('d=')) dur = dur / 1000;
        end = start + dur;
      } else if (endMatch) {
        end = parseTimeAttr(endMatch[1]);
      } else {
        end = start + 3.0;
      }

      cues.push({ start, end, text: rawText });
      plainLines.push(rawText);
    }
    return cues.length ? { cues, lines: plainLines } : null;
  }

  function tryParse(text, track) {
    if (!text || typeof text !== 'string') return null;
    const lang = getTrackLang(track);

    // 1. Try JSON3
    try {
      const j = JSON.parse(text);
      if (j && j.events) {
        const cues = parseJson3Cues(j);
        const lines = parseJson3(j);
        if (lines.length) return { cues, lines, lang };
      }
    } catch (e) {}

    // 2. Try WebVTT / SRT
    const vttRes = parseVttOrSrt(text);
    if (vttRes && vttRes.lines.length) {
      return { cues: vttRes.cues, lines: vttRes.lines, lang };
    }

    // 3. Try XML / TTML
    const xmlRes = parseXmlCues(text);
    if (xmlRes && xmlRes.lines.length) {
      return { cues: xmlRes.cues, lines: xmlRes.lines, lang };
    }

    return null;
  }

  // Helper: check if a base64-encoded protobuf params string contains the videoId
  function b64Contains(b64str, needle) {
    if (!b64str || !needle) return false;
    // Method 1: The videoId is stored as a protobuf length-prefixed string.
    // Encode it the same way and check for substring match in the base64.
    try {
      const encoded = btoa(String.fromCharCode(needle.length) + needle).replace(/=+$/, '');
      if (b64str.includes(encoded)) return true;
    } catch(e) {}
    // Method 2: Try to fully decode and search
    try {
      let s = b64str;
      try { s = decodeURIComponent(s); } catch(e) {}
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      if (atob(s).includes(needle)) return true;
    } catch(e) {}
    return false;
  }

  function getInnertubeCfg(key) {
    try { if (window.ytcfg && typeof window.ytcfg.get === 'function' && window.ytcfg.get(key)) return window.ytcfg.get(key); } catch(e) {}
    try { if (window.ytcfg && window.ytcfg.d && window.ytcfg.d[key]) return window.ytcfg.d[key]; } catch(e) {}
    try { if (window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_[key]) return window.ytcfg.data_[key]; } catch(e) {}
    try { if (window.yt && window.yt.config_ && window.yt.config_[key]) return window.yt.config_[key]; } catch(e) {}
    try {
      const match = document.documentElement.innerHTML.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]+)"'));
      if (match) return match[1];
    } catch(e) {}
    return null;
  }

  // ---- innertube transcript fetch (modern YouTube POST API) -----------------
  function encodeVarInt(value) {
    const bytes = [];
    while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value >>>= 7; }
    bytes.push(value & 0x7f);
    return bytes;
  }
  function pbString(fieldNum, str) {
    const tag = (fieldNum << 3) | 2;
    const enc = new TextEncoder();
    const data = enc.encode(str);
    return [...encodeVarInt(tag), ...encodeVarInt(data.length), ...data];
  }
  function pbBytes(fieldNum, innerBytes) {
    const tag = (fieldNum << 3) | 2;
    return [...encodeVarInt(tag), ...encodeVarInt(innerBytes.length), ...innerBytes];
  }
  function encodeTranscriptParams(videoId, lang, kind) {
    let inner = pbString(1, videoId);
    if (lang) inner = [...inner, ...pbString(2, lang)];
    if (kind) inner = [...inner, ...pbString(3, kind)];

    const level2 = pbBytes(1, inner);
    const level3 = pbBytes(1, level2);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(level3)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function findTranscriptParams(vid) {
    let found = null;
    const seen = new Set();
    function walk(node) {
      if (found || !node || typeof node !== 'object') return;
      if (node instanceof Node) return; // ignore DOM nodes
      if (seen.has(node)) return;
      seen.add(node);
      if (node.getTranscriptEndpoint && node.getTranscriptEndpoint.params) {
        const p = node.getTranscriptEndpoint.params;
        if (typeof p === 'string' && b64Contains(p, vid)) {
          found = p;
          return;
        }
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
      } else {
        let keys = [];
        try { keys = Object.keys(node); } catch(e) {}
        for (const key of keys) walk(node[key]);
      }
    }
    
    // Check captured network responses first!
    if (window.__nova_next_params) {
      for (const p of window.__nova_next_params) {
        if (typeof p === 'string' && b64Contains(p, vid)) return p;
      }
    }

    try { walk(window.ytInitialData); } catch (e) {}
    try { walk(window.ytInitialPlayerResponse); } catch (e) {}
    try { walk(playerResponse()); } catch (e) {}
    if (!found) {
      try {
        const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer, ytd-app, ytd-watch-flexy, ytd-browse, ytd-watch-next-secondary-results-renderer');
        for (const p of panels) {
          if (p.__data || p.data) walk(p.__data || p.data);
        }
      } catch(e) {}
    }
    
    // Bruteforce search through the entire DOM HTML
    if (!found) {
      try {
        const allText = document.documentElement.innerHTML;
        const re = /"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(allText)) !== null) {
          if (b64Contains(m[1], vid)) { found = m[1]; break; }
        }
      } catch(e) {}
    }
    
    return found;
  }

  // Wrapper: try videoId-verified params first, fall back to first params found
  function getTranscriptParams(vid) {
    const verified = findTranscriptParams(vid);
    if (verified) return verified;
    // If videoId check fails (e.g. due to URL encoding), return first params found
    let firstFound = null;
    const seen = new Set();
    function walkFirst(node) {
      if (firstFound || !node || typeof node !== 'object') return;
      if (node instanceof Node) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (node.getTranscriptEndpoint && node.getTranscriptEndpoint.params) {
        firstFound = node.getTranscriptEndpoint.params;
        return;
      }
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) walkFirst(node[i]); }
      else { try { for (const k of Object.keys(node)) walkFirst(node[k]); } catch(e) {} }
    }
    try { walkFirst(window.ytInitialData); } catch(e) {}
    if (!firstFound) try { walkFirst(playerResponse()); } catch(e) {}
    if (!firstFound) {
      try {
        const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer, ytd-app, ytd-watch-flexy');
        for (const p of panels) { if (p.__data || p.data) walkFirst(p.__data || p.data); }
      } catch(e) {}
    }
    if (!firstFound && window.__nova_next_params && window.__nova_next_params.length) {
      firstFound = window.__nova_next_params[window.__nova_next_params.length - 1];
    }
    return firstFound;
  }

  async function fetchViaInnertube(videoId, lang, kind) {
    try {
      const foundParams = getTranscriptParams(videoId);
      const params = foundParams || encodeTranscriptParams(videoId, lang, kind);
      const pSrc = foundParams ? 'found' : 'encoded';

      // Use FULL INNERTUBE_CONTEXT as-is from YouTube — do NOT simplify or modify it
      const rawCtx = getInnertubeCfg('INNERTUBE_CONTEXT');
      let context;
      if (rawCtx && typeof rawCtx === 'object') {
        try { context = JSON.parse(JSON.stringify(rawCtx)); } catch(e) {}
      }
      if (!context) {
        context = {
          client: {
            hl: getInnertubeCfg('HL') || navigator.language || 'en',
            gl: getInnertubeCfg('GL') || 'US',
            clientName: 'WEB',
            clientVersion: getInnertubeCfg('INNERTUBE_CLIENT_VERSION') || '2.20240715.00.00'
          }
        };
      }

      const apiKey = getInnertubeCfg('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

      // Minimal headers — let cookies handle auth
      const headers = { 'Content-Type': 'application/json' };

      let r = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=' + apiKey, {
        method: 'POST',
        credentials: 'include',
        headers: headers,
        body: JSON.stringify({ context: context, params: params })
      });

      // Fallback: retry without cookies
      if (!r.ok && r.status === 400) {
        r = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=' + apiKey, {
          method: 'POST',
          credentials: 'omit',
          headers: headers,
          body: JSON.stringify({ context: context, params: params })
        });
      }

      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        const pVal = params ? String(params).slice(0, 80) : 'null';
        return { parsed: null, diag: 'innertube_http_' + r.status + '(pSrc=' + pSrc + ' pVal=' + JSON.stringify(pVal) + ' ctx=' + (rawCtx ? 'ytcfg' : 'fallback') + ' snip=' + JSON.stringify(errText.slice(0, 120)) + ')' };
      }

      const data = await r.json();
      const parsed = parseInnertubeTranscript(data, lang);
      if (parsed) {
        return { parsed, diag: 'innertube_ok' };
      }
      const keys = data ? Object.keys(data).join(',') : 'null';
      const snippet = JSON.stringify(data || {}).slice(0, 250);
      return { parsed: null, diag: 'innertube_empty(keys=[' + keys + '] snippet=' + snippet + ')' };
    } catch (e) {
      return { parsed: null, diag: 'innertube_exc=' + e.message };
    }
  }

  function extractText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (obj.simpleText) return obj.simpleText;
    if (obj.runs) return obj.runs.map(r => r.text || '').join('');
    return '';
  }

  function parseInnertubeTranscript(data, lang) {
    if (!data || typeof data !== 'object') return null;
    const cues = [];
    const lines = [];

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      if (node.transcriptCueRenderer) {
        const cr = node.transcriptCueRenderer;
        const text = extractText(cr.cue).trim();
        if (text) {
          const start = parseInt(cr.startOffsetMs || '0', 10) / 1000;
          const dur = parseInt(cr.durationMs || '0', 10) / 1000;
          cues.push({ start, end: start + dur, text });
          lines.push(text);
        }
      }

      if (node.transcriptSegmentRenderer) {
        const sr = node.transcriptSegmentRenderer;
        const text = extractText(sr.snippet).trim();
        if (text) {
          const start = parseInt(sr.startMs || '0', 10) / 1000;
          const end = parseInt(sr.endMs || '0', 10) / 1000;
          cues.push({ start, end, text });
          lines.push(text);
        }
      }

      for (const key of Object.keys(node)) {
        if (key !== 'transcriptCueRenderer' && key !== 'transcriptSegmentRenderer') {
          walk(node[key]);
        }
      }
    }

    walk(data);

    if (lines.length) return { cues, lines, lang: lang || 'en' };
    return null;
  }

  async function fetchViaBackground(url) {
    try {
      const res = await sendToBackground({ t: 'nova-fetch-caption', url });
      if (!res || !res.ok) return { ok: false, len: 0, text: '', error: res ? res.error : 'bg proxy error' };
      return res;
    } catch (e) { return { ok: false, len: 0, text: '', error: e.message }; }
  }
  function getTrackLang(track) {
    if (!track) return 'en';
    if (track.languageCode) return track.languageCode;
    if (track.langCode) return track.langCode;
    if (track.language) return track.language;
    const vss = track.vssId || track.vss_id || '';
    if (vss) return vss.replace(/^a\./, '').replace(/^\./, '');
    return 'en';
  }
  function getTrackKind(track) {
    if (!track) return '';
    if (track.kind) return track.kind;
    const vss = track.vssId || track.vss_id || '';
    if (vss && vss.startsWith('a.')) return 'asr';
    return '';
  }
  async function triggerPlayerCaptions(track) {
    try {
      window.__nova_captured_timedtext = [];
      const p = player();
      if (!p) return null;
      if (typeof p.loadModule === 'function') p.loadModule('captions');
      const lang = getTrackLang(track);
      if (typeof p.setOption === 'function') {
        p.setOption('captions', 'track', { languageCode: lang });
      }
      if (typeof p.toggleSubtitlesOn === 'function') p.toggleSubtitlesOn();
    } catch (e) {}

    for (let i = 0; i < 15; i++) {
      await sleep(100);
      if (window.__nova_captured_timedtext && window.__nova_captured_timedtext.length) {
        for (const text of window.__nova_captured_timedtext) {
          const parsed = tryParse(text, track);
          if (parsed) return parsed;
        }
      }
    }
    return null;
  }

  async function fetchCaptionFromTrack(track) {
    const lang = getTrackLang(track);
    const kind = getTrackKind(track);
    const vid = vidId();
    const rawUrl = track.baseUrl || track.url || '';

    // Strategy 0: Trigger YouTube Player native caption module & intercept network response
    const playerResult = await triggerPlayerCaptions(track);
    if (playerResult) return { parsed: playerResult, diag: 'player_driven' };

    const candidates = [];
    if (rawUrl) {
      candidates.push(rawUrl); // PRESERVE EXACT RAW URL WITH SIGNATURE UNTOUCHED!
    }
    if (vid && lang) {
      const direct = 'https://www.youtube.com/api/timedtext?v=' + vid + '&lang=' + encodeURIComponent(lang) + (kind ? '&kind=' + encodeURIComponent(kind) : '') + '&fmt=json3';
      candidates.push(direct);
    }

    const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

    let failLog = [];
    // Strategy 1: Fetch from main world with credentials: 'omit'
    for (const u of uniqueCandidates) {
      try {
        const r = await fetch(u, { credentials: 'omit' });
        if (r.ok) {
          const text = await r.text();
          if (text && text.length > 5) {
            const parsed = tryParse(text, track);
            if (parsed) return { parsed, diag: 'main_omit len=' + text.length };
            else failLog.push('omit_parse_fail(len=' + text.length + ')');
          } else failLog.push('omit_empty');
        } else failLog.push('omit_http' + r.status);
      } catch (e) { failLog.push('omit_err'); }
    }

    // Strategy 2: Fetch from main world with credentials: 'include'
    for (const u of uniqueCandidates) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (r.ok) {
          const text = await r.text();
          if (text && text.length > 5) {
            const parsed = tryParse(text, track);
            if (parsed) return { parsed, diag: 'main_include len=' + text.length };
            else failLog.push('inc_parse_fail(len=' + text.length + ')');
          } else failLog.push('inc_empty');
        } else failLog.push('inc_http' + r.status);
      } catch (e) { failLog.push('inc_err'); }
    }

    // Strategy 3: Background proxy fetch
    for (const u of uniqueCandidates) {
      const bg = await fetchViaBackground(u);
      if (bg && bg.ok && bg.text && bg.text.length > 5) {
        const parsed = tryParse(bg.text, track);
        if (parsed) return { parsed, diag: 'bg len=' + bg.text.length };
        else failLog.push('bg_parse_fail(len=' + bg.text.length + ')');
      } else {
        failLog.push('bg_fail(' + (bg ? (bg.ok ? 'empty' : bg.error) : 'null') + ')');
      }
    }

    return { parsed: null, diag: 'all_failed[' + failLog.join(',') + ']' };
  }

  function transcriptPanels() {
    return [...querySelectorAllDeep('ytd-engagement-panel-section-list-renderer, [panel-target-id*="transcript"], [target-id*="transcript"]')]
      .filter(p => {
        const tid = (p.getAttribute('panel-target-id') || p.getAttribute('target-id') || p.getAttribute('id') || '').toLowerCase();
        return tid.includes('transcript');
      });
  }
  function expandedTranscriptPanel() {
    return transcriptPanels().find(p => p.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN')
      || transcriptPanels()[0];
  }
  function findTranscriptButton() {
    return [...document.querySelectorAll('button')].find(b => {
      const a = b.getAttribute('aria-label') || '';
      return /расшифровка видео|show transcript|транскрипт|transcript/i.test(a) && !/закрыть|close/i.test(a);
    });
  }
  function querySelectorAllDeep(selector, root = document) {
    const results = [];
    function search(node) {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches && node.matches(selector)) {
          results.push(node);
        }
        if (node.shadowRoot) {
          search(node.shadowRoot);
        }
      }
      for (const child of node.childNodes || []) {
        search(child);
      }
    }
    search(root);
    return results;
  }

  function extractTranscriptCuesFromDOM() {
    const parseSec = (str) => {
      const parts = (str || '').trim().split(':').map(Number);
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      return 0;
    };

    const isTimestampLabel = (t) => {
      if (!t) return true;
      t = t.trim();
      if (/^\d+:\d{2}(?::\d{2})?$/.test(t)) return true;
      if (/^\d+\s*(?:сек|мин|час|секунд|секунды|секунда|минут|минуты|минута|часов|часа|час|seconds?|mins?|minutes?|hours?)/i.test(t)) return true;
      return false;
    };

    const cues = [];
    
    // 1. Search whole document (including all Shadow Roots) for transcript segment renderers
    const segs = querySelectorAllDeep('ytd-transcript-segment-renderer, ytm-transcript-segment-renderer, [class*="transcript-segment"], [class*="segmentRenderer"]');
    if (segs.length > 0) {
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const timeEl = s.querySelector('.segment-timestamp, [class*="timestamp"]');
        const textEl = s.querySelector('.segment-text, [class*="segment-text"], [class*="segmentText"]');
        
        let start = 0;
        if (timeEl) {
          start = parseSec(timeEl.textContent);
        }
        
        let text = '';
        if (textEl) {
          text = textEl.textContent.trim();
        }
        
        if (!text || isTimestampLabel(text)) {
          const strings = [...s.querySelectorAll('yt-formatted-string, span, div')]
            .map(e => e.textContent.trim())
            .filter(t => t && !isTimestampLabel(t));
          if (strings.length) text = strings.join(' ');
        }

        if (text && !isTimestampLabel(text)) {
          cues.push({ start, text });
        }
      }
    }

    // 2. Fallback: search specifically inside engagement panels or structured description panels
    if (!cues.length) {
      const panels = querySelectorAllDeep('ytd-engagement-panel-section-list-renderer, ytd-structured-description-content-renderer, [panel-target-id*="transcript"], [target-id*="structured_description"], ytd-transcript-search-panel-renderer');
      for (const panel of panels) {
        if (panel.closest && panel.closest('ytd-watch-next-secondary-results-renderer, #secondary')) continue;
        
        const allElements = querySelectorAllDeep('yt-formatted-string, span, div', panel);
        const allStrings = allElements
          .map(e => (e.textContent || '').replace(/[\u200b\u200e\u200f]/g, '').trim())
          .filter(Boolean);
        
        for (let i = 0; i < allStrings.length; i++) {
          const str = allStrings[i];
          if (isTimestampLabel(str)) {
            let start = parseSec(str);
            let j = i + 1;
            while (j < allStrings.length && isTimestampLabel(allStrings[j])) {
              j++;
            }
            if (j < allStrings.length && !/Поиск|Search/i.test(allStrings[j])) {
              cues.push({ start, text: allStrings[j] });
              i = j;
            }
          }
        }
        if (cues.length > 0) break;
      }
    }

    if (!cues.length) return null;

    for (let i = 0; i < cues.length; i++) {
      if (i < cues.length - 1) {
        cues[i].end = cues[i + 1].start;
      } else {
        cues[i].end = cues[i].start + 4;
      }
    }
    return { cues, lines: cues.map(c => c.text) };
  }

  function closeTranscriptPanelIfOpen() {
    try {
      const app = document.querySelector('ytd-app') || document.body;

      // 1. Dispatch YouTube Polymer events to hide/close engagement panel
      const targetIds = ['PAmodern_transcript_view', 'engagement-panel-searchable-transcript', 'engagement-panel-transcript'];
      ['yt-hide-engagement-panel-section-action', 'yt-close-engagement-panel-section-action'].forEach((act) => {
        targetIds.forEach((targetId) => {
          try {
            app.dispatchEvent(new CustomEvent('yt-action', {
              detail: { actionName: act, args: [{ targetId: targetId }] },
              bubbles: true, composed: true
            }));
          } catch(e) {}
        });
      });

      // 2. Set visibility attribute & property on all transcript engagement panels
      const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
      for (const p of panels) {
        const tid = p.getAttribute('target-id') || '';
        if (tid.includes('transcript') || tid.includes('PAmodern') || p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
          try { p.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'); } catch(e) {}
          try { p.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'; } catch(e) {}
          
          // 3. Find and click close button inside panel
          const closeBtn = p.querySelector('button[aria-label*="Закрыть"], button[aria-label*="Close"], #visibility-button button, #header button');
          if (closeBtn) {
            try { closeBtn.click(); } catch(e) {}
          }
        }
      }

      // 4. Click any global button with aria-label "Закрыть расшифровку видео" or "Close transcript"
      const globalCloseBtns = document.querySelectorAll('button[aria-label*="Закрыть расшифровку"], button[aria-label*="Close transcript"]');
      for (const b of globalCloseBtns) {
        try { b.click(); } catch(e) {}
      }
    } catch (e) {}
  }

  async function getSubtitlesViaPanel(diagSink) {
    let btn = findTranscriptButton();
    if (!btn) {
      const more = document.querySelector('ytd-text-inline-expander #expand, #description #expand, tp-yt-paper-button#expand');
      if (more) { try { more.click(); } catch (e) {} await sleep(400); btn = findTranscriptButton(); }
    }

    const triggerActions = () => {
      if (btn) {
        try { btn.click(); } catch (e) {}
        try { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })); } catch (e) {}
      }
      const app = document.querySelector('ytd-app') || document.body;
      ['yt-open-engagement-panel-section-action', 'yt-show-engagement-panel-section-action', 'yt-load-engagement-panel-section-action', 'yt-reload-engagement-panel-section-action'].forEach((act) => {
        try {
          app.dispatchEvent(new CustomEvent('yt-action', {
            detail: { actionName: act, args: [{ targetId: 'PAmodern_transcript_view' }] },
            bubbles: true, composed: true
          }));
        } catch (e) {}
      });

      // Try native resolveCommand if available
      try {
        const p = findTranscriptParams(vidId());
        if (p && app.resolveCommand) {
          app.resolveCommand({ getTranscriptEndpoint: { params: p } });
        }
      } catch (e) {}
    };

    triggerActions();

    const panel = () => expandedTranscriptPanel();
    const p = panel();
    if (p && p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') {
      try { p.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'); } catch (e) {}
    }

    await sleep(400);

    // Wait up to 10 seconds for transcript segments to render
    for (let i = 0; i < 30; i++) {
      const cuesData = extractTranscriptCuesFromDOM();
      if (cuesData && cuesData.lines && cuesData.lines.length) {
        closeTranscriptPanelIfOpen();
        return cuesData.lines;
      }
      
      // If stuck on spinner after 1.5s, trigger actions again
      if (i === 5 || i === 12) {
        triggerActions();
        const curP = panel();
        if (curP) {
          const spinner = curP.querySelector('yt-content-loading-renderer, tp-yt-paper-spinner');
          if (spinner) {
            try { curP.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'); } catch (e) {}
            try { if (curP.reload) curP.reload(); } catch (e) {}
          }
        }
      }

      await sleep(300);
    }

    if (diagSink) {
      const curP = panel();
      const c = curP && (curP.querySelector('#content') || curP);
      diagSink.push('panel: timeout. content=' + (c ? c.innerHTML.slice(0, 1500) : 'no panel'));
    }
    return null;
  }

  function buildCuesFromLines(lines) {
    if (!lines || !lines.length) return [];
    const cues = [];
    let cur = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] || '').trim();
      if (!line) continue;
      const m = line.match(/^(\d+:\d{2}(?::\d{2})?)\s+(.+)$/s);
      if (m) {
        const parts = m[1].split(':').map(Number);
        const start = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
        const text = m[2].trim();
        cues.push({ start: start, end: start + 4, text: text });
      } else {
        const dur = Math.max(2, Math.min(6, line.length * 0.1));
        cues.push({ start: cur, end: cur + dur, text: line });
        cur += dur;
      }
    }
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) {
        cues[i].end = cues[i + 1].start;
      }
    }
    return cues;
  }

  async function getSubtitles() {
    const tracks = captionTracks();
    if (!tracks.length) {
      const pr = playerResponse();
      const diag = 'no tracks. hasPR=' + !!pr + ' hasCaptions=' + !!(pr && pr.captions) + ' ytInit=' + !!window.ytInitialPlayerResponse;
      throw new Error('у этого видео нет субтитров (' + diag + ')');
    }
    const track = pickTrack(tracks);
    if (!track) throw new Error('субтитры недоступны');
    const lang = getTrackLang(track);
    let fetchDiag = '';

    // 0. Instant DOM check: if user already has transcript panel open in DOM
    const instantCues = extractTranscriptCuesFromDOM();
    if (instantCues && instantCues.lines && instantCues.lines.length) {
      log('subs', 'got ' + instantCues.lines.length + ' lines directly from open DOM panel');
      const cues = (instantCues.cues && instantCues.cues.length) ? instantCues.cues : buildCuesFromLines(instantCues.lines);
      closeTranscriptPanelIfOpen();
      return { text: instantCues.lines.join('\n'), cues: cues, lang: lang };
    }

    // 1. Primary: innertube get_transcript API (modern YouTube)
    const vid = vidId();
    const kind = getTrackKind(track);
    if (vid) {
      const itRes = await fetchViaInnertube(vid, lang, kind);
      if (itRes && itRes.parsed && itRes.parsed.lines && itRes.parsed.lines.length) {
        log('subs', 'got ' + itRes.parsed.lines.length + ' lines via innertube');
        closeTranscriptPanelIfOpen();
        return { text: itRes.parsed.lines.join('\n'), cues: itRes.parsed.cues || null, lang: itRes.parsed.lang || lang };
      }
      fetchDiag += (itRes && itRes.diag ? itRes.diag : 'innertube=empty') + ' ';
    }

    // 2. Fallback: old timedtext GET API (single attempt)
    try {
      const { parsed, diag: d } = await fetchCaptionFromTrack(track);
      if (d) fetchDiag += d;
      if (parsed && parsed.lines && parsed.lines.length) {
        closeTranscriptPanelIfOpen();
        return { text: parsed.lines.join('\n'), cues: parsed.cues || null, lang: parsed.lang || lang };
      }
    } catch (e) { fetchDiag += ' timedtext_err=' + (e && e.message); }

    // 3. Last resort: transcript panel scraping
    const diagSink = [];
    const panelLines = await getSubtitlesViaPanel(diagSink);
    if (panelLines && panelLines.length) {
      const cuesData = extractTranscriptCuesFromDOM();
      const cues = (cuesData && cuesData.cues && cuesData.cues.length) ? cuesData.cues : buildCuesFromLines(panelLines);
      closeTranscriptPanelIfOpen();
      return { text: panelLines.join('\n'), cues: cues, lang: lang };
    }

    // All methods failed — dump diagnostics
    let dump = '=== transcript buttons ===\n';
    try {
      const btns = [...document.querySelectorAll('button, a, tp-yt-paper-button')].filter(b => /transcript|расшифров|транскрипт/i.test((b.getAttribute && (b.getAttribute('aria-label') || '')) || b.textContent || ''));
      dump += btns.slice(0, 12).map(b => (b.outerHTML || '').slice(0, 300)).join('\n---\n') || '(none found)';
    } catch (e) { dump += 'err ' + e.message; }
    dump += '\n=== PAmodern_transcript_view #content (loaded) ===\n';
    try {
      const p = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')].find(x => (x.getAttribute('target-id') || '').includes('transcript'));
      const c = p && (p.querySelector('#content') || p);
      dump += c ? c.outerHTML.slice(0, 3500) : '(panel not found)';
    } catch (e) { dump += 'err ' + e.message; }
    const diag = 'track=' + (track.languageCode || '?') + ' kind=' + (track.kind || '?') +
      ' fetch=[' + fetchDiag + '] panelDiag=[' + diagSink.join(' || ') + ']\n' + dump.slice(0, 4000);
    throw new Error('не удалось получить субтитры (' + diag + ')');
  }

  function subsAvailable() {
    const tracks = captionTracks();
    const track = pickTrack(tracks);
    return { available: !!track, lang: track ? (track.languageCode || 'txt') : null };
  }

  // ---- bridge to the isolated-world UI script ------------------------------
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data[TO_HOOK] !== true) return;
    const { cmd, reqId, height, format, end } = ev.data;
    const reply = (payload, transfer) => {
      window.postMessage({ [FROM_HOOK]: true, reqId, ...payload }, location.origin, transfer || []);
    };
    try {
      if (cmd === 'info') {
        const p = player();
        let dur = video() && video().duration;
        if (!isFinite(dur) || dur <= 0) dur = 0;
        const resp = { ok: true, videoId: vidId(), title: (p && p.getVideoData && p.getVideoData().title) || document.title.replace(/ - YouTube$/, ''), duration: dur, heights: availableHeights() };
        log('info', JSON.stringify({ ctx: (location.pathname.indexOf('/embed/') === 0 ? 'embed' : 'page'), dur, heights: resp.heights, hasPlayer: !!p }));
        reply(resp);
      } else if (cmd === 'download') {
        const isMp3 = format === 'mp3';
        const targetQ = isMp3 ? 'medium' : (QUALITY_BY_HEIGHT[height] || 'hd720');
        const cap = await captureBackground({ targetQ, end, isMp3, height }, (pct) => reply({ progress: pct, phase: 'buffering' }));
        const result = assemble();
        const aud = result.audio;
        if (!aud) throw new Error('не удалось захватить аудио');
        const payload = {
          ok: true,
          done: true,
          audio: { mime: aud.mime, size: aud.bytes.byteLength },
          actualHeight: cap && cap.actualHeight,
          duration: cap && cap.duration,
        };
        const transfers = [aud.bytes.buffer];
        payload._a = aud.bytes.buffer;
        if (!isMp3) {
          const vid = result.video;
          if (!vid) throw new Error('не удалось захватить видео');
          payload.video = { mime: vid.mime, size: vid.bytes.byteLength };
          payload._v = vid.bytes.buffer;
          transfers.push(vid.bytes.buffer);
        }
        reply(payload, transfers);
      } else if (cmd === 'subtitles') {
        const res = await getSubtitles();
        reply({ ok: true, done: true, text: res.text, cues: res.cues || null, lang: res.lang });
      } else if (cmd === 'subs-available') {
        const a = subsAvailable();
        reply({ ok: true, available: a.available, lang: a.lang });
      }
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });

  document.addEventListener('yt-navigate-finish', () => {
    if (vidId() !== store.videoId) {
      store.videoId = vidId();
      resetCapture();
    }
    store.capturing = true; // keep passive capture on while watching
    scheduleAutoplayOff();
  });

  function scheduleAutoplayOff() {
    let tries = 20;
    (function tick() {
      if (keepAutoplayOff() || tries-- <= 0) return;
      setTimeout(tick, 1000);
    })();
  }
  scheduleAutoplayOff();

  store.videoId = vidId();
  store.capturing = true; // passive capture from page load
  log('hook', 'installed; ctx=', (location.pathname.indexOf('/embed/') === 0 ? 'embed-iframe' : 'page'), 'vid=', vidId());
})();
