const prisma = require("../config/db");
const { notifyAllAdmins, notify } = require("../services/notifications.service");

const DOC_TYPES = ["GOVERNMENT_ID", "PROOF_OF_ADDRESS", "TRADE_CERTIFICATE"];
const ID_TYPES = ["NIN", "DRIVERS_LICENSE", "INTL_PASSPORT", "VOTERS_CARD"];
const REPORT_TYPES = ["SOS", "UNSAFE_BEHAVIOUR", "FRAUD", "HARASSMENT", "OTHER"];

// ---- Trust centre summary -------------------------------------------------

async function overview(req, res, next) {
  try {
    const [documents, contacts] = await Promise.all([
      prisma.kycDocument.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } }),
      prisma.emergencyContact.count({ where: { userId: req.user.id } }),
    ]);
    const idApproved = documents.some((d) => d.docType === "GOVERNMENT_ID" && d.status === "APPROVED");
    res.json({
      idVerified: idApproved || !!req.user.artisanProfile?.isVerified,
      kycStatus: req.user.artisanProfile?.kycStatus || null,
      documents,
      emergencyContactCount: contacts,
    });
  } catch (err) {
    next(err);
  }
}

// ---- KYC documents --------------------------------------------------------

async function uploadDocument(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No document uploaded." });
    const { docType, idType, idNumber } = req.body;
    if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: "Invalid document type." });
    if (docType === "GOVERNMENT_ID") {
      if (!ID_TYPES.includes(idType)) return res.status(400).json({ error: "Select the ID type (NIN, Driver's License, Int'l Passport or Voter's Card)." });
      if (!idNumber || !String(idNumber).trim()) return res.status(400).json({ error: "Enter the ID number." });
    }
    // Replaces any still-pending submission of the same type.
    await prisma.kycDocument.deleteMany({ where: { userId: req.user.id, docType, status: "PENDING" } });
    const document = await prisma.kycDocument.create({
      data: {
        userId: req.user.id,
        docType,
        idType: docType === "GOVERNMENT_ID" ? idType : null,
        idNumber: docType === "GOVERNMENT_ID" ? String(idNumber).trim() : null,
        fileUrl: `/uploads/${req.file.filename}`,
      },
    });
    if (req.user.artisanProfile && docType === "GOVERNMENT_ID") {
      await prisma.artisanProfile.update({ where: { id: req.user.artisanProfile.id }, data: { kycStatus: "PENDING", idType, idNumber: String(idNumber).trim() } });
    }
    notifyAllAdmins(req.app.get("io"), "🪪 New KYC document", `${req.user.name} submitted a ${docType.replace(/_/g, " ").toLowerCase()} for review.`, { kycDocumentId: document.id }).catch(() => {});
    res.status(201).json({ document });
  } catch (err) {
    next(err);
  }
}

async function deleteDocument(req, res, next) {
  try {
    const doc = await prisma.kycDocument.findUnique({ where: { id: req.params.id } });
    if (!doc || doc.userId !== req.user.id) return res.status(404).json({ error: "Document not found." });
    if (doc.status === "APPROVED") return res.status(409).json({ error: "Approved documents can only be replaced by an admin." });
    await prisma.kycDocument.delete({ where: { id: doc.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ---- Emergency contacts ---------------------------------------------------

async function listContacts(req, res, next) {
  try {
    res.json({ contacts: await prisma.emergencyContact.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "asc" } }) });
  } catch (err) {
    next(err);
  }
}

async function addContact(req, res, next) {
  try {
    const { name, phone, relationship } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "name and phone are required." });
    if (!/^\+?[0-9]{10,15}$/.test(String(phone).replace(/[\s-]/g, ""))) return res.status(400).json({ error: "Enter a valid phone number." });
    if ((await prisma.emergencyContact.count({ where: { userId: req.user.id } })) >= 5) return res.status(400).json({ error: "You can add up to 5 emergency contacts." });
    const contact = await prisma.emergencyContact.create({
      data: { userId: req.user.id, name: String(name).slice(0, 80), phone: String(phone).replace(/[\s-]/g, ""), relationship: relationship ? String(relationship).slice(0, 40) : null },
    });
    res.status(201).json({ contact });
  } catch (err) {
    next(err);
  }
}

async function deleteContact(req, res, next) {
  try {
    const { count } = await prisma.emergencyContact.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
    if (!count) return res.status(404).json({ error: "Contact not found." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ---- Reports and SOS ------------------------------------------------------

async function createReport(req, res, next) {
  try {
    const { type, bookingId, reportedUserId, description, lat, lng } = req.body;
    if (!REPORT_TYPES.includes(type)) return res.status(400).json({ error: "Invalid report type." });
    if (type !== "SOS" && !description) return res.status(400).json({ error: "Please describe what happened." });
    if (bookingId) {
      const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { artisan: { select: { userId: true } } } });
      if (!booking || (booking.customerId !== req.user.id && booking.artisan?.userId !== req.user.id)) {
        return res.status(403).json({ error: "You can only report your own jobs." });
      }
    }
    const report = await prisma.safetyReport.create({
      data: {
        reporterId: req.user.id,
        type,
        bookingId: bookingId || null,
        reportedUserId: reportedUserId || null,
        description: description ? String(description).slice(0, 2000) : null,
        lat: typeof lat === "number" ? lat : null,
        lng: typeof lng === "number" ? lng : null,
      },
    });
    const io = req.app.get("io");
    const isSos = type === "SOS";
    notifyAllAdmins(io, isSos ? "🚨 SOS alert" : "🛡️ Safety report", `${req.user.name}: ${isSos ? "needs urgent help" : description}`.slice(0, 200), { safetyReportId: report.id, bookingId: bookingId || null, lat: report.lat, lng: report.lng }).catch(() => {});
    if (isSos) io?.to("admins").emit("safety:sos", { reportId: report.id, reporter: req.user.name, lat: report.lat, lng: report.lng });
    const contacts = isSos ? await prisma.emergencyContact.findMany({ where: { userId: req.user.id }, select: { name: true, phone: true } }) : [];
    res.status(201).json({ report, emergencyContacts: contacts });
  } catch (err) {
    next(err);
  }
}

async function listMyReports(req, res, next) {
  try {
    res.json({ reports: await prisma.safetyReport.findMany({ where: { reporterId: req.user.id }, orderBy: { createdAt: "desc" } }) });
  } catch (err) {
    next(err);
  }
}

// ---- Admin ----------------------------------------------------------------

async function adminListDocuments(req, res, next) {
  try {
    const status = req.query.status || "PENDING";
    const documents = await prisma.kycDocument.findMany({
      where: { status },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, name: true, phone: true, email: true, role: true } } },
    });
    res.json({ documents });
  } catch (err) {
    next(err);
  }
}

async function adminReviewDocument(req, res, next) {
  try {
    const { decision, reason } = req.body;
    if (!["APPROVED", "REJECTED"].includes(decision)) return res.status(400).json({ error: "decision must be APPROVED or REJECTED." });
    if (decision === "REJECTED" && !reason) return res.status(400).json({ error: "Give a reason for rejecting." });
    const doc = await prisma.kycDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ error: "Document not found." });
    const updated = await prisma.kycDocument.update({
      where: { id: doc.id },
      data: { status: decision, rejectionReason: decision === "REJECTED" ? reason : null, reviewedById: req.user.id, reviewedAt: new Date() },
    });
    if (doc.docType === "GOVERNMENT_ID") {
      await prisma.artisanProfile.updateMany({
        where: { userId: doc.userId },
        data: decision === "APPROVED" ? { kycStatus: "APPROVED", isVerified: true, kycNote: null } : { kycStatus: "REJECTED", isVerified: false, kycNote: reason },
      });
    }
    await require("../services/auditLog.service").logAdminAction(req.user, `KYC_${decision}`, "KycDocument", doc.id, reason || null);
    notify(req.app.get("io"), doc.userId, "ADMIN", decision === "APPROVED" ? "Document approved ✅" : "Document declined", decision === "APPROVED" ? "Your document was verified." : reason, { kycDocumentId: doc.id }).catch(() => {});
    res.json({ document: updated });
  } catch (err) {
    next(err);
  }
}

async function adminListReports(req, res, next) {
  try {
    const where = req.query.status ? { status: req.query.status } : {};
    const reports = await prisma.safetyReport.findMany({
      where,
      orderBy: [{ type: "asc" }, { createdAt: "desc" }],
      include: { reporter: { select: { id: true, name: true, phone: true } } },
    });
    res.json({ reports });
  } catch (err) {
    next(err);
  }
}

async function adminUpdateReport(req, res, next) {
  try {
    const { status, adminNote } = req.body;
    if (status && !["OPEN", "REVIEWING", "RESOLVED"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    const report = await prisma.safetyReport.update({
      where: { id: req.params.id },
      data: { ...(status && { status, resolvedAt: status === "RESOLVED" ? new Date() : null }), ...(adminNote !== undefined && { adminNote }) },
    });
    await require("../services/auditLog.service").logAdminAction(req.user, "SAFETY_REPORT_UPDATE", "SafetyReport", report.id, status || null);
    res.json({ report });
  } catch (err) {
    next(err);
  }
}

module.exports = { overview, uploadDocument, deleteDocument, listContacts, addContact, deleteContact, createReport, listMyReports, adminListDocuments, adminReviewDocument, adminListReports, adminUpdateReport };
