#!/usr/bin/env node
'use strict';

/**
 * PCG Grading photo extractor.
 *
 * Looks a grading number up on pcggrading.in and saves the highest-resolution
 * version of every certificate photo it can reach.
 *
 * Runs with no setup at all (plain HTTP). If the site turns out to need
 * JavaScript, it uses Playwright when that happens to be installed.
 *
 *   node pcg.js GRN16658IN
 *   node pcg.js              <- asks for the number, for double-click launchers
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { resolveBestPhotos, isLikelyPhoto } = require('./src/probe');
const { request } = require('./src/http');

const DEFAULT_URL = 'https://www.pcggrading.in/authenticity-verification.aspx';
const VERSION = '1.1.0';

function parseArgs(argv) {
  const o = {
    grn: null, url: DEFAULT_URL, out: null, engine: 'auto',
    headful: false, timeout: 30000, concurrency: 4, keepAll: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headful') o.headful = true;
    else if (a === '--browser') o.engine = 'browser';
    else if (a === '--http') o.engine = 'http';
    else if (a === '--engine') o.engine = (argv[++i] || 'auto').toLowerCase();
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]);
    else if (a === '--keep-all') o.keepAll = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!a.startsWith('-') && !o.grn) o.grn = a.trim().toUpperCase();
  }
  return o;
}

const HELP = `
PCG Grading photo extractor v${VERSION}

  node pcg.js <GRADING_NUMBER> [options]
  node pcg.js                        asks for the number

Options
  --http            plain HTTP only (no browser needed)   [default: auto]
  --browser         force the real-browser engine
  --headful         show the browser window (with --browser)
  --url <URL>       a different verification page
  --out <DIR>       where to save   [default: ./results/<GRADING_NUMBER>]
  --timeout <MS>    per-request timeout   [default: 30000]
  --concurrency <N> parallel downloads    [default: 4]
  --keep-all        also keep images that look like site furniture
  -h, --help        this text

Examples
  node pcg.js GRN16658IN
  node pcg.js GRN16658IN --browser --headful
`;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

/** Pause before exit so a double-clicked window does not vanish. */
async function holdWindowOpen() {
  if (!process.stdin.isTTY) return;
  await ask('\nPress Enter to close...');
}

const log = (...m) => console.log(...m);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  let interactive = false;
  if (!opts.grn) {
    if (!process.stdin.isTTY) { console.log(HELP); return 2; }
    interactive = true;
    console.log(`\n  PCG Grading photo extractor v${VERSION}`);
    console.log('  ------------------------------------\n');
    opts.grn = (await ask('  Grading number (e.g. GRN16658IN): ')).toUpperCase();
    if (!opts.grn) { console.log('\n  No number entered.'); await holdWindowOpen(); return 2; }
  }

  const outDir = opts.out || path.join(process.cwd(), 'results', opts.grn);
  const imgDir = path.join(outDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  log(`\n=== PCG Grading photo extractor ===`);
  log(`grading number : ${opts.grn}`);
  log(`page           : ${opts.url}`);
  log(`saving to      : ${outDir}\n`);

  const report = { version: VERSION, grn: opts.grn, url: opts.url, startedAt: new Date().toISOString() };
  let photos = [];
  let attempt = null;

  const runEngine = async (name) => {
    const engine = name === 'browser' ? require('./src/engine-browser') : require('./src/engine-http');
    const res = await engine.lookup(opts.grn, opts.url, {
      timeout: opts.timeout, headful: opts.headful, log,
      screenshotPath: name === 'browser' ? path.join(outDir, 'result.png') : null,
    });

    // Plain HTTP has no session-bound fetcher of its own; make a simple one.
    const fetchImage = res.fetchImage || (async (url) => {
      const r = await request(url, {
        timeout: opts.timeout,
        headers: { referer: res.info.resultUrl || opts.url },
      });
      if (r.status >= 400) return { ok: false, status: r.status };
      return { ok: true, status: r.status, contentType: r.headers['content-type'] || '', buf: r.body };
    });

    // De-duplicate, drop site furniture, and put the certificate's own shots first.
    const seen = new Set();
    let images = res.images.filter((i) => !seen.has(i.url) && seen.add(i.url));
    const total = images.length;
    if (!opts.keepAll) images = images.filter((i) => isLikelyPhoto(i.url));
    const grnLower = opts.grn.toLowerCase();
    images.sort((a, b) => {
      const s = (x) => (x.url.toLowerCase().includes(grnLower) ? 2 : 0) +
                       (/anchor|srcset|api/.test(x.how) ? 1 : 0);
      return s(b) - s(a);
    });
    log(`      ${total} image URL(s) seen, ${images.length} plausible certificate photo(s)`);
    for (const i of images.slice(0, 12)) log(`        [${i.how}] ${i.url}`);

    log('[5/5] finding the highest-resolution version of each...');
    const found = await resolveBestPhotos(images, fetchImage, {
      grn: opts.grn, imgDir, outDir, concurrency: opts.concurrency, log,
    });

    if (res.resultHtml) fs.writeFileSync(path.join(outDir, `result-${name}.html`), res.resultHtml);
    if (res.resultText) fs.writeFileSync(path.join(outDir, `result-${name}.txt`), res.resultText);
    if (res.dispose) await res.dispose();
    return { info: res.info, photos: found };
  };

  const order = opts.engine === 'browser' ? ['browser']
    : opts.engine === 'http' ? ['http'] : ['http', 'browser'];

  for (const name of order) {
    try {
      log(`--- engine: ${name} ---`);
      attempt = await runEngine(name);
      report[name] = attempt.info;
      photos = attempt.photos.filter((p) => p.best);
      if (photos.length) break;
      if (name === 'http' && order.length > 1) {
        log('\nNo photos over plain HTTP - the page may build them with JavaScript.');
        log('Trying the browser engine...\n');
      }
    } catch (err) {
      const msg = String(err.message || err);
      report[name + 'Error'] = msg;
      log(`\n  ${name} engine failed: ${msg}`);
      if (name === 'http' && order.length > 1) log('  Trying the browser engine...\n');
      else if (/not installed/i.test(msg)) {
        log('\n  To enable the browser engine:');
        log('    npm install && npx playwright install chromium');
      }
    }
  }

  report.photos = attempt ? attempt.photos : [];
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  const unique = photos.filter((p) => !p.best.duplicateOfEarlier);
  log('\n=== result ==========================================');
  if (unique.length) {
    log(`Saved ${unique.length} photo(s) to ${imgDir}\n`);
    for (const p of unique) {
      const mp = (p.best.width * p.best.height / 1e6).toFixed(1);
      log(`   ${String(p.best.width + 'x' + p.best.height).padEnd(12)} ${mp} MP  ` +
          `${(p.best.bytes / 1024).toFixed(0)} KB   ${p.best.savedAs}`);
      if (p.upgraded) log(`      upgraded from ${p.baseline.width}x${p.baseline.height} -> ${p.best.url}`);
    }
  } else {
    log('No photos could be extracted.\n');
    log('What to check:');
    log(`  1. Open ${path.join(outDir, 'result-http.html')} - did the lookup actually find the record?`);
    log('  2. Try the browser engine:   node pcg.js ' + opts.grn + ' --browser --headful');
    log('  3. Confirm the grading number is correct and the site is up.');
    log('  4. report.json lists every URL that was tried.');
  }
  log(`\nFull details: ${path.join(outDir, 'report.json')}`);
  log('=====================================================\n');

  if (interactive) await holdWindowOpen();
  return unique.length ? 0 : 1;
}

main().then((c) => process.exit(c)).catch(async (e) => {
  console.error('\nUnexpected error:', e && e.stack ? e.stack : e);
  if (process.stdin.isTTY) await holdWindowOpen();
  process.exit(1);
});
