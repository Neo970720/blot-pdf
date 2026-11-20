/* Blot configuration — the only file to edit before going live.
 *
 * 1) siteUrl is the final public URL (GitHub Pages project page).
 * 2) Gumroad: one product, one price — $29 lifetime. `productId` is what the
 *    app sends to the licence API; `checkoutUrl` is the product page buyers open.
 *    The verify endpoint is Gumroad's public licence API: no secret, no OAuth,
 *    and it answers with Access-Control-Allow-Origin: * so the browser can call it.
 * 3) demo.enabled is false in production: only real Gumroad licence keys unlock Pro.
 */
window.BLOT_CONFIG = {
  siteUrl: "https://neo970720.github.io/blot-pdf",
  version: "1.0.2",
  gumroad: {
    productId: "vBIqiEzX8LLEDnruwMNezw==",
    checkoutUrl: "https://sheetwrightstudio.gumroad.com/l/blot-pro",
    verifyUrl: "https://api.gumroad.com/v2/licenses/verify"
  },
  demo: {
    enabled: false,
    keys: [],
    label: "Demo licence — Pro unlocked locally for evaluation"
  },
  limits: {
    freePages: 10,
    freeDpi: 150,
    proDpi: 300,
    batchFiles: 20
  },
  // Re-check a stored licence at most this often (days) when online.
  revalidateDays: 7
};
