# Blot — browser-local PDF redaction

A static micro-SaaS. Every PDF is opened, redacted and rewritten **inside the visitor's browser**.
There is no upload endpoint, no database and no server process: the site is plain HTML/CSS/JS plus
vendored `pdf.js` and `pdf-lib`.

```
.
├── index.html              marketing page (SEO, JSON-LD, FAQ)
├── pricing.html            plans + Polar checkout links bound from config.js
├── privacy.html            privacy policy (matches what the code actually does)
├── terms.html              licence, refunds, redaction responsibility
├── 404.html
├── app/index.html          the tool
├── assets/
│   ├── style.css           all styling (light + dark, no framework)
│   ├── config.js           ← the only file to edit before going live
│   ├── engine.js           detection, export, verification, certificate
│   ├── app.js              UI: file queue, canvas, boxes, export flow
│   ├── license.js          Polar licence keys, demo keys, offline cache
│   ├── og.png, icon-*.png, favicon.svg
├── vendor/                 pdf.min.js, pdf.worker.min.js, pdf-lib.min.js (vendored, offline)
├── sw.js                   service worker: app shell cached for offline use
├── manifest.webmanifest
├── robots.txt, sitemap.xml, _headers
```

## What it actually does

* **True redaction.** Any page with a box is rendered to an image at 150/200/300 DPI and the boxes are
  painted into that image; the text underneath is gone. Pages without boxes are copied as vectors with
  annotations removed.
* **New document, not an edit.** The export is built from scratch, so bookmarks, form fields, attachments,
  JavaScript and the original metadata never reach the output. Metadata is reset (`Producer: Blot`).
* **Leak check.** The exported bytes are reopened with pdf.js and searched for every value the tool
  redacted (auto-detected matches, plus the text that sat under each manual box). The report shows pages,
  DPI, terms probed and the SHA-256 of the output.
* **PII auto-detect (Pro).** Email, phone, SSN, card (Luhn-checked), IBAN, Korean RRN, account numbers,
  optional IPv4, plus a user keyword list. Matches become boxes with their page coordinates.
* **Certificate (Pro).** One-page PDF with document name, pages, rasterised pages, redaction count, DPI,
  categories, UTC timestamp and the SHA-256 digest of the export.
* **Offline.** Service worker caches the shell and vendor libraries; Pro keys are verified once and cached
  for `revalidateDays`, so the tool works with the network off.

## Plans

| | Free | Pro |
|---|---|---|
| Pages per file | 10 | unlimited |
| Manual boxes | unlimited | unlimited |
| DPI | 150 / 200 | 150 / 200 / 300 |
| Leak check | included | included |
| PII auto-detect | — | ✓ |
| Batch | — | up to 20 files |
| Certificate | — | ✓ |
| Price | $0 | $9/month or $29 once |

Limits live in `assets/config.js` (`limits`). They are enforced in the UI only — this is a static app, so a
determined user can edit JavaScript. That is the normal trade-off for a serverless tool; the paid value is
convenience, not a hard DRM boundary.

## Run locally

```bash
cd products/micro-saas-1
python3 -m http.server 8080
# open http://localhost:8080/index.html  (service worker needs http(s), not file://)
```

## Live

**https://neo970720.github.io/blot-pdf/** — GitHub Pages, branch `main`, root folder, $0/month.

The service worker derives its scope from its own location, so the project sub-path (`/blot-pdf/`) is the
base for the app shell, the manifest and every relative link. All canonical, `og:url`, JSON-LD and sitemap
URLs point at that same prefix; `404.html` carries `<base href="/blot-pdf/">` so deep links still style
correctly. If the site ever moves to a root domain, change those URLs and that one `base` tag.

Cloudflare Pages also works: connect the repo, framework preset **None**, build command empty, output
directory `/`; `_headers` (CSP, `nosniff`, referrer policy, immutable `/vendor` caching) is then applied
automatically — GitHub Pages ignores it.

## Turn on payments (Polar)

Live setup (already done, kept here for reference):

| Thing | Value |
|---|---|
| Organization | `Blot` (slug `blot-pdf`), id `a4052b9a-6301-400e-abc8-523c0c6839c4` |
| Benefit | License Keys, prefix `BLOT`, 3 activations, id `ec96f5a5-b099-411d-984b-16ec0674e46c` |
| Pro monthly | $9 / month, product `0a3c08a4-ee3d-4379-8d8e-88067abbef13` |
| Pro lifetime | $29 once, product `ff8dce45-c344-4ff9-92b3-300a2f603f79` |
| Checkout (monthly) | `https://buy.polar.sh/polar_cl_WEDHiBUDwyL8z4D8UMXn42iREPhzHDnYHRNow2HJiP9` |
| Checkout (lifetime) | `https://buy.polar.sh/polar_cl_3XKhbTjbFHrwM4fdpoNtjATTSzXf3gLc5hqR34OFeDT` |

Payouts run through Stripe Express (KR, KRW). Until that onboarding (identity + bank account) is finished
Polar keeps checkout in test mode and no card is charged.

`demo.enabled` is **false** in production; the demo key list is empty. To dry-run the paid flow without
charging, point `validateUrl` at Polar's sandbox and test there.

How validation works: the app POSTs `{key, organization_id}` to
`https://api.polar.sh/v1/customer-portal/license-keys/validate` — Polar documents this endpoint as safe for
public clients. A `status: "granted"` answer is cached in `localStorage` and re-checked at most every
`revalidateDays`. No secret key is shipped in the client.

## Verification

`e2e` results, screenshots and the generated sample outputs live outside this folder:

* `reports/micro-saas-1/e2e-results.json` — 43 checks (desktop, 390 px, dark, offline, licence gates, real exports)
* `reports/micro-saas-1/*.png` — screenshots
* `work/saas1/e2e.py` — the Playwright/Chromium test runner

The test suite generates PDFs with fake PII, draws and auto-detects redactions, exports them, and then
re-opens the output with **pypdf** (an independent implementation) to prove the text layer is gone, the
untouched pages are intact, the A4 page size is preserved and the certificate carries the export's hash.
