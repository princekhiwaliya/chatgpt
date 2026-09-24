#!/usr/bin/env node
'use strict';

/**
 * Command-line front-end.
 *
 * Most people should use the web app (`npm start`, or the double-click
 * launcher) -- this exists for scripting and for seeing the full log.
 */

const path = require('path');
const readline = require('readline');
const { runLookup, DEFAULT_URL } = require('./src/run');

const VERSION = require('./package.json').version;

function parseArgs(argv) {
  const o = { grn: null, url: DEFAULT_URL, out: null, engine: 'auto',
    headful: false, timeout: 30000, concurrency: 4, keepAll: false };
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
  npm start                          opens the web app instead

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
`;

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function holdWindowOpen() {
  if (process.stdin.isTTY) await ask('\nPress Enter to close...');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  let interactive = false;
  if (!opts.grn) {
    if (!process.stdin.isTTY) { console.log(HELP); return 2; }
    interactive = true;
    console.log(`\n  PCG Grading photo extractor v${VERSION}\n  ---------------------------------\n`);
    opts.grn = (await ask('  Grading number (e.g. GRN16658IN): ')).toUpperCase();
    if (!opts.grn) { console.log('\n  No number entered.'); await holdWindowOpen(); return 2; }
  }

  console.log(`\n=== PCG Grading photo extractor ===`);
  console.log(`grading number : ${opts.grn}`);
  console.log(`page           : ${opts.url}\n`);

  const { photos, outDir, imgDir } = await runLookup({
    grn: opts.grn, url: opts.url, engine: opts.engine, outDir: opts.out,
    headful: opts.headful, timeout: opts.timeout, concurrency: opts.concurrency,
    keepAll: opts.keepAll, onLog: (m) => console.log(m),
  });

  const unique = photos.filter((p) => !p.best.duplicateOfEarlier);
  console.log('\n=== result ==========================================');
  if (unique.length) {
    console.log(`Saved ${unique.length} photo(s) to ${imgDir}\n`);
    for (const p of unique) {
      const mp = (p.best.width * p.best.height / 1e6).toFixed(1);
      console.log(`   ${String(p.best.width + 'x' + p.best.height).padEnd(12)} ${mp} MP  ` +
        `${(p.best.bytes / 1024).toFixed(0)} KB   ${p.best.savedAs}`);
      if (p.upgraded) console.log(`      upgraded from ${p.baseline.width}x${p.baseline.height}`);
    }
  } else {
    console.log('No photos could be extracted.\n');
    console.log('What to check:');
    console.log(`  1. Open ${path.join(outDir, 'result-http.html')} - did the lookup find the record?`);
    console.log(`  2. Try the browser engine:   node pcg.js ${opts.grn} --browser --headful`);
    console.log('  3. Confirm the grading number is correct and the site is up.');
    console.log('  4. report.json lists every URL that was tried.');
  }
  console.log(`\nFull details: ${path.join(outDir, 'report.json')}`);
  console.log('=====================================================\n');

  if (interactive) await holdWindowOpen();
  return unique.length ? 0 : 1;
}

main().then((c) => process.exit(c)).catch(async (e) => {
  console.error('\nUnexpected error:', e && e.stack ? e.stack : e);
  await holdWindowOpen();
  process.exit(1);
});
