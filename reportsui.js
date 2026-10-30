/* Screens: report list, generic filtered report (filters, chips, sort, totals, saved filters, exports)
   and management analytics. All numbers come from Reports.run / Analytics.compute (pure, tested in Node). */
(function () {
  'use strict';
  var A = window.App, E = A.E, UI = window.UI, h = UI.h, Core = window.Core, J = window.Jalali, R = window.Reports, AN = window.Analytics;
  var view = document.getElementById('view'), field = A.field, sel = A.sel;
  function dfield(label, input) { return h('div.f', h('span', label), input); } // div, not label: a label would forward taps to its first button
  var XMIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  function stamp() { var d = new Date(), j = J.g2j(d.getFullYear(), d.getMonth() + 1, d.getDate()); return j[0] + '-' + ('0' + j[1]).slice(-2) + '-' + ('0' + j[2]).slice(-2) + '_' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2); }
  function workPrefs() { var p = E.getMeta('prefs') || {}; return { leadDays: p.leadDays || 7, coverDays: p.coverDays || 30 }; }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function savedList() { var v = E.getMeta('savedReports'); return Array.isArray(v) ? v : []; }
  function sumFmt(s) { return s.length > 2 && s[2] ? R.fmtCell({ type: s[2] }, s[1]) + (s[2] === 'money' ? ' تومان' : '') : (s[1] == null ? '—' : String(s[1])); }
  A.reportStamp = stamp;

  // ======================= index =======================
  A.routes.reports = function () {
    A.setTitle('گزارش‌ها', true);
    view.appendChild(h('a.card', { href: '#/analytics', style: { display: 'block', textDecoration: 'none', color: 'inherit', borderColor: 'var(--brand)' } },
      h('b', 'تحلیل مدیریتی'), h('div.small.muted', 'پرفروش و راکد، سرمایه خوابیده، خطر اتمام و پیشنهاد سفارش، سودآوری، مشتریان و موارد غیرعادی — هر بخش با میزان اطمینان و اقدام پیشنهادی.')));
    var sv = savedList();
    if (sv.length) {
      view.appendChild(h('h3.sec-title', 'فیلترهای ذخیره‌شده'));
      view.appendChild(h('div.list', sv.map(function (s) {
        var d = R.DEFS[s.report];
        return h('div.li', h('a.grow', { href: '#/report/' + s.report + '?saved=' + s.id, style: { textDecoration: 'none', color: 'inherit' } }, h('div.t', s.name), h('div.s', d ? d.title : '')),
          h('button.btn.sm.ghost', { 'aria-label': 'حذف', onclick: function () {
            UI.confirmBox('فیلتر «' + s.name + '» حذف شود؟ (فقط همین میانبر حذف می‌شود، نه داده‌ای)', 'حذف', true).then(function (ok) {
              if (ok) A.run(function () { return E.putMeta('savedReports', savedList().filter(function (x) { return x.id !== s.id; })); }).then(function () { A.route(); }, function () {});
            });
          } }, '×'));
      })));
    }
    var groups = {};
    R.list().forEach(function (d) { (groups[d.group] = groups[d.group] || []).push(d); });
    Object.keys(groups).forEach(function (g) {
      view.appendChild(h('h3.sec-title', g));
      view.appendChild(h('div.list', groups[g].map(function (d) { return h('a.li', { href: '#/report/' + d.id }, h('div.grow.t', d.title), h('span.muted', '‹')); })));
    });
    view.appendChild(h('div.card', h('b', 'خروجی کامل'), h('p.small.muted', 'همه کالاها، اسناد، اقلام فروش، پرداخت‌ها و مشتریان در یک فایل Excel (چند برگه).'),
      h('button.btn.block', { onclick: fullExcel }, 'دریافت Excel کامل')));
    var pii = h('input', { type: 'checkbox' });
    view.appendChild(h('div.card', h('b', 'بسته داده برای تحلیل با هوش مصنوعی'),
      h('p.small.muted', 'یک فایل ZIP شامل گزارش مدیریتی، داده خام و محاسبه‌شده با توضیح کامل ستون‌ها؛ آن را در گفت‌وگو با Claude بارگذاری کنید. فقط خواندنی است و چیزی را در برنامه تغییر نمی‌دهد. برنامه خودش به هیچ سرویس هوش مصنوعی وصل نمی‌شود.'),
      h('label.check', pii, 'نام و تلفن مشتریان هم باشد (پیش‌فرض: حذف و جایگزینی با برچسب مستعار)'),
      h('button.btn.block', { onclick: function () {
        var go = function () {
          var p = workPrefs(); UI.toast('در حال ساخت بسته…');
          setTimeout(function () {
            window.AIExport.build(E, { pseudonymize: !pii.checked, leadDays: p.leadDays, coverDays: p.coverDays, appVersion: A.version, shopName: A.shop().name }).then(function (r) {
              UI.fileSheet(r.bytes, 'amiran-ai-package_' + stamp() + '.zip', 'application/zip', 'شامل بهای خرید و سود است' + (pii.checked ? ' و نام/تلفن مشتریان' : '') + '؛ فقط با ابزار و افراد مورد اعتماد به اشتراک بگذارید.');
            }, A.showErr);
          }, 30);
        };
        if (pii.checked) UI.confirmBox('بسته شامل نام و شماره تلفن مشتریان خواهد بود. فقط وقتی لازم است این گزینه را انتخاب کنید. ادامه می‌دهید؟', 'ساخت بسته').then(function (ok) { if (ok) go(); });
        else go();
      } }, 'ساخت بسته داده (ZIP)')));
  };

  // ======================= one report =======================
  var PAGE = 200;
  A.routes.report = function (name, query) {
    var d = R.DEFS[name];
    if (!d) { A.go('#/reports'); return; }
    var key = 'ay.rep2.' + name;
    var st = A.lsGet(key) || { preset: d.range ? 'month' : 'all', from: '', to: '', f: {}, sort: null, opt: {} };
    st.f = st.f || {}; st.opt = st.opt || {};
    if (query.saved) { var s = savedList().filter(function (x) { return x.id === query.saved; })[0]; if (s) { st = clone(s.state); st.f = st.f || {}; st.opt = st.opt || {}; A.lsSet(key, st); } }
    if (query.s && E.state.suppliers[query.s]) { st.f.supplier = query.s; A.lsSet(key, st); }
    if (query.qf) { try { var qf = JSON.parse(query.qf); if (qf && typeof qf === 'object') { if (qf.preset) st.preset = qf.preset; st.f = qf.f && typeof qf.f === 'object' ? qf.f : {}; st.sort = null; A.lsSet(key, st); } } catch (e) { /* bad link: ignore */ } }
    function save() { A.lsSet(key, st); }
    function rerun() { save(); A.route(); }
    function rerunKeep() { var y = window.scrollY; rerun(); window.scrollTo(0, y); } // sorting / removing a chip keeps the scroll position
    var params = Object.assign({ productId: query.p || null, customerId: query.c || null }, workPrefs());
    var t0 = performance.now(), res;
    try { res = R.run(E, name, st, params); }
    catch (e) { console.error(e); view.appendChild(h('div.alert.bad', h('div.grow', 'ساخت گزارش ممکن نشد: ' + (e.message || e) + '. فیلترها را پاک کنید و دوباره امتحان کنید.'))); view.appendChild(h('button.btn.block', { onclick: function () { st.f = {}; rerun(); } }, 'پاک کردن فیلترها')); return; }
    var ms = Math.round(performance.now() - t0);
    A.setTitle(res.title, true);

    // ---- controls ----
    var ctrl = h('div.card');
    if (d.range) {
      var P = R.presets(), chips = h('div.chips');
      Object.keys(P).concat(['custom']).forEach(function (k) {
        chips.appendChild(h('button.chip' + (st.preset === k ? '.on' : ''), { onclick: function () { st.preset = k; rerun(); } }, k === 'custom' ? 'بازه دلخواه' : P[k][0]));
      });
      ctrl.appendChild(chips);
      if (st.preset === 'custom') {
        var fi = h('input.in', { value: st.from || '', placeholder: 'از ۱۴۰۵/۰۱/۰۱', inputmode: 'numeric' }), ti = h('input.in', { value: st.to || '', placeholder: 'تا ۱۴۰۵/۱۲/۲۹', inputmode: 'numeric' });
        ctrl.appendChild(h('div.grid2', fi, ti));
        ctrl.appendChild(h('button.btn.sm.block', { style: { marginTop: '8px' }, onclick: function () { st.from = fi.value.trim(); st.to = ti.value.trim(); rerun(); } }, 'اعمال بازه'));
        if (res.range.bad) ctrl.appendChild(h('div.hint.bad', 'تاریخ واردشده معتبر نیست (نمونه: ۱۴۰۵/۰۳/۱۵) یا «از» بعد از «تا» است؛ بازه نامعتبر نادیده گرفته شد.'));
      }
    }
    (d.options || []).forEach(function (o) {
      ctrl.appendChild(field(o.label, sel(o.values, res.params.opt[o.id], { onchange: function () { st.opt[o.id] = this.value; rerun(); } })));
    });
    if (d.needs === 'product') {
      var pr = params.productId && E.state.products[params.productId];
      ctrl.appendChild(h('button.btn.block', { style: { marginTop: '8px' }, onclick: function () { A.pickProduct('انتخاب کالا', function (p) { A.go('#/report/' + name + '?p=' + p.id); }); } }, pr ? 'کالا: ' + pr.name + ' (تغییر)' : 'انتخاب کالا'));
    }
    if (d.needs === 'customer') {
      var cu = params.customerId && E.state.customers[params.customerId];
      ctrl.appendChild(h('button.btn.block', { style: { marginTop: '8px' }, onclick: function () { A.pickCustomer(function (c) { A.go('#/report/' + name + '?c=' + c.id); }); } }, cu ? 'مشتری: ' + cu.name + ' (تغییر)' : 'انتخاب مشتری'));
    }
    var fids = (d.filters || []).concat(d.groupFilters || []);
    if (fids.length) {
      var nAct = res.filters.filter(function (x) { return !x.fixed; }).length;
      var bar = h('div.row.wrap', { style: { marginTop: '6px', gap: '6px' } },
        h('button.btn.sm' + (nAct ? '.primary' : ''), { onclick: function () { filterSheet(d, st, res, rerun); } }, 'فیلترها' + (nAct ? ' (' + UI.fa(nAct) + ')' : '')),
        h('button.btn.sm', { onclick: function () { saveFilter(name, st, res); } }, 'ذخیره این فیلتر'));
      if (Object.keys(st.f).length) bar.appendChild(h('button.btn.sm.ghost', { onclick: function () { st.f = {}; rerun(); } }, 'پیش‌فرض'));
      ctrl.appendChild(bar);
      var fc = h('div.chips', { style: { flexWrap: 'wrap', paddingBottom: '0', marginTop: '8px' } });
      res.filters.forEach(function (x) {
        if (x.fixed) return;
        fc.appendChild(h('button.chip.x', { title: 'حذف این فیلتر', onclick: function () { st.f[x.id] = null; rerunKeep(); } }, x.text + (x.isDefault ? ' (پیش‌فرض)' : ''), h('i', ' ×')));
      });
      if (fc.childNodes.length) ctrl.appendChild(fc);
    }
    if (ctrl.childNodes.length) view.appendChild(ctrl);

    // ---- summary + note ----
    if (res.summary && res.summary.length) view.appendChild(h('div.card', h('dl.kv', res.summary.map(function (s) { return [h('dt', s[0]), h('dd', sumFmt(s))]; }))));
    if (res.def.today) view.appendChild(h('div.alert.ok', h('div.grow.small', h('b', 'وضعیت امروز: '), 'این گزارش وضعیت فعلی را نشان می‌دهد و با هر عملیات تازه تغییر می‌کند (گزارش تاریخی نیست).')));
    else if (res.def.asOf && res.range && res.range.to != null) view.appendChild(h('div.alert.ok', h('div.grow.small', h('b', 'تا پایان بازه: '), 'ستون‌های پرداخت، مانده و وضعیت تسویه همان‌گونه است که در پایان بازه (' + UI.dateFa(res.range.to) + ') بود؛ عملیات بعدی آن را تغییر نمی‌دهد.')));
    if (res.note) view.appendChild(h('div.alert.warn', h('div.grow.small', res.note)));

    // ---- exports (same rows/order/totals as the table below) ----
    var shop = A.shop().name || 'امیران یدک', base = name + '_' + stamp();
    view.appendChild(h('div.grid3',
      h('button.btn.sm', { onclick: function () { UI.fileSheet(R.exportXlsx(res), base + '.xlsx', XMIME); } }, 'Excel'),
      h('button.btn.sm', { onclick: function () { UI.fileSheet(R.exportCsv(res), base + '.csv', 'text/csv'); } }, 'CSV'),
      h('button.btn.sm', { onclick: function () { pdfExport(res, shop, base); } }, 'PDF')));
    view.appendChild(h('p.small.muted', { style: { margin: '6px 4px' } }, UI.fa(res.rows.length) + ' ردیف' + (res.rows.length !== res.sourceCount && !d.aggregate ? ' از ' + UI.fa(res.sourceCount) : '') + ' (زمان ساخت: ' + UI.fa(ms) + ' میلی‌ثانیه)'));

    // ---- table ----
    if (!res.rows.length) { view.appendChild(h('div.card.empty', res.filters.length ? 'با این فیلترها موردی پیدا نشد.' : 'موردی برای نمایش نیست.')); return; }
    var sort = res.sort || {};
    var thead = h('tr', res.columns.map(function (c) {
      var on = sort.key === c.key;
      return h('th.sortable' + (on ? '.on' : ''), { onclick: function () { st.sort = { key: c.key, dir: on ? -(sort.dir || 1) : (c.type && c.type !== 'text' ? -1 : 1) }; rerunKeep(); } }, c.label, on ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
    }));
    var tbody = h('tbody'), shown = 0;
    function rowLink(r) {
      var lk = r.linkType || res.link;
      if (lk === 'doc' && r.docId) return '#/doc/' + r.docId;
      if (lk === 'customer' && r.customerId) return '#/customer/' + r.customerId;
      if (lk === 'product' && (r.productId || r.id) && E.state.products[r.productId || r.id]) return '#/product/' + (r.productId || r.id);
      return null;
    }
    function more() {
      var end = Math.min(res.rows.length, shown + PAGE);
      for (var i = shown; i < end; i++) {
        (function (r) {
          var tr = h('tr', res.columns.map(function (c) { return h('td' + (c.type && c.type !== 'text' ? '.n' : ''), R.fmtCell(c, r[c.key])); }));
          var lk = rowLink(r); if (lk) { tr.style.cursor = 'pointer'; tr.addEventListener('click', function () { A.go(lk); }); }
          tbody.appendChild(tr);
        })(res.rows[i]);
      }
      shown = end;
      moreBtn.style.display = shown < res.rows.length ? '' : 'none';
      moreBtn.textContent = 'نمایش ' + UI.fa(Math.min(PAGE, res.rows.length - shown)) + ' ردیف دیگر (' + UI.fa(res.rows.length - shown) + ' باقی‌مانده)';
    }
    var moreBtn = h('button.btn.block', { onclick: more });
    var tf = R.totalsRow(res, true);
    var tbl = h('table.t', h('thead', thead), tbody, tf ? h('tfoot', h('tr.foot', tf.map(function (v, i) { var c = res.columns[i]; return h('td' + (c.type && c.type !== 'text' ? '.n' : ''), v); }))) : null);
    view.appendChild(h('div.table-wrap', tbl));
    view.appendChild(moreBtn);
    more();
    if (res.totals) view.appendChild(h('p.small.muted', { style: { margin: '4px' } }, 'ردیف «جمع» روی همه ' + UI.fa(res.rows.length) + ' ردیف فیلترشده است، نه فقط ردیف‌های نمایش‌داده‌شده.'));
  };

  function pdfExport(res, shop, base) {
    function go() {
      var msg = h('p', 'در حال آماده‌سازی…');
      var s = UI.sheet('ساخت PDF', h('div', msg, h('p.small.muted', 'تا پایان کار صفحه را نبندید.')), { modal: true });
      R.exportPdf(res, shop, function (i, n) { msg.textContent = 'صفحه ' + UI.fa(i) + ' از ' + UI.fa(n); })
        .then(function (pdf) { s.close(); UI.fileSheet(pdf, base + '.pdf', 'application/pdf'); }, function (e) { s.close(); A.showErr(e); });
    }
    if (res.rows.length > 2500) UI.confirmBox('این گزارش ' + UI.fa(res.rows.length) + ' ردیف دارد و PDF آن حدود ' + UI.fa(Math.ceil(res.rows.length / 28)) + ' صفحه می‌شود و ساختش ممکن است چند دقیقه طول بکشد. برای ردیف‌های زیاد Excel مناسب‌تر است. ادامه می‌دهید؟', 'ساخت PDF').then(function (ok) { if (ok) go(); });
    else go();
  }

  function saveFilter(name, st, res) {
    UI.promptBox('ذخیره فیلتر', 'نام (مثلاً «لنت‌های GMW کم‌موجود»)', { value: res.filters.filter(function (x) { return !x.fixed; }).map(function (x) { return x.text; }).join('، ').slice(0, 40) }).then(function (nm) {
      nm = (nm || '').trim(); if (!nm) return;
      var list = savedList().filter(function (x) { return !(x.report === name && x.name === nm); });
      list.unshift({ id: 'sf' + Date.now().toString(36), name: nm, report: name, state: clone(st), createdAt: Date.now() });
      A.run(function () { return E.putMeta('savedReports', list.slice(0, 40)); }).then(function () { UI.toast('ذخیره شد؛ در صفحه «گزارش‌ها» دیده می‌شود.', 'ok'); }, function () {});
    });
  }

  // ---- filter editor (works on a copy; nothing changes until «نمایش نتیجه») ----
  function filterSheet(d, st, res, rerun) {
    var work = clone(res.filterValues) || {}, ctx = { E: E, S: E.state };
    var ids = (d.filters || []).concat(d.groupFilters || []);
    var body = h('div');
    function lbl(id) { var f = R.FILTERS[id]; return id === 'qty' && d.qtyLabel ? d.qtyLabel : id === 'amount' && d.amountLabel ? d.amountLabel : f.label; }
    function pickerRow(id, text, pick) {
      var v = work[id], f = R.FILTERS[id];
      return dfield(lbl(id), h('div.row', { style: { gap: '6px' } },
        h('button.btn.sm.grow', { type: 'button', onclick: pick }, v ? (f.show ? f.show(v, ctx, d) : v) : text),
        v ? h('button.btn.sm.ghost', { type: 'button', onclick: function () { work[id] = null; draw(); } }, '×') : null));
    }
    function draw() {
      UI.clear(body);
      ids.forEach(function (id) {
        var f = R.FILTERS[id]; if (!f) return;
        var v = work[id];
        if (f.kind === 'text') {
          var inp = h('input.in', { type: 'search', value: v || '', placeholder: 'نام، کد، بارکد، مشتری، شماره سند…', oninput: function () { work.q = this.value.trim() || null; } });
          body.appendChild(field(lbl(id), h('div.row', { style: { gap: '6px' } }, inp,
            A.openScanner ? h('button.btn.sm', { type: 'button', onclick: function () { A.openScanner({ title: 'اسکن برای جستجو', mode: 'code', onCode: function (t) { work.q = t; inp.value = t; } }); } }, 'اسکن') : null)));
        } else if (f.kind === 'select') {
          var o = Object.assign({ '': '— همه —' }, f.options(ctx, d));
          body.appendChild(field(lbl(id), sel(o, v == null ? '' : v, { onchange: function () { work[id] = this.value || null; } })));
        } else if (f.kind === 'multi') {
          var opts = f.options(ctx, d), wrap = h('div.chips', { style: { flexWrap: 'wrap', paddingBottom: '0' } });
          Object.keys(opts).forEach(function (k) {
            var on = Array.isArray(v) && v.indexOf(k) >= 0;
            wrap.appendChild(h('button.chip' + (on ? '.on' : ''), { type: 'button', onclick: function () {
              var a = Array.isArray(work[id]) ? work[id].slice() : [];
              if (a.indexOf(k) >= 0) a.splice(a.indexOf(k), 1); else a.push(k);
              work[id] = a.length ? a : null; draw();
            } }, opts[k]));
          });
          body.appendChild(dfield(lbl(id) + (id === 'pflags' || id === 'rflags' ? ' (همه شرط‌های انتخاب‌شده)' : ' (هر کدام)'), wrap));
        } else if (f.kind === 'numrange') {
          var mn = h('input.in', { inputmode: 'decimal', placeholder: 'از', value: v && v.min != null ? UI.fa(v.min) : '' }), mx = h('input.in', { inputmode: 'decimal', placeholder: 'تا', value: v && v.max != null ? UI.fa(v.max) : '' });
          function upd() { var a = UI.parseNum(mn.value), b = UI.parseNum(mx.value); a = a == null || isNaN(a) ? null : a; b = b == null || isNaN(b) ? null : b; work[id] = a == null && b == null ? null : { min: a, max: b }; }
          mn.addEventListener('input', upd); mx.addEventListener('input', upd);
          body.appendChild(field(lbl(id), h('div.grid2', mn, mx)));
        } else if (f.kind === 'category') {
          body.appendChild(pickerRow(id, 'همه گروه‌ها (انتخاب)', function () { A.pickCategory(v === '__none' ? null : v, function (cid) { work[id] = cid || '__none'; draw(); }); }));
        } else if (f.kind === 'supplier') {
          body.appendChild(pickerRow(id, 'همه تأمین‌کنندگان (انتخاب)', function () { A.pickSupplier(function (s) { work[id] = s.id; draw(); }); }));
        } else if (f.kind === 'customer') {
          body.appendChild(pickerRow(id, 'همه مشتریان (انتخاب)', function () { A.pickCustomer(function (c) { work[id] = c.id; draw(); }); }));
        } else if (f.kind === 'product') {
          body.appendChild(pickerRow(id, 'همه کالاها (انتخاب)', function () { A.pickProduct('انتخاب کالا', function (p) { work[id] = p.id; draw(); }); }));
        } else if (f.kind === 'attr') {
          var keys = R.attrKeys(E);
          if (!Object.keys(keys).length) return;
          var ks = sel(Object.assign({ '': '— مشخصه —' }, keys), v && v.key || '', { onchange: function () { work.attr = this.value ? { key: this.value, val: vi.value.trim() } : null; } });
          var vi = h('input.in', { placeholder: 'مقدار (خالی = هر مقداری)', value: v && v.val || '', oninput: function () { if (work.attr) work.attr.val = this.value.trim(); } });
          body.appendChild(field(lbl(id), h('div.grid2', ks, vi)));
        }
      });
    }
    draw();
    var s = UI.sheet('فیلترها — ' + d.title, h('div', body, h('div.sticky-act', h('div.grid2',
      h('button.btn', { onclick: function () { s.close(); st.f = {}; rerun(); } }, 'پیش‌فرض'),
      h('button.btn.primary', { onclick: function () {
        var out = {}; ids.forEach(function (id) { if (work[id] !== undefined) out[id] = work[id]; });
        // keep an explicit «off» for default filters the user cleared
        Object.keys(d.defaults || {}).forEach(function (k) { if (out[k] == null) out[k] = null; });
        st.f = out; s.close(); rerun();
      } }, 'نمایش نتیجه')))));
  }

  // ======================= home alerts =======================
  /* Cheap checks only (no heavy analytics) so the home screen stays fast; each alert opens the exact filtered report. */
  function rlink(name, qf) { return '#/report/' + name + '?qf=' + encodeURIComponent(JSON.stringify(qf)); }
  A.computeAlerts = function (now) {
    now = now || Date.now();
    var out = [], t0 = UI.startOfDay(now), ll = E.getMeta('labelLog') || {}, od = 0, odSum = 0, unk = 0, nrv = 0, noLabel = 0, info = 0, loss = 0, miss = { cat: 0, brand: 0, price: 0 };
    Object.keys(E.state.docs).forEach(function (k) { var d = E.state.docs[k]; if (d.kind === 'out' && d.type === 'sale' && d.status !== 'reversed' && d.balance > 0 && d.dueDate && d.dueDate < t0) { od++; odSum += d.balance; } });
    Object.keys(E.state.products).forEach(function (k) {
      var p = E.state.products[k]; if (p.active === false) return;
      if (p.stock > 0 && p.stock - (p.costedQty || 0) > 0) unk++;
      if (p.stock > 0 && p.costedQty > 0 && p.sellPrice != null && p.sellPrice < Math.round(p.costBasis / p.costedQty)) nrv++; // v2.9: lower of cost and net realisable value (IAS 2 / Iranian std. 8)
      if (p.stock > 0 && !ll[p.id] && !(p.barcodes || []).length) noLabel++;
      if (!p.categoryId || !p.brand || p.sellPrice == null) { info++; if (!p.categoryId) miss.cat++; if (!p.brand) miss.brand++; if (p.sellPrice == null) miss.price++; }
    });
    E.salesLines({ from: now - 30 * 864e5, excludeReturns: true }).forEach(function (r) { if (r.costTotal != null && r.net < r.costTotal) loss++; });
    var hc = A.state.health;
    if (hc && hc.critical) out.push({ lvl: 'bad', text: UI.fa(hc.critical) + ' مشکل جدی در بررسی سلامت داده', href: '#/health' });
    if (od) out.push({ lvl: 'bad', text: UI.fa(od) + ' فاکتور سررسیدگذشته — ' + UI.moneyT(odSum) + ' دریافت‌نشده', href: rlink('invoices', { preset: 'all', f: { due: 'overdue' } }) });
    if (loss) out.push({ lvl: 'warn', text: UI.fa(loss) + ' ردیف فروش زیر بهای خرید در ۳۰ روز اخیر', href: rlink('profit', { preset: 'd90', f: { rflags: ['loss'] } }) });
    // v2.5: opens the screen that FIXES it (each receipt without cost, with its own price field)
    if (unk) out.push({ lvl: 'warn', text: UI.fa(unk) + ' کالای دارای موجودی بدون بهای خرید (سود آن‌ها قابل محاسبه نیست) — ثبت بها', href: '#/costs' });
    if (A.priceIssues) { var PI = A.priceIssues(), np = PI.conf.length + PI.rebuild.length + PI.jump.length; if (np) out.push({ lvl: 'warn', text: UI.fa(np) + ' قیمت مشکوک (لیست‌های ناهمخوان / قیمت فروش ناهمخوان) — بررسی', href: '#/price-check' }); if (PI.dups.length) out.push({ lvl: 'info', text: UI.fa(PI.dups.length) + ' کالای احتمالاً تکراری — ادغام', href: '#/price-check' }); } // v2.10
    if (nrv) out.push({ lvl: 'warn', text: UI.fa(nrv) + ' کالای موجود با قیمت فروش کمتر از بهای خرید (ارزش واقعی موجودی کمتر از دفتر است) — بررسی قیمت', href: rlink('stock', {}) });
    if (noLabel) out.push({ lvl: 'info', text: UI.fa(noLabel) + ' کالای دارای موجودی بدون برچسب QR و بارکد', href: rlink('quality', { f: { rflags: ['noLabel'] } }) });
    // v2.5: says WHICH field is missing (a product with both prices but no brand / group is still listed here)
    if (info) out.push({ lvl: 'info', text: UI.fa(info) + ' کالا با اطلاعات ناقص: ' + [miss.cat ? UI.fa(miss.cat) + ' بدون گروه' : '', miss.brand ? UI.fa(miss.brand) + ' بدون برند' : '', miss.price ? UI.fa(miss.price) + ' بدون قیمت فروش' : ''].filter(Boolean).join('، '), href: rlink('stock', { f: { pflags: ['missingInfo'] } }) });
    return out;
  };
  A.alertsCard = function () {
    var box = h('div');
    setTimeout(function () {
      if (!box.isConnected) return;
      var list = A.computeAlerts();
      if (!list.length) return;
      box.appendChild(h('div.sec-title', 'هشدارها'));
      box.appendChild(h('div.list', list.map(function (x) {
        return h('a.li', { href: x.href }, h('span.badge.' + (x.lvl === 'info' ? 'x' : x.lvl), x.lvl === 'bad' ? 'مهم' : x.lvl === 'warn' ? 'توجه' : 'تکمیل'), h('div.grow.t', { style: { fontSize: '14.5px' } }, x.text), h('span.muted', '‹'));
      })));
    }, 0);
    return box;
  };

  // ======================= full Excel =======================
  function fullExcel() {
    function mx(res) { return R.toMatrix(res, false); }
    var all = { preset: 'all' }, p = workPrefs();
    var BAL = E.allBalances(), cust = Object.keys(E.state.customers).map(function (k) { var c = E.state.customers[k]; return [c.name, c.phone, Core.CUSTOMER_TYPES[c.type] || '', c.city, c.address, BAL[c.id] || 0]; });
    var bytes = window.XLSX.writeXlsx([
      { name: 'موجودی', rows: mx(R.run(E, 'stock', { f: { active: null } }, p)) },
      { name: 'فاکتورها', rows: mx(R.run(E, 'invoices', { preset: 'all', f: { status: null } }, p)) },
      { name: 'اقلام فروش', rows: mx(R.run(E, 'sales', all, p)) },
      { name: 'ورودها', rows: mx(R.run(E, 'receipts', { preset: 'all', f: { status: null } }, p)) },
      { name: 'خروج غیرفروش', rows: mx(R.run(E, 'nonsale', all, p)) },
      { name: 'گردش مالی', rows: mx(R.run(E, 'payments', { preset: 'all', f: { op: null } }, p)) },
      { name: 'گردش کالا', rows: mx(R.run(E, 'movements', all, p)) },
      { name: 'مشتریان', rows: [['نام', 'تلفن', 'نوع', 'شهر', 'نشانی', 'مانده حساب']].concat(cust) }]);
    UI.fileSheet(bytes, 'amiran-full_' + stamp() + '.xlsx', XMIME);
  }
  A.fullExcel = fullExcel;

  // ======================= management analytics =======================
  var CONF_CLASS = { high: '.ok', medium: '.warn', low: '.bad', none: '' }, SUFF_CLASS = { enough: '.ok', limited: '.warn', insufficient: '.bad' };
  // Persian digits for analytics text, but codes like INV-000123 or SKU A12 keep Latin digits
  function faText(s) { return String(s == null ? '' : s).replace(/\d+/g, function (m, i, all) { var prev = all.charAt(i - 1); return /[A-Za-z\-_]/.test(prev) ? m : UI.fa(m); }).replace(/([۰-۹])\.([۰-۹])/g, '$1٫$2'); }
  function anCell(col, v) { var c = AN.COLS[col] || [col, 'text']; return c[1] === 'text' && col !== 'sku' ? faText(R.fmtCell({ type: 'text' }, v)) : R.fmtCell({ type: c[1] }, v); }
  function anVal(x) { return typeof x === 'number' ? UI.money(x) : faText(x); }
  A.routes.analytics = function () {
    A.setTitle('تحلیل مدیریتی', true);
    var st = A.lsGet('ay.an') || { win: 90 };
    var chips = h('div.chips');
    [30, 90, 180, 365].forEach(function (w) { chips.appendChild(h('button.chip' + (st.win === w ? '.on' : ''), { onclick: function () { st.win = w; A.lsSet('ay.an', st); A.route(); } }, UI.fa(w) + ' روز اخیر')); });
    view.appendChild(h('div.card', h('div.small.muted', 'بازه تحلیل فروش:'), chips,
      h('p.small.muted', { style: { margin: 0 } }, 'همه نتایج از داده‌های ثبت‌شده در همین برنامه محاسبه می‌شوند. پیش‌بینی‌ها و پیشنهادها تخمین‌اند، نه قطعیت؛ کنار هر بخش میزان کفایت داده و اطمینان آمده است.')));
    var box = h('div', h('div.card.empty', 'در حال محاسبه…'));
    view.appendChild(box);
    var hash = location.hash;
    setTimeout(function () {
      if (location.hash !== hash) return;
      var p = workPrefs(), t0 = performance.now(), r;
      try { r = AN.compute(E, { windowDays: st.win, leadDays: p.leadDays, coverDays: p.coverDays }); }
      catch (e) { UI.clear(box); box.appendChild(h('div.alert.bad', h('div.grow', 'محاسبه تحلیل ممکن نشد: ' + (e.message || e)))); return; }
      UI.clear(box);
      drawAnalytics(box, r, Math.round(performance.now() - t0));
    }, 30);
  };
  function drawAnalytics(box, r, ms) {
    box.appendChild(h('div.card',
      h('div.row.wrap', { style: { gap: '6px' } }, h('span.badge' + SUFF_CLASS[r.sufficiency], 'کفایت کلی داده: ' + AN.SUFF[r.sufficiency]),
        h('span.badge', UI.fa(r.invoices) + ' فاکتور در بازه'), h('span.badge', 'سابقه: ' + UI.fa(r.spanDays) + ' روز')),
      r.sufficiency !== 'enough' ? h('p.small', { style: { margin: '8px 0 0' } }, 'داده هنوز برای نتیجه‌گیری محکم کافی نیست (حداقل حدود ۵۰ فاکتور در ۶۰ روز). نتایج را راهنمای اولیه بدانید.') : null,
      h('p.small.muted', { style: { margin: '6px 0 0' } }, 'زمان تأمین ' + UI.fa(r.params.leadDays) + ' روز، موجودی هدف ' + UI.fa(r.params.coverDays) + ' روز — ', h('a', { href: '#/settings' }, 'تغییر در تنظیمات'), ' · محاسبه: ' + UI.fa(ms) + ' میلی‌ثانیه')));
    box.appendChild(h('div.grid2', { style: { marginBottom: '10px' } },
      h('button.btn.sm', { onclick: function () { UI.fileSheet(analyticsXlsx(r), 'analysis_' + stamp() + '.xlsx', XMIME); } }, 'Excel تحلیل'),
      h('button.btn.sm', { onclick: function () { analyticsPdf(r); } }, 'PDF تحلیل')));
    var nav = h('div.chips');
    r.sections.forEach(function (s) { nav.appendChild(h('button.chip', { onclick: function () { var el = document.getElementById('an-' + s.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, s.title)); });
    box.appendChild(nav);
    r.sections.forEach(function (s) {
      var card = h('div.card', { id: 'an-' + s.id },
        h('h2', { style: { fontSize: '17px', margin: '0 0 6px' } }, s.title),
        h('div.row.wrap', { style: { gap: '6px', marginBottom: '6px' } }, h('span.badge' + SUFF_CLASS[s.sufficiency], 'کفایت داده: ' + AN.SUFF[s.sufficiency]), h('span.badge' + CONF_CLASS[s.confidence], 'اطمینان: ' + AN.LEVEL[s.confidence])),
        h('p.small.muted', { style: { margin: '0 0 8px' } }, faText(s.basis)));
      if (s.summary && s.summary.length) card.appendChild(h('dl.kv', s.summary.map(function (x) { return [h('dt', x[0]), h('dd', anVal(x[1]))]; })));
      if (s.chart && s.chart.length) card.appendChild(barChart(s.chart));
      s.tables.forEach(function (t) {
        if (!t.rows.length) return;
        card.appendChild(h('h3.sec-title', t.title + ' (' + UI.fa(t.rows.length) + ')'));
        var tb = h('tbody'), lim = 10;
        function fill() {
          UI.clear(tb);
          t.rows.slice(0, lim).forEach(function (row) {
            var tr = h('tr', t.cols.map(function (c) { var tp = (AN.COLS[c] || [])[1]; return h('td' + (tp && tp !== 'text' ? '.n' : ''), anCell(c, row[c])); }));
            var id = row[t.idKey || 'id'], lk = t.link === 'product' && E.state.products[id] ? '#/product/' + id : t.link === 'customer' && E.state.customers[id] ? '#/customer/' + id : t.link === 'doc' && id && E.state.docs[id] ? '#/doc/' + id : null;
            if (lk) { tr.style.cursor = 'pointer'; tr.addEventListener('click', function () { A.go(lk); }); }
            tb.appendChild(tr);
          });
        }
        fill();
        card.appendChild(h('div.table-wrap', h('table.t', h('thead', h('tr', t.cols.map(function (c) { return h('th', (AN.COLS[c] || [c])[0]); }))), tb)));
        if (t.rows.length > lim) { var b = h('button.btn.sm.block', { onclick: function () { lim = t.rows.length; fill(); b.remove(); } }, 'نمایش همه ' + UI.fa(t.rows.length) + ' ردیف'); card.appendChild(b); }
      });
      card.appendChild(h('details', { style: { margin: '8px 0' } }, h('summary.small', 'فرض‌ها و روش محاسبه'), h('ul.small', s.assumptions.map(function (a) { return h('li', faText(a)); }))));
      card.appendChild(h('div.alert.ok', { style: { marginBottom: 0 } }, h('div.grow', h('b', 'اقدام پیشنهادی: '), faText(s.action))));
      box.appendChild(card);
    });
  }
  function barChart(data) {
    var max = Math.max.apply(null, data.map(function (d) { return Math.abs(d.net); }).concat([1]));
    return h('div.bars', data.map(function (d) {
      var pct = Math.max(2, Math.round(Math.abs(d.net) / max * 100));
      return h('div.bar', { title: d.month + ': ' + UI.money(d.net) }, h('span.v', UI.fa(Math.round(d.net / 1e6 * 10) / 10) + ' م'), h('i', { style: { height: pct + '%', background: d.net < 0 ? 'var(--bad)' : 'var(--brand)' } }), h('span.l', data.length <= 6 && J.MONTHS ? J.MONTHS[+d.month.slice(5) - 1] : UI.fa(+d.month.slice(5))));
    }));
  }
  function anMatrix(t) {
    return [t.cols.map(function (c) { return (AN.COLS[c] || [c])[0]; })].concat(t.rows.map(function (row) { return t.cols.map(function (c) { return R.rawCell({ type: (AN.COLS[c] || [])[1] }, row[c]); }); }));
  }
  function analyticsXlsx(r) {
    var head = [['بخش', 'کفایت داده', 'اطمینان', 'مبنای محاسبه', 'خلاصه', 'فرض‌ها', 'اقدام پیشنهادی']];
    var sheets = [{ name: 'خلاصه تحلیل', rows: head.concat(r.sections.map(function (s) {
      return [s.title, AN.SUFF[s.sufficiency], AN.LEVEL[s.confidence], s.basis, s.summary.map(function (x) { return x[0] + ': ' + x[1]; }).join(' | '), s.assumptions.join(' | '), s.action];
    })).concat([[], ['بازه (روز)', r.params.windowDays], ['زمان تأمین (روز)', r.params.leadDays], ['موجودی هدف (روز)', r.params.coverDays], ['تهیه‌شده', J.fmt(Date.now(), true)]]) }];
    var used = {};
    r.sections.forEach(function (s) {
      s.tables.forEach(function (t) {
        if (!t.rows.length) return;
        var nm = (s.title.split(/[،,]/)[0].slice(0, 18) + ' - ' + t.title).slice(0, 31).replace(/[\\\/?*\[\]:]/g, ' '), k = nm, i = 2;
        while (used[k]) k = nm.slice(0, 28) + ' ' + i++;
        used[k] = 1; sheets.push({ name: k, rows: anMatrix(t) });
      });
    });
    return window.XLSX.writeXlsx(sheets);
  }
  function analyticsPdf(r) {
    var blocks = [{ type: 'title', text: 'تحلیل مدیریتی — ' + UI.fa(r.params.windowDays) + ' روز اخیر', sub: 'کفایت کلی داده: ' + AN.SUFF[r.sufficiency] + ' · ' + UI.fa(r.invoices) + ' فاکتور · تخمین‌ها قطعی نیستند', left: [A.shop().name || 'امیران یدک'] }];
    r.sections.forEach(function (s) {
      blocks.push({ type: 'text', text: s.title, bold: true, size: 4 });
      blocks.push({ type: 'kv', cols: 2, items: [['کفایت داده', AN.SUFF[s.sufficiency]], ['اطمینان', AN.LEVEL[s.confidence]]].concat(s.summary.map(function (x) { return [x[0], anVal(x[1])]; })) });
      blocks.push({ type: 'text', text: 'مبنا: ' + faText(s.basis), size: 2.8, color: '#444' });
      blocks.push({ type: 'text', text: 'فرض‌ها: ' + faText(s.assumptions.join(' — ')), size: 2.6, color: '#666' });
      s.tables.forEach(function (t) {
        if (!t.rows.length) return;
        blocks.push({ type: 'text', text: t.title, bold: true, size: 3.2 });
        blocks.push({ type: 'table', columns: t.cols.map(function (c) { var x = AN.COLS[c] || [c, 'text', 1]; return { label: x[0], w: x[2] || 1, wrap: x[1] === 'text', align: x[1] !== 'text' ? 'center' : 'right' }; }),
          rows: t.rows.slice(0, 40).map(function (row) { return t.cols.map(function (c) { return anCell(c, row[c]); }); }) });
      });
      blocks.push({ type: 'text', text: 'اقدام پیشنهادی: ' + faText(s.action), size: 3, bold: true });
      blocks.push({ type: 'gap', h: 4 });
    });
    var msg = h('p', 'در حال آماده‌سازی…'), sh = UI.sheet('ساخت PDF', h('div', msg), { modal: true });
    window.PDF.renderFlow(blocks, { title: 'تحلیل مدیریتی', footer: 'تهیه‌شده در ' + UI.dateFa(Date.now(), true), onProgress: function (i, n) { msg.textContent = 'صفحه ' + UI.fa(i) + ' از ' + UI.fa(n); } })
      .then(function (pdf) { sh.close(); UI.fileSheet(pdf, 'analysis_' + stamp() + '.pdf', 'application/pdf'); }, function (e) { sh.close(); A.showErr(e); });
  }
})();
