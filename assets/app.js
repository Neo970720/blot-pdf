/* Blot app UI — file queue, page canvas, redaction boxes, detection, export, verification. */
(function () {
  "use strict";

  const CFG = window.BLOT_CONFIG;
  const E = window.Blot.engine;
  const L = window.Blot.license;

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.min.js";
  }

  const $ = (id) => document.getElementById(id);
  const S = {
    files: [],
    active: -1,
    page: 0,
    zoom: 1,
    fit: 1,
    cssScale: 1,
    undo: [],
    terms: new Set(),
    lastReport: null,
    busy: false,
    textCache: new Map()
  };

  /* ---------------- theme ---------------- */
  (function theme() {
    const saved = localStorage.getItem("blot.theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    $("themeBtn").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme")
        || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("blot.theme", next);
    });
  })();

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, 4200);
  }

  /* ---------------- licence ---------------- */
  function pro() { return L.read().tier === "pro"; }

  function syncPlanUI() {
    const isPro = pro();
    $("proBadge").classList.toggle("on", isPro);
    $("licenseBtn").textContent = isPro ? "Licence" : "Upgrade";
    $("batchNote").textContent = isPro
      ? "Batch up to " + CFG.limits.batchFiles + " files at once."
      : "One file on Free. Batch up to " + CFG.limits.batchFiles + " with Pro.";
    $("planNote").textContent = isPro
      ? "Pro · unlimited pages · batch · auto-detect · 300 DPI · certificate."
      : "Free · " + CFG.limits.freePages + " pages per file · 150 DPI · manual boxes · leak check included.";
    document.querySelectorAll("[data-pro]").forEach((el) => {
      if (el.tagName === "OPTION") el.disabled = !isPro && el.hasAttribute("data-pro");
      else if (el.type === "checkbox") el.disabled = false;
      if (el.tagName === "OPTION" && el.hasAttribute("data-pro")) el.disabled = !isPro;
    });
    if (!isPro) {
      const dpi = $("dpi");
      if (dpi.value === "300") dpi.value = "150";
      if ($("fill").value !== "black" && $("fill").value !== "white") $("fill").value = "black";
    }
    $("fileInput").multiple = isPro;
    $("licenseRemove").hidden = !L.read().key;
    syncBatchButton();
  }

  $("licenseBtn").addEventListener("click", () => openLicense());
  const toolsBtn = $("toolsBtn");
  if (toolsBtn) {
    toolsBtn.addEventListener("click", () => {
      const open = document.body.classList.toggle("tools-open");
      toolsBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) setTimeout(() => { if (activeFile()) render(); }, 60);
      else setTimeout(() => { if (activeFile()) render(); }, 260);
    });
  }
  $("licenseCancel").addEventListener("click", () => $("licenseModal").classList.remove("show"));
  $("licenseModal").addEventListener("click", (e) => {
    if (e.target === $("licenseModal")) $("licenseModal").classList.remove("show");
  });
  $("licenseActivate").addEventListener("click", async () => {
    const btn = $("licenseActivate");
    btn.disabled = true;
    const r = await L.activate($("licenseKey").value);
    btn.disabled = false;
    $("licenseMsg").textContent = r.message;
    $("licenseMsg").style.color = r.ok ? "var(--ok)" : "var(--accent)";
    if (r.ok) {
      syncPlanUI();
      setTimeout(() => $("licenseModal").classList.remove("show"), 900);
    }
  });
  $("licenseRemove").addEventListener("click", () => {
    L.deactivate();
    syncPlanUI();
    $("licenseMsg").textContent = "Licence removed from this browser. Free plan is active.";
    $("licenseMsg").style.color = "";
  });

  function openLicense() {
    const m = $("licenseModal");
    const checkout = L.checkoutUrl();
    $("buyPro").href = checkout || "#licenseKey";
    $("licenseMsg").textContent = L.read().tier === "pro"
      ? "Pro is active on this browser (" + (L.read().source === "demo" ? "demo key" : "Gumroad licence") + ")."
      : "Paste the key from your Gumroad receipt. It is checked once, then cached in this browser for offline use.";
    $("licenseMsg").style.color = "";
    m.classList.add("show");
    setTimeout(() => $("licenseKey").focus(), 60);
  }

  /* ---------------- files ---------------- */
  $("addFileBtn").addEventListener("click", () => $("fileInput").click());
  $("pickBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => {
    addFiles(Array.from(e.target.files || []));
    e.target.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) => {
    $("canvasArea").addEventListener(ev, (e) => { e.preventDefault(); $("dropzone").classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach((ev) => {
    $("canvasArea").addEventListener(ev, (e) => { e.preventDefault(); $("dropzone").classList.remove("dragover"); });
  });
  $("canvasArea").addEventListener("drop", (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) addFiles(files);
  });

  async function addFiles(files) {
    const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { toast("That is not a PDF.", "bad"); return; }
    if (!pro() && (S.files.length > 0 || pdfs.length > 1)) {
      if (S.files.length === 0 && pdfs.length > 1) {
        toast("Batch is a Pro feature. Loading the first file.", "");
        pdfs.length = 1;
      } else {
        toast("One file on Free. Remove the current file or upgrade for batch.", "bad");
        return;
      }
    }
    for (const f of pdfs) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const doc = await E.loadPdf(bytes);
        S.files.push({ id: Math.random().toString(36).slice(2), name: f.name, bytes, doc, pages: doc.numPages, boxes: new Map() });
      } catch (err) {
        toast("Could not open " + f.name + " (is it password-protected?).", "bad");
      }
    }
    if (S.files.length && S.active < 0) setActive(0);
    else if (S.active >= 0) { S.page = 0; await render(); }
    renderFileList();
  }

  function activeFile() { return S.files[S.active] || null; }

  function renderFileList() {
    const list = $("fileList");
    list.innerHTML = "";
    if (!S.files.length) {
      const p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = "No file loaded.";
      list.appendChild(p);
      return;
    }
    S.files.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "item";
      row.style.cursor = "pointer";
      if (i === S.active) row.style.borderColor = "var(--accent)";
      const nm = document.createElement("span");
      nm.className = "txt";
      nm.textContent = f.name;
      nm.title = f.name + " · " + f.pages + " pages";
      const count = document.createElement("span");
      count.className = "muted";
      count.style.fontSize = "11.5px";
      count.textContent = boxCount(f) + " box";
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "×";
      del.setAttribute("aria-label", "Remove " + f.name);
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        S.files.splice(i, 1);
        S.active = S.files.length ? Math.min(S.active, S.files.length - 1) : -1;
        S.page = 0;
        renderFileList();
        if (S.active >= 0) await render(); else resetCanvas();
      });
      row.append(nm, count, del);
      row.addEventListener("click", async () => {
        if (i === S.active) return;
        S.active = i; S.page = 0;
        renderFileList();
        await render();
      });
      list.appendChild(row);
    });
    syncBatchButton();
  }

  function boxCount(f) {
    let n = 0;
    f.boxes.forEach((arr) => { n += arr.length; });
    return n;
  }

  function resetCanvas() {
    $("pageCard").hidden = true;
    $("pageBar").hidden = true;
    $("dropzone").style.display = "";
    $("fileMeta").textContent = "No file yet";
    $("redactionList").innerHTML = "";
    $("redactionCount").textContent = "0";
    $("reportSlot").innerHTML = "";
  }

  async function setActive(i) {
    S.active = i;
    S.page = 0;
    S.zoom = 1;
    renderFileList();
    await render();
  }

  /* ---------------- rendering ---------------- */
  const canvas = $("pageCanvas");
  const overlay = $("overlay");

  function fitScaleFor(file, pageWidthPts) {
    const area = $("canvasArea");
    const avail = Math.max(220, area.clientWidth - 46);
    return Math.min(avail / pageWidthPts, 2.4);
  }

  async function render() {
    const f = activeFile();
    if (!f) { resetCanvas(); return; }
    $("dropzone").style.display = "none";
    $("pageCard").hidden = false;
    $("pageBar").hidden = false;
    S.page = Math.max(0, Math.min(S.page, f.pages - 1));

    const page1 = await f.doc.getPage(S.page + 1);
    const base = page1.getViewport({ scale: 1 });
    S.fit = fitScaleFor(f, base.width);
    const scale = S.fit * S.zoom;
    const info = await E.renderPage(f.doc, S.page, canvas, scale, Math.min(window.devicePixelRatio || 1, 2));
    S.cssScale = info.scale;
    $("pageCard").style.width = info.width + "px";
    $("pageCard").style.height = info.height + "px";
    $("pageLabel").textContent = (S.page + 1) + " / " + f.pages;
    $("zoomLabel").textContent = Math.round(S.zoom * 100) + "%";
    $("fileMeta").textContent = f.name + " · " + f.pages + " page" + (f.pages > 1 ? "s" : "") + (pro() ? "" : " · Free");
    await cacheText(f);
    drawBoxes();
    renderRedactionList();
  }

  async function cacheText(f) {
    const key = f.id + ":" + S.page;
    if (S.textCache.has(key)) return;
    try {
      const page = await f.doc.getPage(S.page + 1);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter((it) => it.str && it.str.trim()).map((it) => {
        const t = it.transform;
        const h = Math.abs(Math.hypot(t[2], t[3])) || 10;
        return { str: it.str, x: t[4], y: vp.height - t[5] - h, w: it.width || it.str.length * h * 0.5, h };
      });
      S.textCache.set(key, items);
    } catch (e) { S.textCache.set(key, []); }
  }

  function boxesOfPage(pageIdx) {
    const f = activeFile();
    if (!f) return [];
    return f.boxes.get(pageIdx) || [];
  }

  function drawBoxes() {
    overlay.innerHTML = "";
    const boxes = boxesOfPage(S.page);
    boxes.forEach((b, i) => {
      const el = document.createElement("div");
      el.className = "redact-box";
      el.style.left = b.x * S.cssScale + "px";
      el.style.top = b.y * S.cssScale + "px";
      el.style.width = b.w * S.cssScale + "px";
      el.style.height = b.h * S.cssScale + "px";
      if (b.fill === "white") el.style.background = "#ffffff";
      if (b.fill && b.fill !== "white") el.style.background = b.fill;
      el.dataset.idx = String(i);
      el.title = b.category ? "Auto-detected: " + b.category : "Manual redaction";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rm";
      rm.textContent = "×";
      rm.setAttribute("aria-label", "Remove redaction");
      rm.addEventListener("pointerdown", (e) => e.stopPropagation());
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        removeBox(S.page, i);
      });
      el.appendChild(rm);
      el.addEventListener("pointerdown", (e) => startMove(e, i));
      overlay.appendChild(el);
    });
  }

  /* ---------------- drawing boxes ---------------- */
  let drag = null;

  overlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (!activeFile()) return;
    const r = overlay.getBoundingClientRect();
    drag = {
      mode: "new",
      x0: (e.clientX - r.left) / S.cssScale,
      y0: (e.clientY - r.top) / S.cssScale,
      el: null
    };
    overlay.setPointerCapture(e.pointerId);
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const r = overlay.getBoundingClientRect();
    const x = (e.clientX - r.left) / S.cssScale;
    const y = (e.clientY - r.top) / S.cssScale;
    if (drag.mode === "new") {
      if (!drag.el) {
        if (Math.abs(x - drag.x0) < 2 && Math.abs(y - drag.y0) < 2) return;
        const el = document.createElement("div");
        el.className = "redact-box draft";
        overlay.appendChild(el);
        drag.el = el;
      }
      const left = Math.min(x, drag.x0), top = Math.min(y, drag.y0);
      drag.el.style.left = left * S.cssScale + "px";
      drag.el.style.top = top * S.cssScale + "px";
      drag.el.style.width = Math.abs(x - drag.x0) * S.cssScale + "px";
      drag.el.style.height = Math.abs(y - drag.y0) * S.cssScale + "px";
    } else if (drag.mode === "move") {
      drag.el.style.left = (drag.box.x + (x - drag.x0)) * S.cssScale + "px";
      drag.el.style.top = (drag.box.y + (y - drag.y0)) * S.cssScale + "px";
    }
  });

  overlay.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const r = overlay.getBoundingClientRect();
    const x = (e.clientX - r.left) / S.cssScale;
    const y = (e.clientY - r.top) / S.cssScale;
    if (drag.mode === "new") {
      const box = {
        x: Math.min(x, drag.x0),
        y: Math.min(y, drag.y0),
        w: Math.abs(x - drag.x0),
        h: Math.abs(y - drag.y0)
      };
      if (box.w > 3 && box.h > 3) addBox(S.page, box);
      if (drag.el) drag.el.remove();
    } else if (drag.mode === "move") {
      const b = drag.box;
      b.x = Math.max(0, b.x + (x - drag.x0));
      b.y = Math.max(0, b.y + (y - drag.y0));
      drawBoxes();
    }
    drag = null;
  });

  overlay.addEventListener("pointercancel", () => { if (drag && drag.el) drag.el.remove(); drag = null; });

  function startMove(e, idx) {
    e.stopPropagation();
    const f = activeFile();
    if (!f) return;
    const b = boxesOfPage(S.page)[idx];
    const el = e.currentTarget;
    const r = overlay.getBoundingClientRect();
    drag = { mode: "move", box: b, el, x0: (e.clientX - r.left) / S.cssScale, y0: (e.clientY - r.top) / S.cssScale };
    el.classList.add("selected");
    overlay.setPointerCapture(e.pointerId);
  }

  function addBox(pageIdx, box, meta) {
    const f = activeFile();
    if (!f) return;
    if (!f.boxes.has(pageIdx)) f.boxes.set(pageIdx, []);
    const b = Object.assign({}, box, meta || {});
    // remember what sits under a manual box so the leak check can prove it went away
    if (!b.underText) {
      const items = S.textCache.get(f.id + ":" + pageIdx) || [];
      const hit = items.filter((it) => it.x < b.x + b.w && it.x + it.w > b.x && it.y < b.y + b.h && it.y + it.h > b.y);
      const text = hit.map((it) => it.str).join(" ").trim();
      if (text) {
        b.underText = text;
        text.split(/\s+/).forEach((t) => { if (t.length > 2) S.terms.add(t); });
      }
    }
    f.boxes.get(pageIdx).push(b);
    S.undo.push({ type: "add", page: pageIdx, box: b });
    drawBoxes();
    renderRedactionList();
    renderFileList();
  }

  function removeBox(pageIdx, idx) {
    const f = activeFile();
    if (!f) return;
    const arr = f.boxes.get(pageIdx) || [];
    const [removed] = arr.splice(idx, 1);
    if (removed) S.undo.push({ type: "remove", page: pageIdx, box: removed });
    drawBoxes();
    renderRedactionList();
    renderFileList();
  }

  $("undoBtn").addEventListener("click", () => {
    const f = activeFile();
    if (!f) return;
    let op = null;
    while (S.undo.length) {
      const cand = S.undo.pop();
      if (cand.type === "add") {
        const arr = f.boxes.get(cand.page) || [];
        const i = arr.indexOf(cand.box);
        if (i >= 0) { arr.splice(i, 1); op = cand; break; }
      } else if (cand.type === "remove") {
        if (!f.boxes.has(cand.page)) f.boxes.set(cand.page, []);
        f.boxes.get(cand.page).push(cand.box);
        op = cand; break;
      }
    }
    if (!op) { toast("Nothing to undo."); return; }
    if (op.page === S.page) drawBoxes();
    renderRedactionList();
    renderFileList();
  });

  $("clearBtn").addEventListener("click", () => {
    const f = activeFile();
    if (!f) return;
    f.boxes.set(S.page, []);
    S.undo.length = 0;
    drawBoxes();
    renderRedactionList();
    renderFileList();
  });

  /* ---------------- redaction list ---------------- */
  function renderRedactionList() {
    const f = activeFile();
    const list = $("redactionList");
    list.innerHTML = "";
    if (!f) { $("redactionCount").textContent = "0"; return; }
    const entries = [];
    f.boxes.forEach((arr, p) => arr.forEach((b, i) => entries.push({ p, i, b })));
    $("redactionCount").textContent = String(entries.length);
    $("redactionHint").style.display = entries.length ? "none" : "";
    entries.slice(0, 60).forEach(({ p, i, b }) => {
      const row = document.createElement("div");
      row.className = "item";
      const tag = document.createElement("span");
      tag.className = "muted mono";
      tag.style.fontSize = "11px";
      tag.textContent = "p" + (p + 1);
      const txt = document.createElement("span");
      txt.className = "txt";
      txt.textContent = b.category ? b.category + (b.matches && b.matches.length ? ": " + b.matches[0] : "") : "manual box";
      txt.title = (b.underText || b.matches || []).toString();
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "×"; del.setAttribute("aria-label", "Remove");
      del.addEventListener("click", () => { if (p !== S.page) { S.page = p; render().then(() => removeBox(p, i)); } else removeBox(p, i); });
      row.addEventListener("click", () => { if (p !== S.page) { S.page = p; render(); } });
      row.append(tag, txt, del);
      list.appendChild(row);
    });
  }

  /* ---------------- paging & zoom ---------------- */
  $("prevBtn").addEventListener("click", () => { if (S.page > 0) { S.page--; render(); } });
  $("nextBtn").addEventListener("click", async () => {
    const f = activeFile();
    if (f && S.page < f.pages - 1) { S.page++; await render(); }
  });
  $("zoomIn").addEventListener("click", () => { S.zoom = Math.min(3, S.zoom + 0.2); render(); });
  $("zoomOut").addEventListener("click", () => { S.zoom = Math.max(0.4, S.zoom - 0.2); render(); });
  document.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") $("nextBtn").click();
    if (e.key === "ArrowLeft") $("prevBtn").click();
    if (e.key === "Escape") $("licenseModal").classList.remove("show");
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (activeFile()) render(); }, 180);
  });

  /* ---------------- detection ---------------- */
  function selectedCategories() {
    const out = {};
    document.querySelectorAll("#catChips .chip").forEach((c) => { out[c.dataset.cat] = c.getAttribute("aria-pressed") === "true"; });
    return out;
  }
  document.querySelectorAll("#catChips .chip").forEach((c) => {
    c.addEventListener("click", () => c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") === "true" ? "false" : "true"));
  });

  function readKeywords() {
    return $("keywords").value.split(/[\n,]/).map((s) => s.trim()).filter((s) => s.length > 1);
  }

  async function detectFor(f, onProgress) {
    const res = await E.detectDocument(f.doc, { categories: selectedCategories(), keywords: readKeywords() }, onProgress);
    let added = 0;
    res.forEach((boxes, pageIdx) => {
      if (!f.boxes.has(pageIdx)) f.boxes.set(pageIdx, []);
      const arr = f.boxes.get(pageIdx);
      for (const b of boxes) {
        const dup = arr.some((o) => Math.abs(o.x - b.x) < 2 && Math.abs(o.y - b.y) < 2 && Math.abs(o.w - b.w) < 4);
        if (dup) continue;
        arr.push(b);
        (b.matches || []).forEach((m) => S.terms.add(m));
        added++;
      }
    });
    return added;
  }

  $("detectBtn").addEventListener("click", async () => {
    if (!pro()) { openLicense(); return; }
    const f = activeFile();
    if (!f) { toast("Load a PDF first."); return; }
    if (S.busy) return;
    S.busy = true;
    $("detectBtn").disabled = true;
    const t0 = performance.now();
    try {
      const added = await detectFor(f, (i, n) => { $("detectBtn").textContent = "Scanning " + i + "/" + n + "…"; });
      toast(added ? added + " match" + (added > 1 ? "es" : "") + " found in " + Math.round(performance.now() - t0) + " ms. Review them before exporting." : "No matches with the selected categories.", added ? "good" : "");
    } catch (err) {
      toast("Detection failed: " + err.message, "bad");
    } finally {
      S.busy = false;
      $("detectBtn").disabled = false;
      $("detectBtn").textContent = "Find matches on all pages";
      drawBoxes();
      renderRedactionList();
      renderFileList();
    }
  });

  /* ---------------- export ---------------- */
  async function exportOne(f, opts) {
    const boxesByPage = f.boxes;
    const out = await E.exportPdf({
      bytes: f.bytes,
      pdfDoc: f.doc,
      boxesByPage,
      dpi: opts.dpi,
      flattenAll: opts.flattenAll,
      fill: opts.fill,
      label: opts.label,
      onProgress: opts.onProgress
    });
    return out;
  }

  function download(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function outName(name) { return name.replace(/\.pdf$/i, "") + "-redacted.pdf"; }

  function termList(f) {
    const terms = new Set();
    f.boxes.forEach((arr) => arr.forEach((b) => {
      if (Array.isArray(b.matches)) b.matches.forEach((m) => terms.add(m));
      else if (b.matches) terms.add(b.matches);
      if (b.underText) b.underText.split(/\s+/).forEach((t) => { if (t.length > 3) terms.add(t); });
    }));
    return Array.from(terms).filter(Boolean).slice(0, 400);
  }

  function showReport(rep, info) {
    const slot = $("reportSlot");
    const ok = rep.ok;
    const redactedPages = Array.from(activeFile().boxes.entries()).filter(([, a]) => a.length).map(([p]) => p + 1);
    slot.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "report";
    wrap.style.marginTop = "12px";
    wrap.innerHTML =
      '<div class="verdict ' + (ok ? "ok" : "bad") + '">' + (ok ? "✓ Leak check passed" : "✗ Text still found") + "</div>" +
      "<dl class='kv'>" +
      "<dt>Output</dt><dd>" + info.name + "</dd>" +
      "<dt>Pages</dt><dd>" + rep.pages + " (" + redactedPages.length + " rasterised)</dd>" +
      "<dt>Resolution</dt><dd>" + info.dpi + " DPI</dd>" +
      "<dt>Terms probed</dt><dd>" + info.terms + "</dd>" +
      "<dt>SHA-256</dt><dd class='mono' style='word-break:break-all;font-size:11px'>" + info.hash.slice(0, 32) + "…</dd>" +
      "</dl>";
    if (!ok) {
      const ul = document.createElement("ul");
      rep.hits.slice(0, 12).forEach((h) => {
        const li = document.createElement("li");
        li.textContent = "“" + h.term + "” still extractable on page " + h.page;
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
      const note = document.createElement("p");
      note.className = "small muted";
      note.style.marginTop = "8px";
      note.textContent = "Add a box over the area (or turn on Flatten every page) and export again.";
      wrap.appendChild(note);
    } else {
      const note = document.createElement("p");
      note.className = "small muted";
      note.style.marginTop = "8px";
      note.textContent = "The exported file was reopened here and searched for every redacted value. None remain in the text layer.";
      wrap.appendChild(note);
    }
    slot.appendChild(wrap);
    S.lastReport = { rep, info };
  }

  $("exportBtn").addEventListener("click", async () => {
    const f = activeFile();
    if (!f) { toast("Load a PDF first."); return; }
    if (S.busy) return;
    const isPro = pro();
    if (!isPro && f.pages > CFG.limits.freePages) {
      toast("Free handles up to " + CFG.limits.freePages + " pages per file. This one has " + f.pages + ".", "bad");
      openLicense();
      return;
    }
    const dpi = parseInt($("dpi").value, 10) || 150;
    if (dpi > CFG.limits.freeDpi && !isPro) { openLicense(); return; }
    const opts = {
      dpi,
      flattenAll: $("flattenAll").checked,
      fill: $("fill").value,
      label: isPro ? $("labelText").value.trim() : ""
    };
    S.busy = true;
    $("exportBtn").disabled = true;
    const t0 = performance.now();
    try {
      $("exportBtn").textContent = "Redacting…";
      const out = await exportOne(f, Object.assign({}, opts, {
        onProgress: (i, n) => { $("exportBtn").textContent = "Redacting " + i + "/" + n + "…"; }
      }));
      const hash = await E.sha256Hex(out);
      const name = outName(f.name);
      download(out, name);

      const terms = termList(f);
      $("exportBtn").textContent = "Checking the export…";
      const rep = await E.verifyOutput(out, terms);
      showReport(rep, { name, dpi, terms: terms.length, hash });

      if (isPro && $("wantCert").checked) {
        try {
          const boxes = [];
          f.boxes.forEach((arr, p) => arr.forEach((b) => boxes.push({ p, b })));
          const cats = Array.from(new Set(boxes.map((x) => x.b.category).filter(Boolean)));
          const cert = await E.makeCertificate({
            fileName: name,
            timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
            pages: f.pages,
            rasterisedPages: new Set(boxes.map((x) => x.p)).size,
            redactions: boxes.length,
            dpi,
            mode: opts.flattenAll ? "Full flatten" : "Redacted pages rasterised",
            categories: cats,
            sha256: hash,
            version: CFG.version
          });
          download(cert, name.replace(/\.pdf$/i, "") + "-certificate.pdf");
        } catch (certErr) {
          console.error(certErr);
          toast("The PDF was redacted, but the certificate could not be written.", "bad");
        }
      }
      toast(rep.ok ? "Redacted file ready — leak check passed." : "Exported, but the leak check found text. See the report.", rep.ok ? "good" : "bad");
    } catch (err) {
      console.error(err);
      toast("Export failed: " + err.message, "bad");
    } finally {
      S.busy = false;
      $("exportBtn").disabled = false;
      $("exportBtn").textContent = "Redact & download";
      void t0;
    }
  });

  /* ---------------- boot ---------------- */
  /* Batch: redact and download every loaded file with the current settings. */
  async function exportAll() {
    if (!pro()) { openLicense(); return; }
    if (S.files.length < 2) { toast("Load more than one file to use batch."); return; }
    if (S.busy) return;
    const dpi = parseInt($("dpi").value, 10) || 150;
    const opts = { dpi, flattenAll: $("flattenAll").checked, fill: $("fill").value, label: $("labelText").value.trim() };
    S.busy = true;
    $("exportAllBtn").disabled = true;
    $("exportBtn").disabled = true;
    let okCount = 0;
    const failures = [];
    try {
      for (let i = 0; i < S.files.length; i++) {
        const f = S.files[i];
        $("exportAllBtn").textContent = "Batch " + (i + 1) + "/" + S.files.length + " — " + f.name;
        try {
          if (boxCount(f) === 0) await detectFor(f);
          const out = await exportOne(f, opts);
          download(out, outName(f.name));
          const rep = await E.verifyOutput(out, termList(f));
          if (rep.ok) okCount++;
          else failures.push(f.name + " (" + rep.hits.length + " leftover terms)");
          await new Promise((r) => setTimeout(r, 350));
        } catch (err) {
          failures.push(f.name + " (" + err.message + ")");
        }
      }
      toast(failures.length
        ? okCount + " of " + S.files.length + " files passed the leak check. Check: " + failures.join("; ")
        : okCount + " files redacted and downloaded. All passed the leak check.", failures.length ? "bad" : "good");
    } finally {
      S.busy = false;
      $("exportAllBtn").disabled = false;
      $("exportBtn").disabled = false;
      $("exportAllBtn").textContent = "Redact all " + S.files.length + " files";
      renderFileList();
    }
  }
  $("exportAllBtn").addEventListener("click", exportAll);

  function syncBatchButton() {
    const b = $("exportAllBtn");
    if (!b) return;
    b.hidden = !(pro() && S.files.length > 1);
    b.textContent = "Redact all " + S.files.length + " files";
  }

  syncPlanUI();
  L.onChange(syncPlanUI);
  L.refreshIfStale();
  renderFileList();
  resetCanvas();

  // expose a tiny surface for automated checks
  window.Blot.app = {
    state: S,
    addFiles,
    detectFor,
    loadUrl: async (url, name) => {
      const res = await fetch(url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const doc = await E.loadPdf(bytes);
      S.files.push({ id: Math.random().toString(36).slice(2), name: name || "sample.pdf", bytes, doc, pages: doc.numPages, boxes: new Map() });
      await setActive(S.files.length - 1);
      return doc.numPages;
    }
  };
})();
