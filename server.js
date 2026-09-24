#!/usr/bin/env node
'use strict';

/**
 * Local web app: the easy way to use this.
 *
 * Starts a small server on your own machine, opens the browser, and gives you
 * a box to type a grading number into. Progress streams back live, and the
 * photos appear as thumbnails you can click to download at full resolution.
 *
 * Nothing leaves your computer except the request to the grading site itself.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runLookup, DEFAULT_URL } = require('./src/run');

const VERSION = require('./package.json').version;
const RESULTS_ROOT = path.join(process.cwd(), 'results');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff',
};

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PCG Photo Extractor</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #14171a; --muted: #5b6570;
    --line: #e3e6ea; --accent: #1a6acb; --accent-ink: #ffffff;
    --ok: #0f7b46; --warn: #a15c00; --err: #b3261e;
    --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14171a; --card: #1d2125; --ink: #e9edf1; --muted: #9aa5b1;
      --line: #2c3238; --accent: #5fa4f5; --accent-ink: #0b1017;
      --ok: #55d19a; --warn: #e2a33c; --err: #ff7b72;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
  header { margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 14px; }
  .card {
    background: var(--card); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 20px; margin-bottom: 20px;
  }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 8px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  input[type=text] {
    flex: 1 1 240px; min-width: 0; padding: 12px 14px; font-size: 17px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: 0.04em; text-transform: uppercase;
    border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); color: var(--ink);
  }
  input[type=text]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button {
    padding: 12px 22px; font-size: 15px; font-weight: 600; cursor: pointer;
    border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-ink);
  }
  button:disabled { opacity: 0.55; cursor: progress; }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
  .opts { margin-top: 12px; font-size: 13px; color: var(--muted); }
  .opts label { display: inline-flex; align-items: center; gap: 6px; font-weight: 400; margin: 0 16px 0 0; }
  .hidden { display: none !important; }

  #status { font-weight: 600; margin-bottom: 10px; }
  #status.ok { color: var(--ok); } #status.err { color: var(--err); }
  #status.warn { color: var(--warn); }
  pre#log {
    margin: 0; max-height: 220px; overflow: auto; padding: 12px;
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
    font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;
    color: var(--muted); white-space: pre-wrap; word-break: break-all;
  }
  summary { cursor: pointer; font-size: 13px; color: var(--muted); margin-bottom: 8px; }

  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  .shot { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--bg); }
  .shot a.thumb { display: block; background: #0000000d; }
  .shot img { display: block; width: 100%; height: 170px; object-fit: contain; }
  .meta { padding: 10px 12px; }
  .res { font-weight: 700; font-size: 15px; }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 7px;
    border-radius: 999px; background: var(--ok); color: #fff; margin-left: 6px;
  }
  .dim { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .dl { display: block; margin-top: 8px; text-align: center; padding: 7px;
        border: 1px solid var(--line); border-radius: 7px; text-decoration: none;
        color: var(--accent); font-weight: 600; font-size: 13px; }
  ul.tips { margin: 8px 0 0; padding-left: 20px; color: var(--muted); font-size: 14px; }
  ul.tips li { margin-bottom: 4px; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px;
         background: var(--bg); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>PCG Photo Extractor</h1>
    <div class="sub">Grading number daaliye &mdash; sabse high-resolution photos nikal kar denge.</div>
  </header>

  <form class="card" id="form">
    <label for="grn">Grading number</label>
    <div class="row">
      <input type="text" id="grn" name="grn" placeholder="GRN16658IN" autocomplete="off" required>
      <button type="submit" id="go">Get Photos</button>
    </div>
    <div class="opts">
      <label><input type="checkbox" id="browser"> Use real browser (slower, needs setup)</label>
      <label><input type="checkbox" id="keepAll"> Keep every image</label>
    </div>
  </form>

  <section class="card hidden" id="progress">
    <div id="status">Working&hellip;</div>
    <details id="logBox"><summary>Show details</summary><pre id="log"></pre></details>
  </section>

  <section class="card hidden" id="results">
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:14px">
      <strong id="count"></strong>
      <button class="ghost" type="button" id="openFolder">Open folder</button>
    </div>
    <div class="grid" id="grid"></div>
  </section>

  <section class="card hidden" id="failure">
    <div id="failMsg" style="font-weight:600;margin-bottom:6px"></div>
    <ul class="tips">
      <li>Check the grading number &mdash; woh slab ke label par likha hota hai.</li>
      <li>Tick <em>Use real browser</em> above and try again &mdash; site JavaScript use karti ho sakti hai.</li>
      <li>Open <code>results/&lt;NUMBER&gt;/result-http.html</code> to see exactly what the site returned.</li>
      <li><code>report.json</code> mein har woh URL hai jo try ki gayi.</li>
    </ul>
  </section>
</div>

<script>
const $ = (id) => document.getElementById(id);
let currentDir = null;

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const grn = $('grn').value.trim().toUpperCase();
  if (!grn) return;
  start(grn, $('browser').checked, $('keepAll').checked);
});

function start(grn, useBrowser, keepAll) {
  $('go').disabled = true;
  $('progress').classList.remove('hidden');
  $('results').classList.add('hidden');
  $('failure').classList.add('hidden');
  $('grid').innerHTML = '';
  $('log').textContent = '';
  $('status').className = '';
  $('status').textContent = 'Looking up ' + grn + '\\u2026';

  const q = new URLSearchParams({ grn, engine: useBrowser ? 'browser' : 'auto',
    keepAll: keepAll ? '1' : '' });
  const es = new EventSource('/api/track?' + q);

  es.addEventListener('log', (ev) => {
    const el = $('log');
    el.textContent += JSON.parse(ev.data) + '\\n';
    el.scrollTop = el.scrollHeight;
  });

  es.addEventListener('done', (ev) => {
    es.close();
    $('go').disabled = false;
    const d = JSON.parse(ev.data);
    currentDir = d.outDir;
    if (d.photos && d.photos.length) {
      $('status').className = 'ok';
      $('status').textContent = 'Done \\u2014 ' + d.photos.length + ' photo(s) saved.';
      render(d.photos);
    } else {
      $('status').className = 'warn';
      $('status').textContent = 'Lookup finished, but no photos were found.';
      $('failMsg').textContent = d.notFound
        ? 'Site ne is number ka koi record nahi dikhaya.'
        : 'Photos nahi mil payi.';
      $('failure').classList.remove('hidden');
      $('logBox').open = true;
    }
  });

  es.addEventListener('failed', (ev) => {
    es.close();
    $('go').disabled = false;
    $('status').className = 'err';
    $('status').textContent = 'Something went wrong.';
    $('failMsg').textContent = JSON.parse(ev.data).error;
    $('failure').classList.remove('hidden');
    $('logBox').open = true;
  });

  es.onerror = () => {
    es.close();
    $('go').disabled = false;
    if (!$('status').className) {
      $('status').className = 'err';
      $('status').textContent = 'Connection to the local server was lost.';
    }
  };
}

function render(photos) {
  $('count').textContent = photos.length + ' photo' + (photos.length > 1 ? 's' : '');
  $('results').classList.remove('hidden');
  for (const p of photos) {
    const mp = (p.width * p.height / 1e6).toFixed(1);
    const card = document.createElement('div');
    card.className = 'shot';
    const up = p.upgradedFrom
      ? '<span class="badge">' + p.upgradedFrom + ' \\u2192 full</span>' : '';
    card.innerHTML =
      '<a class="thumb" href="' + p.href + '" target="_blank" rel="noopener">' +
        '<img src="' + p.href + '" alt="" loading="lazy">' +
      '</a>' +
      '<div class="meta">' +
        '<div class="res">' + p.width + '\\u00d7' + p.height + up + '</div>' +
        '<div class="dim">' + mp + ' MP \\u00b7 ' + Math.round(p.bytes / 1024) + ' KB</div>' +
        '<a class="dl" href="' + p.href + '" download>Download</a>' +
      '</div>';
    $('grid').appendChild(card);
  }
}

$('openFolder').addEventListener('click', () => {
  if (currentDir) fetch('/api/open?dir=' + encodeURIComponent(currentDir));
});
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

/** Resolve a request path inside `root`, refusing anything that escapes it. */
function safeJoin(root, rel) {
  const full = path.resolve(root, '.' + path.sep + rel.replace(/^[/\\]+/, ''));
  const base = path.resolve(root);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

function openInDesktop(target) {
  const cmd = process.platform === 'win32' ? 'explorer'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { spawn(cmd, [target], { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

async function handleTrack(req, res, query) {
  const grn = String(query.get('grn') || '').trim().toUpperCase();
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const event = (name, data) => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!/^[A-Z0-9-]{3,32}$/.test(grn)) {
    event('failed', { error: 'That does not look like a grading number.' });
    return res.end();
  }

  try {
    const { report, photos, outDir } = await runLookup({
      grn,
      url: process.env.PCG_URL || DEFAULT_URL,
      engine: query.get('engine') === 'browser' ? 'browser' : 'auto',
      keepAll: !!query.get('keepAll'),
      outDir: path.join(RESULTS_ROOT, grn),
      onLog: (line) => event('log', line),
    });

    const unique = photos.filter((p) => !p.best.duplicateOfEarlier);
    event('done', {
      outDir,
      notFound: !!(report.http && report.http.looksNotFound),
      photos: unique.map((p) => ({
        width: p.best.width, height: p.best.height, bytes: p.best.bytes,
        href: '/img/' + encodeURIComponent(grn) + '/' +
              encodeURIComponent(path.basename(p.best.savedAs)),
        upgradedFrom: p.upgraded ? `${p.baseline.width}×${p.baseline.height}` : null,
      })),
    });
  } catch (err) {
    event('failed', { error: String(err.message || err) });
  }
  res.end();
}

function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');

    if (u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (u.pathname === '/api/track') return handleTrack(req, res, u.searchParams);

    if (u.pathname === '/api/open') {
      const dir = u.searchParams.get('dir') || '';
      const safe = safeJoin(RESULTS_ROOT, path.relative(RESULTS_ROOT, dir));
      if (safe && fs.existsSync(safe)) openInDesktop(safe);
      return send(res, 200, 'text/plain', 'ok');
    }

    if (u.pathname.startsWith('/img/')) {
      const rel = decodeURIComponent(u.pathname.slice('/img/'.length));
      const parts = rel.split('/');
      if (parts.length !== 2) return send(res, 400, 'text/plain', 'bad path');
      const file = safeJoin(RESULTS_ROOT, path.join(parts[0], 'images', parts[1]));
      if (!file || !fs.existsSync(file)) return send(res, 404, 'text/plain', 'not found');
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }

    send(res, 404, 'text/plain', 'not found');
  });
}

/** Listen on `port`, stepping to the next free one if it is taken. */
function listen(server, port, host, attemptsLeft = 12) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      if (e.code === 'EADDRINUSE' && attemptsLeft > 0) {
        server.removeListener('error', onError);
        resolve(listen(server, port + 1, host, attemptsLeft - 1));
      } else reject(e);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}

/** A port from the environment or argv, ignoring anything that is not one. */
function wantedPort() {
  for (const raw of [process.env.PORT, process.argv[2]]) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return 8080;
}

async function main() {
  const wanted = wantedPort();
  const server = createServer();
  const port = await listen(server, wanted, '127.0.0.1');
  const url = `http://localhost:${port}`;

  console.log('');
  console.log('  PCG Photo Extractor v' + VERSION + ' is running.');
  console.log('');
  console.log('      ' + url);
  console.log('');
  console.log('  Browser apne aap khul raha hai. Nahi khule to upar wala');
  console.log('  address copy karke browser mein paste kar dijiye.');
  console.log('');
  console.log('  Band karne ke liye is window mein Ctrl+C dabaiye.');
  console.log('');

  if (!process.env.PCG_NO_OPEN) openInDesktop(url);
}

if (require.main === module) {
  main().catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
}

module.exports = { createServer, listen };
