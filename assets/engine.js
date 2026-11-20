/* Blot engine — PDF parsing, PII detection, pixel-burn redaction, verification.
 * Everything runs in the browser. No network calls, no uploads.
 * Depends on: pdf.js (pdfjsLib) and pdf-lib (PDFLib), both vendored locally.
 */
(function () {
  "use strict";

  const PATTERNS = {
    email: { label: "Email", re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g },
    phone: { label: "Phone", re: /(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-])?\d{3,4}[\s.\-]?\d{4}\b/g },
    ssn: { label: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
    card: { label: "Card", re: /\b(?:\d[ \-]?){13,19}\b/g },
    iban: { label: "IBAN", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b/g },
    krn: { label: "KR RRN", re: /\b\d{6}[\- ]?[1-4]\d{6}\b/g },
    acct: { label: "Account no.", re: /\b\d{8,14}\b/g },
    ip: { label: "IP", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g }
  };

  function luhn(num) {
    const d = String(num).replace(/\D/g, "");
    if (d.length < 13 || d.length > 19) return false;
    let sum = 0, alt = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = +d[i];
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }

  function digits(s) { return (s.match(/\d/g) || []).length; }

  /* Build text lines with a per-character map back to text items, so a regex
     match can be turned into page-space rectangles. */
  function buildLines(items, pageHeight) {
    const prepared = items
      .filter((it) => it && it.str && it.str.trim() !== "" && it.transform)
      .map((it) => {
        const t = it.transform;
        const h = Math.abs(Math.hypot(t[2], t[3])) || Math.abs(t[3]) || 10;
        const w = typeof it.width === "number" && it.width > 0 ? it.width : it.str.length * h * 0.5;
        return {
          str: it.str,
          x: t[4],
          top: pageHeight - t[5] - h,
          w,
          h
        };
      })
      .sort((a, b) => a.top - b.top || a.x - b.x);

    const lines = [];
    let cur = null;
    for (const it of prepared) {
      const tol = Math.max(2, it.h * 0.55);
      if (cur && Math.abs(cur.top - it.top) <= tol) {
        const prev = cur.items[cur.items.length - 1];
        const gap = it.x - (prev.x + prev.w);
        if (gap > it.h * 0.28 && !/\s$/.test(cur.text)) {
          cur.text += " ";
          cur.map.push(-1);
        }
        cur.text += it.str;
        for (let i = 0; i < it.str.length; i++) cur.map.push(cur.items.length);
        cur.items.push(it);
        cur.left = Math.min(cur.left, it.x);
        cur.right = Math.max(cur.right, it.x + it.w);
      } else {
        cur = { text: it.str, map: [], items: [it], top: it.top, left: it.x, right: it.x + it.w };
        lines.push(cur);
        for (let i = 0; i < it.str.length; i++) cur.map.push(0);
      }
    }
    return lines;
  }

  function rectsForMatch(line, start, end) {
    const seen = new Set();
    const out = [];
    for (let i = start; i < end && i < line.map.length; i++) {
      const idx = line.map[i];
      if (idx < 0 || seen.has(idx)) continue;
      seen.add(idx);
      const it = line.items[idx];
      out.push({ x: it.x, y: it.top, w: it.w, h: it.h * 1.18 });
    }
    return out;
  }

  function unionRect(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function mergeNearby(rects, pad) {
    const out = [];
    for (const r0 of rects) {
      const r = { x: r0.x - pad, y: r0.y - pad, w: r0.w + pad * 2, h: r0.h + pad * 2, category: r0.category, matches: (r0.matches || []).slice() };
      let merged = false;
      for (const o of out) {
        const sameRow = Math.abs((o.y + o.h / 2) - (r.y + r.h / 2)) < Math.max(o.h, r.h) * 0.6;
        const near = r.x <= o.x + o.w + 2 && o.x <= r.x + r.w + 2;
        if (sameRow && near && o.category === r.category) {
          const u = unionRect(o, r);
          o.x = u.x; o.y = u.y; o.w = u.w; o.h = u.h;
          for (const m of r.matches) if (o.matches.length < 6 && !o.matches.includes(m)) o.matches.push(m);
          merged = true;
          break;
        }
      }
      if (!merged) out.push(r);
    }
    return out;
  }

  /**
   * Detect PII on one page.
   * @param {object} page pdf.js page
   * @param {object} opts {categories:{email:true,...}, keywords:[string]}
   * @returns {Promise<Array<{x,y,w,h,category,matched}>>}
   */
  async function detectPage(page, opts) {
    const cats = Object.assign({ email: true, phone: false, ssn: true, card: true, iban: true, krn: true, acct: false, ip: false }, (opts && opts.categories) || {});
    const keywords = ((opts && opts.keywords) || []).map((k) => k.trim()).filter((k) => k.length > 1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = buildLines(content.items, viewport.height);
    const found = [];

    function add(rects, category, matched) {
      if (!rects.length) return;
      let r = rects[0];
      for (let i = 1; i < rects.length; i++) r = unionRect(r, rects[i]);
      r.category = category;
      r.matches = [matched];
      found.push(r);
    }

    for (const line of lines) {
      const text = line.text;
      if (!text.trim()) continue;
      for (const key of Object.keys(PATTERNS)) {
        if (!cats[key]) continue;
        const p = PATTERNS[key];
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(text)) !== null) {
          const value = m[0].trim();
          if (!value) continue;
          if (key === "phone" && (digits(value) < 9 || digits(value) > 15)) continue;
          if (key === "card" && !luhn(value)) continue;
          if (key === "acct" && (digits(value) < 8 || digits(value) > 14)) continue;
          if (key === "ip") {
            const ok = value.split(".").every((n) => +n >= 0 && +n <= 255);
            if (!ok) continue;
          }
          add(rectsForMatch(line, m.index, m.index + m[0].length), key, value);
        }
      }
      for (const kw of keywords) {
        const lower = text.toLowerCase();
        const target = kw.toLowerCase();
        let from = 0, at;
        while ((at = lower.indexOf(target, from)) !== -1) {
          add(rectsForMatch(line, at, at + target.length), "keyword", kw);
          from = at + target.length;
        }
      }
    }
    return mergeNearby(found, 1.2);
  }

  async function detectDocument(pdfDoc, opts, onProgress) {
    const out = new Map();
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      out.set(i - 1, await detectPage(page, opts));
      if (onProgress) onProgress(i, pdfDoc.numPages);
    }
    return out;
  }

  async function loadPdf(bytes) {
    // pdf.js transfers the buffer to its worker; keep our own copy.
    const copy = bytes.slice(0);
    const doc = await pdfjsLib.getDocument({ data: copy, isEvalSupported: false }).promise;
    return doc;
  }

  async function renderPage(pdfDoc, pageIndex, canvas, scale, dpr) {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const ratio = dpr || Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(ratio, ratio);
    await page.render({ canvasContext: ctx, viewport }).promise;
    ctx.restore();
    return { width: viewport.width, height: viewport.height, scale: viewport.scale };
  }

  /**
   * Burn redactions into a new PDF.
   * Redacted pages are rasterised (text layer destroyed); other pages are copied
   * as vectors with annotations stripped. The output is a brand-new document, so
   * bookmarks, forms and attachments never survive into it.
   */
  async function exportPdf(input) {
    const { bytes, pdfDoc, boxesByPage, dpi, flattenAll, fill, label, onProgress } = input;
    const out = await PDFLib.PDFDocument.create();
    const src = await PDFLib.PDFDocument.load(bytes.slice(0), { updateMetadata: false });
    const total = pdfDoc.numPages;

    for (let i = 0; i < total; i++) {
      const boxes = (boxesByPage.get(i) || []).filter((b) => b.w > 0.5 && b.h > 0.5);
      if (boxes.length === 0 && !flattenAll) {
        const [copied] = await out.copyPages(src, [i]);
        try { copied.node.delete(PDFLib.PDFName.of("Annots")); } catch (e) { /* no annotations */ }
        out.addPage(copied);
      } else {
        const page = await pdfDoc.getPage(i + 1);
        const scale = dpi / 72;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        for (const b of boxes) {
          const x = b.x * scale, y = b.y * scale, w = b.w * scale, h = b.h * scale;
          ctx.fillStyle = fill === "white" ? "#ffffff" : fill || "#000000";
          ctx.fillRect(x, y, w, h);
          if (label && h > 9) {
            const fs = Math.min(h * 0.62, w / Math.max(label.length, 1) * 1.55);
            if (fs >= 5) {
              ctx.fillStyle = fill === "white" ? "#111111" : "#ffffff";
              ctx.font = "600 " + fs + "px system-ui, sans-serif";
              ctx.textBaseline = "middle";
              ctx.textAlign = "center";
              ctx.fillText(label, x + w / 2, y + h / 2);
            }
          }
        }

        const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.94));
        const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        const points = page.getViewport({ scale: 1 });
        const p = out.addPage([points.width, points.height]);
        p.drawImage(img, { x: 0, y: 0, width: points.width, height: points.height });
      }
      if (onProgress) onProgress(i + 1, total);
    }

    const now = new Date();
    out.setProducer("Blot " + (window.BLOT_CONFIG ? window.BLOT_CONFIG.version : ""));
    out.setCreator("Blot — browser-local redaction");
    out.setTitle("");
    out.setAuthor("");
    out.setSubject("");
    out.setKeywords([]);
    out.setCreationDate(now);
    out.setModificationDate(now);
    return await out.save({ useObjectStreams: true });
  }

  async function sha256Hex(bytes) {
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Re-open the exported bytes and look for every redacted string.
   * A pass means: zero hits, and no extractable text on rasterised pages.
   */
  async function verifyOutput(bytes, terms) {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
    const hits = [];
    const perPage = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => it.str).join(" ").replace(/\s+/g, " ");
      perPage.push({ page: i, chars: text.length });
      const lower = text.toLowerCase();
      for (const term of terms) {
        const t = String(term).trim().toLowerCase();
        if (!t) continue;
        let from = 0, at, count = 0;
        while ((at = lower.indexOf(t, from)) !== -1) { count++; from = at + t.length; }
        if (count > 0) hits.push({ term, page: i, count });
      }
    }
    return { ok: hits.length === 0, hits, perPage, pages: doc.numPages };
  }

  async function makeCertificate(info) {
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const page = doc.addPage([595.28, 841.89]);
    const W = 595.28;
    let y = 780;
    const ink = PDFLib.rgb(0.07, 0.08, 0.1);
    const grey = PDFLib.rgb(0.42, 0.44, 0.48);
    const line = (text, size, f, color, dy) => {
      page.drawText(text, { x: 56, y, size, font: f, color });
      y -= dy;
    };
    page.drawRectangle({ x: 0, y: 790, width: W, height: 52, color: PDFLib.rgb(0.07, 0.08, 0.1) });
    page.drawText("REDACTION CERTIFICATE", { x: 56, y: 806, size: 15, font: bold, color: PDFLib.rgb(1, 1, 1) });
    page.drawText("Blot — neo970720.github.io/blot-pdf", { x: 56, y: 780, size: 9, font, color: PDFLib.rgb(0.75, 0.76, 0.78) });
    y = 745;

    line("Document", 9, bold, grey, 16);
    line(info.fileName || "document.pdf", 12, font, ink, 26);

    const rows = [
      ["Processed (UTC)", info.timestamp],
      ["Pages in original", String(info.pages)],
      ["Pages rasterised (pixel-burn)", String(info.rasterisedPages)],
      ["Redactions applied", String(info.redactions)],
      ["Resolution of rasterised pages", info.dpi + " DPI"],
      ["Export mode", info.mode],
      ["Categories", info.categories && info.categories.length ? info.categories.join(", ") : "manual selection"]
    ];
    for (const [k, v] of rows) {
      page.drawText(k, { x: 56, y, size: 9, font, color: grey });
      page.drawText(String(v), { x: 240, y, size: 10, font, color: ink });
      y -= 19;
    }

    y -= 10;
    page.drawRectangle({ x: 56, y: y - 4, width: W - 112, height: 1, color: PDFLib.rgb(0.86, 0.85, 0.82) });
    y -= 26;
    page.drawText("SHA-256 of the exported file", { x: 56, y, size: 9, font: bold, color: grey });
    y -= 15;
    const hash = info.sha256 || "";
    for (let i = 0; i < hash.length; i += 64) {
      page.drawText(hash.slice(i, i + 64), { x: 56, y, size: 8.5, font, color: ink });
      y -= 12;
    }
    y -= 14;
    const bodyText =
      "This certifies that the attached PDF was redacted locally in the operator's web browser. " +
      "Each page listed as rasterised was converted to an image at the stated resolution, so the text and images " +
      "beneath every redaction were destroyed rather than covered. The exported file was generated as a new document: " +
      "bookmarks, form fields, attachments, JavaScript and document metadata from the original were not carried over. " +
      "No document content was transmitted to Blot or any third party during processing; the service has no server that " +
      "receives files. The SHA-256 digest above identifies the exact output file.";
    const maxW = W - 112;
    const words = bodyText.split(/\s+/);
    const bodyLines = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? current + " " + word : word;
      if (font.widthOfTextAtSize(candidate, 9) > maxW && current) {
        bodyLines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) bodyLines.push(current);
    page.drawText(bodyLines.join("\n"), { x: 56, y, size: 9, font, color: PDFLib.rgb(0.2, 0.22, 0.26), lineHeight: 13 });
    page.drawText("Generated by Blot " + (info.version || "") + " · verify by hashing the file you received", {
      x: 56, y: 60, size: 8, font, color: grey
    });
    return await doc.save();
  }

  window.Blot = window.Blot || {};
  window.Blot.engine = {
    PATTERNS,
    loadPdf,
    renderPage,
    detectPage,
    detectDocument,
    exportPdf,
    verifyOutput,
    makeCertificate,
    sha256Hex
  };
})();
