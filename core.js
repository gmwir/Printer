/* Amiran Yadak Inventory — core engine (schema v2).
   Pure logic (no DOM, no IndexedDB). State = plain records in STORES.
   Every operation validates first, then commits ALL record changes at once (atomic) and returns
   the changed records so the storage adapter can persist them in ONE transaction.
   engine.revert(changes) restores memory if persistence fails.
   Money: integer Toman. Quantities: integer counting units. Timestamps: ms since epoch (UTC).
   Posted documents are never deleted or rewritten; corrections are new documents (reversal / return /
   adjustment). Derived fields on an invoice (paid, returned, balance) change only through payment /
   return / reversal documents, which are themselves stored. */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 2;
  var STORES = ['products', 'customers', 'docs', 'payments', 'movements', 'ops', 'meta', 'categories', 'suppliers', 'audit', 'deals', 'ledger', 'quotes']; // v2.8: + quotes (proforma, no accounting effect) // v2.5: + deals (direct buy/sell, outside stock), ledger (party accounts)
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.\-]{0,127}$/;

  function AppError(code, message, details) {
    var e = new Error(message); e.name = 'AppError'; e.code = code; e.details = details || null; return e;
  }

  // ---------- normalization helpers ----------
  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ۀ/g, 'ه').replace(/ة/g, 'ه')
      .replace(/[۰-۹]/g, function (c) { return c.charCodeAt(0) - 1776; })
      .replace(/[٠-٩]/g, function (c) { return c.charCodeAt(0) - 1632; })
      .replace(/[‌‏‎]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function normSku(s) { return normText(s).replace(/\s+/g, ''); }
  function normPhone(s) {
    var d = normText(s).replace(/\D/g, '');
    if (d.length >= 10) d = d.slice(-10); // 0912..., +98912..., 98912... -> 912...
    return d;
  }
  function normCode(s) { return String(s == null ? '' : s).trim(); }
  function isMoney(n) { return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0; }
  function isQty(n) { return typeof n === 'number' && Number.isSafeInteger(n) && n > 0; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function dict() { return Object.create(null); }
  function str(s) { return String(s == null ? '' : s).trim(); }

  var SALE = 'sale';
  // UI-selectable types are listed first; legacy types stay valid so old documents keep their labels.
  var ISSUE_TYPES = { sale: 'فروش', supplier_return: 'مرجوعی به تأمین‌کننده', scrap: 'ضایعات یا آسیب', internal: 'مصرف داخلی', other: 'سایر', transfer: 'انتقال (قدیمی)' };
  var RECEIPT_TYPES = { purchase: 'خرید', initial: 'موجودی اولیه', other: 'سایر', customer_return: 'مرجوعی بدون فاکتور (قدیمی)', transfer_in: 'انتقال (قدیمی)' };
  var UI_ISSUE_TYPES = ['sale', 'supplier_return', 'scrap', 'internal', 'other'];
  var UI_RECEIPT_TYPES = ['purchase', 'initial', 'other'];
  var PAY_METHODS = { cash: 'نقدی', card_transfer: 'کارت‌به‌کارت', pos: 'کارت‌خوان', bank: 'انتقال بانکی', cheque: 'چک', other: 'سایر', credit: 'اعتباری (قدیمی)', credit_transfer: 'انتقال بستانکاری' };
  var UI_PAY_METHODS = ['cash', 'card_transfer', 'pos', 'bank', 'cheque', 'other'];
  var CUSTOMER_TYPES = { mechanic: 'تعمیرکار', store: 'فروشگاه / همکار', person: 'مشتری شخصی', company: 'شرکت / سازمان', other: 'سایر' };
  var ATTR_TYPES = { text: 'متن', number: 'عدد', select: 'انتخابی' };

  function randomCode(len, alphabet) {
    var a = alphabet || '0123456789ABCDEFGHJKMNPQRSTVWXYZ', out = '', bytes = new Uint8Array(len);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < len; j++) out += a[bytes[j] % a.length];
    return out;
  }

  /* ---------- v2.1: synchronous SHA-256 (UTF-8) + canonical JSON, so period fingerprints are identical in
     Node and every browser and can be recomputed at any time without async WebCrypto. ---------- */
  var SHA_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256Stream() {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Int32Array(64), B = new Uint8Array(64), bl = 0, total = 0;
    function compress() {
      var i, a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 16; i++) W[i] = (B[i * 4] << 24) | (B[i * 4 + 1] << 16) | (B[i * 4 + 2] << 8) | B[i * 4 + 3];
      for (i = 16; i < 64; i++) {
        var x = W[i - 15], y = W[i - 2];
        W[i] = (W[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + W[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
      }
      for (i = 0; i < 64; i++) {
        var t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
        var t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    function put(v) { B[bl++] = v; total++; if (bl === 64) { compress(); bl = 0; } }
    return {
      update: function (s) {
        s = String(s);
        for (var i = 0; i < s.length; i++) {
          var c = s.charCodeAt(i);
          if (c < 0x80) put(c);
          else if (c < 0x800) { put(0xc0 | (c >> 6)); put(0x80 | (c & 63)); }
          else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) < 0xe000) {
            var cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
            put(0xf0 | (cp >> 18)); put(0x80 | ((cp >> 12) & 63)); put(0x80 | ((cp >> 6) & 63)); put(0x80 | (cp & 63));
          } else if (c >= 0xd800 && c < 0xe000) { put(0xef); put(0xbf); put(0xbd); } // lone surrogate -> U+FFFD (as TextEncoder)
          else { put(0xe0 | (c >> 12)); put(0x80 | ((c >> 6) & 63)); put(0x80 | (c & 63)); }
        }
        return this;
      },
      hex: function () {
        var bytes = total, hi = Math.floor(bytes / 0x20000000), lo = (bytes * 8) >>> 0;
        put(0x80); while (bl !== 56) put(0);
        put((hi >>> 24) & 255); put((hi >>> 16) & 255); put((hi >>> 8) & 255); put(hi & 255);
        put((lo >>> 24) & 255); put((lo >>> 16) & 255); put((lo >>> 8) & 255); put(lo & 255);
        return H.map(function (v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
      }
    };
  }
  function sha256Hex(s) { return sha256Stream().update(s).hex(); }
  function canon(v) { // deterministic JSON: object keys sorted at every level
    if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    var ks = Object.keys(v).sort(), out = [];
    for (var i = 0; i < ks.length; i++) if (v[ks[i]] !== undefined) out.push(JSON.stringify(ks[i]) + ':' + canon(v[ks[i]]));
    return '{' + out.join(',') + '}';
  }
  /* Settlement ("current state") fields of a document: the ONLY fields that may change on a document of a
     closed period, and only as a side effect of open-period operations (payment, return, transfer). No historical
     report reads them; historical numbers are derived from dated records (see invoiceStates / stockAsOf). */
  var SETTLE_DOC = { paid: 1, refunded: 1, returned: 1, balance: 1, settlement: 1, updatedAt: 1, rev: 1 };
  var SETTLE_LINE = { returnedQty: 1, returnedAmount: 1, returnedCost: 1, layersLeft: 1 };
  function histView(doc) {
    var o = {};
    Object.keys(doc).forEach(function (k) {
      if (SETTLE_DOC[k]) return;
      if (k === 'lines' && Array.isArray(doc.lines)) o.lines = doc.lines.map(function (l) { var x = {}; Object.keys(l || {}).forEach(function (lk) { if (!SETTLE_LINE[lk]) x[lk] = l[lk]; }); return x; });
      else o[k] = doc[k];
    });
    return o;
  }
  function stripRev(r) { var o = {}; Object.keys(r).forEach(function (k) { if (k !== 'rev') o[k] = r[k]; }); return o; }
  var PERIOD_ALGO = 1, BACKDATE_DAYS = 7, DAY_MS = 864e5, TZ_MS = 12600000; // Iran Standard Time (UTC+3:30), used only for "same day" comparisons
  var RESERVED_META = ['counters', 'barcodes', 'settings', 'schema', 'periods', 'learn', 'priceGroups', 'vis']; // v2.2: learn, priceGroups, vis have dedicated writers
  var RESERVED_PREFIX = /^(att|map|exp|pinv|plist|imp):|^x\./; // v2.2: plist: = purchase price lists; imp: = import records (undo) // future side records (attachments, accounting maps, export status) — written only by dedicated functions; v2.5: x.deals. / x.ledger. = where db.js keeps the deals & ledger stores
  function dayKey(ts) { return Math.floor((ts + TZ_MS) / DAY_MS); }
  // exact largest-remainder split of an integer total by integer weights (no per-line cap; Σ == total)
  function allocExact(total, weights) {
    var sum = weights.reduce(function (s, w) { return s + w; }, 0), out = weights.map(function () { return 0; });
    if (!total) return out;
    if (!sum) return null;
    var rem = total, fr = [];
    weights.forEach(function (w, i) { var ex = total * w / sum; out[i] = Math.floor(ex); rem -= out[i]; fr.push({ i: i, f: ex - out[i] }); });
    fr.sort(function (a, b) { return b.f - a.f || a.i - b.i; });
    for (var k = 0; rem > 0; k = (k + 1) % fr.length) { if (weights[fr[k].i] > 0) { out[fr[k].i]++; rem--; } }
    return out;
  }
  // supplier invoice numbers: STRICT key (digits/ي ك/case/spaces only) decides "definite duplicate";
  // SIMILAR key (no separators, no leading zeros) only raises "probable duplicate" — never merges two numbers.
  function invKeyStrict(no) {
    return String(no == null ? '' : no).replace(/[۰-۹]/g, function (c) { return c.charCodeAt(0) - 1776; }).replace(/[٠-٩]/g, function (c) { return c.charCodeAt(0) - 1632; })
      .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[‌‏‎]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function invKeySimilar(no) { return invKeyStrict(no).replace(/[^0-9a-zؠ-يپچژکگی]/g, '').replace(/^0+(?=.)/, ''); }

  function createEngine(opts) {
    opts = opts || {};
    var now = opts.now || function () { return Date.now(); };
    var newId = opts.newId || function () { return randomCode(8); };
    var newPublic = opts.newPublicCode || function () { return randomCode(10, '23456789ABCDEFGHJKMNPQRSTUVWXYZ'); };
    var S = {}; STORES.forEach(function (n) { S[n] = dict(); });

    // ---------- in-memory indexes ----------
    var IX;
    function nbKey(p) { var c = function (x) { return normText(x).replace(/[آأإ]/g, 'ا').replace(/[^0-9a-z\u0600-\u06FF]/g, ''); }; return c(p.name) + '|' + c(p.brand); } // v2.10: «لنت-ترمز جلو» = «لنت ترمز جلو» (spaces, dashes, signs ignored)
    function ixReset() { IX = { sku: dict(), nb: dict(), phone: dict(), pub: dict(), supName: dict() }; }
    ixReset();
    function ixAdd(store, r) {
      if (store === 'products') {
        IX.sku[normSku(r.sku)] = r.id; var k = nbKey(r); (IX.nb[k] = IX.nb[k] || []).push(r.id);
        if (r.publicCode) IX.pub[r.publicCode] = r.id;
      } else if (store === 'customers') { var ph = normPhone(r.phone); if (ph.length >= 7) IX.phone[ph] = r.id; }
      else if (store === 'suppliers') IX.supName[normText(r.name)] = r.id;
    }
    function ixDel(store, r) {
      if (store === 'products') {
        if (IX.sku[normSku(r.sku)] === r.id) delete IX.sku[normSku(r.sku)];
        var k = nbKey(r), a = IX.nb[k]; if (a) { a = a.filter(function (x) { return x !== r.id; }); if (a.length) IX.nb[k] = a; else delete IX.nb[k]; }
        if (r.publicCode && IX.pub[r.publicCode] === r.id) delete IX.pub[r.publicCode];
      } else if (store === 'customers') { var ph = normPhone(r.phone); if (IX.phone[ph] === r.id) delete IX.phone[ph]; }
      else if (store === 'suppliers') { if (IX.supName[normText(r.name)] === r.id) delete IX.supName[normText(r.name)]; }
    }
    function ixRebuild() { ixReset(); ['products', 'customers', 'suppliers'].forEach(function (st) { Object.keys(S[st]).forEach(function (id) { ixAdd(st, S[st][id]); }); }); }

    // ---------- transaction (all-or-nothing) ----------
    function Tx() { this.work = {}; this.del = {}; STORES.forEach(function (n) { this.work[n] = dict(); this.del[n] = dict(); }, this); }
    Tx.prototype.get = function (store, id) {
      if (this.work[store][id]) return this.work[store][id];
      var cur = S[store][id]; if (!cur) return null;
      return (this.work[store][id] = clone(cur));
    };
    Tx.prototype.put = function (store, rec) { this.work[store][rec.id] = rec; return rec; };
    // a NEW record: never silently overwrites an existing one
    Tx.prototype.insert = function (store, rec) {
      if (S[store][rec.id] || this.work[store][rec.id]) throw AppError('ID_CLASH', 'شناسه تکراری در ' + store + ': ' + rec.id);
      this.work[store][rec.id] = rec; return rec;
    };
    Tx.prototype.remove = function (store, id) { this.del[store][id] = true; delete this.work[store][id]; };
    Tx.prototype.id = function (store) { // unique id for a new record in this store
      for (var i = 0; i < 50; i++) { var id = newId(); if (!S[store][id] && !this.work[store][id]) return id; }
      throw AppError('ID_CLASH', 'ساخت شناسه یکتا ممکن نشد.');
    };
    Tx.prototype.commit = function () {
      periodGuard(this); // v2.1: central lock — every write path of the engine passes here
      var changes = [];
      STORES.forEach(function (st) {
        Object.keys(this.work[st]).forEach(function (id) {
          var rec = this.work[st][id], prev = S[st][id] || null;
          rec.rev = (prev && prev.rev || 0) + 1;
          changes.push({ store: st, rec: rec, prev: prev });
        }, this);
        Object.keys(this.del[st]).forEach(function (id) {
          if (S[st][id]) changes.push({ store: st, rec: S[st][id], prev: S[st][id], deleted: true });
        });
      }, this);
      changes.forEach(function (c) {
        if (c.prev) ixDel(c.store, c.prev);
        if (c.deleted) delete S[c.store][c.rec.id];
        else { S[c.store][c.rec.id] = c.rec; ixAdd(c.store, c.rec); }
      });
      if (changes.length) VER++;
      return changes;
    };
    function revert(changes) {
      changes.slice().reverse().forEach(function (c) {
        if (!c.deleted) ixDel(c.store, c.rec);
        if (c.prev) { S[c.store][c.rec.id] = c.prev; ixAdd(c.store, c.prev); } else delete S[c.store][c.rec.id];
      });
      if (changes.length) VER++;
    }
    var VER = 0; // in-memory data version (changes on every commit / revert / load) — used to detect a stale backup

    // ---------- v2.1 period lock: central guard ----------
    function closedThrough() { var m = S.meta.periods; return m && m.v && typeof m.v.closedThrough === 'number' ? m.v.closedThrough : null; }
    function fmtD(ts) { try { var J = root.Jalali; return J && J.fmt ? J.fmt(ts) : new Date(ts).toISOString().slice(0, 10); } catch (e) { return String(ts); } }
    function lockErr(msg, details) { return AppError('PERIOD_CLOSED', msg, details); }
    function periodGuard(tx) {
      if ((tx.work.meta.periods || tx.del.meta.periods) && !tx.allowPeriods) throw AppError('PERIOD_RESERVED', 'قفل دوره مالی فقط از «بستن دوره» یا «بازگشایی دوره» تغییر می‌کند.');
      Object.keys(tx.work.meta).concat(Object.keys(tx.del.meta)).forEach(function (id) {
        if (RESERVED_PREFIX.test(id) && !tx.allowReserved) throw AppError('PERIOD_RESERVED', 'این رکورد فقط از مسیر مخصوص خودش نوشته می‌شود.');
      });
      var c = closedThrough();
      ['docs', 'payments', 'movements', 'deals', 'ledger'].forEach(function (st) { // v2.5: deals & ledger are dated and immutable like payments
        Object.keys(tx.work[st]).forEach(function (id) {
          var rec = tx.work[st][id], prev = S[st][id];
          if (!prev) {
            if (typeof rec.ts !== 'number' || !isFinite(rec.ts)) throw AppError('BAD_INPUT', 'تاریخ رکورد نامعتبر است.');
            if (c != null && rec.ts <= c) throw lockErr('ثبت با تاریخ ' + fmtD(rec.ts) + ' ممکن نیست: دوره مالی تا ' + fmtD(c) + ' بسته شده است.', { ts: rec.ts, closedThrough: c, store: st });
            return;
          }
          if (rec.ts !== prev.ts) throw AppError('TS_IMMUTABLE', 'تاریخ سند یا پرداخت ثبت‌شده قابل تغییر نیست.', { id: id, store: st });
          if (c != null && prev.ts <= c) {
            if (st !== 'docs') throw lockErr('پرداخت یا گردش دوره بسته‌شده قابل تغییر نیست.', { id: id, store: st });
            if (canon(histView(prev)) !== canon(histView(rec))) throw lockErr('سند ' + (prev.invoiceNo || prev.no) + ' در دوره مالی بسته‌شده است و قابل تغییر نیست؛ اصلاح فقط با سند جبرانی در دوره باز.', { id: id, store: st });
          }
        });
        Object.keys(tx.del[st]).forEach(function (id) {
          var prev = S[st][id];
          if (prev && c != null && prev.ts <= c) throw lockErr('رکورد دوره بسته‌شده قابل حذف نیست.', { id: id, store: st });
        });
      });
    }
    function counterNext(tx, key) {
      var m = tx.get('meta', 'counters') || tx.put('meta', { id: 'counters', v: {} });
      m.v[key] = (m.v[key] || 0) + 1;
      return m.v[key];
    }
    function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
    function settings() { return (S.meta.settings && S.meta.settings.v) || { allowNegative: false }; }
    function requireManager(ctx, what) {
      if (!ctx || ctx.manager !== true) throw AppError('NEED_MANAGER', 'این عملیات به تأیید مدیر نیاز دارد: ' + what);
    }
    function checkOpKey(opKey) {
      if (!opKey || typeof opKey !== 'string') throw AppError('NO_OPKEY', 'شناسه یکتای عملیات الزامی است.');
    }
    function existingOp(opKey) {
      var o = S.ops[opKey]; if (!o) return null;
      return { duplicate: true, docId: o.docId, doc: S.docs[o.docId] || null, changes: [] };
    }
    function who(ctx) { return (ctx && ctx.user) || 'مدیر'; }
    function src(ctx, d) { return str((d && d.source) || (ctx && ctx.source) || 'ui'); }

    // ---------- audit trail (master data; stock & money are traced by documents) ----------
    var AUDIT_SKIP = { stock: 1, layers: 1, costBasis: 1, costedQty: 1, updatedAt: 1, rev: 1, createdAt: 1 };
    function diff(before, after) {
      var ch = {}, keys = {}, k;
      for (k in (before || {})) keys[k] = 1; for (k in (after || {})) keys[k] = 1;
      Object.keys(keys).forEach(function (key) {
        if (AUDIT_SKIP[key]) return;
        var a = before ? before[key] : undefined, b = after ? after[key] : undefined;
        if (JSON.stringify(a) !== JSON.stringify(b)) ch[key] = [a === undefined ? null : a, b === undefined ? null : b];
      });
      return ch;
    }
    function audit(tx, entity, entityId, action, before, after, ctx, extra) {
      var changes = diff(before, after);
      if (action === 'update' && !Object.keys(changes).length) return null;
      var rec = Object.assign({ id: tx.id('audit'), ts: now(), user: who(ctx), entity: entity, entityId: entityId, action: action, changes: changes, source: src(ctx) }, extra || {});
      return tx.insert('audit', rec);
    }

    // ---------- categories (tree, user-defined, no code needed) ----------
    function categoryPath(id) {
      var names = [], seen = {}, c = S.categories[id];
      while (c && !seen[c.id]) { seen[c.id] = 1; names.unshift(c.name); c = c.parentId ? S.categories[c.parentId] : null; }
      return names;
    }
    function categoryDescendants(id) { // includes id itself
      var out = [id], i = 0;
      while (i < out.length) { var cur = out[i++]; Object.keys(S.categories).forEach(function (k) { if (S.categories[k].parentId === cur && out.indexOf(k) < 0) out.push(k); }); }
      return out;
    }
    function categoryAttrDefs(id) { // inherited from ancestors, nearest wins on key clash
      var defs = [], keys = {}, chain = [], seen = {}, c = S.categories[id];
      while (c && !seen[c.id]) { seen[c.id] = 1; chain.push(c); c = c.parentId ? S.categories[c.parentId] : null; }
      chain.forEach(function (cat) { (cat.attrDefs || []).forEach(function (d) { if (!keys[d.key]) { keys[d.key] = 1; defs.push(d); } }); });
      return defs;
    }
    function validAttrDefs(defs) {
      var keys = {};
      (defs || []).forEach(function (d) {
        if (!d || !normText(d.label)) throw AppError('BAD_INPUT', 'عنوان مشخصه الزامی است.');
        if (!ATTR_TYPES[d.type || 'text']) throw AppError('BAD_INPUT', 'نوع مشخصه نامعتبر است.');
        if (!d.key) throw AppError('BAD_INPUT', 'کلید مشخصه الزامی است.');
        if (keys[d.key]) throw AppError('BAD_INPUT', 'مشخصه تکراری: ' + d.label); keys[d.key] = 1;
      });
      return (defs || []).map(function (d) { return { key: String(d.key), label: str(d.label), type: d.type || 'text', options: (d.options || []).map(str).filter(Boolean) }; });
    }
    function findCategoryByName(name, parentId) {
      var n = normText(name);
      for (var k in S.categories) { var c = S.categories[k]; if (normText(c.name) === n && (c.parentId || null) === (parentId || null)) return c; }
      return null;
    }
    function createCategory(c, ctx) {
      if (!normText(c.name)) throw AppError('BAD_INPUT', 'نام گروه الزامی است.');
      if (c.parentId && !S.categories[c.parentId]) throw AppError('NOT_FOUND', 'گروه والد پیدا نشد.');
      var dup = findCategoryByName(c.name, c.parentId);
      if (dup) throw AppError('DUP_CATEGORY', 'گروهی با همین نام در همین سطح وجود دارد.', { categoryId: dup.id });
      var tx = new Tx();
      var rec = tx.insert('categories', { id: tx.id('categories'), name: str(c.name), parentId: c.parentId || null, attrDefs: validAttrDefs(c.attrDefs),
        active: true, order: c.order || 0, createdAt: now(), updatedAt: now() });
      audit(tx, 'category', rec.id, 'create', null, rec, ctx);
      return { category: rec, changes: tx.commit() };
    }
    function updateCategory(id, patch, ctx) {
      var cur = S.categories[id]; if (!cur) throw AppError('NOT_FOUND', 'گروه پیدا نشد.');
      var tx = new Tx(), c = tx.get('categories', id), before = clone(cur);
      if (patch.name !== undefined) {
        if (!normText(patch.name)) throw AppError('BAD_INPUT', 'نام گروه الزامی است.');
        var dup = findCategoryByName(patch.name, patch.parentId !== undefined ? patch.parentId : cur.parentId);
        if (dup && dup.id !== id) throw AppError('DUP_CATEGORY', 'گروهی با همین نام در همین سطح وجود دارد.');
        c.name = str(patch.name);
      }
      if (patch.parentId !== undefined) {
        var p = patch.parentId || null;
        if (p && !S.categories[p]) throw AppError('NOT_FOUND', 'گروه والد پیدا نشد.');
        if (p && categoryDescendants(id).indexOf(p) >= 0) throw AppError('BAD_INPUT', 'گروه نمی‌تواند زیرمجموعه خودش باشد.');
        c.parentId = p;
      }
      if (patch.attrDefs !== undefined) c.attrDefs = validAttrDefs(patch.attrDefs);
      if (patch.active !== undefined) c.active = !!patch.active;
      if (patch.order !== undefined) c.order = patch.order | 0;
      c.updatedAt = now();
      audit(tx, 'category', id, 'update', before, c, ctx);
      return { category: c, changes: tx.commit() };
    }
    function deleteCategory(id, ctx) {
      if (!S.categories[id]) throw AppError('NOT_FOUND', 'گروه پیدا نشد.');
      var used = Object.keys(S.products).some(function (k) { return S.products[k].categoryId === id; });
      var kids = Object.keys(S.categories).some(function (k) { return S.categories[k].parentId === id; });
      if (used || kids) throw AppError('IN_USE', 'این گروه کالا یا زیرگروه دارد؛ به‌جای حذف، آن را غیرفعال کنید.');
      var tx = new Tx(); audit(tx, 'category', id, 'delete', S.categories[id], null, ctx); tx.remove('categories', id);
      return { changes: tx.commit() };
    }

    // v2.3: make sure a group path exists («یدکی › جلوبندی › سیبک فرمان»): existing levels are reused, missing ones created
    function ensureCategoryPath(names, ctx) {
      names = (names || []).map(str).filter(Boolean);
      if (!names.length || names.length > 6) throw AppError('BAD_INPUT', 'مسیر گروه نامعتبر است.');
      var tx = new Tx(), parent = null, fresh = false, made = [];
      names.forEach(function (nm) {
        var ex = fresh ? null : findCategoryByName(nm, parent);
        if (ex) { parent = ex.id; return; }
        fresh = true;
        var rec = tx.insert('categories', { id: tx.id('categories'), name: nm, parentId: parent, attrDefs: [], active: true, order: 0, createdAt: now(), updatedAt: now() });
        audit(tx, 'category', rec.id, 'create', null, rec, ctx); made.push(rec.id); parent = rec.id;
      });
      var changes = tx.commit();
      return { category: S.categories[parent], created: made, changes: changes };
    }
    // v2.3: move many products to their groups / set their cars in ONE step (the regroup screen); no stock, price or document changes
    function setProductGroups(items, ctx) {
      items = items || [];
      items.forEach(function (it) {
        if (!it || !S.products[it.id]) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
        if (it.categoryId && !S.categories[it.categoryId]) throw AppError('NOT_FOUND', 'گروه کالا پیدا نشد.');
        if (it.cars !== undefined) validateProductFields(Object.assign({}, S.products[it.id], { cars: it.cars }));
      });
      var tx = new Tx();
      items.forEach(function (it) {
        var p = tx.get('products', it.id), before = clone(S.products[it.id]);
        if (it.categoryId !== undefined) { p.categoryId = it.categoryId || null; p.category = p.categoryId ? categoryPath(p.categoryId).join(' › ') : ''; }
        if (it.cars !== undefined) { var cs = cleanCars(it.cars); if (cs.length) p.cars = cs; else delete p.cars; }
        p.updatedAt = now();
        audit(tx, 'product', it.id, 'update', before, p, ctx, { reason: str(it.reason) || 'مرتب‌سازی گروه‌ها' });
      });
      return { changes: tx.commit() };
    }

    // ---------- suppliers ----------
    function createSupplier(s, ctx) {
      if (!normText(s.name)) throw AppError('BAD_INPUT', 'نام تأمین‌کننده الزامی است.');
      var dupId = IX.supName[normText(s.name)];
      if (dupId) throw AppError('DUP_SUPPLIER', 'تأمین‌کننده‌ای با همین نام وجود دارد.', { supplierId: dupId });
      var tx = new Tx();
      var rec = tx.insert('suppliers', { id: tx.id('suppliers'), name: str(s.name), phone: str(s.phone), city: str(s.city), notes: str(s.notes), active: true, createdAt: now(), updatedAt: now() });
      audit(tx, 'supplier', rec.id, 'create', null, rec, ctx);
      return { supplier: rec, changes: tx.commit() };
    }
    function updateSupplier(id, patch, ctx) {
      var cur = S.suppliers[id]; if (!cur) throw AppError('NOT_FOUND', 'تأمین‌کننده پیدا نشد.');
      if (patch.name !== undefined) {
        if (!normText(patch.name)) throw AppError('BAD_INPUT', 'نام تأمین‌کننده الزامی است.');
        var d = IX.supName[normText(patch.name)]; if (d && d !== id) throw AppError('DUP_SUPPLIER', 'تأمین‌کننده‌ای با همین نام وجود دارد.');
      }
      var tx = new Tx(), s = tx.get('suppliers', id), before = clone(cur);
      ['name', 'phone', 'city', 'notes'].forEach(function (k) { if (patch[k] !== undefined) s[k] = str(patch[k]); });
      if (patch.active !== undefined) s.active = !!patch.active;
      s.updatedAt = now();
      audit(tx, 'supplier', id, 'update', before, s, ctx);
      return { supplier: s, changes: tx.commit() };
    }

    // ---------- products ----------
    function findProductBySku(sku) { var id = IX.sku[normSku(sku)]; return id ? S.products[id] || null : null; }
    // Accepts: internal QR "AY:<id>", public QR URL ".../p/<publicCode>" or "AYP:<code>", factory barcode.
    function parseCode(code) {
      code = normCode(code); if (!code) return null;
      if (code.indexOf('AY:') === 0) return { kind: 'internal', value: code.slice(3) };
      if (code.indexOf('AYP:') === 0) return { kind: 'public', value: code.slice(4) };
      var m = /\/p\/([23456789A-Z]{10})\/?(?:[?#].*)?$/i.exec(code);
      if (m && /^https?:\/\//i.test(code)) return { kind: 'public', value: m[1].toUpperCase() };
      return { kind: 'barcode', value: code };
    }
    function findProductByCode(code) {
      var c = parseCode(code); if (!c) return null;
      if (c.kind === 'internal') return S.products[c.value] || null;
      if (c.kind === 'public') { var id = IX.pub[c.value]; return id ? S.products[id] || null : null; }
      var pid = S.meta.barcodes && S.meta.barcodes.v[c.value];
      return pid ? S.products[pid] || null : null;
    }
    /* Product search (read-only). Covers name, brand, short name, SKU, factory barcodes, model/vehicle, family,
       custom technical attributes and the full group path. ALL words must match (in any of these fields).
       Ranking: exact scanned code > exact SKU > SKU/barcode contains > words in name/brand > words elsewhere.
       Per-product index is cached by object identity + rev/updatedAt and rebuilt when the group tree changes. */
    var SRCH = { sig: null, map: null };
    function catSignature() { var s = ''; for (var k in S.categories) { var c = S.categories[k]; s += k + '\u0001' + c.name + '\u0001' + (c.parentId || '') + '\u0002'; } return s; }
    function searchEntry(p) {
      var t = SRCH.map.get(p);
      if (t && t.rev === p.rev && t.u === p.updatedAt) return t;
      var a = p.attrs || {}, path = p.categoryId && S.categories[p.categoryId] ? categoryPath(p.categoryId).join(' ') : (p.category || '');
      t = { rev: p.rev, u: p.updatedAt, sku: normSku(p.sku), codes: (p.barcodes || []).map(normSku),
        main: normText([p.name, p.brand, p.shortName].join(' ')),
        other: normText([p.model, p.family, path, (p.cars || []).join(' '), p.location, Object.keys(a).map(function (k) { return a[k]; }).join(' ')].join(' ')) };
      SRCH.map.set(p, t); return t;
    }
    function searchProducts(q, opts) {
      opts = opts || {};
      var sig = catSignature();
      if (sig !== SRCH.sig || !SRCH.map) { SRCH.sig = sig; SRCH.map = new WeakMap(); }
      var raw = String(q == null ? '' : q).trim(), n = normText(raw), ns = normSku(raw), toks = n ? n.split(' ') : [];
      var all = Object.keys(S.products).map(function (k) { return S.products[k]; }).filter(function (p) { return opts.includeInactive || p.active !== false; });
      var byName = function (a, b) { return a.name.localeCompare(b.name, 'fa'); };
      if (!n) return all.sort(byName);
      var exact = findProductByCode(raw), hits = [];
      all.forEach(function (p) {
        var t = searchEntry(p), sc = -1;
        if (exact && p.id === exact.id) sc = 0;
        else if (ns && t.sku === ns) sc = 1;
        else if (ns && (t.sku.indexOf(ns) >= 0 || t.codes.some(function (c) { return c.indexOf(ns) >= 0; }))) sc = 2;
        else if (toks.every(function (w) { return t.main.indexOf(w) >= 0; })) sc = 3;
        else if (toks.every(function (w) { return t.main.indexOf(w) >= 0 || t.other.indexOf(w) >= 0 || t.sku.indexOf(w) >= 0; })) sc = 4;
        if (sc >= 0) hits.push([sc, p]);
      });
      return hits.sort(function (a, b) { return a[0] - b[0] || byName(a[1], b[1]); }).map(function (x) { return x[1]; });
    }
    /* Import helper (read-only): map a category text from a file to the group tree WITHOUT guessing.
       Accepts a single name or a path ("الف › ب", "الف > ب", "الف / ب"). Only active groups match.
       status: exact (one match) | ambiguous (several groups with this name) | none | empty */
    function resolveCategoryText(text) {
      var rawT = String(text == null ? '' : text).trim();
      if (!normText(rawT)) return { status: 'empty', text: rawT, candidates: [], suggestions: [] };
      var act = Object.keys(S.categories).map(function (k) { return S.categories[k]; }).filter(function (c) { return c.active !== false; });
      var pathOf = function (c) { return categoryPath(c.id).map(normText); };
      var parts = rawT.split(/\s*[›>\/\\|]\s*/).map(normText).filter(Boolean), n = normText(rawT), found = [];
      if (parts.length > 1) found = act.filter(function (c) { var pp = pathOf(c); return pp.length === parts.length && pp.every(function (x, i) { return x === parts[i]; }); });
      if (!found.length) found = act.filter(function (c) { return normText(c.name) === n; }); // whole text as one name (names may contain "/")
      var ids = found.map(function (c) { return c.id; });
      var res = { text: rawT, candidates: ids, suggestions: [] };
      if (ids.length === 1) { res.status = 'exact'; res.id = ids[0]; return res; }
      if (ids.length > 1) { res.status = 'ambiguous'; return res; }
      var last = parts[parts.length - 1] || n;
      res.status = 'none';
      res.suggestions = act.filter(function (c) { var cn = normText(c.name); return last.length >= 2 && (cn.indexOf(last) >= 0 || last.indexOf(cn) >= 0); }).map(function (c) { return c.id; }).slice(0, 5);
      return res;
    }
    function findDuplicates(p) {
      var out = [], bySku = p.sku ? findProductBySku(p.sku) : null;
      if (bySku) out.push({ kind: 'sku', product: bySku });
      if (normText(p.name)) (IX.nb[nbKey(p)] || []).forEach(function (id) { if (!bySku || id !== bySku.id) out.push({ kind: 'name_brand', product: S.products[id] }); });
      return out;
    }
    function validateProductFields(p) {
      if (!normText(p.name)) throw AppError('BAD_INPUT', 'نام کالا الزامی است.');
      if (!normSku(p.sku)) throw AppError('BAD_INPUT', 'کد داخلی (SKU) الزامی است.');
      if (/^(AY|AYP):/i.test(str(p.sku))) throw AppError('BAD_INPUT', 'کد داخلی نباید با AY: شروع شود.');
      ['buyPrice', 'sellPrice'].forEach(function (k) {
        if (p[k] != null && p[k] !== '' && !isMoney(p[k])) throw AppError('BAD_INPUT', 'قیمت باید عدد صحیح غیرمنفی باشد.');
      });
      if (p.packSize != null && !(Number.isSafeInteger(p.packSize) && p.packSize >= 1)) throw AppError('BAD_INPUT', 'تعداد در بسته باید عدد صحیح ۱ یا بیشتر باشد.');
      if (p.minStock != null && !(Number.isSafeInteger(p.minStock) && p.minStock >= 0)) throw AppError('BAD_INPUT', 'حداقل موجودی نامعتبر است.');
      if (p.warrantyMonths != null && p.warrantyMonths !== '' && !(Number.isSafeInteger(p.warrantyMonths) && p.warrantyMonths >= 0)) throw AppError('BAD_INPUT', 'مدت گارانتی نامعتبر است.');
      if (p.categoryId && !S.categories[p.categoryId]) throw AppError('NOT_FOUND', 'گروه کالا پیدا نشد.');
      if (p.supplierId && !S.suppliers[p.supplierId]) throw AppError('NOT_FOUND', 'تأمین‌کننده پیدا نشد.');
      ['boxQty', 'cartonQty'].forEach(function (k) { // v2.2: pieces in a box / in the master carton (prices stay per piece)
        if (p[k] != null && p[k] !== '' && !(Number.isSafeInteger(p[k]) && p[k] >= 1 && p[k] <= 9999)) throw AppError('BAD_INPUT', (k === 'boxQty' ? 'تعداد در جعبه' : 'تعداد در کارتن') + ' باید عدد صحیح ۱ تا ۹۹۹۹ باشد.');
      });
      if (p.cars != null) { // v2.3: the cars a part fits (one part often fits several cars); a separate attribute, not a group
        if (!Array.isArray(p.cars) || p.cars.length > 30 || p.cars.some(function (c) { return typeof c !== 'string' || str(c).length > 40; })) throw AppError('BAD_INPUT', 'فهرست خودروها نامعتبر است.');
      }
      if (p.barcodeQty != null) { // v2.2: pieces added by one scan of a factory barcode (a box of 2 -> 2)
        if (typeof p.barcodeQty !== 'object' || Array.isArray(p.barcodeQty)) throw AppError('BAD_INPUT', 'تعداد هر اسکن نامعتبر است.');
        Object.keys(p.barcodeQty).forEach(function (c) { var n = p.barcodeQty[c]; if (!(Number.isSafeInteger(n) && n >= 1 && n <= 9999)) throw AppError('BAD_INPUT', 'تعداد هر اسکن بارکد باید عدد صحیح ۱ تا ۹۹۹۹ باشد.'); });
      }
      if (p.prices != null) { // v2.2: sale price per price group (structure only; the sale form still uses sellPrice)
        if (typeof p.prices !== 'object' || Array.isArray(p.prices)) throw AppError('BAD_INPUT', 'قیمت‌های گروهی نامعتبر است.');
        var gs = priceGroupMap();
        Object.keys(p.prices).forEach(function (g) {
          if (!gs[g]) throw AppError('NOT_FOUND', 'گروه قیمت «' + g + '» تعریف نشده است.');
          if (p.prices[g] != null && !isMoney(p.prices[g])) throw AppError('BAD_INPUT', 'قیمت گروه «' + gs[g].name + '» باید عدد صحیح غیرمنفی باشد.');
        });
      }
    }
    function cleanQtyMap(m, codes) { var o = {}; Object.keys(m || {}).forEach(function (c) { var k = normCode(c); if (codes.indexOf(k) >= 0 && m[c] > 1) o[k] = m[c]; }); return o; }
    function cleanCars(a) { var o = [], seen = {}; (a || []).forEach(function (c) { var v = str(c), k = normText(v); if (v && !seen[k]) { seen[k] = 1; o.push(v); } }); return o; }
    function cleanPrices(m) { var o = {}; Object.keys(m || {}).forEach(function (g) { if (m[g] != null && m[g] !== '') o[g] = m[g]; }); return o; }
    // v2.2: how many units one scan of this code adds (internal / public QR and unknown codes: 1)
    function scanQty(product, code) { var k = normCode(code), m = product && product.barcodeQty; return m && Number.isSafeInteger(m[k]) && m[k] >= 1 ? m[k] : 1; }
    function cleanAttrs(attrs, categoryId) {
      var out = {}, defs = categoryId ? categoryAttrDefs(categoryId) : [], byKey = {};
      defs.forEach(function (d) { byKey[d.key] = d; });
      Object.keys(attrs || {}).forEach(function (k) {
        var v = attrs[k]; if (v == null || v === '') return;
        var d = byKey[k];
        if (d && d.type === 'number') { var n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-]/g, '')); if (!isFinite(n)) throw AppError('BAD_INPUT', '«' + d.label + '» باید عدد باشد.'); v = n; }
        else v = str(v);
        out[k] = v;
      });
      return out;
    }
    function uniquePublicCode(tx) {
      for (var i = 0; i < 50; i++) { var c = newPublic(); if (!IX.pub[c] && !Object.keys(tx.work.products).some(function (k) { return tx.work.products[k].publicCode === c; })) return c; }
      throw AppError('ID_CLASH', 'ساخت کد عمومی یکتا ممکن نشد.');
    }
    function createProduct(p, ctx) {
      validateProductFields(p);
      var dupSku = findProductBySku(p.sku);
      if (dupSku) throw AppError('DUP_SKU', 'این کد داخلی قبلاً برای «' + dupSku.name + '» ثبت شده است.', { productId: dupSku.id });
      var dups = findDuplicates(p).filter(function (d) { return d.kind === 'name_brand'; });
      if (dups.length && !p.allowDuplicate)
        throw AppError('DUP_NAME', 'کالایی با همین نام و برند وجود دارد: «' + dups[0].product.name + '». اگر متفاوت است تأیید کنید.', { productId: dups[0].product.id });
      var codes = (p.barcodes || []).map(normCode).filter(Boolean);
      var tx = new Tx();
      var rec = {
        id: tx.id('products'), sku: str(p.sku), name: str(p.name), shortName: str(p.shortName),
        brand: str(p.brand), model: str(p.model), family: str(p.family), categoryId: p.categoryId || null, category: '',
        unit: str(p.unit) || 'عدد', packSize: p.packSize || 1, minStock: p.minStock || 0,
        stock: 0, buyPrice: isMoney(p.buyPrice) ? p.buyPrice : null, sellPrice: isMoney(p.sellPrice) ? p.sellPrice : null,
        location: str(p.location), notes: str(p.notes), active: p.active !== false,
        supplierId: p.supplierId || null, warrantyMonths: Number.isSafeInteger(p.warrantyMonths) ? p.warrantyMonths : null,
        attrs: cleanAttrs(p.attrs, p.categoryId), publicCode: null,
        barcodes: [], layers: [], costBasis: 0, costedQty: 0, source: src(ctx, p), createdAt: now(), updatedAt: now()
      };
      rec.category = rec.categoryId ? categoryPath(rec.categoryId).join(' › ') : str(p.category);
      rec.publicCode = uniquePublicCode(tx);
      tx.insert('products', rec);
      var map = tx.get('meta', 'barcodes') || tx.put('meta', { id: 'barcodes', v: {} });
      codes.forEach(function (c) { attachCode(map, rec, c); });
      var bq = cleanQtyMap(p.barcodeQty, rec.barcodes); if (Object.keys(bq).length) rec.barcodeQty = bq;
      ['boxQty', 'cartonQty'].forEach(function (k) { if (Number.isSafeInteger(p[k]) && p[k] > 1) rec[k] = p[k]; });
      if (p.prices) { var pr = cleanPrices(p.prices); if (Object.keys(pr).length) rec.prices = pr; }
      if (p.cars) { var cs = cleanCars(p.cars); if (cs.length) rec.cars = cs; }
      audit(tx, 'product', rec.id, 'create', null, rec, ctx);
      return { product: rec, changes: tx.commit() };
    }
    function attachCode(map, product, code) {
      if (/^(AY|AYP):/i.test(code) || parseCode(code).kind === 'public') throw AppError('BAD_INPUT', 'این الگو برای QR داخلی/عمومی برنامه رزرو شده است.');
      var owner = map.v[code];
      if (owner && owner !== product.id) {
        var o = S.products[owner];
        throw AppError('DUP_BARCODE', 'این بارکد قبلاً به «' + (o ? o.name : owner) + '» متصل شده است.', { productId: owner });
      }
      map.v[code] = product.id;
      if (product.barcodes.indexOf(code) < 0) product.barcodes.push(code);
    }
    function mapBarcode(productId, code, ctx, o) { // o.qty (v2.2): units per scan of this code
      code = normCode(code); o = o || {};
      if (!code) throw AppError('BAD_INPUT', 'بارکد خالی است.');
      if (!S.products[productId]) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
      if (o.qty != null && !(Number.isSafeInteger(o.qty) && o.qty >= 1 && o.qty <= 9999)) throw AppError('BAD_INPUT', 'تعداد هر اسکن بارکد باید عدد صحیح ۱ تا ۹۹۹۹ باشد.');
      var tx = new Tx(), p = tx.get('products', productId), before = clone(S.products[productId]);
      var map = tx.get('meta', 'barcodes') || tx.put('meta', { id: 'barcodes', v: {} });
      attachCode(map, p, code); p.updatedAt = now();
      if (o.qty != null) { var bq = Object.assign({}, p.barcodeQty || {}); if (o.qty > 1) bq[code] = o.qty; else delete bq[code]; if (Object.keys(bq).length) p.barcodeQty = bq; else delete p.barcodeQty; }
      audit(tx, 'product', p.id, 'update', before, p, ctx);
      return { product: p, changes: tx.commit() };
    }
    function unmapBarcode(productId, code, ctx) {
      code = normCode(code);
      var cur = S.products[productId]; if (!cur) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
      if ((cur.barcodes || []).indexOf(code) < 0) throw AppError('NOT_FOUND', 'این بارکد برای این کالا ثبت نشده است.');
      var tx = new Tx(), p = tx.get('products', productId), before = clone(cur), map = tx.get('meta', 'barcodes');
      p.barcodes = p.barcodes.filter(function (b) { return b !== code; });
      if (map && map.v[code] === productId) delete map.v[code];
      if (p.barcodeQty && p.barcodeQty[code] != null) { delete p.barcodeQty[code]; if (!Object.keys(p.barcodeQty).length) delete p.barcodeQty; }
      p.updatedAt = now();
      audit(tx, 'product', p.id, 'update', before, p, ctx);
      return { product: p, changes: tx.commit() };
    }
    function updateProduct(id, patch, ctx) {
      var cur = S.products[id]; if (!cur) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
      if (patch.stock !== undefined) throw AppError('BAD_INPUT', 'موجودی مستقیم ویرایش نمی‌شود؛ از سند تعدیل استفاده کنید.');
      var merged = Object.assign({}, cur, patch);
      validateProductFields(merged);
      var other = findProductBySku(merged.sku);
      if (other && other.id !== id) throw AppError('DUP_SKU', 'این کد داخلی برای «' + other.name + '» ثبت شده است.');
      var tx = new Tx(), p = tx.get('products', id), before = clone(cur);
      ['sku', 'name', 'shortName', 'brand', 'model', 'family', 'unit', 'location', 'notes'].forEach(function (k) { if (patch[k] !== undefined) p[k] = str(patch[k]); });
      ['packSize', 'minStock'].forEach(function (k) { if (patch[k] !== undefined) p[k] = patch[k]; });
      ['buyPrice', 'sellPrice', 'warrantyMonths'].forEach(function (k) { if (patch[k] !== undefined) p[k] = (patch[k] === '' || patch[k] == null) ? null : patch[k]; });
      if (patch.categoryId !== undefined) p.categoryId = patch.categoryId || null;
      if (patch.supplierId !== undefined) p.supplierId = patch.supplierId || null;
      if (patch.categoryId !== undefined || patch.category !== undefined) p.category = p.categoryId ? categoryPath(p.categoryId).join(' › ') : str(patch.category !== undefined ? patch.category : p.category);
      if (patch.attrs !== undefined) p.attrs = cleanAttrs(patch.attrs, p.categoryId);
      if (patch.active !== undefined) p.active = !!patch.active;
      if (patch.barcodeQty !== undefined) { var bq = cleanQtyMap(patch.barcodeQty, p.barcodes || []); if (Object.keys(bq).length) p.barcodeQty = bq; else delete p.barcodeQty; }
      ['boxQty', 'cartonQty'].forEach(function (k) { if (patch[k] !== undefined) { if (Number.isSafeInteger(patch[k]) && patch[k] > 1) p[k] = patch[k]; else delete p[k]; } });
      if (patch.prices !== undefined) { var pr = cleanPrices(patch.prices); if (Object.keys(pr).length) p.prices = pr; else delete p.prices; }
      if (patch.cars !== undefined) { var cs = cleanCars(patch.cars); if (cs.length) p.cars = cs; else delete p.cars; }
      p.updatedAt = now();
      audit(tx, 'product', id, 'update', before, p, ctx, patch.reason ? { reason: str(patch.reason) } : null);
      return { product: p, changes: tx.commit() };
    }

    // ---------- customers ----------
    function findCustomerByPhone(phone) {
      var n = normPhone(phone); if (n.length < 7) return null;
      var id = IX.phone[n]; return id ? S.customers[id] || null : null;
    }
    function createCustomer(c, ctx) {
      if (!normText(c.name)) throw AppError('BAD_INPUT', 'نام مشتری الزامی است.');
      var dup = c.phone ? findCustomerByPhone(c.phone) : null;
      if (dup) throw AppError('DUP_CUSTOMER', 'مشتری با این شماره تلفن قبلاً ثبت شده: «' + dup.name + '».', { customerId: dup.id });
      var tx = new Tx();
      var rec = tx.insert('customers', { id: tx.id('customers'), name: str(c.name), phone: str(c.phone), type: CUSTOMER_TYPES[c.type] ? c.type : 'other',
        city: str(c.city), address: str(c.address), notes: str(c.notes), source: src(ctx, c), createdAt: now(), updatedAt: now() });
      audit(tx, 'customer', rec.id, 'create', null, rec, ctx);
      return { customer: rec, changes: tx.commit() };
    }
    function updateCustomer(id, patch, ctx) {
      var cur = S.customers[id]; if (!cur) throw AppError('NOT_FOUND', 'مشتری پیدا نشد.');
      var name = patch.name !== undefined ? patch.name : cur.name;
      if (!normText(name)) throw AppError('BAD_INPUT', 'نام مشتری الزامی است.');
      if (patch.phone !== undefined && patch.phone) {
        var dup = findCustomerByPhone(patch.phone);
        if (dup && dup.id !== id) throw AppError('DUP_CUSTOMER', 'این شماره برای «' + dup.name + '» ثبت شده است.', { customerId: dup.id });
      }
      var tx = new Tx(), c = tx.get('customers', id), before = clone(cur);
      ['name', 'phone', 'city', 'address', 'notes'].forEach(function (k) { if (patch[k] !== undefined) c[k] = str(patch[k]); });
      if (patch.type !== undefined) c.type = CUSTOMER_TYPES[patch.type] ? patch.type : 'other';
      if (patch.priceGroup !== undefined) { // v2.2 structure: the customer's price group (null = base sale price)
        if (patch.priceGroup && !priceGroupMap()[patch.priceGroup]) throw AppError('NOT_FOUND', 'گروه قیمت تعریف نشده است.');
        if (patch.priceGroup) c.priceGroup = patch.priceGroup; else delete c.priceGroup;
      }
      c.updatedAt = now();
      audit(tx, 'customer', id, 'update', before, c, ctx);
      return { customer: c, changes: tx.commit() };
    }

    // ---------- FIFO cost layers ----------
    /* layers: [{qty, cost|null, src, via}] oldest first. src = document that brought the unit in
       (receipt / adjustment), via = sales-return document if the unit came back from a customer.
       A sold line has a known cost ONLY if every unit it consumed had a known purchase cost. */
    function avgCost(p) { return p.costedQty > 0 ? Math.round(p.costBasis / p.costedQty) : null; }
    function ensureLayers(p) {
      if (Array.isArray(p.layers)) return p.layers;
      p.layers = [];
      var unk = p.stock - (p.costedQty || 0);
      if (unk > 0) p.layers.push({ qty: unk, cost: null, src: null });
      if (p.costedQty > 0) p.layers.push({ qty: p.costedQty, cost: Math.round(p.costBasis / p.costedQty), src: null });
      return p.layers;
    }
    function syncCost(p) {
      var b = 0, q = 0;
      p.layers.forEach(function (l) { if (l.cost != null) { b += l.cost * l.qty; q += l.qty; } });
      p.costBasis = b; p.costedQty = q;
    }
    function sameLayer(a, b) { return a && b && a.cost === b.cost && (a.src || null) === (b.src || null) && (a.via || null) === (b.via || null); }
    function addLayer(p, u, front) { // u: {qty, cost, src, via}
      var L = ensureLayers(p), edge = front ? L[0] : L[L.length - 1], item = { qty: u.qty, cost: u.cost == null ? null : u.cost, src: u.src || null };
      if (u.via) item.via = u.via;
      if (sameLayer(edge, item)) edge.qty += u.qty; else if (front) L.unshift(item); else L.push(item);
      syncCost(p);
    }
    function consumeFifo(p, qty) {
      var L = ensureLayers(p), left = qty, used = [], known = true, total = 0;
      while (left > 0 && L.length) {
        var l = L[0], take = Math.min(l.qty, left), u = { qty: take, cost: l.cost, src: l.src || null };
        if (l.via) u.via = l.via;
        used.push(u);
        if (l.cost == null) known = false; else total += l.cost * take;
        l.qty -= take; left -= take; if (l.qty === 0) L.shift();
      }
      if (left > 0) { used.push({ qty: left, cost: null, src: null }); known = false; } // only possible with allowNegative
      syncCost(p);
      return { used: used, known: known, costTotal: known ? total : null };
    }
    function layersQty(p, pred) { return ensureLayers(p).reduce(function (s, l) { return s + (pred(l) ? l.qty : 0); }, 0); }
    function removeLayers(p, pred, qty) { // remove qty units from layers matching pred (newest first); returns removed parts
      var L = ensureLayers(p), left = qty, removed = [];
      for (var i = L.length - 1; i >= 0 && left > 0; i--) {
        if (!pred(L[i])) continue;
        var take = Math.min(L[i].qty, left), r = { qty: take, cost: L[i].cost, src: L[i].src || null };
        if (L[i].via) r.via = L[i].via;
        removed.unshift(r); L[i].qty -= take; left -= take;
        if (L[i].qty === 0) L.splice(i, 1);
      }
      syncCost(p);
      return removed;
    }
    // units of a receipt line: first its own layers (by origin); for documents created before origin tracking
    // existed (schema v1), units of the same cost and unknown origin — cost-neutral, so valuation stays exact.
    function removeReceiptUnits(p, docId, line) {
      var got = removeLayers(p, function (x) { return x.src === docId && !x.via; }, line.qty).reduce(function (s, u) { return s + u.qty; }, 0);
      if (got < line.qty) {
        var uc = line.unitCost == null ? null : line.unitCost;
        got += removeLayers(p, function (x) { return x.src == null && !x.via && x.cost === uc; }, line.qty - got).reduce(function (s, u) { return s + u.qty; }, 0);
      }
      return got;
    }
    function takeFromEnd(parts, qty) { // split [{qty..}] list: last qty units removed and returned (in original order)
      var left = qty, taken = [];
      for (var i = parts.length - 1; i >= 0 && left > 0; i--) {
        var t = Math.min(parts[i].qty, left), piece = Object.assign({}, parts[i], { qty: t });
        taken.unshift(piece); parts[i].qty -= t; left -= t;
        if (parts[i].qty === 0) parts.splice(i, 1);
      }
      return taken;
    }
    function costOf(parts) { var t = 0; for (var i = 0; i < parts.length; i++) { if (parts[i].cost == null) return null; t += parts[i].cost * parts[i].qty; } return t; }

    function pushMovement(tx, p, doc, qtyDelta, kind, extra) {
      var m = Object.assign({
        id: tx.id('movements'), productId: p.id, docId: doc.id, docNo: doc.no, kind: kind, qty: qtyDelta,
        balanceAfter: p.stock, ts: doc.ts, createdAt: now(), user: doc.user
      }, extra || {});
      tx.insert('movements', m); return m;
    }
    function aggregateQty(items) {
      var agg = {};
      items.forEach(function (it) { agg[it.productId] = (agg[it.productId] || 0) + it.qty; });
      return agg;
    }
    function checkTs(ts) {
      if (ts == null) return now();
      if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) throw AppError('BAD_INPUT', 'تاریخ سند نامعتبر است.');
      if (ts > now() + 5 * 60 * 1000) throw AppError('BAD_INPUT', 'تاریخ سند نمی‌تواند در آینده باشد.');
      return ts;
    }
    // v2.1: every dated operation — period lock + soft lock (> 7 days back needs the manager when a user is acting)
    function assertOpen(ts, what) {
      var c = closedThrough();
      if (c != null && ts <= c) throw lockErr('تاریخ ' + what + ' (' + fmtD(ts) + ') در دوره مالی بسته‌شده (تا ' + fmtD(c) + ') است؛ با تاریخی بعد از آن ثبت کنید.', { ts: ts, closedThrough: c });
    }
    function assertBackdate(ts, ctx, what) {
      if (ctx && ctx.manager !== true && ts < now() - BACKDATE_DAYS * DAY_MS)
        throw AppError('BACKDATE_LIMIT', 'ثبت ' + what + ' با تاریخ بیش از ' + BACKDATE_DAYS + ' روز گذشته به تأیید مدیر نیاز دارد.', { ts: ts });
    }
    function docDate(tsIn, ctx, what) { var ts = checkTs(tsIn); assertOpen(ts, what); assertBackdate(ts, ctx, what); return ts; }
    /* actual payment date: its own field (default: now), never copied from the invoice date */
    function payDate(pm, docTs, ctx) {
      var ts = docDate(pm && pm.ts, ctx, 'پرداخت');
      if (docTs != null && dayKey(ts) < dayKey(docTs) && !(pm && pm.beforeInvoiceOk === true))
        throw AppError('PAY_BEFORE_INVOICE', 'تاریخ پرداخت (' + fmtD(ts) + ') پیش از تاریخ فاکتور (' + fmtD(docTs) + ') است؛ اگر درست است، آن را تأیید کنید.', { ts: ts, invoiceTs: docTs });
      return ts;
    }
    function notBefore(ts, refTs, msg) { if (ts < refTs - 5 * 60 * 1000) throw AppError('BAD_DATE', msg, { ts: ts, ref: refTs }); }

    // ---------- receipts (stock in) ----------
    function postReceipt(d, ctx) {
      checkOpKey(d.opKey);
      var ex = existingOp(d.opKey); if (ex) return ex;
      if (d.invoice) return postPurchaseInvoice(d, ctx); // v2.1 purchase invoice (optional fields; the old path below is unchanged)
      if (!RECEIPT_TYPES[d.type || 'purchase']) throw AppError('BAD_INPUT', 'نوع ورود نامعتبر است.');
      if (!d.items || !d.items.length) throw AppError('BAD_INPUT', 'هیچ کالایی برای ورود اضافه نشده است.');
      if (d.supplierId && !S.suppliers[d.supplierId]) throw AppError('NOT_FOUND', 'تأمین‌کننده پیدا نشد.');
      d.items.forEach(function (it) {
        if (!S.products[it.productId]) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
        if (!isQty(it.qty)) throw AppError('BAD_INPUT', 'تعداد ورود باید عدد صحیح مثبت باشد.');
        if (it.unitCost != null && it.unitCost !== '' && !isMoney(it.unitCost)) throw AppError('BAD_INPUT', 'قیمت خرید نامعتبر است.');
      });
      var ts = docDate(d.ts, ctx, 'ورود کالا');
      var type = d.type || 'purchase';
      var sup = d.supplierId ? S.suppliers[d.supplierId] : null;
      // v2.1.1: the quick receipt is a purchase path too — the same duplicate control as the purchase invoice
      var sdn = str(d.supplierDocNo), dupHit = [];
      if (sdn || (type === 'purchase' && (sup || normText(d.supplier)))) {
        var payT = 0; d.items.forEach(function (it) { payT = payT == null || !(isMoney(it.unitCost) && it.unitCost > 0) ? null : payT + it.unitCost * it.qty; });
        var dup = findPurchaseDuplicates({ supplierId: sup ? sup.id : null, supplier: sup ? '' : str(d.supplier), no: sdn, date: ts, payableT: payT });
        dupHit = dup.definite.concat(dup.probable);
        if (dupHit.length && !managerOk(d.duplicateOk, ctx))
          throw AppError('DUPLICATE_INVOICE', (dup.definite.length ? 'این فاکتور خرید قبلاً ثبت شده است' : 'فاکتور خرید مشابهی قبلاً ثبت شده است') + ' (' + dupHit.map(function (m) { return m.no + (m.supplierDocNo ? ' / ' + m.supplierDocNo : ''); }).join('، ') + '). ثبت دوباره فقط با تأیید صریح مدیر و ذکر علت.', dup);
      }
      var tx = new Tx();
      var doc = { id: tx.id('docs'), kind: 'in', type: type, no: 'IN-' + pad(counterNext(tx, 'in'), 6), ts: ts,
        supplierId: sup ? sup.id : null, supplier: sup ? sup.name : str(d.supplier), supplierDocNo: sdn, note: str(d.note),
        user: who(ctx), source: src(ctx, d), status: 'posted', opKey: d.opKey, lines: [], createdAt: now(), updatedAt: now() };
      if (dupHit.length) {
        doc.duplicateOverride = { reason: str(d.duplicateOk.reason), by: who(ctx), at: now(), matches: dupHit };
        audit(tx, 'purchase', doc.id, 'override', null, { duplicate: doc.duplicateOverride }, ctx);
      }
      d.items.forEach(function (it) {
        var p = tx.get('products', it.productId);
        p.stock += it.qty; p.updatedAt = now();
        var cost = isMoney(it.unitCost) && it.unitCost > 0 ? it.unitCost : null;
        addLayer(p, { qty: it.qty, cost: cost, src: doc.id }, false);
        if (cost != null) p.buyPrice = cost;
        doc.lines.push({ productId: p.id, sku: p.sku, name: p.name, brand: p.brand, qty: it.qty, unitCost: cost });
        pushMovement(tx, p, doc, it.qty, type === 'initial' ? 'initial' : 'in', { unitCost: cost });
      });
      tx.insert('docs', doc);
      tx.insert('ops', { id: d.opKey, docId: doc.id });
      return { duplicate: false, docId: doc.id, doc: doc, changes: tx.commit() };
    }

    // ---------- v2.1 purchase invoice (Phase A): invoice price, line/invoice discount, charges & VAT kept apart ----------
    var CHARGE_TYPES = { freight: 'حمل', vat: 'مالیات بر ارزش افزوده', other: 'سایر هزینه‌ها' };
    var CHARGE_TREAT = { capitalize: 'سرشکن در بهای کالا', separate: 'جدا از بهای کالا' };
    var CHARGE_BASIS = { value: 'به نسبت مبلغ اقلام', qty: 'به نسبت تعداد', manual: 'دستی' };
    function receiptPayable(d) { // Toman; null when unknown (legacy receipts without cost)
      if (d.invoice && d.invoice.payableT != null) return d.invoice.payableT;
      var s = 0; for (var i = 0; i < d.lines.length; i++) { var l = d.lines[i]; if (l.unitCost == null) return null; s += l.unitCost * l.qty; }
      return s;
    }
    /* q: {supplierId, supplier (text, legacy), no, date, payableT, excludeId}. Read-only.
       definite = same supplier + same STRICT number; probable = same supplier + same SIMILAR number, or same invoice day + same amount.
       Reversed receipts are only warnings (re-entering a cancelled invoice is normal). */
    function findPurchaseDuplicates(q) {
      q = q || {};
      var sup = q.supplierId ? S.suppliers[q.supplierId] : null, supName = sup ? normText(sup.name) : normText(q.supplier);
      var ks = invKeyStrict(q.no), kl = invKeySimilar(q.no), out = { definite: [], probable: [], reversed: [] };
      var anySup = !q.supplierId && !supName; // v2.1.1: no supplier given (quick receipt) -> the same number at ANY supplier is a probable duplicate
      Object.keys(S.docs).forEach(function (k) {
        var d = S.docs[k]; if (d.kind !== 'in' || d.id === q.excludeId) return;
        var same = anySup || (q.supplierId && d.supplierId ? d.supplierId === q.supplierId : (!d.supplierId && !!supName && normText(d.supplier) === supName));
        if (!same) return;
        var dno = d.invoice ? d.invoice.no : d.supplierDocNo, why = null;
        if (ks && invKeyStrict(dno) === ks) why = anySup ? 'strict_any_supplier' : 'strict';
        else if (kl && invKeySimilar(dno) === kl) why = 'similar';
        else if (!anySup && q.date != null && q.payableT != null) {
          var dd = d.invoice && d.invoice.date != null ? d.invoice.date : d.ts;
          if (dayKey(dd) === dayKey(q.date) && receiptPayable(d) === q.payableT) why = 'date_amount';
        }
        if (!why) return;
        var info = { docId: d.id, no: d.no, supplierDocNo: dno || '', ts: d.ts, why: why, status: d.status };
        if (d.status === 'reversed') out.reversed.push(info); else if (why === 'strict') out.definite.push(info); else out.probable.push(info);
      });
      return out;
    }
    function lineErr(i, msg) { return AppError('BAD_INPUT', 'ردیف ' + (i + 1) + ': ' + msg, { line: i }); }
    /* Pure calculation shared by the purchase screen (preview) and posting, so both always agree.
       All amounts in the invoice currency are integers; conversion to Toman happens last. */
    function computePurchase(d) {
      var inv = d.invoice || {}, cur = inv.currency === 'rial' ? 'rial' : 'toman', items = d.items || [];
      if (!items.length) throw AppError('BAD_INPUT', 'هیچ کالایی در فاکتور نیست.');
      var L = items.map(function (it, i) {
        var qty = it.qty, up = it.unitPrice, ld = it.lineDiscount == null || it.lineDiscount === '' ? 0 : it.lineDiscount;
        if (!isQty(qty)) throw lineErr(i, 'تعداد باید عدد صحیح مثبت باشد.');
        if (!isMoney(up)) throw lineErr(i, 'فی خرید باید عدد صحیح غیرمنفی باشد.');
        if (!isMoney(ld) || ld > qty * up) throw lineErr(i, 'تخفیف ردیف نامعتبر یا بیشتر از مبلغ ردیف است.');
        if (!Number.isSafeInteger(qty * up)) throw lineErr(i, 'مبلغ ردیف بیش از حد بزرگ است.');
        return { qty: qty, unitPrice: up, lineDiscount: ld, gross: qty * up, lineNet: qty * up - ld };
      });
      var nets = L.map(function (l) { return l.lineNet; }), qtys = L.map(function (l) { return l.qty; });
      var subtotal = nets.reduce(function (s, x) { return s + x; }, 0);
      var disc = inv.discount == null || inv.discount === '' ? 0 : inv.discount;
      if (!isMoney(disc) || disc > subtotal) throw AppError('BAD_INPUT', 'تخفیف کلی فاکتور نامعتبر یا بیشتر از جمع اقلام است.');
      var alloc = inv.discountAlloc === 'manual' ? 'manual' : 'value', ds;
      if (alloc === 'manual') {
        ds = inv.discountManual;
        if (!Array.isArray(ds) || ds.length !== L.length) throw AppError('BAD_INPUT', 'تخصیص دستی تخفیف کلی باید برای همه ردیف‌ها تعیین شود.');
        ds.forEach(function (x, i) { if (!isMoney(x) || x > L[i].lineNet) throw lineErr(i, 'سهم تخفیف کلی نامعتبر یا بیشتر از مبلغ خالص ردیف است.'); });
        if (ds.reduce(function (s, x) { return s + x; }, 0) !== disc) throw AppError('ALLOC_SUM', 'جمع سهم‌های دستی تخفیف کلی با تخفیف کلی برابر نیست.');
      } else ds = allocate(disc, nets);
      var charges = (inv.charges || []).map(function (c, ci) {
        if (!CHARGE_TYPES[c.type]) throw AppError('BAD_INPUT', 'نوع هزینه نامعتبر است.');
        if (!isMoney(c.amount) || c.amount === 0) throw AppError('BAD_INPUT', 'مبلغ «' + CHARGE_TYPES[c.type] + '» نامعتبر است.');
        if (!CHARGE_TREAT[c.treatment]) {
          if (c.type === 'vat') throw AppError('NEED_TAX_CHOICE', 'روش اعمال مالیات بر ارزش افزوده را برای همین فاکتور صریحاً انتخاب کنید: «سرشکن در بهای کالا» یا «جدا از بهای کالا».');
          throw AppError('BAD_INPUT', 'روش اعمال «' + CHARGE_TYPES[c.type] + '» مشخص نیست.');
        }
        var basis = CHARGE_BASIS[c.basis] ? c.basis : 'value', sh;
        if (basis === 'manual') {
          sh = c.manual;
          if (!Array.isArray(sh) || sh.length !== L.length || sh.some(function (x) { return !isMoney(x); })) throw AppError('BAD_INPUT', 'سهم دستی «' + CHARGE_TYPES[c.type] + '» باید برای همه ردیف‌ها عدد صحیح باشد.');
          if (sh.reduce(function (s, x) { return s + x; }, 0) !== c.amount) throw AppError('ALLOC_SUM', 'جمع سهم‌های دستی «' + CHARGE_TYPES[c.type] + '» با مبلغ آن برابر نیست.');
        } else {
          sh = allocExact(c.amount, basis === 'qty' ? qtys : nets);
          if (!sh) throw AppError('BAD_INPUT', 'سرشکن «' + CHARGE_TYPES[c.type] + '» به نسبت مبلغ ممکن نیست (جمع اقلام صفر است)؛ مبنای دیگری انتخاب کنید.');
        }
        return { type: c.type, label: str(c.label) || CHARGE_TYPES[c.type], amount: c.amount, treatment: c.treatment, basis: basis, shares: sh, choiceSource: c.choiceSource === 'default' ? 'default' : 'invoice' };
      });
      L.forEach(function (l, i) {
        l.invDisc = ds[i];
        l.charges = charges.map(function (c) { return c.shares[i]; });
        l.capitalized = charges.reduce(function (s, c) { return s + (c.treatment === 'capitalize' ? c.shares[i] : 0); }, 0);
        l.costCur = l.lineNet - l.invDisc + l.capitalized;
        if (l.costCur < 0) throw lineErr(i, 'بهای خالص منفی شد.');
      });
      var chargesTotal = charges.reduce(function (s, c) { return s + c.amount; }, 0);
      var separate = charges.reduce(function (s, c) { return s + (c.treatment === 'separate' ? c.amount : 0); }, 0);
      var payable = subtotal - disc + chargesTotal, costsCur = L.map(function (l) { return l.costCur; });
      var costT, sepT, payT;
      if (cur === 'rial') {
        var totR = costsCur.reduce(function (s, x) { return s + x; }, 0);
        costT = allocExact(Math.round(totR / 10), costsCur) || costsCur.map(function () { return 0; });
        sepT = Math.round(separate / 10); payT = Math.round(payable / 10);
      } else { costT = costsCur; sepT = separate; payT = payable; }
      L.forEach(function (l, i) {
        l.costTotal = costT[i]; l.unitCost = Math.round(costT[i] / l.qty);
        var base = Math.floor(costT[i] / l.qty), r = costT[i] - base * l.qty;
        l.layers = r ? [{ qty: l.qty - r, cost: base }, { qty: r, cost: base + 1 }] : [{ qty: l.qty, cost: base }];
      });
      var costTotalT = costT.reduce(function (s, x) { return s + x; }, 0);
      var dec = inv.declared || {}, mismatch = [];
      if (dec.subtotal != null && dec.subtotal !== '' && dec.subtotal !== subtotal) mismatch.push({ field: 'subtotal', declared: dec.subtotal, computed: subtotal });
      if (dec.payable != null && dec.payable !== '' && dec.payable !== payable) mismatch.push({ field: 'payable', declared: dec.payable, computed: payable });
      return { currency: cur, lines: L, subtotal: subtotal, discount: disc, discountAlloc: alloc, charges: charges, chargesTotal: chargesTotal, separate: separate, payable: payable,
        payableT: payT, separateT: sepT, costTotalT: costTotalT, roundingDiffT: payT - (costTotalT + sepT), mismatch: mismatch };
    }
    function managerOk(o, ctx) { return !!(o && normText(o.reason) && ctx && ctx.manager === true); }
    function postPurchaseInvoice(d, ctx) {
      var inv = d.invoice;
      if (!d.supplierId || !S.suppliers[d.supplierId]) throw AppError('NEED_SUPPLIER', 'برای فاکتور خرید، تأمین‌کننده ثبت‌شده را انتخاب کنید.');
      if (!d.items || !d.items.length) throw AppError('BAD_INPUT', 'هیچ کالایی برای ورود اضافه نشده است.');
      d.items.forEach(function (it, i) { if (!S.products[it.productId]) throw lineErr(i, 'کالا پیدا نشد.'); });
      var noRaw = str(inv.no);
      if (!noRaw && !managerOk(inv.noNumberOk, ctx)) throw AppError('NEED_INVOICE_NO', 'شماره فاکتور تأمین‌کننده الزامی است؛ ثبت بدون شماره فقط با تأیید مدیر و ذکر علت ممکن است.');
      if (inv.date != null && !(typeof inv.date === 'number' && isFinite(inv.date) && inv.date > 0 && inv.date <= now() + 5 * 60 * 1000)) throw AppError('BAD_INPUT', 'تاریخ فاکتور نامعتبر است.');
      var ts = docDate(d.ts, ctx, 'دریافت کالا');
      var c = computePurchase(d);
      if (c.mismatch.length && !managerOk(inv.mismatchOk, ctx))
        throw AppError('TOTAL_MISMATCH', 'جمع محاسبه‌شده با جمع اعلامی فاکتور برابر نیست (' + c.mismatch.map(function (m) { return (m.field === 'payable' ? 'قابل پرداخت' : 'جمع اقلام') + ': اعلامی ' + m.declared + '، محاسبه‌شده ' + m.computed; }).join('؛ ') + '). ثبت فقط با تأیید مدیر و ذکر علت.', { mismatch: c.mismatch });
      var dup = findPurchaseDuplicates({ supplierId: d.supplierId, no: noRaw, date: inv.date != null ? inv.date : ts, payableT: c.payableT });
      var dupHit = dup.definite.concat(dup.probable);
      if (dupHit.length && !managerOk(inv.duplicateOk, ctx))
        throw AppError('DUPLICATE_INVOICE', (dup.definite.length ? 'این فاکتور قبلاً ثبت شده است' : 'فاکتور مشابهی قبلاً ثبت شده است') + ' (' + dupHit.map(function (m) { return m.no + (m.supplierDocNo ? ' / ' + m.supplierDocNo : ''); }).join('، ') + '). ثبت دوباره فقط با تأیید صریح مدیر و ذکر علت.', dup);
      var tx = new Tx(), sup = S.suppliers[d.supplierId], at = now(), by = who(ctx), dec = inv.declared || {};
      var doc = { id: tx.id('docs'), kind: 'in', type: 'purchase', no: 'IN-' + pad(counterNext(tx, 'in'), 6), ts: ts,
        supplierId: sup.id, supplier: sup.name, supplierDocNo: noRaw, note: str(d.note), user: by, source: src(ctx, d), status: 'posted', opKey: d.opKey, lines: [], createdAt: at, updatedAt: at };
      doc.invoice = { v: 1, no: noRaw, keyStrict: invKeyStrict(noRaw), keySimilar: invKeySimilar(noRaw), date: inv.date != null ? inv.date : null, currency: c.currency,
        declared: { subtotal: dec.subtotal != null && dec.subtotal !== '' ? dec.subtotal : null, payable: dec.payable != null && dec.payable !== '' ? dec.payable : null },
        computed: { subtotal: c.subtotal, discount: c.discount, charges: c.chargesTotal, separate: c.separate, payable: c.payable },
        payableT: c.payableT, separateT: c.separateT, costTotalT: c.costTotalT, roundingDiffT: c.roundingDiffT, discountAlloc: c.discountAlloc,
        charges: c.charges.map(function (ch) { return { type: ch.type, label: ch.label, amount: ch.amount, treatment: ch.treatment, basis: ch.basis, choiceSource: ch.choiceSource, chosenBy: by, chosenAt: at }; }),
        mismatch: c.mismatch.length ? { items: c.mismatch, reason: str(inv.mismatchOk.reason), by: by, at: at } : null,
        duplicateOverride: dupHit.length ? { reason: str(inv.duplicateOk.reason), by: by, at: at, matches: dupHit } : null,
        duplicateWarnings: dup.reversed.length ? dup.reversed : null,
        noNumber: noRaw ? null : { reason: str(inv.noNumberOk.reason), by: by, at: at },
        importFile: inv.importFile ? { name: str(inv.importFile.name), sha256: str(inv.importFile.sha256) } : null,
        confirmedBy: by, confirmedAt: at };
      d.items.forEach(function (it, i) {
        var l = c.lines[i], p = tx.get('products', it.productId);
        p.stock += l.qty; p.updatedAt = at;
        l.layers.forEach(function (u) { addLayer(p, { qty: u.qty, cost: u.cost, src: doc.id }, false); });
        p.buyPrice = l.unitCost; // last purchase price = net unit cost; the sale price is never changed here
        doc.lines.push({ productId: p.id, sku: p.sku, name: p.name, brand: p.brand, qty: l.qty, unitCost: l.unitCost, costTotal: l.costTotal,
          unitPrice: l.unitPrice, lineDiscount: l.lineDiscount, lineNet: l.lineNet, invDisc: l.invDisc, charges: l.charges, match: str(it.match) || null });
        pushMovement(tx, p, doc, l.qty, 'in', { unitCost: l.unitCost });
      });
      tx.insert('docs', doc);
      tx.insert('ops', { id: d.opKey, docId: doc.id });
      if (doc.invoice.keyStrict) { // uniqueness marker: two windows posting the same invoice at once -> the second commit conflicts
        var base = 'pinv:' + sup.id + ':' + sha256Hex(doc.invoice.keyStrict).slice(0, 16) + ':', n = 0;
        while (S.ops[base + n]) n++;
        tx.insert('ops', { id: base + n, docId: doc.id });
      }
      if (doc.invoice.mismatch || doc.invoice.duplicateOverride || doc.invoice.noNumber)
        audit(tx, 'purchase', doc.id, 'override', null, { mismatch: doc.invoice.mismatch, duplicate: doc.invoice.duplicateOverride, noNumber: doc.invoice.noNumber }, ctx);
      return { duplicate: false, docId: doc.id, doc: doc, changes: tx.commit() };
    }

    // invoice discount split over lines by the largest-remainder method (Σ shares == discount exactly)
    function allocate(total, weights) {
      var sum = weights.reduce(function (s, w) { return s + w; }, 0), out = weights.map(function () { return 0; });
      if (!total || !sum) return out;
      var rem = total, fr = [];
      weights.forEach(function (w, i) { var exact = total * w / sum; out[i] = Math.floor(exact); rem -= out[i]; fr.push({ i: i, f: exact - out[i] }); });
      fr.sort(function (a, b) { return b.f - a.f || a.i - b.i; });
      for (var k = 0; rem > 0 && k < fr.length; k++) { if (weights[fr[k].i] > out[fr[k].i]) { out[fr[k].i]++; rem--; } }
      return out;
    }

    // ---------- issues (stock out; sales and non-sales) ----------
    function postIssue(d, ctx) {
      checkOpKey(d.opKey);
      var ex = existingOp(d.opKey); if (ex) return ex;
      var type = d.type || SALE;
      if (!ISSUE_TYPES[type]) throw AppError('BAD_INPUT', 'نوع خروج نامعتبر است.');
      if (!d.items || !d.items.length) throw AppError('BAD_INPUT', 'هیچ کالایی برای خروج اضافه نشده است.');
      var isSale = type === SALE;
      if (isSale && (!d.customerId || !S.customers[d.customerId])) throw AppError('NEED_CUSTOMER', 'برای فروش باید مشتری انتخاب شود.');
      d.items.forEach(function (it) {
        if (!S.products[it.productId]) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
        if (!isQty(it.qty)) throw AppError('BAD_INPUT', 'تعداد خروج باید عدد صحیح مثبت باشد.');
        if (isSale) {
          if (!isMoney(it.unitPrice)) throw AppError('BAD_INPUT', 'قیمت فروش هر قلم الزامی و باید عدد صحیح باشد.');
          if (it.discount != null && !isMoney(it.discount)) throw AppError('BAD_INPUT', 'تخفیف قلم نامعتبر است.');
          if ((it.discount || 0) > it.qty * it.unitPrice) throw AppError('BAD_INPUT', 'تخفیف قلم از مبلغ آن بیشتر است.');
        }
      });
      if (d.dueDate != null && !(typeof d.dueDate === 'number' && isFinite(d.dueDate))) throw AppError('BAD_INPUT', 'تاریخ سررسید نامعتبر است.');
      var ts = docDate(d.ts, ctx, isSale ? 'فاکتور' : 'خروج کالا');
      var tx = new Tx();
      var agg = aggregateQty(d.items), negative = false;
      Object.keys(agg).forEach(function (pid) {
        var p = S.products[pid];
        if (p.stock < agg[pid]) {
          if (!(settings().allowNegative && ctx && ctx.manager === true))
            throw AppError('NO_STOCK', 'موجودی «' + p.name + '» کافی نیست (موجودی: ' + p.stock + '، درخواست: ' + agg[pid] + ').', { productId: pid, stock: p.stock, requested: agg[pid] });
          negative = true;
        }
      });
      var doc = { id: tx.id('docs'), kind: 'out', type: type, no: 'OUT-' + pad(counterNext(tx, 'out'), 6), ts: ts,
        customerId: d.customerId || null, recipient: str(d.recipient), note: str(d.note), replaces: d.replaces || null,
        user: who(ctx), source: src(ctx, d), status: 'posted', opKey: d.opKey, lines: [], negativeStock: negative, createdAt: now(), updatedAt: now() };
      var sum = 0;
      d.items.forEach(function (it) {
        var p = tx.get('products', it.productId);
        var fifo = consumeFifo(p, it.qty);
        var cost = fifo.known ? Math.round(fifo.costTotal / it.qty) : null;
        var lineTotal = isSale ? it.qty * it.unitPrice - (it.discount || 0) : null;
        if (isSale) sum += lineTotal;
        p.stock -= it.qty; p.updatedAt = now();
        doc.lines.push({ productId: p.id, sku: p.sku, name: p.name, brand: p.brand, qty: it.qty,
          unitPrice: isSale ? it.unitPrice : null, discount: isSale ? (it.discount || 0) : null, lineTotal: lineTotal,
          unitCost: cost, costTotal: fifo.costTotal, layers: fifo.used });
        pushMovement(tx, p, doc, -it.qty, 'out', { reason: type });
      });
      if (isSale) {
        var dd = d.discount || 0;
        if (!isMoney(dd) || dd > sum) throw AppError('BAD_INPUT', 'تخفیف کل نامعتبر است.');
        var shares = allocate(dd, doc.lines.map(function (l) { return l.lineTotal; }));
        doc.lines.forEach(function (l, i) { l.invDisc = shares[i]; l.net = l.lineTotal - shares[i]; l.returnedQty = 0; l.returnedAmount = 0; l.returnedCost = 0; l.layersLeft = clone(l.layers); });
        doc.invoiceNo = 'INV-' + pad(counterNext(tx, 'inv'), 6);
        doc.subtotal = sum; doc.discount = dd; doc.total = sum - dd; doc.paid = 0; doc.refunded = 0; doc.returned = 0;
        doc.dueDate = d.dueDate || null;
        recalcSettlement(doc);
        var paySum = 0;
        var pays = (d.payments || []).map(function (pm) {
          if (!isMoney(pm.amount) || pm.amount === 0) throw AppError('BAD_INPUT', 'مبلغ پرداخت نامعتبر است.');
          if (!PAY_METHODS[pm.method] || pm.method === 'credit_transfer') throw AppError('BAD_INPUT', 'روش پرداخت نامعتبر است.');
          paySum += pm.amount;
          if (paySum > doc.total) throw AppError('OVERPAY', 'مجموع پرداخت از مبلغ فاکتور بیشتر است.');
          return Object.assign({}, pm, { ts: payDate(pm, ts, ctx) }); // actual payment date: its own (default now)
        });
        tx.insert('docs', doc);
        pays.forEach(function (pm) { applyPayment(tx, doc, pm, 'receipt', ctx); });
      } else {
        tx.insert('docs', doc);
      }
      tx.insert('ops', { id: d.opKey, docId: doc.id });
      return { duplicate: false, docId: doc.id, doc: doc, changes: tx.commit() };
    }

    // ---------- payments ----------
    function effectiveTotal(doc) { return doc.status === 'reversed' ? 0 : doc.total - (doc.returned || 0); }
    function recalcSettlement(doc) {
      doc.balance = effectiveTotal(doc) - (doc.paid - doc.refunded);
      if (doc.balance < 0) doc.settlement = 'credit';
      else if (doc.status === 'reversed') doc.settlement = 'settled';
      else doc.settlement = doc.balance === 0 ? 'settled' : (doc.paid - doc.refunded) > 0 ? 'partial' : 'unsettled';
    }
    function applyPayment(tx, doc, pm, kind, ctx, extra) {
      var rec = Object.assign({ id: tx.id('payments'), docId: doc.id, customerId: doc.customerId, kind: kind, amount: pm.amount, method: pm.method,
        ref: str(pm.ref), note: str(pm.note), ts: pm.ts || now(),
        no: 'PAY-' + pad(counterNext(tx, 'pay'), 6), user: who(ctx), source: src(ctx, pm), createdAt: now() }, extra || {});
      tx.insert('payments', rec);
      if (kind === 'receipt') doc.paid += pm.amount; else doc.refunded += pm.amount;
      doc.updatedAt = now();
      recalcSettlement(doc);
      return rec;
    }
    function saleDoc(id) { var d = S.docs[id]; return d && d.kind === 'out' && d.type === SALE ? d : null; }
    function addPayment(docId, pm, ctx) {
      checkOpKey(pm.opKey);
      var ex = existingOp(pm.opKey); if (ex) return ex;
      var cur = saleDoc(docId);
      if (!cur) throw AppError('NOT_FOUND', 'فاکتور فروش پیدا نشد.');
      if (!isMoney(pm.amount) || pm.amount === 0) throw AppError('BAD_INPUT', 'مبلغ باید عدد صحیح مثبت باشد.');
      if (!PAY_METHODS[pm.method] || pm.method === 'credit_transfer') throw AppError('BAD_INPUT', 'روش پرداخت نامعتبر است.');
      var kind = pm.kind || 'receipt';
      if (kind === 'receipt') {
        if (cur.status === 'reversed') throw AppError('REVERSED', 'این فاکتور برگشت خورده؛ دریافت جدید ممکن نیست.');
        if (pm.amount > cur.balance) throw AppError('OVERPAY', 'مبلغ از مانده بدهی (' + cur.balance + ') بیشتر است.', { balance: cur.balance });
      } else if (kind === 'refund') {
        requireManager(ctx, 'بازپرداخت وجه');
        if (cur.balance >= 0) throw AppError('BAD_INPUT', 'این فاکتور بستانکاری ندارد؛ بازپرداخت ممکن نیست.');
        if (pm.amount > -cur.balance) throw AppError('OVERPAY', 'مبلغ از بستانکاری مشتری (' + (-cur.balance) + ') بیشتر است.');
      } else throw AppError('BAD_INPUT', 'نوع پرداخت نامعتبر است.');
      var pts = payDate(pm, cur.ts, ctx);
      var tx = new Tx(), doc = tx.get('docs', docId);
      var rec = applyPayment(tx, doc, Object.assign({}, pm, { ts: pts }), kind, ctx);
      tx.insert('ops', { id: pm.opKey, docId: doc.id });
      return { duplicate: false, docId: doc.id, payment: rec, doc: doc, changes: tx.commit() };
    }
    // move a customer's credit (overpaid / returned invoice) to an unpaid invoice of the SAME customer; no cash moves
    function transferCredit(t, ctx) {
      checkOpKey(t.opKey);
      var ex = existingOp(t.opKey); if (ex) return ex;
      var from = saleDoc(t.fromDocId), to = saleDoc(t.toDocId);
      if (!from || !to) throw AppError('NOT_FOUND', 'فاکتور پیدا نشد.');
      if (from.id === to.id) throw AppError('BAD_INPUT', 'مبدأ و مقصد یکی است.');
      if (from.customerId !== to.customerId) throw AppError('BAD_INPUT', 'انتقال بستانکاری فقط بین فاکتورهای یک مشتری ممکن است.');
      if (!isMoney(t.amount) || t.amount === 0) throw AppError('BAD_INPUT', 'مبلغ نامعتبر است.');
      if (from.balance >= 0 || t.amount > -from.balance) throw AppError('OVERPAY', 'مبلغ از بستانکاری فاکتور مبدأ بیشتر است.');
      if (to.status === 'reversed' || t.amount > to.balance) throw AppError('OVERPAY', 'مبلغ از مانده بدهی فاکتور مقصد بیشتر است.');
      var tts = docDate(t.ts, ctx, 'انتقال بستانکاری');
      var tx = new Tx(), a = tx.get('docs', from.id), b = tx.get('docs', to.id), pair = tx.id('payments');
      var out = applyPayment(tx, a, { amount: t.amount, method: 'credit_transfer', note: 'انتقال به ' + to.invoiceNo, ts: tts }, 'refund', ctx, { pairId: pair, transferTo: to.id });
      var inn = applyPayment(tx, b, { amount: t.amount, method: 'credit_transfer', note: 'انتقال از ' + from.invoiceNo, ts: tts }, 'receipt', ctx, { pairId: pair, transferFrom: from.id });
      tx.insert('ops', { id: t.opKey, docId: b.id });
      return { duplicate: false, docId: b.id, payments: [out, inn], changes: tx.commit() };
    }

    // ---------- partial / full sales return linked to the invoice ----------
    /* items: [{line: index in invoice.lines, qty}]. Credit = proportional share of the line's NET amount
       (after line + invoice discount); the last unit returned takes the exact remainder, so the sum of
       returns never exceeds what was charged. Units come back with their original cost layers. */
    /* v2.1.1: the return state kept on an invoice line (returnedQty, returnedAmount, layersLeft) must agree with the
       ACTIVE return documents of that line; a new return is computed from it, so damaged values would move wrong
       units or costs into stock. Read-only; returns null when consistent, otherwise what disagrees. */
    function activeReturnsOf(invId) {
      return Object.keys(S.docs).map(function (k) { return S.docs[k]; }).filter(function (r) { return r.kind === 'return' && r.invoiceId === invId && r.status !== 'reversed'; });
    }
    function returnStateIssue(inv, li, rets) {
      var l = inv.lines[li], q = 0, a = 0, parts = [], partsKnown = true;
      rets.forEach(function (r) { (r.lines || []).forEach(function (rl) { if (rl.line !== li) return; q += rl.qty; a += rl.amount; if (Array.isArray(rl.layers)) parts = parts.concat(rl.layers); else partsKnown = false; }); });
      if ((l.returnedQty || 0) !== q) return 'تعداد مرجوع‌شده';
      if ((l.returnedAmount || 0) !== a) return 'مبلغ مرجوع‌شده';
      var base = l.layers || [{ qty: l.qty, cost: l.unitCost == null ? null : l.unitCost, src: null }], left = l.layersLeft || base;
      if (!Array.isArray(left) || left.some(function (u) { return !u || !isQty(u.qty) || (u.cost != null && !isMoney(u.cost)); })) return 'لایه‌های بهای باقی‌مانده';
      if (left.reduce(function (s, u) { return s + u.qty; }, 0) !== l.qty - q) return 'تعداد لایه‌های باقی‌مانده';
      if (partsKnown) { // layers left + layers of the active returns == layers the sale consumed (by cost and origin)
        var bal = {}, key = function (u) { return (u.cost == null ? 'n' : u.cost) + '|' + (u.src || ''); };
        base.forEach(function (u) { bal[key(u)] = (bal[key(u)] || 0) + u.qty; });
        left.concat(parts).forEach(function (u) { bal[key(u)] = (bal[key(u)] || 0) - u.qty; });
        if (Object.keys(bal).some(function (k) { return bal[k] !== 0; })) return 'بهای لایه‌های باقی‌مانده';
      }
      return null;
    }
    function postSaleReturn(invoiceId, d, ctx) {
      checkOpKey(d.opKey);
      var ex = existingOp(d.opKey); if (ex) return ex;
      requireManager(ctx, 'مرجوعی فروش');
      var inv = saleDoc(invoiceId);
      if (!inv) throw AppError('NOT_FOUND', 'فاکتور فروش پیدا نشد.');
      if (inv.status === 'reversed') throw AppError('REVERSED', 'این فاکتور برگشت خورده است.');
      if (!normText(d.reason)) throw AppError('BAD_INPUT', 'علت مرجوعی الزامی است.');
      if (!d.items || !d.items.length) throw AppError('BAD_INPUT', 'کالایی برای مرجوعی انتخاب نشده است.');
      var perLine = {}, rets = activeReturnsOf(inv.id);
      d.items.forEach(function (it) {
        var l = inv.lines[it.line];
        if (!l) throw AppError('BAD_INPUT', 'ردیف فاکتور نامعتبر است.');
        if (!isQty(it.qty)) throw AppError('BAD_INPUT', 'تعداد مرجوعی باید عدد صحیح مثبت باشد.');
        var bad = returnStateIssue(inv, it.line, rets);
        if (bad) throw AppError('RETURN_STATE', 'اطلاعات مرجوعی ردیف «' + l.name + '» در فاکتور ' + inv.invoiceNo + ' با اسناد مرجوعی آن سازگار نیست (' + bad + '). برای جلوگیری از اثر نادرست روی موجودی و بهای تمام‌شده، مرجوعی ثبت نشد؛ «بررسی سلامت» را ببینید.', { docId: inv.id, line: it.line });
        perLine[it.line] = (perLine[it.line] || 0) + it.qty;
        if (perLine[it.line] > l.qty - (l.returnedQty || 0)) throw AppError('TOO_MANY', 'تعداد مرجوعی «' + l.name + '» از تعداد فروخته‌شده باقی‌مانده (' + (l.qty - (l.returnedQty || 0)) + ') بیشتر است.');
      });
      var ts = docDate(d.ts, ctx, 'مرجوعی');
      notBefore(ts, inv.ts, 'تاریخ مرجوعی نمی‌تواند پیش از تاریخ فاکتور باشد.');
      var rts = d.refund && d.refund.amount > 0 ? docDate(d.refund.ts, ctx, 'بازپرداخت') : null;
      var tx = new Tx(), o = tx.get('docs', inv.id);
      var doc = { id: tx.id('docs'), kind: 'return', type: 'sale_return', no: 'RET-' + pad(counterNext(tx, 'ret'), 6), ts: ts,
        invoiceId: inv.id, invoiceNo: inv.invoiceNo, customerId: inv.customerId, reason: str(d.reason), note: str(d.note),
        user: who(ctx), source: src(ctx, d), status: 'posted', opKey: d.opKey, lines: [], total: 0, createdAt: now(), updatedAt: now() };
      Object.keys(perLine).map(Number).sort(function (a, b) { return a - b; }).forEach(function (li) {
        var l = o.lines[li], q = perLine[li], remaining = l.qty - (l.returnedQty || 0);
        var net = l.net != null ? l.net : l.lineTotal;
        var amount = q === remaining ? net - (l.returnedAmount || 0) : Math.round(net * q / l.qty);
        if (!l.layersLeft) l.layersLeft = clone(l.layers || [{ qty: l.qty, cost: l.unitCost, src: null }]);
        // v2.2: units whose receipt was completed later come back WITH that cost; the return keeps the original parts (origin
        // check of v2.1.1: layers left + returned parts == the parts the sale consumed)
        var raw = takeFromEnd(l.layersLeft, q), parts = resolveParts(raw, l.productId), cost = costOf(parts);
        l.returnedQty = (l.returnedQty || 0) + q; l.returnedAmount = (l.returnedAmount || 0) + amount;
        l.returnedCost = cost == null || l.returnedCost == null ? null : (l.returnedCost || 0) + cost;
        var p = tx.get('products', l.productId);
        p.stock += q; p.updatedAt = now();
        parts.slice().reverse().forEach(function (u) { addLayer(p, { qty: u.qty, cost: u.cost, src: u.src, via: doc.id }, true); });
        doc.lines.push({ line: li, productId: p.id, sku: l.sku, name: l.name, brand: l.brand, qty: q, amount: amount, costTotal: cost, layers: raw });
        doc.total += amount;
        pushMovement(tx, p, doc, q, 'return', { reason: doc.reason, invoiceNo: inv.invoiceNo });
      });
      o.returned = (o.returned || 0) + doc.total; o.updatedAt = now();
      recalcSettlement(o);
      tx.insert('docs', doc);
      var refund = null;
      if (d.refund && d.refund.amount > 0) {
        if (!PAY_METHODS[d.refund.method] || d.refund.method === 'credit_transfer') throw AppError('BAD_INPUT', 'روش بازپرداخت نامعتبر است.');
        if (o.balance >= 0 || d.refund.amount > -o.balance) throw AppError('OVERPAY', 'مبلغ بازپرداخت از بستانکاری مشتری بیشتر است.');
        refund = applyPayment(tx, o, { amount: d.refund.amount, method: d.refund.method, ref: d.refund.ref, note: 'بازپرداخت مرجوعی ' + doc.no, ts: rts }, 'refund', ctx, { returnId: doc.id });
      }
      tx.insert('ops', { id: d.opKey, docId: doc.id });
      return { duplicate: false, docId: doc.id, doc: doc, invoice: o, refund: refund, changes: tx.commit() };
    }

    // ---------- reversal (cancellation of an erroneous document) — original is never deleted ----------
    function reverseDoc(docId, d, ctx) {
      checkOpKey(d.opKey);
      var ex = existingOp(d.opKey); if (ex) return ex;
      requireManager(ctx, 'برگشت سند');
      var orig = S.docs[docId];
      if (!orig || ['out', 'in', 'return'].indexOf(orig.kind) < 0) throw AppError('NOT_FOUND', 'این سند قابل برگشت نیست.');
      if (orig.status === 'reversed') throw AppError('REVERSED', 'این سند قبلاً برگشت خورده است.');
      if (!normText(d.reason)) throw AppError('BAD_INPUT', 'علت برگشت الزامی است.');
      var cl = closedThrough();
      if (cl != null && orig.ts <= cl)
        throw lockErr('سند ' + (orig.invoiceNo || orig.no) + ' در دوره مالی بسته‌شده (تا ' + fmtD(cl) + ') است و لغو یا اصلاح آن ممکن نیست. اصلاح را با سند جبرانی در دوره باز انجام دهید (مرجوعی، مرجوعی به تأمین‌کننده، تعدیل یا فاکتور اصلاحی).', { docId: orig.id, closedThrough: cl });
      var rvTs = docDate(d.ts, ctx, 'سند برگشت');
      notBefore(rvTs, orig.ts, 'تاریخ سند برگشت نمی‌تواند پیش از تاریخ سند اصلی باشد.');
      if (orig.kind === 'out' && orig.type === SALE && (orig.lines.some(function (l) { return (l.returnedQty || 0) > 0; }) || activeReturnsOf(orig.id).length)) // v2.1.1: the return documents decide, not only the stored counter
        throw AppError('HAS_RETURNS', 'این فاکتور مرجوعی دارد؛ برای برگرداندن باقی اقلام از «مرجوعی» استفاده کنید.');
      // receipts / returns can be cancelled only while their units are still in stock (exact undo)
      if (orig.kind === 'in' || orig.kind === 'return') {
        var dry = {};
        orig.lines.forEach(function (l) {
          var p = dry[l.productId] || (dry[l.productId] = clone(S.products[l.productId]));
          var got = orig.kind === 'in' ? removeReceiptUnits(p, orig.id, l) : removeLayers(p, function (x) { return x.via === orig.id; }, l.qty).reduce(function (s, u) { return s + u.qty; }, 0);
          if (got < l.qty)
            throw AppError('CONSUMED', 'بخشی از کالای «' + p.name + '» در این سند بعداً خارج شده است؛ برگشت کامل ممکن نیست. برای اصلاح از «اصلاح موجودی» با ذکر علت استفاده کنید.', { productId: p.id });
        });
      }
      var tx = new Tx();
      var rev = { id: tx.id('docs'), kind: 'reversal', type: 'reversal', no: 'REV-' + pad(counterNext(tx, 'rev'), 6), ts: rvTs,
        reverses: orig.id, reversesNo: orig.no, reason: str(d.reason), customerId: orig.customerId || null,
        user: who(ctx), source: src(ctx, d), status: 'posted', opKey: d.opKey, lines: [], createdAt: now(), updatedAt: now() };
      orig.lines.forEach(function (l) {
        var p = tx.get('products', l.productId), q;
        if (orig.kind === 'out') {
          q = l.qty; p.stock += q;
          var back = resolveParts(l.layers || [{ qty: l.qty, cost: l.unitCost != null ? l.unitCost : null, src: null }], l.productId);
          back.slice().reverse().forEach(function (u) { addLayer(p, u, true); });
        } else if (orig.kind === 'in') {
          q = -l.qty; p.stock += q;
          removeReceiptUnits(p, orig.id, l);
        } else { // return: units go back out, the invoice line gets its sold units back
          q = -l.qty; p.stock += q;
          removeLayers(p, function (x) { return x.via === orig.id; }, l.qty);
        }
        p.updatedAt = now();
        rev.lines.push({ productId: p.id, sku: p.sku, name: p.name, brand: p.brand, qty: Math.abs(q) });
        pushMovement(tx, p, rev, q, 'reversal', { reverses: orig.no });
      });
      if (orig.kind === 'return') {
        var inv = tx.get('docs', orig.invoiceId);
        if (inv.status === 'reversed') throw AppError('REVERSED', 'فاکتور مربوط برگشت خورده است.');
        orig.lines.forEach(function (rl) {
          var l = inv.lines[rl.line];
          l.returnedQty -= rl.qty; l.returnedAmount -= rl.amount;
          if (l.returnedCost != null && rl.costTotal != null) l.returnedCost -= rl.costTotal; else if (l.returnedQty === 0) l.returnedCost = 0;
          (rl.layers || []).forEach(function (u) { var c = Object.assign({}, u); delete c.via; l.layersLeft.push(c); });
        });
        inv.returned -= orig.total; inv.updatedAt = now();
        recalcSettlement(inv);
      }
      var o = tx.get('docs', orig.id);
      o.status = 'reversed'; o.reversedBy = rev.id; o.reversedAt = now(); o.reverseReason = rev.reason; o.updatedAt = now();
      if (o.type === SALE) recalcSettlement(o);
      tx.insert('docs', rev);
      tx.insert('ops', { id: d.opKey, docId: rev.id });
      return { duplicate: false, docId: rev.id, doc: rev, changes: tx.commit() };
    }

    // ---------- adjustment ----------
    function adjustStock(productId, d, ctx) {
      checkOpKey(d.opKey);
      var ex = existingOp(d.opKey); if (ex) return ex;
      requireManager(ctx, 'تعدیل موجودی');
      var cur = S.products[productId]; if (!cur) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
      if (!normText(d.reason)) throw AppError('BAD_INPUT', 'علت تعدیل الزامی است.');
      if (!Number.isSafeInteger(d.newStock) || d.newStock < 0) throw AppError('BAD_INPUT', 'موجودی جدید باید عدد صحیح غیرمنفی باشد.');
      if (d.unitCost != null && d.unitCost !== '' && !isMoney(d.unitCost)) throw AppError('BAD_INPUT', 'بهای واحد نامعتبر است.');
      var delta = d.newStock - cur.stock;
      if (delta === 0) throw AppError('NO_CHANGE', 'موجودی جدید با موجودی فعلی برابر است.');
      var tx = new Tx(), p = tx.get('products', productId);
      var doc = { id: tx.id('docs'), kind: 'adjust', type: 'adjust', no: 'ADJ-' + pad(counterNext(tx, 'adj'), 6), ts: docDate(d.ts, ctx, 'تعدیل موجودی'),
        reason: str(d.reason), user: who(ctx), source: src(ctx, d), status: 'posted', opKey: d.opKey, createdAt: now(), updatedAt: now(),
        lines: [{ productId: p.id, sku: p.sku, name: p.name, brand: p.brand, before: p.stock, after: d.newStock, qty: delta }] };
      if (delta < 0) { var f = consumeFifo(p, -delta); doc.lines[0].layers = f.used; doc.lines[0].costTotal = f.costTotal; }
      else { var c = isMoney(d.unitCost) && d.unitCost > 0 ? d.unitCost : null; addLayer(p, { qty: delta, cost: c, src: doc.id }, false); doc.lines[0].unitCost = c; }
      p.stock = d.newStock; p.updatedAt = now();
      pushMovement(tx, p, doc, delta, 'adjust', { reason: doc.reason });
      tx.insert('docs', doc); tx.insert('ops', { id: d.opKey, docId: doc.id });
      return { duplicate: false, docId: doc.id, doc: doc, changes: tx.commit() };
    }


    // ======================= v2.2 =======================
    /* ---------- price groups (structure only): meta 'priceGroups' = [{id, name}]; product.prices = {groupId: price};
       customer.priceGroup. The base sale price stays product.sellPrice (group id 'base' is reserved for it). ---------- */
    function priceGroupMap() { var m = dict(), g = S.meta.priceGroups && S.meta.priceGroups.v; (Array.isArray(g) ? g : []).forEach(function (x) { m[x.id] = x; }); return m; }
    function priceGroups() { var g = S.meta.priceGroups && S.meta.priceGroups.v; return Array.isArray(g) ? clone(g) : []; }
    function setPriceGroups(groups, ctx) {
      requireManager(ctx, 'تعریف گروه‌های قیمت');
      if (!Array.isArray(groups)) throw AppError('BAD_INPUT', 'فهرست گروه‌های قیمت نامعتبر است.');
      var seen = dict(), out = groups.map(function (g) {
        var id = str(g.id), name = str(g.name);
        if (!/^[a-z0-9_]{1,24}$/.test(id) || id === 'base') throw AppError('BAD_INPUT', 'شناسه گروه قیمت نامعتبر است: ' + id);
        if (!normText(name)) throw AppError('BAD_INPUT', 'نام گروه قیمت الزامی است.');
        if (seen[id]) throw AppError('BAD_INPUT', 'شناسه گروه قیمت تکراری است: ' + id); seen[id] = 1;
        return { id: id, name: name };
      });
      var cur = priceGroupMap();
      Object.keys(cur).forEach(function (id) { // a group still used by a product or customer cannot disappear
        if (seen[id]) return;
        var used = Object.keys(S.products).some(function (k) { var pr = S.products[k].prices; return pr && pr[id] != null; }) || Object.keys(S.customers).some(function (k) { return S.customers[k].priceGroup === id; });
        if (used) throw AppError('IN_USE', 'گروه قیمت «' + cur[id].name + '» هنوز برای کالا یا مشتری استفاده شده است.');
      });
      var tx = new Tx(), before = priceGroups();
      tx.put('meta', { id: 'priceGroups', v: out, updatedAt: now() });
      audit(tx, 'settings', 'priceGroups', before.length ? 'update' : 'create', { groups: before }, { groups: out }, ctx);
      return { groups: out, changes: tx.commit() };
    }
    function priceFor(productId, customerId) { // the price the sale form WILL use when price groups get their screen
      var p = S.products[productId]; if (!p) return null;
      var c = customerId ? S.customers[customerId] : null, g = c && c.priceGroup;
      return g && p.prices && p.prices[g] != null ? p.prices[g] : p.sellPrice;
    }

    /* ---------- learned matches (offline "learning"): meta 'learn' = {a: {key: {p: productId, n: times, t: lastTs}}}.
       Keys are built by match.js (normalized text / code, optionally per supplier). The LATEST correction wins. ---------- */
    var LEARN_MAX = 6000;
    function learnedAll() { var m = S.meta.learn && S.meta.learn.v; return (m && m.a) || {}; }
    function learned(key) { var e = learnedAll()[key]; return e && S.products[e.p] ? { productId: e.p, n: e.n, t: e.t } : null; }
    // v2.3: a learned answer may also be a product GROUP (key «g:<part type>» -> categoryId), stored as {c}
    function learnedCategory(key) { var e = learnedAll()[key], c = e && e.c && S.categories[e.c]; return c && c.active !== false ? c.id : null; }
    function learn(entries, ctx) {
      entries = (entries || []).filter(function (e) { return e && str(e.key) && (e.categoryId ? !!S.categories[e.categoryId] : !!S.products[e.productId]); });
      if (!entries.length) return { changes: [] };
      var tx = new Tx(), m = tx.get('meta', 'learn') || tx.put('meta', { id: 'learn', v: { a: {} } }), a = m.v.a || (m.v.a = {}), t = now();
      entries.forEach(function (e) {
        var k = str(e.key).slice(0, 200), cur = a[k];
        if (e.categoryId) { a[k] = cur && cur.c === e.categoryId ? { c: e.categoryId, n: (cur.n || 1) + 1, t: t } : { c: e.categoryId, n: 1, t: t }; return; }
        a[k] = cur && cur.p === e.productId ? { p: e.productId, n: (cur.n || 1) + 1, t: t } : { p: e.productId, n: 1, t: t }; // a correction replaces the old answer
      });
      var keys = Object.keys(a);
      if (keys.length > LEARN_MAX) keys.sort(function (x, y) { return a[x].t - a[y].t; }).slice(0, keys.length - LEARN_MAX).forEach(function (k) { delete a[k]; });
      m.updatedAt = t;
      return { changes: tx.commit() };
    }
    // v2.2 visual memory of confirmed box-label photos: meta 'vis' = {p: {productId: [{h, c, t}] (newest last, max 4)}}
    var VIS_PER = 3, VIS_MAX = 1000; // ~1.6 KB per photo
    function visualMemory() { var m = S.meta.vis && S.meta.vis.v; var p = (m && m.p) || {}, out = {}; Object.keys(p).forEach(function (id) { if (S.products[id] && S.products[id].active !== false) out[id] = p[id]; }); return out; }
    function learnVisual(productId, fp, ctx) {
      if (!S.products[productId]) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
      if (!fp || typeof fp.h !== 'string' || typeof fp.c !== 'string' || fp.h.length > 2400 || fp.c.length > 100) throw AppError('BAD_INPUT', 'اثر تصویری نامعتبر است.');
      var tx = new Tx(), m = tx.get('meta', 'vis') || tx.put('meta', { id: 'vis', v: { p: {} } }), P = m.v.p || (m.v.p = {}), t = now();
      var L = (P[productId] || []).concat([{ h: fp.h, c: fp.c, t: t }]); P[productId] = L.slice(-VIS_PER);
      var ids = Object.keys(P);
      if (ids.length > VIS_MAX) ids.sort(function (a, b) { return P[a][P[a].length - 1].t - P[b][P[b].length - 1].t; }).slice(0, ids.length - VIS_MAX).forEach(function (k) { delete P[k]; });
      m.updatedAt = t;
      return { changes: tx.commit() };
    }
    function unlearn(keys, ctx) {
      var a = learnedAll(), hit = (keys || []).filter(function (k) { return a[k]; });
      if (!hit.length) return { changes: [] };
      var tx = new Tx(), m = tx.get('meta', 'learn');
      hit.forEach(function (k) { delete m.v.a[k]; }); m.updatedAt = now();
      return { changes: tx.commit() };
    }

    /* ---------- purchase price lists: meta 'plist:<id>' = {id, date, supplierId, name, currency, file, items: {productId: unitPrice (Toman)}}.
       Used for: (1) a receipt line without cost -> the price of a list dated within PLIST_DAYS BEFORE the receipt date,
       (2) completing the cost of earlier receipts posted without cost, (3) "today's price" (replacement cost). ---------- */
    var PLIST_DAYS = null; // v2.2.1: no age limit (owner's decision) — the nearest list is used
    function priceLists() {
      return Object.keys(S.meta).filter(function (k) { return k.indexOf('plist:') === 0 && S.meta[k].v; }).map(function (k) { return S.meta[k].v; })
        .sort(function (a, b) { return a.date - b.date || a.createdAt - b.createdAt; });
    }
    function savePriceList(pl, ctx) {
      pl = pl || {};
      checkOpKey(pl.opKey);
      if (priceLists().some(function (x) { return x.opKey === pl.opKey; })) return { duplicate: true, changes: [] };
      var date = pl.date == null ? now() : pl.date;
      if (typeof date !== 'number' || !isFinite(date) || date <= 0 || date > now() + 5 * 60 * 1000) throw AppError('BAD_INPUT', 'تاریخ لیست قیمت نامعتبر است (نمی‌تواند در آینده باشد).');
      if (pl.supplierId && !S.suppliers[pl.supplierId]) throw AppError('NOT_FOUND', 'تأمین‌کننده پیدا نشد.');
      var items = {}, n = 0;
      (pl.items || []).forEach(function (it, i) {
        if (!S.products[it.productId]) throw AppError('NOT_FOUND', 'ردیف ' + (i + 1) + ': کالا پیدا نشد.');
        if (!isMoney(it.price) || it.price === 0) throw AppError('BAD_INPUT', 'ردیف ' + (i + 1) + ': قیمت نامعتبر است.');
        if (items[it.productId] == null) n++;
        items[it.productId] = it.price;
      });
      if (!n) throw AppError('BAD_INPUT', 'هیچ کالایی از انبار شما در این لیست تطبیق داده نشده است.');
      var sha = pl.file && str(pl.file.sha256);
      if (sha && !pl.allowDuplicate && priceLists().some(function (x) { return x.file && x.file.sha256 === sha && (x.supplierId || null) === (pl.supplierId || null) && dayKey(x.date) === dayKey(date); }))
        throw AppError('DUP_PLIST', 'همین فایل لیست قیمت با همین تاریخ قبلاً ثبت شده است.');
      var tx = new Tx(); tx.allowReserved = true;
      var id = 'plist:' + tx.id('meta'), at = now();
      var rec = { id: id, opKey: pl.opKey, date: date, supplierId: pl.supplierId || null, name: str(pl.name), currency: pl.currency === 'rial' ? 'rial' : 'toman',
        file: pl.file ? { name: str(pl.file.name), sha256: sha } : null, items: items, count: n, by: who(ctx), createdAt: at };
      tx.insert('meta', { id: id, v: rec, updatedAt: at });
      audit(tx, 'pricelist', id, 'create', null, { date: date, supplierId: rec.supplierId, name: rec.name, count: n, file: rec.file }, ctx);
      return { priceList: rec, changes: tx.commit() };
    }
    /* v2.2.1: which list gives the cost of a receipt dated ts (owner's rule, no age limit): a list of the SAME supplier
       first; then the latest list dated on/before the receipt day; if there is none, the earliest list after it.
       Lower rank = better. */
    function listRank(pl, ts, supplierId) {
      var d0 = dayKey(ts), dk = dayKey(pl.date), before = dk <= d0;
      return [!!supplierId && pl.supplierId === supplierId ? 0 : 1, before ? 0 : 1, before ? d0 - dk : dk - d0, -(pl.createdAt || 0)];
    }
    function rankLess(a, b) { for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; }
    function listCostFor(productId, ts, supplierId) {
      var best = null, bestR = null;
      priceLists().forEach(function (pl) {
        var price = pl.items[productId]; if (price == null) return;
        var r = listRank(pl, ts, supplierId);
        if (!best || rankLess(r, bestR)) { best = { price: price, listId: pl.id, date: pl.date, supplierId: pl.supplierId, name: pl.name, same: r[0] === 0, before: r[1] === 0 }; bestR = r; }
      });
      return best;
    }

    /* ---------- cost completion: a NEW document (kind 'cost', dated today) gives units that were received without a
       purchase cost their cost. Posted documents are not rewritten: the units still in stock get the cost in their FIFO
       layers; reports derive the cost of units already sold/returned from the completion "as of" the report date, so a
       closed period (always before today) never changes. ---------- */
    var COMP = { ver: -1, map: null };
    function compKey(pid, src) { return pid + '|' + (src || ''); }
    function completions() {
      if (COMP.ver === VER && COMP.map) return COMP.map;
      var m = dict();
      Object.keys(S.docs).forEach(function (k) {
        var d = S.docs[k]; if (d.kind !== 'cost' || d.status === 'reversed') return;
        d.lines.forEach(function (l) { var key = compKey(l.productId, l.srcDocId); if (!m[key] || m[key].ts > d.ts) m[key] = { ts: d.ts, unitCost: l.unitCost, docId: d.id, docNo: d.no }; });
      });
      COMP.ver = VER; COMP.map = m; return m;
    }
    function completionFor(pid, src, X) { var c = completions()[compKey(pid, src)]; return c && (X == null || c.ts <= X) ? c : null; }
    // cost of FIFO parts [{qty, cost, src}] as known at time X (null = now); null if any unit is still unknown
    function partsCost(parts, pid, X) {
      if (!parts || !parts.length) return null;
      var t = 0;
      for (var i = 0; i < parts.length; i++) {
        var u = parts[i], c = u.cost;
        if (c == null) { var cp = completionFor(pid, u.src, X); if (!cp) return null; c = cp.unitCost; }
        t += c * u.qty;
      }
      return t;
    }
    function resolveParts(parts, pid) { // for NEW documents: unknown parts that were completed get their cost now
      return (parts || []).map(function (u) { if (u.cost != null) return u; var cp = completionFor(pid, u.src, null); return cp ? Object.assign({}, u, { cost: cp.unitCost }) : u; });
    }
    function outLineCost(l, X) { return l.costTotal != null ? l.costTotal : partsCost(l.layers, l.productId, X); }
    function inLineCost(l, d, X) { var c = receiptLineCost(l); if (c != null) return c; var cp = completionFor(l.productId, d.id, X); return cp ? cp.unitCost * l.qty : null; }
    function adjLineCost(l, d, X) {
      if (l.qty < 0) return outLineCost(l, X);
      if (l.unitCost != null) return l.unitCost * l.qty;
      var cp = completionFor(l.productId, d.id, X); return cp ? cp.unitCost * l.qty : null;
    }
    // every source of units without cost: receipt / positive adjustment lines (and legacy units of unknown origin still in stock)
    function costCandidates(o) {
      o = o || {}; var out = [], comp = completions();
      allDocs().forEach(function (d) {
        if (d.status === 'reversed' || !(d.kind === 'in' || (d.kind === 'adjust' && d.lines[0] && d.lines[0].qty > 0))) return;
        var seen = dict();
        d.lines.forEach(function (l) {
          if (o.productId && l.productId !== o.productId) return;
          var known = d.kind === 'in' ? receiptLineCost(l) != null : l.unitCost != null;
          if (known || seen[l.productId] || comp[compKey(l.productId, d.id)] || !S.products[l.productId]) return;
          seen[l.productId] = 1;
          var p = S.products[l.productId], qty = d.lines.filter(function (x) { return x.productId === l.productId && (d.kind !== 'in' || receiptLineCost(x) == null); }).reduce(function (s2, x) { return s2 + Math.abs(x.qty); }, 0);
          var inStock = layersQty(p, function (x) { return x.src === d.id && x.cost == null; });
          out.push({ srcDocId: d.id, srcNo: d.no, srcKind: d.kind, ts: d.ts, supplierId: d.supplierId || null, supplier: d.supplier || '', productId: p.id, sku: p.sku, name: p.name, brand: p.brand,
            qty: qty, inStock: inStock, suggestion: listCostFor(p.id, d.ts, d.supplierId || null) });
        });
      });
      Object.keys(S.products).forEach(function (id) { // legacy (schema 1) units without origin
        if (o.productId && id !== o.productId) return;
        var p = S.products[id], q = layersQty(p, function (x) { return x.src == null && x.cost == null; });
        if (q > 0 && !comp[compKey(id, null)]) out.push({ srcDocId: null, srcNo: '', srcKind: 'legacy', ts: null, supplierId: null, supplier: '', productId: id, sku: p.sku, name: p.name, brand: p.brand, qty: q, inStock: q, suggestion: null });
      });
      return out;
    }
    function completeCosts(d, ctx) {
      checkOpKey(d.opKey);
      var ex = existingOp(d.opKey); if (ex) return ex;
      requireManager(ctx, 'تکمیل بهای خرید');
      if (!d.items || !d.items.length) throw AppError('BAD_INPUT', 'ردیفی برای تکمیل بها انتخاب نشده است.');
      var cand = dict(); costCandidates().forEach(function (c) { cand[compKey(c.productId, c.srcDocId)] = c; });
      var keys = dict();
      d.items.forEach(function (it, i) {
        var k = compKey(it.productId, it.srcDocId || null);
        if (!cand[k]) throw AppError('NOT_OPEN', 'ردیف ' + (i + 1) + ': این ورود بهای نامشخص ندارد، قبلاً تکمیل شده یا لغو شده است.');
        if (!isMoney(it.unitCost) || it.unitCost === 0) throw AppError('BAD_INPUT', 'ردیف ' + (i + 1) + ': بهای واحد باید عدد صحیح مثبت باشد.');
        if (keys[k]) throw AppError('BAD_INPUT', 'ردیف ' + (i + 1) + ' تکراری است.'); keys[k] = 1;
        if (it.listId && !(S.meta[it.listId] && S.meta[it.listId].v)) throw AppError('NOT_FOUND', 'لیست قیمت پیدا نشد.');
      });
      var ts = docDate(null, ctx, 'تکمیل بها'), tx = new Tx();
      var doc = { id: tx.id('docs'), kind: 'cost', type: 'cost_complete', no: 'CST-' + pad(counterNext(tx, 'cst'), 6), ts: ts, reason: str(d.reason), note: str(d.note),
        user: who(ctx), source: src(ctx, d), status: 'posted', opKey: d.opKey, lines: [], createdAt: now(), updatedAt: now() };
      d.items.forEach(function (it) {
        var c = cand[compKey(it.productId, it.srcDocId || null)], p = tx.get('products', it.productId), moved = 0;
        ensureLayers(p).forEach(function (l) { if (l.cost == null && (l.src || null) === (c.srcDocId || null)) { l.cost = it.unitCost; moved += l.qty; } });
        // merge neighbours that became identical
        for (var i = p.layers.length - 1; i > 0; i--) if (sameLayer(p.layers[i - 1], p.layers[i])) { p.layers[i - 1].qty += p.layers[i].qty; p.layers.splice(i, 1); }
        syncCost(p); p.updatedAt = now();
        if (p.buyPrice == null) p.buyPrice = it.unitCost; // v2.5: a product that never had a purchase price shows this one
        var pl = it.listId ? S.meta[it.listId].v : null;
        doc.lines.push({ productId: p.id, sku: p.sku, name: p.name, brand: p.brand, srcDocId: c.srcDocId, srcNo: c.srcNo, srcTs: c.ts, qty: c.qty, inStock: moved, unitCost: it.unitCost,
          listId: pl ? pl.id : null, listDate: pl ? pl.date : null, how: it.listId ? 'list' : 'manual' });
      });
      tx.insert('docs', doc);
      tx.insert('ops', { id: d.opKey, docId: doc.id });
      return { duplicate: false, docId: doc.id, doc: doc, changes: tx.commit() };
    }

    /* ---------- "today's price" (replacement cost) = the most recent known purchase price on or before T:
       a receipt line with a known unit cost (on its date) or a purchase price list (on its date). ---------- */
    var REPL = { ver: -1, by: null };
    function replIndex() {
      if (REPL.ver === VER && REPL.by) return REPL.by;
      var by = dict();
      function put(pid, ts, c, kind, known) { if (!isMoney(c) || !c || ts == null) return; var e = { ts: ts, c: c, kind: kind }; if (known != null) e.known = known; (by[pid] = by[pid] || []).push(e); }
      Object.keys(S.docs).forEach(function (k) {
        var d = S.docs[k]; if (d.status === 'reversed') return;
        if (d.kind === 'in') d.lines.forEach(function (l) { if (l.unitCost != null) put(l.productId, d.ts, l.unitCost, 'receipt'); });
        // v2.5: a cost completed later is the price of THAT receipt on its date, but it is only known from the completion
        // date on (a report "as of" an earlier date — e.g. a closed period — does not see it)
        if (d.kind === 'cost') d.lines.forEach(function (l) { if (l.srcTs != null) put(l.productId, l.srcTs, l.unitCost, 'receipt', d.ts); });
      });
      priceLists().forEach(function (pl) { Object.keys(pl.items).forEach(function (pid) { put(pid, pl.date, pl.items[pid], 'list'); }); });
      Object.keys(by).forEach(function (pid) { by[pid].sort(function (a, b) { return a.ts - b.ts || (a.kind === 'list' ? -1 : 1); }); });
      REPL.ver = VER; REPL.by = by; return by;
    }
    function replacementCost(pid, T) {
      var a = replIndex()[pid]; if (!a || !a.length) return null;
      if (T == null) { var z = a[a.length - 1]; return { unitCost: z.c, ts: z.ts, kind: z.kind }; }
      var lo = 0, hi = a.length - 1, ans = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (a[mid].ts <= T) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      while (ans >= 0 && a[ans].known != null && a[ans].known > T) ans--; // v2.5: completed after T -> not known yet at T
      return ans < 0 ? null : { unitCost: a[ans].c, ts: a[ans].ts, kind: a[ans].kind };
    }


    /* ---------- v2.2.2 undo of an import (price list / product list): the record is built from what the import
       ACTUALLY changed (the change list of its transaction batch), so nothing has to be remembered by hand.
       Undo never touches what was changed again later, sold, or locked in a closed period; it says why. ---------- */
    var MASTER_F = ['sku', 'name', 'shortName', 'brand', 'model', 'family', 'unit', 'packSize', 'minStock', 'buyPrice', 'sellPrice', 'location', 'notes', 'categoryId', 'category',
      'supplierId', 'warrantyMonths', 'attrs', 'active', 'boxQty', 'cartonQty', 'barcodeQty', 'prices', 'barcodes', 'cars'];
    var OPT_F = { boxQty: 1, cartonQty: 1, barcodeQty: 1, prices: 1, cars: 1 }; // fields a product may simply not have
    function lval(e) { return !e ? null : e.c ? 'c:' + e.c : (e.p || null); } // v2.3: a learned product id, or «c:<categoryId>»
    function same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
    function recordImport(o, results, ctx) {
      var ch = []; (results || []).forEach(function (r) { if (r && r.changes) ch = ch.concat(r.changes); });
      var first = {}, last = {};
      ch.forEach(function (c) { var k = c.store + '\u0000' + c.rec.id; if (!(k in first)) first[k] = c.prev; last[k] = c; });
      var rec = { kind: str(o.kind) || 'import', label: str(o.label), file: o.file ? { name: str(o.file.name), sha256: str(o.file.sha256) } : null,
        products: [], changed: [], categories: [], catChanged: [], plists: [], receipts: [], costs: [], learned: [], at: now(), by: who(ctx) };
      Object.keys(last).forEach(function (k) {
        var c = last[k], prev = first[k], st = c.store, r = c.rec;
        if (st === 'products') {
          if (!prev) rec.products.push(r.id);
          else { var f = {}; MASTER_F.forEach(function (x) { if (!same(prev[x], r[x])) f[x] = [prev[x] === undefined ? null : clone(prev[x]), r[x] === undefined ? null : clone(r[x])]; }); if (Object.keys(f).length) rec.changed.push({ id: r.id, f: f }); }
        } else if (st === 'categories' && !prev) rec.categories.push(r.id);
        else if (st === 'categories' && prev && !c.deleted) { var cf2 = {}; ['name', 'parentId', 'active'].forEach(function (x) { if (!same(prev[x], r[x])) cf2[x] = [prev[x] === undefined ? null : prev[x], r[x] === undefined ? null : r[x]]; }); if (Object.keys(cf2).length) rec.catChanged.push({ id: r.id, f: cf2 }); } // v2.9: moves / merges of groups can be undone
        else if (st === 'meta' && /^plist:/.test(r.id) && !prev) rec.plists.push(r.id);
        else if (st === 'docs' && !prev && r.kind === 'in') rec.receipts.push(r.id);
        else if (st === 'docs' && !prev && r.kind === 'cost') rec.costs.push(r.id);
        else if (st === 'meta' && r.id === 'learn') {
          var A0 = (prev && prev.v && prev.v.a) || {}, A1 = (r.v && r.v.a) || {};
          Object.keys(A1).forEach(function (key) { if (lval(A0[key]) !== lval(A1[key])) rec.learned.push({ key: key, before: lval(A0[key]), after: lval(A1[key]) }); });
        }
      });
      var tx = new Tx(); tx.allowReserved = true;
      var id = 'imp:' + tx.id('meta'); rec.id = id;
      tx.insert('meta', { id: id, v: rec, updatedAt: rec.at });
      return { record: rec, changes: tx.commit() };
    }
    function importRecords() { return Object.keys(S.meta).filter(function (k) { return k.indexOf('imp:') === 0; }).map(function (k) { return S.meta[k].v; }).sort(function (a, b) { return b.at - a.at; }); }
    function productInUse(id) {
      if (Object.keys(S.movements).some(function (k) { return S.movements[k].productId === id; })) return true;
      return Object.keys(S.docs).some(function (k) { return (S.docs[k].lines || []).some(function (l) { return l.productId === id; }); });
    }
    // what an undo would do now (read-only): receipts to cancel first, then everything else; skips say why
    function undoImportPlan(id) {
      var m = S.meta[id], r = m && m.v; if (!r) throw AppError('NOT_FOUND', 'سابقه ورود پیدا نشد.');
      var c = closedThrough(), plan = { id: id, done: !!r.undoneAt, receipts: [], products: { del: [], off: [] }, fields: [], categories: [], plists: [], costs: [], learned: [], skips: [] };
      r.receipts.forEach(function (did) {
        var d = S.docs[did]; if (!d || d.status === 'reversed') return;
        if (c != null && d.ts <= c) { plan.skips.push('ورود ' + d.no + ' در دوره بسته است'); return; }
        var dry = {}, okR = d.lines.every(function (l) { var p = dry[l.productId] || (dry[l.productId] = clone(S.products[l.productId])); return p && removeReceiptUnits(p, d.id, l) >= l.qty; });
        if (okR) plan.receipts.push(did); else plan.skips.push('بخشی از کالای ورود ' + d.no + ' فروش رفته یا خارج شده؛ موجودی آن برنمی‌گردد');
      });
      r.costs.forEach(function (did) {
        var d = S.docs[did]; if (!d || d.status === 'reversed') return;
        if (c != null && d.ts <= c) { plan.skips.push('تکمیل بهای ' + d.no + ' در دوره بسته است'); return; }
        var later = d.lines.some(function (l) { return Object.keys(S.docs).some(function (k) { var x = S.docs[k]; return x.ts >= d.ts && x.id !== d.id && (x.kind === 'out' || x.kind === 'return' || x.kind === 'adjust') && x.lines.some(function (y) { return y.productId === l.productId; }); }); });
        if (later) plan.skips.push('بعد از تکمیل بهای ' + d.no + ' فروش یا مرجوعی ثبت شده؛ بها برنمی‌گردد'); else plan.costs.push(did);
      });
      r.products.forEach(function (pid) { var p = S.products[pid]; if (!p) return; if (p.stock === 0 && !productInUse(pid)) plan.products.del.push(pid); else if (p.active !== false) plan.products.off.push(pid); });
      r.changed.forEach(function (x) {
        var p = S.products[x.id]; if (!p) return;
        Object.keys(x.f).forEach(function (k) { if (same(p[k], x.f[k][1])) plan.fields.push({ id: x.id, k: k, to: x.f[k][0] }); else plan.skips.push('«' + p.name + '»: ' + k + ' بعداً دوباره تغییر کرده؛ دست نخورد'); });
      });
      r.categories.forEach(function (cid) { if (S.categories[cid]) plan.categories.push(cid); });
      plan.catFields = []; (r.catChanged || []).forEach(function (x) { var cc = S.categories[x.id]; if (!cc) return; Object.keys(x.f).forEach(function (k) { if (same(cc[k] === undefined ? null : cc[k], x.f[k][1])) plan.catFields.push({ id: x.id, k: k, to: x.f[k][0] }); else plan.skips.push('گروه «' + cc.name + '»: ' + k + ' بعداً دوباره تغییر کرده؛ دست نمی‌خورد'); }); });
      r.plists.forEach(function (pl) { if (S.meta[pl]) plan.plists.push(pl); });
      var a = learnedAll(); r.learned.forEach(function (l) { if (a[l.key] && lval(a[l.key]) === l.after) plan.learned.push(l); });
      return plan;
    }
    // undo everything except receipts (cancel those first with reverseDoc, in the same batch)
    function undoImport(id, ctx) {
      requireManager(ctx, 'بازگرداندن ورود از فایل');
      var plan = undoImportPlan(id), r = S.meta[id].v;
      if (r.undoneAt) throw AppError('DONE', 'این ورود قبلاً بازگردانده شده است.');
      if (plan.receipts.length) throw AppError('BAD_INPUT', 'ابتدا ورودهای این فایل باید لغو شوند.');
      var tx = new Tx(); tx.allowReserved = true;
      var map = tx.get('meta', 'barcodes'), dropCode = function (p, code) { if (map && map.v[code] === p.id) delete map.v[code]; };
      plan.costs.forEach(function (did) { // completion undone: layers back to "unknown", the document marked reversed by a reversal document
        var d = tx.get('docs', did);
        var rev = { id: tx.id('docs'), kind: 'reversal', type: 'reversal', no: 'REV-' + pad(counterNext(tx, 'rev'), 6), ts: now(), reverses: d.id, reversesNo: d.no, reason: 'بازگرداندن ورود از فایل',
          user: who(ctx), source: src(ctx), status: 'posted', opKey: 'undo:' + id + ':' + did, lines: [], createdAt: now(), updatedAt: now() };
        d.lines.forEach(function (l) {
          var p = tx.get('products', l.productId); ensureLayers(p).forEach(function (u) { if ((u.src || null) === (l.srcDocId || null) && u.cost === l.unitCost) u.cost = null; });
          syncCost(p); p.updatedAt = now();
        });
        d.status = 'reversed'; d.reversedBy = rev.id; d.reversedAt = now(); d.reverseReason = rev.reason; d.updatedAt = now();
        tx.insert('docs', rev);
      });
      plan.fields.forEach(function (x) {
        var p = tx.get('products', x.id);
        if (x.k === 'barcodes') { (p.barcodes || []).forEach(function (code) { if ((x.to || []).indexOf(code) < 0) dropCode(p, code); }); (x.to || []).forEach(function (code) { if (map) map.v[code] = p.id; }); }
        // v2.3: optional fields are removed; base fields (group, prices…) go back to null as created, never missing
        if (x.to == null) { if (OPT_F[x.k]) delete p[x.k]; else p[x.k] = null; } else p[x.k] = clone(x.to);
        p.updatedAt = now();
      });
      plan.products.del.forEach(function (pid) { var p = S.products[pid]; (p.barcodes || []).forEach(function (code) { dropCode(p, code); }); tx.remove('products', pid); audit(tx, 'product', pid, 'delete', p, null, ctx, { reason: 'بازگرداندن ورود از فایل' }); });
      plan.products.off.forEach(function (pid) { var p = tx.get('products', pid); p.active = false; p.updatedAt = now(); });
      var gone = {}; plan.products.del.forEach(function (pid) { gone[pid] = 1; });
      var moved = {}; plan.fields.forEach(function (x) { if (x.k === 'categoryId') moved[x.id] = x.to || null; });
      var catOf = function (k) { return k in moved ? moved[k] : S.products[k].categoryId; }, goneC = {}, more = true;
      while (more) { // v2.3: a created path («یدکی › جلوبندی › سیبک») goes child first, and only when nothing is left in it
        more = false;
        plan.categories.forEach(function (cid) {
          if (goneC[cid]) return;
          var used = Object.keys(S.products).some(function (k) { return !gone[k] && catOf(k) === cid; }) || Object.keys(S.categories).some(function (k) { return !goneC[k] && S.categories[k].parentId === cid; });
          if (!used) { goneC[cid] = 1; more = true; tx.remove('categories', cid); }
        });
      }
      plan.catFields.forEach(function (x) { var cc = tx.get('categories', x.id); if (x.k === 'active') cc.active = x.to !== false; else cc[x.k] = x.to; cc.updatedAt = now(); }); // v2.9
      plan.plists.forEach(function (pl) { tx.remove('meta', pl); });
      if (plan.learned.length) { var lm = tx.get('meta', 'learn'); plan.learned.forEach(function (l) {
        var bc = l.before && /^c:/.test(l.before) ? l.before.slice(2) : null;
        if (bc && S.categories[bc]) lm.v.a[l.key] = { c: bc, n: 1, t: now() }; else if (!bc && l.before && S.products[l.before]) lm.v.a[l.key] = { p: l.before, n: 1, t: now() }; else delete lm.v.a[l.key];
      }); }
      var m = tx.get('meta', id); m.v.undoneAt = now(); m.v.undoneBy = who(ctx); m.v.undoSkips = plan.skips;
      audit(tx, 'import', id, 'undo', null, { label: r.label, skips: plan.skips.length }, ctx);
      return { plan: plan, changes: tx.commit() };
    }
    // a product created by mistake (manually or from a file) that was never used in any document
    function deleteProduct(id, ctx) {
      requireManager(ctx, 'حذف کالا');
      var p = S.products[id]; if (!p) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
      if (p.stock !== 0 || productInUse(id)) throw AppError('IN_USE', 'این کالا در اسناد استفاده شده است و حذف نمی‌شود؛ می‌توانید آن را «غیرفعال» کنید.');
      var tx = new Tx(), map = tx.get('meta', 'barcodes');
      (p.barcodes || []).forEach(function (code) { if (map && map.v[code] === id) delete map.v[code]; });
      tx.remove('products', id);
      audit(tx, 'product', id, 'delete', p, null, ctx);
      return { changes: tx.commit() };
    }
    // a purchase price list (list prices only; product fields changed by it are undone with its import record)
    /* v2.9: take wrong prices out of a saved purchase list (e.g. rows matched to another brand's product); the list stays */
    function removePriceListItems(id, productIds, ctx) {
      requireManager(ctx, 'حذف قیمت از لیست قیمت');
      if (!/^plist:/.test(id) || !S.meta[id]) throw AppError('NOT_FOUND', 'لیست قیمت پیدا نشد.');
      var pl = S.meta[id].v, gone = (productIds || []).filter(function (pid) { return pl.items[pid] != null; });
      if (!gone.length) throw AppError('BAD_INPUT', 'این کالا در لیست نیست.');
      var tx = new Tx(); tx.allowReserved = true; var m = tx.get('meta', id), was = {};
      gone.forEach(function (pid) { was[pid] = m.v.items[pid]; delete m.v.items[pid]; });
      m.v.count = Object.keys(m.v.items).length; m.v.removed = (m.v.removed || []).concat([{ at: now(), by: who(ctx), items: was }]); m.updatedAt = now();
      audit(tx, 'pricelist', id, 'update', { items: was }, { items: {} }, ctx);
      return { changes: tx.commit() };
    }
    function deletePriceList(id, ctx) {
      requireManager(ctx, 'حذف لیست قیمت');
      if (!/^plist:/.test(id) || !S.meta[id]) throw AppError('NOT_FOUND', 'لیست قیمت پیدا نشد.');
      var tx = new Tx(); tx.allowReserved = true; tx.remove('meta', id);
      audit(tx, 'pricelist', id, 'delete', { name: S.meta[id].v.name, count: S.meta[id].v.count }, null, ctx);
      return { changes: tx.commit() };
    }

    // ---------- meta ----------
    function putMeta(id, v, ctx) {
      if (RESERVED_META.indexOf(id) >= 0 || RESERVED_PREFIX.test(String(id))) throw AppError('BAD_INPUT', 'این رکورد رزرو شده است.');
      var tx = new Tx(), before = S.meta[id] ? clone(S.meta[id].v) : null;
      tx.put('meta', { id: id, v: clone(v), updatedAt: now() });
      if (['shop', 'auth', 'prefs'].indexOf(id) >= 0) {
        var mask = function (o) { if (!o || id !== 'auth') return o; var m = {}; Object.keys(o).forEach(function (k) { m[k] = '***'; }); return m; };
        audit(tx, 'settings', id, before ? 'update' : 'create', mask(before), mask(clone(v)), ctx);
      }
      return { changes: tx.commit() };
    }
    function getMeta(id) { return S.meta[id] ? clone(S.meta[id].v) : null; }
    function setSettings(patch, ctx) {
      requireManager(ctx, 'تغییر تنظیمات');
      var tx = new Tx(), m = tx.get('meta', 'settings') || tx.put('meta', { id: 'settings', v: { allowNegative: false } }), before = clone(m.v);
      Object.assign(m.v, patch);
      audit(tx, 'settings', 'settings', 'update', before, m.v, ctx);
      return { changes: tx.commit() };
    }

    // ---------- queries & reports ----------
    function inRange(ts, r) { return (!r || r.from == null || ts >= r.from) && (!r || r.to == null || ts <= r.to); }
    function allDocs() { return Object.keys(S.docs).map(function (k) { return S.docs[k]; }).sort(function (a, b) { return a.ts - b.ts || a.createdAt - b.createdAt; }); }
    function list(store) { return Object.keys(S[store]).map(function (k) { return S[store][k]; }); }
    function stockReport() {
      return Object.keys(S.products).map(function (id) {
        var p = S.products[id], rp = replacementCost(id, null);
        return { id: id, sku: p.sku, name: p.name, brand: p.brand, model: p.model, family: p.family, unit: p.unit, packSize: p.packSize, stock: p.stock,
          pieces: p.stock * p.packSize, minStock: p.minStock, low: p.active && p.stock <= p.minStock && p.minStock > 0, active: p.active,
          location: p.location, avgCost: avgCost(p), knownValue: p.costBasis || 0, unknownCostQty: Math.max(0, p.stock - (p.costedQty || 0)),
          categoryId: p.categoryId, category: p.categoryId ? categoryPath(p.categoryId).join(' › ') : (p.category || ''), supplierId: p.supplierId,
          supplier: p.supplierId && S.suppliers[p.supplierId] ? S.suppliers[p.supplierId].name : '',
          sellPrice: p.sellPrice, buyPrice: p.buyPrice, barcodes: (p.barcodes || []).join(' '), warrantyMonths: p.warrantyMonths, attrs: p.attrs || {},
          // v2.2: value at the sale price and at today's purchase price (null when the price is unknown)
          sellValue: p.sellPrice != null && p.stock > 0 ? p.stock * p.sellPrice : (p.stock > 0 ? null : 0), replUnit: rp ? rp.unitCost : null, replValue: rp && p.stock > 0 ? p.stock * rp.unitCost : (p.stock > 0 ? null : 0),
          potential: p.sellPrice != null && p.stock > 0 && p.costedQty === p.stock ? p.stock * p.sellPrice - (p.costBasis || 0) : null };
      }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    }
    function productLedger(productId) {
      return Object.keys(S.movements).map(function (k) { return S.movements[k]; })
        .filter(function (m) { return m.productId === productId; })
        .sort(function (a, b) { return a.ts - b.ts || a.createdAt - b.createdAt; });
    }
    /* ---------- v2.1 historical (event-based) reporting ----------
       Every event counts on ITS OWN date: an invoice (+) on its date, its cancellation (−) on the cancellation
       date; a return (−) on its date, the return's cancellation (+) on that date. When a document and its
       cancellation both fall inside the requested range they cancel out and are not listed (same as before).
       Settlement columns are computed "as of the end of the range" from dated records only (payments, returns,
       reversals) — never from the settlement fields — so a closed period never changes. With no end date the
       current (stored) values are used. */
    function revTs(d) {
      if (!d || d.status !== 'reversed') return null;
      var r = d.reversedBy && S.docs[d.reversedBy];
      return r ? r.ts : (d.reversedAt || d.ts);
    }
    function settleOf(total, returned, paidNet, reversed) {
      var bal = (reversed ? 0 : total - returned) - paidNet;
      return { balance: bal, settlement: bal < 0 ? 'credit' : reversed ? 'settled' : bal === 0 ? 'settled' : paidNet > 0 ? 'partial' : 'unsettled' };
    }
    /* state of every sale invoice at time X (null = now / stored values): {id: {status, total, returned, paid, balance, settlement}} */
    function invoiceStates(X) {
      var out = {};
      if (X == null) {
        Object.keys(S.docs).forEach(function (k) { var d = S.docs[k]; if (d.kind === 'out' && d.type === SALE) out[k] = { status: d.status, total: d.total, returned: d.returned || 0, paid: d.paid - d.refunded, balance: d.balance, settlement: d.settlement }; });
        return out;
      }
      var ret = {}, pay = {};
      Object.keys(S.docs).forEach(function (k) {
        var r = S.docs[k]; if (r.kind !== 'return' || r.ts > X) return;
        var rt = revTs(r); if (rt != null && rt <= X) return;
        ret[r.invoiceId] = (ret[r.invoiceId] || 0) + r.total;
      });
      Object.keys(S.payments).forEach(function (k) {
        var p = S.payments[k]; if (p.ts > X) return;
        pay[p.docId] = (pay[p.docId] || 0) + (p.kind === 'refund' ? -p.amount : p.amount);
      });
      Object.keys(S.docs).forEach(function (k) {
        var d = S.docs[k]; if (!(d.kind === 'out' && d.type === SALE)) return;
        var rt = revTs(d), rev = rt != null && rt <= X, st = settleOf(d.total, ret[k] || 0, pay[k] || 0, rev);
        out[k] = { status: rev ? 'reversed' : 'posted', total: d.total, returned: ret[k] || 0, paid: pay[k] || 0, balance: st.balance, settlement: st.settlement };
      });
      return out;
    }
    function invoiceAsOf(docId, X) { return invoiceStates(X)[docId] || null; }
    // which events of a document fall in range f: {doc, cancel}; null when nothing is listed
    function eventsIn(d, f) {
      var rt = revTs(d), inD = inRange(d.ts, f), inC = rt != null && inRange(rt, f);
      if (rt != null && inD && inC && !f.includeReversed) return null;
      if (!inD && !inC) return null;
      return { doc: inD, cancel: inC && !inD, rt: rt };
    }
    function revNo(d) { var r = d.reversedBy && S.docs[d.reversedBy]; return r ? r.no : ''; }
    function salesLines(f) {
      f = f || {}; var rows = [], X = f.to != null ? f.to : null, st = null;
      allDocs().forEach(function (d) {
        var isSale = d.kind === 'out' && d.type === SALE, isRet = d.kind === 'return' && !f.excludeReturns;
        if (!isSale && !isRet) return;
        if (f.customerId && d.customerId !== f.customerId) return;
        var ev = eventsIn(d, f); if (!ev) return;
        var c = S.customers[d.customerId], base = { invoiceNo: d.invoiceNo, customerId: d.customerId, customer: c ? c.name : '', phone: c ? c.phone : '', customerType: c ? c.type : '', docId: d.id, user: d.user };
        if (isSale) {
          var s = null; if (ev.doc) { st = st || invoiceStates(X); s = st[d.id]; }
          d.lines.forEach(function (l, li) {
            if (f.productId && l.productId !== f.productId) return;
            if (f.brand && normText(l.brand) !== normText(f.brand)) return;
            var net = l.net != null ? l.net : l.lineTotal, cost = outLineCost(l, X); if (cost == null && l.unitCost != null) cost = l.unitCost * l.qty; // v2.2: completed costs count from their date
            var rp = replacementCost(l.productId, d.ts); // v2.2: "today's price" on the sale date
            var item = { sku: l.sku, name: l.name, brand: l.brand, unitPrice: l.unitPrice, unitCost: l.unitCost != null ? l.unitCost : (cost != null ? Math.round(cost / l.qty) : null), productId: l.productId, line: li, type: d.type, dueDate: d.dueDate || null,
              replUnit: rp ? rp.unitCost : null, costCompleted: l.costTotal == null && cost != null };
            if (ev.doc) rows.push(Object.assign({ kind: 'sale', docNo: d.no, ts: d.ts, qty: l.qty, discount: l.discount, invDisc: l.invDisc || 0, lineTotal: l.lineTotal, net: net, costTotal: cost,
              invoiceTotal: d.total, paid: s.paid, balance: s.balance, settlement: s.settlement, status: s.status, note: d.note }, base, item));
            if (ev.cancel) rows.push(Object.assign({ kind: 'sale_cancel', docNo: revNo(d), ts: ev.rt, qty: -l.qty, discount: -(l.discount || 0), invDisc: -(l.invDisc || 0), lineTotal: -l.lineTotal, net: -net, costTotal: cost == null ? null : -cost,
              invoiceTotal: null, paid: null, balance: null, settlement: '', status: 'posted', note: d.reverseReason || '' }, base, item));
          });
        } else {
          var invD = S.docs[d.invoiceId];
          d.lines.forEach(function (l) {
            if (f.productId && l.productId !== f.productId) return;
            if (f.brand && normText(l.brand) !== normText(f.brand)) return;
            var rc = outLineCost(l, X), rp = replacementCost(l.productId, invD ? invD.ts : d.ts);
            var item = { sku: l.sku, name: l.name, brand: l.brand, unitPrice: null, discount: 0, invDisc: 0, unitCost: rc == null ? null : Math.round(rc / l.qty), invoiceTotal: null, paid: null, balance: null, settlement: '',
              type: 'sale_return', invoiceId: d.invoiceId, productId: l.productId, replUnit: rp ? rp.unitCost : null, costCompleted: l.costTotal == null && rc != null };
            if (ev.doc) rows.push(Object.assign({ kind: 'return', docNo: d.no, ts: d.ts, qty: -l.qty, lineTotal: -l.amount, net: -l.amount, costTotal: rc == null ? null : -rc,
              status: ev.rt != null && (X == null || ev.rt <= X) ? 'reversed' : 'posted', note: d.reason }, base, item));
            if (ev.cancel) rows.push(Object.assign({ kind: 'return_cancel', docNo: revNo(d), ts: ev.rt, qty: l.qty, lineTotal: l.amount, net: l.amount, costTotal: rc == null ? null : rc,
              status: 'posted', note: d.reverseReason || '' }, base, item));
          });
        }
      });
      return rows;
    }
    function nonSaleIssues(f) {
      f = f || {}; var rows = [];
      allDocs().forEach(function (d) {
        if (d.kind !== 'out' || d.type === SALE) return;
        var ev = eventsIn(d, f); if (!ev) return;
        d.lines.forEach(function (l) {
          var b = { type: d.type, typeLabel: ISSUE_TYPES[d.type], recipient: d.recipient, sku: l.sku, name: l.name, brand: l.brand, docId: d.id, productId: l.productId, user: d.user };
          var lc = outLineCost(l, f.to != null ? f.to : null);
          if (ev.doc) rows.push(Object.assign({ docNo: d.no, ts: d.ts, qty: l.qty, note: d.note, costTotal: lc, cancel: false, status: ev.rt != null && (f.to == null || ev.rt <= f.to) ? 'reversed' : 'posted' }, b));
          if (ev.cancel) rows.push(Object.assign({ docNo: revNo(d), ts: ev.rt, qty: -l.qty, note: 'لغو ' + d.no + (d.reverseReason ? ' — ' + d.reverseReason : ''), costTotal: lc == null ? null : -lc, cancel: true, status: 'posted' }, b));
        });
      });
      return rows;
    }
    function receiptLineCost(l) { return l.costTotal != null ? l.costTotal : (l.unitCost != null ? l.unitCost * l.qty : null); }
    function receiptLines(f) {
      f = f || {}; var rows = [];
      allDocs().forEach(function (d) {
        if (d.kind !== 'in') return;
        var ev = eventsIn(d, f); if (!ev) return;
        d.lines.forEach(function (l) {
          var cost = inLineCost(l, d, f.to != null ? f.to : null), inv = d.invoice || null; // v2.2: a completed cost counts from the completion date
          var b = { op: d.type, supplierId: d.supplierId || null, supplier: d.supplier, supplierDocNo: d.supplierDocNo, productId: l.productId, sku: l.sku, name: l.name, brand: l.brand, docId: d.id, user: d.user,
            invoiceDate: inv ? inv.date : null, unitPrice: l.unitPrice != null ? l.unitPrice : null, lineDiscount: l.lineDiscount != null ? l.lineDiscount : null, invDisc: l.invDisc != null ? l.invDisc : null, currency: inv ? inv.currency : null };
          var uc = l.unitCost != null ? l.unitCost : (cost != null ? Math.round(cost / l.qty) : null); b.costCompleted = l.unitCost == null && receiptLineCost(l) == null && cost != null;
          if (ev.doc) rows.push(Object.assign({ ts: d.ts, no: d.no, qty: l.qty, unitCost: uc, total: cost, cancel: false, status: ev.rt != null && (f.to == null || ev.rt <= f.to) ? 'reversed' : 'posted' }, b));
          if (ev.cancel) rows.push(Object.assign({ ts: ev.rt, no: revNo(d), qty: -l.qty, unitCost: uc, total: cost == null ? null : -cost, cancel: true, status: 'posted', reversedNo: d.no }, b));
        });
      });
      return rows;
    }
    /* stock at time X from dated records only: quantity = Σ movements ≤ X; value = Σ cost flows of documents ≤ X
       (each document stores the actual FIFO cost it moved). incomplete = some flow of that product had no cost. */
    function stockAsOf(X) {
      var by = {}, i;
      function P(id) { return by[id] || (by[id] = { qty: 0, value: 0, incomplete: false }); }
      Object.keys(S.movements).forEach(function (k) { var m = S.movements[k]; if (X == null || m.ts <= X) P(m.productId).qty += m.qty; });
      function flow(pid, cost, sign) { var x = P(pid); if (cost == null) x.incomplete = true; else x.value += sign * cost; }
      Object.keys(S.docs).forEach(function (k) {
        var d = S.docs[k]; if (X != null && d.ts > X) return;
        // v2.2: units received without cost and completed later carry the completed cost from the completion date on
        if (d.kind === 'in') d.lines.forEach(function (l) { flow(l.productId, inLineCost(l, d, X), 1); });
        else if (d.kind === 'out') d.lines.forEach(function (l) { flow(l.productId, outLineCost(l, X), -1); });
        else if (d.kind === 'return') d.lines.forEach(function (l) { flow(l.productId, outLineCost(l, X), 1); });
        else if (d.kind === 'adjust') d.lines.forEach(function (l) { flow(l.productId, adjLineCost(l, d, X), l.qty < 0 ? -1 : 1); });
        else if (d.kind === 'reversal') {
          var o = S.docs[d.reverses]; if (!o) return;
          if (o.kind === 'out') o.lines.forEach(function (l) { flow(l.productId, outLineCost(l, X), 1); });
          else if (o.kind === 'in') o.lines.forEach(function (l) { flow(l.productId, inLineCost(l, o, X), -1); });
          else if (o.kind === 'return') o.lines.forEach(function (l) { flow(l.productId, outLineCost(l, X), -1); });
        }
      });
      var tot = { qty: 0, value: 0, incomplete: 0, byProduct: by };
      for (i in by) { tot.qty += by[i].qty; if (by[i].incomplete) tot.incomplete++; else tot.value += by[i].value; }
      return tot;
    }
    /* period summary — every number from dated records in (from, to] (stock and receivables: as of `to`) */
    function periodSummary(from, to, algo) {
      if ((algo || PERIOD_ALGO) !== 1) throw AppError('BAD_INPUT', 'نسخه الگوریتم خلاصه دوره پشتیبانی نمی‌شود.');
      var f = { from: from == null ? null : from, to: to }, s = { algo: 1, from: f.from, to: to, salesNet: 0, returnsNet: 0, saleLines: 0, netKnown: 0, cogsKnown: 0, unknownCostLines: 0,
        purchases: 0, purchaseQty: 0, purchaseUnknownLines: 0, nonSaleCost: 0, received: 0, refunded: 0, receivable: 0, customerCredit: 0, stockQty: 0, stockValueKnown: 0, stockIncomplete: 0 };
      salesLines(f).forEach(function (r) {
        s.salesNet += r.net; s.saleLines++;
        if (r.kind === 'return' || r.kind === 'return_cancel') s.returnsNet += r.net;
        if (r.costTotal == null) s.unknownCostLines++; else { s.cogsKnown += r.costTotal; s.netKnown += r.net; }
      });
      s.grossProfitKnown = s.netKnown - s.cogsKnown;
      receiptLines(f).forEach(function (r) { s.purchaseQty += r.qty; if (r.total == null) s.purchaseUnknownLines++; else s.purchases += r.total; });
      nonSaleIssues(f).forEach(function (r) { if (r.costTotal != null) s.nonSaleCost += r.costTotal; });
      Object.keys(S.payments).forEach(function (k) {
        var p = S.payments[k]; if (!inRange(p.ts, f) || p.method === 'credit_transfer') return;
        if (p.kind === 'refund') s.refunded += p.amount; else s.received += p.amount;
      });
      var stt = invoiceStates(to);
      Object.keys(stt).forEach(function (k) { if (S.docs[k].ts > to) return; var b = stt[k].balance; if (b > 0) s.receivable += b; else if (b < 0) s.customerCredit += b; });
      var sk = stockAsOf(to); s.stockQty = sk.qty; s.stockValueKnown = sk.value; s.stockIncomplete = sk.incomplete;
      return s;
    }
    /* fingerprint of everything dated ≤ X (documents without settlement fields, payments, movements) */
    function periodFingerprint(X, algo) {
      if ((algo || PERIOD_ALGO) !== 1) throw AppError('BAD_INPUT', 'نسخه الگوریتم اثر انگشت پشتیبانی نمی‌شود.');
      var h = sha256Stream();
      ['docs', 'payments', 'movements'].forEach(function (st) {
        h.update('#' + st + '\n');
        Object.keys(S[st]).filter(function (k) { return S[st][k].ts <= X; }).sort().forEach(function (k) {
          var r = S[st][k]; h.update(canon(st === 'docs' ? histView(r) : stripRev(r))); h.update('\n');
        });
      });
      return h.hex();
    }
    function periodInfo() {
      var m = S.meta.periods, v = m && m.v ? m.v : { closedThrough: null, history: [] };
      return { closedThrough: closedThrough(), history: clone(v.history || []), backdateDays: BACKDATE_DAYS, algo: PERIOD_ALGO };
    }
    function activeClose() {
      var c = closedThrough(), m = S.meta.periods; if (c == null || !m) return null;
      var hs = (m.v.history || []).filter(function (x) { return x.action === 'close' && x.through === c; });
      return hs.length ? hs[hs.length - 1] : null;
    }
    // products whose stock at the end of day X is below zero (from dated movements)
    function negativeStockAsOf(X) {
      var by = stockAsOf(X).byProduct, out = [];
      Object.keys(by).forEach(function (pid) { if (by[pid].qty < 0) { var p = S.products[pid]; out.push({ productId: pid, name: p ? p.name : pid, sku: p ? p.sku : '', qty: by[pid].qty }); } });
      return out;
    }
    /* close the period through `o.through` (inclusive). o: {through, reason, backup: {hash, at, evidence: 'user'|'verified', version}, negativeOk?: {reason}} */
    function closePeriod(o, ctx) {
      requireManager(ctx, 'بستن دوره مالی');
      o = o || {};
      var through = o.through, cur = closedThrough();
      if (typeof through !== 'number' || !isFinite(through) || through <= 0) throw AppError('BAD_INPUT', 'تاریخ پایان دوره نامعتبر است.');
      if (through >= now()) throw AppError('BAD_INPUT', 'دوره‌ای که هنوز تمام نشده قابل بستن نیست.');
      if (cur != null && through <= cur) throw AppError('BAD_INPUT', 'دوره فقط رو به جلو بسته می‌شود؛ تا ' + fmtD(cur) + ' قبلاً بسته شده است.');
      var hc = healthCheck();
      if (hc.critical) throw AppError('PERIOD_HEALTH', 'بررسی سلامت ' + hc.critical + ' مشکل جدی نشان می‌دهد؛ تا رفع آن، دوره بسته نمی‌شود.', { issues: hc.issues.filter(function (x) { return x.severity === 'critical'; }) });
      var bk = o.backup;
      if (!bk || typeof bk.hash !== 'string' || bk.hash.length < 16 || (bk.evidence !== 'user' && bk.evidence !== 'verified'))
        throw AppError('NEED_BACKUP', 'پیش از بستن دوره، فایل پشتیبان باید ساخته و ذخیره آن تأیید شود.');
      if (bk.version !== VER) throw AppError('STALE_BACKUP', 'پس از ساخت فایل پشتیبان، اطلاعات تغییر کرده است؛ دوباره پشتیبان بگیرید.');
      // v2.1.1: a closed period must not freeze an unintended NEGATIVE stock (e.g. a back-dated sale before its receipt)
      var neg = negativeStockAsOf(through);
      if (neg.length && !(o.negativeOk && normText(o.negativeOk.reason)))
        throw AppError('PERIOD_NEG_STOCK', 'موجودی ' + neg.length + ' کالا در پایان این دوره منفی است (' + neg.slice(0, 3).map(function (x) { return '«' + x.name + '»: ' + x.qty; }).join('، ') + (neg.length > 3 ? '، …' : '') + '). معمولاً یعنی فروشی با تاریخی پیش از تاریخ ثبت ورود همان کالا ثبت شده است. اگر کالا واقعاً در آن تاریخ موجود بوده، با ذکر علت تأیید کنید؛ وگرنه پیش از بستن بررسی کنید.', { items: neg });
      var from = cur != null ? cur + 1 : null, summary = periodSummary(from, through), fp = periodFingerprint(through);
      var tx = new Tx(); tx.allowPeriods = true;
      var m = tx.get('meta', 'periods') || tx.put('meta', { id: 'periods', v: { closedThrough: null, history: [] } });
      var entry = { action: 'close', through: through, from: from, prev: cur, at: now(), by: who(ctx), reason: str(o.reason), algo: PERIOD_ALGO, summary: summary, fp: fp,
        backup: { hash: bk.hash, at: bk.at || null, evidence: bk.evidence } };
      if (neg.length) entry.negativeStock = { items: neg, reason: str(o.negativeOk.reason) };
      m.v.history = (m.v.history || []).concat([entry]); m.v.closedThrough = through; m.updatedAt = now();
      audit(tx, 'period', 'periods', 'close', { closedThrough: cur }, { closedThrough: through, backupEvidence: bk.evidence }, ctx);
      return { entry: entry, changes: tx.commit() };
    }
    /* reopen back to `o.to` (an earlier close point or null = fully open). The caller keeps a safety snapshot first. */
    function reopenPeriod(o, ctx) {
      requireManager(ctx, 'بازگشایی دوره مالی');
      o = o || {};
      var cur = closedThrough(); if (cur == null) throw AppError('BAD_INPUT', 'دوره بسته‌ای وجود ندارد.');
      if (!normText(o.reason)) throw AppError('BAD_INPUT', 'علت بازگشایی الزامی است.');
      var to = o.to == null ? null : o.to;
      if (to != null && (typeof to !== 'number' || to >= cur)) throw AppError('BAD_INPUT', 'تاریخ بازگشایی باید پیش از تاریخ بسته‌شدن فعلی باشد.');
      var tx = new Tx(); tx.allowPeriods = true;
      var m = tx.get('meta', 'periods');
      var entry = { action: 'reopen', from: cur, to: to, at: now(), by: who(ctx), reason: str(o.reason), snapshot: o.snapshot || null };
      m.v.history = (m.v.history || []).concat([entry]); m.v.closedThrough = to; m.updatedAt = now();
      audit(tx, 'period', 'periods', 'reopen', { closedThrough: cur }, { closedThrough: to, reason: entry.reason }, ctx);
      return { entry: entry, changes: tx.commit() };
    }
    function allBalances() {
      var m = {};
      for (var id in S.docs) { var d = S.docs[id]; if (d.kind === 'out' && d.type === SALE && d.customerId) m[d.customerId] = (m[d.customerId] || 0) + d.balance; }
      return m;
    }
    function customerBalance(customerId) {
      var bal = 0;
      for (var id in S.docs) { var d = S.docs[id]; if (d.kind === 'out' && d.type === SALE && d.customerId === customerId) bal += d.balance; }
      return bal;
    }
    function customerStatement(customerId) {
      var docs = allDocs().filter(function (d) { return d.kind === 'out' && d.type === SALE && d.customerId === customerId; });
      var returns = allDocs().filter(function (d) { return d.kind === 'return' && d.customerId === customerId; });
      var pays = Object.keys(S.payments).map(function (k) { return S.payments[k]; }).filter(function (p) { return p.customerId === customerId; }).sort(function (a, b) { return a.ts - b.ts || a.createdAt - b.createdAt; });
      var sold = docs.filter(function (d) { return d.status !== 'reversed'; }).reduce(function (s, d) { return s + d.total - (d.returned || 0); }, 0);
      return { customer: S.customers[customerId], docs: docs, returns: returns, payments: pays, totalSales: sold, balance: customerBalance(customerId) };
    }
    function debtors() {
      var b = allBalances();
      return Object.keys(S.customers).map(function (id) { return { customer: S.customers[id], balance: b[id] || 0 }; })
        .filter(function (r) { return r.balance > 0; }).sort(function (a, b) { return b.balance - a.balance; });
    }
    // Profit on NET amounts (after line + invoice discount). Lines with unknown cost are excluded and counted.
    function grossProfit(f) {
      var rows = salesLines(f), profit = 0, known = 0, unknown = 0, knownSales = 0, unknownSales = 0;
      rows.forEach(function (r) {
        if (r.costTotal == null) { unknown++; unknownSales += r.net; r.profit = null; r.cost = null; return; }
        r.cost = r.costTotal; r.profit = r.net - r.costTotal; profit += r.profit; known++; knownSales += r.net;
      });
      return { rows: rows, profit: profit, knownLines: known, unknownLines: unknown, knownSales: knownSales, unknownSales: unknownSales, complete: unknown === 0 };
    }
    function topProducts(f) {
      var m = {};
      salesLines(f).forEach(function (r) { var x = m[r.productId] || (m[r.productId] = { productId: r.productId, sku: r.sku, name: r.name, brand: r.brand, qty: 0, amount: 0 }); x.qty += r.qty; x.amount += r.net; });
      return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.qty - a.qty; });
    }
    function paymentsReport(f) {
      f = f || {};
      return Object.keys(S.payments).map(function (k) { return S.payments[k]; })
        .filter(function (p) { return inRange(p.ts, f) && (!f.customerId || p.customerId === f.customerId) && (!f.method || p.method === f.method) && (f.includeTransfers || p.method !== 'credit_transfer'); })
        .sort(function (a, b) { return a.ts - b.ts || a.createdAt - b.createdAt; })
        .map(function (p) {
          var d = S.docs[p.docId], c = S.customers[p.customerId];
          return { no: p.no, ts: p.ts, kind: p.kind, amount: p.amount, signed: p.kind === 'refund' ? -p.amount : p.amount, method: p.method,
            methodLabel: PAY_METHODS[p.method] || p.method, ref: p.ref, note: p.note, invoiceNo: d ? d.invoiceNo : '', docId: p.docId,
            customer: c ? c.name : '', customerId: p.customerId, customerType: c ? c.type : '', user: p.user };
        });
    }
    function reconcile() {
      var sums = {}, bad = [];
      Object.keys(S.movements).forEach(function (k) { var m = S.movements[k]; sums[m.productId] = (sums[m.productId] || 0) + m.qty; });
      Object.keys(S.products).forEach(function (id) {
        var calc = sums[id] || 0;
        if (calc !== S.products[id].stock) bad.push({ productId: id, name: S.products[id].name, stored: S.products[id].stock, calculated: calc });
      });
      return bad;
    }

    /* Data health check: verifies every invariant; NEVER changes data. severity: critical | warning | info */
    function healthCheck(o) {
      o = o || {}; // o.periodHash === false: skip the (slower) fingerprint, keep the recomputed summary check
      var issues = [];
      function add(sev, code, msg, ref) { issues.push({ severity: sev, code: code, message: msg, ref: ref || null }); }
      reconcile().forEach(function (b) { add('critical', 'STOCK_MOVEMENTS', 'موجودی ثبت‌شده «' + b.name + '» (' + b.stored + ') با جمع گردش‌ها (' + b.calculated + ') برابر نیست.', { productId: b.productId }); });
      Object.keys(S.products).forEach(function (id) {
        var p = S.products[id], L = p.layers || [];
        var lq = L.reduce(function (s, l) { return s + l.qty; }, 0);
        if (p.stock >= 0 && lq !== p.stock) add('critical', 'LAYERS', 'لایه‌های بهای «' + p.name + '» (' + lq + ') با موجودی (' + p.stock + ') برابر نیست.', { productId: id });
        if (L.some(function (l) { return !(l.qty > 0) || (l.cost != null && !isMoney(l.cost)); })) add('critical', 'LAYER_VALUE', 'لایه بهای نامعتبر در «' + p.name + '».', { productId: id });
        var b = 0, q = 0; L.forEach(function (l) { if (l.cost != null) { b += l.cost * l.qty; q += l.qty; } });
        if (b !== (p.costBasis || 0) || q !== (p.costedQty || 0)) add('critical', 'COST_SUM', 'جمع بهای «' + p.name + '» با لایه‌ها برابر نیست.', { productId: id });
        if (p.stock < 0) add('warning', 'NEG_STOCK', 'موجودی منفی: «' + p.name + '» (' + p.stock + ').', { productId: id });
        if (p.categoryId && !S.categories[p.categoryId]) add('warning', 'REF_CATEGORY', 'گروه کالای «' + p.name + '» وجود ندارد.', { productId: id });
        if (p.supplierId && !S.suppliers[p.supplierId]) add('warning', 'REF_SUPPLIER', 'تأمین‌کننده کالای «' + p.name + '» وجود ندارد.', { productId: id });
        (p.barcodes || []).forEach(function (code) { if (!S.meta.barcodes || S.meta.barcodes.v[code] !== id) add('warning', 'BARCODE_MAP', 'بارکد ' + code + ' در فهرست بارکدها ثبت نشده.', { productId: id }); });
      });
      if (S.meta.barcodes) Object.keys(S.meta.barcodes.v).forEach(function (code) { var pid = S.meta.barcodes.v[code]; if (!S.products[pid]) add('warning', 'BARCODE_ORPHAN', 'بارکد ' + code + ' به کالای ناموجود اشاره دارد.'); });
      var pubSeen = {}, skuSeen = {};
      Object.keys(S.products).forEach(function (id) {
        var p = S.products[id];
        if (p.publicCode) { if (pubSeen[p.publicCode]) add('critical', 'PUBLIC_DUP', 'کد عمومی تکراری: ' + p.publicCode); pubSeen[p.publicCode] = 1; }
        var k = normSku(p.sku); if (skuSeen[k]) add('warning', 'SKU_DUP', 'کد کالای تکراری: ' + p.sku); skuSeen[k] = 1;
      });
      // payments per invoice
      var paid = {}, refunded = {}, returned = {}, retDocs = {};
      Object.keys(S.payments).forEach(function (k) {
        var pm = S.payments[k];
        if (!S.docs[pm.docId]) { add('critical', 'REF_PAYMENT', 'پرداخت ' + pm.no + ' به سند ناموجود اشاره دارد.'); return; }
        if (pm.kind === 'receipt') paid[pm.docId] = (paid[pm.docId] || 0) + pm.amount; else refunded[pm.docId] = (refunded[pm.docId] || 0) + pm.amount;
      });
      var nums = {};
      Object.keys(S.docs).forEach(function (k) {
        var d = S.docs[k];
        if (nums[d.no]) add('critical', 'DOC_NO_DUP', 'شماره سند تکراری: ' + d.no); nums[d.no] = 1;
        if (d.invoiceNo && d.kind === 'out') { if (nums[d.invoiceNo]) add('critical', 'DOC_NO_DUP', 'شماره فاکتور تکراری: ' + d.invoiceNo); nums[d.invoiceNo] = 1; }
        (d.lines || []).forEach(function (l) { if (!S.products[l.productId]) add('critical', 'REF_PRODUCT', 'سند ' + d.no + ' به کالای ناموجود اشاره دارد.', { docId: d.id }); });
        if (d.customerId && !S.customers[d.customerId]) add('critical', 'REF_CUSTOMER', 'سند ' + d.no + ' به مشتری ناموجود اشاره دارد.', { docId: d.id });
        if (d.kind === 'return') {
          if (!S.docs[d.invoiceId]) add('critical', 'REF_INVOICE', 'مرجوعی ' + d.no + ' به فاکتور ناموجود اشاره دارد.', { docId: d.id });
          else if (d.status !== 'reversed') { returned[d.invoiceId] = (returned[d.invoiceId] || 0) + d.total; (retDocs[d.invoiceId] = retDocs[d.invoiceId] || []).push(d); }
        }
        if (d.status === 'reversed' && (!d.reversedBy || !S.docs[d.reversedBy])) add('critical', 'REF_REVERSAL', 'سند برگشتی ' + d.no + ' سند برگشت ندارد.', { docId: d.id });
        if (d.kind === 'cost') d.lines.forEach(function (l) { // v2.2
          if (l.srcDocId && !S.docs[l.srcDocId]) add('critical', 'REF_COST_SRC', 'سند تکمیل بها ' + d.no + ' به سند ورود ناموجود اشاره دارد.', { docId: d.id });
          if (!isMoney(l.unitCost) || !l.unitCost) add('critical', 'COST_VALUE', 'بهای نامعتبر در سند تکمیل بها ' + d.no + '.', { docId: d.id });
        });
      });
      Object.keys(S.docs).forEach(function (k) {
        var d = S.docs[k]; if (!(d.kind === 'out' && d.type === SALE)) return;
        var sub = d.lines.reduce(function (s, l) { return s + l.lineTotal; }, 0);
        if (sub !== d.subtotal || d.subtotal - d.discount !== d.total) add('critical', 'INV_TOTAL', 'جمع فاکتور ' + d.invoiceNo + ' با اقلام آن برابر نیست.', { docId: d.id });
        if (d.lines.every(function (l) { return l.net != null; }) && d.lines.reduce(function (s, l) { return s + l.net; }, 0) !== d.total) add('critical', 'INV_NET', 'سهم تخفیف ردیف‌های فاکتور ' + d.invoiceNo + ' با مبلغ فاکتور برابر نیست.', { docId: d.id });
        if ((paid[d.id] || 0) !== d.paid || (refunded[d.id] || 0) !== d.refunded) add('critical', 'INV_PAID', 'مبلغ پرداخت‌شده فاکتور ' + d.invoiceNo + ' با پرداخت‌های ثبت‌شده برابر نیست.', { docId: d.id });
        if ((returned[d.id] || 0) !== (d.returned || 0)) add('critical', 'INV_RETURNED', 'مبلغ مرجوعی فاکتور ' + d.invoiceNo + ' با اسناد مرجوعی برابر نیست.', { docId: d.id });
        if (d.balance !== effectiveTotal(d) - (d.paid - d.refunded)) add('critical', 'INV_BALANCE', 'مانده فاکتور ' + d.invoiceNo + ' نادرست است.', { docId: d.id });
        d.lines.forEach(function (l) { if ((l.returnedQty || 0) > l.qty || (l.returnedQty || 0) < 0) add('critical', 'INV_RETQTY', 'تعداد مرجوعی ردیف «' + l.name + '» در ' + d.invoiceNo + ' نامعتبر است.', { docId: d.id }); });
        // v2.1.1: the stored return state of every line must agree with its active return documents
        d.lines.forEach(function (l, li) { var bad = returnStateIssue(d, li, retDocs[d.id] || []); if (bad) add('critical', 'INV_RETURN_STATE', 'اطلاعات مرجوعی ردیف «' + l.name + '» در ' + d.invoiceNo + ' با اسناد مرجوعی آن سازگار نیست (' + bad + ')؛ مرجوعی جدید این ردیف ثبت نمی‌شود.', { docId: d.id, line: li }); });
      });
      Object.keys(S.movements).forEach(function (k) { var m = S.movements[k]; if (!S.docs[m.docId]) add('critical', 'REF_MOVEMENT', 'گردش کالا به سند ناموجود اشاره دارد (' + m.docNo + ').'); if (!S.products[m.productId]) add('critical', 'REF_MOVEMENT', 'گردش به کالای ناموجود اشاره دارد (' + m.docNo + ').'); });
      Object.keys(S.ops).forEach(function (k) { var o = S.ops[k]; if (!(o.store ? S[o.store] && S[o.store][o.docId] : S.docs[o.docId])) add('warning', 'REF_OP', 'کلید عملیات به سند ناموجود اشاره دارد.'); });
      dealsHealth(add); // v2.5
      // counters must be ahead of every number in use, otherwise the next document would reuse a number
      var cnt = (S.meta.counters && S.meta.counters.v) || {}, pref = { 'IN-': 'in', 'OUT-': 'out', 'INV-': 'inv', 'REV-': 'rev', 'ADJ-': 'adj', 'RET-': 'ret', 'PAY-': 'pay', 'CST-': 'cst' }, maxN = {};
      function track(no) { if (!no) return; Object.keys(pref).forEach(function (pfx) { if (no.indexOf(pfx) === 0) { var n = parseInt(no.slice(pfx.length), 10); if (n > (maxN[pref[pfx]] || 0)) maxN[pref[pfx]] = n; } }); }
      Object.keys(S.docs).forEach(function (k) { track(S.docs[k].no); track(S.docs[k].invoiceNo); });
      Object.keys(S.payments).forEach(function (k) { track(S.payments[k].no); });
      Object.keys(maxN).forEach(function (key) { if ((cnt[key] || 0) < maxN[key]) add('critical', 'COUNTER', 'شمارنده اسناد (' + key + ') از آخرین شماره عقب‌تر است.'); });
      Object.keys(S.categories).forEach(function (id) {
        var c = S.categories[id], seen = {}, x = c, hops = 0;
        if (c.parentId && !S.categories[c.parentId]) add('warning', 'REF_PARENT', 'والد گروه «' + c.name + '» وجود ندارد.');
        while (x && x.parentId && hops++ < 100) { if (seen[x.id]) { add('critical', 'CAT_CYCLE', 'گروه «' + c.name + '» حلقه دارد.'); break; } seen[x.id] = 1; x = S.categories[x.parentId]; }
      });
      // v2.1: the closed period must still be exactly what was closed (fingerprint + recomputed summary)
      if (closedThrough() != null) {
        var ac = activeClose();
        if (!ac) add('warning', 'PERIOD_HISTORY', 'سابقه بستن دوره فعلی پیدا نشد؛ اثر انگشت دوره قابل بررسی نیست.');
        else {
          try {
            if (o.periodHash !== false && periodFingerprint(ac.through, ac.algo) !== ac.fp) add('critical', 'PERIOD_FP', 'اطلاعات دوره مالی بسته‌شده (تا ' + fmtD(ac.through) + ') پس از بستن تغییر کرده است (اثر انگشت یکسان نیست).');
            if (canon(periodSummary(ac.from, ac.through, ac.algo)) !== canon(ac.summary)) add('critical', 'PERIOD_SUMMARY', 'خلاصه دوره بسته‌شده (تا ' + fmtD(ac.through) + ') با محاسبه دوباره برابر نیست.');
          } catch (e) { add('warning', 'PERIOD_CHECK', 'بررسی دوره بسته ممکن نشد: ' + e.message); }
        }
      }
      var crit = issues.filter(function (i) { return i.severity === 'critical'; }).length;
      return { ok: crit === 0, critical: crit, warnings: issues.length - crit, issues: issues };
    }

    // ---------- v2.5 direct deals (buy & sell outside the warehouse) + party accounts ----------
    /* Deals and the party ledger live in their own stores ('deals', 'ledger'). They NEVER write movements, products or
       stock layers, so physical stock and stock value are untouched by construction. Every record is immutable once
       posted: corrections are new records (return / cancel legs, reversal entries) dated when they are made.
       Balance sign everywhere: + = the party owes us (بدهکار), − = we owe the party (بستانکار). */
    var PARTY = { customer: 'customers', supplier: 'suppliers' };
    var LG_KINDS = { opening: 'مانده اول دوره', bill: 'بدهی خرید (فاکتور ورود)', payment: 'پرداخت به طرف حساب', receipt: 'دریافت از طرف حساب', adjust: 'تعدیل مانده',
      settle: 'تسویه از پیش‌پرداخت / بستانکاری', expense: 'هزینه نقدی معامله', reversal: 'ابطال' };
    function partyRec(t, id) { return PARTY[t] && id ? S[PARTY[t]][id] || null : null; }
    function needParty(t, id) { if (!partyRec(t, id)) throw AppError('NOT_FOUND', 'طرف حساب پیدا نشد.'); }
    function itemKey(name, code) { var c = normSku(code || ''); return c ? 'c:' + c : 'n:' + normText(name); }
    function existingOp2(opKey) {
      var o = S.ops[opKey]; if (!o) return null;
      var rec = o.store && S[o.store] ? S[o.store][o.docId] || null : null;
      return { duplicate: true, id: o.docId, store: o.store || null, rec: rec, changes: [] };
    }
    function dueOf(v) {
      if (v == null || v === '') return null;
      if (typeof v !== 'number' || !isFinite(v) || v <= 0) throw AppError('BAD_INPUT', 'تاریخ سررسید نامعتبر است.');
      return v;
    }
    function listOf(st, fn) { var out = []; for (var k in S[st]) { var r = S[st][k]; if (!fn || fn(r)) out.push(r); } return out.sort(function (a, b) { return a.ts - b.ts || (a.createdAt || 0) - (b.createdAt || 0); }); }
    function legsOf(dealId) { return listOf('deals', function (r) { return r.rt === 'leg' && r.dealId === dealId; }); }
    function cancelOf(legId) { for (var k in S.deals) { var r = S.deals[k]; if (r.rt === 'leg' && r.type === 'cancel' && r.refLegId === legId) return r; } return null; }
    function reversalOf(entryId) { for (var k in S.ledger) { var r = S.ledger[k]; if (r.kind === 'reversal' && r.reverses === entryId) return r; } return null; }

    /* signed effects of one leg: items {key: {q, v}} (v = cost for buys, net income for sells), party balance, direct cost */
    function legEffects(leg) {
      if (leg.type === 'cancel') {
        var o = S.deals[leg.refLegId], e = o ? legEffects(o) : { items: {}, bal: 0, direct: 0, cash: 0 }, it = {};
        Object.keys(e.items).forEach(function (k) { it[k] = { q: -e.items[k].q, v: -e.items[k].v, name: e.items[k].name, code: e.items[k].code }; });
        return { items: it, bal: -e.bal, direct: -e.direct };
      }
      var buy = leg.side === 'buy', ret = leg.type === 'return', items = {};
      leg.lines.forEach(function (l) {
        var x = items[l.key] || (items[l.key] = { q: 0, v: 0, name: l.name, code: l.code });
        var s = ret ? -1 : 1;
        x.q += s * l.qty; x.v += s * (buy ? (ret ? l.net : l.cost) : l.net);
      });
      var amt = ret ? leg.net : leg.payable;
      return { items: items, bal: (buy ? -1 : 1) * (ret ? -1 : 1) * amt, direct: !buy && !ret ? leg.costTotal : 0 };
    }
    /* open (unsettled) amount of a posted leg after its returns and cancellation */
    function legOpenAmount(leg) {
      if (leg.type !== 'post' || cancelOf(leg.id)) return 0;
      var a = leg.payable;
      for (var k in S.deals) { var r = S.deals[k]; if (r.rt === 'leg' && r.type === 'return' && r.refLegId === leg.id && !cancelOf(r.id)) a -= r.net; }
      return Math.max(0, a);
    }
    /* deal state from its legs dated ≤ X (null = all) */
    function dealCalc(dealId, X) {
      var legs = legsOf(dealId).filter(function (l) { return X == null || l.ts <= X; });
      var items = {}, direct = 0, lastBuyTs = {};
      legs.forEach(function (leg) {
        var e = legEffects(leg), side = leg.type === 'cancel' ? (S.deals[leg.refLegId] || {}).side : leg.side;
        direct += e.direct;
        Object.keys(e.items).forEach(function (k) {
          var x = items[k] || (items[k] = { key: k, name: e.items[k].name, code: e.items[k].code, boughtQ: 0, cost: 0, soldQ: 0, income: 0, hasBuy: false, sellEv: [] });
          if (side === 'buy') { x.boughtQ += e.items[k].q; x.cost += e.items[k].v; x.hasBuy = true; lastBuyTs[k] = leg.ts; }
          else { x.soldQ += e.items[k].q; x.income += e.items[k].v; x.sellEv.push({ ts: leg.ts, q: e.items[k].q, v: e.items[k].v, legId: leg.id }); }
        });
      });
      var income = 0, cogs = 0, uncertain = false, open = false, uncertainIncome = 0;
      Object.keys(items).forEach(function (k) {
        var x = items[k];
        x.openQ = x.boughtQ - x.soldQ;
        if (x.soldQ > 0 && (!x.hasBuy || x.soldQ > x.boughtQ)) { x.status = 'uncertain'; x.cogs = null; uncertain = true; uncertainIncome += x.income; }
        else if (x.boughtQ > 0) { x.cogs = Math.round(x.cost * x.soldQ / x.boughtQ); x.status = x.openQ > 0 ? 'open' : 'closed'; if (x.openQ > 0) open = true; }
        else { x.cogs = x.hasBuy ? x.cost : 0; x.status = 'closed'; } // everything returned: the remaining (sunk) costs are a loss
        x.lastBuyTs = lastBuyTs[k] || null;
        income += x.income; if (x.cogs != null) cogs += x.cogs;
      });
      var profit = uncertain ? null : income - cogs - direct;
      return { items: items, income: income, cogs: uncertain ? null : cogs, cogsKnown: cogs, direct: direct, profit: profit, uncertain: uncertain, uncertainIncome: uncertainIncome,
        open: open, legs: legs };
    }
    /* every allocation of non-reversed payments / receipts / settlements: {'leg:<id>' | 'bill:<id>' | 'opening:<id>': amount} */
    function reversedSet() { var m = {}; for (var k in S.ledger) { var r = S.ledger[k]; if (r.kind === 'reversal') m[r.reverses] = r; } return m; }
    function allocations() {
      var m = {}, rv = reversedSet();
      for (var k in S.ledger) {
        var e = S.ledger[k]; if (!e.alloc || rv[e.id]) continue;
        e.alloc.forEach(function (a) { if (a.t !== 'sale') m[a.t + ':' + a.id] = (m[a.t + ':' + a.id] || 0) + a.amount; });
      }
      return m;
    }
    function dealSettle(dealId, al) {
      al = al || allocations(); var open = 0, total = 0;
      legsOf(dealId).forEach(function (l) { if (l.type !== 'post') return; var a = legOpenAmount(l); total += a; open += Math.max(0, a - (al['leg:' + l.id] || 0)); });
      return { total: total, remaining: open, status: !total || !open ? 'settled' : open < total ? 'partial' : 'unsettled' };
    }
    function dealView(dealId, X) {
      var d = S.deals[dealId]; if (!d || d.rt !== 'deal') return null;
      var c = dealCalc(dealId, X), al = allocations();
      var legs = c.legs.map(function (l) {
        var cx = cancelOf(l.id), a = l.type === 'post' ? legOpenAmount(l) : 0, got = al['leg:' + l.id] || 0;
        return Object.assign({}, l, { cancelled: !!cx, cancelNo: cx ? cx.no : '', open: a, allocated: got, remaining: Math.max(0, a - got),
          party: partyRec(l.partyType, l.partyId) });
      });
      var cancelledAll = legs.length > 0 && legs.every(function (l) { return l.type !== 'post' || l.cancelled; });
      return Object.assign({ deal: d, settle: dealSettle(dealId, al), status: cancelledAll ? 'cancelled' : c.uncertain ? 'uncertain' : c.open ? 'open' : 'closed' }, c, { legs: legs });
    }
    /* f: {from, to, customerId, supplierId, item (text), settle: settled|partial|unsettled, profit: definite|uncertain|loss|gain, status} */
    function dealsList(f) {
      f = f || {}; var al = allocations(), q = normText(f.item || '');
      return listOf('deals', function (r) { return r.rt === 'deal'; }).map(function (d) {
        var v = dealView(d.id), lg = v.legs;
        var first = lg.length ? lg[0].ts : d.ts, last = lg.length ? lg[lg.length - 1].ts : d.ts;
        return { id: d.id, no: d.no, title: d.title, ts: d.ts, first: first, last: last, status: v.status, income: v.income, cogs: v.cogs, direct: v.direct, profit: v.profit,
          uncertain: v.uncertain, settle: dealSettle(d.id, al), items: v.items, legs: lg };
      }).filter(function (x) {
        if (f.from != null && x.last < f.from) return false;
        if (f.to != null && x.first > f.to) return false;
        if (f.customerId && !x.legs.some(function (l) { return l.partyType === 'customer' && l.partyId === f.customerId; })) return false;
        if (f.supplierId && !x.legs.some(function (l) { return l.partyType === 'supplier' && l.partyId === f.supplierId; })) return false;
        if (q && !(normText(x.title).indexOf(q) >= 0 || Object.keys(x.items).some(function (k) { var it = x.items[k]; return normText(it.name).indexOf(q) >= 0 || normSku(it.code || '').indexOf(normSku(q)) >= 0; }))) return false;
        if (f.settle && x.settle.status !== f.settle) return false;
        if (f.status && x.status !== f.status) return false;
        if (f.profit === 'definite' && x.uncertain) return false;
        if (f.profit === 'uncertain' && !x.uncertain) return false;
        if (f.profit === 'loss' && !(x.profit != null && x.profit < 0)) return false;
        if (f.profit === 'gain' && !(x.profit != null && x.profit > 0)) return false;
        return true;
      });
    }
    /* deal profit recognised in (from, to]: income and direct costs on their own dates; cost of goods sold by the average
       cost of the deal's purchases dated ≤ to (cumulative rounding, so the periods add up for a fixed cost basis). */
    function dealsPL(f) {
      f = f || {}; var X = f.to != null ? f.to : null;
      var s = { income: 0, cogs: 0, direct: 0, profit: 0, uncertainIncome: 0, uncertainDirect: 0, uncertainDeals: 0, deals: 0, rows: [] };
      listOf('deals', function (r) { return r.rt === 'deal'; }).forEach(function (d) {
        var c = dealCalc(d.id, X), inc = 0, cg = 0, dir = 0, unc = 0;
        c.legs.forEach(function (l) { if (inRange(l.ts, f)) dir += legEffects(l).direct; });
        Object.keys(c.items).forEach(function (k) {
          var x = c.items[k], qb = 0, qa = 0, before = 0;
          x.sellEv.forEach(function (ev) { if (f.from != null && ev.ts < f.from) before += ev.q; });
          x.sellEv.forEach(function (ev) { if (inRange(ev.ts, f)) { qa += ev.q; if (x.status === 'uncertain') unc += ev.v; else inc += ev.v; } });
          if (x.status === 'uncertain') return;
          if (x.boughtQ > 0) { qb = before; cg += Math.round(x.cost * (qb + qa) / x.boughtQ) - Math.round(x.cost * qb / x.boughtQ); }
          else if (x.hasBuy && x.lastBuyTs != null && inRange(x.lastBuyTs, f)) cg += x.cost; // sunk costs of a fully returned purchase
        });
        if (!inc && !cg && !dir && !unc) return;
        s.deals++;
        if (c.uncertain) { // «سود هنوز قطعی نیست»: nothing of this deal enters the definite profit
          s.uncertainDeals++; s.uncertainIncome += inc + unc; s.uncertainDirect += dir;
          s.rows.push({ dealId: d.id, no: d.no, title: d.title, income: inc + unc, cogs: null, direct: dir, profit: null, uncertain: true });
          return;
        }
        s.income += inc; s.cogs += cg; s.direct += dir;
        s.rows.push({ dealId: d.id, no: d.no, title: d.title, income: inc, cogs: cg, direct: dir, profit: inc - cg - dir, uncertain: false });
      });
      s.profit = s.income - s.cogs - s.direct;
      return s;
    }
    function legCalc(side, lines, discount, costs) {
      var gross = 0;
      lines.forEach(function (l) { l.amount = l.qty * l.unitPrice; gross += l.amount; });
      if (discount > gross) throw AppError('BAD_INPUT', 'تخفیف از جمع اقلام بیشتر است.');
      var dA = allocExact(discount, lines.map(function (l) { return l.amount; })) || lines.map(function () { return 0; });
      lines.forEach(function (l, i) { l.net = l.amount - dA[i]; });
      var all = 0, party = 0, cash = 0;
      costs.forEach(function (c) { all += c.amount; if (c.payTo === 'party') party += c.amount; else cash += c.amount; });
      if (side === 'buy') {
        var w = lines.map(function (l) { return l.net; }), cA = allocExact(all, w) || allocExact(all, lines.map(function (l) { return l.qty; }));
        lines.forEach(function (l, i) { l.cost = l.net + cA[i]; });
      }
      return { gross: gross, discount: discount, net: gross - discount, payable: gross - discount + party, costTotal: all, cashCosts: cash, partyCosts: party };
    }
    function payIn(pm, what) {
      if (!pm || pm.amount == null || pm.amount === '' || pm.amount === 0) return null;
      if (!isMoney(pm.amount)) throw AppError('BAD_INPUT', 'مبلغ ' + what + ' نامعتبر است.');
      var m = pm.method || 'cash';
      if (!PAY_METHODS[m] || m === 'credit_transfer' || m === 'credit') throw AppError('BAD_INPUT', 'روش پرداخت نامعتبر است.');
      return { amount: pm.amount, method: m, ref: str(pm.ref) };
    }
    function lgInsert(tx, e, ctx) {
      var rec = Object.assign({ id: tx.id('ledger'), no: 'LG-' + pad(counterNext(tx, 'lg'), 6), partyType: null, partyId: null, amount: 0, dir: 0, method: null, ref: '', note: '',
        dueDate: null, docId: null, legId: null, alloc: [], saleAlloc: 0, auto: false, user: who(ctx), source: src(ctx), createdAt: now() }, e);
      tx.insert('ledger', rec); return rec;
    }
    /* new leg of a direct deal (creates the deal when d.dealId is empty). d: {opKey, dealId?, title?, side: buy|sell, partyId,
       ts, invoiceNo, lines: [{name, code, qty, unitPrice}], discount, costs: [{title, amount, payTo: party|cash}], dueDate, note,
       pay: {amount, method, ref} (paid / received now), duplicateOk: {reason}} */
    function postDealLeg(d, ctx) {
      checkOpKey(d.opKey);
      var ex = existingOp2(d.opKey); if (ex) return ex;
      var side = d.side; if (side !== 'buy' && side !== 'sell') throw AppError('BAD_INPUT', 'نوع ردیف معامله (خرید/فروش) نامعتبر است.');
      var pt = side === 'buy' ? 'supplier' : 'customer'; needParty(pt, d.partyId);
      if (d.dealId && !(S.deals[d.dealId] && S.deals[d.dealId].rt === 'deal')) throw AppError('NOT_FOUND', 'معامله پیدا نشد.');
      if (!d.lines || !d.lines.length) throw AppError('BAD_INPUT', 'هیچ قلمی وارد نشده است.');
      var lines = d.lines.map(function (l) {
        var name = str(l.name); if (!name) throw AppError('BAD_INPUT', 'نام کالا الزامی است.');
        if (!isQty(l.qty)) throw AppError('BAD_INPUT', 'تعداد باید عدد صحیح مثبت باشد.');
        if (!isMoney(l.unitPrice)) throw AppError('BAD_INPUT', 'قیمت واحد «' + name + '» نامعتبر است.');
        return { key: itemKey(name, l.code), name: name, code: str(l.code), qty: l.qty, unitPrice: l.unitPrice };
      });
      var disc = d.discount == null || d.discount === '' ? 0 : d.discount; if (!isMoney(disc)) throw AppError('BAD_INPUT', 'تخفیف نامعتبر است.');
      var costs = (d.costs || []).filter(function (c) { return c && c.amount; }).map(function (c) {
        if (!isMoney(c.amount)) throw AppError('BAD_INPUT', 'مبلغ هزینه نامعتبر است.');
        return { title: str(c.title) || 'هزینه', amount: c.amount, payTo: side === 'buy' && c.payTo === 'party' ? 'party' : 'cash' };
      });
      var calc = legCalc(side, lines, disc, costs), pay = payIn(d.pay, side === 'buy' ? 'پرداختی' : 'دریافتی');
      if (pay && pay.amount > calc.payable) throw AppError('OVERPAY', 'مبلغ ' + (side === 'buy' ? 'پرداختی' : 'دریافتی') + ' از جمع فاکتور (' + calc.payable + ') بیشتر است.');
      var ts = docDate(d.ts, ctx, side === 'buy' ? 'خرید مستقیم' : 'فروش مستقیم'), inv = str(d.invoiceNo);
      if (inv) {
        var k = invKeyStrict(inv), dup = listOf('deals', function (r) { return r.rt === 'leg' && r.type === 'post' && r.side === side && r.partyId === d.partyId && invKeyStrict(r.invoiceNo) === k && !cancelOf(r.id); });
        if (dup.length && !managerOk(d.duplicateOk, ctx))
          throw AppError('DUPLICATE_INVOICE', 'این شماره فاکتور برای همین طرف حساب قبلاً در معامله ' + dup[0].no + ' ثبت شده است.', { matches: dup.map(function (x) { return { id: x.id, no: x.no }; }) });
      }
      var tx = new Tx(), deal;
      if (d.dealId) deal = S.deals[d.dealId];
      else {
        deal = { id: tx.id('deals'), rt: 'deal', no: 'DL-' + pad(counterNext(tx, 'deal'), 6), ts: ts, title: str(d.title) || lines[0].name, note: str(d.note),
          user: who(ctx), source: src(ctx, d), opKey: d.opKey, createdAt: now() };
        tx.insert('deals', deal);
      }
      var leg = Object.assign({ id: tx.id('deals'), rt: 'leg', dealId: deal.id, no: (side === 'buy' ? 'DLB-' : 'DLS-') + pad(counterNext(tx, 'dleg'), 6), ts: ts,
        side: side, type: 'post', partyType: pt, partyId: d.partyId, invoiceNo: inv, lines: lines, costs: costs, dueDate: dueOf(d.dueDate), note: str(d.note),
        refLegId: null, reason: '', user: who(ctx), source: src(ctx, d), opKey: d.opKey, createdAt: now() }, calc);
      if (inv && d.duplicateOk && managerOk(d.duplicateOk, ctx)) leg.duplicateOverride = { reason: str(d.duplicateOk.reason) };
      tx.insert('deals', leg);
      var auto = [];
      if (calc.cashCosts) auto.push(lgInsert(tx, { kind: 'expense', ts: ts, amount: calc.cashCosts, method: 'cash', legId: leg.id, auto: true,
        note: 'هزینه‌های نقدی ' + leg.no + ' (' + costs.filter(function (c) { return c.payTo === 'cash'; }).map(function (c) { return c.title; }).join('، ') + ')' }, ctx));
      if (pay) auto.push(lgInsert(tx, { kind: side === 'buy' ? 'payment' : 'receipt', ts: ts, partyType: pt, partyId: d.partyId, amount: pay.amount, method: pay.method, ref: pay.ref,
        legId: leg.id, auto: true, alloc: [{ t: 'leg', id: leg.id, amount: pay.amount }], note: (side === 'buy' ? 'پرداخت هنگام خرید ' : 'دریافت هنگام فروش ') + leg.no }, ctx));
      tx.insert('ops', { id: d.opKey, docId: leg.id, store: 'deals' });
      return { duplicate: false, deal: deal, leg: leg, entries: auto, changes: tx.commit() };
    }
    /* return part of a posted leg. r: {opKey, legId, ts, lines: [{line: index, qty}], reason, note}. Amount = the line's net share
       (exact remainder on the last unit). Buy returns lower the supplier debt by that amount; sunk purchase costs stay in the deal. */
    function returnDealLeg(r, ctx) {
      checkOpKey(r.opKey);
      var ex = existingOp2(r.opKey); if (ex) return ex;
      var o = S.deals[r.legId];
      if (!o || o.rt !== 'leg' || o.type !== 'post') throw AppError('NOT_FOUND', 'ردیف معامله پیدا نشد.');
      if (cancelOf(o.id)) throw AppError('REVERSED', 'این ردیف ابطال شده است.');
      if (!r.lines || !r.lines.length) throw AppError('BAD_INPUT', 'هیچ قلمی برای برگشت انتخاب نشده است.');
      var done = o.lines.map(function () { return { q: 0, v: 0 }; });
      listOf('deals', function (x) { return x.rt === 'leg' && x.type === 'return' && x.refLegId === o.id && !cancelOf(x.id); }).forEach(function (x) {
        x.lines.forEach(function (l) { done[l.line].q += l.qty; done[l.line].v += l.net; });
      });
      var seen = {}, lines = r.lines.filter(function (l) { return l && l.qty; }).map(function (l) {
        var L = o.lines[l.line]; if (!L || seen[l.line]) throw AppError('BAD_INPUT', 'ردیف برگشتی نامعتبر است.'); seen[l.line] = 1;
        if (!isQty(l.qty)) throw AppError('BAD_INPUT', 'تعداد برگشتی باید عدد صحیح مثبت باشد.');
        var left = L.qty - done[l.line].q; if (l.qty > left) throw AppError('BAD_INPUT', 'تعداد برگشتی «' + L.name + '» از باقی‌مانده (' + left + ') بیشتر است.');
        var net = l.qty === left ? L.net - done[l.line].v : Math.round(L.net * l.qty / L.qty);
        return { line: l.line, key: L.key, name: L.name, code: L.code, qty: l.qty, unitPrice: L.unitPrice, net: net };
      });
      if (!lines.length) throw AppError('BAD_INPUT', 'هیچ قلمی برای برگشت انتخاب نشده است.');
      var ts = docDate(r.ts, ctx, 'برگشت معامله'); notBefore(ts, o.ts, 'تاریخ برگشت پیش از تاریخ ردیف اصلی است.');
      var tx = new Tx(), net = lines.reduce(function (s, l) { return s + l.net; }, 0);
      var leg = { id: tx.id('deals'), rt: 'leg', dealId: o.dealId, no: (o.side === 'buy' ? 'DLBR-' : 'DLSR-') + pad(counterNext(tx, 'dleg'), 6), ts: ts, side: o.side, type: 'return',
        partyType: o.partyType, partyId: o.partyId, invoiceNo: o.invoiceNo, lines: lines, costs: [], gross: net, discount: 0, net: net, payable: net, costTotal: 0, cashCosts: 0, partyCosts: 0,
        dueDate: null, refLegId: o.id, reason: str(r.reason), note: str(r.note), user: who(ctx), source: src(ctx, r), opKey: r.opKey, createdAt: now() };
      tx.insert('deals', leg);
      tx.insert('ops', { id: r.opKey, docId: leg.id, store: 'deals' });
      return { duplicate: false, leg: leg, changes: tx.commit() };
    }
    function reverseEntryTx(tx, e, reason, ctx, ts) {
      var rv = lgInsert(tx, { kind: 'reversal', ts: ts, partyType: e.partyType, partyId: e.partyId, amount: e.amount, dir: e.dir, method: e.method, reverses: e.id, reversesNo: e.no,
        legId: e.legId, note: 'ابطال ' + e.no + (reason ? ' — ' + reason : '') }, ctx);
      (e.alloc || []).forEach(function (a) { // money applied to sale invoices goes back to those invoices
        if (a.t !== 'sale') return;
        var doc = tx.get('docs', a.id);
        applyPayment(tx, doc, { amount: a.amount, method: e.kind === 'settle' ? 'credit_transfer' : e.method, note: 'ابطال ' + e.no, ts: ts }, 'refund', ctx, { ledgerId: rv.id });
      });
      return rv;
    }
    /* cancel a wrongly recorded leg (manager): a cancel leg dated now negates it; the cash costs and the payment recorded with it
       are reversed too. Later payments stay on the party's account as credit. */
    function cancelDealLeg(c, ctx) {
      checkOpKey(c.opKey);
      var ex = existingOp2(c.opKey); if (ex) return ex;
      requireManager(ctx, 'ابطال ردیف معامله');
      var o = S.deals[c.legId];
      if (!o || o.rt !== 'leg' || o.type === 'cancel') throw AppError('NOT_FOUND', 'ردیف معامله پیدا نشد.');
      if (cancelOf(o.id)) throw AppError('REVERSED', 'این ردیف قبلاً ابطال شده است.');
      if (!normText(c.reason)) throw AppError('BAD_INPUT', 'علت ابطال الزامی است.');
      if (o.type === 'post' && listOf('deals', function (x) { return x.rt === 'leg' && x.type === 'return' && x.refLegId === o.id && !cancelOf(x.id); }).length)
        throw AppError('BAD_INPUT', 'این ردیف برگشتی دارد؛ ابتدا برگشتی‌ها را ابطال کنید یا باقی‌مانده را برگشت بزنید.');
      var ts = docDate(null, ctx, 'ابطال'), tx = new Tx();
      var leg = { id: tx.id('deals'), rt: 'leg', dealId: o.dealId, no: 'DLX-' + pad(counterNext(tx, 'dleg'), 6), ts: ts, side: o.side, type: 'cancel', partyType: o.partyType, partyId: o.partyId,
        invoiceNo: o.invoiceNo, lines: [], costs: [], refLegId: o.id, refNo: o.no, reason: str(c.reason), user: who(ctx), source: src(ctx, c), opKey: c.opKey, createdAt: now() };
      tx.insert('deals', leg);
      var revs = listOf('ledger', function (e) { return e.legId === o.id && e.auto && e.kind !== 'reversal' && !reversalOf(e.id); }).map(function (e) { return reverseEntryTx(tx, e, 'ابطال ' + o.no, ctx, ts); });
      tx.insert('ops', { id: c.opKey, docId: leg.id, store: 'deals' });
      return { duplicate: false, leg: leg, reversals: revs, changes: tx.commit() };
    }

    /* ---- party accounts ---- */
    function saleRowsByCustomer() { // exact per-event deltas of every sale invoice's balance (same rules as invoiceStates)
      var out = {}, retOf = {}, payOf = {};
      for (var k in S.docs) { var r = S.docs[k]; if (r.kind === 'return' && r.invoiceId) (retOf[r.invoiceId] = retOf[r.invoiceId] || []).push(r); }
      for (var p in S.payments) { var pm = S.payments[p]; (payOf[pm.docId] = payOf[pm.docId] || []).push(pm); }
      for (var id in S.docs) {
        var d = S.docs[id]; if (!(d.kind === 'out' && d.type === SALE && d.customerId)) continue;
        var ev = [{ ts: d.ts, o: 0, t: 'inv' }], rt = revTs(d);
        if (rt != null) ev.push({ ts: rt, o: 3, t: 'rev' });
        (retOf[d.id] || []).forEach(function (r) { ev.push({ ts: r.ts, o: 1, t: 'ret', r: r }); var x = revTs(r); if (x != null) ev.push({ ts: x, o: 2, t: 'retx', r: r }); });
        (payOf[d.id] || []).forEach(function (pm) { ev.push({ ts: pm.ts, o: 1, t: 'pay', p: pm }); });
        ev.sort(function (a, b) { return a.ts - b.ts || a.o - b.o; });
        var ret = 0, paid = 0, rev = false, prev = 0, list = out[d.customerId] || (out[d.customerId] = []);
        ev.forEach(function (e) {
          if (e.t === 'rev') rev = true; else if (e.t === 'ret') ret += e.r.total; else if (e.t === 'retx') ret -= e.r.total;
          else if (e.t === 'pay') paid += e.p.kind === 'refund' ? -e.p.amount : e.p.amount;
          var cur = (rev ? 0 : d.total - ret) - paid, amt = cur - prev; prev = cur;
          var row = { ts: e.ts, amount: amt, src: e.t === 'pay' ? 'payment' : 'sale', refId: e.t === 'pay' ? e.p.id : e.r ? e.r.id : d.id, docId: d.id,
            no: e.t === 'pay' ? e.p.no : e.r ? e.r.no : (d.invoiceNo || d.no),
            desc: e.t === 'inv' ? 'فاکتور فروش ' + (d.invoiceNo || d.no) : e.t === 'rev' ? 'ابطال فاکتور ' + (d.invoiceNo || d.no) : e.t === 'ret' ? 'مرجوعی از فاکتور ' + (d.invoiceNo || d.no)
              : e.t === 'retx' ? 'ابطال مرجوعی ' + e.r.no : (e.p.kind === 'refund' ? 'بازپرداخت / انتقال از ' : 'دریافت بابت ') + (d.invoiceNo || d.no) + (e.p.method ? ' (' + (PAY_METHODS[e.p.method] || e.p.method) + ')' : ''),
            ref: e.p ? e.p.ref || '' : '', viaLedger: e.p ? e.p.ledgerId || null : null };
          if (amt || e.t !== 'rev') list.push(row);
        });
      }
      return out;
    }
    function lgEffect(e) { // {bal, cash}
      if (e.kind === 'reversal') { var o = S.ledger[e.reverses], x = o ? lgEffect(o) : { bal: 0, cash: 0 }; return { bal: -x.bal, cash: -x.cash }; }
      if (e.kind === 'opening' || e.kind === 'adjust') return { bal: e.dir * e.amount, cash: 0 };
      if (e.kind === 'bill') return { bal: -e.amount, cash: 0 };
      if (e.kind === 'payment') return { bal: e.amount, cash: -e.amount };
      if (e.kind === 'receipt') return { bal: -(e.amount - (e.saleAlloc || 0)), cash: e.amount - (e.saleAlloc || 0) };
      if (e.kind === 'settle') return { bal: e.saleAlloc || 0, cash: 0 };
      if (e.kind === 'expense') return { bal: 0, cash: -e.amount };
      return { bal: 0, cash: 0 };
    }
    /* every dated row of every party: {'customer:<id>' | 'supplier:<id>': [{ts, amount (signed balance effect), src, no, desc, ref, …}]} */
    function allPartyRows() {
      var out = {}, sale = saleRowsByCustomer(), folded = {}, rvs = reversedSet();
      function L(t, id) { return out[t + ':' + id] || (out[t + ':' + id] = []); }
      Object.keys(sale).forEach(function (cid) { sale[cid].forEach(function (r) { if (r.viaLedger) folded[r.viaLedger] = (folded[r.viaLedger] || 0) + r.amount; else L('customer', cid).push(r); }); });
      for (var k in S.deals) {
        var g = S.deals[k]; if (g.rt !== 'leg') continue;
        var e = legEffects(g), o = g.type === 'cancel' ? S.deals[g.refLegId] : null;
        L(g.partyType, g.partyId).push({ ts: g.ts, amount: e.bal, src: 'deal', refId: g.id, dealId: g.dealId, no: g.no,
          desc: (g.type === 'cancel' ? 'ابطال ' + (o ? o.no : '') : g.type === 'return' ? (g.side === 'buy' ? 'برگشت از خرید مستقیم' : 'برگشت از فروش مستقیم') : (g.side === 'buy' ? 'خرید مستقیم' : 'فروش مستقیم'))
            + (g.invoiceNo ? ' — فاکتور ' + g.invoiceNo : '') + (g.reason ? ' — ' + g.reason : ''), ref: g.invoiceNo || '', dueDate: g.dueDate || null, createdAt: g.createdAt });
      }
      for (var j in S.ledger) {
        var x = S.ledger[j]; if (!x.partyType) continue;
        var amt = lgEffect(x).bal + (folded[x.id] || 0);
        L(x.partyType, x.partyId).push({ ts: x.ts, amount: amt, src: 'ledger', refId: x.id, kind: x.kind, no: x.no, desc: (LG_KINDS[x.kind] || x.kind) + (x.note ? ' — ' + x.note : ''),
          ref: x.ref || '', method: x.method, dueDate: x.dueDate || null, reversed: !!rvs[x.id], createdAt: x.createdAt });
      }
      Object.keys(out).forEach(function (k2) { out[k2].sort(function (a, b) { return a.ts - b.ts || (a.createdAt || 0) - (b.createdAt || 0); }); });
      return out;
    }
    function partyBalance(t, id, X) {
      var r = allPartyRows()[t + ':' + id] || [], b = 0;
      r.forEach(function (x) { if (X == null || x.ts <= X) b += x.amount; });
      return b;
    }
    /* f: {from, to}. Opening = everything before `from`; closing = opening + rows. */
    function partyStatement(t, id, f) {
      needParty(t, id); f = f || {};
      var all = allPartyRows()[t + ':' + id] || [], open = 0, list = [], run;
      all.forEach(function (r) { if (f.from != null && r.ts < f.from) open += r.amount; });
      run = open;
      all.forEach(function (r) { if (inRange(r.ts, f) && r.amount !== 0) { run += r.amount; list.push(Object.assign({}, r, { debit: r.amount > 0 ? r.amount : 0, credit: r.amount < 0 ? -r.amount : 0, balance: run })); } });
      return { party: partyRec(t, id), partyType: t, opening: open, rows: list, closing: run,
        debit: list.reduce(function (s, r) { return s + r.debit; }, 0), credit: list.reduce(function (s, r) { return s + r.credit; }, 0) };
    }
    /* open items of a party (what a payment / receipt can settle). dir: +1 they owe us, −1 we owe them. */
    function partyOpenItems(t, id, X) {
      needParty(t, id);
      var al = allocations(), out = [], today = X != null ? X : now();
      function push(o) { o.remaining = Math.max(0, o.amount - o.allocated); o.status = o.remaining === 0 ? 'settled' : o.allocated > 0 ? 'partial' : 'unsettled';
        o.overdue = o.remaining > 0 && o.dueDate != null && dayKey(o.dueDate) < dayKey(today); out.push(o); }
      if (t === 'customer') for (var k in S.docs) {
        var d = S.docs[k]; if (!(d.kind === 'out' && d.type === SALE && d.customerId === id) || d.status === 'reversed') continue;
        var et = effectiveTotal(d); if (et <= 0) continue;
        push({ t: 'sale', id: d.id, no: d.invoiceNo || d.no, ts: d.ts, dueDate: d.dueDate || null, dir: 1, amount: et, allocated: et - Math.max(0, d.balance), desc: 'فاکتور فروش' });
      }
      listOf('deals', function (g) { return g.rt === 'leg' && g.type === 'post' && g.partyType === t && g.partyId === id; }).forEach(function (g) {
        var a = legOpenAmount(g); if (!a && cancelOf(g.id)) return;
        push({ t: 'leg', id: g.id, dealId: g.dealId, no: g.no, invoiceNo: g.invoiceNo, ts: g.ts, dueDate: g.dueDate || null, dir: g.side === 'sell' ? 1 : -1, amount: a, allocated: Math.min(a, al['leg:' + g.id] || 0),
          desc: g.side === 'sell' ? 'فروش مستقیم' : 'خرید مستقیم' });
      });
      listOf('ledger', function (e) { return (e.kind === 'bill' || e.kind === 'opening') && e.partyType === t && e.partyId === id && !reversalOf(e.id); }).forEach(function (e) {
        var dir = e.kind === 'bill' ? -1 : e.dir;
        push({ t: e.kind, id: e.id, no: e.no, ts: e.ts, dueDate: e.dueDate || null, dir: dir, amount: e.amount, allocated: Math.min(e.amount, al[e.kind + ':' + e.id] || 0),
          desc: e.kind === 'bill' ? 'بدهی خرید ' + (e.docNo || '') : 'مانده اول دوره', category: e.kind === 'bill' ? 'purchase' : 'opening' });
      });
      return out.sort(function (a, b) { return (a.dueDate || a.ts) - (b.dueDate || b.ts) || a.ts - b.ts; });
    }
    /* unapplied money of a party (payments / receipts not allocated, allocations above a later-reduced item) minus settlements */
    function partyCredit(t, id) {
      var pool = 0, al = allocations();
      listOf('ledger', function (e) { return e.partyType === t && e.partyId === id && !reversalOf(e.id) && e.kind !== 'reversal'; }).forEach(function (e) {
        if (e.kind === 'payment' || e.kind === 'receipt') pool += e.amount - e.alloc.reduce(function (s, a) { return s + a.amount; }, 0);
        else if (e.kind === 'settle') pool -= e.amount;
      });
      var rv = reversedSet();
      Object.keys(al).forEach(function (key) {
        var i = key.indexOf(':'), tt = key.slice(0, i), tid = key.slice(i + 1), tg = tt === 'leg' ? S.deals[tid] : S.ledger[tid];
        if (!tg || tg.partyType !== t || tg.partyId !== id) return;
        var cap = tt === 'leg' ? legOpenAmount(tg) : rv[tid] ? 0 : tg.amount;
        pool += Math.max(0, al[key] - cap);
      });
      return Math.max(0, pool);
    }
    /* e: {opKey, kind: opening|bill|payment|receipt|adjust|settle, partyType, partyId, amount, dir (+1 they owe us / −1 we owe; opening & adjust),
       method, ref, note, ts, dueDate, docId (bill: the stocked purchase 'in' document), alloc: 'auto' | [{t: leg|bill|opening|sale, id, amount}]} */
    function postPartyEntry(e, ctx) {
      checkOpKey(e.opKey);
      var ex = existingOp2(e.opKey); if (ex) return ex;
      var kind = e.kind, t = e.partyType;
      if (!LG_KINDS[kind] || kind === 'reversal' || kind === 'expense') throw AppError('BAD_INPUT', 'نوع تراکنش نامعتبر است.');
      needParty(t, e.partyId);
      if (!isMoney(e.amount) || !e.amount) throw AppError('BAD_INPUT', 'مبلغ باید عدد صحیح مثبت باشد.');
      var rec = { kind: kind, partyType: t, partyId: e.partyId, amount: e.amount, ref: str(e.ref), note: str(e.note), dueDate: dueOf(e.dueDate) };
      if (kind === 'opening' || kind === 'adjust') {
        if (e.dir !== 1 && e.dir !== -1) throw AppError('BAD_INPUT', 'جهت مانده (بدهکار / بستانکار) را مشخص کنید.');
        rec.dir = e.dir;
      }
      if (kind === 'adjust') { requireManager(ctx, 'تعدیل مانده حساب'); if (!rec.note) throw AppError('BAD_INPUT', 'علت تعدیل الزامی است.'); }
      if (kind === 'opening' && listOf('ledger', function (x) { return x.kind === 'opening' && x.partyType === t && x.partyId === e.partyId && !reversalOf(x.id); }).length)
        throw AppError('BAD_INPUT', 'مانده اول دوره این طرف حساب قبلاً ثبت شده است؛ برای تغییر، آن را ابطال و دوباره ثبت کنید.');
      if (kind === 'bill') {
        if (t !== 'supplier') throw AppError('BAD_INPUT', 'بدهی خرید فقط برای تأمین‌کننده ثبت می‌شود.');
        var dd = S.docs[e.docId];
        if (!dd || dd.kind !== 'in') throw AppError('NOT_FOUND', 'سند ورود کالا پیدا نشد.');
        if (dd.status === 'reversed') throw AppError('REVERSED', 'این سند ورود برگشت خورده است.');
        if (dd.supplierId && dd.supplierId !== e.partyId) throw AppError('BAD_INPUT', 'تأمین‌کننده این سند ورود با طرف حساب یکی نیست.');
        var cap = receiptPayable(dd), used = listOf('ledger', function (x) { return x.kind === 'bill' && x.docId === dd.id && !reversalOf(x.id); }).reduce(function (s, x) { return s + x.amount; }, 0);
        if (cap != null && used + e.amount > cap) throw AppError('OVERPAY', 'جمع بدهی ثبت‌شده برای این سند از مبلغ فاکتور (' + cap + ') بیشتر می‌شود' + (used ? ' (قبلاً ' + used + ' ثبت شده)' : '') + '.');
        rec.docId = dd.id; rec.docNo = dd.supplierDocNo || dd.no;
      }
      if (kind === 'payment' || kind === 'receipt') {
        var pm = payIn(e, kind === 'payment' ? 'پرداختی' : 'دریافتی'); rec.method = pm.method;
      }
      var ts = docDate(e.ts, ctx, LG_KINDS[kind]);
      // allocation: receipts settle what they owe us (+1), payments what we owe them (−1); settle uses the party's unapplied money
      var alloc = [];
      if (kind === 'payment' || kind === 'receipt' || kind === 'settle') {
        var dir = kind === 'receipt' ? 1 : kind === 'payment' ? -1 : (e.dir === 1 || e.dir === -1 ? e.dir : (t === 'customer' ? 1 : -1));
        var items = partyOpenItems(t, e.partyId).filter(function (o) { return o.dir === dir && o.remaining > 0; }), byKey = {};
        items.forEach(function (o) { byKey[o.t + ':' + o.id] = o; });
        if (e.alloc === 'auto' || (kind === 'settle' && !e.alloc)) {
          var left = e.amount;
          items.forEach(function (o) { if (left <= 0) return; var a = Math.min(left, o.remaining); alloc.push({ t: o.t, id: o.id, amount: a }); left -= a; });
        } else (e.alloc || []).forEach(function (a) {
          if (!a || !a.amount) return;
          var o = byKey[a.t + ':' + a.id]; if (!o) throw AppError('BAD_INPUT', 'قلم تسویه نامعتبر است یا مانده ندارد.');
          if (!isMoney(a.amount) || a.amount > o.remaining) throw AppError('OVERPAY', 'مبلغ تسویه «' + o.no + '» از مانده آن (' + o.remaining + ') بیشتر است.');
          alloc.push({ t: a.t, id: a.id, amount: a.amount });
        });
        var sum = alloc.reduce(function (s, a) { return s + a.amount; }, 0);
        if (sum > e.amount) throw AppError('OVERPAY', 'جمع تسویه‌ها از مبلغ بیشتر است.');
        if (kind === 'settle') {
          if (!alloc.length) throw AppError('BAD_INPUT', 'قلمی برای تسویه وجود ندارد.');
          var pool = partyCredit(t, e.partyId); if (e.amount > pool) throw AppError('OVERPAY', 'پیش‌پرداخت / بستانکاری آزاد این طرف حساب ' + pool + ' است.');
          if (sum !== e.amount) rec.amount = sum;
        }
      }
      var tx = new Tx();
      rec.ts = ts; rec.alloc = alloc;
      rec.saleAlloc = alloc.filter(function (a) { return a.t === 'sale'; }).reduce(function (s, a) { return s + a.amount; }, 0);
      var out = lgInsert(tx, rec, ctx);
      alloc.forEach(function (a) { // money applied to an existing sale invoice is recorded on the invoice itself (same rules as «دریافت وجه»)
        if (a.t !== 'sale') return;
        var doc = tx.get('docs', a.id);
        applyPayment(tx, doc, { amount: a.amount, method: kind === 'settle' ? 'credit_transfer' : out.method, ref: out.ref, note: out.no + (out.note ? ' — ' + out.note : ''), ts: ts }, 'receipt', ctx, { ledgerId: out.id });
      });
      tx.insert('ops', { id: e.opKey, docId: out.id, store: 'ledger' });
      return { duplicate: false, entry: out, changes: tx.commit() };
    }
    function reversePartyEntry(r, ctx) {
      checkOpKey(r.opKey);
      var ex = existingOp2(r.opKey); if (ex) return ex;
      requireManager(ctx, 'ابطال تراکنش حساب');
      var e = S.ledger[r.entryId];
      if (!e || e.kind === 'reversal') throw AppError('NOT_FOUND', 'تراکنش پیدا نشد.');
      if (reversalOf(e.id)) throw AppError('REVERSED', 'این تراکنش قبلاً ابطال شده است.');
      if (!normText(r.reason)) throw AppError('BAD_INPUT', 'علت ابطال الزامی است.');
      var ts = docDate(null, ctx, 'ابطال'), tx = new Tx();
      var rv = reverseEntryTx(tx, e, str(r.reason), ctx, ts);
      tx.insert('ops', { id: r.opKey, docId: rv.id, store: 'ledger' });
      return { duplicate: false, entry: rv, changes: tx.commit() };
    }
    function partyList(t, q) {
      var st = PARTY[t]; if (!st) throw AppError('BAD_INPUT', 'نوع طرف حساب نامعتبر است.');
      var all = allPartyRows(), qq = normText(q || ''), qp = normPhone(q || '');
      return Object.keys(S[st]).map(function (id) {
        var p = S[st][id], b = (all[t + ':' + id] || []).reduce(function (s, r) { return s + r.amount; }, 0);
        return { partyType: t, id: id, party: p, name: p.name, phone: p.phone || '', balance: b, rows: (all[t + ':' + id] || []).length };
      }).filter(function (x) { return !qq || normText(x.name).indexOf(qq) >= 0 || (qp.length >= 3 && normPhone(x.phone).indexOf(qp) >= 0); })
        .sort(function (a, b) { return Math.abs(b.balance) - Math.abs(a.balance) || String(a.name).localeCompare(String(b.name), 'fa'); });
    }
    /* kind: debtors | creditors | overdueRec | overduePay */
    function partyReport(kind, X) {
      var rowsOut = [];
      ['customer', 'supplier'].forEach(function (t) {
        partyList(t).forEach(function (p) {
          if (kind === 'debtors' && p.balance > 0) rowsOut.push(p);
          else if (kind === 'creditors' && p.balance < 0) rowsOut.push(p);
          else if (kind === 'overdueRec' || kind === 'overduePay') {
            var due = partyOpenItems(t, p.id, X).filter(function (o) { return o.overdue && o.dir === (kind === 'overdueRec' ? 1 : -1); });
            if (due.length) rowsOut.push(Object.assign({}, p, { items: due, overdue: due.reduce(function (s, o) { return s + o.remaining; }, 0) }));
          }
        });
      });
      return rowsOut;
    }
    /* cash actually moved in (from, to]: sale-invoice payments (existing) + party ledger; unpaid amounts never count */
    function cashFlow(f) {
      f = f || {};
      var s = { saleReceipts: 0, saleRefunds: 0, partyReceipts: 0, partyPayments: 0, dealExpenses: 0, reversals: 0, cashIn: 0, cashOut: 0, net: 0 };
      for (var k in S.payments) {
        var p = S.payments[k]; if (!inRange(p.ts, f) || p.method === 'credit_transfer') continue;
        if (p.kind === 'refund') s.saleRefunds += p.amount; else s.saleReceipts += p.amount;
      }
      for (var j in S.ledger) {
        var e = S.ledger[j]; if (!inRange(e.ts, f)) continue;
        var c = lgEffect(e).cash; if (!c) continue;
        if (e.kind === 'reversal') s.reversals += c;
        else if (e.kind === 'receipt') s.partyReceipts += c;
        else if (e.kind === 'payment') s.partyPayments -= c;
        else if (e.kind === 'expense') s.dealExpenses -= c;
      }
      s.cashIn = s.saleReceipts + s.partyReceipts + (s.reversals > 0 ? s.reversals : 0);
      s.cashOut = s.saleRefunds + s.partyPayments + s.dealExpenses + (s.reversals < 0 ? -s.reversals : 0);
      s.net = s.cashIn - s.cashOut;
      return s;
    }
    /* profit & loss: warehouse sales (existing gross profit, unchanged) + direct deals; the two never overlap */
    function profitLoss(f) {
      var g = grossProfit(f), dl = dealsPL(f);
      return { stock: { sales: g.knownSales + g.unknownSales, profit: g.profit, unknownLines: g.unknownLines, complete: g.complete },
        deals: dl, total: g.profit + dl.profit, complete: g.complete && !dl.uncertainDeals };
    }

    // ---------- v2.8 proforma invoices (پیش‌فاکتور): a QUOTE only — never stock, balances, profit, cash or periods ----------
    /* q: {opKey, id? (edit an open one), customerId?, customerName?, validUntil?, items: [{productId, qty, unitPrice, discount}], discount, note}.
       Prices are what the user saved; a new list price NEVER changes a quote by itself (quoteView shows the difference). */
    function saveQuote(q, ctx) {
      checkOpKey(q.opKey);
      var ex = existingOp2(q.opKey); if (ex) return ex;
      var cur = q.id ? S.quotes[q.id] : null;
      if (q.id && !cur) throw AppError('NOT_FOUND', 'پیش‌فاکتور پیدا نشد.');
      if (cur && cur.status !== 'open') throw AppError('BAD_INPUT', 'این پیش‌فاکتور ' + (cur.status === 'converted' ? 'به فاکتور تبدیل شده' : 'لغو شده') + ' و قابل ویرایش نیست.');
      if (q.customerId && !S.customers[q.customerId]) throw AppError('NOT_FOUND', 'مشتری پیدا نشد.');
      if (!q.items || !q.items.length) throw AppError('BAD_INPUT', 'هیچ کالایی در پیش‌فاکتور نیست.');
      var sum = 0, lines = q.items.map(function (it) {
        var p = S.products[it.productId]; if (!p) throw AppError('NOT_FOUND', 'کالا پیدا نشد.');
        if (!isQty(it.qty)) throw AppError('BAD_INPUT', 'تعداد «' + p.name + '» باید عدد صحیح مثبت باشد.');
        if (!isMoney(it.unitPrice)) throw AppError('BAD_INPUT', 'قیمت «' + p.name + '» را وارد کنید.');
        var dc = it.discount || 0; if (!isMoney(dc) || dc > it.qty * it.unitPrice) throw AppError('BAD_INPUT', 'تخفیف ردیف «' + p.name + '» نامعتبر است.');
        var lt = it.qty * it.unitPrice - dc; sum += lt;
        return { productId: p.id, sku: p.sku, name: p.name, brand: p.brand, qty: it.qty, unitPrice: it.unitPrice, discount: dc, lineTotal: lt };
      });
      var dd = q.discount || 0; if (!isMoney(dd) || dd > sum) throw AppError('BAD_INPUT', 'تخفیف کل نامعتبر است.');
      var tx = new Tx(), rec, before = cur ? clone(cur) : null;
      if (cur) { rec = tx.get('quotes', cur.id); rec.revision = (rec.revision || 1) + 1; }
      else { rec = { id: tx.id('quotes'), no: 'PF-' + pad(counterNext(tx, 'pf'), 6), ts: now(), status: 'open', revision: 1, user: who(ctx), source: src(ctx, q), createdAt: now() }; tx.insert('quotes', rec); }
      Object.assign(rec, { customerId: q.customerId || null, customerName: str(q.customerName), validUntil: dueOf(q.validUntil), lines: lines, subtotal: sum, discount: dd, total: sum - dd,
        note: str(q.note), updatedAt: now() });
      if (cur) audit(tx, 'quote', rec.id, 'update', { total: before.total, lines: before.lines.length }, { total: rec.total, lines: rec.lines.length }, ctx);
      tx.insert('ops', { id: q.opKey, docId: rec.id, store: 'quotes' });
      return { duplicate: false, quote: rec, changes: tx.commit() };
    }
    function cancelQuote(c, ctx) {
      checkOpKey(c.opKey);
      var ex = existingOp2(c.opKey); if (ex) return ex;
      var cur = S.quotes[c.id]; if (!cur) throw AppError('NOT_FOUND', 'پیش‌فاکتور پیدا نشد.');
      if (cur.status !== 'open') throw AppError('BAD_INPUT', 'این پیش‌فاکتور باز نیست.');
      var tx = new Tx(), rec = tx.get('quotes', cur.id);
      rec.status = 'cancelled'; rec.cancelledAt = now(); rec.cancelReason = str(c.reason); rec.updatedAt = now();
      tx.insert('ops', { id: c.opKey, docId: rec.id, store: 'quotes' });
      return { duplicate: false, quote: rec, changes: tx.commit() };
    }
    /* called in the SAME batch as the sale's postIssue (all or nothing); a retry of an already converted quote is a no-op */
    function markQuoteConverted(id, docId, ctx) {
      var cur = S.quotes[id]; if (!cur) throw AppError('NOT_FOUND', 'پیش‌فاکتور پیدا نشد.');
      var d = S.docs[docId]; if (!d || d.kind !== 'out' || d.type !== SALE) throw AppError('NOT_FOUND', 'فاکتور فروش پیدا نشد.');
      if (cur.status === 'converted' && cur.docId === docId) return { duplicate: true, quote: cur, changes: [] };
      if (cur.status !== 'open') throw AppError('BAD_INPUT', 'این پیش‌فاکتور باز نیست.');
      var tx = new Tx(), rec = tx.get('quotes', id);
      rec.status = 'converted'; rec.docId = docId; rec.invoiceNo = d.invoiceNo; rec.convertedAt = now(); rec.updatedAt = now();
      audit(tx, 'quote', id, 'convert', { status: 'open' }, { status: 'converted', invoiceNo: d.invoiceNo }, ctx);
      return { duplicate: false, quote: rec, changes: tx.commit() };
    }
    /* a quote with the current sale price of each line (changed = the price list / product price moved since it was saved) */
    function quoteView(id) {
      var q = S.quotes[id]; if (!q) return null;
      var lines = q.lines.map(function (l) { var p = S.products[l.productId], cp = p ? p.sellPrice : null; return Object.assign({}, l, { current: cp, changed: q.status === 'open' && cp != null && cp !== l.unitPrice, missing: !p }); });
      return Object.assign({}, q, { lines: lines, changed: lines.filter(function (l) { return l.changed; }).length, expired: q.status === 'open' && q.validUntil != null && q.validUntil < now(), // v2.8.1: to the hour (48 h validity)
        customer: q.customerId ? S.customers[q.customerId] || null : null });
    }
    function quotesList(f) {
      f = f || {};
      return listOf('quotes').filter(function (q) { return !f.status || q.status === f.status; }).reverse().map(function (q) { return quoteView(q.id); });
    }
    function dealsHealth(add) {
      for (var k in S.deals) {
        var g = S.deals[k];
        if (g.rt === 'leg') {
          if (!S.deals[g.dealId]) add('critical', 'REF_DEAL', 'ردیف ' + g.no + ' به معامله ناموجود اشاره دارد.');
          if (!partyRec(g.partyType, g.partyId)) add('critical', 'REF_PARTY', 'ردیف ' + g.no + ' به طرف حساب ناموجود اشاره دارد.');
          if (g.refLegId && !S.deals[g.refLegId]) add('critical', 'REF_DEAL', 'ردیف ' + g.no + ' به ردیف اصلی ناموجود اشاره دارد.');
        }
      }
      for (var qk in S.quotes) { var qq = S.quotes[qk]; if (qq.docId && !S.docs[qq.docId]) add('warning', 'REF_QUOTE', 'پیش‌فاکتور ' + qq.no + ' به فاکتور ناموجود اشاره دارد.'); }
      var al = allocations();
      for (var j in S.ledger) {
        var e = S.ledger[j];
        if (e.partyType && !partyRec(e.partyType, e.partyId)) add('critical', 'REF_PARTY', 'تراکنش ' + e.no + ' به طرف حساب ناموجود اشاره دارد.');
        if (e.reverses && !S.ledger[e.reverses]) add('critical', 'REF_LEDGER', 'ابطال ' + e.no + ' به تراکنش ناموجود اشاره دارد.');
        if (e.docId && !S.docs[e.docId]) add('critical', 'REF_INVOICE', 'تراکنش ' + e.no + ' به سند ناموجود اشاره دارد.');
        (e.alloc || []).forEach(function (a) {
          var ok = a.t === 'sale' ? !!S.docs[a.id] : a.t === 'leg' ? !!S.deals[a.id] : !!S.ledger[a.id];
          if (!ok) add('critical', 'REF_ALLOC', 'تسویه ' + e.no + ' به قلم ناموجود اشاره دارد.');
        });
      }
      Object.keys(al).forEach(function (key) { // a leg may be reduced later (return / cancel): its excess is party credit, not an error
        var i = key.indexOf(':'), t = key.slice(0, i), id = key.slice(i + 1);
        if (t === 'leg') { var g = S.deals[id]; if (g && al[key] > g.payable) add('warning', 'OVER_ALLOC', 'تسویه بیش از مبلغ ردیف ' + g.no + '.'); }
        else if (S.ledger[id] && al[key] > S.ledger[id].amount) add('warning', 'OVER_ALLOC', 'تسویه بیش از مبلغ ' + S.ledger[id].no + '.');
      });
    }

    // ---------- load/export ----------
    function load(data) {
      data = data || {};
      var next = {};
      STORES.forEach(function (n) {
        next[n] = dict();
        var rows = data[n] || [];
        if (!Array.isArray(rows)) throw AppError('BAD_DATA', 'ساختار داده «' + n + '» نامعتبر است.');
        rows.forEach(function (r) {
          if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) throw AppError('BAD_DATA', 'شناسه نامعتبر در «' + n + '».');
          if (next[n][r.id]) throw AppError('BAD_DATA', 'شناسه تکراری در «' + n + '»: ' + r.id);
          next[n][r.id] = r;
        });
      });
      STORES.forEach(function (n) { S[n] = next[n]; });
      Object.keys(S.products).forEach(function (id) { ensureLayers(S.products[id]); });
      ixRebuild(); VER++;
    }
    function exportAll() {
      var out = {}; STORES.forEach(function (n) { out[n] = Object.keys(S[n]).map(function (k) { return S[n][k]; }); }); return out;
    }

    var engineApi = {
      state: S, STORES: STORES, SCHEMA_VERSION: SCHEMA_VERSION, load: load, exportAll: exportAll, revert: revert, list: list,
      createProduct: createProduct, updateProduct: updateProduct, mapBarcode: mapBarcode, unmapBarcode: unmapBarcode,
      findProductByCode: findProductByCode, findProductBySku: findProductBySku, findDuplicates: findDuplicates, parseCode: parseCode,
      searchProducts: searchProducts, resolveCategoryText: resolveCategoryText,
      createCustomer: createCustomer, updateCustomer: updateCustomer, findCustomerByPhone: findCustomerByPhone,
      createCategory: createCategory, updateCategory: updateCategory, deleteCategory: deleteCategory, categoryPath: categoryPath, ensureCategoryPath: ensureCategoryPath, setProductGroups: setProductGroups,
      categoryDescendants: categoryDescendants, categoryAttrDefs: categoryAttrDefs, findCategoryByName: findCategoryByName,
      createSupplier: createSupplier, updateSupplier: updateSupplier,
      putMeta: putMeta, getMeta: getMeta, setSettings: setSettings,
      postReceipt: postReceipt, postIssue: postIssue, addPayment: addPayment, transferCredit: transferCredit,
      postSaleReturn: postSaleReturn, reverseDoc: reverseDoc, adjustStock: adjustStock,
      stockReport: stockReport, productLedger: productLedger, salesLines: salesLines, nonSaleIssues: nonSaleIssues, paymentsReport: paymentsReport,
      customerBalance: customerBalance, allBalances: allBalances, customerStatement: customerStatement, debtors: debtors, grossProfit: grossProfit,
      topProducts: topProducts, reconcile: reconcile, healthCheck: healthCheck, allDocs: allDocs, avgCost: avgCost, effectiveTotal: effectiveTotal,
      // v2.1
      version: function () { return VER; }, closedThrough: closedThrough, periodInfo: periodInfo, closePeriod: closePeriod, reopenPeriod: reopenPeriod,
      periodSummary: periodSummary, periodFingerprint: periodFingerprint, invoiceStates: invoiceStates, invoiceAsOf: invoiceAsOf, stockAsOf: stockAsOf, revTs: revTs,
      receiptLines: receiptLines, computePurchase: computePurchase, findPurchaseDuplicates: findPurchaseDuplicates, BACKDATE_DAYS: BACKDATE_DAYS,
      // v2.2
      scanQty: scanQty, priceGroups: priceGroups, setPriceGroups: setPriceGroups, priceFor: priceFor, learn: learn, unlearn: unlearn, learned: learned, learnedAll: learnedAll, learnedCategory: learnedCategory,
      learnVisual: learnVisual, visualMemory: visualMemory,
      recordImport: recordImport, importRecords: importRecords, undoImportPlan: undoImportPlan, undoImport: undoImport, deleteProduct: deleteProduct, deletePriceList: deletePriceList, productInUse: productInUse,
      priceLists: priceLists, savePriceList: savePriceList, listCostFor: listCostFor, removePriceListItems: removePriceListItems, PLIST_DAYS: PLIST_DAYS, listRank: listRank, rankLess: rankLess,
      costCandidates: costCandidates, completeCosts: completeCosts, completionFor: completionFor, replacementCost: replacementCost,
      // v2.5 direct deals & party accounts
      postDealLeg: postDealLeg, returnDealLeg: returnDealLeg, cancelDealLeg: cancelDealLeg, postPartyEntry: postPartyEntry, reversePartyEntry: reversePartyEntry,
      dealView: dealView, dealsList: dealsList, dealsPL: dealsPL, partyBalance: partyBalance, partyStatement: partyStatement, partyOpenItems: partyOpenItems, partyCredit: partyCredit,
      partyList: partyList, partyReport: partyReport, cashFlow: cashFlow, profitLoss: profitLoss, LG_KINDS: LG_KINDS,
      // v2.8 proforma
      saveQuote: saveQuote, cancelQuote: cancelQuote, markQuoteConverted: markQuoteConverted, quoteView: quoteView, quotesList: quotesList,
      lineCost: function (d, l, X) { return d.kind === 'in' ? inLineCost(l, d, X) : d.kind === 'adjust' ? adjLineCost(l, d, X) : outLineCost(l, X); }
    };
    if (opts.testHooks) engineApi.__test = { Tx: Tx }; // automated tests only: raw transactions to prove the central guard
    return engineApi;
  }

  /* Schema migration (pure). Returns {data, log, from, to}. Never changes stock quantities, money totals,
     balances or ids; callers verify that with invariants() before saving. */
  function migrate(data, opts) {
    opts = opts || {};
    data = JSON.parse(JSON.stringify(data || {}));
    STORES.forEach(function (n) { if (!Array.isArray(data[n])) data[n] = []; });
    var schemaRec = data.meta.filter(function (m) { return m.id === 'schema'; })[0];
    var from = schemaRec && schemaRec.v && schemaRec.v.v || 1, log = [];
    if (from > SCHEMA_VERSION) throw AppError('NEWER_SCHEMA', 'این داده‌ها با نسخه جدیدتری از برنامه ساخته شده‌اند؛ ابتدا برنامه را به‌روز کنید.');
    if (from < 2) {
      var newPublic = opts.newPublicCode || function () { return randomCode(10, '23456789ABCDEFGHJKMNPQRSTUVWXYZ'); };
      var newId = opts.newId || function () { return randomCode(8); };
      var usedPub = {}, usedCat = {};
      data.products.forEach(function (p) { if (p.publicCode) usedPub[p.publicCode] = 1; });
      data.categories.forEach(function (c) { usedCat[c.id] = 1; });
      var catByName = {}, created = 0;
      data.products.forEach(function (p) {
        if (!p.publicCode) { var c; do { c = newPublic(); } while (usedPub[c]); usedPub[c] = 1; p.publicCode = c; }
        if (!Array.isArray(p.layers)) {
          p.layers = []; var unk = p.stock - (p.costedQty || 0);
          if (unk > 0) p.layers.push({ qty: unk, cost: null, src: null });
          if (p.costedQty > 0) p.layers.push({ qty: p.costedQty, cost: Math.round(p.costBasis / p.costedQty), src: null });
        }
        p.layers.forEach(function (l) { if (l.src === undefined) l.src = null; });
        if (p.attrs == null) p.attrs = {};
        ['model', 'family'].forEach(function (k) { if (p[k] == null) p[k] = ''; });
        if (p.supplierId === undefined) p.supplierId = null;
        if (p.warrantyMonths === undefined) p.warrantyMonths = null;
        if (!p.categoryId && normText(p.category)) {
          var key = normText(p.category);
          if (!catByName[key]) {
            var id; do { id = newId(); } while (usedCat[id]); usedCat[id] = 1;
            catByName[key] = { id: id, name: String(p.category).trim(), parentId: null, attrDefs: [], active: true, order: 0, createdAt: Date.now(), updatedAt: Date.now() };
            data.categories.push(catByName[key]); created++;
          }
          p.categoryId = catByName[key].id;
        }
        if (p.categoryId === undefined) p.categoryId = null;
      });
      if (created) log.push(created + ' گروه کالا از دسته‌بندی‌های متنی قبلی ساخته شد.');
      var alloc = 0;
      data.docs.forEach(function (d) {
        if (d.kind === 'out' && d.type === 'sale') {
          if (d.lines.some(function (l) { return l.net == null; })) {
            var sum = d.lines.reduce(function (s, l) { return s + l.lineTotal; }, 0), dd = d.discount || 0, rem = dd, fr = [];
            d.lines.forEach(function (l, i) { var ex = sum ? dd * l.lineTotal / sum : 0; l.invDisc = Math.floor(ex); rem -= l.invDisc; fr.push({ i: i, f: ex - l.invDisc }); });
            fr.sort(function (a, b) { return b.f - a.f || a.i - b.i; });
            for (var k = 0; rem > 0 && k < fr.length; k++) { var L = d.lines[fr[k].i]; if (L.lineTotal > L.invDisc) { L.invDisc++; rem--; } }
            d.lines.forEach(function (l) { l.net = l.lineTotal - l.invDisc; });
            if (dd) alloc++;
          }
          d.lines.forEach(function (l) {
            if (l.returnedQty == null) l.returnedQty = 0; if (l.returnedAmount == null) l.returnedAmount = 0; if (l.returnedCost == null) l.returnedCost = 0;
            if (!l.layersLeft) l.layersLeft = JSON.parse(JSON.stringify(l.layers || [{ qty: l.qty, cost: l.unitCost == null ? null : l.unitCost, src: null }]));
            (l.layers || []).concat(l.layersLeft).forEach(function (u) { if (u.src === undefined) u.src = null; });
          });
          if (d.returned == null) d.returned = 0;
          if (d.dueDate === undefined) d.dueDate = null;
          if (d.status === 'reversed' && d.settlement === 'credit' && d.balance === 0) d.settlement = 'settled';
        } else (d.lines || []).forEach(function (l) { (l.layers || []).forEach(function (u) { if (u.src === undefined) u.src = null; }); });
      });
      if (alloc) log.push('تخفیف کلی ' + alloc + ' فاکتور بین ردیف‌ها تقسیم شد (فقط برای محاسبه صحیح سود؛ مبلغ فاکتورها تغییر نکرد).');
      log.push('کد عمومی (QR مشتری) برای ' + data.products.length + ' کالا ساخته شد؛ شناسه‌ها و QRهای داخلی چاپ‌شده تغییری نکردند.');
    }
    if (from < SCHEMA_VERSION || !schemaRec) {
      data.meta = data.meta.filter(function (m) { return m.id !== 'schema'; });
      data.meta.push({ id: 'schema', v: { v: SCHEMA_VERSION, migratedAt: Date.now(), from: from } });
    }
    return { data: data, log: log, from: from, to: SCHEMA_VERSION };
  }
  /* Invariants that a migration / restore must preserve: ids, stock per product, money per invoice, customer balances. */
  function invariants(data) {
    var out = { products: {}, invoices: {}, balances: {}, counts: {} };
    STORES.forEach(function (n) { out.counts[n] = (data[n] || []).length; });
    (data.products || []).forEach(function (p) { out.products[p.id] = p.stock; });
    (data.docs || []).forEach(function (d) {
      if (d.kind === 'out' && d.type === 'sale') {
        out.invoices[d.id] = [d.total, d.paid, d.refunded, d.balance].join('/');
        out.balances[d.customerId] = (out.balances[d.customerId] || 0) + d.balance;
      }
    });
    return out;
  }
  function sameInvariants(a, b, ignoreCounts) {
    var diffs = [];
    ['products', 'invoices', 'balances'].forEach(function (k) {
      var keys = {}; Object.keys(a[k]).forEach(function (x) { keys[x] = 1; }); Object.keys(b[k]).forEach(function (x) { keys[x] = 1; });
      Object.keys(keys).forEach(function (x) { if (String(a[k][x]) !== String(b[k][x])) diffs.push(k + ':' + x + ' ' + a[k][x] + ' → ' + b[k][x]); });
    });
    (ignoreCounts ? [] : ['products', 'customers', 'docs', 'payments', 'movements']).forEach(function (n) { if (a.counts[n] !== b.counts[n]) diffs.push('count:' + n + ' ' + a.counts[n] + ' → ' + b.counts[n]); });
    return diffs;
  }

  var api = { createEngine: createEngine, migrate: migrate, invariants: invariants, sameInvariants: sameInvariants, AppError: AppError,
    SCHEMA_VERSION: SCHEMA_VERSION, STORES: STORES,
    ISSUE_TYPES: ISSUE_TYPES, RECEIPT_TYPES: RECEIPT_TYPES, PAY_METHODS: PAY_METHODS, UI_ISSUE_TYPES: UI_ISSUE_TYPES, UI_RECEIPT_TYPES: UI_RECEIPT_TYPES,
    UI_PAY_METHODS: UI_PAY_METHODS, CUSTOMER_TYPES: CUSTOMER_TYPES, ATTR_TYPES: ATTR_TYPES,
    normText: normText, normSku: normSku, normPhone: normPhone, randomCode: randomCode,
    sha256Hex: sha256Hex, canon: canon, histView: histView, invKeyStrict: invKeyStrict, invKeySimilar: invKeySimilar, allocExact: allocExact,
    SETTLE_DOC: SETTLE_DOC, SETTLE_LINE: SETTLE_LINE, PERIOD_ALGO: PERIOD_ALGO, CHARGE_TYPES: { freight: 'حمل', vat: 'مالیات بر ارزش افزوده', other: 'سایر هزینه‌ها' },
    CHARGE_TREAT: { capitalize: 'سرشکن در بهای کالا', separate: 'جدا از بهای کالا' }, CHARGE_BASIS: { value: 'به نسبت مبلغ اقلام', qty: 'به نسبت تعداد', manual: 'دستی' } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof self !== 'undefined' ? self : this);
