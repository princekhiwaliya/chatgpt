'use strict';
/**
 * Stand-in for the PCG verification site, used to exercise the tracker offline.
 * Mimics the shape of an ASP.NET WebForms app: __VIEWSTATE postback, an image
 * handler with a size parameter, and a JSON photo endpoint fetched over XHR.
 */
const http = require('http');
const zlib = require('zlib');

const CERT = 'GRN16658IN';

/* --- minimal PNG encoder, so we can mint images at any resolution --- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(w, h, seed) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      raw[i] = (x * 7 + seed) & 0xff;
      raw[i + 1] = (y * 5 + seed) & 0xff;
      raw[i + 2] = ((x ^ y) + seed) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --- the sizes the "site" is willing to serve --- */
const SIZES = { thumb: [160, 120], medium: [640, 480], large: [1600, 1200], original: [3000, 2250] };

function resolveSize(q) {
  const named = (q.get('size') || '').toLowerCase();
  if (SIZES[named]) return SIZES[named];
  // A numeric width is clamped to the original, like a real resizer.
  const w = Number(q.get('w') || q.get('width') || 0);
  if (w > 0) {
    const [ow, oh] = SIZES.original;
    const cw = Math.min(w, ow);
    return [cw, Math.round((cw / ow) * oh)];
  }
  return SIZES.thumb;
}

const PAGE = (body) => `<!DOCTYPE html><html><head><title>Authenticity Verification - PCG Grading</title></head>
<body><form method="post" action="/authenticity-verification.aspx" id="form1">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwUKMTIzNDU2Nzg5MGRk" />
<input type="hidden" name="__VIEWSTATEGENERATOR" value="CA0B0334" />
<input type="hidden" name="__EVENTVALIDATION" value="/wEdAAKq" />
<h1>Authenticity Verification</h1>
<label>Enter Grading Number</label>
<input name="ctl00$ContentPlaceHolder1$txtCertNo" id="txtCertNo" type="text" style="width:260px;height:28px" placeholder="e.g. GRN00000IN" />
<input type="submit" name="ctl00$ContentPlaceHolder1$btnVerify" id="btnVerify" value="Verify" />
${body}</form></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  if (u.pathname === '/GetImage.ashx') {
    const [w, h] = resolveSize(u.searchParams);
    const png = makePng(w, h, 42);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    return res.end(png);
  }

  // The "photo API" the results page calls over XHR.
  if (u.pathname === '/api/photos') {
    const payload = JSON.stringify({
      cert: u.searchParams.get('cert'),
      photos: [
        { face: 'obverse', thumb: `/GetImage.ashx?cert=${CERT}&side=obv&size=thumb` },
        { face: 'reverse', thumb: `/GetImage.ashx?cert=${CERT}&side=rev&size=thumb` },
      ],
      gallery: `/media/thumb/${CERT}_slab_s.png`,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(payload);
  }

  // A static derivative whose original lives in a sibling directory.
  const m = u.pathname.match(/^\/media\/(thumb|original)\/(.+?)(_s)?\.png$/);
  if (m) {
    const big = m[1] === 'original';
    const png = makePng(big ? 2400 : 200, big ? 1800 : 150, 7);
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(png);
  }

  if (u.pathname === '/authenticity-verification.aspx') {
    if (req.method !== 'POST') return html(res, PAGE(''));
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const cert = (params.get('ctl00$ContentPlaceHolder1$txtCertNo') || '').trim().toUpperCase();
      if (cert !== CERT) return html(res, PAGE('<p>No record found for this number.</p>'));
      html(res, PAGE(`
<div id="result">
  <h2>Certificate ${CERT}</h2>
  <table><tr><td>Grade</td><td>MS 65</td></tr><tr><td>Item</td><td>1 Rupee 1947</td></tr></table>
  <a href="/media/original/${CERT}_slab.png">
    <img id="imgSlab" src="/media/thumb/${CERT}_slab_s.png" alt="${CERT} slab" />
  </a>
  <img id="imgObv" src="/GetImage.ashx?cert=${CERT}&side=obv&size=thumb" alt="obverse" />
  <img src="/logo.png" alt="site logo" />
</div>
<script>fetch('/api/photos?cert=${CERT}').then(r=>r.json()).then(d=>console.log(d));</script>`));
    });
    return;
  }

  if (u.pathname === '/logo.png') {
    const png = makePng(80, 30, 1);
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(png);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

function html(res, s) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(s);
}

const port = Number(process.argv[2] || 8799);
server.listen(port, '127.0.0.1', () => console.log('mock listening on ' + port));
