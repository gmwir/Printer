/* v2.1 — Purchase invoice (Phase A, no OCR). Separate from the quick receipt form.
   Draft only (no effect on stock) until the final confirmation; then ONE atomic batch:
   [new products] + purchase receipt (FIFO layers, movements, duplicate marker, audit).
   All money math is done by the engine (E.computePurchase) so the preview always equals what is posted. */
(function () {
  'use strict';
  var A = window.App, E = A.E, DB = A.DB, UI = window.UI, h = UI.h, Core = window.Core, view = document.getElementById('view');
  var KEY = 'ay.draft.purchase', field = A.field, sel = A.sel;
  var TREAT = { capitalize: 'سرشکن در بهای کالا', separate: 'جدا از بهای کالا' }, BASIS = Core.CHARGE_BASIS, CTYPES = Core.CHARGE_TYPES;
  var COLS = [['code', 'کد کالا', ['کد', 'کد کالا', 'sku', 'کد فنی', 'شماره فنی', 'part no', 'partno', 'کد قطعه', 'code']], ['barcode', 'بارکد', ['بارکد', 'barcode', 'ean']],
    ['name', 'نام / شرح کالا', ['نام', 'نام کالا', 'شرح', 'شرح کالا', 'عنوان', 'description', 'name', 'کالا']], ['brand', 'برند', ['برند', 'مارک', 'brand']],
    ['qty', 'تعداد', ['تعداد', 'مقدار', 'qty', 'quantity']], ['price', 'فی (قیمت واحد)', ['فی', 'قیمت', 'قیمت واحد', 'مبلغ واحد', 'فی واحد', 'price', 'unit price']],
    ['disc', 'تخفیف ردیف', ['تخفیف', 'تخفیف ردیف', 'discount']], ['total', 'جمع ردیف', ['جمع', 'مبلغ کل', 'جمع کل', 'جمع ردیف', 'total', 'amount']]];

  function newDraft() { return { v: 1, opKey: UI.opKey('pinv'), supplierId: null, no: '', invDate: '', date: '', currency: 'toman', discount: null, discountAlloc: 'value', discountManual: null, charges: [], decSubtotal: null, decPayable: null, note: '', items: [], importFile: null }; }
  function load() { var d = A.lsGet(KEY); return d && d.v === 1 ? d : newDraft(); }
  function n0(v) { return v == null || v === '' || isNaN(v) ? null : v; }
  function rowKey() { return 'r' + Math.random().toString(36).slice(2, 9); }

  A.routes.purchase = function () {
    var d = load(), S = E.state;
    if (S.ops[d.opKey]) { // this draft was already posted (e.g. the app was closed right after saving): never post it twice
      var done = S.docs[S.ops[d.opKey].docId]; A.lsSet(KEY, null);
      UI.toast('این پیش‌نویس قبلاً ثبت شده است' + (done ? ' (سند ' + done.no + ')' : '') + '.', 'ok', 5000);
      if (done) { A.go('#/doc/' + done.id); return; }
      d = load();
    }
    function save() { A.lsSet(KEY, d); }
    var rdT = null; function redraw() { save(); clearTimeout(rdT); rdT = setTimeout(A.route, 0); } // v2.10: never rebuild the page inside the blur of the field being left
    A.setTitle('فاکتور خرید', true, h('button.tb-btn', { onclick: function () {
      UI.confirmBox('پیش‌نویس این فاکتور پاک شود؟ (هیچ اثری روی موجودی نداشته است)', 'پاک کردن', true).then(function (ok) { if (ok) { A.lsSet(KEY, null); A.route(); } });
    } }, 'پاک کردن'));
    d.items.forEach(function (it) { if (it.productId && !S.products[it.productId]) it.productId = null; });
    var cur = d.currency === 'rial' ? 'ریال' : 'تومان';

    view.appendChild(h('div.alert.ok', h('div.grow', h('b', 'این خرید وارد انبار می‌شود'), ' (موجودی و ارزش انبار زیاد می‌شود). کالایی که مستقیم به مشتری می‌فروشید و وارد انبار نمی‌شود را از «خرید و فروش مستقیم» ثبت کنید.'), h('a.btn.sm', { href: '#/deals?new=buy' }, 'خرید مستقیم'))); // v2.8: which kind of purchase this is, stated up front
    // ---------- header ----------
    var sp = d.supplierId && S.suppliers[d.supplierId];
    var noIn = h('input.in', { value: d.no, placeholder: 'مثلاً ۱۲۵۴', onchange: function () { d.no = noIn.value.trim(); redraw(); } });
    var invDate = h('input.in', { value: d.invDate, inputmode: 'numeric', placeholder: 'تاریخ روی فاکتور', onchange: function () { d.invDate = invDate.value; redraw(); } });
    var recDate = h('input.in', { value: d.date || UI.todayStr(), inputmode: 'numeric', onchange: function () { d.date = recDate.value; redraw(); } });
    var curSel = sel({ toman: 'تومان', rial: 'ریال' }, d.currency, { onchange: function () { d.currency = curSel.value; redraw(); } });
    var decSub = A.moneyInput(d.decSubtotal, 'جمع اقلام روی فاکتور'), decPay = A.moneyInput(d.decPayable, 'مبلغ قابل پرداخت روی فاکتور');
    decSub.input.addEventListener('change', function () { d.decSubtotal = n0(decSub.value()); redraw(); });
    decPay.input.addEventListener('change', function () { d.decPayable = n0(decPay.value()); redraw(); });
    view.appendChild(h('div.card', h('h2', 'سربرگ فاکتور'),
      h('label.f', h('span', 'تأمین‌کننده', h('i', ' *')), sp ? h('div.row', h('div.grow.card', { style: { margin: 0, padding: '8px 12px' } }, h('b', sp.name), sp.phone ? h('div.small.muted.ltr', sp.phone) : null),
        h('button.btn.sm', { onclick: function () { A.pickSupplier(function (x) { d.supplierId = x.id; redraw(); }); } }, 'تغییر'))
        : h('button.btn.block', { onclick: function () { A.pickSupplier(function (x) { d.supplierId = x.id; redraw(); }); } }, '+ انتخاب یا تعریف تأمین‌کننده')),
      h('div.grid2', field('شماره فاکتور تأمین‌کننده', noIn, null, true), field('تاریخ فاکتور', invDate)),
      h('div.grid2', field('تاریخ دریافت کالا (تاریخ سند)', recDate), field('واحد مبالغ فاکتور', curSel)),
      h('div.grid2', field('جمع اقلام (اعلامی)', decSub.input, decSub.hint), field('قابل پرداخت (اعلامی)', decPay.input, decPay.hint)),
      h('p.small.muted', 'مبالغ اعلامی را دقیقاً از روی فاکتور وارد کنید؛ با جمع محاسبه‌شده مقایسه می‌شوند.')));

    // ---------- items ----------
    var itemsCard = h('div.card', { style: { padding: '4px 14px' } });
    view.appendChild(h('div.row.between', { style: { margin: '14px 4px 8px' } }, h('b', 'اقلام (' + UI.fa(d.items.length) + ')'),
      h('div.row.wrap', h('button.btn.sm.accent', { onclick: scan }, UI.icon('scan'), 'اسکن'), h('button.btn.sm', { onclick: pick }, 'از انبار'),
        h('button.btn.sm', { onclick: manualCode }, 'کد دستی'), h('button.btn.sm', { onclick: importFile }, 'Excel / CSV'))));
    if (!d.items.length) itemsCard.appendChild(h('div.empty', 'کالایی اضافه نشده. با اسکن، انتخاب از انبار، کد دستی یا فایل Excel/CSV اقلام را وارد کنید.'));
    d.items.forEach(function (it, idx) { itemsCard.appendChild(itemRow(it, idx)); });
    view.appendChild(itemsCard);

    // ---------- discount & charges ----------
    var disc = A.moneyInput(d.discount, 'تخفیف کلی فاکتور (' + cur + ')');
    disc.input.addEventListener('change', function () { d.discount = n0(disc.value()); redraw(); });
    var allocSel = sel({ value: 'به نسبت مبلغ اقلام', manual: 'تخصیص دستی (مدیر)' }, d.discountAlloc, { onchange: function () {
      if (allocSel.value === 'manual') manualAlloc('تخصیص دستی تخفیف کلی', d.discount || 0, d.discountManual, function (v) { d.discountAlloc = 'manual'; d.discountManual = v; redraw(); }, function () { allocSel.value = d.discountAlloc; });
      else { d.discountAlloc = 'value'; d.discountManual = null; redraw(); }
    } });
    var chBox = h('div');
    d.charges.forEach(function (c, ci) {
      var am = A.moneyInput(c.amount, 'مبلغ (' + cur + ')'); am.input.addEventListener('change', function () { c.amount = n0(am.value()); redraw(); });
      var tr = sel(c.type === 'vat' ? { '': '— انتخاب کنید (الزامی) —', capitalize: TREAT.capitalize, separate: TREAT.separate } : TREAT, c.treatment || '', { onchange: function () { c.treatment = tr.value || null; redraw(); } });
      var bs = sel(BASIS, c.basis || 'value', { onchange: function () {
        if (bs.value === 'manual') manualAlloc('تخصیص دستی «' + CTYPES[c.type] + '»', c.amount || 0, c.manual, function (v) { c.basis = 'manual'; c.manual = v; redraw(); }, function () { bs.value = c.basis || 'value'; });
        else { c.basis = bs.value; c.manual = null; redraw(); }
      } });
      chBox.appendChild(h('div.line', h('div.row', h('b.grow', CTYPES[c.type]), h('button.btn.sm.ghost', { onclick: function () { d.charges.splice(ci, 1); redraw(); } }, '✕')),
        h('div.grid2', h('div', am.input, am.hint), field('روش اعمال', tr)), c.treatment === 'capitalize' ? field('مبنای سرشکن', bs) : null,
        c.type === 'vat' && !c.treatment ? h('div.hint.bad', 'برای مالیات پیش‌فرضی وجود ندارد؛ روش را برای همین فاکتور انتخاب کنید.') : null));
    });
    view.appendChild(h('div.card', h('h2', 'تخفیف کلی، هزینه‌ها و مالیات'), h('div', disc.input, disc.hint), field('تقسیم تخفیف کلی بین اقلام', allocSel), chBox,
      h('div.row.wrap', ['freight', 'vat', 'other'].map(function (t) { return h('button.btn.sm', { onclick: function () { d.charges.push({ type: t, amount: null, treatment: t === 'vat' ? null : 'capitalize', basis: 'value' }); redraw(); } }, '+ ' + CTYPES[t]); }))));

    // ---------- preview ----------
    var ts = d.date ? UI.parseDateInput(d.date) : null, invTs = d.invDate ? UI.parseDateInput(d.invDate) : null;
    var calc = null, calcErr = null, ready = d.items.length && d.items.every(function (it) { return (it.productId || it.newProd) && it.qty > 0 && it.unitPrice != null; });
    if (ready) { try { calc = E.computePurchase({ invoice: invoicePayload({}), items: d.items.map(itemPayload) }); } catch (e) { calcErr = e.message; } }
    var pv = h('div.card', h('h2', 'پیش‌نمایش کامل'));
    if (!ready) pv.appendChild(h('p.muted', 'برای پیش‌نمایش، همه ردیف‌ها باید کالا، تعداد و فی داشته باشند.'));
    if (calcErr) pv.appendChild(h('div.alert.bad', calcErr));
    if (calc) {
      pv.appendChild(h('div.table-wrap', h('table.t', h('thead', h('tr', ['کالا', 'تعداد', 'فی', 'تخفیف ردیف', 'سهم تخفیف کلی', 'هزینه‌ها', 'بهای خالص', 'بهای واحد', 'موجودی ← پس از ثبت'].map(function (x) { return h('th', x); }))),
        h('tbody', calc.lines.map(function (l, i) {
          var it = d.items[i], p = it.productId && S.products[it.productId], nm = p ? p.name : (it.newProd ? it.newProd.name + ' (جدید)' : '؟');
          var ch = l.charges.reduce(function (s, x) { return s + x; }, 0), warn = p && p.buyPrice > 0 && Math.abs(l.unitCost - p.buyPrice) / p.buyPrice > 0.5;
          return h('tr', h('td', nm, warn ? h('div.small', { style: { color: 'var(--warn)' } }, '⚠ با آخرین خرید (' + UI.money(p.buyPrice) + ') بیش از ۵۰٪ فاصله دارد') : null), h('td.n', UI.qty(l.qty)), h('td.n', UI.money(l.unitPrice)),
            h('td.n', UI.money(l.lineDiscount)), h('td.n', UI.money(l.invDisc)), h('td.n', UI.money(ch)), h('td.n', UI.money(l.costTotal)), h('td.n', UI.money(l.unitCost)),
            h('td.n', p ? UI.qty(p.stock) + ' ← ' + UI.qty(p.stock + l.qty) : '۰ ← ' + UI.qty(l.qty)));
        })))));
      var mm = function (k) { return calc.mismatch.filter(function (x) { return x.field === k; })[0]; };
      pv.appendChild(h('div', h('div.tot', h('span', 'جمع اقلام (' + cur + ')'), h('b', UI.money(calc.subtotal)), mm('subtotal') ? h('span.badge.bad', 'اعلامی ' + UI.money(mm('subtotal').declared)) : null),
        calc.discount ? h('div.tot', h('span', 'تخفیف کلی'), h('b', '− ' + UI.money(calc.discount))) : null,
        calc.charges.map(function (c) { return h('div.tot', h('span', c.label + ' — ' + TREAT[c.treatment]), h('b', '+ ' + UI.money(c.amount))); }),
        h('div.tot.grand', h('span', 'قابل پرداخت (' + cur + ')'), h('b', UI.money(calc.payable)), mm('payable') ? h('span.badge.bad', 'اعلامی ' + UI.money(mm('payable').declared)) : null),
        d.currency === 'rial' ? h('div.tot', h('span', 'معادل تومان'), h('b', UI.moneyT(calc.payableT))) : null,
        h('div.tot', h('span', 'بهای کالاها که وارد موجودی می‌شود'), h('b', UI.moneyT(calc.costTotalT))), calc.separateT ? h('div.tot', h('span', 'جدا از بهای کالا (مثلاً مالیات)'), h('b', UI.moneyT(calc.separateT))) : null,
        calc.mismatch.length ? h('div.alert.bad', 'جمع محاسبه‌شده با جمع اعلامی فاکتور برابر نیست؛ اعداد را بررسی کنید. ثبت با اختلاف فقط با تأیید مدیر و ذکر علت.') : (d.decPayable != null || d.decSubtotal != null ? h('div.alert.ok', 'جمع محاسبه‌شده با جمع اعلامی فاکتور برابر است ✓') : null),
        h('p.small.muted', 'قیمت فروش هیچ کالایی تغییر نمی‌کند. «آخرین قیمت خرید» هر کالا برابر بهای خالص واحد می‌شود.')));
    }
    // duplicate check (live, read-only; the engine checks again when posting)
    if (d.supplierId && (d.no || calc)) {
      var dup = E.findPurchaseDuplicates({ supplierId: d.supplierId, no: d.no, date: invTs != null && !isNaN(invTs) ? invTs : (ts != null && !isNaN(ts) ? ts : Date.now()), payableT: calc ? calc.payableT : null });
      var WHY = { strict: 'همان شماره', similar: 'شماره مشابه', date_amount: 'همان تاریخ و مبلغ' };
      var lst = function (a) { return a.map(function (x) { return h('a', { href: '#/doc/' + x.docId, style: { display: 'block' } }, x.no + (x.supplierDocNo ? ' / فاکتور ' + x.supplierDocNo : '') + ' — ' + WHY[x.why] + ' (' + UI.dateFa(x.ts) + ')'); }); };
      if (dup.definite.length || dup.probable.length) pv.appendChild(h('div.alert.bad', h('div.grow', h('b', dup.definite.length ? 'این فاکتور قبلاً ثبت شده است:' : 'فاکتور مشابه قبلاً ثبت شده است:'), lst(dup.definite.concat(dup.probable)), h('div.small', 'ثبت دوباره به‌طور پیش‌فرض مسدود است و فقط با تأیید صریح مدیر و ذکر علت ممکن است.'))));
      if (dup.reversed.length) pv.appendChild(h('div.alert.warn', h('div.grow', h('b', 'فاکتور با همین مشخصات قبلاً ثبت و لغو شده است:'), lst(dup.reversed))));
    }
    view.appendChild(pv);
    var noteIn = h('input.in', { value: d.note || '', placeholder: 'اختیاری', onchange: function () { d.note = noteIn.value; save(); } });
    view.appendChild(h('div.card', field('توضیحات', noteIn)));
    d.pay = d.pay || {}; // v2.10: the supplier's account (debt / paid now), asked here
    if (calc && d.supplierId) view.appendChild(A.settleBox(d.pay, calc.payableT, save));
    var canPost = !!(ready && calc && d.supplierId);
    var go = h('button.btn.primary.block', { disabled: !canPost, onclick: submit }, 'ثبت نهایی فاکتور خرید');
    view.appendChild(h('div.sticky-act', go));

    // ---------- helpers ----------
    function invoicePayload(fl) {
      var o = { no: d.no, date: invTs != null && !isNaN(invTs) ? invTs : null, currency: d.currency, discount: d.discount || 0, discountAlloc: d.discountAlloc, discountManual: d.discountManual,
        charges: d.charges.filter(function (c) { return c.amount; }).map(function (c) { return { type: c.type, amount: c.amount, treatment: c.treatment || null, basis: c.basis || 'value', manual: c.manual || null }; }),
        declared: { subtotal: d.decSubtotal, payable: d.decPayable }, importFile: d.importFile };
      if (fl.DUPLICATE_INVOICE) o.duplicateOk = { reason: fl.DUPLICATE_INVOICE };
      if (fl.TOTAL_MISMATCH) o.mismatchOk = { reason: fl.TOTAL_MISMATCH };
      if (fl.NEED_INVOICE_NO) o.noNumberOk = { reason: fl.NEED_INVOICE_NO };
      return o;
    }
    function itemPayload(it) { return { productId: it.productId, qty: it.qty, unitPrice: it.unitPrice, lineDiscount: it.lineDiscount || 0, match: it.match }; }
    function addProduct(p, how, n) { // n (v2.2): units of one scan (box barcode -> box quantity)
      n = n || 1;
      var ex = d.items.filter(function (x) { return x.productId === p.id && (x.match === 'scan' || x.match === 'pick' || x.match === 'code'); })[0];
      if (ex && how !== 'code') ex.qty += n; else d.items.push({ key: rowKey(), productId: p.id, qty: n, unitPrice: null, lineDiscount: null, match: how });
    }
    function scan() {
      var inCart = function (pid) { return d.items.filter(function (x) { return x.productId === pid; }).reduce(function (s, x) { return s + x.qty; }, 0); };
      A.openScanner({ mode: 'pick', title: 'اسکن برای فاکتور خرید', addTo: 'in', checkStock: false, inCart: inCart, avail: function (pid) { return S.products[pid].stock; },
        onPick: function (p, n) { addProduct(p, 'scan', n); save(); }, onAdjust: function (p, delta) { var it = d.items.filter(function (x) { return x.productId === p.id; })[0]; if (it) { it.qty = Math.max(1, it.qty + delta); save(); } },
        onRemove: function (p) { d.items = d.items.filter(function (x) { return x.productId !== p.id; }); save(); },
        summary: function () { return { lines: d.items.length, qty: d.items.reduce(function (s, x) { return s + x.qty; }, 0) }; }, onClose: function () { A.route(); } });
    }
    function pick() { A.pickProduct('افزودن کالا به فاکتور خرید', function (p) { addProduct(p, 'pick'); redraw(); }); }
    function matchCode(code) { // only certain rules: exact barcode/QR mapping, exact SKU
      var byCode = E.findProductByCode(code), bySku = E.findProductBySku(code);
      if (byCode && bySku && byCode.id !== bySku.id) return { conflict: [byCode.id, bySku.id] };
      return { product: byCode || bySku || null };
    }
    function manualCode() {
      UI.promptBox('کد یا بارکد کالا', 'کد داخلی، بارکد کارخانه یا کد QR', { ltr: true }).then(function (code) {
        code = String(code || '').trim(); if (!code) return;
        var m = matchCode(code);
        if (m.product) addProduct(m.product, 'code');
        else d.items.push({ key: rowKey(), productId: null, qty: 1, unitPrice: null, lineDiscount: null, match: null, raw: { code: code }, candidates: m.conflict || A.productSearch(code).slice(0, 3).map(function (p) { return p.id; }), conflict: !!m.conflict });
        redraw();
      });
    }
    function itemRow(it, idx) {
      var p = it.productId && S.products[it.productId], st = p ? (it.conflict ? 'need' : 'ok') : it.newProd ? 'new' : 'need';
      var badge = { ok: h('span.badge.ok', it.match === 'confirmed' ? 'تأیید دستی' : 'قطعی'), need: h('span.badge.bad', it.conflict ? 'تعارض کد — انتخاب کنید' : 'نیازمند تأیید'), new: h('span.badge.warn', 'کالای جدید') }[st];
      var title = p ? p.name : it.newProd ? it.newProd.name : [it.raw && it.raw.name, it.raw && it.raw.brand, it.raw && (it.raw.code || it.raw.barcode)].filter(Boolean).join(' · ') || 'ردیف بدون مشخصات';
      var up = A.moneyInput(it.unitPrice, 'فی (' + cur + ')'), ld = A.moneyInput(it.lineDiscount, 'تخفیف ردیف');
      up.input.addEventListener('change', function () { it.unitPrice = n0(up.value()); redraw(); });
      ld.input.addEventListener('change', function () { it.lineDiscount = n0(ld.value()); redraw(); });
      var line = it.unitPrice != null ? it.qty * it.unitPrice - (it.lineDiscount || 0) : null;
      var row = h('div.line', h('div.row', h('div.grow', h('b', title), ' ', badge, p ? h('div.small.muted', [p.brand, p.sku].filter(Boolean).join(' · ') + ' · موجودی: ' + UI.qty(p.stock)) : null),
        h('button.btn.sm.ghost', { 'aria-label': 'حذف', onclick: function () { d.items.splice(idx, 1); redraw(); } }, '✕')),
        h('div.row.between', { style: { marginTop: '6px' } }, A.stepper(it.qty, function (v) { it.qty = v; save(); }), line != null ? h('div.small', 'جمع ردیف: ', h('b', UI.money(line))) : null),
        h('div.grid2', { style: { marginTop: '6px' } }, h('div', up.input, up.hint), h('div', ld.input, ld.hint)),
        it.fileTotal != null && line != null && it.fileTotal !== line ? h('div.hint', { style: { color: 'var(--warn)' } }, '⚠ جمع این ردیف در فایل ' + UI.money(it.fileTotal) + ' است؛ با تعداد × فی − تخفیف (' + UI.money(line) + ') نمی‌خواند.') : null);
      if (st !== 'ok') {
        var acts = h('div.row.wrap', { style: { marginTop: '6px' } });
        (it.candidates || []).forEach(function (cid) { var c = S.products[cid]; if (c) acts.appendChild(h('button.btn.sm', { onclick: function () { it.productId = c.id; it.newProd = null; it.conflict = false; it.match = 'confirmed'; redraw(); } }, 'این است: ' + c.name + (c.sku ? ' (' + c.sku + ')' : ''))); });
        acts.appendChild(h('button.btn.sm', { onclick: function () { A.pickProduct('کالای این ردیف', function (c) { it.productId = c.id; it.newProd = null; it.conflict = false; it.match = 'confirmed'; redraw(); }); } }, 'انتخاب از انبار'));
        acts.appendChild(h('button.btn.sm', { onclick: function () { newProductSheet(it); } }, it.newProd ? 'ویرایش کالای جدید' : 'تعریف کالای جدید'));
        row.appendChild(acts);
      }
      return row;
    }
    function autoSku() { var n = Object.keys(S.products).length + 1, s; do { s = 'AY-' + ('0000' + n).slice(-4); n++; } while (E.findProductBySku(s) || d.items.some(function (x) { return x.newProd && x.newProd.sku === s; })); return s; }
    function newProductSheet(it) {
      var np = it.newProd || { name: (it.raw && it.raw.name) || '', brand: (it.raw && it.raw.brand) || '', sku: (it.raw && it.raw.code) || autoSku(), sellPrice: null, barcodes: it.raw && it.raw.barcode ? [it.raw.barcode] : [] };
      var nm = h('input.in', { value: np.name }), br = h('input.in', { value: np.brand }), sk = h('input.in.ltr-in', { value: np.sku }), spr = A.moneyInput(np.sellPrice, 'اختیاری'), msg = h('div');
      function check() {
        UI.clear(msg);
        var dups = E.findDuplicates({ sku: sk.value, name: nm.value, brand: br.value });
        dups.forEach(function (x) {
          msg.appendChild(h('div.alert.warn', h('div.grow', (x.kind === 'sku' ? 'این کد قبلاً برای «' : 'کالای هم‌نام و هم‌برند وجود دارد: «') + x.product.name + '»'),
            h('button.btn.sm', { onclick: function () { it.productId = x.product.id; it.newProd = null; it.conflict = false; it.match = 'confirmed'; s.close(); redraw(); } }, 'همین کالاست')));
        });
      }
      [nm, br, sk].forEach(function (x) { x.addEventListener('change', check); });
      // v2.10: while the name is typed, the products already in the app are offered (smart search) — no second copy by a space or a dash
      var sug = h('div'), tmr = null;
      function suggest() {
        UI.clear(sug); var q = nm.value.trim(); if (q.length < 3) return;
        var r = A.searchSmart(q + (br.value.trim() ? ' ' + br.value.trim() : '')), seen = {}, L = [];
        r.list.concat(r.near.map(function (c) { return c.product; })).forEach(function (p) { if (!seen[p.id] && L.length < 6) { seen[p.id] = 1; L.push(p); } });
        if (!L.length && br.value.trim()) { r = A.searchSmart(q); r.list.concat(r.near.map(function (c) { return c.product; })).forEach(function (p) { if (!seen[p.id] && L.length < 6) { seen[p.id] = 1; L.push(p); } }); }
        if (!L.length) return;
        sug.appendChild(h('div.small.muted', { style: { margin: '6px 0 2px' } }, 'این کالاها در اپ هست؛ اگر همان است انتخاب کنید:'));
        sug.appendChild(h('div.list', L.map(function (p) {
          return h('button.li', { type: 'button', style: { width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'right' },
            onclick: function () { it.productId = p.id; it.newProd = null; it.conflict = false; it.match = 'confirmed'; s.close(); redraw(); } },
            h('div.grow', h('div.t', p.name), h('div.s', [p.brand, p.sku].filter(Boolean).join(' · '))), h('span.badge.ok', 'همین است'));
        })));
      }
      [nm, br].forEach(function (x) { x.addEventListener('input', function () { clearTimeout(tmr); tmr = setTimeout(suggest, 150); }); });
      var s = UI.sheet('تعریف کالای جدید (هنگام ثبت نهایی ساخته می‌شود)', h('div.stack', field('نام کالا', nm, null, true), sug, field('برند', br), field('کد داخلی (SKU)', sk, null, true), field('قیمت فروش', spr.input, spr.hint), msg,
        h('p.small.muted', 'تا ثبت نهایی فاکتور هیچ کالایی ساخته نمی‌شود؛ اگر ثبت انجام نشود، کالا هم ساخته نمی‌شود.'),
        h('button.btn.primary.block', { onclick: function () {
          if (!nm.value.trim() || !sk.value.trim()) { UI.toast('نام و کد کالا الزامی است.', 'bad'); return; }
          if (E.findProductBySku(sk.value)) { UI.toast('این کد قبلاً استفاده شده است.', 'bad'); return; }
          var sv = spr.value(); if (sv != null && (isNaN(sv) || sv < 0)) { UI.toast('قیمت فروش نامعتبر است.', 'bad'); return; }
          it.newProd = { name: nm.value.trim(), brand: br.value.trim(), sku: sk.value.trim(), sellPrice: n0(sv), barcodes: np.barcodes || [] }; it.productId = null; it.conflict = false; it.match = 'new';
          s.close(); redraw();
        } }, 'تأیید کالای جدید')));
      check(); suggest();
    }
    function manualAlloc(title, total, current, onOk, onCancel) {
      if (!d.items.length) { UI.toast('ابتدا اقلام را وارد کنید.', 'bad'); if (onCancel) onCancel(); return; }
      A.manager('تخصیص دستی').then(function (ctx) {
        if (!ctx) { if (onCancel) onCancel(); return; }
        var ins = d.items.map(function (it, i) { return A.moneyInput(current && current[i] != null ? current[i] : 0, 'سهم ردیف ' + UI.fa(i + 1)); }), sum = h('b');
        function upd() { var t = ins.reduce(function (s, x) { return s + (x.value() || 0); }, 0); sum.textContent = UI.money(t) + ' از ' + UI.money(total); sum.style.color = t === total ? 'var(--ok)' : 'var(--bad)'; }
        ins.forEach(function (x) { x.input.addEventListener('input', upd); });
        var s = UI.sheet(title, h('div.stack', d.items.map(function (it, i) { var p = it.productId && S.products[it.productId]; return field((p ? p.name : (it.newProd || {}).name) || 'ردیف ' + UI.fa(i + 1), ins[i].input, ins[i].hint); }),
          h('div.tot', h('span', 'جمع سهم‌ها'), sum),
          h('button.btn.primary.block', { onclick: function () {
            var v = ins.map(function (x) { return x.value() || 0; });
            if (v.some(function (x) { return isNaN(x) || x < 0 || !Number.isInteger(x); }) || v.reduce(function (a, b) { return a + b; }, 0) !== total) { UI.toast('جمع سهم‌ها باید دقیقاً برابر ' + UI.money(total) + ' باشد.', 'bad'); return; }
            s.close(); onOk(v);
          } }, 'ذخیره تخصیص')), { onClose: function () {} });
        upd();
      });
    }
    function importFile() {
      UI.pickFile('.xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').then(function (f) {
        if (!f) return;
        UI.readFileBytes(f).then(function (bytes) {
          var isX = /\.xlsx$/i.test(f.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
          var hashP = window.crypto && crypto.subtle ? crypto.subtle.digest('SHA-256', bytes).then(function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }) : Promise.resolve('');
          return Promise.all([hashP, isX ? window.XLSX.readXlsx(bytes) : { sheets: [{ name: 'CSV', rows: window.XLSX.readCsv(bytes) }] }]);
        }).then(function (r) { mapSheet(f.name, r[0], r[1].sheets.filter(function (s) { return s.rows.length; })[0]); }).catch(function (e) { UI.toast('فایل خوانده نشد: ' + (e.message || e), 'bad'); });
      });
    }
    function normH(s) { return Core.normText(s).replace(/[‌_\-]/g, ' ').replace(/\s+/g, ' ').trim(); }
    function mapSheet(name, hash, sheet) {
      if (!sheet) { UI.toast('فایل خالی است.', 'bad'); return; }
      var rows = sheet.rows, hi = 0; while (hi < rows.length && rows[hi].filter(function (c) { return String(c).trim(); }).length < 2) hi++;
      var header = (rows[hi] || []).map(String), data = rows.slice(hi + 1), map = {};
      COLS.forEach(function (c) { header.forEach(function (hd, i) { if (map[c[0]] == null && c[2].map(normH).indexOf(normH(hd)) >= 0 && Object.keys(map).every(function (k) { return map[k] !== i; })) map[c[0]] = i; }); });
      var opts = { '-1': '— ندارد —' }; header.forEach(function (hd, i) { opts[i] = hd || ('ستون ' + UI.fa(i + 1)); });
      var sels = COLS.map(function (c) { return sel(opts, map[c[0]] == null ? '-1' : String(map[c[0]])); });
      var s = UI.sheet('ستون‌های فایل ' + name, h('div.stack', h('p.small.muted', UI.fa(data.length) + ' ردیف. ستون‌ها را بررسی کنید؛ ردیف‌ها فقط به پیش‌نویس اضافه می‌شوند و تا ثبت نهایی اثری روی موجودی ندارند.'),
        COLS.map(function (c, i) { return field(c[1], sels[i]); }),
        h('button.btn.primary.block', { onclick: function () {
          var m = {}; COLS.forEach(function (c, i) { if (sels[i].value !== '-1') m[c[0]] = +sels[i].value; });
          if (m.qty == null || m.price == null || (m.code == null && m.barcode == null && m.name == null)) { UI.toast('ستون تعداد، فی و حداقل یکی از کد/بارکد/نام لازم است.', 'bad'); return; }
          var added = 0, bad = 0;
          data.forEach(function (r) {
            var g = function (k) { return m[k] == null ? '' : String(r[m[k]] == null ? '' : r[m[k]]).trim(); }, num = function (k) { var v = UI.parseNum(g(k)); return v == null || isNaN(v) ? null : v; };
            if (!g('code') && !g('barcode') && !g('name')) return;
            var qty = num('qty'), price = num('price'), ld = num('disc'), tot = num('total');
            var it = { key: rowKey(), productId: null, qty: Number.isInteger(qty) && qty > 0 ? qty : 1, unitPrice: price != null && price >= 0 ? Math.round(price) : null, lineDiscount: ld != null && ld >= 0 ? Math.round(ld) : null,
              match: null, raw: { code: g('code'), barcode: g('barcode'), name: g('name'), brand: g('brand') }, fileTotal: tot != null ? Math.round(tot) : null };
            if (!(Number.isInteger(qty) && qty > 0) || it.unitPrice == null) bad++;
            var byBar = it.raw.barcode ? E.findProductByCode(it.raw.barcode) : null, mc = it.raw.code ? matchCode(it.raw.code) : {};
            var bySku = mc.product || null;
            if (mc.conflict || (byBar && bySku && byBar.id !== bySku.id)) { it.conflict = true; it.candidates = mc.conflict || [byBar.id, bySku.id]; }
            else if (byBar || bySku) { it.productId = (byBar || bySku).id; it.match = byBar ? 'file-barcode' : 'file-code'; }
            else it.candidates = it.raw.name ? A.productSearch([it.raw.name, it.raw.brand].filter(Boolean).join(' ')).slice(0, 3).map(function (p) { return p.id; }) : []; // name: suggestion only
            d.items.push(it); added++;
          });
          d.importFile = { name: name, sha256: hash };
          s.close(); redraw(); UI.toast(UI.fa(added) + ' ردیف به پیش‌نویس اضافه شد' + (bad ? '؛ ' + UI.fa(bad) + ' ردیف تعداد یا فی نامعتبر دارد (بررسی کنید)' : '') + '.', bad ? 'bad' : 'ok', 5000);
        } }, 'افزودن به پیش‌نویس')));
    }
    function overrideSheet(e) {
      var T = { DUPLICATE_INVOICE: 'ثبت فاکتور تکراری / مشابه', TOTAL_MISMATCH: 'ثبت با اختلاف جمع', NEED_INVOICE_NO: 'ثبت فاکتور بدون شماره' };
      return new Promise(function (res) {
        var why = h('input.in', { placeholder: 'علت (الزامی)' }), chk = h('input', { type: 'checkbox' });
        var s = UI.sheet(T[e.code], h('div.stack', h('div.alert.bad', e.message), field('علت', why, null, true),
          h('label.check', chk, e.code === 'DUPLICATE_INVOICE' ? 'تأیید صریح: می‌دانم فاکتور مشابه قبلاً ثبت شده و این یک فاکتور جداست.' : 'تأیید صریح: این مورد را بررسی کرده‌ام.'),
          h('button.btn.danger.block', { onclick: function () {
            if (!why.value.trim()) { UI.toast('علت را بنویسید.', 'bad'); return; }
            if (!chk.checked) { UI.toast('تأیید صریح را بزنید.', 'bad'); return; }
            s.close(why.value.trim());
          } }, 'ادامه با رمز مدیر')), { onClose: function (v) { res(typeof v === 'string' ? v : null); } });
      });
    }
    function submit() {
      if (!d.supplierId) { UI.toast('تأمین‌کننده را انتخاب کنید.', 'bad'); return; }
      if (ts !== null && isNaN(ts)) { UI.toast('تاریخ دریافت نامعتبر است.', 'bad'); return; }
      if (d.invDate && (invTs == null || isNaN(invTs))) { UI.toast('تاریخ فاکتور نامعتبر است.', 'bad'); return; }
      var sc = calc ? A.settleCheck(d.pay || {}, calc.payableT) : null; if (sc) { UI.toast(sc, 'bad'); return; }
      go.disabled = true; go.textContent = 'در حال ثبت…';
      function build(ctx, fl) {
        var fns = [], at = {};
        d.items.forEach(function (it, i) {
          if (it.productId || !it.newProd) return;
          at[i] = fns.length;
          fns.push(function () { return E.createProduct(Object.assign({}, it.newProd, { supplierId: d.supplierId, allowDuplicate: !!fl.allowDup, buyPrice: null }), ctx); });
        });
        fns.push(function (done) {
          return E.postReceipt({ opKey: d.opKey, type: 'purchase', ts: ts || undefined, supplierId: d.supplierId, note: d.note, invoice: invoicePayload(fl),
            items: d.items.map(function (it, i) { var x = itemPayload(it); if (!x.productId) x.productId = done[at[i]].product.id; return x; }) }, ctx);
        });
        A.settleSteps(fns, fns.length - 1, d.pay, d.supplierId, d.opKey, ctx); // v2.10: debt + payment, all or nothing
        return DB.batch(fns);
      }
      function attempt(ctx, fl) {
        return DB.run(build(ctx, fl)).catch(function (e) {
          var c = e && e.code;
          if (c === 'BACKDATE_LIMIT' && !ctx.manager) return A.manager('ثبت با تاریخ بیش از ۷ روز گذشته').then(function (m) { if (!m) throw e; return attempt(m, fl); });
          if ((c === 'DUPLICATE_INVOICE' || c === 'TOTAL_MISMATCH' || c === 'NEED_INVOICE_NO') && !fl[c]) return overrideSheet(e).then(function (reason) {
            if (!reason) throw e;
            return A.manager(c === 'DUPLICATE_INVOICE' ? 'ثبت فاکتور مشابه' : c === 'TOTAL_MISMATCH' ? 'ثبت با اختلاف جمع' : 'ثبت بدون شماره فاکتور').then(function (m) { if (!m) throw e; fl[c] = reason; return attempt(m, fl); });
          });
          if (c === 'DUP_NAME' && !fl.allowDup) return UI.confirmBox(e.message + ' کالای جدید جدا ثبت شود؟', 'ثبت جدا').then(function (ok) { if (!ok) throw e; fl.allowDup = true; return attempt(ctx, fl); });
          throw e;
        });
      }
      attempt(A.userCtx(), {}).then(function (res) {
        var r = res.filter(function (x) { return x && x.doc && x.docId; }).pop() || res[res.length - 1]; A.lsSet(KEY, null);
        UI.toast(r.duplicate ? 'این فاکتور قبلاً ثبت شده بود (ثبت تکراری انجام نشد).' : 'فاکتور خرید ' + r.doc.no + ' ثبت شد؛ موجودی افزایش یافت.', 'ok', 4000); A.go('#/doc/' + r.docId);
      }, function (e) { go.disabled = false; go.textContent = 'ثبت نهایی فاکتور خرید'; A.showErr(e); });
    }
  };
})();
