const prisma = require("../config/db");
const paystack = require("../services/paystack.service");

function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function updateMe(req, res, next) {
  try {
    const { name, address, state, lga } = req.body;
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        name: name ?? undefined,
        address: address ?? undefined,
        state: state ?? undefined,
        lga: lga ?? undefined,
      },
      include: { artisanProfile: true, wallet: true },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

async function updateArtisanProfile(req, res, next) {
  try {
    if (!req.user.artisanProfile) return res.status(403).json({ error: "No artisan profile found." });
    const { category, bizName, bio, yearsExp, lat, lng } = req.body;
    const profile = await prisma.artisanProfile.update({
      where: { id: req.user.artisanProfile.id },
      data: {
        category: category ?? undefined,
        bizName: bizName ?? undefined,
        bio: bio ?? undefined,
        yearsExp: yearsExp !== undefined ? Number(yearsExp) : undefined,
        lat: lat !== undefined ? Number(lat) : undefined,
        lng: lng !== undefined ? Number(lng) : undefined,
      },
    });
    res.json({ artisanProfile: profile });
  } catch (err) {
    next(err);
  }
}

// Matches the frontend's availability toggle — an artisan must be online to
// show up in nearby search / receive new job dispatch.
async function setAvailability(req, res, next) {
  try {
    if (!req.user.artisanProfile) return res.status(403).json({ error: "No artisan profile found." });
    const { isAvailable } = req.body;
    const profile = await prisma.artisanProfile.update({
      where: { id: req.user.artisanProfile.id },
      data: { isAvailable: !!isAvailable },
    });
    res.json({ artisanProfile: profile });
  } catch (err) {
    next(err);
  }
}

async function uploadAvatar(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { avatarUrl: `/uploads/${req.file.filename}` },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

// Verifies the account name behind a bank account number via Paystack
// before it's saved, so withdrawals never get typo'd into someone else's
// account.
async function linkBankAccount(req, res, next) {
  try {
    const { bankName, bankCode, bankAccountNumber } = req.body;
    if (!bankCode || !bankAccountNumber) {
      return res.status(400).json({ error: "Bank code and account number are required." });
    }
    const resolved = await paystack.resolveBankAccount(bankAccountNumber, bankCode);
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { bankName, bankAccountNumber, bankAccountName: resolved.account_name },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

async function listBanks(req, res, next) {
  try {
    const banks = await paystack.listBanks();
    res.json({ banks });
  } catch (err) {
    next(err);
  }
}

module.exports = { updateMe, updateArtisanProfile, setAvailability, uploadAvatar, linkBankAccount, listBanks };
