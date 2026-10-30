/* Amiran Yadak Inventory — app shell, routing, home, products, receipt/issue forms, documents, customers, scanner UI.
   Second half of the screens (reports, import, labels, settings/backup, onboarding) is in views2.js. */
(function () {
  'use strict';
  var UI = window.UI, h = UI.h, Core = window.Core, J = window.Jalali;
  var APP_VERSION = '2.10.0';
  var E = Core.createEngine();
  var DB = window.Store.createStore(E);
  var A = window.App = { E: E, DB: DB, UI: UI, h: h, version: APP_VERSION, routes: {}, state: { mgrUntil: 0 } };
  var view = document.getElementById('view');

  // ======================= helpers =======================
  A.shop = function () { return E.getMeta('shop') || {}; };
  A.errMsg = function (e) {
    if (!e) return 'خطای نامشخص';
    if (e.code) return e.message;
    return 'خطای غیرمنتظره: ' + (e.message || e.name || e);
  };
  A.showErr = function (e) { UI.toast(A.errMsg(e), 'bad'); if (window.console) console.warn(e); };
  // run an engine operation and persist it; returns result or throws (after showing the error)
  A.run = function (fn) { return DB.run(fn).catch(function (e) { A.showErr(e); throw e; }); };
  /* v2.1: run a dated operation as the current user. If the date is more than 7 days back the manager is asked;
     if a payment is dated before its invoice the user must confirm it. build(ctx, flags) returns the engine function. */
  A.runSmart = function (build, o) {
    o = o || {}; var flags = {};
    function attempt(ctx) {
      return DB.run(build(ctx, flags)).catch(function (e) {
        if (e && e.code === 'BACKDATE_LIMIT' && !(ctx && ctx.manager)) return A.manager('ثبت با تاریخ بیش از ۷ روز گذشته').then(function (m) { if (!m) throw e; return attempt(m); });
        if (e && e.code === 'PAY_BEFORE_INVOICE' && !flags.beforeInvoiceOk) return UI.confirmBox(e.message, 'تاریخ درست است').then(function (ok) { if (!ok) throw e; flags.beforeInvoiceOk = true; return attempt(ctx); });
        // v2.1.1: duplicate supplier invoice in the quick receipt -> only with an explicit reason + the manager's PIN
        if (e && e.code === 'DUPLICATE_INVOICE' && !flags.duplicateOk) return A.dupOverride(e).then(function (reason) {
          if (!reason) throw e;
          return A.manager('ثبت فاکتور خرید تکراری / مشابه').then(function (m) { if (!m) throw e; flags.duplicateOk = { reason: reason }; return attempt(m); });
        });
        throw e;
      });
    }
    return attempt(o.ctx || A.userCtx()).catch(function (e) { A.showErr(e); throw e; });
  };
  A.dupOverride = function (e) { // -> Promise<reason | null>
    return new Promise(function (res) {
      var why = h('input.in', { placeholder: 'علت (الزامی)' }), chk = h('input', { type: 'checkbox' });
      var s = UI.sheet('ثبت فاکتور خرید تکراری / مشابه', h('div.stack', h('div.alert.bad', e.message), field('علت', why, null, true),
        h('label.check', chk, 'تأیید صریح: می‌دانم فاکتور مشابه قبلاً ثبت شده و این یک ورود جداست.'),
        h('button.btn.danger.block', { onclick: function () {
          if (!why.value.trim()) { UI.toast('علت را بنویسید.', 'bad'); return; }
          if (!chk.checked) { UI.toast('تأیید صریح را بزنید.', 'bad'); return; }
          s.close(why.value.trim());
        } }, 'ادامه با رمز مدیر')), { onClose: function (v) { res(typeof v === 'string' ? v : null); } });
    });
  };
  // v2.1: is a document inside the closed financial period?
  A.inClosed = function (ts) { var c = E.closedThrough(); return c != null && ts <= c; };
  A.closedText = function () { var c = E.closedThrough(); return c == null ? '' : UI.dateFa(c); };
  A.go = function (hash) { if (location.hash === hash) route(); else location.hash = hash; };
  A.manager = function (what) {
    var auth = E.getMeta('auth');
    var ctx = { manager: true, user: 'مدیر' };
    if (!auth || !auth.hash) return UI.confirmBox('«' + what + '» یک عملیات مدیریتی است. ادامه می‌دهید؟ (برای امنیت بیشتر در تنظیمات رمز مدیر تعیین کنید.)', 'ادامه').then(function (ok) { return ok ? ctx : null; });
    if (Date.now() < A.state.mgrUntil) return Promise.resolve(ctx);
    return UI.pinPad('رمز مدیر', what, { forgot: !!auth.rec }).then(function (pin) {
      if (pin == null) return null;
      if (pin === '__forgot__') return A.recoverPin(auth).then(function (okk) { return okk ? ctx : null; });
      return UI.sha256hex(auth.salt + ':' + pin).then(function (hx) {
        if (hx !== auth.hash) { UI.toast('رمز اشتباه است.', 'bad'); return null; }
        A.state.mgrUntil = Date.now() + 3 * 60 * 1000; return ctx;
      });
    });
  };
  A.normRecovery = function (s) { return J.toLatinDigits(String(s || '')).toUpperCase().replace(/[^0-9A-Z]/g, ''); };
  A.recoverPin = function (auth) {
    return UI.promptBox('بازیابی رمز مدیر', 'کد بازیابی که هنگام تعیین رمز یادداشت کردید', { ltr: true }).then(function (code) {
      if (!code) return false;
      return UI.sha256hex(auth.salt + ':rec:' + A.normRecovery(code)).then(function (hx) {
        if (hx !== auth.rec) { UI.toast('کد بازیابی اشتباه است.', 'bad'); return false; }
        UI.toast('کد درست است؛ رمز جدید تعیین کنید.', 'ok');
        return A.setPin(false).then(function () { A.state.mgrUntil = Date.now() + 3 * 60 * 1000; return true; });
      });
    });
  };
  A.publicBase = function () { var b = (E.getMeta('prefs') || {}).publicBase || 'https://amiran-yadak.ir'; return String(b).replace(/\/+$/, ''); };
  A.userCtx = function () { return { user: Date.now() < A.state.mgrUntil ? 'مدیر' : 'کاربر' }; };
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  A.lsGet = lsGet; A.lsSet = lsSet;
  function setTitle(t, back, act) {
    document.getElementById('tb-title').textContent = t;
    document.getElementById('tb-back').hidden = !back;
    var a = UI.clear(document.getElementById('tb-act')); if (act) a.appendChild(act);
    document.title = t + ' — امیران یدک';
  }
  A.setTitle = setTitle;
  function field(label, input, hint, req) { return h('label.f', h('span', label, req ? h('i', ' *') : null), input, hint || null); }
  A.field = field;
  function sel(opts, value, attrs) {
    var s = h('select.in', attrs || {});
    Object.keys(opts).forEach(function (k) { s.appendChild(h('option', { value: k, selected: k === value }, opts[k])); });
    return s;
  }
  A.sel = sel;
  function moneyInput(value, ph) {
    var i = h('input.in', { inputmode: 'numeric', value: value == null ? '' : UI.fa(UI.group(value)), placeholder: ph || '', autocomplete: 'off' });
    var hint = h('div.hint');
    function upd() { var n = UI.parseNum(i.value); hint.textContent = n == null ? '' : isNaN(n) || n < 0 || !Number.isInteger(n) ? 'عدد نامعتبر' : UI.moneyT(n); hint.className = 'hint' + (n != null && (isNaN(n) || n < 0 || !Number.isInteger(n)) ? ' bad' : ''); }
    i.addEventListener('input', upd); i.addEventListener('blur', function () { var n = UI.parseNum(i.value); if (n != null && !isNaN(n)) i.value = UI.fa(UI.group(n)); }); upd();
    return { input: i, hint: hint, value: function () { return UI.parseNum(i.value); } };
  }
  A.moneyInput = moneyInput;
  function stepper(val, onChange, min) {
    min = min == null ? 1 : min;
    var inp = h('input', { inputmode: 'numeric', value: UI.fa(val), 'aria-label': 'تعداد' });
    function set(v) { if (!Number.isSafeInteger(v) || v < min) v = min; inp.value = UI.fa(v); onChange(v); }
    inp.addEventListener('change', function () { var n = UI.parseInt2(inp.value); set(n == null || isNaN(n) ? min : n); });
    inp.addEventListener('focus', function () { inp.select(); });
    return h('div.stepper', h('button', { type: 'button', onclick: function () { set((UI.parseInt2(inp.value) || 0) + 1); } }, '+'), inp,
      h('button', { type: 'button', onclick: function () { set((UI.parseInt2(inp.value) || 0) - 1); } }, '−'));
  }
  A.stepper = stepper;
  function stockBadge(p) {
    var cls = p.stock <= 0 ? '.bad' : (p.minStock > 0 && p.stock <= p.minStock) ? '.warn' : '.ok';
    return h('span.badge' + cls, UI.qty(p.stock) + ' ' + (p.unit || ''));
  }
  A.stockBadge = stockBadge;
  // v2.5: ranked, typo-tolerant search (match.js search: name, brand, SKU, barcode, model, cars, family, attributes, group path).
  // opts.detail -> [{product, score, full, conflict}] (full:false = «similar», one word did not match)
  function productSearch(q, opts) { return A.matcher().search(q, opts); }
  A.productSearch = productSearch;
  function productRow(p, onclick, extra) {
    return h(onclick ? 'button.li' : 'a.li', onclick ? { type: 'button', onclick: onclick, style: { width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'right' } } : { href: '#/product/' + p.id },
      h('div.grow', h('div.t', p.name), h('div.s', [p.brand, p.sku, p.location].filter(Boolean).join(' · '))),
      h('div.e', stockBadge(p), extra || (p.sellPrice != null ? h('div.s', UI.money(p.sellPrice)) : null)));
  }
  A.productRow = productRow;
  // ---------- v2.2: smart search with learning (offline) ----------
  var MATCH = null; A.matcher = function () { return MATCH || (MATCH = window.Match.create(E)); };
  var CLS = null; A.classifier = function () { return CLS || (CLS = window.Classify.create(E)); }; // v2.3 product groups
  function qKey(q) { var c = window.Match.compact(q || ''); return c.length >= 3 ? 'q:' + c : null; }
  /* exact search first; the answer the user chose last time for the same words is moved to the top; when little is
     found, the nearest products by name/code are offered ("شاید منظورتان…"), marked when a detail differs (چپ/راست…) */
  A.searchSmart = function (q, opts) {
    var det = productSearch(q, Object.assign({}, opts || {}, { detail: true })), sim = {};
    det.forEach(function (x) { if (!x.full) sim[x.product.id] = 1; });
    var r = det.map(function (x) { return x.product; }), k = qKey(q), L = k ? E.learned(k) : null, lp = L && E.state.products[L.productId];
    if (lp && lp.active !== false) { r = [lp].concat(r.filter(function (p) { return p.id !== lp.id; })); delete sim[lp.id]; }
    var near = [];
    if (String(q || '').trim().length >= 3 && r.length < 3) {
      var have = {}; r.forEach(function (p) { have[p.id] = 1; });
      near = A.matcher().suggest(q, 6).filter(function (c) { return !have[c.product.id]; }).sort(function (a, b) { return (a.conflict ? 1 : 0) - (b.conflict ? 1 : 0) || b.score - a.score; });
    }
    return { list: r, near: near, learnedId: lp ? lp.id : null, similar: sim };
  };
  A.learnSearch = function (q, p) { var k = qKey(q); if (!(k && p)) return Promise.resolve(); return DB.run(function () { return E.learn([{ key: k, productId: p.id }], A.userCtx()); }).catch(function () {}); };
  function nearBox(near, onPick) {
    if (!near.length) return null;
    return h('div', h('div.small.muted', { style: { margin: '10px 4px 4px' } }, 'شاید منظورتان یکی از این‌هاست (با انتخاب، دفعه بعد خودکار پیدا می‌شود):'),
      h('div.list', near.map(function (c) { return productRow(c.product, function () { onPick(c.product); }, c.conflict ? h('div.s', { style: { color: 'var(--warn)' } }, '⚠ ' + c.conflict.join('، ')) : null); })));
  }
  A.nearBox = nearBox;

  // ---------- pickers ----------
  A.pickProduct = function (title, onPick, opts) {
    opts = opts || {};
    var q = h('input.in', { placeholder: 'نام، کد، بارکد، مدل خودرو یا گروه…', type: 'search', autocomplete: 'off' }), list = h('div.list');
    function choose(p, fromNear) {
      var w = q.value; picked = true; s.close();
      if (fromNear || (res && res.learnedId)) A.learnSearch(w, p); // v2.2: remember (or correct) what these words mean
      onPick(p);
    }
    var res = null;
    function draw() {
      UI.clear(list);
      res = A.searchSmart(q.value, opts);
      var r = res.list.slice(0, 60);
      if (!r.length && !res.near.length) list.appendChild(h('div.empty', 'کالایی پیدا نشد.'));
      r.forEach(function (p) { var sm = res.similar[p.id]; list.appendChild(productRow(p, function () { choose(p, sm); }, res.learnedId === p.id ? h('div.s', 'انتخاب قبلی شما') : sm ? h('div.s', { style: { color: 'var(--warn)' } }, 'مشابه') : null)); });
      var nb = nearBox(res.near, function (p) { choose(p, true); }); if (nb) list.appendChild(nb);
    }
    var deb0; q.addEventListener('input', function () { clearTimeout(deb0); deb0 = setTimeout(draw, 100); }); // v2.9: no lag while typing
    var picked = false;
    var s = UI.sheet(title || 'انتخاب کالا', h('div', h('div.row', { style: { marginBottom: '8px' } }, q,
      opts.noScan ? null : h('button.btn.sm', { type: 'button', onclick: function () { picked = true; s.close(); A.openScanner({ title: title, mode: 'pick1', onPick: function (p) { onPick(p); } }); } }, 'اسکن')), list),
      { onClose: function () { if (!picked && opts.onCancel) opts.onCancel(); } });
    draw(); setTimeout(function () { q.focus(); }, 80);
  };
  A.pickCustomer = function (onPick) {
    var q = h('input.in', { placeholder: 'نام یا شماره تلفن…', type: 'search', autocomplete: 'off' }), list = h('div.list');
    function draw() {
      UI.clear(list);
      var n = Core.normText(q.value), ph = Core.normPhone(q.value), BAL = E.allBalances();
      var r = Object.keys(E.state.customers).map(function (k) { return E.state.customers[k]; }).filter(function (c) {
        return !n || Core.normText(c.name).indexOf(n) >= 0 || (ph.length >= 3 && Core.normPhone(c.phone).indexOf(ph) >= 0);
      }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 50);
      if (!r.length) list.appendChild(h('div.empty', 'مشتری پیدا نشد.'));
      r.forEach(function (c) {
        var bal = BAL[c.id] || 0;
        list.appendChild(h('button.li', { type: 'button', style: { width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'right' }, onclick: function () { s.close(); onPick(c); } },
          h('div.grow', h('div.t', c.name), h('div.s.ltr', c.phone || '')), bal ? h('span.badge' + (bal > 0 ? '.bad' : '.ok'), UI.money(bal)) : null));
      });
    }
    q.addEventListener('input', draw);
    var s = UI.sheet('انتخاب مشتری', h('div', h('div.row', { style: { marginBottom: '8px' } }, q,
      h('button.btn.sm.primary', { type: 'button', onclick: function () { s.close(); A.customerForm(null, onPick, q.value); } }, '+ جدید')), list));
    draw(); setTimeout(function () { q.focus(); }, 80);
  };
  A.customerForm = function (c, onSaved, preset) {
    c = c || {};
    var isPhone = preset && /^[\d۰-۹+\s-]+$/.test(preset);
    var name = h('input.in', { value: c.name || (!isPhone && preset) || '', autocomplete: 'off' });
    var phone = h('input.in.ltr-in', { value: c.phone || (isPhone ? preset : ''), inputmode: 'tel', autocomplete: 'off' });
    var city = h('input.in', { value: c.city || '' }), addr = h('input.in', { value: c.address || '' }), notes = h('textarea.in', { value: c.notes || '' });
    var type = sel({ mechanic: 'تعمیرکار', store: 'فروشگاه / همکار', person: 'مشتری شخصی', other: 'سایر' }, c.type || 'other');
    var s = UI.sheet(c.id ? 'ویرایش مشتری' : 'مشتری جدید', h('div', field('نام', name, null, true), field('تلفن همراه', phone), field('نوع', type), field('شهر', city), field('نشانی', addr), field('توضیحات', notes),
      h('button.btn.primary.block', { onclick: function () {
        var data = { name: name.value, phone: phone.value, city: city.value, address: addr.value, notes: notes.value, type: type.value };
        A.run(function () { return c.id ? E.updateCustomer(c.id, data) : E.createCustomer(data); }).then(function (r) { s.close(); UI.toast('مشتری ذخیره شد.', 'ok'); if (onSaved) onSaved(r.customer); }, function () {});
      } }, 'ذخیره')));
    setTimeout(function () { if (!c.id) name.focus(); }, 80);
  };

  // ======================= scanner UI =======================
  /* modes: 'lookup' (find product), 'pick' (multi-item into a form), 'pick1' (return one product), 'code' (return raw code).
     pick + fast mode: a NEW item is added at once (qty 1) and scanning continues; an item ALREADY in the list
     is never incremented silently — the user confirms (+1) on a card. Every step is timed for diagnostics. */
  var SC = { el: document.getElementById('scanner'), scanner: null, opts: null, banner: null, bannerT: null };
  function nowMs() { return performance.now(); }
  function prefs() { return A.lsGet('ay.scanPrefs') || { fast: true, debug: false }; }
  function logScan(ev) {
    var all = A.lsGet('ay.scanStats') || []; all.push(Object.assign({ at: Date.now() }, ev));
    A.lsSet('ay.scanStats', all.slice(-200));
  }
  A.openScanner = function (opts) {
    if (SC.scanner && !SC.el.hidden) { // v2.4: already open (e.g. lookup -> «ورود»): keep the camera, switch to the new list
      SC.opts = opts; document.getElementById('sc-title').textContent = opts.title || 'اسکن';
      var md = document.getElementById('sc-mode'); md.hidden = opts.mode !== 'pick'; md.textContent = prefs().fast ? 'حالت: سریع' : 'حالت: تأیید هر اسکن';
      UI.clear(document.getElementById('sc-slot')); updateCounter(); SC.scanner.resume(); return;
    }
    SC.opts = opts; UI.primeAudio();
    SC.el.hidden = false; document.getElementById('sc-title').textContent = opts.title || 'اسکن';
    UI.clear(document.getElementById('sc-slot'));
    document.getElementById('sc-hint').textContent = 'کد را داخل کادر و در فاصله ۱۵ تا ۲۵ سانتی‌متری نگه دارید';
    var p = prefs(), mode = document.getElementById('sc-mode');
    mode.hidden = opts.mode !== 'pick';
    mode.textContent = p.fast ? 'حالت: سریع' : 'حالت: تأیید هر اسکن';
    updateCounter();
    var video = document.getElementById('sc-video');
    SC.openedAt = nowMs();
    // v2.2: the shop's barcodes (one clean row is enough for them), the method order learned on this phone, the moving line
    var known = E.state.meta.barcodes && E.state.meta.barcodes.v ? Object.keys(E.state.meta.barcodes.v) : [];
    var ms = lsGet('ay.scanModes'); ms = Array.isArray(ms) && ms.length === 5 ? ms : null;
    SC.scanner = new window.Scan.Scanner({ video: video, onCode: onScan, holdMs: 1500, known: known, modeStats: ms, onBand: placeLine });
    SC.scanner.start().then(function () {
      var tb = document.getElementById('sc-torch'); tb.hidden = !SC.scanner.hasTorch(); tb.dataset.on = '';
      if (prefs().debug) debugLoop();
    }).catch(function (e) { showScanErr(window.Scan.camError(e)); });
  };
  function updateCounter() {
    var c = document.getElementById('sc-count'), o = SC.opts;
    if (!o || o.mode !== 'pick' || !o.summary) { c.hidden = true; return; }
    var s = o.summary(); c.hidden = false; c.textContent = UI.fa(s.lines) + ' قلم · ' + UI.fa(s.qty) + ' عدد';
  }
  function debugLoop() {
    var box = document.getElementById('sc-debug');
    if (!SC.scanner || SC.el.hidden) { box.hidden = true; return; }
    var s = SC.scanner.summary(); box.hidden = false;
    box.textContent = 'موتور: ' + s.engine + ' · ' + s.resolution + ' · فریم ' + s.frames + ' · رمزگشایی میانگین ' + s.avgDecodeMs + 'ms (بیشینه ' + s.maxDecodeMs + ') · اولین فریم ' + s.firstFrameMs + 'ms' + (SC.last ? ' · آخرین تشخیص: رمزگشایی ' + SC.last.decodeMs + 'ms، نمایش ' + SC.last.displayMs + 'ms' : '');
    setTimeout(debugLoop, 500);
  }
  function showScanErr(msg) {
    var slot = UI.clear(document.getElementById('sc-slot'));
    slot.appendChild(h('div.sc-err', h('b', 'دوربین در دسترس نیست'), h('p', msg), h('p.small.muted', 'می‌توانید با دکمه «عکس» از کد یا برچسب جعبه عکس بگیرید، کد را دستی وارد کنید یا از «جستجو» استفاده کنید.')));
  }
  function placeLine(pos) { // the red line shows the band being read (centre every frame + upper / lower in turn)
    var ln = document.getElementById('sc-line'), v = document.getElementById('sc-video');
    if (!ln || !v || !v.videoWidth) return;
    var y = pos === 'v' ? 0.5 : pos, s2 = Math.max(v.clientWidth / v.videoWidth, v.clientHeight / v.videoHeight), oy = (v.clientHeight - v.videoHeight * s2) / 2;
    ln.style.top = Math.round(oy + v.videoHeight * s2 * y) + 'px';
  }
  A.closeScanner = function () {
    if (SC.scanner) {
      try { lsSet('ay.scanModes', SC.scanner.modeStats.map(function (n) { return Math.min(n, 5000); })); } catch (e) { /* ignore */ }
      var s = SC.scanner.summary();
      logScan({ type: 'session', mode: SC.opts && SC.opts.mode, engine: s.engine, openMs: s.openMs, firstFrameMs: s.firstFrameMs, frames: s.frames, avgDecodeMs: s.avgDecodeMs, maxDecodeMs: s.maxDecodeMs, detections: s.detections, resolution: s.resolution, durationMs: Math.round(nowMs() - SC.openedAt) });
      SC.scanner.stop();
    }
    SC.scanner = null; clearTimeout(SC.bannerT);
    SC.el.hidden = true; UI.clear(document.getElementById('sc-slot'));
    if (SC.opts && SC.opts.onClose) SC.opts.onClose();
  };
  A.scannerOpen = function () { return !SC.el.hidden; };
  document.getElementById('sc-close').addEventListener('click', function () { A.closeScanner(); });
  document.getElementById('sc-mode').addEventListener('click', function () {
    var p = prefs(); p.fast = !p.fast; A.lsSet('ay.scanPrefs', p);
    this.textContent = p.fast ? 'حالت: سریع' : 'حالت: تأیید هر اسکن';
    UI.toast(p.fast ? 'کالا با یک اسکن اضافه می‌شود. در ورود کالا، اسکن دوباره همان کالا خودکار یکی اضافه می‌کند؛ در فروش تأیید می‌خواهد.' : 'هر اسکن قبل از افزودن تأیید می‌خواهد.', '', 3500);
  });
  document.getElementById('sc-torch').addEventListener('click', function () {
    var b = this, on = !b.dataset.on; SC.scanner && SC.scanner.setTorch(on).then(function (ok) { if (ok) b.dataset.on = on ? '1' : ''; });
  });
  document.getElementById('sc-manual').addEventListener('click', function () {
    if (SC.scanner) SC.scanner.pause();
    UI.promptBox('ورود دستی', 'کد QR، بارکد یا کد کالا (SKU)', { ltr: true }).then(function (v) {
      if (SC.scanner) SC.scanner.resume();
      if (v && v.trim()) onScan({ format: 'manual', text: v.trim(), detectedAt: nowMs(), decodeMs: 0 });
    });
  });
  document.getElementById('sc-search').addEventListener('click', function () {
    var o = SC.opts; if (!o) return;
    if (SC.scanner) SC.scanner.pause();
    A.pickProduct('جستجوی کالا', function (p) { if (SC.scanner) SC.scanner.resume(); onScan({ format: 'search', text: 'AY:' + p.id, detectedAt: nowMs(), decodeMs: 0 }); }, { noScan: true, onCancel: function () { if (SC.scanner) SC.scanner.resume(); } });
  });
  document.getElementById('sc-photo').addEventListener('change', function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    document.getElementById('sc-hint').textContent = 'در حال خواندن عکس…';
    var t0 = nowMs();
    var known = E.state.meta.barcodes && E.state.meta.barcodes.v || null;
    window.Scan.decodeImage(f, { known: known }).then(function (r) {
      document.getElementById('sc-hint').textContent = 'کد را داخل کادر و در فاصله ۱۵ تا ۲۵ سانتی‌متری نگه دارید';
      if (r) { r.detectedAt = nowMs(); r.decodeMs = Math.round(r.detectedAt - t0); onScan(r); }
      else nameScan(f); // v2.2: no barcode in the photo -> recognise the box label (text online / visual memory offline)
    }).catch(function (e) { A.showErr(e); });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && SC.scanner) { SC.scanner.stop(); SC.wasOpen = true; }
    else if (!document.hidden && SC.wasOpen && !SC.el.hidden) { SC.wasOpen = false; A.openScanner(SC.opts); }
  });
  function measured(res, action) { // time from detection to the result being on screen
    requestAnimationFrame(function () {
      var ev = { type: 'scan', format: res.format, decodeMs: res.decodeMs || 0, sinceStart: res.sinceStart || null, displayMs: Math.round(nowMs() - (res.detectedAt || nowMs())), action: action };
      SC.last = ev; logScan(ev);
    });
  }
  function hideBanner() { if (SC.banner && SC.banner.parentNode) SC.banner.parentNode.removeChild(SC.banner); SC.banner = null; }
  // v2.4: every item added while scanning = a beep AND a green flash (the sound may be muted on an iPhone in silent mode)
  function flash() { var f = document.getElementById('sc-flash'); if (!f) { f = h('div#sc-flash'); SC.el.appendChild(f); } f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
  function okFeedback() { UI.beep(); flash(); }
  A.okFeedback = okFeedback;
  // v2.4: the technical code (internal code / model) printed as the barcode — looked up only when no barcode matched
  function techCode(code) {
    var n = window.Match.codeNorm(code); if (n.length < 4) return null;
    var hit = null, many = false;
    Object.keys(E.state.products).forEach(function (k) { var x = E.state.products[k]; if (x.active === false) return; if (window.Match.codeNorm(x.sku) === n || (x.model && window.Match.codeNorm(x.model) === n)) { if (hit && hit !== x) many = true; hit = x; } });
    return many ? null : hit;
  }
  function onScan(res) {
    var o = SC.opts; if (!o) return;
    if (res.suggest && o.mode === 'code') return; // a suggestion is never a new code to link
    if (o.mode === 'code') { UI.beep(); A.closeScanner(); o.onCode(res.text, res); return; }
    var slot = document.getElementById('sc-slot');
    function pauseCard(card) { if (SC.scanner) SC.scanner.pause(); hideBanner(); UI.clear(slot); slot.appendChild(card); }
    function resume() { UI.clear(slot); if (SC.scanner) SC.scanner.resume(); }
    if (res.suggest) { // v2.4: part of a damaged barcode fits exactly ONE of the shop's barcodes -> ask, never add by itself
      var sp = E.findProductByCode(res.text); if (!sp) return;
      UI.beep();
      pauseCard(h('div.sc-card', h('div.small', { style: { color: 'var(--warn)' } }, 'بارکد کامل خوانده نشد. شاید این کالاست؟'),
        h('div', { style: { fontSize: '19px', fontWeight: 700, lineHeight: 1.4 } }, sp.name), h('div.small.muted', [sp.brand, sp.sku].filter(Boolean).join(' · ')), h('div.ltr.small.muted', res.text),
        h('div.grid2', { style: { marginTop: '10px' } }, h('button.btn', { onclick: resume }, 'نه'),
          h('button.btn.primary', { onclick: function () { resume(); onScan(Object.assign({}, res, { suggest: false, gapMs: null })); } }, 'بله، همین است'))));
      measured(res, 'suggest');
      return;
    }
    var p = E.findProductByCode(res.text) || E.findProductBySku(res.text) || techCode(res.text);
    if (!p && o.mode === 'pick' && o.quickDefine && (E.parseCode(res.text) || {}).kind === 'barcode') { // v2.1.2: define it ONCE, here, then keep scanning
      UI.beep(false);
      pauseCard(quickDefineCard(res.text, o, resume));
      measured(res, 'quick-define');
      return;
    }
    if (!p) {
      UI.beep(false);
      var pub = E.parseCode(res.text);
      pauseCard(h('div.sc-card', h('b', pub && pub.kind === 'public' ? 'QR عمومی ناشناخته' : 'کد ناشناخته'), h('div.ltr.small', { style: { margin: '4px 0 10px', wordBreak: 'break-all' } }, res.text),
        h('div.grid2', h('button.btn', { onclick: function () {
          A.pickProduct('اتصال این کد به کالا', function (pp) {
            A.run(function () { return E.mapBarcode(pp.id, res.text, A.userCtx()); }).then(function () { UI.toast('کد به «' + pp.name + '» متصل شد.', 'ok'); onScan(res); }, resume);
          }, { noScan: true, onCancel: resume });
        } }, 'اتصال به کالای موجود'), h('button.btn.primary', { onclick: function () {
          A.state.prefill = { barcode: res.text, back: location.hash, addTo: o.addTo || null };
          A.closeScanner(); A.go('#/product-edit/new');
        } }, 'تعریف کالای جدید')),
        h('button.btn.ghost.block', { onclick: resume }, 'ادامه اسکن')));
      measured(res, 'unknown');
      return;
    }
    if (o.mode === 'pick1') { UI.beep(); A.closeScanner(); o.onPick(p); return; }
    var info = h('div', h('div', { style: { fontSize: '19px', fontWeight: 700, lineHeight: 1.4 } }, p.name), h('div.small.muted', [p.brand, p.sku, p.location].filter(Boolean).join(' · ')), h('div.small', 'موجودی: ', stockBadge(p)));
    if (o.mode === 'lookup') {
      UI.beep();
      pauseCard(h('div.sc-card', info, h('div.grid3', { style: { marginTop: '10px' } },
        h('button.btn.sm', { onclick: function () { A.closeScanner(); A.go('#/product/' + p.id); } }, 'مشاهده'),
        h('button.btn.sm', { onclick: function () { adopt('in'); } }, 'ورود'),
        h('button.btn.sm.primary', { onclick: function () { adopt('out'); } }, 'خروج')),
        h('button.btn.ghost.block', { onclick: resume }, 'اسکن بعدی')));
      measured(res, 'lookup');
      return;
    }
    // v2.4: «ورود» / «خروج» from the lookup scanner: the item goes to the list and the SAME camera keeps scanning for that list
    function adopt(kind) {
      var n = 1; A.addToDraft(kind, p, n); // v2.4.1: one scan = one unit
      UI.clear(slot); okFeedback(); UI.toast('«' + p.name + '» اضافه شد', 'ok', 1500);
      A.state.adoptScan = kind; A.state.keepScanner = true; A.go('#/' + kind);
    }
    // ---- pick (multi-item) ----
    var inCart = o.inCart ? o.inCart(p.id) : 0, avail = o.avail ? o.avail(p.id) : p.stock;
    var sq = 1; // v2.4.1: one scan = ONE unit of the variant (a box of 2 counts as 1; its price is the box price)
    if (o.checkStock && inCart + sq > avail) {
      UI.beep(false);
      pauseCard(h('div.sc-card', info, h('div.alert.bad', { style: { marginTop: '8px' } }, 'موجودی کافی نیست: موجودی ' + UI.qty(avail) + (inCart ? '، در لیست ' + UI.qty(inCart) : '') + '.'),
        h('button.btn.block', { onclick: resume }, 'ادامه اسکن')));
      measured(res, 'no-stock');
      return;
    }
    // v2.1.2: when RECEIVING goods (addTo 'in') a repeat scan of the same item adds +1 automatically (the anti-duplicate
    // hold of the scanner still ignores a code that simply stays in view). A repeat less than 2 s after the code was last
    // seen still asks (protects against a barcode that is read only now and then while held still). Sales keep the confirmation.
    var autoRepeat = o.addTo === 'in' && inCart > 0 && !(res.gapMs != null && res.gapMs < 2000);
    if (prefs().fast && (inCart === 0 || autoRepeat)) { // new item (or a repeat while receiving) -> add immediately, keep scanning
      o.onPick(p, sq); okFeedback(); updateCounter();
      hideBanner(); clearTimeout(SC.bannerT);
      var qtyEl = h('b', UI.fa(o.inCart ? o.inCart(p.id) : sq));
      SC.banner = h('div.sc-card.sc-banner', h('div.row', h('div.grow', h('div', { style: { fontSize: '18px', fontWeight: 700, lineHeight: 1.35 } }, autoRepeat ? '+' + UI.fa(sq) + ' ' : '✓ ', p.name),
        h('div.small.muted', [p.brand, p.sku, sq > 1 ? 'جعبه ' + UI.fa(sq) + ' تایی' : ''].filter(Boolean).join(' · '))),
        h('div.stepper', h('button', { onclick: function () { o.onPick(p, 1); qtyEl.textContent = UI.fa(o.inCart(p.id)); updateCounter(); keep(); } }, '+'), h('span', { style: { minWidth: '34px', textAlign: 'center', fontSize: '17px' } }, qtyEl),
          h('button', { onclick: function () { if (o.inCart(p.id) > 1) { o.onAdjust(p, -1); qtyEl.textContent = UI.fa(o.inCart(p.id)); updateCounter(); } keep(); } }, '−'))),
        h('div.row', { style: { marginTop: '8px' } }, h('span.small.muted.grow', 'اسکن ادامه دارد…'), h('button.btn.sm.ghost', { onclick: function () { o.onRemove(p); updateCounter(); hideBanner(); UI.toast('«' + p.name + '» از لیست حذف شد.'); } }, 'حذف از لیست')));
      slot.appendChild(SC.banner);
      function keep() { clearTimeout(SC.bannerT); SC.bannerT = setTimeout(hideBanner, 6000); }
      keep();
      measured(res, autoRepeat ? 'auto-repeat' : 'auto-add');
      return;
    }
    // already in the list (or careful mode): confirm before adding — never increment silently
    UI.beep();
    var q = sq, warn = h('div.hint.bad');
    function chk() { warn.textContent = o.checkStock && q + inCart > avail ? 'بیشتر از موجودی (' + UI.qty(avail) + ')' : ''; }
    chk();
    pauseCard(h('div.sc-card', inCart ? h('div.alert.warn', { style: { marginBottom: '8px' } }, 'این کالا قبلاً اسکن شده؛ ' + UI.qty(inCart) + ' عدد در لیست است. فقط اگر واقعاً یکی دیگر دارید اضافه کنید.') : null, info,
      h('div.row.between', { style: { marginTop: '10px' } }, h('span', inCart ? 'اضافه کردن:' : 'تعداد:'), stepper(sq, function (v) { q = v; chk(); })), warn,
      h('div.grid2', { style: { marginTop: '10px' } }, h('button.btn', { onclick: resume }, inCart ? 'نه، اضافه نکن' : 'رد'),
        h('button.btn.primary', { onclick: function () {
          if (o.checkStock && q + inCart > avail) { UI.beep(false); return; }
          o.onPick(p, q); updateCounter(); okFeedback(); UI.toast('«' + p.name + '» × ' + UI.fa(q) + ' اضافه شد', 'ok', 1500); resume();
        } }, inCart ? '+ ' + UI.fa(sq) + ' اضافه کن' : 'افزودن'))));
    measured(res, inCart ? 'repeat-confirm' : 'confirm');
  }
  /* v2.2 box-label recognition from a photo: online text reading (Google Vision, only if a key is set and the phone is
     online) + offline visual memory of labels confirmed before. Up to 4 products are OFFERED; nothing is added without
     the user's tap. Every confirmation is learned (label fingerprint + the text line), so it gets better with use. */
  function ocrCfg() { var c = lsGet('ay.ocr'); return c && c.key && c.on !== false ? c : null; }
  A.ocrCfg = ocrCfg;
  function imageData(file, maxSide) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        var s = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight)), w = Math.round(im.naturalWidth * s), hh = Math.round(im.naturalHeight * s);
        var c = document.createElement('canvas'); c.width = w; c.height = hh; var x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, w, hh);
        URL.revokeObjectURL(url); res({ canvas: c, data: x.getImageData(0, 0, w, hh) });
      };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('تصویر قابل خواندن نیست.')); };
      im.src = url;
    });
  }
  function nameScan(file) {
    var o = SC.opts; if (!o) return;
    var slot = document.getElementById('sc-slot'); if (SC.scanner) SC.scanner.pause(); hideBanner(); UI.clear(slot);
    function resume() { UI.clear(slot); if (SC.scanner) SC.scanner.resume(); }
    var cfg = ocrCfg(), online = !!cfg && navigator.onLine !== false;
    slot.appendChild(h('div.sc-card', h('b', 'در حال شناسایی نام کالا…'), h('div.small.muted', online ? 'متن برچسب با اینترنت خوانده می‌شود و با کالاهای شما مقایسه می‌شود.' : 'بدون اینترنت: مقایسه با برچسب‌هایی که قبلاً تأیید کرده‌اید.')));
    Promise.all([imageData(file, 640), online ? imageData(file, 1600) : null]).then(function (r) {
      var d = r[0].data, fp = window.Vision.fingerprint(d.data, d.width, d.height), q = window.Vision.query(d.data, d.width, d.height);
      var ocrP = online ? window.Vision.ocrOnline(cfg, r[1].canvas.toDataURL('image/jpeg', 0.8).split(',')[1]).catch(function (e) { return { err: e }; }) : Promise.resolve(null);
      return ocrP.then(function (text) {
        var err = text && text.err; if (err) text = null;
        var C = {}, M = A.matcher(), lineOf = {};
        function put(p, sc, why, line) { if (!p || p.active === false) return; var c = C[p.id]; if (!c || sc > c.score) C[p.id] = { p: p, score: sc, why: why }; if (line) lineOf[p.id] = line; }
        if (text) {
          var lines = text.split(/\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x.length >= 3; }).slice(0, 12);
          [lines.slice(0, 3).join(' ')].concat(lines).forEach(function (ln) {
            M.match({ name: ln, code: /[A-Za-z0-9]{4,}/.test(ln) ? ln : '' }, { limit: 4, min: 45 }).candidates.forEach(function (c) { if (!c.conflict) put(c.product, c.score, c.kind === 'learned' ? 'قبلاً تأیید شده' : 'از متن برچسب', ln); });
          });
        }
        window.Vision.rank(q, E.visualMemory(), 4).forEach(function (v) { if (v.score >= 0.6) put(E.state.products[v.productId], Math.round(v.score * 95), 'از شکل جعبه'); });
        var list = Object.keys(C).map(function (k) { return C[k]; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 4);
        UI.clear(slot);
        function choose(p) {
          var steps = [function () { return E.learnVisual(p.id, fp, A.userCtx()); }], ln = lineOf[p.id] || (text ? text.split(/\n+/)[0] : '');
          if (ln) steps.push(function () { return E.learn(M.learnKeys({ name: ln }).map(function (k) { return { key: k, productId: p.id }; }), A.userCtx()); });
          DB.run(DB.batch(steps)).catch(function () {});
          UI.clear(slot); if (SC.scanner) SC.scanner.resume();
          onScan({ format: 'name', text: 'AY:' + p.id, qty: 1, detectedAt: nowMs(), decodeMs: 0 });
        }
        slot.appendChild(h('div.sc-card', h('b', list.length ? 'کدام کالاست؟' : 'کالا شناخته نشد'),
          err ? h('div.small', { style: { color: 'var(--warn)' } }, 'خواندن متن با اینترنت ممکن نشد (' + (err.message || err) + ')؛ فقط مقایسه با برچسب‌های قبلی انجام شد.') : null,
          !online ? h('div.small.muted', cfg ? 'اینترنت وصل نیست؛ فقط برچسب‌هایی که قبلاً تأیید کرده‌اید شناخته می‌شوند.' : 'خواندن متن با اینترنت تنظیم نشده (تنظیمات)؛ فقط برچسب‌هایی که قبلاً تأیید کرده‌اید شناخته می‌شوند.') : null,
          list.map(function (c) { return h('button.btn.block', { type: 'button', style: { margin: '6px 0', textAlign: 'right' }, onclick: function () { choose(c.p); } }, h('b', c.p.name), h('div.small.muted', [c.p.brand, c.why].filter(Boolean).join(' · '))); }),
          h('div.grid2', { style: { marginTop: '8px' } }, h('button.btn', { onclick: resume }, 'رد'),
            h('button.btn', { onclick: function () { A.pickProduct('کدام کالاست؟', choose, { noScan: true, onCancel: resume }); } }, 'جستجو و انتخاب')),
          h('div.small.muted', { style: { marginTop: '6px' } }, 'با هر انتخاب، برنامه این برچسب را یاد می‌گیرد.')));
      });
    }).catch(function (e) { UI.clear(slot); if (SC.scanner) SC.scanner.resume(); A.showErr(e); });
  }

  /* v2.1.2 quick definition of an unknown factory barcode while receiving: name (+ brand) only. The product is created
     at once with this barcode, one unit goes into the list and scanning continues; the next scan of the same barcode
     is recognised and adds +1. Prices and the other details are completed later (receipt list / product page). */
  function autoSku(code) {
    var base = String(code).replace(/\s+/g, '').slice(0, 40);
    if (!base || /^(AY|AYP):/i.test(base)) base = 'P' + Date.now().toString(36).toUpperCase();
    var s = base, n = 1; while (E.findProductBySku(s)) s = base + '-' + (++n);
    return s;
  }
  function quickDefineCard(code, o, resume0) {
    function resume() { if (SC.scanner && SC.scanner.touch) SC.scanner.touch(code); resume0(); } // the box is usually still in view
    var name = h('input.in', { placeholder: 'نام کالا (الزامی)', autocomplete: 'off', enterkeyhint: 'done' }), brand = h('input.in', { placeholder: 'برند (اختیاری)', autocomplete: 'off', enterkeyhint: 'done' });
    var msg = h('div'), sugg = h('div'), go = h('button.btn.primary', { onclick: function () { save(false); } }, 'ثبت و افزودن');
    function qty() { return 1; } // v2.4.1: one scan = ONE unit of the variant (a box of 2, a set, a piece); the box content is only a property
    [name, brand].forEach(function (el) { el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); save(false); } }); });
    function added(p, how, n) { if (SC.scanner && SC.scanner.addKnown) SC.scanner.addKnown(code); o.onPick(p, n); updateCounter(); okFeedback(); UI.toast('«' + p.name + '» ' + how + '؛ ' + UI.fa(n) + ' عدد به لیست اضافه شد.', 'ok', 2200); resume(); }
    function link(p) {
      var n = qty();
      var steps = [function () { return E.mapBarcode(p.id, code, A.userCtx(), { qty: 1 }); }];
      DB.run(DB.batch(steps)).then(function () { added(E.state.products[p.id], 'با این بارکد متصل شد', n); }, A.showErr);
    }
    // v2.2: while the name is typed, similar existing items are offered (a damaged / differently written name -> guess + confirm)
    var deb;
    function suggest() {
      UI.clear(sugg);
      if (name.value.trim().length < 3) return;
      var r = A.matcher().match({ name: name.value, brand: brand.value }, { limit: 3, min: 50 }).candidates.filter(function (c) { return !c.conflict; });
      if (!r.length) return;
      sugg.appendChild(h('div.small.muted', { style: { margin: '6px 0 4px' } }, 'شاید همین کالاست؟'));
      r.forEach(function (c) { sugg.appendChild(h('button.btn.sm.block', { type: 'button', style: { marginBottom: '4px', textAlign: 'right' }, onclick: function () { link(c.product); } }, 'همین است: ' + c.product.name + (c.product.brand ? ' — ' + c.product.brand : ''))); });
    }
    [name, brand].forEach(function (el) { el.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(suggest, 200); }); });
    function save(allowDup) {
      var nm = name.value.trim(), n = qty();
      if (!nm) { UI.toast('نام کالا را بنویسید.', 'bad'); name.focus(); return; }
      go.disabled = true;
      // v2.3: a known or learned part type gets its group right away (a mere guess is left for «مرتب‌سازی گروه‌ها»); cars from the name
      var g = A.classifier().guess(nm, { brand: brand.value.trim() }), sure = g.conf !== 'guess', mk = sure && !g.categoryId;
      var steps = mk ? [function () { return E.ensureCategoryPath(g.path, A.userCtx()); }] : [];
      steps.push(function (dn) { return E.createProduct({ sku: autoSku(code), name: nm, brand: brand.value.trim(), barcodes: [code],
        categoryId: sure ? (mk ? dn[0].category.id : g.categoryId) : null, cars: g.cars, allowDuplicate: allowDup === true }, A.userCtx()); });
      DB.run(DB.batch(steps))
        .then(function (res) { added(res[res.length - 1].product, 'تعریف شد', n); }, function (e) {
          go.disabled = false;
          var ex = e && e.code === 'DUP_NAME' && e.details && E.state.products[e.details.productId];
          if (!ex) { A.showErr(e); return; }
          UI.clear(msg).appendChild(h('div.alert.warn', h('div.grow', 'کالای «' + ex.name + '»' + (ex.brand ? ' (' + ex.brand + ')' : '') + ' قبلاً تعریف شده است.',
            h('div.grid2', { style: { marginTop: '8px' } },
              h('button.btn.sm', { onclick: function () { link(ex); } }, 'همان کالاست؛ بارکد را وصل کن'),
              h('button.btn.sm', { onclick: function () { save(true); } }, 'کالای دیگری است؛ جدا ثبت کن')))));
        });
    }
    setTimeout(function () { try { name.focus(); } catch (e) { /* ignore */ } }, 60);
    return h('div.sc-card#quick-define', h('b', 'کالای جدید'), h('div.ltr.small.muted', { style: { margin: '2px 0 8px', wordBreak: 'break-all' } }, code),
      h('p.small', 'فقط همین یک بار: اگر کالا در لیست قیمت هست، چند حرف از نامش را بنویسید و «همین است» را بزنید؛ وگرنه نام (و برند). هر اسکن این بارکد = ۱ عدد از همین تنوع (جعبه، ست یا عدد)د. قیمت‌ها را بعداً وارد کنید.'),
      h('div.stack', name, brand), sugg,
      msg,
      h('div.grid2', { style: { marginTop: '10px' } }, h('button.btn', { onclick: resume }, 'رد / ادامه اسکن'), go),
      h('button.btn.ghost.block', { onclick: function () { A.pickProduct('اتصال این بارکد به کالا', link, { noScan: true, onCancel: resume }); } }, 'این کالا قبلاً تعریف شده (اتصال بارکد)'));
  }

  // ======================= drafts (receipt / issue) =======================
  A.newDraft = function (kind) {
    var d = { opKey: UI.opKey(kind), kind: kind, type: kind === 'in' ? 'purchase' : 'sale', items: [], date: '', note: '', supplier: '', supplierDocNo: '', customerId: null, recipient: '', discount: null, payments: [] };
    lsSet('ay.draft.' + kind, d); return d;
  };
  A.draft = function (kind) { return lsGet('ay.draft.' + kind) || A.newDraft(kind); };
  A.saveDraft = function (d) { lsSet('ay.draft.' + d.kind, d); };
  A.addToDraft = function (kind, p, q) {
    var d = A.draft(kind), it = d.items.filter(function (x) { return x.productId === p.id; })[0];
    if (it) it.qty += q; else d.items.push({ productId: p.id, qty: q, unitCost: null, unitPrice: kind === 'out' ? p.sellPrice : null, discount: null });
    A.saveDraft(d);
  };

  // ======================= routing =======================
  function route() {
    var hs = location.hash.replace(/^#\/?/, ''), parts = hs.split('?')[0].split('/'), name = parts[0] || '', arg = parts[1] ? decodeURIComponent(parts[1]) : null;
    var query = {}; (hs.split('?')[1] || '').split('&').forEach(function (kv) { if (kv) { var p = kv.split('='); query[p[0]] = decodeURIComponent(p[1] || ''); } });
    UI.closeAllSheets();
    if (A.scannerOpen && A.scannerOpen() && !A.state.keepScanner) A.closeScanner(); // navigating away always releases the camera (v2.4: except lookup -> list)
    A.state.keepScanner = false;
    if (!E.getMeta('shop') && name !== 'setup') { location.replace('#/setup'); return; }
    var fn = A.routes[name] || A.routes[''];
    UI.clear(view);
    try { fn(arg, query); } catch (e) { A.showErr(e); view.appendChild(h('div.alert.bad', A.errMsg(e))); }
    var tab = { '': 'home', products: 'products', product: 'products', 'product-edit': 'products', docs: 'docs', doc: 'docs', 'in': 'home', out: 'home' }[name] || 'more';
    Array.prototype.forEach.call(document.querySelectorAll('#tabbar a'), function (a) { a.classList.toggle('on', a.dataset.tab === tab); });
    document.getElementById('tabbar').hidden = name === 'setup';
    window.scrollTo(0, 0);
  }
  A.route = route;
  window.addEventListener('hashchange', route);
  document.getElementById('tb-back').addEventListener('click', function () { if (history.length > 1) history.back(); else A.go('#/'); });

  function buildTabbar() {
    var tb = UI.clear(document.getElementById('tabbar'));
    [['home', '#/', 'home', 'خانه'], ['products', '#/products', 'box', 'کالاها'], ['scan', '', 'scan', 'اسکن'], ['docs', '#/docs', 'doc', 'اسناد'], ['more', '#/more', 'more', 'بیشتر']].forEach(function (t) {
      var a = h('a' + (t[0] === 'scan' ? '.scan' : ''), { href: t[1] || '#', 'data-tab': t[0], onclick: t[0] === 'scan' ? function (e) { e.preventDefault(); A.openScanner({ mode: 'lookup', title: 'اسکن و استعلام' }); } : null },
        UI.icon(t[2]), h('small', t[3]));
      tb.appendChild(a);
    });
  }

  // ======================= HOME =======================
  A.routes[''] = function () {
    var shop = A.shop();
    setTitle(shop.name || 'امیران یدک', false);
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    if (!window.isSecureContext) view.appendChild(h('div.alert.bad', h('div.grow', 'برنامه با HTTPS باز نشده است؛ دوربین و برخی امکانات کار نمی‌کنند. نشانی را با https:// باز کنید.')));
    if (isIOS && !standalone) view.appendChild(h('div.alert.warn', h('div.grow', h('b', 'برنامه را نصب کنید: '), 'در Safari دکمه اشتراک‌گذاری (مربع با فلش) ← «Add to Home Screen» را بزنید و از این به بعد برنامه را فقط از آیکون صفحه اصلی باز کنید. اطلاعات داخل Safari و برنامه نصب‌شده از هم جدا هستند.')));
    var counts = Object.keys(E.state.products).length + Object.keys(E.state.docs).length;
    var bk = E.getMeta('backup');
    if (counts > 0 && (!bk || Date.now() - bk.at > 7 * 864e5)) view.appendChild(h('a.alert.warn', { href: '#/settings', style: { textDecoration: 'none' } }, h('div.grow', bk ? 'آخرین پشتیبان ' + UI.fa(Math.floor((Date.now() - bk.at) / 864e5)) + ' روز پیش گرفته شده. ' : 'هنوز فایل پشتیبان نگرفته‌اید. ', h('b', 'الان پشتیبان بگیرید ←'))));
    var bad = E.reconcile();
    if (bad.length) view.appendChild(h('a.alert.bad', { href: '#/report/reconcile', style: { textDecoration: 'none' } }, h('div.grow', 'مغایرت موجودی در ' + UI.fa(bad.length) + ' کالا — بررسی کنید')));

    view.appendChild(h('div.tiles',
      h('a.tile.hl', { href: '#/out' }, UI.icon('out'), 'فروش / خروج'),
      h('a.tile.hl', { href: '#/in' }, UI.icon('in'), 'ورود کالا'),
      h('a.tile', { href: '#', onclick: function (e) { e.preventDefault(); A.openScanner({ mode: 'lookup', title: 'اسکن و استعلام' }); } }, UI.icon('scan'), 'اسکن و استعلام'),
      h('a.tile', { href: '#/customers' }, UI.icon('user'), 'مشتریان و دریافت'),
      h('a.tile', { href: '#/product-edit/new' }, UI.icon('plus'), 'کالای جدید'),
      h('a.tile', { href: '#/reports' }, UI.icon('chart'), 'گزارش‌ها')));

    var t0 = UI.startOfDay(Date.now()), sales = E.salesLines({ from: t0 }), inv = {};
    sales.forEach(function (r) { inv[r.docId] = r.invoiceTotal; });
    var todaySum = Object.keys(inv).reduce(function (s, k) { return s + inv[k]; }, 0);
    var debt = E.debtors().reduce(function (s, d) { return s + d.balance; }, 0);
    var sr = E.stockReport(), low = sr.filter(function (r) { return r.active && (r.stock <= 0 || r.low); }).length;
    view.appendChild(h('div.stats',
      h('a.stat', { href: '#/report/invoices' }, h('b', UI.money(todaySum)), h('span', 'فروش امروز (' + UI.fa(Object.keys(inv).length) + ' فاکتور) — تومان')),
      h('a.stat', { href: '#/report/debtors' }, h('b', UI.money(debt)), h('span', 'طلب از مشتریان — تومان')),
      h('a.stat', { href: '#/report/low' }, h('b', UI.qty(low)), h('span', 'کالای کم‌موجود / ناموجود')),
      h('a.stat', { href: '#/products' }, h('b', UI.qty(sr.length)), h('span', 'تعداد کالا'))));

    if (A.alertsCard) view.appendChild(A.alertsCard());
    var recent = E.allDocs().slice(-6).reverse();
    view.appendChild(h('div.sec-title', 'آخرین اسناد'));
    if (!recent.length) view.appendChild(h('div.card.empty', 'هنوز سندی ثبت نشده. برای شروع، کالاها را تعریف کنید یا از «بیشتر ← ورود دسته‌جمعی» فایل اکسل کالاها را وارد کنید.'));
    else view.appendChild(h('div.list', recent.map(docRow)));
  };

  function docRow(d) {
    var c = d.customerId && E.state.customers[d.customerId];
    var label = window.Reports.docTypeLabel(d);
    var isSale = d.kind === 'out' && d.type === 'sale';
    var rt = d.kind === 'in' ? A.receiptTotal(d) : null; // v2.10: a purchase shows its total (marked when some rows have no cost)
    var amount = isSale ? h('div.s', UI.money(d.total)) : d.kind === 'return' ? h('div.s', '− ' + UI.money(d.total)) : rt && rt.total ? h('div.s', UI.money(rt.total) + (rt.missing ? ' (ناقص)' : '')) : h('div.s', UI.qty(d.lines.reduce(function (s, l) { return s + Math.abs(l.qty); }, 0)) + ' قلم');
    var st = d.status === 'reversed' ? h('span.badge.bad', isSale ? 'لغوشده' : 'برگشت‌خورده') : isSale ? h('span.badge' + (d.settlement === 'settled' ? '.ok' : d.settlement === 'partial' || d.settlement === 'credit' ? '.warn' : '.bad'), window.Reports.SETTLE[d.settlement]) : h('span.badge', label);
    return h('a.li', { href: '#/doc/' + d.id }, h('div.grow', h('div.t', (isSale ? d.invoiceNo : d.no) + ' — ' + label), h('div.s', UI.dateFa(d.ts, true) + (c ? ' · ' + c.name : d.supplier ? ' · ' + d.supplier : d.recipient ? ' · ' + d.recipient : ''))), h('div.e', st, amount));
  }
  A.docRow = docRow;
  var FIELD_FA = { name: 'نام', sku: 'کد کالا', brand: 'برند', model: 'مدل', family: 'خانواده', categoryId: 'گروه', category: 'گروه (متن)', unit: 'واحد', packSize: 'تعداد در واحد',
    minStock: 'حداقل موجودی', buyPrice: 'قیمت خرید', sellPrice: 'قیمت فروش', location: 'محل', notes: 'توضیحات', active: 'فعال', barcodes: 'بارکدها', supplierId: 'تأمین‌کننده',
    warrantyMonths: 'گارانتی', attrs: 'مشخصات اختصاصی', shortName: 'نام کوتاه', phone: 'تلفن', city: 'شهر', address: 'نشانی', type: 'نوع', publicCode: 'کد عمومی', parentId: 'والد', attrDefs: 'مشخصات گروه' };
  function auditVal(k, v) {
    if (v == null || v === '') return '—';
    if (k === 'categoryId') return A.categoryLabel(v) || v;
    if (k === 'supplierId') return E.state.suppliers[v] ? E.state.suppliers[v].name : v;
    if (k === 'buyPrice' || k === 'sellPrice') return UI.money(v);
    if (k === 'active') return v ? 'بله' : 'خیر';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  A.auditRow = function (a) {
    var ACT = { create: 'ایجاد', update: 'ویرایش', delete: 'حذف' };
    var keys = Object.keys(a.changes || {}).filter(function (k) { return a.action !== 'create' || ['name', 'sku', 'sellPrice', 'buyPrice'].indexOf(k) >= 0; });
    return h('div.line.small', h('div', h('b', ACT[a.action] || a.action), ' · ' + UI.dateFa(a.ts, true) + ' · ' + (a.user || '') + (a.reason ? ' · علت: ' + a.reason : '')),
      keys.map(function (k) { var c = a.changes[k]; return h('div.muted', (FIELD_FA[k] || k) + ': ' + (a.action === 'create' ? auditVal(k, c[1]) : auditVal(k, c[0]) + ' ← ' + auditVal(k, c[1]))); }));
  };

  // ======================= PRODUCTS =======================
  A.routes.products = function (arg, query) {
    setTitle('کالاها', false, h('a.tb-btn', { href: '#/import', style: { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' } }, 'ورود اکسل'));
    var state = A.lsGet('ay.prodFilter') || { f: 'all' };
    var q = h('input.in', { type: 'search', placeholder: 'جستجو: نام، کد، بارکد، مدل خودرو، گروه، مشخصات…', value: query.q || '', autocomplete: 'off' });
    var list = h('div'), chips = h('div.chips');
    var filters = { all: 'همه', low: 'کم‌موجود', zero: 'ناموجود', inactive: 'غیرفعال' };
    Object.keys(filters).forEach(function (k) { chips.appendChild(h('button.chip' + (state.f === k ? '.on' : ''), { onclick: function () { state.f = k; A.lsSet('ay.prodFilter', state); Array.prototype.forEach.call(chips.children, function (c, i) { c.classList.toggle('on', Object.keys(filters)[i] === k); }); draw(); } }, filters[k])); });
    var limit = 150;
    function draw() {
      UI.clear(list);
      // v2.5: ranked results; the user's earlier choice for the same words first; «similar» ones (a word did not match) after
      var det = productSearch(q.value, { includeInactive: state.f === 'inactive', detail: true });
      det = det.filter(function (x) {
        var p = x.product;
        return state.f === 'low' ? p.stock > 0 && p.minStock > 0 && p.stock <= p.minStock : state.f === 'zero' ? p.stock <= 0 : state.f === 'inactive' ? p.active === false : true;
      });
      var lk = qKey(q.value), LL = lk ? E.learned(lk) : null;
      if (LL) det.sort(function (a, b) { return (b.product.id === LL.productId ? 1 : 0) - (a.product.id === LL.productId ? 1 : 0); }); // stable: only lifts it
      if (LL) det.forEach(function (x) { if (x.product.id === LL.productId) x.full = true; });
      var r = det.filter(function (x) { return x.full; }).map(function (x) { return x.product; }), sim = det.filter(function (x) { return !x.full; });
      list.appendChild(h('div.muted', { style: { margin: '0 4px 6px' } }, UI.fa(r.length) + ' کالا' + (sim.length ? ' · ' + UI.fa(sim.length) + ' مشابه' : '')));
      var w = q.value, pickSim = function (p) { A.learnSearch(w, p).then(function () { A.go('#/product/' + p.id); }); };
      var simRow = function (x) { return productRow(x.product, function () { pickSim(x.product); }, x.conflict ? h('div.s', { style: { color: 'var(--warn)' } }, '⚠ ' + x.conflict.join('، ')) : h('div.s', { style: { color: 'var(--warn)' } }, x.tier === 'similar' ? 'نوشتار نزدیک' : 'یک کلمه فرق دارد')); };
      if (!r.length) { // v2.9: never an empty screen when something close exists; nothing is presented as an exact result by guess
        list.appendChild(h('div.card.empty', Object.keys(E.state.products).length ? 'کالایی با این مشخصات پیدا نشد.' : 'هنوز کالایی تعریف نشده است.'));
        var have = {}; sim.forEach(function (x) { have[x.product.id] = 1; });
        var more = w.trim().length >= 3 && state.f === 'all' && sim.length < 6 ? A.matcher().suggest(w, 6).filter(function (c) { return !have[c.product.id]; }) : [];
        if (sim.length || more.length) {
          list.appendChild(h('div', h('div.small.muted', { style: { margin: '10px 4px 4px' } }, 'شاید منظورتان یکی از این‌هاست (با انتخاب، دفعه بعد خودکار پیدا می‌شود):'),
            h('div.list', sim.map(simRow).concat(more.map(function (c) { return simRow({ product: c.product, conflict: c.conflict, tier: 'similar' }); })))));
        }
        return;
      }
      var box = h('div.list'); r.slice(0, limit).forEach(function (p) { box.appendChild(productRow(p, null, LL && p.id === LL.productId ? h('div.s', 'انتخاب قبلی شما') : null)); }); list.appendChild(box);
      if (r.length > limit) list.appendChild(h('button.btn.block', { onclick: function () { limit += 300; draw(); } }, 'نمایش بیشتر (' + UI.fa(r.length - limit) + ')'));
      if (sim.length && r.length <= limit) {
        list.appendChild(h('div', h('div.small.muted', { style: { margin: '10px 4px 4px' } }, 'شاید منظورتان (مشابه):'), h('div.list', sim.map(simRow))));
      }
    }
    var deb; q.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(draw, 120); });
    view.appendChild(h('div.search', q, h('button.btn', { onclick: function () { A.openScanner({ mode: 'lookup', title: 'اسکن و استعلام' }); } }, UI.icon('scan'))));
    view.appendChild(chips); view.appendChild(list);
    view.appendChild(h('a.fab', { href: '#/product-edit/new', 'aria-label': 'کالای جدید', html: UI.ICONS.plus }));
    draw();
  };

  A.routes.product = function (id) {
    var p = E.state.products[id];
    if (!p) { setTitle('کالا', true); view.appendChild(h('div.card.empty', 'کالا پیدا نشد.')); return; }
    setTitle(p.name, true, h('a.tb-btn', { href: '#/product-edit/' + p.id, style: { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' } }, 'ویرایش'));
    var qr = window.QR.encode('AY:' + p.id, 'H', 2), cv = h('canvas.qr-prev', { width: qr.size + 4, height: qr.size + 4 }), cx = cv.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, qr.size + 4, qr.size + 4); cx.fillStyle = '#000';
    qr.modules.forEach(function (row, y) { row.forEach(function (m, x) { if (m) cx.fillRect(x + 2, y + 2, 1, 1); }); });
    var avg = E.avgCost(p), unk = Math.max(0, p.stock - (p.costedQty || 0));
    view.appendChild(h('div.card', h('div.row', h('div.grow',
      h('div.muted', [p.brand, p.model, A.categoryLabel(p.categoryId) || p.category].filter(Boolean).join(' · ') || '—'),
      h('div.big-num', UI.qty(p.stock), h('span.muted', { style: { fontSize: '16px' } }, ' ' + (p.unit || ''))),
      p.packSize > 1 ? h('div.small.muted', 'هر ' + p.unit + ' = ' + UI.fa(p.packSize) + ' عدد — جمع: ' + UI.qty(p.stock * p.packSize) + ' عدد') : null,
      p.active === false ? h('span.badge.bad', 'غیرفعال') : stockBadge(p)), cv),
      h('dl.kv', { style: { marginTop: '10px' } },
        h('dt', 'کد کالا'), h('dd.ltr', p.sku),
        (p.cars || []).length ? [h('dt', 'خودرو'), h('dd', p.cars.join('، '))] : null,
        h('dt', 'قیمت فروش'), h('dd', UI.moneyT(p.sellPrice)),
        p.boxQty > 1 ? [h('dt', 'محتوای هر واحد'), h('dd', UI.fa(p.boxQty) + ' عدد داخل هر جعبه (موجودی و قیمت برای کل جعبه است)')] : null,
        p.cartonQty > 1 ? [h('dt', 'تعداد در کارتن'), h('dd', UI.fa(p.cartonQty) + ' عدد' + (p.sellPrice != null ? ' — قیمت کارتن: ' + UI.moneyT(p.sellPrice * p.cartonQty) : ''))] : null,
        // v2.9: ONE purchase price for accounting (what the stock really cost); «today's» price is information only
        (function () {
          var rp = E.replacementCost(p.id, null), out = [];
          if (p.stock > 0) {
            out.push(h('dt', 'بهای خرید موجودی'), h('dd', avg == null ? 'نامشخص' : UI.moneyT(avg)));
            if (rp && rp.unitCost !== avg) out.push(h('dt', 'قیمت خرید امروز (فقط برای اطلاع)'), h('dd', UI.moneyT(rp.unitCost) + ' (' + (rp.kind === 'list' ? 'لیست قیمت ' : 'ورود ') + UI.dateFa(rp.ts) + ')',
              p.sellPrice != null ? h('div.small.muted', 'سود واقعی هر واحد اگر امروز جایگزین کنید: ' + UI.moneyT(p.sellPrice - rp.unitCost)) : null));
          } else {
            var one = rp ? rp.unitCost : p.buyPrice;
            out.push(h('dt', 'قیمت خرید'), h('dd', one == null ? '—' : UI.moneyT(one) + (rp ? ' (' + (rp.kind === 'list' ? 'لیست قیمت ' : 'ورود ') + UI.dateFa(rp.ts) + ')' : ' (آخرین خرید)')));
          }
          return out;
        })(),
        unk > 0 ? [h('dt', 'موجودی بدون بهای خرید'), h('dd', UI.qty(unk) + ' — ', h('a', { href: '#/costs?p=' + encodeURIComponent(p.id) }, 'ثبت بهای خرید'))] : null,
        h('dt', 'حداقل موجودی'), h('dd', UI.qty(p.minStock)),
        h('dt', 'محل نگهداری'), h('dd', p.location || '—'),
        h('dt', 'بارکدها'), h('dd.ltr', (p.barcodes || []).join('، ') || '—'),
        p.supplierId && E.state.suppliers[p.supplierId] ? [h('dt', 'تأمین‌کننده'), h('dd', E.state.suppliers[p.supplierId].name)] : null,
        p.family ? [h('dt', 'خانواده'), h('dd', p.family)] : null,
        p.warrantyMonths ? [h('dt', 'گارانتی'), h('dd', UI.fa(p.warrantyMonths) + ' ماه')] : null,
        E.categoryAttrDefs(p.categoryId || '').filter(function (d) { return p.attrs && p.attrs[d.key] != null && p.attrs[d.key] !== ''; }).map(function (d) { return [h('dt', d.label), h('dd', UI.fa(p.attrs[d.key]))]; }),
        h('dt', 'شناسه ثابت'), h('dd.ltr', p.id + ' / ' + (p.publicCode || '—'))),
      p.notes ? h('p.small.muted', p.notes) : null));
    (function () { // v2.9: every purchase list that prices this item; a wrong one (e.g. another brand's row) can be removed
      var L = E.priceLists().filter(function (pl) { return pl.items[p.id] != null; }).reverse();
      if (!L.length) return;
      view.appendChild(h('details.card', h('summary', 'قیمت این کالا در لیست‌های خرید (' + UI.fa(L.length) + ')'),
        h('div.list', L.map(function (pl) {
          return h('div.li', h('div.grow', h('div.t', UI.moneyT(pl.items[p.id])), h('div.s', (pl.name || 'لیست قیمت') + ' · ' + UI.dateFa(pl.date))),
            h('button.btn.sm.ghost', { onclick: function () {
              UI.confirmBox('قیمت ' + UI.moneyT(pl.items[p.id]) + ' این کالا از لیست «' + (pl.name || '') + '» حذف شود؟ (بقیه لیست دست نمی‌خورد؛ قیمت فروش خودکار عوض نمی‌شود.)', 'حذف', true).then(function (ok) {
                if (ok) A.manager('حذف قیمت از لیست قیمت').then(function (ctx) { if (ctx) A.run(function () { return E.removePriceListItems(pl.id, [p.id], ctx); }).then(function () { UI.toast('حذف شد.', 'ok'); route(); }, function () {}); });
              });
            } }, 'حذف از این لیست'));
        }))));
    })();
    view.appendChild(h('div.grid2',
      h('button.btn.primary', { onclick: function () { A.addToDraft('in', p, 1); A.go('#/in'); } }, UI.icon('in'), 'ورود'),
      h('button.btn.primary', { disabled: p.stock <= 0, onclick: function () { A.addToDraft('out', p, 1); A.go('#/out'); } }, UI.icon('out'), 'خروج / فروش'),
      h('button.btn', { onclick: function () { adjustSheet(p); } }, 'اصلاح موجودی'),
      h('a.btn', { href: '#/labels?p=' + p.id }, UI.icon('qr'), 'چاپ برچسب'),
      h('button.btn', { onclick: function () { addBarcode(p); } }, 'افزودن بارکد'),
      h('a.btn', { href: '#/report/ledger?p=' + p.id }, 'کاردکس کامل')));
    if (p.stock === 0 && !E.productInUse(p.id)) // v2.2.2: a product created by mistake and never used can be deleted
      view.appendChild(h('button.btn.ghost.block', { style: { color: 'var(--bad)', marginTop: '8px' }, onclick: function () {
        UI.confirmBox('«' + p.name + '» هیچ سندی ندارد. کاملاً حذف شود؟', 'حذف کالا', true).then(function (ok) {
          if (ok) A.manager('حذف کالا').then(function (ctx) { if (ctx) A.run(function () { return E.deleteProduct(p.id, ctx); }).then(function () { UI.toast('کالا حذف شد.', 'ok'); A.go('#/products'); }, function () {}); });
        });
      } }, 'حذف این کالا (بدون سابقه)'));
    var hist = E.list('audit').filter(function (a) { return a.entity === 'product' && a.entityId === p.id; }).sort(function (a, b) { return b.ts - a.ts; });
    if (hist.length) view.appendChild(h('details.card', h('summary', { style: { fontWeight: 700, cursor: 'pointer' } }, 'سابقه تغییرات مشخصات (' + UI.fa(hist.length) + ')'), hist.slice(0, 50).map(A.auditRow)));
    var run = 0, led = E.productLedger(p.id).map(function (m) { run += m.qty; return Object.assign({}, m, { balanceAfter: run }); }).slice(-30).reverse();
    view.appendChild(h('div.sec-title', 'گردش اخیر کالا'));
    if (!led.length) view.appendChild(h('div.card.empty', 'گردشی ثبت نشده است.'));
    else view.appendChild(h('div.list', led.map(function (m) {
      var d = E.state.docs[m.docId];
      return h('a.li', { href: '#/doc/' + m.docId }, h('div.grow', h('div.t', (window.Reports.KIND[m.kind] || m.kind) + ' — ' + window.Reports.docTypeLabel(d)), h('div.s', m.docNo + ' · ' + UI.dateFa(m.ts, true))),
        h('div.e', h('b', { style: { color: m.qty > 0 ? 'var(--ok)' : 'var(--bad)' } }, (m.qty > 0 ? '+' : '−') + UI.qty(Math.abs(m.qty))), h('div.s', 'مانده ' + UI.qty(m.balanceAfter))));
    })));
  };
  function addBarcode(p) {
    var go = function (code) {
      if (!code) return;
      A.run(function () { return E.mapBarcode(p.id, code.trim(), A.userCtx()); }).then(function () { UI.toast('بارکد ثبت شد.', 'ok'); route(); }, function () {});
    };
    var s = UI.sheet('افزودن بارکد کارخانه', h('div.stack', h('p.small.muted', 'بارکد روی بسته‌بندی کالا (EAN یا Code128) را به این کالا وصل کنید تا با اسکن آن، همین کالا پیدا شود.'),
      h('button.btn.primary.block', { onclick: function () { s.close(); A.openScanner({ mode: 'code', title: 'اسکن بارکد کالا', onCode: go }); } }, 'اسکن با دوربین'),
      h('button.btn.block', { onclick: function () { s.close(); UI.promptBox('ورود دستی بارکد', 'بارکد', { ltr: true, inputmode: 'numeric' }).then(go); } }, 'ورود دستی')));
  }
  function adjustSheet(p) {
    var cnt = h('input.in', { inputmode: 'numeric', placeholder: 'موجودی شمارش‌شده' });
    var reason = sel({ count: 'شمارش انبار', damage: 'خرابی / آسیب', lost: 'مفقودی', found: 'پیدا شدن کالا', error: 'اصلاح اشتباه ثبت', other: 'سایر' }, 'count');
    var desc = h('input.in', { placeholder: 'توضیح (اختیاری)' }), cost = moneyInput(null, 'بهای واحد (اختیاری، فقط برای افزایش)');
    var info = h('div.hint');
    cnt.addEventListener('input', function () { var n = UI.parseInt2(cnt.value); info.textContent = n == null || isNaN(n) ? '' : 'تغییر: ' + (n - p.stock >= 0 ? '+' : '−') + UI.qty(Math.abs(n - p.stock)); });
    var key = UI.opKey('adj');
    var s = UI.sheet('اصلاح موجودی: ' + p.name, h('div', h('p.small.muted', 'موجودی فعلی: ' + UI.qty(p.stock) + '. اصلاح موجودی با سند تعدیل و علت ثبت می‌شود و نیاز به تأیید مدیر دارد.'),
      field('موجودی واقعی', cnt, info, true), field('علت', reason), field('توضیح', desc), field('بهای واحد', cost.input, cost.hint),
      h('button.btn.primary.block', { onclick: function () {
        var n = UI.parseInt2(cnt.value);
        if (n == null || isNaN(n) || n < 0) { UI.toast('موجودی واقعی را درست وارد کنید.', 'bad'); return; }
        var c = cost.value(); if (c != null && (isNaN(c) || c < 0 || !Number.isInteger(c))) { UI.toast('بهای واحد نامعتبر است.', 'bad'); return; }
        A.manager('اصلاح موجودی').then(function (ctx) {
          if (!ctx) return;
          var r = reason.options[reason.selectedIndex].text + (desc.value.trim() ? ' — ' + desc.value.trim() : '');
          A.run(function () { return E.adjustStock(p.id, { opKey: key, newStock: n, reason: r, unitCost: c }, ctx); }).then(function () { s.close(); UI.toast('موجودی اصلاح شد.', 'ok'); route(); }, function () {});
        });
      } }, 'ثبت اصلاح')));
  }

  A.routes['product-edit'] = function (id) {
    var p = id && id !== 'new' ? E.state.products[id] : null, isNew = !p, pre = isNew ? (A.state.prefill || {}) : {};
    if (isNew) A.state.prefill = null;
    setTitle(isNew ? 'کالای جدید' : 'ویرایش کالا', true);
    var last = isNew ? A.lsGet('ay.lastProd') || {} : {};
    p = p || { unit: 'عدد', packSize: 1, minStock: 0, active: true, barcodes: pre.barcode ? [pre.barcode] : [], categoryId: last.categoryId && E.state.categories[last.categoryId] ? last.categoryId : null, attrs: {} };
    var brands = {}, units = { 'عدد': 1, 'ست': 1, 'جفت': 1, 'بسته': 1, 'کارتن': 1, 'لیتر': 1, 'متر': 1, 'کیلوگرم': 1 }, fams = {};
    E.list('products').forEach(function (x) { if (x.brand) brands[x.brand] = 1; if (x.unit) units[x.unit] = 1; if (x.family) fams[x.family] = 1; });
    function dl(idn, o) { return h('datalist#' + idn, Object.keys(o).map(function (v) { return h('option', { value: v }); })); }
    var st = { categoryId: p.categoryId || null, supplierId: p.supplierId || null, attrs: Object.assign({}, p.attrs || {}) };
    var f = {
      name: h('input.in', { value: p.name || '', autocomplete: 'off' }), sku: h('input.in.ltr-in', { value: p.sku || '', autocomplete: 'off', autocapitalize: 'characters' }),
      shortName: h('input.in', { value: p.shortName || '', placeholder: 'برای برچسب (اختیاری)' }),
      brand: h('input.in', { value: p.brand || '', list: 'dl-brand' }), model: h('input.in', { value: p.model || '', placeholder: 'مثلاً کد فنی / مدل' }),
      family: h('input.in', { value: p.family || '', list: 'dl-fam', placeholder: 'برای گروه‌بندی تنوع‌ها (اختیاری)' }),
      unit: h('input.in', { value: p.unit || 'عدد', list: 'dl-unit' }), packSize: h('input.in', { inputmode: 'numeric', value: UI.fa(p.packSize || 1) }),
      boxQty: h('input.in', { inputmode: 'numeric', value: p.boxQty > 1 ? UI.fa(p.boxQty) : '', placeholder: '—' }), cartonQty: h('input.in', { inputmode: 'numeric', value: p.cartonQty > 1 ? UI.fa(p.cartonQty) : '', placeholder: '—' }),
      minStock: h('input.in', { inputmode: 'numeric', value: UI.fa(p.minStock || 0) }), location: h('input.in', { value: p.location || '', placeholder: 'مثلاً قفسه ۳ ردیف ۲' }),
      warranty: h('input.in', { inputmode: 'numeric', value: p.warrantyMonths != null ? UI.fa(p.warrantyMonths) : '', placeholder: 'ماه (اختیاری)' }),
      notes: h('textarea.in', { value: p.notes || '' }), barcodes: h('input.in.ltr-in', { value: (p.barcodes || []).join(' '), placeholder: 'با فاصله جدا کنید' }),
      cars: h('input.in', { value: (p.cars || []).join('، '), placeholder: 'مثلاً پژو ۴۰۵، پژو پارس (با ، جدا کنید)' }),
      active: h('input', { type: 'checkbox', checked: p.active !== false }), reason: h('input.in', { placeholder: 'مثلاً افزایش قیمت تأمین‌کننده (اختیاری، در سابقه ثبت می‌شود)' })
    };
    var buy = moneyInput(p.buyPrice, 'تومان'), sell = moneyInput(p.sellPrice, 'تومان');
    var initQty = h('input.in', { inputmode: 'numeric', placeholder: '۰' }), initCost = moneyInput(null, 'بهای خرید هر واحد (اختیاری)');
    var autoSku = h('button.btn.sm', { type: 'button', onclick: function () {
      var n = Object.keys(E.state.products).length + 1, s;
      do { s = 'AY-' + ('0000' + n).slice(-4); n++; } while (E.findProductBySku(s));
      f.sku.value = s;
    } }, 'کد خودکار');
    var catBtn = h('button.btn.block', { type: 'button', onclick: function () { A.pickCategory(st.categoryId, function (c) { st.categoryId = c ? c.id : null; st.newPath = null; st.userPicked = true; drawCat(); drawAttrs(); suggest(); }); } });
    function drawCat() { catBtn.textContent = st.newPath ? st.newPath.join(' › ') + ' (گروه جدید)' : st.categoryId ? A.categoryLabel(st.categoryId) : 'انتخاب گروه کالا'; }
    // v2.3: the app proposes the group («یدکی › جلوبندی › سیبک فرمان») and the cars from the name; one tap applies it
    var sugBox = h('div'), sugT = null;
    function suggest() {
      UI.clear(sugBox);
      var nm = f.name.value.trim(); if (!nm) return;
      var g = A.classifier().guess(nm, { brand: f.brand.value }); st.g = g;
      var same = st.newPath ? st.newPath.join('›') === g.path.join('›') : (g.categoryId && st.categoryId === g.categoryId);
      if (!same) sugBox.appendChild(h('button.btn.sm', { type: 'button', style: { margin: '4px 0' }, onclick: function () {
        if (g.categoryId) { st.categoryId = g.categoryId; st.newPath = null; } else { st.newPath = g.path.slice(); st.categoryId = null; }
        st.userPicked = true; drawCat(); drawAttrs(); suggest();
      } }, (g.conf === 'guess' ? 'حدس گروه: ' : 'پیشنهاد گروه: ') + g.path.join(' › ')));
      if (!f.cars.value.trim() && g.cars.length) sugBox.appendChild(h('button.btn.sm', { type: 'button', style: { margin: '4px' }, onclick: function () { f.cars.value = g.cars.join('، '); suggest(); } }, 'خودرو از نام: ' + g.cars.join('، ')));
    }
    f.name.addEventListener('input', function () { clearTimeout(sugT); sugT = setTimeout(suggest, 350); });
    var supBtn = h('button.btn.block', { type: 'button', onclick: function () { A.pickSupplier(function (x) { st.supplierId = x.id; drawSup(); }); } });
    function drawSup() { supBtn.textContent = st.supplierId && E.state.suppliers[st.supplierId] ? E.state.suppliers[st.supplierId].name : 'انتخاب تأمین‌کننده (اختیاری)'; }
    var attrBox = h('div');
    function drawAttrs() {
      UI.clear(attrBox);
      var defs = st.categoryId ? E.categoryAttrDefs(st.categoryId) : [];
      if (!defs.length) return;
      attrBox.appendChild(h('b', 'مشخصات اختصاصی گروه'));
      defs.forEach(function (d) {
        var v = st.attrs[d.key] == null ? '' : st.attrs[d.key], inp;
        if (d.type === 'select') { var o = { '': '—' }; d.options.forEach(function (x) { o[x] = x; }); inp = sel(o, String(v), { onchange: function () { st.attrs[d.key] = inp.value; } }); }
        else inp = h('input.in', { value: d.type === 'number' && v !== '' ? UI.fa(v) : v, inputmode: d.type === 'number' ? 'decimal' : null, oninput: function () { st.attrs[d.key] = d.type === 'number' ? (UI.parseNum(inp.value) == null ? '' : UI.parseNum(inp.value)) : inp.value; } });
        attrBox.appendChild(field(d.label, inp));
      });
    }
    drawCat(); drawSup(); drawAttrs(); suggest();
    /* v2.5: units received WITHOUT a purchase cost get their cost right here. Before, the price typed above only changed
       «last purchase price», so the old receipt, the sale profit and the «no purchase cost» alert stayed unknown.
       Each uncosted receipt gets its own field (the price of THAT purchase, e.g. months ago); it is pre-filled from the
       nearest purchase price list, otherwise it follows the price typed above until the user edits it. */
    var cost = isNew ? null : (function () {
      var C = E.costCandidates({ productId: p.id }); if (!C.length) return null;
      var rows = C.map(function (c) {
        var sug = c.suggestion ? c.suggestion.price : null, mi = moneyInput(sug != null ? sug : p.buyPrice, 'بهای خرید هر واحد در آن ورود');
        var r = { c: c, mi: mi, touched: false, auto: sug == null };
        mi.input.addEventListener('input', function () { r.touched = true; });
        return r;
      });
      buy.input.addEventListener('input', function () { // the price typed above fills the receipts the user has not edited
        var v = buy.value(); rows.forEach(function (r) { if (!r.touched && r.auto) { r.mi.input.value = v == null || isNaN(v) ? '' : UI.fa(UI.group(v)); r.mi.input.dispatchEvent(new Event('blur')); } });
      });
      var unk = C.reduce(function (s2, c) { return s2 + c.inStock; }, 0);
      var el = h('div', { style: { border: '1px solid var(--warn)', background: 'var(--warn-bg)', borderRadius: '12px', padding: '8px 12px', margin: '2px 0 12px' } }, h('b', 'بهای خرید ورودهای بی‌قیمت'),
        h('p.small.muted', 'این کالا ' + UI.fa(C.length) + ' ورود بدون بهای خرید دارد' + (unk ? ' (' + UI.qty(unk) + ' عدد هنوز در انبار)' : '') + '. بهای خرید همان ورود را بنویسید تا سند ورود، سود فروش‌ها و هشدار «بدون بهای خرید» درست شود. ردیف خالی تغییری نمی‌کند.'),
        rows.map(function (r) {
          var c = r.c;
          return h('div', { style: { marginTop: '8px' } }, h('div.small', h('b.ltr', c.srcNo || 'موجودی قدیمی بدون سند'), ' · ', [c.ts ? UI.dateFa(c.ts) : '', c.supplier, UI.qty(c.qty) + ' عدد' + (c.inStock !== c.qty ? ' (' + UI.qty(c.inStock) + ' در انبار)' : '')].filter(Boolean).join(' · ')),
            h('div', { style: { marginTop: '4px' } }, r.mi.input, r.mi.hint),
            c.suggestion ? h('div.hint', 'از لیست قیمت خرید' + (c.suggestion.name ? ' «' + c.suggestion.name + '»' : '') + ' (' + UI.dateFa(c.suggestion.date) + ')') : null);
        }));
      return {
        el: el,
        items: function () { // null = an invalid number
          var out = [], bad = false;
          rows.forEach(function (r) {
            var n = r.mi.value(); if (n == null) return;
            if (isNaN(n) || n <= 0 || !Number.isInteger(n)) { bad = true; return; }
            out.push({ srcDocId: r.c.srcDocId, productId: p.id, unitCost: n, listId: r.c.suggestion && r.c.suggestion.price === n ? r.c.suggestion.listId : null });
          });
          return bad ? null : out;
        }
      };
    })();
    var more = h('details', { open: !isNew || null }, h('summary', { style: { fontWeight: 700, padding: '6px 0', cursor: 'pointer' } }, 'مشخصات بیشتر'),
      h('div.grid2', field('مدل / کد فنی', f.model), field('خانواده (تنوع‌ها)', f.family)), field('تأمین‌کننده اصلی', supBtn),
      h('div.grid2', field('واحد', f.unit), field('تعداد در هر واحد', f.packSize)),
      h('div.grid2', field('تعداد داخل هر جعبه', f.boxQty, h('div.hint', 'فقط مشخصه؛ موجودی و قیمت برای کل جعبه است')), field('تعداد در کارتن مادر', f.cartonQty)),
      h('div.grid2', field('حداقل موجودی (هشدار)', f.minStock), field('محل نگهداری', f.location)),
      h('div.grid2', field('گارانتی (ماه)', f.warranty), field('نام کوتاه برچسب', f.shortName)), attrBox, field('توضیحات', f.notes));
    var form = h('div', dl('dl-brand', brands), dl('dl-unit', units), dl('dl-fam', fams),
      h('div.card', field('نام کالا', f.name, null, true), h('label.f', h('span', 'کد داخلی (SKU)', h('i', ' *')), h('div.row', f.sku, autoSku)),
        field('برند', f.brand), field('گروه کالا', catBtn), sugBox, field('خودرو', f.cars, h('div.hint', 'جدا از گروه؛ یک قطعه می‌تواند چند خودرو داشته باشد')),
        h('div.grid2', field(!isNew && p.stock > 0 ? 'آخرین قیمت خرید (فقط اطلاع)' : 'قیمت خرید', buy.input, h('div', buy.hint, !isNew && p.stock > 0 ? h('div.hint', 'بهای واقعی موجودی از سند ورود می‌آید' + (cost ? ' (پایین همین صفحه)' : '') + '؛ این عدد در سود و گزارش‌ها نیست.') : null)), field('قیمت فروش', sell.input, sell.hint)), cost ? cost.el : null, // v2.9
        h('label.f', h('span', 'بارکدهای کارخانه'), h('div.row', f.barcodes, h('button.btn.sm', { type: 'button', onclick: function () {
          A.openScanner({ mode: 'code', title: 'اسکن بارکد کالا', onCode: function (c) { f.barcodes.value = (f.barcodes.value + ' ' + c).trim(); } });
        } }, 'اسکن'))), more, isNew ? null : h('label.check', f.active, 'کالا فعال است'), isNew ? null : field('علت تغییر', f.reason)),
      isNew ? h('div.card', h('h2', 'موجودی اولیه (اختیاری)'), h('div.grid2', field('تعداد', initQty), field('بهای خرید هر واحد', initCost.input, initCost.hint)),
        h('p.small.muted', 'اگر بهای خرید را وارد نکنید، سود فروش این تعداد «نامشخص» محاسبه می‌شود.')) : null);
    var key = UI.opKey('newprod');
    var save = h('button.btn.primary.block', { onclick: function () { submit(false); } }, 'ذخیره کالا');
    function num(i) { var n = UI.parseInt2(i.value); return n; }
    function submit(allowDup) {
      var data = { name: f.name.value, sku: f.sku.value, shortName: f.shortName.value, brand: f.brand.value, model: f.model.value, family: f.family.value,
        categoryId: st.categoryId, supplierId: st.supplierId, attrs: st.attrs, unit: f.unit.value || 'عدد', warrantyMonths: num(f.warranty),
        packSize: num(f.packSize), minStock: num(f.minStock), location: f.location.value, notes: f.notes.value, buyPrice: buy.value(), sellPrice: sell.value(),
        boxQty: num(f.boxQty), cartonQty: num(f.cartonQty), cars: A.parseCars(f.cars.value) };
      if ([data.boxQty, data.cartonQty].some(function (x) { return x != null && (isNaN(x) || x < 1 || x > 9999); })) { UI.toast('تعداد در جعبه / کارتن نامعتبر است.', 'bad'); return; }
      // v2.2: factory barcodes follow the box quantity (a code that had the old box quantity, or none, gets the new one)
      data.barcodeQty = {}; // v2.4.1: one scan = one unit; an old per-barcode quantity (v2.2) is cleared on save
      if (data.packSize == null) data.packSize = 1; if (data.minStock == null) data.minStock = 0;
      if ([data.packSize, data.minStock, data.buyPrice, data.sellPrice, data.warrantyMonths].some(function (x) { return x != null && (isNaN(x) || !Number.isInteger(x)); })) { UI.toast('اعداد را درست وارد کنید (فقط عدد صحیح).', 'bad'); return; }
      var codes = f.barcodes.value.split(/[\s,،]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      var iq = isNew ? num(initQty) : null, ic = isNew ? initCost.value() : null;
      if (iq != null && (isNaN(iq) || iq < 0)) { UI.toast('موجودی اولیه نامعتبر است.', 'bad'); return; }
      if (ic != null && (isNaN(ic) || ic < 0 || !Number.isInteger(ic))) { UI.toast('بهای خرید نامعتبر است.', 'bad'); return; }
      var comp = cost ? cost.items() : [];
      if (comp == null) { UI.toast('بهای ورودهای بی‌قیمت را عدد صحیح مثبت بنویسید (یا خالی بگذارید).', 'bad'); return; }
      var gate = !comp.length ? Promise.resolve(null) : UI.confirmBox('بهای خرید ' + UI.fa(comp.length) + ' ورود قبلی هم ثبت می‌شود: ' + comp.map(function (it) {
        var c = E.state.docs[it.srcDocId]; return (c ? c.no : 'موجودی قدیمی') + ' = ' + UI.moneyT(it.unitCost);
      }).join('، ') + '. سند ورود، سود فروش‌ها و هشدارها از همین بها استفاده می‌کنند.', 'ثبت').then(function (ok) {
        if (!ok) return false; var au = E.getMeta('auth');
        return au && au.hash ? A.manager('تکمیل بهای خرید') : { manager: true, user: 'مدیر' };
      });
      gate.then(function (mctx) { if (comp.length && !mctx) return; go(mctx); });
      function go(mctx) {
      save.disabled = true;
      var job, newPath = st.newPath, off = newPath ? 1 : 0, first = newPath ? [function () { return E.ensureCategoryPath(newPath, A.userCtx()); }] : [];
      var withCat = function (dn) { if (newPath) data.categoryId = dn[0].category.id; return data; };
      var learnStep = function (dn) { // v2.3: a group the user chose or confirmed teaches the app this part type
        var g = st.g, cid = newPath ? dn[0].category.id : st.categoryId;
        return st.userPicked && g && g.key && cid ? E.learn([{ key: g.key, categoryId: cid }], A.userCtx()) : { changes: [] };
      };
      if (isNew) {
        data.barcodes = codes; data.allowDuplicate = allowDup; data.active = true;
        job = DB.batch(first.concat([function (dn) { return E.createProduct(withCat(dn), A.userCtx()); }, function (done) {
          if (!iq) return { changes: [] };
          return E.postReceipt({ opKey: key, type: 'initial', items: [{ productId: done[off].product.id, qty: iq, unitCost: ic }], note: 'موجودی اولیه هنگام تعریف کالا' }, A.userCtx());
        }, learnStep]));
      } else {
        data.active = f.active.checked; data.reason = f.reason.value;
        var removed = (p.barcodes || []).filter(function (c) { return codes.indexOf(c) < 0; }), added = codes.filter(function (c) { return (p.barcodes || []).indexOf(c) < 0; });
        job = DB.batch(first.concat([function (dn) { return E.updateProduct(p.id, withCat(dn), A.userCtx()); }])
          .concat(removed.map(function (c) { return function () { return E.unmapBarcode(p.id, c, A.userCtx()); }; }))
          .concat(added.map(function (c) { return function () { return E.mapBarcode(p.id, c, A.userCtx()); }; }))
          .concat([learnStep])
          .concat(comp.length ? [function () { return E.completeCosts({ opKey: key + ':c', reason: 'بهای خرید ثبت‌شده در ویرایش کالا', items: comp }, mctx); }] : []));
      }
      DB.run(job).then(function (res) {
        var prod = res[off].product; UI.toast(comp.length ? 'کالا و بهای خرید ' + UI.fa(comp.length) + ' ورود ذخیره شد.' : 'کالا ذخیره شد.', 'ok');
        if (isNew) A.lsSet('ay.lastProd', { categoryId: prod.categoryId });
        if (isNew && pre.addTo) { A.addToDraft(pre.addTo, prod, 1); A.go('#/' + pre.addTo); return; }
        A.go('#/product/' + prod.id);
      }, function (e) {
        save.disabled = false;
        if (e.code === 'DUP_NAME') UI.confirmBox(e.message, 'ثبت به‌عنوان کالای جداگانه').then(function (ok) { if (ok) submit(true); });
        else A.showErr(e);
      });
      }
    }
    view.appendChild(form); view.appendChild(h('div.sticky-act', save));
    if (isNew) setTimeout(function () { f.name.focus(); }, 100);
  };

  // ======================= RECEIPT / ISSUE FORMS =======================
  A.routes['in'] = function () { docForm('in'); };
  A.routes.out = function () { docForm('out'); };
  function docForm(kind) {
    var d = A.draft(kind), isIn = kind === 'in';
    setTitle(isIn ? 'ورود کالا' : 'فروش / خروج کالا', true, h('button.tb-btn', { onclick: function () {
      if (!d.items.length) return; UI.confirmBox('همه اقلام این فرم پاک شود؟', 'پاک کردن', true).then(function (ok) { if (ok) { A.newDraft(kind); route(); } });
    } }, 'پاک کردن'));
    var S = E.state;
    d.items = d.items.filter(function (it) { return S.products[it.productId]; });
    function save() { A.saveDraft(d); }
    var head = h('div.card');
    var typeOpts = {}; (isIn ? Core.UI_RECEIPT_TYPES : Core.UI_ISSUE_TYPES).forEach(function (k) { typeOpts[k] = (isIn ? Core.RECEIPT_TYPES : Core.ISSUE_TYPES)[k]; });
    var replaced = !isIn && d.replaces ? S.docs[d.replaces] : null;
    if (!isIn && d.replaces && (!replaced || replaced.status === 'reversed')) { d.replaces = null; replaced = null; save(); }
    if (replaced) d.type = 'sale';
    var typeSel = sel(typeOpts, d.type, { onchange: function () { d.type = typeSel.value; save(); renderHead(); renderLines(); renderFoot(); } });
    if (replaced) typeSel.disabled = true;
    // stock available to this form = stock + what the invoice being corrected already holds
    function avail(pid) { var a = S.products[pid].stock; if (replaced) replaced.lines.forEach(function (l) { if (l.productId === pid) a += l.qty; }); return a; }
    var dateIn = h('input.in', { value: d.date || UI.todayStr(), inputmode: 'numeric', placeholder: '۱۴۰۵/۰۷/۱۹', onchange: function () { d.date = dateIn.value; save(); if (isIn) { renderLines(); renderFoot(); } } });
    var note = h('input.in', { value: d.note || '', placeholder: 'اختیاری', oninput: function () { d.note = note.value; save(); } });
    function renderHead() {
      UI.clear(head);
      head.appendChild(field(isIn ? 'نوع ورود' : 'نوع خروج', typeSel));
      var fromQ = !isIn && d.quoteId && S.quotes[d.quoteId]; // v2.8
      if (fromQ) head.appendChild(h('div.alert.ok', h('div.grow', 'از پیش‌فاکتور ' + fromQ.no + ': با ثبت این فاکتور، پیش‌فاکتور «تبدیل‌شده» علامت می‌خورد.'), h('button.btn.sm', { onclick: function () { d.quoteId = null; save(); renderHead(); } }, 'جدا کن')));
      if (replaced) head.appendChild(h('div.alert.warn', h('div.grow', 'اصلاح فاکتور ' + replaced.invoiceNo + ': با ثبت این پیش‌نویس، فاکتور قبلی لغو و این فاکتور جایگزین می‌شود و پرداخت‌های قبلی (' + UI.moneyT(replaced.paid - replaced.refunded) + ') به آن منتقل می‌شود. تأیید مدیر لازم است.'),
        h('button.btn.sm', { onclick: function () { d.replaces = null; A.newDraft('out'); route(); } }, 'انصراف')));
      if (isIn) {
        head.appendChild(h('a.alert.ok', { href: '#/purchase', style: { textDecoration: 'none' } }, h('div.grow', h('b', 'فاکتور خرید کامل ←'), ' با تخفیف، هزینه حمل و مالیات، کنترل جمع و جلوگیری از ثبت تکراری')));
        var sp = d.supplierId && S.suppliers[d.supplierId];
        var sdn = h('input.in', { value: d.supplierDocNo || '', oninput: function () { d.supplierDocNo = sdn.value; save(); } });
        head.appendChild(h('label.f', h('span', 'تأمین‌کننده'), sp ? h('div.row', h('div.grow.card', { style: { margin: 0, padding: '8px 12px' } }, h('b', sp.name), sp.phone ? h('div.small.muted.ltr', sp.phone) : null),
          h('button.btn.sm', { onclick: function () { A.pickSupplier(function (x) { d.supplierId = x.id; save(); renderHead(); renderLines(); renderFoot(); }); } }, 'تغییر'), h('button.btn.sm.ghost', { onclick: function () { d.supplierId = null; save(); renderHead(); renderLines(); renderFoot(); } }, '✕'))
          : h('button.btn.block', { onclick: function () { A.pickSupplier(function (x) { d.supplierId = x.id; save(); renderHead(); renderLines(); renderFoot(); }); } }, '+ انتخاب تأمین‌کننده (اختیاری)')));
        head.appendChild(field('شماره فاکتور خرید', sdn));
      } else if (d.type === 'sale') {
        var c = d.customerId && S.customers[d.customerId];
        head.appendChild(h('label.f', h('span', 'مشتری', h('i', ' *')), c ?
          h('div.row', h('div.grow.card', { style: { margin: 0, padding: '8px 12px' } }, h('b', c.name), h('div.small.muted.ltr', c.phone || ''), (function () { var b = E.customerBalance(c.id); return b > 0 ? h('div.small', { style: { color: 'var(--bad)' } }, 'بدهی قبلی: ' + UI.moneyT(b)) : null; })()),
            h('button.btn.sm', { onclick: function () { A.pickCustomer(function (cc) { d.customerId = cc.id; save(); renderHead(); }); } }, 'تغییر')) :
          h('button.btn.block', { onclick: function () { A.pickCustomer(function (cc) { d.customerId = cc.id; save(); renderHead(); }); } }, '+ انتخاب یا ثبت مشتری')));
      } else {
        var rec = h('input.in', { value: d.recipient || '', placeholder: 'نام تحویل‌گیرنده / مقصد', oninput: function () { d.recipient = rec.value; save(); } });
        head.appendChild(field('تحویل‌گیرنده', rec));
      }
      head.appendChild(h('div.grid2', field('تاریخ', dateIn), field('توضیحات', note)));
    }
    var linesBox = h('div'), foot = h('div');
    function inCart(pid) { return d.items.filter(function (x) { return x.productId === pid; }).reduce(function (s, x) { return s + x.qty; }, 0); }
    function addProduct(p, q) {
      var it = d.items.filter(function (x) { return x.productId === p.id; })[0];
      if (it) it.qty += q || 1; else d.items.push({ productId: p.id, qty: q || 1, unitCost: null, unitPrice: isIn ? null : p.sellPrice, discount: null });
      save(); renderLines(); renderFoot();
    }
    /* v2.2.1: a line without a typed purchase cost takes the price of the nearest purchase price list (same supplier first,
       then the latest list on/before the receipt date, else the earliest after it; no age limit). A typed cost always wins. */
    var scanAdds = 0;
    function openScan() {
      scanAdds = 0;
      A.openScanner({ mode: 'pick', title: isIn ? 'اسکن برای ورود' : 'اسکن برای فروش / خروج', addTo: kind, checkStock: !isIn, quickDefine: isIn, inCart: inCart, avail: avail,
        onPick: function (p, n) { scanAdds++; addProduct(p, n); },
        onAdjust: function (p, delta) { var it = d.items.filter(function (x) { return x.productId === p.id; })[0]; if (it) { it.qty = Math.max(1, it.qty + delta); save(); renderLines(); renderFoot(); } },
        onRemove: function (p) { d.items = d.items.filter(function (x) { return x.productId !== p.id; }); save(); renderLines(); renderFoot(); },
        summary: function () { return { lines: d.items.length, qty: d.items.reduce(function (s, x) { return s + x.qty; }, 0) }; },
        onClose: function () { // v2.4: closing the camera after receiving -> post the receipt now (asked), so the stock is not left at zero
          if (!isIn || !d.items.length) return;
          var adopted = A.state.adoptedIn; A.state.adoptedIn = false;
          if (!scanAdds && !adopted) return;
          setTimeout(function () {
            if (!/^#\/in(\?|$)/.test(location.hash)) return; // navigated elsewhere: nothing is asked
            var q = d.items.reduce(function (s2, x) { return s2 + x.qty; }, 0), nc = d.items.filter(function (x) { return x.unitCost == null; }).length;
            UI.confirmBox('ثبت رسید ورود: ' + UI.fa(d.items.length) + ' قلم، ' + UI.fa(q) + ' عدد. با ثبت، موجودی اضافه می‌شود.' + (nc ? ' ' + UI.fa(nc) + ' ردیف بهای خرید ندارد؛ بعداً از لیست قیمت یا «تکمیل بهای خرید» کامل می‌شود.' : ''), 'ثبت رسید')
              .then(function (ok) { if (ok) submit(true); });
          }, 0);
        } });
    }
    function applyListCosts() {
      if (!isIn) return;
      var t = UI.parseDateInput(d.date || ''); if (t == null || isNaN(t)) t = Date.now();
      var changed = false;
      d.items.forEach(function (it) {
        if (it.costManual) return;
        var hit = E.listCostFor(it.productId, t, d.supplierId || null);
        var nc = hit ? hit.price : null, nf = hit ? { listId: hit.listId, date: hit.date, name: hit.name, price: hit.price } : null;
        if (it.costFrom || nc != null) { if (it.unitCost !== nc || JSON.stringify(it.costFrom || null) !== JSON.stringify(nf)) { it.unitCost = nc; it.costFrom = nf; changed = true; } }
      });
      if (changed) save();
    }
    function renderLines() {
      UI.clear(linesBox);
      applyListCosts();
      linesBox.appendChild(h('div.row.between', { style: { margin: '14px 4px 8px' } }, h('b', 'اقلام (' + UI.fa(d.items.length) + ')'),
        h('div.row', h('button.btn.sm.accent', { onclick: openScan }, UI.icon('scan'), 'اسکن'),
          h('button.btn.sm', { onclick: function () { A.pickProduct('افزودن کالا', function (p) { addProduct(p, 1); }); } }, 'جستجو'))));
      if (!d.items.length) { linesBox.appendChild(h('div.card.empty', 'کالایی اضافه نشده. با «اسکن» یا «جستجو» کالا اضافه کنید.')); return; }
      var card = h('div.card', { style: { padding: '4px 14px' } });
      d.items.forEach(function (it, idx) {
        var p = S.products[it.productId], over = !isIn && inCart(p.id) > avail(p.id);
        var warn = [];
        if (!isIn && d.type === 'sale' && it.unitPrice != null) {
          var ac = E.avgCost(p);
          if (ac != null && it.unitPrice > 0 && it.unitPrice * it.qty - (it.discount || 0) < ac * it.qty) warn.push('قیمت خالص کمتر از بهای خرید (' + UI.money(ac) + ') است.');
          if (p.sellPrice && it.unitPrice > 0 && (it.unitPrice > p.sellPrice * 1.5 || it.unitPrice < p.sellPrice * 0.6)) warn.push('با قیمت تعریف‌شده (' + UI.money(p.sellPrice) + ') فاصله زیادی دارد؛ تعداد صفرها را بررسی کنید.');
          if (it.unitPrice === 0) warn.push('قیمت صفر است.');
        }
        var row = h('div.line',
          h('div.row', h('div.grow', h('b', p.name), h('div.small.muted', [p.brand, p.sku].filter(Boolean).join(' · ') + ' · موجودی: ' + UI.qty(p.stock))),
            h('button.btn.sm.ghost', { 'aria-label': 'حذف', onclick: function () { d.items.splice(idx, 1); save(); renderLines(); renderFoot(); } }, '✕')),
          h('div.row.between', { style: { marginTop: '6px' } }, A.stepper(it.qty, function (v) { it.qty = v; save(); renderLines(); renderFoot(); }),
            isIn ? null : (d.type === 'sale' ? h('div.small', 'جمع: ', h('b', UI.money(Math.max(0, it.qty * (it.unitPrice || 0) - (it.discount || 0))))) : null)),
          over ? h('div.hint.bad', 'بیشتر از موجودی است (موجودی: ' + UI.qty(avail(p.id)) + ')') : null,
          warn.length ? h('div.hint', { style: { color: 'var(--warn)' } }, '⚠ ' + warn.join(' ')) : null);
        if (isIn) {
          var mc = moneyInput(it.unitCost, p.buyPrice != null ? 'آخرین خرید: ' + UI.money(p.buyPrice) : 'بهای خرید هر واحد (اختیاری)');
          mc.input.addEventListener('input', function () { var n = mc.value(); it.unitCost = n == null || isNaN(n) ? null : n; it.costManual = true; it.costFrom = null; save(); renderFoot(); });
          if (it.costFrom && it.unitCost === it.costFrom.price) mc.hint.textContent = 'از لیست قیمت' + (it.costFrom.name ? ' «' + it.costFrom.name + '»' : '') + ' (' + UI.dateFa(it.costFrom.date) + ')';
          // v2.1.2: optional new SALE price, applied to the product when the receipt is posted
          var ms = moneyInput(it.sellPrice, p.sellPrice != null ? 'فروش فعلی: ' + UI.money(p.sellPrice) : 'قیمت فروش (اختیاری)');
          ms.input.addEventListener('input', function () { var n = ms.value(); it.sellPrice = n == null || isNaN(n) ? null : n; save(); renderFoot(); });
          row.appendChild(h('div.grid2', { style: { marginTop: '6px' } }, h('div', mc.input, mc.hint), h('div', ms.input, ms.hint)));
        } else if (d.type === 'sale') {
          var mp = moneyInput(it.unitPrice, 'قیمت فروش هر واحد'), md = moneyInput(it.discount, 'تخفیف این ردیف');
          mp.input.addEventListener('input', function () { var n = mp.value(); it.unitPrice = n == null || isNaN(n) ? null : n; save(); renderFoot(); });
          mp.input.addEventListener('change', function () { renderLines(); });
          mp.input.addEventListener('blur', function () { renderLines(); });
          md.input.addEventListener('input', function () { var n = md.value(); it.discount = n == null || isNaN(n) ? null : n; save(); renderFoot(); });
          md.input.addEventListener('change', function () { renderLines(); });
          row.appendChild(h('div.grid2', { style: { marginTop: '6px' } }, h('div', mp.input, mp.hint), h('div', md.input, md.hint)));
        }
        card.appendChild(row);
      });
      linesBox.appendChild(card);
    }
    var submitBtn = h('button.btn.primary.block', { onclick: submit }, isIn ? 'ثبت ورود' : 'ثبت');
    function totals() {
      var sub = 0; d.items.forEach(function (it) { sub += it.qty * (it.unitPrice || 0) - (it.discount || 0); });
      var total = sub - (d.discount || 0), paid = (d.payments || []).reduce(function (s, p) { return s + (p.amount || 0); }, 0);
      return { sub: sub, total: total, paid: paid, rest: total - paid };
    }
    function renderFoot() {
      UI.clear(foot);
      var qsum = d.items.reduce(function (s, it) { return s + it.qty; }, 0);
      if (isIn) {
        var known = d.items.filter(function (it) { return it.unitCost != null; }), cost = known.reduce(function (s, it) { return s + it.qty * it.unitCost; }, 0);
        d.pay = d.pay || {};
        if (d.supplierId && known.length === d.items.length && cost > 0) foot.appendChild(A.settleBox(d.pay, cost, save, true)); // v2.10: supplier's account (optional on a quick receipt)
        foot.appendChild(h('div.card', h('div.tot', h('span', 'جمع تعداد'), h('b', UI.qty(qsum))),
          h('div.tot', h('span', 'جمع مبلغ خرید (اقلام دارای قیمت)'), h('b', UI.moneyT(cost))),
          known.length < d.items.length ? h('p.small.muted', UI.fa(d.items.length - known.length) + ' ردیف بدون بهای خرید است. این فهرست خودکار ذخیره می‌ماند؛ می‌توانید قیمت‌ها را بعداً، پیش از «ثبت ورود»، وارد کنید. بعد از ثبت، بهای خرید اضافه نمی‌شود و سود فروش آن‌ها «نامشخص» خواهد بود.') : null));
      } else if (d.type === 'sale') {
        var t = totals();
        var disc = moneyInput(d.discount, 'تخفیف کل فاکتور (اختیاری)');
        disc.input.addEventListener('change', function () { var n = disc.value(); d.discount = n == null || isNaN(n) ? null : n; save(); renderFoot(); });
        var pays = h('div');
        (d.payments || []).forEach(function (pm, i) {
          var am = moneyInput(pm.amount, 'مبلغ');
          am.input.addEventListener('change', function () { var n = am.value(); pm.amount = n == null || isNaN(n) ? null : n; save(); renderFoot(); });
          var mt = sel(A.payMethods(), pm.method, { onchange: function () { pm.method = mt.value; save(); } });
          var ref = h('input.in', { value: pm.ref || '', placeholder: 'شماره پیگیری (اختیاری)', oninput: function () { pm.ref = ref.value; save(); } });
          pays.appendChild(h('div.line', h('div.row', h('div.grow', mt), h('button.btn.sm.ghost', { onclick: function () { d.payments.splice(i, 1); save(); renderFoot(); } }, '✕')),
            h('div.grid2', { style: { marginTop: '6px' } }, h('div', am.input, am.hint), ref)));
        });
        foot.appendChild(h('div.card', h('div.tot', h('span', 'جمع اقلام'), h('b', UI.moneyT(t.sub))), h('div', { style: { margin: '8px 0' } }, disc.input, disc.hint),
          h('div.tot.grand', h('span', 'مبلغ فاکتور'), h('b', UI.moneyT(t.total)))));
        foot.appendChild(h('div.card', h('div.row.between', h('b', 'دریافت وجه'), h('div.row',
          h('button.btn.sm', { onclick: function () { d.payments = [{ method: 'cash', amount: Math.max(0, t.total), ref: '' }]; save(); renderFoot(); } }, 'تسویه کامل'),
          h('button.btn.sm', { onclick: function () { d.payments.push({ method: 'cash', amount: Math.max(0, t.rest), ref: '' }); save(); renderFoot(); } }, '+ پرداخت'))),
          pays, (d.payments || []).length ? (function () { var pd = h('input.in', { value: d.payDate || UI.todayStr(), inputmode: 'numeric', onchange: function () { d.payDate = pd.value; save(); } }); return field('تاریخ واقعی دریافت', pd, h('div.hint', 'روزی که پول واقعاً دریافت شد (پیش‌فرض: امروز؛ مستقل از تاریخ فاکتور).')); })() : null,
          h('div.tot', h('span', 'پرداخت‌شده'), h('b', UI.moneyT(t.paid))),
          h('div.tot', h('span', t.rest >= 0 ? 'مانده (بدهی مشتری)' : 'بیش از مبلغ فاکتور!'), h('b', { style: { color: t.rest > 0 ? 'var(--bad)' : t.rest < 0 ? 'var(--bad)' : 'var(--ok)' } }, UI.moneyT(Math.abs(t.rest)))),
          !(d.payments || []).length ? h('p.small.muted', 'اگر پرداختی وارد نکنید، کل مبلغ به حساب بدهی مشتری ثبت می‌شود.') : null,
          t.rest > 0 ? (function () { var due = h('input.in', { value: d.dueDate || '', inputmode: 'numeric', placeholder: 'مثلاً ۱۴۰۵/۰۸/۲۰ (اختیاری)', onchange: function () { d.dueDate = due.value; save(); } }); return field('سررسید پرداخت مانده', due); })() : null,
          replaced ? h('p.small', { style: { color: 'var(--ok)' } }, 'پرداخت‌های فاکتور قبلی (' + UI.moneyT(replaced.paid - replaced.refunded) + ') پس از ثبت به این فاکتور منتقل می‌شود.') : null));
      } else {
        foot.appendChild(h('div.card', h('div.tot', h('span', 'جمع تعداد'), h('b', UI.qty(qsum)))));
      }
      var over = !isIn && d.items.some(function (it) { return inCart(it.productId) > avail(it.productId); });
      submitBtn.disabled = !d.items.length || over || (!isIn && d.type === 'sale' && totals().rest < 0);
      submitBtn.textContent = isIn ? 'ثبت ورود' : d.type === 'sale' ? 'ثبت فاکتور فروش' : 'ثبت خروج';
    }
    var asking = false;
    function submit(confirmed) {
      if (asking) return;
      var ts = UI.parseDateInput(dateIn.value);
      if (ts !== null && isNaN(ts)) { UI.toast('تاریخ نامعتبر است (مثال: ۱۴۰۵/۰۷/۱۹).', 'bad'); return; }
      if (ts && ts > Date.now() + 60000) { UI.toast('تاریخ سند نمی‌تواند در آینده باشد.', 'bad'); return; }
      var priceUpd = []; // v2.1.2: new sale prices typed on the receipt lines
      if (isIn) {
        if (d.items.some(function (it) { return it.sellPrice != null && !(Number.isInteger(it.sellPrice) && it.sellPrice >= 0); })) { UI.toast('قیمت فروش واردشده نامعتبر است (فقط عدد صحیح).', 'bad'); return; }
        d.items.forEach(function (it) { var p = S.products[it.productId]; if (it.sellPrice != null && p && it.sellPrice !== p.sellPrice && !priceUpd.some(function (u) { return u.id === p.id; })) priceUpd.push({ id: p.id, sellPrice: it.sellPrice }); });
        var noCost = d.items.filter(function (it) { return it.unitCost == null; }).length; // v2.9: never insists — a missing cost is asked later in «هشدارها»
        var settleOn = !!(d.supplierId && !noCost && d.items.length && d.pay && d.pay.settle); // v2.10 (quick receipt: only when chosen)
        if (settleOn) { var ctot = d.items.reduce(function (s0, it) { return s0 + it.qty * it.unitCost; }, 0), sm = ctot > 0 ? A.settleCheck(d.pay || {}, ctot) : null; if (sm) { UI.toast(sm, 'bad'); return; } }
      }
      if (!isIn && d.type === 'sale') {
        if (!d.customerId) { UI.toast('مشتری را انتخاب کنید.', 'bad'); return; }
        if (d.items.some(function (it) { return it.unitPrice == null; })) { UI.toast('قیمت فروش همه اقلام را وارد کنید.', 'bad'); return; }
      }
      var payload = { opKey: d.opKey, type: d.type, ts: ts || undefined, note: d.note, items: d.items.map(function (it) {
        return isIn ? { productId: it.productId, qty: it.qty, unitCost: it.unitCost } : { productId: it.productId, qty: it.qty, unitPrice: it.unitPrice, discount: it.discount || 0 };
      }) };
      if (isIn) { payload.supplierId = d.supplierId || null; payload.supplier = d.supplierId ? '' : (d.supplier || ''); payload.supplierDocNo = d.supplierDocNo; }
      else if (d.type === 'sale') {
        payload.customerId = d.customerId; payload.discount = d.discount || 0;
        var pts = d.payDate && String(d.payDate).trim() ? UI.parseDateInput(d.payDate) : null;
        if (pts !== null && isNaN(pts)) { UI.toast('تاریخ دریافت نامعتبر است.', 'bad'); return; }
        payload.payments = (d.payments || []).filter(function (p) { return p.amount > 0; }).map(function (p) { return { method: p.method, amount: p.amount, ref: p.ref, ts: pts || undefined }; });
        if (d.dueDate && String(d.dueDate).trim()) { var dd = UI.parseDateInput(d.dueDate, true); if (dd == null || isNaN(dd)) { UI.toast('تاریخ سررسید نامعتبر است.', 'bad'); return; } payload.dueDate = dd; }
      }
      else payload.recipient = d.recipient;
      function done(r) {
        A.newDraft(kind);
        UI.toast(r.duplicate ? 'این سند قبلاً ثبت شده بود (ثبت تکراری انجام نشد).' : 'سند ' + (r.doc.invoiceNo || r.doc.no) + ' ثبت شد.' + (isIn && noCost ? ' بهای خرید ' + UI.fa(noCost) + ' ردیف بعداً در «هشدارها» پرسیده می‌شود.' : ''), 'ok', isIn && noCost ? 4000 : undefined);
        A.go('#/doc/' + r.docId);
      }
      if (replaced) { // correction: cancel old + post new + move old payments, atomically
        payload.replaces = replaced.id;
        A.manager('اصلاح فاکتور').then(function (ctx) {
          if (!ctx) return;
          submitBtn.disabled = true; submitBtn.textContent = 'در حال ثبت…';
          A.run(DB.batch([
            function () { return E.reverseDoc(replaced.id, { opKey: d.opKey + ':rev', reason: 'اصلاح فاکتور (جایگزین شد)' }, ctx); },
            function () { return E.postIssue(payload, ctx); },
            function (dn) {
              var oldD = E.state.docs[replaced.id], newD = dn[1].doc && E.state.docs[dn[1].docId], amt = oldD && newD ? Math.min(-oldD.balance, newD.balance) : 0;
              return amt > 0 ? E.transferCredit({ opKey: d.opKey + ':tr', fromDocId: replaced.id, toDocId: newD.id, amount: amt }, ctx) : { changes: [] };
            }])).then(function (res) { done(res[1]); }, function () { renderFoot(); });
        });
        return;
      }
      submitBtn.disabled = true; submitBtn.textContent = 'در حال ثبت…';
      var tc = performance.now();
      A.runSmart(function (ctx, fl) {
        (payload.payments || []).forEach(function (pm) { pm.beforeInvoiceOk = !!fl.beforeInvoiceOk; });
        if (isIn) payload.duplicateOk = fl.duplicateOk || null; // v2.1.1
        if (isIn && (priceUpd.length || settleOn)) { // v2.1.2: receipt + new sale prices (+ v2.10 supplier account) in ONE transaction (all or nothing)
          var fns = [function () { return E.postReceipt(payload, ctx); }].concat(priceUpd.map(function (u) {
            return function (dn) { return dn[0].duplicate || !S.products[u.id] ? { changes: [] } : E.updateProduct(u.id, { sellPrice: u.sellPrice }, ctx); };
          }));
          if (settleOn) A.settleSteps(fns, 0, d.pay, d.supplierId, d.opKey, ctx);
          return DB.batch(fns);
        }
        if (!isIn && d.quoteId && S.quotes[d.quoteId]) return DB.batch([function () { return E.postIssue(payload, ctx); }, // v2.8: sale + «converted» mark, all or nothing
          function (dn) { return dn[0].duplicate ? { changes: [] } : E.markQuoteConverted(d.quoteId, dn[0].docId, ctx); }]);
        return function () { return isIn ? E.postReceipt(payload, ctx) : E.postIssue(payload, ctx); };
      }).then(function (r) {
        if (Array.isArray(r)) r = r[0];
        var all = A.lsGet('ay.scanStats') || []; all.push({ type: 'commit', at: Date.now(), ms: Math.round(performance.now() - tc), lines: payload.items.length }); A.lsSet('ay.scanStats', all.slice(-200));
        done(r);
      }, function () { renderFoot(); });
    }
    renderHead(); renderLines(); renderFoot();
    if (isIn) view.appendChild(h('div.alert.ok', h('div.grow', h('b', 'این خرید وارد انبار می‌شود'), ' (موجودی و ارزش انبار زیاد می‌شود). کالایی که مستقیم به مشتری می‌فروشید و وارد انبار نمی‌شود را از «خرید و فروش مستقیم» ثبت کنید.'), h('a.btn.sm', { href: '#/deals?new=buy' }, 'خرید مستقیم'))); // v2.8
    view.appendChild(head); view.appendChild(linesBox); view.appendChild(foot); view.appendChild(h('div.sticky-act', submitBtn));
    if (A.state.adoptScan === kind) { A.state.adoptScan = null; A.state.adoptedIn = isIn; openScan(); } // v2.4: the lookup camera continues here
  }

  // ======================= DOCUMENTS =======================
  A.routes.docs = function (arg, query) {
    setTitle('اسناد', false);
    var f = query.f || 'all', q = h('input.in', { type: 'search', placeholder: 'شماره سند، فاکتور، مشتری…' }), list = h('div'), chips = h('div.chips');
    var F = { all: 'همه', sale: 'فروش', unsettled: 'تسویه‌نشده', overdue: 'سررسید گذشته', ret: 'مرجوعی', in: 'ورود', out: 'خروج غیرفروش', adjust: 'تعدیل', reversal: 'برگشت/لغو' };
    Object.keys(F).forEach(function (k) { chips.appendChild(h('a.chip' + (f === k ? '.on' : ''), { href: '#/docs?f=' + k }, F[k])); });
    var limit = 100;
    function draw() {
      UI.clear(list);
      var n = Core.normText(q.value);
      var r = E.allDocs().reverse().filter(function (d) {
        if (f === 'sale' && !(d.kind === 'out' && d.type === 'sale')) return false;
        if (f === 'in' && d.kind !== 'in') return false;
        if (f === 'out' && !(d.kind === 'out' && d.type !== 'sale')) return false;
        if (f === 'adjust' && d.kind !== 'adjust') return false;
        if (f === 'reversal' && d.kind !== 'reversal') return false;
        if (f === 'unsettled' && !(d.type === 'sale' && d.status !== 'reversed' && d.balance > 0)) return false;
        if (f === 'overdue' && !(d.type === 'sale' && d.status !== 'reversed' && d.balance > 0 && d.dueDate && d.dueDate < UI.startOfDay(Date.now()))) return false;
        if (f === 'ret' && d.kind !== 'return') return false;
        if (!n) return true;
        var c = d.customerId && E.state.customers[d.customerId];
        return Core.normText([d.no, d.invoiceNo, d.supplier, d.recipient, d.note, c && c.name, c && c.phone].join(' ')).indexOf(n) >= 0;
      });
      if (!r.length) { list.appendChild(h('div.card.empty', 'سندی پیدا نشد.')); return; }
      list.appendChild(h('div.list', r.slice(0, limit).map(docRow)));
      if (r.length > limit) list.appendChild(h('button.btn.block', { onclick: function () { limit += 200; draw(); } }, 'نمایش بیشتر'));
    }
    q.addEventListener('input', draw);
    view.appendChild(h('div.search', q)); view.appendChild(chips); view.appendChild(list); draw();
  };

  A.routes.doc = function (id) {
    var d = E.state.docs[id];
    if (!d) { setTitle('سند', true); view.appendChild(h('div.card.empty', 'سند پیدا نشد.')); return; }
    var isSale = d.kind === 'out' && d.type === 'sale', isRet = d.kind === 'return', c = d.customerId && E.state.customers[d.customerId];
    setTitle((d.invoiceNo && !isRet ? d.invoiceNo : d.no), true);
    if (d.status === 'reversed') {
      var rv = E.state.docs[d.reversedBy];
      view.appendChild(h('a.alert.bad', { href: rv ? '#/doc/' + rv.id : '#', style: { textDecoration: 'none' } }, h('div.grow', (isSale ? 'این فاکتور لغو (ابطال) شده است' : 'این سند برگشت خورده است') + (d.reverseReason ? ' — علت: ' + d.reverseReason : '') + (rv ? ' (سند ' + rv.no + ')' : ''))));
    }
    if (d.replaces && E.state.docs[d.replaces]) view.appendChild(h('a.alert.ok', { href: '#/doc/' + d.replaces, style: { textDecoration: 'none' } }, h('div.grow', 'این فاکتور جایگزین فاکتور اصلاح‌شده ' + E.state.docs[d.replaces].invoiceNo + ' است.')));
    if (d.negativeStock) view.appendChild(h('div.alert.warn', 'این سند با موجودی منفی و تأیید مدیر ثبت شده است.'));
    var closed = A.inClosed(d.ts);
    if (closed) view.appendChild(h('div.alert.warn', h('div.grow', h('b', 'دوره مالی بسته‌شده (تا ' + A.closedText() + '): '), 'این سند قابل لغو یا اصلاح نیست. ',
      isSale ? 'برای برگشت کالا «مرجوعی کالا» و برای اصلاح، مرجوعی کامل و فاکتور جدید (با انتقال بستانکاری) در دوره باز ثبت کنید. دریافت وجه همچنان ممکن است.' : 'اصلاح با سند جبرانی در دوره باز (مرجوعی به تأمین‌کننده، تعدیل موجودی) انجام می‌شود.')));
    var overdue = isSale && d.dueDate && d.balance > 0 && d.dueDate < UI.startOfDay(Date.now());
    if (overdue) view.appendChild(h('div.alert.bad', 'سررسید این فاکتور (' + UI.dateFa(d.dueDate) + ') گذشته و ' + UI.moneyT(d.balance) + ' از آن پرداخت نشده است.'));
    view.appendChild(h('div.card', h('dl.kv',
      h('dt', 'نوع'), h('dd', window.Reports.docTypeLabel(d)),
      h('dt', 'شماره سند'), h('dd.ltr', d.no), d.invoiceNo ? [h('dt', isRet ? 'فاکتور مربوط' : 'شماره فاکتور'), h('dd', isRet ? h('a.ltr', { href: '#/doc/' + d.invoiceId }, d.invoiceNo) : h('span.ltr', d.invoiceNo))] : null,
      h('dt', 'تاریخ سند'), h('dd', UI.dateFa(d.ts, true)),
      d.createdAt && Math.abs(d.createdAt - d.ts) > 864e5 ? [h('dt', 'زمان واقعی ثبت'), h('dd', UI.dateFa(d.createdAt, true))] : null,
      d.invoice && d.invoice.date ? [h('dt', 'تاریخ فاکتور تأمین‌کننده'), h('dd', UI.dateFa(d.invoice.date))] : null,
      isSale && d.dueDate ? [h('dt', 'سررسید'), h('dd', UI.dateFa(d.dueDate))] : null,
      c ? [h('dt', 'مشتری'), h('dd', h('a', { href: '#/customer/' + c.id }, c.name))] : null,
      d.supplier ? [h('dt', 'تأمین‌کننده'), h('dd', d.supplier)] : null, d.supplierDocNo ? [h('dt', 'فاکتور خرید'), h('dd', d.supplierDocNo)] : null,
      d.recipient ? [h('dt', 'تحویل‌گیرنده'), h('dd', d.recipient)] : null,
      d.reason ? [h('dt', 'علت'), h('dd', d.reason)] : null,
      d.reversesNo ? [h('dt', 'برگشتِ سند'), h('dd', h('a', { href: '#/doc/' + d.reverses }, d.reversesNo))] : null,
      d.note ? [h('dt', 'توضیحات'), h('dd', d.note)] : null,
      h('dt', 'ثبت‌کننده'), h('dd', d.user || '—'))));
    view.appendChild(h('div.card', { style: { padding: '4px 14px' } }, d.lines.map(function (l) {
      return h('div.line', h('div.row', h('div.grow', h('a', { href: '#/product/' + l.productId, style: { fontWeight: 700, color: 'inherit' } }, l.name), h('div.small.muted', [l.brand, l.sku].filter(Boolean).join(' · '))),
        h('div.e', h('b', d.kind === 'adjust' ? UI.qty(l.before) + ' ← ' + UI.qty(l.after) : '× ' + UI.qty(l.qty)))),
        isSale ? h('div.small.muted', 'فی ' + UI.money(l.unitPrice) + (l.discount ? ' − تخفیف ' + UI.money(l.discount) : '') + ' = ' + UI.money(l.lineTotal) + (l.invDisc ? ' (سهم تخفیف فاکتور ' + UI.money(l.invDisc) + ')' : '')) : null,
        isSale && l.returnedQty ? h('div.small', { style: { color: 'var(--warn)' } }, 'مرجوع‌شده: ' + UI.qty(l.returnedQty) + ' عدد — ' + UI.moneyT(l.returnedAmount)) : null,
        isRet ? h('div.small.muted', 'مبلغ مرجوعی: ' + UI.moneyT(l.amount) + ' · بهای تمام‌شده: ' + (l.costTotal != null ? UI.moneyT(l.costTotal) : 'نامشخص')) : null,
        d.kind === 'in' && l.unitPrice != null ? h('div.small.muted', 'فی فاکتور ' + UI.money(l.unitPrice) + (d.invoice && d.invoice.currency === 'rial' ? ' ریال' : '') + (l.lineDiscount ? ' − تخفیف ردیف ' + UI.money(l.lineDiscount) : '') + (l.invDisc ? ' − سهم تخفیف کلی ' + UI.money(l.invDisc) : '') +
          (l.charges || []).map(function (x, ci) { var c = d.invoice.charges[ci]; return x ? ' + ' + (c.treatment === 'separate' ? '(جدا) ' : '') + c.label + ' ' + UI.money(x) : ''; }).join('')) : null,
        d.kind === 'in' ? h('div.small.muted', 'بهای خرید هر واحد: ' + (l.unitCost != null ? UI.moneyT(l.unitCost) : (function () { var cp = E.completionFor(l.productId, d.id, null); return cp ? UI.moneyT(cp.unitCost) + ' (تکمیل‌شده در ' + cp.docNo + ')' : 'نامشخص'; })()) + (l.costTotal != null ? ' · بهای خالص ردیف: ' + UI.moneyT(l.costTotal) : '')) : null,
        d.kind === 'cost' ? h('div.small.muted', 'بهای هر عدد: ' + UI.moneyT(l.unitCost) + ' · ورود: ', l.srcDocId ? h('a', { href: '#/doc/' + l.srcDocId }, l.srcNo) : 'موجودی قدیمی', l.srcTs ? ' (' + UI.dateFa(l.srcTs) + ')' : '', ' · در انبار: ' + UI.qty(l.inStock) + (l.listId ? ' · از لیست قیمت ' + UI.dateFa(l.listDate) : ' · دستی')) : null);
    })));
    if ((d.kind === 'in' || d.kind === 'adjust') && d.status !== 'reversed' && E.costCandidates().some(function (c) { return c.srcDocId === d.id; })) // v2.2; v2.5: opens THIS document's rows
      view.appendChild(h('a.btn.primary.block', { href: '#/costs?d=' + encodeURIComponent(d.id), style: { margin: '8px 0' } }, 'این سند ردیف بدون بهای خرید دارد — ثبت بهای خرید همان زمان'));
    if (d.invoice) view.appendChild(purchaseCard(d));
    if (d.kind === 'in' && d.status !== 'reversed') (function () { // v2.10: this purchase on the supplier's account
      var LG = E.state.ledger, rev = {}; Object.keys(LG).forEach(function (k) { if (LG[k].kind === 'reversal') rev[LG[k].reverses] = 1; });
      var bills = Object.keys(LG).map(function (k) { return LG[k]; }).filter(function (x) { return x.kind === 'bill' && x.docId === d.id && !rev[x.id]; });
      var sp = d.supplierId && E.state.suppliers[d.supplierId], tot = A.receiptTotal(d);
      if (bills.length) {
        var items = sp ? E.partyOpenItems('supplier', sp.id) : [], due = 0, amt = 0;
        bills.forEach(function (b) { amt += b.amount; var it = items.filter(function (o) { return o.t === 'bill' && o.id === b.id; })[0]; if (it) due += it.remaining; });
        view.appendChild(h('a.alert.ok', { href: sp ? '#/party/' + sp.id + '?t=supplier' : '#', style: { textDecoration: 'none' } }, h('div.grow', 'در حساب «' + (sp ? sp.name : '') + '»: بدهی این خرید ' + UI.moneyT(amt) + (due ? ' — مانده پرداخت‌نشده ' + UI.moneyT(due) : ' — تسویه شده'))));
      } else if (sp && tot.total > 0 && !tot.missing) {
        view.appendChild(h('div.alert.warn', h('div.grow', 'این خرید در حساب «' + sp.name + '» ثبت نشده است (بدهکار/بستانکار).'), h('button.btn.sm', { onclick: function () {
          var st = {}, s0 = UI.sheet('ثبت در حساب تأمین‌کننده', h('div.stack', A.settleBox(st, tot.total), h('button.btn.primary.block', { onclick: function () {
            var m = A.settleCheck(st, tot.total); if (m) { UI.toast(m, 'bad'); return; }
            var fns = [function () { return { doc: d, docId: d.id, changes: [] }; }], key = 'acct:' + d.id + ':' + UI.opKey('b');
            A.runSmart(function (ctx) { var f2 = fns.slice(0, 1); A.settleSteps(f2, 0, st, sp.id, key, ctx); return DB.batch(f2); }).then(function () { s0.close(); UI.toast('در حساب تأمین‌کننده ثبت شد.', 'ok'); route(); }, function () {});
          } }, 'ثبت')));
        } }, 'ثبت در حساب')));
      }
    })();
    if (d.kind === 'in' && !d.invoice) { // v2.8: the receipt total is always shown; rows without cost are counted, never guessed
      var kq = 0, ks = 0, nk = 0; d.lines.forEach(function (l) { var cp = l.unitCost != null ? l.unitCost : null; kq += l.qty; if (cp == null) nk++; else ks += cp * l.qty; });
      view.appendChild(h('div.card', h('div.tot', h('span', 'جمع تعداد'), h('b', UI.qty(kq))),
        h('div.tot.grand', h('span', 'جمع مبلغ خرید' + (nk ? ' (ناقص)' : '')), h('b', UI.moneyT(ks))),
        nk ? h('div.small', { style: { color: 'var(--warn)' } }, UI.fa(nk) + ' ردیف بهای خرید ندارد و در این جمع نیست.') : null));
    }
    if (isRet) view.appendChild(h('div.card', h('div.tot.grand', h('span', 'جمع مبلغ مرجوعی (بستانکار مشتری)'), h('b', UI.moneyT(d.total)))));
    if (isSale) {
      view.appendChild(h('div.card', h('div.tot', h('span', 'جمع اقلام'), h('b', UI.moneyT(d.subtotal))), d.discount ? h('div.tot', h('span', 'تخفیف فاکتور'), h('b', UI.moneyT(d.discount))) : null,
        h('div.tot.grand', h('span', 'مبلغ فاکتور'), h('b', UI.moneyT(d.total))),
        d.returned ? h('div.tot', h('span', 'مرجوعی'), h('b', '− ' + UI.moneyT(d.returned))) : null,
        h('div.tot', h('span', 'دریافت‌شده'), h('b', UI.moneyT(d.paid))),
        d.refunded ? h('div.tot', h('span', 'بازپرداخت / انتقال'), h('b', UI.moneyT(d.refunded))) : null,
        h('div.tot', h('span', d.balance < 0 ? 'بستانکاری مشتری' : 'مانده'), h('b', { style: { color: d.balance ? 'var(--bad)' : 'var(--ok)' } }, UI.moneyT(Math.abs(d.balance)))),
        h('div', { style: { marginTop: '6px' } }, h('span.badge' + (d.settlement === 'settled' ? '.ok' : d.settlement === 'credit' ? '.warn' : '.bad'), window.Reports.SETTLE[d.settlement]))));
      var rets = E.list('docs').filter(function (x) { return x.kind === 'return' && x.invoiceId === d.id; });
      if (rets.length) view.appendChild(h('div.list', rets.map(docRow)));
      var pays = E.list('payments').filter(function (p) { return p.docId === d.id; }).sort(function (a, b) { return a.ts - b.ts || a.createdAt - b.createdAt; });
      if (pays.length) view.appendChild(h('div.list', pays.map(function (p) {
        var label = p.method === 'credit_transfer' ? (p.kind === 'refund' ? 'انتقال بستانکاری به فاکتور دیگر' : 'دریافت از بستانکاری فاکتور دیگر') : (p.kind === 'refund' ? 'بازپرداخت' : 'دریافت') + ' — ' + Core.PAY_METHODS[p.method];
        var other = p.transferTo || p.transferFrom;
        return h(other ? 'a.li' : 'div.li', other ? { href: '#/doc/' + other } : {}, h('div.grow', h('div.t', label), h('div.s', p.no + ' · ' + UI.dateFa(p.ts, true) + (p.createdAt && Math.abs(p.createdAt - p.ts) > 864e5 ? ' (ثبت: ' + UI.dateFa(p.createdAt) + ')' : '') + (p.ref ? ' · پیگیری ' + p.ref : '') + (p.note ? ' · ' + p.note : ''))), h('div.e', h('b', UI.money(p.amount))));
      })));
    }
    var acts = h('div.grid2');
    acts.appendChild(h('button.btn.primary', { onclick: function () { docPdf(d); } }, isSale ? 'PDF فاکتور' : 'PDF سند'));
    if (isSale && d.status !== 'reversed') {
      if (d.balance > 0) acts.appendChild(h('button.btn.primary', { onclick: function () { paySheet(d); } }, UI.icon('cash'), 'دریافت وجه'));
      if (d.lines.some(function (l) { return l.qty > (l.returnedQty || 0); })) acts.appendChild(h('button.btn', { onclick: function () { returnSheet(d); } }, 'مرجوعی کالا'));
      if (!closed && !d.lines.some(function (l) { return l.returnedQty > 0; })) {
        acts.appendChild(h('button.btn', { onclick: function () { correctInvoice(d); } }, 'اصلاح فاکتور'));
        acts.appendChild(h('button.btn', { onclick: function () { reverseSheet(d); } }, 'لغو فاکتور (ثبت اشتباه)'));
      }
    }
    if (isSale && d.balance < 0) acts.appendChild(h('button.btn.accent', { onclick: function () { creditSheet(d); } }, 'تسویه بستانکاری مشتری'));
    if (!closed && (d.kind === 'in' || (d.kind === 'out' && !isSale) || isRet) && d.status !== 'reversed') acts.appendChild(h('button.btn', { onclick: function () { reverseSheet(d); } }, isRet ? 'لغو این مرجوعی' : 'برگشت سند'));
    if (isSale) acts.appendChild(h('button.btn', { onclick: function () { A.newDraft('out'); var nd = A.draft('out'); nd.customerId = d.customerId; A.saveDraft(nd); A.go('#/out'); } }, 'فاکتور جدید همین مشتری'));
    view.appendChild(acts);
  };
  function purchaseCard(d) {
    var iv = d.invoice, cur = iv.currency === 'rial' ? ' ریال' : ' تومان', m = function (v) { return UI.money(v) + cur; };
    return h('div.card', h('h2', 'فاکتور خرید تأمین‌کننده'), h('dl.kv',
      h('dt', 'شماره فاکتور'), h('dd', iv.no || 'بدون شماره'),
      h('dt', 'جمع اقلام'), h('dd', m(iv.computed.subtotal)),
      iv.computed.discount ? [h('dt', 'تخفیف کلی (' + (iv.discountAlloc === 'manual' ? 'تخصیص دستی' : 'به نسبت مبلغ اقلام') + ')'), h('dd', m(iv.computed.discount))] : null,
      iv.charges.map(function (c) { return [h('dt', c.label), h('dd', m(c.amount) + ' — ' + Core.CHARGE_TREAT[c.treatment] + (c.treatment === 'capitalize' ? '، ' + Core.CHARGE_BASIS[c.basis] : '') + (c.type === 'vat' ? ' (انتخاب: ' + c.chosenBy + ')' : ''))]; }),
      h('dt', 'قابل پرداخت (محاسبه‌شده)'), h('dd', h('b', m(iv.computed.payable))),
      iv.declared.payable != null ? [h('dt', 'قابل پرداخت (روی فاکتور)'), h('dd', m(iv.declared.payable))] : null,
      iv.currency === 'rial' ? [h('dt', 'معادل تومان'), h('dd', UI.moneyT(iv.payableT) + (iv.roundingDiffT ? ' (اختلاف گرد کردن: ' + UI.fa(iv.roundingDiffT) + ' تومان)' : ''))] : null,
      h('dt', 'بهای کالاها (وارد موجودی)'), h('dd', UI.moneyT(iv.costTotalT)), iv.separateT ? [h('dt', 'جدا از بهای کالا'), h('dd', UI.moneyT(iv.separateT))] : null,
      h('dt', 'تأیید ثبت'), h('dd', iv.confirmedBy + ' — ' + UI.dateFa(iv.confirmedAt, true)),
      iv.importFile ? [h('dt', 'فایل واردشده'), h('dd', iv.importFile.name)] : null),
      iv.mismatch ? h('div.alert.warn', 'اختلاف جمع با تأیید مدیر ثبت شد — علت: ' + iv.mismatch.reason) : null,
      iv.duplicateOverride ? h('div.alert.warn', 'با وجود فاکتور مشابه (' + iv.duplicateOverride.matches.map(function (x) { return x.no; }).join('، ') + ') با تأیید مدیر ثبت شد — علت: ' + iv.duplicateOverride.reason) : null,
      iv.noNumber ? h('div.alert.warn', 'بدون شماره فاکتور با تأیید مدیر — علت: ' + iv.noNumber.reason) : null,
      h('p.small.muted', 'قیمت فروش کالاها با این فاکتور تغییر نکرده است.'));
  }
  function payMethods() { var o = {}; Core.UI_PAY_METHODS.forEach(function (k) { o[k] = Core.PAY_METHODS[k]; }); return o; }
  A.payMethods = payMethods;
  function paySheet(d) {
    var am = moneyInput(d.balance, 'مبلغ'), mt = sel(payMethods(), 'cash'), ref = h('input.in', { placeholder: 'اختیاری' }), key = UI.opKey('pay');
    var pd = h('input.in', { value: UI.todayStr(), inputmode: 'numeric' });
    var btn = h('button.btn.primary.block', { onclick: function () {
      var n = am.value(); if (n == null || isNaN(n) || n <= 0) { UI.toast('مبلغ را وارد کنید.', 'bad'); return; }
      var ts = UI.parseDateInput(pd.value); if (ts !== null && isNaN(ts)) { UI.toast('تاریخ دریافت نامعتبر است.', 'bad'); return; }
      btn.disabled = true;
      A.runSmart(function (ctx, fl) { return function () { return E.addPayment(d.id, { opKey: key, method: mt.value, amount: n, ref: ref.value, ts: ts || undefined, beforeInvoiceOk: !!fl.beforeInvoiceOk }, ctx); }; })
        .then(function () { s.close(); UI.toast('دریافت ثبت شد.', 'ok'); route(); }, function () { btn.disabled = false; });
    } }, 'ثبت دریافت');
    var s = UI.sheet('دریافت وجه — ' + d.invoiceNo, h('div', h('p.muted', 'مانده فاکتور: ' + UI.moneyT(d.balance)), field('مبلغ', am.input, am.hint), field('روش پرداخت', mt),
      field('تاریخ واقعی دریافت', pd, h('div.hint', 'پیش‌فرض امروز؛ اگر پول روز دیگری دریافت شده، همان روز را وارد کنید.')), field('شماره پیگیری', ref), btn));
  }
  // partial or full return of sold items, linked to the invoice
  function returnSheet(d) {
    var q = {}, prev = h('div.card'), key = UI.opKey('ret');
    var reason = sel({ defect: 'خرابی / ایراد کالا', wrong: 'کالای اشتباه / نامناسب', change: 'انصراف مشتری', fit: 'عدم تطابق با خودرو', other: 'سایر' }, 'defect'), note = h('input.in', { placeholder: 'توضیح (اختیاری)' });
    var refundMode = sel({ keep: 'نگه‌داشتن به‌عنوان بستانکاری مشتری', refund: 'بازپرداخت همین الان' }, 'keep'), refundMethod = sel(payMethods(), 'cash');
    function credit() {
      var sum = 0;
      Object.keys(q).forEach(function (li) {
        var l = d.lines[li], n = q[li]; if (!n) return;
        var net = l.net != null ? l.net : l.lineTotal, remaining = l.qty - (l.returnedQty || 0);
        sum += n === remaining ? net - (l.returnedAmount || 0) : Math.round(net * n / l.qty);
      });
      return sum;
    }
    function draw() {
      var cr = credit(), nb = d.balance - cr;
      UI.clear(prev).appendChild(h('div', h('div.tot', h('span', 'مبلغ مرجوعی'), h('b', UI.moneyT(cr))),
        h('div.tot', h('span', nb < 0 ? 'بستانکاری مشتری پس از مرجوعی' : 'مانده بدهی پس از مرجوعی'), h('b', UI.moneyT(Math.abs(nb)))),
        nb < 0 ? h('div', field('بستانکاری چه شود؟', refundMode), refundMode.value === 'refund' ? field('روش بازپرداخت', refundMethod) : null) : null));
    }
    refundMode.addEventListener('change', draw);
    var rows = d.lines.map(function (l, li) {
      var remaining = l.qty - (l.returnedQty || 0); if (remaining <= 0) return null;
      q[li] = 0;
      var net = l.net != null ? l.net : l.lineTotal;
      return h('div.line', h('div.row', h('div.grow', h('b', l.name), h('div.small.muted', 'فروخته‌شده ' + UI.qty(l.qty) + (l.returnedQty ? ' · مرجوع قبلی ' + UI.qty(l.returnedQty) : '') + ' · خالص هر واحد ≈ ' + UI.money(Math.round(net / l.qty)))),
        A.stepper(0, function (v) { q[li] = Math.min(v, remaining); draw(); }, 0)));
    });
    var btn = h('button.btn.danger.block', { onclick: function () {
      var items = Object.keys(q).filter(function (k) { return q[k] > 0; }).map(function (k) { return { line: +k, qty: q[k] }; });
      if (!items.length) { UI.toast('تعداد مرجوعی را مشخص کنید.', 'bad'); return; }
      var over = items.filter(function (it) { return it.qty > d.lines[it.line].qty - (d.lines[it.line].returnedQty || 0); });
      if (over.length) { UI.toast('تعداد مرجوعی بیش از فروخته‌شده است.', 'bad'); return; }
      var cr = credit(), nb = d.balance - cr;
      A.manager('مرجوعی فروش').then(function (ctx) {
        if (!ctx) return;
        btn.disabled = true;
        var payload = { opKey: key, reason: reason.options[reason.selectedIndex].text + (note.value.trim() ? ' — ' + note.value.trim() : ''), items: items };
        if (nb < 0 && refundMode.value === 'refund') payload.refund = { method: refundMethod.value, amount: -nb };
        A.run(function () { return E.postSaleReturn(d.id, payload, ctx); }).then(function (r) {
          s.close(); UI.toast(r.duplicate ? 'این مرجوعی قبلاً ثبت شده بود.' : 'مرجوعی ' + r.doc.no + ' ثبت شد؛ کالا به موجودی برگشت.', 'ok', 4000); A.go('#/doc/' + r.docId);
        }, function () { btn.disabled = false; });
      });
    } }, 'ثبت مرجوعی');
    var s = UI.sheet('مرجوعی از فاکتور ' + d.invoiceNo, h('div', h('p.small.muted', 'تعداد هر کالایی را که مشتری برگردانده مشخص کنید. مبلغ از سهم خالص همان ردیف (پس از تخفیف‌ها) محاسبه و کالا با همان بهای خرید به انبار برمی‌گردد.'),
      h('div.card', { style: { padding: '4px 14px' } }, rows), field('علت مرجوعی', reason, null, true), field('توضیح', note), prev, btn));
    draw();
  }
  // customer credit on an invoice: refund cash or apply it to the customer's unpaid invoices (oldest first)
  function creditSheet(d) {
    var credit = -d.balance, open = E.allDocs().filter(function (x) { return x.kind === 'out' && x.type === 'sale' && x.customerId === d.customerId && x.status !== 'reversed' && x.balance > 0 && x.id !== d.id; });
    var debt = open.reduce(function (s, x) { return s + x.balance; }, 0), key = UI.opKey('cred'), mt = sel(payMethods(), 'cash');
    var s = UI.sheet('بستانکاری ' + UI.moneyT(credit), h('div.stack',
      open.length ? h('div.card', h('b', 'اعمال روی بدهی‌های همین مشتری'), h('p.small.muted', UI.fa(open.length) + ' فاکتور باز، جمع ' + UI.moneyT(debt) + '. پول جابه‌جا نمی‌شود؛ فقط بستانکاری به فاکتورهای باز منتقل می‌شود.'),
        h('button.btn.primary.block', { onclick: function () {
          var left = credit, fns = [];
          open.forEach(function (x, i) { if (left <= 0) return; var a = Math.min(left, x.balance); left -= a; fns.push(function () { return E.transferCredit({ opKey: key + ':' + i, fromDocId: d.id, toDocId: x.id, amount: a }, A.userCtx()); }); });
          A.run(DB.batch(fns)).then(function () { s.close(); UI.toast('بستانکاری روی ' + UI.fa(fns.length) + ' فاکتور اعمال شد.', 'ok'); route(); }, function () {});
        } }, 'اعمال بستانکاری')) : null,
      h('div.card', h('b', 'بازپرداخت وجه به مشتری'), field('روش', mt), h('button.btn.block', { onclick: function () {
        A.manager('بازپرداخت وجه').then(function (ctx) {
          if (!ctx) return;
          A.run(function () { return E.addPayment(d.id, { opKey: key + ':refund', kind: 'refund', method: mt.value, amount: credit }, ctx); }).then(function () { s.close(); UI.toast('بازپرداخت ثبت شد.', 'ok'); route(); }, function () {});
        });
      } }, 'بازپرداخت ' + UI.moneyT(credit)))));
  }
  // correction = cancel + new invoice + move the old payments, all in ONE atomic batch at submit time
  function correctInvoice(d) {
    UI.confirmBox('برای اصلاح، یک پیش‌نویس با همین اقلام باز می‌شود. با ثبت آن، فاکتور ' + d.invoiceNo + ' لغو و فاکتور جدید جایگزین آن می‌شود و پرداخت‌های قبلی به فاکتور جدید منتقل می‌شود. تا پیش از ثبت، چیزی تغییر نمی‌کند.', 'باز کردن پیش‌نویس').then(function (ok) {
      if (!ok) return;
      var nd = A.newDraft('out');
      nd.customerId = d.customerId; nd.discount = d.discount || null; nd.replaces = d.id; nd.note = d.note || ''; nd.dueDate = d.dueDate ? UI.dateFa(d.dueDate) : '';
      nd.items = d.lines.map(function (l) { return { productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount || null, unitCost: null }; });
      A.saveDraft(nd); A.go('#/out');
    });
  }
  function reverseSheet(d) {
    var isSale = d.kind === 'out' && d.type === 'sale', isRet = d.kind === 'return';
    var reason = h('input.in', { placeholder: isSale ? 'مثلاً فاکتور اشتباه صادر شد' : 'مثلاً ثبت اشتباه' }), key = UI.opKey('rev');
    var msg = isSale ? 'لغو برای فاکتوری است که اشتباه صادر شده. همه اقلام به موجودی برمی‌گردند و فاکتور از حساب مشتری خارج می‌شود؛ پرداخت‌های آن به‌صورت بستانکاری می‌ماند. برای برگشت کالا توسط مشتری از «مرجوعی کالا» استفاده کنید. سند اصلی پاک نمی‌شود.'
      : isRet ? 'کالاهای این مرجوعی دوباره از موجودی کم و مبلغ آن به بدهی مشتری برگردانده می‌شود. فقط تا وقتی ممکن است که همان کالاها هنوز در انبار باشند.'
      : d.kind === 'in' ? 'اقلام این ورود از موجودی کم می‌شوند؛ فقط تا وقتی ممکن است که همان کالاها هنوز خارج نشده باشند. سند اصلی در تاریخچه می‌ماند.' : 'اقلام به موجودی برمی‌گردند. سند اصلی در تاریخچه می‌ماند.';
    var s = UI.sheet((isSale ? 'لغو فاکتور ' : 'برگشت سند ') + (isSale ? d.invoiceNo : d.no), h('div', h('p.small.muted', msg), field('علت', reason, null, true),
      h('button.btn.danger.block', { onclick: function () {
        if (!reason.value.trim()) { UI.toast('علت را بنویسید.', 'bad'); return; }
        A.manager(isSale ? 'لغو فاکتور' : 'برگشت سند').then(function (ctx) {
          if (!ctx) return;
          A.run(function () { return E.reverseDoc(d.id, { opKey: key, reason: reason.value }, ctx); }).then(function (r) { s.close(); UI.toast('ثبت شد (' + r.doc.no + ').', 'ok'); route(); }, function () {});
        });
      } }, 'تأیید')));
  }
  function docPdf(d) {
    var shop = A.shop(), c = d.customerId && E.state.customers[d.customerId], isSale = d.kind === 'out' && d.type === 'sale';
    var title = isSale ? 'فاکتور فروش' : window.Reports.docTypeLabel(d);
    var blocks = [{ type: 'title', text: title + (d.status === 'reversed' ? ' (برگشت‌خورده)' : ''), sub: shop.name || 'امیران یدک', left: [shop.phone, shop.address].filter(Boolean) }];
    var kv = [['شماره', d.invoiceNo || d.no], ['تاریخ', UI.dateFa(d.ts, true)]];
    if (c) kv.push(['مشتری', c.name], ['تلفن', c.phone || '—']);
    if (d.supplier) kv.push(['تأمین‌کننده', d.supplier]); if (d.recipient) kv.push(['تحویل‌گیرنده', d.recipient]); if (d.reason) kv.push(['علت', d.reason]);
    if (d.invoiceNo) kv.push(['شماره سند انبار', d.no]);
    blocks.push({ type: 'kv', items: kv, cols: 2 });
    if (isSale) {
      blocks.push({ type: 'table', columns: [{ label: 'ردیف', w: 0.5, align: 'center' }, { label: 'کد', w: 1.1 }, { label: 'شرح کالا', w: 3, wrap: true }, { label: 'تعداد', w: 0.7, align: 'center' }, { label: 'فی (تومان)', w: 1.2, align: 'center' }, { label: 'تخفیف', w: 1, align: 'center' }, { label: 'مبلغ (تومان)', w: 1.3, align: 'center' }],
        rows: d.lines.map(function (l, i) { return [UI.fa(i + 1), l.sku, l.name + (l.brand ? ' — ' + l.brand : ''), UI.qty(l.qty), UI.money(l.unitPrice), l.discount ? UI.money(l.discount) : '', UI.money(l.lineTotal)]; }) });
      var tot = [['جمع اقلام', UI.moneyT(d.subtotal)]]; if (d.discount) tot.push(['تخفیف فاکتور', UI.moneyT(d.discount)]);
      tot.push(['مبلغ قابل پرداخت', UI.moneyT(d.total)], ['پرداخت‌شده', UI.moneyT(d.paid - d.refunded)], ['مانده', UI.moneyT(d.balance)]);
      blocks.push({ type: 'kv', items: tot, cols: 2 });
      var pays = Object.keys(E.state.payments).map(function (k) { return E.state.payments[k]; }).filter(function (p) { return p.docId === d.id; });
      if (pays.length) blocks.push({ type: 'table', columns: [{ label: 'پرداخت', w: 1 }, { label: 'تاریخ', w: 1.2 }, { label: 'روش', w: 1 }, { label: 'پیگیری', w: 1 }, { label: 'مبلغ', w: 1, align: 'center' }],
        rows: pays.map(function (p) { return [p.kind === 'refund' ? 'بازپرداخت' : 'دریافت', UI.dateFa(p.ts, true), Core.PAY_METHODS[p.method], p.ref || '', UI.money(p.amount)]; }) });
      A.accountBlocks().forEach(function (b) { blocks.push(b); }); // v2.8.1: where the buyer pays
      if (shop.invoiceNote) blocks.push({ type: 'text', text: shop.invoiceNote, size: 2.9, color: '#444' });
    } else {
      blocks.push({ type: 'table', columns: [{ label: 'ردیف', w: 0.5, align: 'center' }, { label: 'کد', w: 1.2 }, { label: 'شرح کالا', w: 3.2, wrap: true }, { label: d.kind === 'adjust' ? 'قبل ← بعد' : 'تعداد', w: 1, align: 'center' }, d.kind === 'in' ? { label: 'بهای خرید', w: 1.2, align: 'center' } : null].filter(Boolean),
        rows: d.lines.map(function (l, i) { return [UI.fa(i + 1), l.sku, l.name + (l.brand ? ' — ' + l.brand : ''), d.kind === 'adjust' ? UI.qty(l.before) + ' ← ' + UI.qty(l.after) : UI.qty(l.qty)].concat(d.kind === 'in' ? [l.unitCost != null ? UI.money(l.unitCost) : 'نامشخص'] : []); }) });
    }
    if (d.kind === 'in') { var rt0 = A.receiptTotal(d); blocks.push({ type: 'kv', items: [['جمع مبلغ خرید' + (rt0.missing ? ' (ناقص: ' + UI.fa(rt0.missing) + ' ردیف بی‌بها)' : ''), UI.moneyT(rt0.total)]], cols: 1 }); } // v2.10
    if (d.note) blocks.push({ type: 'text', text: 'توضیحات: ' + d.note, size: 3 });
    UI.toast('در حال ساخت PDF…');
    window.PDF.renderFlow(blocks, { title: title + ' ' + (d.invoiceNo || d.no), footer: shop.name || '' }).then(function (pdf) {
      UI.fileSheet(pdf, (d.invoiceNo || d.no) + '.pdf', 'application/pdf');
    }, A.showErr);
  }
  A.docPdf = docPdf;
  /* v2.10: a stocked purchase goes on the supplier's account in the same transaction: the debt (= payable of the document)
     and what was paid now. st: {settle: '' | cash | credit | part, paid, method, due} — chosen by the user, never assumed. */
  A.receiptTotal = function (d) { // Toman; {total, missing} (missing = lines without cost)
    if (d.invoice && d.invoice.payableT != null) return { total: d.invoice.payableT, missing: 0 };
    var t = 0, m = 0; (d.lines || d.items || []).forEach(function (l) { if (l.unitCost == null) m++; else t += l.unitCost * l.qty; }); return { total: t, missing: m };
  };
  A.settleBox = function (st, total, onChange, optional) { // optional: an empty choice = not on the account now (later from the document page)
    var box = h('div.card');
    function draw() {
      UI.clear(box);
      var opts = { '': optional ? '— فعلاً در حساب ثبت نشود —' : '— انتخاب کنید —', cash: 'نقد — کامل پرداخت شد', credit: 'نسیه — کل مبلغ بدهی به تأمین‌کننده', part: 'بخشی پرداخت شد' };
      var sl = A.sel(opts, st.settle || '', { onchange: function () { st.settle = sl.value; onChange && onChange(); draw(); } });
      var mt = A.sel(A.payMethods(), st.method || 'cash', { onchange: function () { st.method = mt.value; onChange && onChange(); } });
      var pa = A.moneyInput(st.paid, 'مبلغ پرداخت‌شده (تومان)'); pa.input.addEventListener('change', function () { st.paid = pa.value(); onChange && onChange(); });
      var du = h('input.in', { value: st.due || '', inputmode: 'numeric', placeholder: 'اختیاری' }); du.addEventListener('change', function () { st.due = du.value; onChange && onChange(); });
      box.appendChild(h('h2', 'حساب تأمین‌کننده'));
      box.appendChild(A.field('پرداخت این خرید (' + UI.moneyT(total) + ')', sl, h('div.hint', 'بدهی و پرداخت در «حساب اشخاص» ثبت می‌شود؛ هزینه دوباره نمی‌سازد.')));
      if (st.settle === 'part') box.appendChild(A.field('مبلغ پرداخت‌شده', pa.input, pa.hint));
      if (st.settle === 'cash' || st.settle === 'part') box.appendChild(A.field('روش پرداخت', mt));
      if (st.settle === 'credit' || st.settle === 'part') box.appendChild(A.field('سررسید مانده', du));
    }
    draw(); return box;
  };
  A.settleCheck = function (st, total) {
    if (!st.settle) return 'وضعیت پرداخت این خرید (نقد / نسیه / بخشی) را انتخاب کنید.';
    if (st.settle === 'part' && !(st.paid > 0 && st.paid < total)) return 'مبلغ پرداخت‌شده باید بیشتر از صفر و کمتر از جمع فاکتور باشد.';
    if (st.due && String(st.due).trim()) { var t = UI.parseDateInput(st.due, true); if (t == null || isNaN(t)) return 'تاریخ سررسید نامعتبر است.'; }
    return null;
  };
  // steps after the receipt step at index ri (in the same batch): the debt, then the payment allocated to it
  A.settleSteps = function (fns, ri, st, supplierId, key, ctx) {
    if (!st || !st.settle || !supplierId) return;
    var due = st.due && String(st.due).trim() ? UI.parseDateInput(st.due, true) : null;
    fns.push(function (done) {
      var r = done[ri], tot = A.receiptTotal(r.doc).total; if (!(tot > 0)) return { changes: [] };
      return E.postPartyEntry({ opKey: key + ':bill', kind: 'bill', partyType: 'supplier', partyId: supplierId, amount: tot, docId: r.docId, dueDate: st.settle === 'cash' ? null : due, ts: r.doc.ts, note: 'خرید ' + r.doc.no }, ctx);
    });
    var bi = fns.length - 1;
    if (st.settle === 'cash' || st.settle === 'part') fns.push(function (done) {
      var b = done[bi]; if (!b || !b.entry) return { changes: [] };
      var amt = st.settle === 'cash' ? b.entry.amount : st.paid;
      return E.postPartyEntry({ opKey: key + ':pay', kind: 'payment', partyType: 'supplier', partyId: supplierId, amount: amt, method: st.method || 'cash', ts: b.entry.ts, alloc: [{ t: 'bill', id: b.entry.id, amount: amt }], note: 'پرداخت خرید ' + done[ri].doc.no }, ctx);
    });
  };
  // v2.8.1: payment accounts and checks (IBAN mod-97, card Luhn)
  A.QUOTE_NOTE = 'اعتبار قیمت‌های این پیش‌فاکتور ۴۸ ساعت است و تا پیش از تسویه کامل، به دلیل نوسان شدید قیمت‌ها، قطعی نمی‌باشد.';
  A.normIban = function (v) { var s = String(v || '').replace(/[۰-۹]/g, function (c) { return c.charCodeAt(0) - 1776; }).replace(/[\s\-]/g, '').toUpperCase(); if (/^\d{24}$/.test(s)) s = 'IR' + s; return s; };
  A.ibanOk = function (s) {
    if (!/^IR\d{24}$/.test(s)) return false;
    var r = (s.slice(4) + '1827' + s.slice(2, 4)), m = 0; for (var i = 0; i < r.length; i++) m = (m * 10 + (+r[i])) % 97; return m === 1;
  };
  A.cardOk = function (s) {
    if (!/^\d{16}$/.test(s)) return false;
    var t = 0; for (var i = 0; i < 16; i++) { var d = +s[i]; if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } t += d; } return t % 10 === 0;
  };
  A.fmtIban = function (s) { return s.replace(/(.{4})/g, '$1 ').trim(); };
  A.fmtCard = function (s) { return s.replace(/(\d{4})/g, '$1-').replace(/-$/, ''); };
  A.accountBlocks = function () { // PDF blocks with the accounts marked «show»
    var L = (A.shop().accounts || []).filter(function (x) { return x.show !== false && (x.iban || x.card); });
    if (!L.length) return [];
    return [{ type: 'table', columns: [{ label: 'حساب واریز', w: 1.4 }, { label: 'به نام', w: 1.4 }, { label: 'شبا', w: 3, align: 'center' }, { label: 'کارت', w: 2, align: 'center' }],
      rows: L.map(function (x) { return [x.bank || '', x.owner || '', x.iban ? A.fmtIban(x.iban) : '', x.card ? A.fmtCard(x.card) : '']; }) }];
  };

  // ======================= CUSTOMERS =======================
  A.routes.customers = function () {
    setTitle('مشتریان', true);
    var q = h('input.in', { type: 'search', placeholder: 'نام یا تلفن…' }), list = h('div'), onlyDebt = A.lsGet('ay.custDebt') || false;
    var chips = h('div.chips', h('button.chip' + (!onlyDebt ? '.on' : ''), { onclick: function () { A.lsSet('ay.custDebt', false); route(); } }, 'همه'), h('button.chip' + (onlyDebt ? '.on' : ''), { onclick: function () { A.lsSet('ay.custDebt', true); route(); } }, 'بدهکاران'));
    function draw() {
      UI.clear(list);
      var n = Core.normText(q.value), ph = Core.normPhone(q.value), BAL = E.allBalances();
      var r = Object.keys(E.state.customers).map(function (k) { var c = E.state.customers[k]; return { c: c, bal: BAL[c.id] || 0 }; })
        .filter(function (x) { return (!onlyDebt || x.bal > 0) && (!n || Core.normText(x.c.name).indexOf(n) >= 0 || (ph.length >= 3 && Core.normPhone(x.c.phone).indexOf(ph) >= 0)); })
        .sort(function (a, b) { return onlyDebt ? b.bal - a.bal : a.c.name.localeCompare(b.c.name, 'fa'); });
      if (!r.length) { list.appendChild(h('div.card.empty', 'مشتری‌ای پیدا نشد.')); return; }
      list.appendChild(h('div.list', r.slice(0, 300).map(function (x) {
        return h('a.li', { href: '#/customer/' + x.c.id }, h('div.grow', h('div.t', x.c.name), h('div.s.ltr', x.c.phone || '')), x.bal ? h('span.badge' + (x.bal > 0 ? '.bad' : '.ok'), UI.money(x.bal)) : null);
      })));
    }
    q.addEventListener('input', draw);
    view.appendChild(h('div.search', q)); view.appendChild(chips); view.appendChild(list);
    view.appendChild(h('button.fab', { 'aria-label': 'مشتری جدید', html: UI.ICONS.plus, onclick: function () { A.customerForm(null, function (c) { A.go('#/customer/' + c.id); }); } }));
    draw();
  };
  A.routes.customer = function (id) {
    var c = E.state.customers[id];
    if (!c) { setTitle('مشتری', true); view.appendChild(h('div.card.empty', 'مشتری پیدا نشد.')); return; }
    setTitle(c.name, true, h('button.tb-btn', { onclick: function () { A.customerForm(c, function () { route(); }); } }, 'ویرایش'));
    var st = E.customerStatement(c.id), live = st.docs.filter(function (d) { return d.status !== 'reversed'; });
    var open = live.filter(function (d) { return d.balance > 0; }), credits = st.docs.filter(function (d) { return d.balance < 0; });
    var debt = open.reduce(function (s, d) { return s + d.balance; }, 0), credit = -credits.reduce(function (s, d) { return s + d.balance; }, 0);
    var today = UI.startOfDay(Date.now()), overdue = open.filter(function (d) { return d.dueDate && d.dueDate < today; });
    var last = live.length ? live[live.length - 1].ts : null;
    view.appendChild(h('div.card', h('div.muted', [Core.CUSTOMER_TYPES[c.type], c.phone, c.city].filter(Boolean).join(' · ') || '—'),
      h('div', { style: { margin: '6px 0' } }, h('span.muted', st.balance < 0 ? 'بستانکار: ' : 'مانده بدهی: '), h('span.big-num', { style: { color: st.balance > 0 ? 'var(--bad)' : 'var(--ok)', fontSize: '28px' } }, UI.money(Math.abs(st.balance))), h('span.muted', ' تومان')),
      h('div.small.muted', 'جمع خرید خالص: ' + UI.moneyT(st.totalSales) + ' · ' + UI.fa(live.length) + ' فاکتور' + (live.length ? ' · میانگین ' + UI.moneyT(Math.round(st.totalSales / live.length)) : '') + (last ? ' · آخرین خرید ' + UI.dateFa(last) : '') + (st.returns.length ? ' · ' + UI.fa(st.returns.length) + ' مرجوعی' : '')),
      overdue.length ? h('div.small', { style: { color: 'var(--bad)' } }, UI.fa(overdue.length) + ' فاکتور سررسید گذشته: ' + UI.moneyT(overdue.reduce(function (s, d) { return s + d.balance; }, 0))) : null,
      c.address ? h('div.small', c.address) : null, c.notes ? h('div.small.muted', c.notes) : null,
      (function () { var pb = E.partyBalance('customer', c.id); return h('a.btn.sm', { href: '#/party/' + c.id + '?t=customer', style: { marginTop: '6px' } }, 'حساب کامل' + (pb !== st.balance ? ' (با معاملات مستقیم: ' + UI.money(pb) + ')' : '')); })()));
    if (credit > 0) view.appendChild(h('div.alert.warn', h('div.grow', 'این مشتری ' + UI.moneyT(credit) + ' بستانکاری دارد' + (debt > 0 ? ' و ' + UI.moneyT(debt) + ' بدهی باز. ' : '. ')),
      h('a.btn.sm', { href: '#/doc/' + credits[0].id }, debt > 0 ? 'تسویه' : 'بازپرداخت')));
    view.appendChild(h('div.grid2',
      h('button.btn.primary', { disabled: debt <= 0, onclick: function () { receiveSheet(c); } }, UI.icon('cash'), 'دریافت وجه'),
      h('button.btn.primary', { onclick: function () { A.newDraft('out'); var nd = A.draft('out'); nd.customerId = c.id; A.saveDraft(nd); A.go('#/out'); } }, 'فاکتور جدید'),
      h('a.btn', { href: '#/report/customer?c=' + c.id }, 'صورت‌حساب و خروجی'),
      c.phone ? h('a.btn', { href: 'tel:' + c.phone.replace(/[^\d+]/g, '') }, 'تماس') : h('span')));
    view.appendChild(h('div.sec-title', 'فاکتورها و مرجوعی‌ها'));
    var all = st.docs.concat(st.returns).sort(function (a, b) { return b.ts - a.ts; });
    if (!all.length) view.appendChild(h('div.card.empty', 'فاکتوری ندارد.'));
    else view.appendChild(h('div.list', all.map(docRow)));
  };
  // receive money from a customer and allocate it to the oldest unpaid invoices (one atomic batch)
  function receiveSheet(c) {
    var open = E.allDocs().filter(function (d) { return d.kind === 'out' && d.type === 'sale' && d.customerId === c.id && d.status !== 'reversed' && d.balance > 0; });
    var debt = open.reduce(function (s, d) { return s + d.balance; }, 0);
    var am = moneyInput(debt, 'مبلغ'), mt = sel(Core.PAY_METHODS, 'cash'), ref = h('input.in', { placeholder: 'اختیاری' }), prev = h('div.small.muted'), key = UI.opKey('recv');
    function alloc(n) { var left = n, out = []; open.forEach(function (d) { if (left <= 0) return; var a = Math.min(left, d.balance); out.push({ d: d, a: a }); left -= a; }); return out; }
    am.input.addEventListener('input', function () { var n = am.value(); UI.clear(prev); if (!n || isNaN(n)) return; if (n > debt) { prev.textContent = 'بیشتر از کل بدهی (' + UI.moneyT(debt) + ') است.'; return; } prev.textContent = 'تخصیص: ' + alloc(n).map(function (x) { return x.d.invoiceNo + ' ← ' + UI.money(x.a); }).join('، '); });
    am.input.dispatchEvent(new Event('input'));
    var btn = h('button.btn.primary.block', { onclick: function () {
      var n = am.value(); if (n == null || isNaN(n) || n <= 0 || n > debt) { UI.toast('مبلغ نامعتبر است.', 'bad'); return; }
      btn.disabled = true;
      var parts = alloc(n);
      A.run(DB.batch(parts.map(function (x, i) { return function () { return E.addPayment(x.d.id, { opKey: key + ':' + i, method: mt.value, amount: x.a, ref: ref.value, note: 'دریافت از مشتری' }, A.userCtx()); }; })))
        .then(function () { s.close(); UI.toast('دریافت ' + UI.moneyT(n) + ' ثبت شد.', 'ok'); route(); }, function () { btn.disabled = false; });
    } }, 'ثبت دریافت');
    var s = UI.sheet('دریافت وجه از ' + c.name, h('div', h('p.muted', 'کل بدهی: ' + UI.moneyT(debt) + ' در ' + UI.fa(open.length) + ' فاکتور'), field('مبلغ دریافتی', am.input, am.hint), prev, field('روش پرداخت', mt), field('شماره پیگیری', ref), btn));
  }

  // ======================= MORE =======================
  A.routes.more = function () {
    setTitle('بیشتر', false);
    function item(href, ic, t, s) { return h('a.li', { href: href }, h('span', { style: { color: 'var(--brand-2)' } }, UI.icon(ic)), h('div.grow', h('div.t', t), s ? h('div.s', s) : null), h('span.muted', '‹')); }
    view.appendChild(h('div.list',
      item('#/customers', 'user', 'مشتریان', 'حساب، بدهی، دریافت وجه'),
      item('#/parties', 'user', 'حساب اشخاص و طرف‌های تجاری', 'مانده، صورت‌حساب، بدهکاران/بستانکاران، سررسید، پرداخت و دریافت'),
      item('#/price-check', 'chart', 'بررسی قیمت‌های مشکوک و کالای تکراری', 'دو لیست با دو قیمت، قیمت فروش ناهمخوان، فروش زیر قیمت خرید، کالای ثبت‌شده دوبار'),
      item('#/quotes', 'doc', 'پیش‌فاکتور', 'قیمت برای مشتری بدون اثر روی انبار و حساب؛ PDF؛ تبدیل به فاکتور'),
      item('#/deals', 'doc', 'خرید و فروش مستقیم (خارج از انبار)', 'معامله بدون ورود به انبار؛ سود هر معامله، تسویه و گزارش'),
      item('#/reports', 'chart', 'گزارش‌ها و تحلیل مدیریتی', 'گزارش با فیلتر ترکیبی، تحلیل، خروجی Excel / CSV / PDF و بسته هوش مصنوعی'),
      item('#/categories', 'box', 'گروه‌های کالا', 'رشته‌های کاری، زیرگروه‌ها و مشخصات فنی'),
      item('#/regroup', 'box', 'مرتب‌سازی گروه‌ها', 'قطعات یدکی › سیستم › نوع قطعه، متفرقه، و خودروی هر کالا — با پیشنهاد و تأیید'),
      item('#/suppliers', 'in', 'تأمین‌کنندگان', 'فهرست و خریدهای هر تأمین‌کننده'),
      item('#/purchase', 'in', 'فاکتور خرید', 'تخفیف، هزینه و مالیات، کنترل جمع، جلوگیری از ثبت تکراری، ورود از Excel'),
      item('#/pricelists', 'doc', 'لیست قیمت', 'بارگذاری لیست قیمت تأمین‌کننده یا قیمت فروش؛ تطبیق هوشمند و یادگیری'),
      item('#/saleslist', 'doc', 'لیست قیمت فروش (مصرف‌کننده)', 'ساخت لیست قیمت امیران یدک به تفکیک گروه و برند؛ قالب قابل تنظیم؛ خروجی PDF و Excel'),
      item('#/imports', 'doc', 'سابقه ورود از فایل', 'بازگرداندن لیست قیمت یا لیست کالای اشتباه'),
      (function () { var n = E.costCandidates().length; return item('#/costs', 'chart', 'تکمیل بهای خرید', n ? UI.fa(n) + ' ورود بدون بهای خرید' : 'همه ورودها بهای خرید دارند'); })(),
      item('#/period', 'doc', 'دوره مالی', 'بستن دوره، قفل اسناد گذشته، سابقه بستن و بازگشایی'),
      item('#/import', 'in', 'ورود دسته‌جمعی کالا', 'از فایل Excel یا CSV'),
      item('#/labels', 'qr', 'چاپ برچسب QR', 'PDF آماده چاپ روی A4'),
      item('#/settings', 'more', 'تنظیمات و پشتیبان‌گیری', 'اطلاعات فروشگاه، رمز مدیر، پشتیبان و بازیابی'),
      item('#/help', 'doc', 'راهنمای استفاده و نصب')));
    view.appendChild(h('p.muted', { style: { textAlign: 'center' } }, 'نسخه ' + UI.fa(APP_VERSION)));
  };

  // ======================= boot =======================
  A.boot = function () {
    buildTabbar();
    DB.open().then(function () { return A.prepareData(); }).then(function (mig) {
      DB.on(function (ev) {
        if (ev.type === 'external') route();
        else if (ev.type === 'multi' && !A.state.multiWarned) { A.state.multiWarned = true; UI.toast('برنامه در پنجره دیگری هم باز است؛ برای جلوگیری از تداخل، فقط در یک پنجره کار کنید.', 'bad', 6000); }
        else if (ev.type === 'closed') UI.toast('نسخه جدید برنامه در پنجره دیگری باز شد؛ این صفحه را ببندید یا دوباره بارگذاری کنید.', 'bad', 8000);
      });
      DB.announce();
      DB.persist();
      autoSnapshot();
      route();
      registerSW();
      if (mig && mig.migrated) UI.toast('ساختار اطلاعات به نسخه ' + UI.fa(mig.to) + ' به‌روز شد؛ موجودی و مبالغ بدون تغییر ماند (نسخه قبلی در تنظیمات نگه داشته شد).', 'ok', 7000);
      var hc = E.healthCheck({ periodHash: false }); A.state.health = hc; // quick at start-up; the closed-period fingerprint is verified a moment later
      if (hc.critical) UI.toast('بررسی سلامت داده‌ها ' + UI.fa(hc.critical) + ' مشکل جدی پیدا کرد؛ تنظیمات ← بررسی سلامت داده‌ها.', 'bad', 8000);
      else if (E.closedThrough() != null) setTimeout(function () { var full = E.healthCheck(); A.state.health = full; if (full.critical) UI.toast('بررسی سلامت: اطلاعات دوره مالی بسته‌شده تغییر کرده است؛ تنظیمات ← بررسی سلامت داده‌ها.', 'bad', 8000); }, 4000);
    }).catch(function (e) {
      var box = UI.clear(view).appendChild(h('div.alert.bad', h('div.grow', h('b', e && e.code === 'MIGRATION_FAILED' ? 'به‌روزرسانی ساختار داده انجام نشد. ' : 'حافظه دستگاه در دسترس نیست. '),
        e && (e.code === 'MIGRATION_FAILED' || e.code === 'NEWER_SCHEMA') ? e.message : 'اگر Safari در حالت Private است آن را خارج کنید. اگر برنامه در پنجره دیگری باز است آن را ببندید. خطا: ' + (e && (e.message || e.name)))));
      if (e && e.raw) view.appendChild(h('button.btn.block', { onclick: function () {
        window.Backup.make(e.raw, { app: A.version }).then(function (txt) { UI.fileSheet(new Blob([txt], { type: 'application/json' }), 'amiran-raw-backup.json', 'application/json', 'نسخه دست‌نخورده اطلاعات؛ آن را نگه دارید و برای پشتیبان فنی بفرستید.'); });
      } }, 'دریافت نسخه دست‌نخورده اطلاعات'));
      return box;
    });
  };
  function autoSnapshot() {
    var has = Object.keys(E.state.docs).length + Object.keys(E.state.products).length;
    if (!has) return;
    DB.listSnapshots().then(function (list) {
      var last = list.filter(function (s) { return s.kind === 'auto'; })[0];
      if (!last || Date.now() - last.ts > 20 * 3600 * 1000) return DB.putSnapshot('auto', E.exportAll(), 7);
    }).catch(function () {});
  }
  function registerSW() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      function ask(w) {
        var bar = h('div.alert.ok', { style: { position: 'fixed', top: '60px', left: '10px', right: '10px', zIndex: 90 } }, h('div.grow', 'نسخه جدید برنامه آماده است.'),
          h('button.btn.sm.primary', { onclick: function () { w.postMessage({ type: 'SKIP_WAITING' }); } }, 'به‌روزرسانی'));
        document.body.appendChild(bar);
      }
      if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        w && w.addEventListener('statechange', function () { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); });
      });
      A.checkUpdate = function () { return reg.update(); };
    }).catch(function () {});
    // reload only when an UPDATE takes over (not when the very first install claims this page)
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadController && !reloaded) { reloaded = true; location.reload(); } hadController = true; });
  }
  document.addEventListener('DOMContentLoaded', function () { A.boot(); });
})();
