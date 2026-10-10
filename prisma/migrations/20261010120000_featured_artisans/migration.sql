-- AlterTable
ALTER TABLE "ArtisanProfile" ADD COLUMN "featuredUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ArtisanProfile_featuredUntil_idx" ON "ArtisanProfile"("featuredUntil");

-- Testing data: the seeded demo artisans count as having paid for a
-- year-long promotion, so the homepage "Featured" list isn't empty.
UPDATE "ArtisanProfile" SET "featuredUntil" = NOW() + INTERVAL '365 days'
WHERE "userId" IN (
  SELECT "id" FROM "User"
  WHERE "phone" IN ('+2348010000002', '+2348010000003', '+2348010000004', '+2348010000005', '+2348010000006')
);

-- Admin sign-in is removed from the app; switch off the seeded demo admin
-- (shared password) so it can't be used against the live API.
UPDATE "User" SET "status" = 'SUSPENDED'
WHERE "phone" = '+2348010000000' AND "role" = 'ADMIN' AND "name" = 'FixMi Admin';
