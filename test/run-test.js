'use strict';
/**
 * End-to-end check for both engines.
 *
 * Boots the mock grading site and runs the real CLI against it twice -- once
 * over plain HTTP, once through the browser -- asserting that each finds the
 * form, completes the lookup, discovers the photo API, upgrades the thumbnails
 * to the full-resolution originals, and writes correct files.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { imageSize } = require('../src/imagesize');

const PORT = 8900 + Math.floor(Math.random() * 300);
const GRN = 'GRN16658IN';
const URL_ = `http://127.0.0.1:${PORT}/authenticity-verification.aspx`;
const CLI = path.join(__dirname, '..', 'pcg.js');

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || !detail ? '' : '  -- ' + detail}`);
  if (!cond) failures++;
}

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-server.js'), String(PORT)],
  { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function runEngine(flag, out, grn = GRN) {
  return spawnSync(process.execPath, [CLI, grn, flag, '--url', URL_, '--out', out],
    { encoding: 'utf8' });
}

/** Assertions that must hold whichever engine produced the result. */
function verify(engine, out, run) {
  console.log(`\n--- ${engine} engine ---`);
  check(`${engine}: exited successfully`, run.status === 0, 'exit ' + run.status);

  const reportPath = path.join(out, 'report.json');
  check(`${engine}: report.json written`, fs.existsSync(reportPath));
  if (!fs.existsSync(reportPath)) return;
  const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const info = r[engine];

  check(`${engine}: no engine error`, !r[engine + 'Error'], r[engine + 'Error']);
  check(`${engine}: found the certificate field`, !!(info && (info.field || info.form)));
  check(`${engine}: detected ASP.NET WebForms`,
    !!(info && (info.isWebForms || (info.form && info.form.isWebForms))));
  check(`${engine}: grading number present in result`, info && info.grnFoundOnPage === true);
  check(`${engine}: did not misread as "not found"`, info && info.looksNotFound === false);

  // The photo API must be discovered, and its body read.
  const apiBodies = engine === 'http'
    ? (info.apiResponses || []).map((a) => a.bodyPreview || '')
    : (info.apiCalls || []).map((c) => c.bodyPreview || '');
  check(`${engine}: discovered the photo API and read its body`,
    apiBodies.some((b) => b.includes('obverse')),
    `${apiBodies.length} API body/bodies seen`);

  const photos = (r.photos || []).filter((p) => p.best);
  check(`${engine}: resolved at least 2 photos`, photos.length >= 2, 'got ' + photos.length);

  // The 160x120 handler thumbnail must resolve to the 3000x2250 original.
  const biggest = photos.reduce((a, b) =>
    !a || b.best.width * b.best.height > a.best.width * a.best.height ? b : a, null);
  check(`${engine}: found the full-resolution original (3000x2250)`,
    biggest && biggest.best.width === 3000 && biggest.best.height === 2250,
    biggest ? `${biggest.best.width}x${biggest.best.height}` : 'none');
  check(`${engine}: reported the upgrade over the thumbnail`, !!(biggest && biggest.upgraded));

  // Saved bytes must match what was reported, with a truthful extension.
  for (const p of photos) {
    const f = path.join(out, p.best.savedAs);
    const dim = fs.existsSync(f) ? imageSize(fs.readFileSync(f)) : null;
    check(`${engine}: saved file matches reported size (${path.basename(f)})`,
      !!dim && dim.width === p.best.width && dim.height === p.best.height,
      dim ? `${dim.width}x${dim.height} vs ${p.best.width}x${p.best.height}` : 'missing');
    check(`${engine}: extension matches real format (${path.extname(f)})`,
      !!dim && path.extname(f).slice(1) === dim.type.replace('jpeg', 'jpg'));
  }

  const onDisk = fs.readdirSync(path.join(out, 'images'));
  const distinct = new Set(photos.map((p) => p.best.sha256));
  check(`${engine}: de-duplicated identical photos`, onDisk.length === distinct.size,
    `${onDisk.length} files vs ${distinct.size} distinct images`);
  check(`${engine}: site logo excluded`, !photos.some((p) => /logo/i.test(p.best.url)));
}

(async () => {
  await wait(1500);
  const outs = [];

  // The plain-HTTP engine is the one that must work with nothing installed.
  const httpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-http-'));
  outs.push(httpOut);
  verify('http', httpOut, runEngine('--http', httpOut));

  // The browser engine is optional; skip cleanly when Playwright is absent.
  let havePlaywright = true;
  try { require.resolve('playwright'); } catch { havePlaywright = false; }
  if (havePlaywright) {
    const browserOut = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-browser-'));
    outs.push(browserOut);
    verify('browser', browserOut, runEngine('--browser', browserOut));
  } else {
    console.log('\n--- browser engine ---\nSKIP  playwright not installed (optional)');
  }

  // A number with no record must fail cleanly rather than inventing photos.
  const missOut = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-miss-'));
  outs.push(missOut);
  const miss = runEngine('--http', missOut, 'GRN00000XX');
  console.log('\n--- unknown grading number ---');
  check('unknown number: non-zero exit', miss.status !== 0, 'exit ' + miss.status);
  const missReport = JSON.parse(fs.readFileSync(path.join(missOut, 'report.json'), 'utf8'));
  check('unknown number: no photos invented', (missReport.photos || []).filter((p) => p.best).length === 0);

  finish(outs);
})().catch((e) => { console.error(e); failures++; finish([]); });

function finish(outs) {
  mock.kill();
  for (const o of outs) fs.rmSync(o, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}
