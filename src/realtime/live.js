const { Server } = require("socket.io");
const prisma = require("../config/db");
const { verifyAccessToken } = require("../utils/jwt");
const escrowSvc = require("../services/escrow.service");
const bookingsCtrl = require("../controllers/bookings.controller");

// Replaces every client-side setTimeout "simulation" in the frontend
// prototype (the radar-search auto-advance, escrow release countdown) with
// real server-pushed events. Room state lives in this process's memory —
// fine for a single instance, would need the socket.io Redis adapter to
// scale horizontally.
//
// Room map:
//   user:{userId}     — personal channel (notifications, new job broadcast)
//   booking:{bookingId}
//   chat:{threadId}
function attachLiveSocket(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: true, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error("Authentication required."));
      let payload;
      try {
        payload = verifyAccessToken(token);
      } catch (err) {
        return next(new Error("Invalid or expired token."));
      }
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, status: true, name: true, artisanProfile: { select: { id: true, category: true } } },
      });
      if (!user || user.status !== "ACTIVE") return next(new Error("Account is not active."));
      socket.user = user;
      next();
    } catch (err) {
      next(new Error("Authentication failed."));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.user;
    socket.join(`user:${user.id}`);
    if (user.role === "ADMIN") socket.join("admins");

    // Explicit room joins, each gated by an actual access check so a
    // socket can't eavesdrop on someone else's booking/chat by guessing an id.
    socket.on("booking:join", async ({ bookingId }, ack) => {
      if (!bookingId) return typeof ack === "function" && ack({ joined: false });
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!booking) return typeof ack === "function" && ack({ joined: false });
      const allowed = booking.customerId === user.id || (user.artisanProfile && booking.artisanId === user.artisanProfile.id);
      if (allowed) socket.join(`booking:${bookingId}`);
      if (typeof ack === "function") ack({ joined: !!allowed });
    });

    socket.on("chat:join", async ({ threadId }) => {
      if (!threadId) return;
      const participant = await prisma.chatParticipant.findUnique({ where: { threadId_userId: { threadId, userId: user.id } } });
      if (participant) socket.join(`chat:${threadId}`);
    });

    socket.on("chat:typing", ({ threadId }) => {
      if (threadId) socket.to(`chat:${threadId}`).emit("chat:typing", { threadId, userId: user.id });
    });

    // Artisan live location while en route — the frontend's tracking/ETA
    // screen reads this instead of animating a canned SVG path.
    socket.on("artisan:location", async ({ lat, lng }) => {
      if (!user.artisanProfile || typeof lat !== "number" || typeof lng !== "number") return;
      await prisma.artisanProfile.update({ where: { id: user.artisanProfile.id }, data: { lat, lng } });
      const activeBookings = await prisma.booking.findMany({
        where: { artisanId: user.artisanProfile.id, status: { in: ["PAID", "IN_PROGRESS"] } },
        select: { id: true },
      });
      const payload = { artisanId: user.artisanProfile.id, lat, lng, at: new Date().toISOString() };
      activeBookings.forEach((b) => io.to(`booking:${b.id}`).emit("artisan:location", payload));
    });

    // Ad-hoc 1:1 call between a customer and their assigned artisan — the
    // booking detail screen's real "Call" button. Rings the callee's
    // personal user:{userId} room; only once accepted do both sides learn
    // each other's live socket id and start real SDP/ICE signaling. This
    // server only relays the small handshake messages — audio/video itself
    // is peer-to-peer.
    socket.on("call:invite", async ({ toUserId, bookingId, callerName }) => {
      if (!toUserId) return;
      if (bookingId) {
        const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { artisan: { select: { userId: true } } } });
        if (!booking) return;
        const allowed = booking.customerId === user.id || (booking.artisan && booking.artisan.userId === user.id);
        if (!allowed) return;
      }
      io.to(`user:${toUserId}`).emit("call:incoming", { fromUserId: user.id, fromSocketId: socket.id, bookingId: bookingId || null, callerName: callerName || user.name });
    });
    socket.on("call:accept", ({ toSocketId, bookingId }) => {
      if (!toSocketId) return;
      io.to(toSocketId).emit("call:accepted", { fromUserId: user.id, fromSocketId: socket.id, bookingId: bookingId || null });
    });
    socket.on("call:decline", ({ toSocketId, bookingId }) => {
      if (!toSocketId) return;
      io.to(toSocketId).emit("call:declined", { fromUserId: user.id, bookingId: bookingId || null });
    });
    socket.on("call:end", ({ toSocketId, bookingId }) => {
      if (!toSocketId) return;
      io.to(toSocketId).emit("call:ended", { fromUserId: user.id, bookingId: bookingId || null });
    });
    ["call:offer", "call:answer", "call:ice-candidate"].forEach((evt) => {
      socket.on(evt, (payload) => {
        if (!payload || !payload.toSocketId) return;
        io.to(payload.toSocketId).emit(evt, Object.assign({}, payload, { fromSocketId: socket.id }));
      });
    });

    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (room.startsWith("booking:")) {
          socket.to(room).emit("call:ended", { bookingId: room.slice("booking:".length), fromUserId: user.id });
        }
      }
    });
  });

  // Server-side escrow auto-release — replaces a frontend client setTimeout
  // countdown, which stops running the moment a tab closes and would
  // otherwise strand an artisan's payout forever.
  const sweepMs = 5 * 60 * 1000;
  setInterval(() => {
    escrowSvc.runAutoReleaseSweep().catch((err) => console.error("[escrow] auto-release sweep failed:", err));
  }, sweepMs);
  setInterval(() => {
    bookingsCtrl.finalizeAutoReleasedBookings(io).catch((err) => console.error("[booking] auto-release finalize sweep failed:", err));
  }, sweepMs);

  return io;
}

module.exports = { attachLiveSocket };
