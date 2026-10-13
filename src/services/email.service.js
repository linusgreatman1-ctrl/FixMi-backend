// Optional SMTP email (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS, EMAIL_FROM).
// isConfigured() is false until those are set, and callers skip sending.
const nodemailer = require("nodemailer");

let transport = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (transport) return transport;
  const port = parseInt(process.env.SMTP_PORT, 10);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

async function sendEmail(to, subject, text, html) {
  if (!isConfigured()) throw Object.assign(new Error("Email is not configured."), { status: 503 });
  await getTransport().sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, text, html: html || undefined });
}

module.exports = { isConfigured, sendEmail };
