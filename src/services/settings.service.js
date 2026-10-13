const prisma = require("../config/db");
const content = require("../config/defaultContent.json");
const { PLANS: CORPORATE_PLANS } = require("./corporate.service");

// Everything the app shows that an admin may want to change without a deploy.
// A saved AppSetting row wins; otherwise the default below is used.
const DEFAULTS = {
  services: { value: content.services, category: "catalogue", description: "Services customers can book: [{name, icon, bg, label}]", type: "array" },
  "faqs.customer": { value: content.faqs_customer, category: "help", description: "Customer Help & Support FAQs: [{q, a}] (a may contain basic HTML)", type: "array" },
  "faqs.artisan": { value: content.faqs_artisan, category: "help", description: "Artisan Help & Support FAQs: [{q, a}]", type: "array" },
  "safety.customer": { value: content.safety_customer, category: "safety", description: "Customer safety guidelines: [{q, a}]", type: "array" },
  "safety.artisan": { value: content.safety_artisan, category: "safety", description: "Artisan safety guidelines: [{q, a}]", type: "array" },
  "promotion.plans": {
    value: {
      basic: { label: "Basic Boost", days: 7, priceKobo: 150000 },
      standard: { label: "Standard Boost", days: 30, priceKobo: 450000 },
      vip: { label: "VIP Annual", days: 365, priceKobo: 4000000 },
    },
    category: "pricing",
    description: "Promote My Page packages: {key: {label, days, priceKobo}}",
    type: "object",
  },
  "corporate.plans": { value: CORPORATE_PLANS, category: "pricing", description: "Corporate plans: {key: {label, priceKobo, period, days, callsTotal, maxCategories}}", type: "object" },
  support: { value: { phone: "", email: "", whatsapp: "", hours: "" }, category: "contact", description: "Support contact details shown in the app", type: "object" },
  banner: { value: { enabled: false, text: "", tone: "info" }, category: "home", description: "Notice bar on the home screen: {enabled, text, tone}", type: "object" },
  maintenance: { value: { enabled: false, message: "FixMi is being updated. Please try again shortly." }, category: "system", description: "Maintenance mode message", type: "object" },
};

let cache = null;
let cachedAt = 0;
const TTL_MS = 20 * 1000;

async function loadAll() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const rows = await prisma.appSetting.findMany();
  const map = {};
  for (const r of rows) map[r.key] = r;
  cache = map;
  cachedAt = Date.now();
  return map;
}

function invalidate() {
  cache = null;
}

async function get(key) {
  const rows = await loadAll();
  if (rows[key] && rows[key].value != null) return rows[key].value;
  return DEFAULTS[key] ? DEFAULTS[key].value : undefined;
}

function isValid(key, value) {
  const def = DEFAULTS[key];
  if (!def) return false;
  if (def.type === "array") return Array.isArray(value);
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function set(key, value, userId) {
  if (!isValid(key, value)) throw Object.assign(new Error(`Invalid value for "${key}": expected ${DEFAULTS[key]?.type || "a known setting"}.`), { status: 400 });
  const def = DEFAULTS[key];
  const row = await prisma.appSetting.upsert({
    where: { key },
    update: { value, updatedById: userId || null },
    create: { key, value, category: def.category, description: def.description, updatedById: userId || null },
  });
  invalidate();
  return row;
}

async function reset(key) {
  if (!DEFAULTS[key]) throw Object.assign(new Error("Unknown setting."), { status: 404 });
  await prisma.appSetting.deleteMany({ where: { key } });
  invalidate();
}

// For the admin editor: every known setting with its current value and whether it was customised.
async function listForAdmin() {
  const rows = await loadAll();
  return Object.entries(DEFAULTS).map(([key, def]) => ({
    key,
    category: def.category,
    description: def.description,
    type: def.type,
    customised: !!rows[key],
    updatedAt: rows[key]?.updatedAt || null,
    value: rows[key] ? rows[key].value : def.value,
    defaultValue: def.value,
  }));
}

// What GET /api/config/app serves to the app.
async function publicContent() {
  const [services, faqsC, faqsA, safetyC, safetyA, promo, corp, support, banner, maintenance] = await Promise.all([
    get("services"), get("faqs.customer"), get("faqs.artisan"), get("safety.customer"), get("safety.artisan"),
    get("promotion.plans"), get("corporate.plans"), get("support"), get("banner"), get("maintenance"),
  ]);
  return {
    services,
    faqs: { customer: faqsC, artisan: faqsA },
    safety: { customer: safetyC, artisan: safetyA },
    promotionPlans: promo,
    corporatePlans: corp,
    support,
    banner,
    maintenance,
  };
}

module.exports = { DEFAULTS, get, set, reset, listForAdmin, publicContent };
