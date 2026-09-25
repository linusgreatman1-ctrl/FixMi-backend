require("dotenv").config();

const express = require("express");
const http = require("http");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");

const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const { attachLiveSocket } = require("./realtime/live");

const authRoutes = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const artisansRoutes = require("./routes/artisans.routes");
const searchRoutes = require("./routes/search.routes");
const bookingsRoutes = require("./routes/bookings.routes");
const walletRoutes = require("./routes/wallet.routes");
const paymentsRoutes = require("./routes/payments.routes");
const ratingsRoutes = require("./routes/ratings.routes");
const supportRoutes = require("./routes/support.routes");
const notificationsRoutes = require("./routes/notifications.routes");
const chatRoutes = require("./routes/chat.routes");
const adminRoutes = require("./routes/admin.routes");

const app = express();

// The web app at /app is a single static HTML file with its logic in an
// inline <script> block (no build step) — 'unsafe-inline' on script-src is
// what lets that run at all under helmet's default CSP. helmet's default
// directives set script-src-attr to 'none' SEPARATELY from script-src, so
// it needs its own allowance too or every onclick="..." handler is inert.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "'unsafe-inline'", "https://js.paystack.co", "https://cdn.socket.io"],
        "script-src-attr": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
        "frame-src": ["'self'", "https://*.paystack.co", "https://*.paystack.com"],
        "connect-src": ["'self'", "https://*.paystack.co", "https://*.paystack.com", "ws:", "wss:"],
        "img-src": ["'self'", "data:", "blob:"],
      },
    },
  })
);

const allowedOrigins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));

app.use(compression());
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Captures the raw request body alongside the parsed one so
// payments.controller.webhook can verify Paystack's HMAC-SHA512 signature
// (computed over the exact raw bytes, not a re-serialized JSON.stringify
// which can differ in key order/whitespace).
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use("/api", globalLimiter);

app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));
app.use("/app", express.static(path.join(__dirname, "..", "public", "app")));

app.get("/health", (req, res) => res.json({ status: "ok", service: "fixmi-backend" }));
app.get("/", (req, res) => res.json({ service: "fixmi-backend", status: "ok", app: "/app", health: "/health", api: "/api" }));

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/artisans", artisansRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/ratings", ratingsRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/admin", adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
const io = attachLiveSocket(server);
app.set("io", io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`FixMe backend listening on port ${PORT}`);
});

module.exports = { app, server };
