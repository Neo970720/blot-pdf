/* Blot licence handling.
 * Free: no key, no account, works forever.
 * Pro:  a Polar license key. Validated against Polar's public customer-portal
 *       endpoint (no secret in the client) and cached locally so the app keeps
 *       working offline. While BLOT_CONFIG.polar.orgId is empty, demo keys
 *       unlock Pro locally so the whole purchase flow can be reviewed.
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

  function normalize(key) { return String(key || "").trim().toUpperCase(); }

  async function validateWithPolar(key) {
    const url = CFG.polar.validateUrl;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, organization_id: CFG.polar.orgId })
    });
    if (res.status === 404) return { ok: false, message: "That key was not found. Check for typos, or use the link in your purchase email." };
    if (!res.ok) return { ok: false, message: "Could not reach the licence server (HTTP " + res.status + "). Try again in a moment." };
    const data = await res.json();
    const status = (data && (data.status || (data.license_key && data.license_key.status))) || "";
    if (status === "granted") return { ok: true, data };
    if (status === "revoked") return { ok: false, message: "This key was revoked. If your subscription ended, renew it to restore Pro." };
    return { ok: false, message: "This key is not active right now (status: " + (status || "unknown") + ")." };
  }

  async function activate(inputKey) {
    const key = normalize(inputKey);
    if (!key) return { ok: false, message: "Enter your licence key." };

    if (CFG.demo.enabled && CFG.demo.keys.map(normalize).includes(key)) {
      write({ tier: "pro", key, source: "demo", plan: "demo", since: new Date().toISOString(), checked: Date.now() });
      return { ok: true, message: "Demo licence active on this browser." };
    }

    if (!CFG.polar.orgId) {
      return { ok: false, message: "Online licence checks are not switched on for this build yet. Only demo keys work here." };
    }

    try {
      const result = await validateWithPolar(key);
      if (!result.ok) return result;
      const plan = String(key).length > 20 ? "polar" : "polar";
      write({ tier: "pro", key, source: "polar", plan, since: new Date().toISOString(), checked: Date.now() });
      return { ok: true, message: "Licence verified. Pro unlocked on this browser." };
    } catch (e) {
      return { ok: false, message: "Could not reach the licence server. Check your connection and try again." };
    }
  }

  /* Re-check a Polar key in the background now and then; offline keeps working. */
  async function refreshIfStale() {
    const s = read();
    if (s.tier !== "pro" || s.source !== "polar" || !CFG.polar.orgId) return;
    const age = Date.now() - (s.checked || 0);
    if (age < (CFG.revalidateDays || 7) * 86400000) return;
    try {
      const r = await validateWithPolar(s.key);
      if (r.ok) write(Object.assign({}, s, { checked: Date.now() }));
    } catch (e) { /* stay offline-friendly */ }
  }

  function deactivate() {
    write({ tier: "free" });
  }

  function checkoutUrl(plan) {
    const p = plan === "lifetime" ? CFG.polar.checkoutLifetime : CFG.polar.checkoutMonthly;
    return p || "";
  }

  function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

  window.Blot = window.Blot || {};
  window.Blot.license = { read, isPro, activate, deactivate, checkoutUrl, onChange, refreshIfStale };
})();
