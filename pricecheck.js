/* v2.10 «بررسی قیمت‌های مشکوک»: finds prices that are probably wrong and fixes them only on the user's choice.
   1) the same product priced differently by two purchase lists of (about) the same day -> remove from the wrong list (one tap for all rows of a list);
   2) a sale price that is not «today's purchase price + the saved profit % of its brand / group» -> rebuild (ticked rows only);
   3) a sale price below the purchase cost; 4) a list price that jumped ≥ 50 % from the previous list.
   Nothing changes without the user; every change is recorded (price history / «سابقه ورود»). */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = window.UI, h = UI.h, Core = window.Core, view = document.getElementById('view');
  var DAY36 = 36 * 3600e3;
  function sellOf(cost, pct) { return Math.ceil(cost * (100 + pct) / 100 / 1000 - 1e-9) * 1000; }
  function pctFor(p, cfg) { var N = Core.normText; return p.categoryId && cfg.groups[p.categoryId] != null ? cfg.groups[p.categoryId] : cfg.brands[N(p.brand || '')]; }
  A.priceIssues = function () {
    var L = E.priceLists(), conf = [], cfg = E.getMeta('markup') || {}; cfg = { brands: cfg.brands || {}, groups: cfg.groups || {} };
    L.forEach(function (a, i) { L.slice(i + 1).forEach(function (b) {
      if (Math.abs(a.date - b.date) >= DAY36) return;
      Object.keys(a.items).forEach(function (pid) { var p = E.state.products[pid]; if (p && b.items[pid] != null && b.items[pid] !== a.items[pid]) conf.push({ p: p, a: a, b: b }); });
    }); });
    var conflictPid = {}; conf.forEach(function (x) { conflictPid[x.p.id] = 1; });
    var rebuild = [], loss = [], jump = [];
    Object.keys(E.state.products).forEach(function (id) {
      var p = E.state.products[id]; if (p.active === false) return;
      var rp = E.replacementCost(id, null), cost = p.costedQty > 0 ? Math.round(p.costBasis / p.costedQty) : null;
      if (rp && rp.kind === 'list' && !conflictPid[id]) { var pct = pctFor(p, cfg); if (pct != null) { var sp = sellOf(rp.unitCost, pct); if (sp !== p.sellPrice) rebuild.push({ p: p, cost: rp.unitCost, pct: pct, sell: sp }); } }
      var ref = cost != null && p.stock > 0 ? cost : rp ? rp.unitCost : null;
      if (p.sellPrice != null && ref != null && p.sellPrice < ref) loss.push({ p: p, ref: ref });
      var mine = L.filter(function (pl) { return pl.items[id] != null; });
      if (mine.length >= 2) { var x = mine[mine.length - 1].items[id], y = mine[mine.length - 2].items[id]; if (y > 0 && Math.abs(x - y) / y >= 0.5) jump.push({ p: p, from: y, to: x, a: mine[mine.length - 2], b: mine[mine.length - 1] }); }
    });
    // 5) the same product defined twice (name / brand differ only by spaces, dashes or signs)
    var byKey = {}, key = function (p) { return window.Match.compact(p.name) + '|' + window.Match.compact(p.brand || ''); };
    Object.keys(E.state.products).forEach(function (id) { var p = E.state.products[id]; if (p.active === false) return; (byKey[key(p)] = byKey[key(p)] || []).push(p); });
    var dups = Object.keys(byKey).filter(function (k) { return byKey[k].length > 1; }).map(function (k) { return byKey[k]; });
    return { conf: conf, rebuild: rebuild, loss: loss, jump: jump, dups: dups, total: conf.length + rebuild.length + loss.length + jump.length + dups.length };
  };

  /* merge duplicate products into «keep»: stock moves with its cost (two stock adjustments), barcodes move, the others are
     deactivated (their past documents stay as they are). Manager only; shown and confirmed first. */
  function mergeInto(keep, others) {
    var qty = others.reduce(function (s0, p) { return s0 + Math.max(0, p.stock); }, 0), neg = others.filter(function (p) { return p.stock < 0; });
    if (neg.length) { UI.toast('موجودی «' + neg[0].name + '» منفی است؛ اول آن را اصلاح کنید.', 'bad'); return; }
    var codes = []; others.forEach(function (p) { (p.barcodes || []).forEach(function (c) { codes.push([p, c]); }); });
    UI.confirmBox('همه در «' + keep.name + '» (' + (keep.sku || '') + ') ادغام شود؟ ' + UI.fa(qty) + ' عدد موجودی (با بهای خرید خودش) و ' + UI.fa(codes.length) + ' بارکد منتقل می‌شود و ' + UI.fa(others.length) +
      ' کالای دیگر غیرفعال می‌شود. اسناد گذشته همان‌طور می‌مانند.', 'ادغام').then(function (ok) {
      if (!ok) return;
      A.manager('ادغام کالای تکراری').then(function (ctx) {
        if (!ctx) return;
        var steps = [], key = UI.opKey('mrg'), add = 0, cost = 0, known = true;
        others.forEach(function (p, i) {
          if (p.stock > 0) steps.push(function (dn) { var r = E.adjustStock(p.id, { opKey: key + ':o' + i, newStock: 0, reason: 'ادغام در «' + keep.name + '»' }, ctx); var l = r.doc.lines[0]; add += p.stock; if (l.costTotal == null) known = false; else cost += l.costTotal; return r; });
          (p.barcodes || []).forEach(function (c) { steps.push(function () { return E.unmapBarcode(p.id, c, ctx); }); steps.push(function () { return E.mapBarcode(keep.id, c, ctx); }); });
          steps.push(function () { return E.updateProduct(p.id, { active: false, notes: ((p.notes || '') + ' [ادغام‌شده در ' + (keep.sku || keep.name) + ']').trim(), reason: 'ادغام کالای تکراری' }, ctx); });
        });
        steps.push(function () { if (!add) return { changes: [] }; var k = E.state.products[keep.id]; return E.adjustStock(keep.id, { opKey: key + ':k', newStock: k.stock + add, unitCost: known && add ? Math.round(cost / add) : null, reason: 'ادغام کالای تکراری' }, ctx); });
        steps.push(function () { var L = []; others.forEach(function (p) { A.matcher().learnKeys({ name: p.name, code: p.sku, brand: p.brand }).forEach(function (k) { L.push({ key: k, productId: keep.id }); }); }); return L.length ? E.learn(L, ctx) : { changes: [] }; });
        A.run(A.DB.batch(steps)).then(function () { UI.toast('ادغام شد.', 'ok'); A.route(); }, function () {});
      });
    });
  }

  A.routes['price-check'] = function () {
    A.setTitle('بررسی قیمت‌های مشکوک', true);
    var I = A.priceIssues();
    view.appendChild(h('p.small.muted', { style: { margin: '0 4px 8px' } }, 'اپ چیزی را خودش عوض نمی‌کند؛ هر اصلاح با انتخاب شما و قابل پیگیری است.'));
    if (!I.total) { view.appendChild(h('div.card.empty', 'قیمت مشکوکی پیدا نشد.')); return; }
    // 1) same-day lists disagree
    if (I.conf.length) {
      var byPair = {}; I.conf.forEach(function (x) { var k = x.a.id + '|' + x.b.id; (byPair[k] = byPair[k] || { a: x.a, b: x.b, rows: [] }).rows.push(x); });
      view.appendChild(h('div.card', h('h2', '۱. دو لیست هم‌تاریخ، دو قیمت (' + UI.fa(I.conf.length) + ')'),
        h('p.small.muted', 'معمولاً ردیفِ برند دیگری به این کالا وصل شده است. قیمت‌های لیست اشتباه را حذف کنید؛ بعد قیمت فروش را در بخش ۲ دوباره بسازید.'),
        Object.keys(byPair).map(function (k) {
          var g = byPair[k];
          function rmAll(pl) {
            UI.confirmBox(UI.fa(g.rows.length) + ' قیمت از لیست «' + pl.name + '» حذف شود؟ (بقیه لیست دست نمی‌خورد)', 'حذف', true).then(function (ok) {
              if (ok) A.manager('حذف قیمت از لیست قیمت').then(function (ctx) { if (ctx) A.run(function () { return E.removePriceListItems(pl.id, g.rows.map(function (x) { return x.p.id; }), ctx); }).then(function () { UI.toast('حذف شد.', 'ok'); A.route(); }, function () {}); });
            });
          }
          return h('div.line', h('div.small', '«' + g.a.name + '» (' + UI.dateFa(g.a.date) + ') و «' + g.b.name + '» (' + UI.dateFa(g.b.date) + ')'),
            g.rows.slice(0, 50).map(function (x) { return h('div.small', '• ' + x.p.name + (x.p.brand ? ' — ' + x.p.brand : '') + ': ' + UI.money(x.a.items[x.p.id]) + ' / ' + UI.money(x.b.items[x.p.id])); }),
            h('div.row', { style: { marginTop: '6px' } }, h('button.btn.sm', { onclick: function () { rmAll(g.a); } }, 'حذف همه از «' + g.a.name + '»'), h('button.btn.sm', { onclick: function () { rmAll(g.b); } }, 'حذف همه از «' + g.b.name + '»')));
        })));
    }
    // 2) sale price != today's cost + saved %
    if (I.rebuild.length) {
      var pick = {};
      var list = h('div'), cnt = h('b');
      var upd = function () { cnt.textContent = UI.fa(Object.keys(pick).filter(function (k) { return pick[k]; }).length) + ' انتخاب'; };
      I.rebuild.slice(0, 400).forEach(function (x) {
        var ch = h('input', { type: 'checkbox' }); ch.addEventListener('change', function () { pick[x.p.id] = ch.checked; upd(); }); x.ch = ch;
        list.appendChild(h('label.line.row', ch, h('div.grow', h('b', x.p.name + (x.p.brand ? ' — ' + x.p.brand : '')),
          h('div.small', 'فعلی ' + UI.money(x.p.sellPrice) + ' ← ' , h('b', UI.money(x.sell)), ' (خرید امروز ' + UI.money(x.cost) + ' + ' + UI.fa(x.pct) + '٪)'))));
      });
      view.appendChild(h('div.card', h('h2', '۲. قیمت فروش با «قیمت خرید امروز + درصد سود» جور نیست (' + UI.fa(I.rebuild.length) + ')'),
        h('p.small.muted', 'درصد سود همان است که در صفحه «قیمت فروش» برای برند / گروه ذخیره کرده‌اید.'),
        h('div.row', h('button.btn.sm', { onclick: function () { I.rebuild.forEach(function (x) { pick[x.p.id] = true; if (x.ch) x.ch.checked = true; }); upd(); } }, 'انتخاب همه'), cnt), list,
        h('button.btn.primary.block', { onclick: function () {
          var rows = I.rebuild.filter(function (x) { return pick[x.p.id]; }); if (!rows.length) { UI.toast('ردیفی انتخاب نشده است.', 'bad'); return; }
          var ctx = A.userCtx(), steps = rows.map(function (x) { return function () { return E.updateProduct(x.p.id, { sellPrice: x.sell, reason: 'بررسی قیمت‌ها: خرید امروز + ' + x.pct + '٪' }, ctx); }; });
          steps.push(function (dn) { return E.recordImport({ kind: 'markup', label: 'اصلاح قیمت فروش — ' + UI.fa(rows.length) + ' کالا' }, dn, ctx); });
          A.run(A.DB.batch(steps)).then(function () { UI.toast('قیمت فروش ' + UI.fa(rows.length) + ' کالا اصلاح شد.', 'ok'); A.route(); }, function () {});
        } }, 'اصلاح قیمت فروش انتخاب‌شده‌ها')));
      upd();
    }
    if (I.loss.length) view.appendChild(h('div.card', h('h2', '۳. قیمت فروش کمتر از قیمت خرید (' + UI.fa(I.loss.length) + ')'),
      I.loss.slice(0, 200).map(function (x) { return h('a.li', { href: '#/product/' + x.p.id }, h('div.grow', h('div.t', x.p.name), h('div.s', 'فروش ' + UI.money(x.p.sellPrice) + ' · خرید ' + UI.money(x.ref)))); })));
    if (I.dups.length) view.appendChild(h('div.card', h('h2', '۵. کالای تکراری (فقط فاصله، خط تیره یا علامت فرق دارد) (' + UI.fa(I.dups.length) + ')'),
      h('p.small.muted', 'در گزارش‌ها جدا شمرده می‌شوند. کالای درست را «نگه‌دار» بزنید؛ بقیه در آن ادغام می‌شوند.'),
      I.dups.slice(0, 100).map(function (g) {
        return h('div.line', g.map(function (p) {
          return h('div.row', h('div.grow', h('div', p.name + (p.brand ? ' — ' + p.brand : '')), h('div.small.muted', [p.sku, 'موجودی ' + UI.qty(p.stock), (p.barcodes || []).length ? UI.fa(p.barcodes.length) + ' بارکد' : ''].filter(Boolean).join(' · '))),
            h('button.btn.sm', { onclick: function () { mergeInto(p, g.filter(function (x) { return x.id !== p.id; })); } }, 'نگه‌دار'));
        }));
      })));
    if (I.jump.length) view.appendChild(h('div.card', h('h2', '۴. قیمت لیست بیش از ۵۰٪ تغییر کرده (' + UI.fa(I.jump.length) + ')'),
      h('p.small.muted', 'شاید ریال/تومان یا واحد (دست/بسته) اشتباه بوده است. در صفحه کالا می‌توانید قیمت هر لیست را ببینید و اشتباه را حذف کنید.'),
      I.jump.slice(0, 200).map(function (x) { return h('a.li', { href: '#/product/' + x.p.id }, h('div.grow', h('div.t', x.p.name + (x.p.brand ? ' — ' + x.p.brand : '')), h('div.s', UI.money(x.from) + ' («' + x.a.name + '») ← ' + UI.money(x.to) + ' («' + x.b.name + '»)'))); })));
  };
})();
