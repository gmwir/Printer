/* UI helpers: safe DOM builder (no innerHTML for data), Persian number formatting,
   toasts, bottom sheets, confirm/PIN dialogs, file save/share for iOS. */
(function (root) {
  'use strict';
  var J = root.Jalali;

  // h('div.cls#id', {attrs/on*}, children...) — strings become text nodes (XSS-safe)
  function h(sel, attrs) {
    var m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [], el = document.createElement(m[1] || 'div');
    (m[2] || '').replace(/([.#])([\w-]+)/g, function (_, t, v) { if (t === '.') el.classList.add(v); else el.id = v; });
    var kids = Array.prototype.slice.call(arguments, 2);
    if (attrs && (typeof attrs !== 'object' || attrs.nodeType || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v; // ONLY for static trusted markup (icons)
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    kids.forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    });
  }
  function clear(el) { try { while (el.firstChild) el.removeChild(el.firstChild); } catch (e) { el.innerHTML = ''; } return el; } // v2.10: a field being left (blur) may already be detached

  // ---------- numbers ----------
  var FA = '۰۱۲۳۴۵۶۷۸۹';
  function fa(s) { return String(s == null ? '' : s).replace(/\d/g, function (d) { return FA[d]; }); }
  function group(n) { var neg = n < 0, s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '٬'); return (neg ? '−' : '') + s; }
  function money(n) { return n == null ? '—' : fa(group(n)); }
  function moneyT(n) { return n == null ? '—' : money(n) + ' تومان'; }
  function qty(n) { return n == null ? '—' : fa(group(n)); }
  // parse user number input (Persian/Arabic digits, separators) -> integer | null | NaN
  function parseNum(s) {
    if (s == null) return null;
    var t = J.toLatinDigits(String(s)).replace(/[,٬،\s]/g, '').replace(/٫/g, '.').replace(/تومان|ریال|IRR|IRT/gi, '');
    if (t === '') return null;
    if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
    return Number(t);
  }
  function parseInt2(s) { var n = parseNum(s); return n == null ? null : (Number.isInteger(n) ? n : NaN); }

  // ---------- dates ----------
  function dateFa(ms, withTime) { return ms ? fa(J.fmt(ms, withTime)) : '—'; }
  function todayStr() { return fa(J.fmt(Date.now())); }
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function endOfDay(ms) { var d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); }
  // Jalali input string -> ms on that date with current time of day (null if empty, NaN if invalid)
  function parseDateInput(s, endDay) {
    if (!s || !String(s).trim()) return null;
    var ms = J.parse(s); if (ms == null) return NaN;
    if (endDay) return endOfDay(ms);
    var now = new Date(), d = new Date(ms); d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0); return d.getTime();
  }

  // ---------- ids ----------
  function opKey(prefix) {
    var a = new Uint8Array(10); (root.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; });
    return (prefix || 'op') + ':' + Date.now().toString(36) + ':' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // ---------- toast ----------
  var toastT;
  function toast(msg, kind, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show ' + (kind || '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = ''; }, ms || (kind === 'bad' ? 4500 : 2400));
  }

  // ---------- sheets ----------
  var openSheets = [];
  function sheet(title, body, opts) {
    opts = opts || {};
    var bg = h('div.sheet-bg'), box = h('div.sheet', h('div.grab'), title ? h('h3', title) : null, body);
    bg.appendChild(box);
    var api = { el: box, close: function (v) { if (!bg.parentNode) return; bg.parentNode.removeChild(bg); openSheets.splice(openSheets.indexOf(api), 1); if (opts.onClose) opts.onClose(v); } };
    bg.addEventListener('click', function (e) { if (e.target === bg && !opts.modal) api.close(); });
    document.body.appendChild(bg); openSheets.push(api);
    return api;
  }
  function closeAllSheets() { openSheets.slice().forEach(function (s) { s.close(); }); }
  function confirmBox(msg, okText, danger) {
    return new Promise(function (res) {
      var s = sheet('تأیید', h('div.stack', h('p', msg),
        h('div.grid2', h('button.btn', { onclick: function () { s.close(false); } }, 'انصراف'),
          h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: function () { s.close(true); } }, okText || 'تأیید'))), { onClose: function (v) { res(!!v); } });
    });
  }
  function promptBox(title, label, opts) {
    opts = opts || {};
    return new Promise(function (res) {
      var inp = h('input.in', { value: opts.value || '', placeholder: opts.placeholder || '', inputmode: opts.inputmode || null, class: opts.ltr ? 'ltr-in' : null });
      var s = sheet(title, h('div', h('label.f', h('span', label), inp),
        h('div.grid2', h('button.btn', { onclick: function () { s.close(null); } }, 'انصراف'),
          h('button.btn.primary', { onclick: function () { s.close(inp.value); } }, opts.ok || 'تأیید'))), { onClose: function (v) { res(v == null ? null : v); } });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') s.close(inp.value); });
      setTimeout(function () { inp.focus(); }, 60);
    });
  }
  // PIN pad: resolves the entered string or null
  function pinPad(title, sub, opts) {
    opts = opts || {};
    return new Promise(function (res) {
      var val = '', dots = h('div.pin-dots'), msg = h('div.hint.bad', { style: { textAlign: 'center' } });
      function draw() { clear(dots); for (var i = 0; i < Math.max(4, val.length); i++) dots.appendChild(h('i' + (i < val.length ? '.f' : ''))); }
      var keys = h('div.keypad');
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].forEach(function (k) {
        keys.appendChild(h('button', { type: 'button', onclick: function () {
          if (k === 'C') val = ''; else if (k === '⌫') val = val.slice(0, -1); else if (val.length < 8) val += k; draw();
        } }, fa(k)));
      });
      draw();
      var s = sheet(title, h('div', sub ? h('p.muted', { style: { textAlign: 'center' } }, sub) : null, dots, msg, keys,
        h('div.grid2', { style: { marginTop: '12px' } }, h('button.btn', { onclick: function () { s.close(null); } }, 'انصراف'),
          h('button.btn.primary', { onclick: function () { if (val.length < 4) { msg.textContent = 'حداقل ۴ رقم'; return; } s.close(val); } }, 'تأیید')),
        opts.forgot ? h('button.btn.ghost.block', { style: { marginTop: '6px' }, onclick: function () { s.close('__forgot__'); } }, 'رمز را فراموش کرده‌ام') : null),
        { modal: true, onClose: function (v) { res(v == null ? null : v); } });
    });
  }

  // ---------- files (iOS: Share sheet -> Save to Files / Telegram / WhatsApp; fallback: download) ----------
  function fileSheet(bytes, name, mime, note) {
    var blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
    var file = null, canShare = false;
    [mime, 'application/octet-stream', 'text/plain'].some(function (t) {
      try { file = new File([blob], name, { type: t }); } catch (e) { file = null; return true; }
      canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
      return canShare;
    });
    var url = URL.createObjectURL(blob);
    var body = h('div.stack',
      h('div.card', h('div.row', h('div.grow', h('b.ltr', name), h('div.muted', fa((blob.size / 1024).toFixed(blob.size < 10240 ? 1 : 0)) + ' کیلوبایت'))), note ? h('p.small.muted', note) : null),
      canShare ? h('button.btn.primary.block', { onclick: function () {
        navigator.share({ files: [file], title: name }).catch(function (e) { if (e && e.name !== 'AbortError') toast('اشتراک‌گذاری ناموفق بود؛ از «دانلود» استفاده کنید.', 'bad'); });
      } }, 'ذخیره در Files / ارسال') : null,
      h('a.btn.block' + (canShare ? '' : '.primary'), { href: url, download: name, onclick: function () { setTimeout(function () { toast('اگر فایل باز شد، از دکمه اشتراک‌گذاری برای ذخیره استفاده کنید.'); }, 400); } }, 'دانلود فایل'),
      /pdf/.test(mime) ? h('a.btn.block', { href: url, target: '_blank', rel: 'noopener' }, 'نمایش PDF') : null,
      h('button.btn.ghost.block', { onclick: function () { s.close(); } }, 'بستن'));
    var s = sheet('فایل آماده است', body, { onClose: function () { setTimeout(function () { URL.revokeObjectURL(url); }, 60000); } });
    return s;
  }
  function pickFile(accept) {
    return new Promise(function (res) {
      var i = h('input', { type: 'file', accept: accept, style: { display: 'none' } });
      i.addEventListener('change', function () { res(i.files && i.files[0] ? i.files[0] : null); i.remove(); });
      document.body.appendChild(i); i.click();
    });
  }
  function readFileBytes(f) {
    if (f.arrayBuffer) return f.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(new Uint8Array(r.result)); }; r.onerror = rej; r.readAsArrayBuffer(f); });
  }

  // ---------- hashing ----------
  function sha256hex(str) {
    if (root.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (b) {
        return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      });
    }
    // non-secure context fallback (FNV-1a 64-bit-ish); only used when HTTPS is missing
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) { h1 ^= str.charCodeAt(i); h1 = Math.imul(h1, 16777619) >>> 0; h2 = Math.imul(h2 ^ h1, 2654435761) >>> 0; }
    return Promise.resolve('fnv' + h1.toString(16) + h2.toString(16));
  }

  // ---------- beep ----------
  var actx = null;
  function primeAudio() { try { actx = actx || new (root.AudioContext || root.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { actx = null; } }
  function beep(ok) {
    try {
      if (!actx) return; var o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = ok === false ? 220 : 1240; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + (ok === false ? 0.25 : 0.09));
    } catch (e) { /* ignore */ }
    if (navigator.vibrate) navigator.vibrate(ok === false ? [80, 60, 80] : 40);
  }

  var ICONS = {
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z"/></svg>',
    scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h7"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    in: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v3h16v-3"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
    cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/></svg>',
    qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM18 18h3v3M14 20h2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>'
  };
  function icon(name) { return h('span.ic', { html: ICONS[name] || '' }); }

  root.UI = { h: h, clear: clear, fa: fa, money: money, moneyT: moneyT, qty: qty, parseNum: parseNum, parseInt2: parseInt2, group: group,
    dateFa: dateFa, todayStr: todayStr, startOfDay: startOfDay, endOfDay: endOfDay, parseDateInput: parseDateInput, opKey: opKey,
    toast: toast, sheet: sheet, closeAllSheets: closeAllSheets, confirmBox: confirmBox, promptBox: promptBox, pinPad: pinPad,
    fileSheet: fileSheet, pickFile: pickFile, readFileBytes: readFileBytes, sha256hex: sha256hex, primeAudio: primeAudio, beep: beep, icon: icon, ICONS: ICONS };
})(typeof self !== 'undefined' ? self : this);
