// Minimal demo dataset so the API has something to browse immediately
// after `npm run seed` — one admin, a handful of verified artisans across
// different categories, and a customer. Not exhaustive fixture data, just
// enough to click through every screen.
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function hash(pw) {
  return bcrypt.hash(pw, 10);
}

async function makeUser({ name, email, phone, role, extra = {} }) {
  return prisma.user.create({
    data: {
      name,
      email,
      phone,
      passwordHash: await hash("password123"),
      role,
      address: "12 Adeola Odeku, Victoria Island, Lagos",
      state: "Lagos",
      lga: "Eti-Osa",
      bankName: "GTBank",
      bankAccountNumber: "0123456789",
      bankAccountName: name,
      wallet: { create: {} },
      notificationPref: { create: {} },
      ...extra,
    },
  });
}

async function makeArtisan({ name, email, phone, category, bizName, yearsExp, lat, lng }) {
  return makeUser({
    name,
    email,
    phone,
    role: "ARTISAN",
    extra: {
      artisanProfile: {
        create: {
          category,
          bizName,
          bio: `Experienced ${category.toLowerCase()} serving Lagos.`,
          yearsExp,
          idType: "NIN",
          idNumber: "10293847561",
          kycStatus: "APPROVED",
          isVerified: true,
          isAvailable: true,
          lat,
          lng,
          ratingAvg: 4.5 + Math.random() * 0.5,
          ratingCount: Math.floor(10 + Math.random() * 40),
          jobsDone: Math.floor(10 + Math.random() * 40),
        },
      },
    },
  });
}

async function main() {
  console.log("Seeding FixMi demo data...");

  await makeUser({
    name: "FixMi Admin",
    email: "linusgreatman1@gmail.com",
    phone: "+2348010000000",
    role: "ADMIN",
    extra: { isSuperAdmin: true },
  });

  const customer = await makeUser({ name: "Ada Customer", email: "ada@example.com", phone: "+2348010000001", role: "CUSTOMER" });

  const artisans = await Promise.all([
    makeArtisan({ name: "Emeka Okafor", email: "emeka@example.com", phone: "+2348010000002", category: "Electrician", bizName: "Emeka Electricals", yearsExp: 5, lat: 6.4281, lng: 3.4219 }),
    makeArtisan({ name: "Taiwo Adeleke", email: "taiwo@example.com", phone: "+2348010000003", category: "Plumber", bizName: "Taiwo Plumbing Works", yearsExp: 7, lat: 6.4351, lng: 3.4108 }),
    makeArtisan({ name: "Ibrahim Musa", email: "ibrahim@example.com", phone: "+2348010000004", category: "AC Tech", bizName: "Ice Cool AC Services", yearsExp: 8, lat: 6.4401, lng: 3.4302 }),
    makeArtisan({ name: "Yusuf Bello", email: "yusuf@example.com", phone: "+2348010000005", category: "Carpenter", bizName: "Bello Woodworks", yearsExp: 10, lat: 6.4501, lng: 3.4022 }),
    makeArtisan({ name: "Chidinma Eze", email: "chidinma@example.com", phone: "+2348010000006", category: "Cleaner", bizName: "Sparkle Clean Co", yearsExp: 4, lat: 6.4321, lng: 3.4501 }),
  ]);

  // A pending sign-up so the admin's "pending artisans" screen has
  // something to approve/reject out of the box.
  await makeArtisan({ name: "Musa Danjuma", email: "musa@example.com", phone: "+2348010000007", category: "Welder", bizName: "Danjuma Welding", yearsExp: 3, lat: 6.42, lng: 3.41 }).then((u) =>
    prisma.artisanProfile.update({ where: { userId: u.id }, data: { kycStatus: "PENDING", isVerified: false } })
  );

  console.log(`Seeded: 1 admin, 1 customer (${customer.email}), ${artisans.length} verified artisans, 1 pending artisan.`);
  console.log(`All demo accounts use password "password123".`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
