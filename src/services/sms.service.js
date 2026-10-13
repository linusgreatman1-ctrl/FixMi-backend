// Africa's Talking SMS. Optional: when AFRICASTALKING_API_KEY / AFRICASTALKING_USERNAME
// are not set, isConfigured() is false and callers skip sending instead of failing.
const SMS_URL = "https://api.africastalking.com/version1/messaging";

function isConfigured() {
  return !!(process.env.AFRICASTALKING_API_KEY && process.env.AFRICASTALKING_USERNAME);
}

// Normalises Nigerian numbers to E.164 (08012345678 -> +2348012345678).
function toE164(phone) {
  const p = String(phone).replace(/[\s-]/g, "");
  if (p.startsWith("+")) return p;
  if (p.startsWith("234")) return "+" + p;
  if (p.startsWith("0")) return "+234" + p.slice(1);
  return "+" + p;
}

async function sendSms(toPhone, message) {
  if (!isConfigured()) {
    const err = new Error("SMS is not configured.");
    err.status = 503;
    throw err;
  }
  const body = { username: process.env.AFRICASTALKING_USERNAME, to: toE164(toPhone), message };
  if (process.env.AFRICASTALKING_SENDER_ID) body.from = process.env.AFRICASTALKING_SENDER_ID;
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(SMS_URL, {
    method: "POST",
    headers: { apiKey: process.env.AFRICASTALKING_API_KEY, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(raw.trim() || "SMS request failed.");
  }
  if (!res.ok) throw new Error(json.SMSMessageData?.Message || "SMS request failed.");
  const recipient = json.SMSMessageData?.Recipients?.[0];
  if (recipient && recipient.status !== "Success") throw new Error(`SMS not delivered: ${recipient.status}`);
  return json;
}

module.exports = { isConfigured, sendSms, toE164 };
