-- CreateEnum
CREATE TYPE "ManualPaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateTable
CREATE TABLE "ManualPaymentRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "senderName" TEXT,
    "note" TEXT,
    "status" "ManualPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "processedById" TEXT,
    "processedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualPaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualPaymentRequest_reference_key" ON "ManualPaymentRequest"("reference");

-- CreateIndex
CREATE INDEX "ManualPaymentRequest_userId_idx" ON "ManualPaymentRequest"("userId");

-- CreateIndex
CREATE INDEX "ManualPaymentRequest_status_idx" ON "ManualPaymentRequest"("status");

-- AddForeignKey
ALTER TABLE "ManualPaymentRequest" ADD CONSTRAINT "ManualPaymentRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

