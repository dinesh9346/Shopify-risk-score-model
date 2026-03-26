import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function findDuplicates() {
  console.log(" Scanning for fragmented buyer profiles...\n");

  // 1. Check for shared Shopify Customer IDs
  const sharedCustomerIds = await prisma.zippyy_buyer_profile.groupBy({
    by: ['shop', 'customerId'],
    _count: { id: true }, // 🔥 FIX: Explicitly request the count in the output
    having: { id: { _count: { gt: 1 } } },
    where: { customerId: { not: null } } 
  });

  // 2. Check for shared Emails
  const sharedEmails = await prisma.zippyy_buyer_profile.groupBy({
    by: ['shop', 'customerEmail'],
    _count: { id: true }, 
    having: { id: { _count: { gt: 1 } } },
    where: { customerEmail: { not: null } }
  });

  // 3. Check for shared Phone Numbers
  const sharedPhones = await prisma.zippyy_buyer_profile.groupBy({
    by: ['shop', 'customerPhone'],
    _count: { id: true }, 
    having: { id: { _count: { gt: 1 } } },
    where: { customerPhone: { not: null } }
  });

  // --- OUTPUT THE RESULTS ---

  if (sharedCustomerIds.length > 0) {
    console.log(" Found profiles sharing the same Shopify Customer ID:");
    for (const group of sharedCustomerIds) {
      console.log(`   - Customer ID: ${group.customerId} exists in ${group._count.id} separate rows.`);
      // Fetch and show the specific rows
      const rows = await prisma.zippyy_buyer_profile.findMany({
        where: { shop: group.shop, customerId: group.customerId },
        select: { buyerIdentifier: true, totalorders: true }
      });
      console.log(`     Identifiers:`, rows.map(r => r.buyerIdentifier).join(" | "));
    }
    console.log("\n");
  } else {
    console.log(" No Customer ID duplicates found.\n");
  }

  if (sharedEmails.length > 0) {
    console.log(" Found profiles sharing the same Email Address:");
    for (const group of sharedEmails) {
      console.log(`   - Email: ${group.customerEmail} exists in ${group._count.id} separate rows.`);
    }
    console.log("\n");
  } else {
    console.log("No Email duplicates found.\n");
  }

  if (sharedPhones.length > 0) {
    console.log(" Found profiles sharing the same Phone Number:");
    for (const group of sharedPhones) {
      console.log(`   - Phone: ${group.customerPhone} exists in ${group._count.id} separate rows.`);
    }
    console.log("\n");
  } else {
    console.log(" No Phone Number duplicates found.\n");
  }

  console.log(" Scan complete.");
}

findDuplicates()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });