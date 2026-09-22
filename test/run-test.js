'use strict';
/**
 * End-to-end check: boots the mock grading site, runs the tracker against it,
 * and asserts that each stage did its job -- form discovery, postback lookup,
 * photo-API capture, high-resolution upgrade and de-duplication.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8799 + Math.floor(Math.random() * 200);
const GRN = 'GRN16658IN';
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-test-'));

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || !detail ? '' : '  -- ' + detail}`);
  if (!cond) failures++;
}

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-server.js'), String(PORT)],
  { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(1500);
  const run = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'src', 'pcg-track.js'), GRN,
    '--url', `http://127.0.0.1:${PORT}/authenticity-verification.aspx`,
    '--out', out,
  ], { encoding: 'utf8' });

  if (run.status !== 0) {
    console.error(run.stdout, run.stderr);
    check('tracker exited cleanly', false, 'exit ' + run.status);
  }

  const reportPath = path.join(out, 'report.json');
  check('report.json written', fs.existsSync(reportPath));
  if (!fs.existsSync(reportPath)) return finish();
  const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

  check('no run error', !r.error, r.error);
  check('found the certificate input', !!(r.form && r.form.fieldSelector), JSON.stringify(r.form));
  check('detected ASP.NET WebForms', r.form && r.form.isWebForms === true);
  check('grading number present in result page', r.grnFoundOnPage === true);
  check('did not mistake the page for "not found"', r.looksNotFound === false);

  // The XHR photo endpoint must be captured with its JSON body.
  const photoApi = (r.apiCalls || []).find((c) => c.url.includes('/api/photos'));
  check('captured the photo API call', !!photoApi, 'apiCalls=' + (r.apiCalls || []).length);
  check('captured the photo API response body',
    !!(photoApi && photoApi.bodyPreview && photoApi.bodyPreview.includes('obverse')));

  const photos = (r.photos || []).filter((p) => p.best);
  check('resolved at least 2 photos', photos.length >= 2, 'got ' + photos.length);

  // The handler thumbnail (160x120) must be upgraded to the 3000x2250 original.
  const biggest = photos.reduce((a, b) =>
    (a && a.best.width * a.best.height > b.best.width * b.best.height ? a : b), null);
  check('found the full-resolution original (3000x2250)',
    biggest && biggest.best.width === 3000 && biggest.best.height === 2250,
    biggest ? `${biggest.best.width}x${biggest.best.height}` : 'none');
  check('reported the upgrade over the thumbnail', !!(biggest && biggest.upgraded === true));

  // Saved bytes must match the reported dimensions, and carry a true extension.
  const { imageSize } = require('../src/imagesize');
  for (const p of photos) {
    const f = path.join(out, p.best.savedAs);
    const dim = fs.existsSync(f) ? imageSize(fs.readFileSync(f)) : null;
    check(`saved file matches reported size (${p.best.savedAs})`,
      !!dim && dim.width === p.best.width && dim.height === p.best.height,
      dim ? `${dim.width}x${dim.height} vs ${p.best.width}x${p.best.height}` : 'missing');
    check(`extension matches real format (${path.extname(f)})`,
      !!dim && path.extname(f).slice(1).replace('jpg', 'jpeg') === dim.type.replace('jpg', 'jpeg'));
  }

  // Byte-identical winners share one file on disk.
  const onDisk = fs.readdirSync(path.join(out, 'images'));
  const uniqueHashes = new Set(photos.map((p) => p.best.sha256));
  check('de-duplicated identical photos', onDisk.length === uniqueHashes.size,
    `${onDisk.length} files vs ${uniqueHashes.size} distinct images`);

  check('site logo excluded from certificate photos',
    !photos.some((p) => /logo/i.test(p.best.url)));

  finish();
})().catch((e) => { console.error(e); failures++; finish(); });

function finish() {
  mock.kill();
  fs.rmSync(out, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}
