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

## Deploy (Cloudflare Pages, $0)

1. Push this folder to a GitHub repository (or upload it directly in the Pages dashboard).
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**, framework preset **None**,
   build command empty, output directory `/` (this folder).
3. Add the custom domain (`blotpdf.com` — **available as of 20 Nov 2026**, checked with whois) or use the
   free `*.pages.dev` subdomain first.
4. `_headers` is picked up automatically: CSP, `nosniff`, referrer policy, immutable caching for `/vendor`.

GitHub Pages works too: copy the folder to a repo, enable Pages, add a `CNAME` file with the domain. The
service worker uses its own location as the base path, so a project sub-path (`/repo/`) also works.

## Turn on payments (Polar)

1. Create a Polar account and connect a bank account for payouts (KRW payouts are supported).
2. Create two products:
   * **Blot Pro — monthly**, $9 / month, recurring.
   * **Blot Pro — lifetime**, $29, one-time.
3. For each product add a **Benefit → License Keys**, prefix `BLOT`, and if you like set
   “activation limit” to 3 devices.
4. Copy from the dashboard into `assets/config.js`:
   * `polar.orgId` — Settings → Organization id.
   * `polar.checkoutMonthly`, `polar.checkoutLifetime` — the checkout links.
   * `polar.productMonthlyId`, `polar.productLifetimeId` — optional, for reporting.
5. Set `demo.enabled = false` once real keys are live (or keep it and remove the demo key).
6. Test with Polar's sandbox: `validateUrl` → `https://sandbox-api.polar.sh/v1/customer-portal/license-keys/validate`.

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
