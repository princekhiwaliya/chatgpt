# PCG Grading certificate tracker

Looks up a grading number on [pcggrading.in](https://www.pcggrading.in/authenticity-verification.aspx),
discovers which endpoint serves the certificate photos by watching real browser
traffic, and then finds and downloads the **highest-resolution** version of each
photo the site will give up.

Built for grading number `GRN16658IN`, but it takes any number as an argument.

---

## Status: the live lookup has not been run yet

This tool is complete and tested, but it **could not be run against the real
site from the cloud container it was written in**. `www.pcggrading.in` is
refused by the sandbox's network egress policy, from every available path:

| Path | Result |
|---|---|
| `curl` via the agent proxy | `curl: (56) CONNECT tunnel failed, response 403` |
| `WebFetch` | `EGRESS_BLOCKED: Access to www.pcggrading.in is blocked by the network egress proxy` |
| Chromium/Playwright | same proxy, same denial |

That is a policy decision at the egress proxy, not a bug in this code, and it is
not something the tool should route around. **Run it from a machine that can
reach the site** (see below), or allow the domain for the environment — network
policy is chosen per environment and documented at
<https://code.claude.com/docs/en/claude-code-on-the-web>.

Everything except the live fetch is verified: `npm test` exercises the whole
pipeline end to end against a mock of an ASP.NET WebForms grading site.

---

## Usage

```bash
npm install                 # installs playwright
npx playwright install chromium

node src/pcg-track.js GRN16658IN
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--headful` | show the browser, so you can watch the lookup happen |
| `--out DIR` | where to write results (default `./results`) |
| `--url URL` | override the verification page |
| `--timeout MS` | per-step timeout (default 45000) |
| `--concurrency N` | parallel probe requests (default 4, kept low on purpose) |

`--headful` is the one to reach for first: if the site adds a captcha or changes
its markup, you will see it immediately.

## What it writes

```
results/
  report.json        every finding, machine-readable
  network-log.txt    every request the page made: status, type, content-type, URL
  result.html        the rendered certificate page
  result.txt         its visible text
  result.png         full-page screenshot
  images/            the best version of each photo, named <GRN>_NN_<hint>.<ext>
```

## How it finds the photo API

Nothing about the site's markup is hardcoded, because none of it is documented.

1. **The form is found by scoring, not by name.** Every text input is ranked on
   its `name`/`id`/`placeholder` (`grn`, `cert`, `barcode`, `serial`, …) and on
   whether it is actually visible, then the best-scoring one is filled. The
   matching submit control is located within the same `<form>`. `report.json`
   records the runners-up, so a wrong guess is easy to see and correct.
2. **Every network call is recorded** — URL, method, resource type, status,
   content type, and for XHR/fetch/script responses the body itself. A photo
   endpoint that is called from JavaScript shows up here even though it appears
   nowhere in the HTML.
3. **Images are harvested from five places**: `<img src>`, `srcset`, lazy-load
   `data-*` attributes, `<a href>` zoom links, CSS `background-image`, plus any
   image path mentioned inside a captured API response body.
4. Obvious chrome (logos, icons, sprites, spinners, captchas) is filtered out,
   and anything carrying the grading number is ranked first.

## How it finds the highest-quality photo

For each photo it derives candidate URLs (`src/highres.js`) and then **proves
which one is best by downloading it and measuring the real pixels** — byte size
alone lies, since a re-encoded JPEG can be larger than a bigger image.

Candidates come from the patterns grading and CMS sites actually use:

- directory swaps — `/thumb/` → `/original/`, `/full/`, `/large/`, or removed
- filename markers — `_s`, `_thumb`, `-small` dropped or swapped for `_large`, `_orig`
- CMS dimension suffixes — `coin-150x150.jpg` → `coin.jpg`
- query parameters — `w`/`width`/`size`/`quality` dropped, inflated to `4000`
  (a well-behaved resizer clamps to the original), or set to `large`/`full`/`original`
- alternate extensions, for sites that keep a lossless master

ASP.NET image handlers (`.ashx`, `.aspx`, `.asmx`) are treated as code, not
assets, so only their query string is varied — renaming `GetImage.ashx` would
only generate 404s.

Probes reuse the browser's session cookies, which matters when the image handler
refuses requests that did not come from a completed lookup. Results are
de-duplicated by URL **and** by SHA-256, so two paths to the same photo produce
one file. Downloads are capped at 4 concurrent requests.

## Tests

```bash
npm test
```

`test/mock-server.js` stands in for the real site: `__VIEWSTATE` postback, a
`GetImage.ashx` handler with a clamping `size`/`w` parameter, a `/api/photos`
JSON endpoint fetched over XHR, a thumbnail whose original lives in a sibling
directory, and a logo that must be ignored. The suite asserts that the form is
found, the postback succeeds, the photo API and its body are captured, a
160×120 thumbnail is upgraded to the 3000×2250 original, saved bytes match the
reported dimensions, extensions match the real format, and identical photos are
de-duplicated.

## Note on use

This reads a public authenticity-verification page the way a browser does, for a
certificate number you hold. It looks up one number at a time and keeps request
concurrency low. Don't point it at bulk ranges of certificate numbers.
