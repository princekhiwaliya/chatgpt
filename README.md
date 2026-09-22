# PCG Grading photo extractor

Enter a grading number, get the **highest-resolution photos** the
[pcggrading.in](https://www.pcggrading.in/authenticity-verification.aspx)
certificate page will give up — saved into a folder on your machine.

Grading sites show you a small preview. The full-size scan is usually sitting
right there on the server under a slightly different URL. This finds it.

---

## Quick start

**You only need [Node.js](https://nodejs.org) — click the big LTS button, install, done.**
Nothing else. No `npm install`, no browser download.

**Windows** — double-click `PCG-Tracker.bat`
**Mac / Linux** — double-click `pcg-tracker.command`

It asks for the grading number, then saves the photos.

Or from a terminal:

```bash
node pcg.js GRN16658IN
```

Photos land in `results/GRN16658IN/images/`.

```
=== result ==========================================
Saved 2 photo(s) to results/GRN16658IN/images

   3000x2250     6.8 MP  1737 KB   images/GRN16658IN_01_obv.jpg
      upgraded from 160x120 -> https://.../GetImage.ashx?cert=GRN16658IN&size=original
```

---

## If it finds nothing

The site may build its page with JavaScript, which plain HTTP cannot run. Then
use the browser engine — this is the one time you need to install something:

```bash
npm install
npx playwright install chromium

node pcg.js GRN16658IN --browser --headful
```

`--headful` opens a visible window so you can watch what happens — if there is a
captcha, or the number is wrong, you will see it immediately.

Also worth checking:

- Open `results/<NUMBER>/result-http.html` — did the lookup actually find the record?
- `report.json` lists **every URL that was tried** and what came back.
- Confirm the grading number is right (it is on the slab label).

## Options

```
node pcg.js <GRADING_NUMBER> [options]

  --http            plain HTTP only (no browser)        [default: auto]
  --browser         force the real-browser engine
  --headful         show the browser window
  --url <URL>       a different verification page
  --out <DIR>       where to save   [default: ./results/<NUMBER>]
  --timeout <MS>    per-request timeout   [default: 30000]
  --concurrency <N> parallel downloads    [default: 4]
  --keep-all        also keep images that look like site furniture
```

## What you get

```
results/GRN16658IN/
  images/            the best version of each photo
  report.json        every URL tried, every size found
  result-http.html   the certificate page as received
  result-http.txt    its visible text
  result.png         full-page screenshot (browser engine only)
```

---

## How it works

**Two engines, same results.** Plain HTTP is the default because it needs
nothing installed: it replays the ASP.NET WebForms postback directly, keeping
the session cookie so the image handler accepts the requests. The browser
engine runs the page's JavaScript in real Chromium and records every network
call it makes. If HTTP finds no photos, the browser engine is tried
automatically when it is available.

**Nothing about the site is hardcoded**, because none of it is documented:

- *The form is found by scoring.* Every text input is ranked on its
  `name`/`id`/`placeholder` (`grn`, `cert`, `barcode`, `serial`, …) and the best
  one is filled. `report.json` records the runners-up, so a wrong guess is
  visible and fixable.
- *The photo endpoint is found by observation.* HTTP mode scans inline scripts
  for endpoints and calls the JSON ones itself; browser mode logs every request
  and captures XHR/fetch response bodies. Either way an undocumented photo API
  shows up.
- *Images are gathered from everywhere* — `<img src>`, `srcset`, lazy-load
  `data-*` attributes, zoom links, CSS backgrounds, and paths mentioned inside
  API responses. Logos, icons and spinners are filtered out.

**The highest-quality version is proven, not guessed.** Candidate URLs are
derived from the patterns these sites actually use:

| Pattern | Example |
|---|---|
| directory swap | `/thumb/x.jpg` → `/original/x.jpg` |
| filename marker | `x_s.jpg` → `x.jpg`, `x_large.jpg` |
| CMS size suffix | `coin-150x150.jpg` → `coin.jpg` |
| size parameter | `?w=200` → dropped, or `w=4000` (resizers clamp to the original) |
| named tier | `size=thumb` → `size=original` |

Every candidate is then **downloaded and measured**. The winner is the one with
the most actual pixels — byte size alone lies, since a re-encoded small image
can outweigh a larger one. ASP.NET handlers (`.ashx`, `.aspx`) are treated as
code, not filenames, so only their query strings are varied.

Results are de-duplicated by URL *and* by SHA-256, so several thumbnails that
lead to the same original produce one file. Downloads run 4 at a time.

## Tests

```bash
npm test
```

`test/mock-server.js` stands in for the real site: `__VIEWSTATE` postback, a
`GetImage.ashx` handler with a clamping `size`/`w` parameter, a `/api/photos`
JSON endpoint fetched over XHR, a thumbnail whose original lives in a sibling
directory, and a logo that must be ignored. The suite runs **both engines**
through the real CLI and checks that each finds the form, completes the lookup,
discovers the photo API, upgrades a 160×120 thumbnail to the 3000×2250
original, writes files whose bytes and extensions match what was reported, and
de-duplicates identical photos — plus that an unknown number fails cleanly
instead of inventing results.

## A note on the live site

This was written in a sandbox where `www.pcggrading.in` is blocked by network
policy, so **it has never been run against the real site** — every test above is
against the mock. The code makes no assumptions about the site's markup for
exactly this reason, but the first real run may still need a small adjustment.
If it comes back empty, `report.json` and `result-http.html` say precisely what
the site returned, which is what any fix would start from.

## Please use it reasonably

This reads a public verification page the way a browser does, for certificate
numbers you hold. It looks up one number at a time and keeps concurrency low.
Don't point it at bulk ranges of certificate numbers.
