// Thin wrapper around the Flutterwave v3 API: the second card/USSD gateway next
// to Paystack (paymentGateway.service.js picks between them). Needs
// FLW_SECRET_KEY; without it callers get a clear error, never a fake success.
// Amounts in and out of this file are KOBO; Flutterwave itself uses naira.
const FLW_BASE = process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3";

function isConfigured() {
  return !!process.env.FLW_SECRET_KEY;
}

function requireKey() {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw Object.assign(new Error("FLW_SECRET_KEY is not configured."), { status: 503 });
  return key;
}

async function flwFetch(path, options = {}) {
  const key = requireKey();
  const fetch = (await import("node-fetch")).default;
  let res;
  try {
    res = await fetch(`${FLW_BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  } catch (netErr) {
    throw Object.assign(new Error("Couldn't reach Flutterwave right now. Please try again or choose another payment method."), { status: 502 });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === "error") {
    throw Object.assign(new Error(json.message || "Flutterwave request failed."), { status: res.status >= 400 && res.status < 500 ? 400 : 502 });
  }
  return json.data;
}

// Hosted checkout -> { authorization_url, reference }.
async function initializeTransaction({ email, amountKobo, reference, metadata, channel, callbackUrl }) {
  const data = await flwFetch("/payments", {
    method: "POST",
    body: JSON.stringify({
      tx_ref: reference,
      amount: Math.round(amountKobo) / 100,
      currency: "NGN",
      redirect_url: callbackUrl,
      payment_options: channel === "ussd" ? "ussd" : "card,ussd,banktransfer",
      customer: { email: email || "customer@fixmi.app" },
      meta: { purpose: metadata && metadata.purpose },
      customizations: { title: "FixMi", description: "Secure payment into FixMi escrow" },
    }),
  });
  return { authorization_url: data.link, reference };
}

// -> { status: "success" | "pending" | other, amountKobo, currency, reference }
async function verifyTransaction(reference) {
  let data;
  try {
    data = await flwFetch(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, { method: "GET" });
  } catch (err) {
    if (err.status === 503) throw err;
    return { status: "pending", amountKobo: 0, currency: null, reference }; // not started or not found yet
  }
  const ok = data && data.status === "successful";
  return { status: ok ? "success" : (data && data.status) || "pending", amountKobo: Math.round(Number(data && data.amount) * 100) || 0, currency: data && data.currency, reference };
}

module.exports = { isConfigured, initializeTransaction, verifyTransaction };
