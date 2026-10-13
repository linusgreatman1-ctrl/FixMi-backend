const prisma = require("../config/db");

// Fire-and-forget: a logging failure must never break the admin action it records.
async function logAdminAction(actor, action, targetType, targetId, details) {
  try {
    await prisma.adminAuditLog.create({
      data: { actorId: actor.id, actorName: actor.name, actorEmail: actor.email || null, action, targetType: targetType || null, targetId: targetId || null, details: details || null },
    });
  } catch (err) {
    console.error("[auditLog] failed:", action, err.message);
  }
}

module.exports = { logAdminAction };
