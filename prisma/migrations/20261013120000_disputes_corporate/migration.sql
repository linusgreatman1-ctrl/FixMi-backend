-- AlterEnum
ALTER TYPE "EscrowStatus" ADD VALUE 'DISPUTED';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "corporatePlanId" TEXT;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "category" TEXT,
ADD COLUMN     "evidenceUrl" TEXT,
ADD COLUMN     "isDispute" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundAmountKobo" INTEGER,
ADD COLUMN     "requestedRefundKobo" INTEGER,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "secondPartyEvidenceUrl" TEXT,
ADD COLUMN     "secondPartyRespondedAt" TIMESTAMP(3),
ADD COLUMN     "secondPartyResponse" TEXT,
ADD COLUMN     "secondPartyUserId" TEXT;

-- CreateTable
CREATE TABLE "CorporatePlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "callsTotal" INTEGER NOT NULL,
    "callsUsed" INTEGER NOT NULL DEFAULT 0,
    "categories" TEXT[],
    "escrowKobo" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorporatePlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CorporatePlan_userId_idx" ON "CorporatePlan"("userId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_corporatePlanId_fkey" FOREIGN KEY ("corporatePlanId") REFERENCES "CorporatePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorporatePlan" ADD CONSTRAINT "CorporatePlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

