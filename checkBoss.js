import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkBossOrders() {
  console.log("🔍 Fetching all raw orders containing 'boss'...");
  
  const orders = await prisma.shopify_store_order.findMany({
    where: { 
      customerEmail: { contains: "boss", mode: "insensitive" } 
    },
    select: { 
      shopifyOrderId: true, 
      customerEmail: true, 
      customerPhone: true,
      customerId: true 
    }
  });

  console.table(orders);
  console.log(`\nTotal orders found: ${orders.length}`);
}

checkBossOrders().finally(() => prisma.$disconnect());