/* Blot licence handling.
 * Free: no key, no account, works forever.
 * Pro:  a Gumroad licence key. Validated against Gumroad's public licence
 *       endpoint (POST /v2/licenses/verify — no secret, no OAuth, CORS open)
 *       and then cached locally so the app keeps working offline.
 */
(function () {
  "use strict";

  const CFG = window.BLOT_CONFIG;
  const STORE = "blot.license.v1";
  const listeners = new Set();

  function read() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return { tier: "free" };
      const s = JSON.parse(raw);
      if (!s || !s.key) return { tier: "free" };
      return s;
    } catch (e) {
      return { tier: "free" };
    }
  }

  function write(state) {
    try {
      if (!state || !state.key) localStorage.removeItem(STORE);
      else localStorage.setItem(STORE, JSON.stringify(state));
    } catch (e) { /* private mode */ }
    listeners.forEach((cb) => { try { cb(state); } catch (e) {} });
  }

  function isPro() {
    const s = read();
    return s.tier === "pro" ? s : null;
  }

  function normalize(key) {
    let k = String(key || "").trim().toUpperCase().replace(/[\s_]+/g, "");
    if (/^[A-Z0-9]{32}$/.test(k)) k = k.replace(/(.{8})(.{8})(.{8})(.{8})/, "$1-$2-$3-$4");
    return k;
  }

  async function validateWithGumroad(key, countUse) {
    const body = new URLSearchParams({
      product_id: CFG.gumroad.productId,
      license_key: key,
      increment_uses_count: countUse ? "true" : "false"
    });
    const res = await fetch(CFG.gumroad.verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (res.status === 404) {
      return { ok: false, message: "That key was not found for Blot Pro. Check for typos, or copy the key from your Gumroad receipt." };
    }
    if (!res.ok) {
      return { ok: false, message: "Could not reach the licence server (HTTP " + res.status + "). Try again in a moment." };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!data || data.success !== true) {
      return { ok: false, message: "This key is not active right now. If you have just bought it, try again in a minute." };
    }
    const purchase = data.purchase || {};
    if (purchase.refunded || purchase.chargebacked || purchase.dispute_won) {
      return { ok: false, message: "This purchase was refunded or reversed, so the key is no longer active." };
    }
    return { ok: true, data: data };
  }

  async function activate(inputKey) {
    const key = normalize(inputKey);
    if (!key) return { ok: false, message: "Enter your licence key." };

    if (CFG.demo.enabled && CFG.demo.keys.map(normalize).includes(key)) {
      write({ tier: "pro", key, source: "demo", plan: "demo", since: new Date().toISOString(), checked: Date.now() });
      return { ok: true, message: "Demo licence active on this browser." };
    }

    if (!CFG.gumroad.productId) {
      return { ok: false, message: "Licence checks are not configured in this build yet." };
    }

    try {
      const result = await validateWithGumroad(key, true);
      if (!result.ok) return result;
      write({ tier: "pro", key, source: "gumroad", plan: "lifetime", since: new Date().toISOString(), checked: Date.now() });
      return { ok: true, message: "Licence verified. Pro is unlocked on this browser." };
    } catch (e) {
      return { ok: false, message: "Could not reach the licence server. Check your connection and try again." };
    }
  }

  /* Re-check a stored Gumroad key in the background now and then; offline keeps working. */
  async function refreshIfStale() {
    const s = read();
    if (s.tier !== "pro" || s.source !== "gumroad" || !CFG.gumroad.productId) return;
    const age = Date.now() - (s.checked || 0);
    if (age < (CFG.revalidateDays || 7) * 86400000) return;
    try {
      const r = await validateWithGumroad(s.key, false);
      if (r.ok) write(Object.assign({}, s, { checked: Date.now() }));
    } catch (e) { /* stay offline-friendly */ }
  }

  function deactivate() {
    write({ tier: "free" });
  }

  function checkoutUrl() {
    return (CFG.gumroad && CFG.gumroad.checkoutUrl) || "";
  }

  function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

  window.Blot = window.Blot || {};
  window.Blot.license = { read, isPro, activate, deactivate, checkoutUrl, onChange, refreshIfStale };
})();
