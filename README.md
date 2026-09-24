# PCG Photo Extractor

Ek grading number daaliye — [pcggrading.in](https://www.pcggrading.in/authenticity-verification.aspx)
ke certificate page se **sabse high-resolution photos** nikal kar aapke computer
par save ho jayengi.

Grading sites chhoti preview dikhati hain. Poora scan aksar wahin server par,
thoda alag URL par pada hota hai. Ye wahi dhoondh kar nikalta hai.

---

## Chalane ka tarika

**Sirf [Node.js](https://nodejs.org) chahiye** — bada LTS button dabaiye, install
kijiye, bas. Aur kuch install nahi karna: na `npm install`, na koi browser download.

**Windows** — `PCG-Tracker.bat` par double-click
**Mac / Linux** — `pcg-tracker.command` par double-click

Browser apne aap khul jayega:

```
http://localhost:8080
```

Number daaliye, **Get Photos** dabaiye, photos neeche aa jayengi — resolution ke
saath, aur har ek par Download button.

<sub>Port busy ho to apne aap agla free port le leta hai (8081, 8082…) — terminal
window mein sahi address likha hota hai.</sub>

### Terminal se

```bash
npm start              # web app
node pcg.js GRN16658IN # seedha command line se
```

Photos yahan save hoti hain: `results/<NUMBER>/images/`

---

## Kuch na mile to

Site JavaScript se page banati ho sakti hai, jo plain HTTP nahi chala sakta.
Web app mein **"Use real browser"** tick kijiye. Pehli baar ek install chahiye:

```bash
npm install
npx playwright install chromium
```

Ye bhi dekhiye:

- Grading number sahi hai? (slab ke label par likha hota hai)
- `results/<NUMBER>/result-http.html` — site ne asal mein kya bheja
- `report.json` — **har woh URL jo try ki gayi**, aur kya jawab aaya

## Options (command line)

```
node pcg.js <GRADING_NUMBER> [options]

  --http            sirf plain HTTP (browser ki zaroorat nahi)  [default: auto]
  --browser         real-browser engine zabardasti
  --headful         browser window dikhaiye
  --url <URL>       koi doosra verification page
  --out <DIR>       kahan save karein   [default: ./results/<NUMBER>]
  --timeout <MS>    per-request timeout  [default: 30000]
  --concurrency <N> ek saath kitne downloads  [default: 4]
  --keep-all        site ke logo/icons bhi rakhiye
```

## Kya-kya milta hai

```
results/GRN16658IN/
  images/            har photo ka sabse achha version
  report.json        har URL jo try hui, har size jo mila
  result-http.html   certificate page jaisa aaya
  result-http.txt    uska dikhne wala text
  result.png         full-page screenshot (browser engine par)
```

---

## Ye kaam kaise karta hai

**Do engine, ek hi natija.** Plain HTTP default hai kyunki usme kuch install
nahi karna padta — woh ASP.NET WebForms ka postback seedha replay karta hai aur
session cookie sambhaalta hai (wahi cookie image handler se photos nikalwati
hai). Browser engine asli Chromium mein page ka JavaScript chalata hai aur uski
har network call record karta hai. HTTP se kuch na mile to browser engine apne
aap try hota hai (agar installed ho).

**Site ke baare mein kuch bhi hardcoded nahi hai**, kyunki uska koi documentation
nahi hai:

- *Form scoring se milta hai.* Har text input ko uske `name`/`id`/`placeholder`
  (`grn`, `cert`, `barcode`, `serial`…) par number diya jaata hai, sabse zyada
  score wala bhara jaata hai. Baaki candidates `report.json` mein rehte hain,
  isliye galat guess turant dikh jaata hai.
- *Photo endpoint dekh kar milta hai.* HTTP mode inline scripts scan karke JSON
  endpoints khud call karta hai; browser mode har request log karta hai aur
  XHR/fetch ki response body pakadta hai.
- *Images har jagah se* — `<img src>`, `srcset`, lazy-load `data-*`, zoom links,
  CSS backgrounds, aur API responses ke andar likhe paths. Logo, icon, spinner
  chhaant diye jaate hain.

**Sabse achhi quality guess nahi, sabit hoti hai.** Candidate URLs in patterns se
bante hain:

| Pattern | Example |
|---|---|
| directory badalna | `/thumb/x.jpg` → `/original/x.jpg` |
| filename marker | `x_s.jpg` → `x.jpg`, `x_large.jpg` |
| CMS size suffix | `coin-150x150.jpg` → `coin.jpg` |
| size parameter | `?w=200` → hataana, ya `w=4000` (resizer original par clamp karta hai) |
| named tier | `size=thumb` → `size=original` |

Phir **har candidate download karke uske asli pixels naape jaate hain**. Jeetta
wahi hai jisme sabse zyada pixels hon — sirf byte size dekhna jhooth bolta hai,
kyunki re-encoded chhoti image badi ho sakti hai. ASP.NET handlers (`.ashx`,
`.aspx`) ko code maana jaata hai, filename nahi, isliye sirf unki query string
badalti hai.

Natije URL aur SHA-256 dono se dedupe hote hain, to ek hi original tak jaane
wali kai thumbnails se ek hi file banti hai. Ek saath 4 download chalte hain.

## Tests

```bash
npm test
```

`test/mock-server.js` asli site ki jagah khada hota hai: `__VIEWSTATE` postback,
`GetImage.ashx` handler jo `size`/`w` ko clamp karta hai, `/api/photos` JSON
endpoint jo XHR se aata hai, ek thumbnail jiska original bagal ki directory mein
hai, aur ek logo jo ignore hona chahiye. Suite **dono engines** ko asli CLI se
chalati hai aur check karti hai ki dono form dhoondhte hain, lookup poora karte
hain, photo API pakadte hain, 160×120 thumbnail ko 3000×2250 original tak le
jaate hain, files ke bytes aur extension report se match karte hain, aur
identical photos dedupe hoti hain — saath hi ye bhi ki galat number par saaf
fail hota hai, jhooti photos nahi banti.

## Asli site ke baare mein ek zaroori baat

Ye sandbox mein likha gaya hai jahan `www.pcggrading.in` network policy se
blocked hai, isliye **ye asli site par kabhi nahi chala** — upar ke saare tests
mock par hue hain. Code isiliye site ke markup ke baare mein koi assumption
nahi karta, par pehli asli run par thoda adjustment lag sakta hai. Khaali aaye
to `report.json` aur `result-http.html` bilkul saaf bata denge ki site ne kya
bheja — fix wahin se shuru hoga.

## Thoda dhyan rakhiye

Ye ek public verification page ko waise hi padhta hai jaise browser padhta hai,
un certificate numbers ke liye jo aapke paas hain. Ek baar mein ek number, aur
concurrency kam rakhi gayi hai. Ise certificate numbers ki bulk range par mat
chalaiye.
