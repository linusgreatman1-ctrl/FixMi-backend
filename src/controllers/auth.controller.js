const crypto = require("crypto");
const prisma = require("../config/db");
const { hashPassword, comparePassword, isStrongPassword } = require("../utils/password");
const { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } = require("../utils/jwt");
const { notifyAllAdmins } = require("../services/notifications.service");

const REFRESH_COOKIE_NAME = "fixme_refresh";

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function issueSession(res, user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return { accessToken, refreshToken };
}

// Every account gets a Wallet + default NotificationPreference regardless
// of role — customers hold escrow refunds/change there too, not just
// artisans.
function baseCreateData({ name, email, phone, passwordHash, role, address, state, lga, bankName, bankAccountNumber, bankAccountName, isGuest }) {
  return {
    name,
    email: email || null,
    phone: phone || null,
    passwordHash: passwordHash || null,
    isGuest: !!isGuest,
    role,
    address: address || null,
    state: state || null,
    lga: lga || null,
    bankName: bankName || null,
    bankAccountNumber: bankAccountNumber || null,
    bankAccountName: bankAccountName || null,
    wallet: { create: {} },
    notificationPref: { create: {} },
  };
}

async function register(req, res, next) {
  try {
    const {
      name,
      email,
      phone,
      password,
      role = "CUSTOMER",
      address,
      state,
      lga,
      bankName,
      bankAccountNumber,
      bankAccountName,
      // ARTISAN-only
      category,
      bizName,
      bio,
      yearsExp,
      idType,
      idNumber,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required." });
    }
    if (!email && !phone) {
      return res.status(400).json({ error: "Email or phone is required." });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (!["CUSTOMER", "ARTISAN"].includes(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }
    if (role === "ARTISAN") {
      if (!category || !category.trim()) {
        return res.status(400).json({ error: "A service category is required for artisan accounts." });
      }
      const ID_TYPES = ["NIN", "DRIVERS_LICENSE", "INTL_PASSPORT", "VOTERS_CARD"];
      if (!ID_TYPES.includes(idType)) {
        return res.status(400).json({ error: "Select which ID type you're providing (NIN, Driver's License, Int'l Passport, or Voter's Card)." });
      }
      if (!idNumber || !String(idNumber).trim()) {
        return res.status(400).json({ error: "Enter your ID number." });
      }
    }

    if (email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return res.status(409).json({ error: "An account with this email already exists." });
    }
    if (phone) {
      const existing = await prisma.user.findUnique({ where: { phone } });
      if (existing) return res.status(409).json({ error: "An account with this phone number already exists." });
    }

    const passwordHash = await hashPassword(password);
    const data = baseCreateData({ name, email, phone, passwordHash, role, address, state, lga, bankName, bankAccountNumber, bankAccountName });

    if (role === "ARTISAN") {
      data.artisanProfile = {
        create: {
          category: category.trim(),
          bizName: bizName || null,
          bio: bio || null,
          yearsExp: yearsExp ? Number(yearsExp) : null,
          idType,
          idNumber: String(idNumber).trim(),
          kycStatus: "PENDING",
        },
      };
    }

    const user = await prisma.user.create({
      data,
      include: { artisanProfile: true, wallet: true },
    });

    if (role === "ARTISAN") {
      notifyAllAdmins(req.app.get("io"), "🪪 New artisan sign-up", `${user.name} (${category}) is awaiting verification.`, { userId: user.id }).catch(() => {});
    }

    const { accessToken, refreshToken } = await issueSession(res, user);
    res.status(201).json({ user: publicUser(user), accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, phone, password } = req.body;
    if ((!email && !phone) || !password) {
      return res.status(400).json({ error: "Email/phone and password are required." });
    }

    const user = await prisma.user.findFirst({
      where: email ? { email } : { phone },
      include: { artisanProfile: true, wallet: true },
    });

    if (!user || !user.passwordHash || !(await comparePassword(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    if (user.status !== "ACTIVE") {
      return res.status(403).json({ error: "This account is not active." });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    // An artisan who closes their tab without explicitly going offline
    // stays "available" in the database indefinitely — every fresh login
    // starts genuinely offline; going online again is always an explicit
    // action (matches the frontend's availability toggle).
    if (user.artisanProfile && user.artisanProfile.isAvailable) {
      await prisma.artisanProfile.update({ where: { id: user.artisanProfile.id }, data: { isAvailable: false } });
      user.artisanProfile.isAvailable = false;
    }

    const { accessToken, refreshToken } = await issueSession(res, user);
    res.json({ user: publicUser(user), accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
}

// Lets a customer browse without registering, matching the frontend's
// "Continue as Guest" button. Guest accounts are CUSTOMER-role, have no
// password.
async function guestLogin(req, res, next) {
  try {
    const guestTag = crypto.randomBytes(4).toString("hex");
    const user = await prisma.user.create({
      data: {
        name: "Guest",
        isGuest: true,
        role: "CUSTOMER",
        wallet: { create: {} },
        notificationPref: { create: {} },
      },
    });
    const { accessToken, refreshToken } = await issueSession(res, user);
    res.status(201).json({ user: publicUser(user), accessToken, refreshToken, guestTag });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const token = req.body?.refreshToken;
    if (!token) return res.status(401).json({ error: "No refresh token." });

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired refresh token." });
    }

    const tokenHash = hashToken(token);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: "Invalid or expired refresh token." });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { artisanProfile: true },
    });
    if (!user || user.status !== "ACTIVE") {
      return res.status(401).json({ error: "Account is not active." });
    }

    // Rotate: revoke the used refresh token, issue a fresh pair.
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked: true } });
    const { accessToken, refreshToken } = await issueSession(res, user);
    res.json({ user: publicUser(user), accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const token = req.body?.refreshToken;
    if (token) {
      await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token) }, data: { revoked: true } });
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { artisanProfile: true, wallet: true, notificationPref: true },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, guestLogin, refresh, logout, me };
