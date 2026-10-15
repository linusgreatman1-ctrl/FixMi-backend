-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "party" TEXT,
ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "ManualPaymentRequest" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'BANK_TRANSFER';

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'paystack',
    "amountKobo" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "email" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_reference_key" ON "PaymentIntent"("reference");

