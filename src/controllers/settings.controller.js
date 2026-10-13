const prisma = require("../config/db");
const { comparePassword } = require("../utils/password");

const PREF_FIELDS = ["pushEnabled", "emailEnabled", "smsEnabled", "marketingEnabled"];
const ADDRESS_ORDER = [{ isDefault: "desc" }, { createdAt: "desc" }];

async function getSettings(req, res, next) {
  try {
    const [pref, addresses, contacts] = await Promise.all([
      prisma.notificationPreference.findUnique({ where: { userId: req.user.id } }),
      prisma.savedAddress.findMany({ where: { userId: req.user.id }, orderBy: ADDRESS_ORDER }),
      prisma.emergencyContact.findMany({ where: { userId: req.user.id } }),
    ]);
    res.json({
      notifications: {
        pushEnabled: pref?.pushEnabled ?? true,
        emailEnabled: pref?.emailEnabled ?? true,
        smsEnabled: pref?.smsEnabled ?? false,
        marketingEnabled: pref?.marketingEnabled ?? true,
      },
      addresses,
      emergencyContacts: contacts,
    });
  } catch (err) {
    next(err);
  }
}

async function updateNotificationPrefs(req, res, next) {
  try {
    const data = {};
    for (const k of PREF_FIELDS) if (typeof req.body[k] === "boolean") data[k] = req.body[k];
    const pref = await prisma.notificationPreference.upsert({ where: { userId: req.user.id }, update: data, create: { userId: req.user.id, ...data } });
    res.json({ notifications: pref });
  } catch (err) {
    next(err);
  }
}

async function listAddresses(req, res, next) {
  try {
    res.json({ addresses: await prisma.savedAddress.findMany({ where: { userId: req.user.id }, orderBy: ADDRESS_ORDER }) });
  } catch (err) {
    next(err);
  }
}

async function addAddress(req, res, next) {
  try {
    const { label, address, state, lga, lat, lng, isDefault } = req.body;
    if (!label || !address) return res.status(400).json({ error: "label and address are required." });
    const count = await prisma.savedAddress.count({ where: { userId: req.user.id } });
    if (count >= 10) return res.status(400).json({ error: "You can save up to 10 addresses." });
    const makeDefault = !!isDefault || count === 0;
    const created = await prisma.$transaction(async (tx) => {
      if (makeDefault) await tx.savedAddress.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
      return tx.savedAddress.create({
        data: { userId: req.user.id, label: String(label).slice(0, 40), address: String(address).slice(0, 300), state: state || null, lga: lga || null, lat: lat ?? null, lng: lng ?? null, isDefault: makeDefault },
      });
    });
    res.status(201).json({ address: created });
  } catch (err) {
    next(err);
  }
}

async function updateAddress(req, res, next) {
  try {
    const existing = await prisma.savedAddress.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.user.id) return res.status(404).json({ error: "Address not found." });
    const { label, address, state, lga, lat, lng, isDefault } = req.body;
    const updated = await prisma.$transaction(async (tx) => {
      if (isDefault === true) await tx.savedAddress.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
      return tx.savedAddress.update({
        where: { id: existing.id },
        data: {
          ...(label !== undefined && { label: String(label).slice(0, 40) }),
          ...(address !== undefined && { address: String(address).slice(0, 300) }),
          ...(state !== undefined && { state }),
          ...(lga !== undefined && { lga }),
          ...(lat !== undefined && { lat }),
          ...(lng !== undefined && { lng }),
          ...(isDefault === true && { isDefault: true }),
        },
      });
    });
    res.json({ address: updated });
  } catch (err) {
    next(err);
  }
}

async function deleteAddress(req, res, next) {
  try {
    const existing = await prisma.savedAddress.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.user.id) return res.status(404).json({ error: "Address not found." });
    await prisma.savedAddress.delete({ where: { id: existing.id } });
    if (existing.isDefault) {
      const replacement = await prisma.savedAddress.findFirst({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
      if (replacement) await prisma.savedAddress.update({ where: { id: replacement.id }, data: { isDefault: true } });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// Closes the account: suspends it and revokes sessions. Refused while a job or
// wallet money is in flight so escrow is never orphaned.
async function deactivateAccount(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { wallet: true } });
    if (user.passwordHash) {
      if (!req.body.password || !(await comparePassword(req.body.password, user.passwordHash))) {
        return res.status(401).json({ error: "Password is incorrect." });
      }
    }
    const artisanId = req.user.artisanProfile?.id;
    const open = await prisma.booking.count({
      where: {
        status: { in: ["REQUESTED", "ACCEPTED", "PAID", "IN_PROGRESS", "COMPLETED", "DISPUTED"] },
        OR: [{ customerId: user.id }, ...(artisanId ? [{ artisanId }] : [])],
      },
    });
    if (open > 0) return res.status(409).json({ error: "Finish or cancel your open jobs before closing your account." });
    if (user.wallet && user.wallet.balanceKobo > 0) return res.status(409).json({ error: "Withdraw your wallet balance before closing your account." });
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } }),
      prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } }),
      ...(artisanId ? [prisma.artisanProfile.update({ where: { id: artisanId }, data: { isAvailable: false } })] : []),
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateNotificationPrefs, listAddresses, addAddress, updateAddress, deleteAddress, deactivateAccount };
