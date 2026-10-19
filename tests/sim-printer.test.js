// Simulated-printer test for index.html (no real Bluetooth, no real printer).
// Runs the unmodified page in headless Chromium with a fake Web Bluetooth PT-260 that parses ESC/POS
// the way a printer would: inside GS v 0 it swallows exactly xL*yL bytes; any non-NUL byte outside a
// known command counts as "printed as text" (garbage).
//
// Run:  NODE_PATH=$(npm root -g) node tests/sim-printer.test.js
// Needs: playwright (+ Chromium). Exit code 0 = all checks passed.
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');

const APP = path.resolve(__dirname, '..', 'index.html');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt260-'));
const CSV = path.join(TMP, 'labels5.csv');
fs.writeFileSync(CSV, 'code,name\n' + [1, 2, 3, 4, 5].map(i => 'AY-00' + i + ',Test ' + i).join('\n') + '\n');
const EXE = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

// mode: ok | drop (write K fails, not delivered) | dupe (write K delivered, reported failed)
//       lose (write K acknowledged, only half delivered) | dead (from write K on, link dies and never returns)
const mock = (mode, K) => `(() => {
  const SVC = '000018f0-0000-1000-8000-00805f9b34fb';
  window.__rx = []; window.__sizes = []; window.__starts = []; window.__w = 0; window.__dead = false; const L = {};
  const dev = { name: 'PT-260_5855', id: 'x', addEventListener(t, f){ (L[t] = L[t] || []).push(f); } };
  const drop = () => { dev.gatt.connected = false; setTimeout(() => (L.gattserverdisconnected || []).forEach(f => f({})), 0); };
  const chr = { properties: { write: true }, async writeValueWithResponse(b){
    const a = Array.from(new Uint8Array(b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b));
    if (!dev.gatt.connected) throw new Error('GATT disconnected');
    const n = ++window.__w; window.__sizes.push(a.length); window.__starts.push(a.slice(0, 3));
    if (n === ${K} && '${mode}' === 'drop') { drop(); throw new Error('NetworkError: drop'); }
    if (n === ${K} && '${mode}' === 'dupe') { window.__rx.push(...a); drop(); throw new Error('NetworkError: drop'); }
    if (n === ${K} && '${mode}' === 'lose') { window.__rx.push(...a.slice(0, a.length >> 1)); return; }
    if (n >= ${K} && '${mode}' === 'dead') { window.__dead = true; drop(); throw new Error('NetworkError: dead'); }
    window.__rx.push(...a); } };
  dev.gatt = { connected: false,
    async connect(){ if (window.__dead) { await new Promise(r => setTimeout(r, 50)); throw new Error('NetworkError: unreachable'); } dev.gatt.connected = true; return dev.gatt; },
    disconnect(){ if (dev.gatt.connected) drop(); },
    async getPrimaryService(u){ if (u !== SVC) throw new Error('NotFound'); return { getCharacteristic: async () => chr }; } };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => dev } });
})();`;

function parse(rx){
  let i = 0, rows = 0, labels = 0, garbage = 0, sensor = 0; const feeds = [];
  while (i < rx.length) {
    const b = rx[i];
    if (b === 0x1B && rx[i + 1] === 0x40) { labels++; i += 2; continue; }
    if (b === 0x1B && rx[i + 1] === 0x4A) { feeds.push(rx[i + 2]); i += 3; continue; }
    if (b === 0x1D && rx[i + 1] === 0x0C) { sensor++; i += 2; continue; }          // GS FF: feed to next label (gap sensor)
    if (b === 0x0C) { sensor++; i++; continue; }                                   // FF
    if (b === 0x1D && rx[i + 1] === 0x76 && rx[i + 2] === 0x30) { const y = rx[i + 6] | rx[i + 7] << 8; rows += y; i += 8 + (rx[i + 4] | rx[i + 5] << 8) * y; continue; }
    if (b !== 0) garbage++;
    i++;
  }
  return { rows, labels, garbage, feeds, sensor };
}

async function page(mode, K){
  const br = await chromium.launch({ executablePath: EXE }), pg = await br.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(e.message)); pg.on('dialog', d => d.accept());
  await pg.addInitScript(mock(mode, K)); await pg.goto('file://' + APP);
  await pg.evaluate(() => { const l = document.getElementById('lpause'); l.value = '0'; l.dispatchEvent(new Event('change')); });
  await pg.setInputFiles('#file', CSV);
  await pg.waitForFunction(() => /CSV/.test(document.getElementById('info').textContent));
  return { br, pg, errs };
}
const idle = pg => pg.waitForFunction(() => !document.getElementById('bStart').disabled, null, { timeout: 120000 });
const state = pg => pg.evaluate(() => ({ rx: window.__rx, sizes: window.__sizes, starts: window.__starts }));

let failed = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  [' + info + ']' : '')); if (!ok) failed++; };

(async () => {
  // defaults: label 34.5 mm = 276 dots, pitch 39 mm = 312 dots, print head to tear edge 10 mm = 80 dots.
  // All paper movement is blank raster rows: start alignment S, 36 blank rows after each label,
  // first-label check (eject D, realign S), end eject D.
  const H = 276, P = 312, D = 80, S = P - D % P, TOTAL = S + 5 * P + D + S + D;
  for (const [mode, K] of [['ok', -1], ['drop', 40], ['dupe', 40], ['lose', 40], ['lose', 92], ['lose', 93]]) {
    const { br, pg, errs } = await page(mode, K);
    await pg.click('#bStart'); await idle(pg);
    const { rx, sizes, starts } = await state(pg), r = parse(rx);
    const tag = mode + '@' + K, info = `labels=${r.labels} rows=${r.rows}/${TOTAL} garbage=${r.garbage} feedCmds=${r.feeds.length + r.sensor}`;
    check(tag + ': no page errors', errs.length === 0, errs.join('; '));
    check(tag + ': every Bluetooth write <= 182 bytes', Math.max(...sizes) <= 182, 'max ' + Math.max(...sizes));
    check(tag + ': every write starts with a command', starts.every(s => (s[0] === 0x1B && (s[1] === 0x40 || s[1] === 0x4A)) || (s[0] === 0x1D && (s[1] === 0x0C || (s[1] === 0x76 && s[2] === 0x30))) || s[0] === 0x0C));
    check(tag + ': no standalone feed commands (ESC J / FF / GS FF)', r.feeds.length === 0 && r.sensor === 0, info);
    if (mode === 'ok' || mode === 'drop') check(tag + ': exact output (paper moved only by blank rows)', r.labels === 5 && r.rows === TOTAL && r.garbage === 0, info);
    if (mode === 'dupe') check(tag + ': no garbage, at most one repeated band', r.labels === 5 && r.garbage === 0 && r.rows - TOTAL >= 0 && r.rows - TOTAL <= 3, info);
    if (mode === 'lose') check(tag + ': damage limited to one band (<= 160 garbage bytes)', r.garbage <= 160 && r.labels >= 4 && r.rows >= TOTAL - 9, info);
    await br.close();
  }
  { // TSPL test button: small text label, one complete command per Bluetooth write
    const { br, pg } = await page('ok', -1);
    await pg.click('#bTspl'); await pg.waitForFunction(() => !document.getElementById('bTspl').disabled, null, { timeout: 30000 });
    const { rx, sizes } = await state(pg), txt = new TextDecoder().decode(new Uint8Array(rx)), lines = txt.split('\r\n').filter(Boolean);
    check('TSPL test sends SIZE 34.5 mm, GAP 4.5 mm, BOX, TEXT, PRINT 1,1 (one line per write)',
      lines[0] === 'SIZE 48 mm,34.5 mm' && lines[1] === 'GAP 4.5 mm,0 mm' && lines.some(l => l.startsWith('BOX ')) && lines[lines.length - 1] === 'PRINT 1,1' && sizes.length === lines.length && Math.max(...sizes) <= 182,
      lines.join(' | '));
    await br.close();
  }
  { // Cancel, then manual feed must still work
    const { br, pg } = await page('ok', -1);
    await pg.click('#bStart'); await pg.waitForFunction(() => !document.getElementById('bStop').disabled); await pg.click('#bStop'); await idle(pg);
    const before = (await state(pg)).rx.length;
    await pg.click('#bMFeed'); await pg.waitForFunction(() => !document.getElementById('bMFeed').disabled, null, { timeout: 30000 });
    const fed = (await state(pg)).rx.slice(before);
    const fr = parse(fed);
    check('manual feed after cancel sends 64 blank rows', fr.rows === 64 && fr.garbage === 0 && fr.feeds.length === 0, 'rows=' + fr.rows + ' bytes=' + fed.length);
    await br.close();
  }
  { // Link dies during label 3 (write 400: align 78 + label 104 + check 27+78 + label 104 frames before it) and never returns: user cancels; next start must resume at label 3, not repeat 1-2
    const { br, pg } = await page('dead', 400);
    await pg.click('#bStart');
    await pg.waitForFunction(() => /اتصال مجدد، تلاش 2/.test(document.getElementById('ptxt').textContent), null, { timeout: 60000 });
    await pg.click('#bStop'); await idle(pg);
    const from = await pg.inputValue('#from'), r = parse((await state(pg)).rx);
    check('after failure, resume point is the unfinished label (3)', from === '3', 'from=' + from + ' labels sent=' + r.labels);
    // Manual feed with an unreachable printer must give up on its own and re-enable the button
    const t0 = Date.now();
    await pg.click('#bMFeed'); await pg.waitForFunction(() => !document.getElementById('bMFeed').disabled, null, { timeout: 90000 });
    check('manual feed gives up when printer is unreachable', true, ((Date.now() - t0) / 1000).toFixed(0) + ' s');
    await br.close();
  }
  console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
