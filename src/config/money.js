// Money is stored as Int kobo everywhere (Paystack's own unit), never
// float, to avoid rounding drift.
function nairaToKobo(naira) {
  return Math.round(Number(naira) * 100);
}

function koboToNaira(kobo) {
  return Math.round(Number(kobo)) / 100;
}

function commissionPercent() {
  const n = Number(process.env.PLATFORM_COMMISSION_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 10;
}

module.exports = { nairaToKobo, koboToNaira, commissionPercent };
