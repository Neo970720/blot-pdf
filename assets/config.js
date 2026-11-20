/* Blot configuration — the only file to edit before going live.
 *
 * 1) siteUrl is the final public URL (GitHub Pages project page).
 * 2) Polar: organization id, the two checkout links and the product ids.
 *    Both products grant the "License Keys" benefit (prefix BLOT, 3 devices).
 * 3) demo.enabled is false in production: only real Polar licence keys unlock Pro.
 */
window.BLOT_CONFIG = {
  siteUrl: "https://neo970720.github.io/blot-pdf",
  version: "1.0.0",
  polar: {
    // Polar organization id (Settings → Organization). Needed for public license validation.
    orgId: "a4052b9a-6301-400e-abc8-523c0c6839c4",
    // Public, unauthenticated validation endpoint (safe in a static client).
    validateUrl: "https://api.polar.sh/v1/customer-portal/license-keys/validate",
    // Checkout links copied from the Polar dashboard.
    checkoutMonthly: "https://buy.polar.sh/polar_cl_WEDHiBUDwyL8z4D8UMXn42iREPhzHDnYHRNow2HJiP9",
    checkoutLifetime: "https://buy.polar.sh/polar_cl_3XKhbTjbFHrwM4fdpoNtjATTSzXf3gLc5hqR34OFeDT",
    productMonthlyId: "0a3c08a4-ee3d-4379-8d8e-88067abbef13",
    productLifetimeId: "ff8dce45-c344-4ff9-92b3-300a2f603f79"
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
  // Re-check a stored Polar key at most this often (days) when online.
  revalidateDays: 7
};
