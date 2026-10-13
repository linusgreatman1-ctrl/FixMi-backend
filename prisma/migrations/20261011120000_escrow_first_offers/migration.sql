-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REJECTED', 'CLOSED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "agreedPriceKobo" INTEGER,
ADD COLUMN     "arrivedAt" TIMESTAMP(3),
ADD COLUMN     "escrowKobo" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "onsitePriceKobo" INTEGER,
ADD COLUMN     "priceOnHold" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BookingOffer" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "artisanId" TEXT NOT NULL,
    "priceKobo" INTEGER,
    "isHold" BOOLEAN NOT NULL DEFAULT false,
    "customerPriceKobo" INTEGER,
    "lastBy" TEXT NOT NULL DEFAULT 'ARTISAN',
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingOffer_artisanId_idx" ON "BookingOffer"("artisanId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingOffer_bookingId_artisanId_key" ON "BookingOffer"("bookingId", "artisanId");

-- AddForeignKey
ALTER TABLE "BookingOffer" ADD CONSTRAINT "BookingOffer_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingOffer" ADD CONSTRAINT "BookingOffer_artisanId_fkey" FOREIGN KEY ("artisanId") REFERENCES "ArtisanProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Bookings from the old flow: requests nobody paid for yet are closed (no
-- money was taken), and jobs already paid keep their price as the agreed
-- price — their payout escrow holds already exist.
UPDATE "Booking" SET "status" = 'CANCELLED', "cancelledAt" = NOW(), "cancelReason" = 'Closed when the booking flow was upgraded'
WHERE "status" IN ('REQUESTED', 'ACCEPTED');
UPDATE "Booking" SET "agreedPriceKobo" = "priceKobo"
WHERE "status" IN ('PAID', 'IN_PROGRESS', 'COMPLETED', 'CONFIRMED');
