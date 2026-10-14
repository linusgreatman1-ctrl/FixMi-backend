-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'PENDING_PAYMENT';

-- AlterTable
ALTER TABLE "ManualPaymentRequest" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'WALLET_DEPOSIT',
ADD COLUMN     "targetId" TEXT;

