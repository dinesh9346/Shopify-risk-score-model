import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  // 1. Authenticate the webhook securely
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "SHOPIFY_PAYMENTS_DISPUTE_CREATED") {
    console.log(`🚨 DISPUTE (CHARGEBACK) received for order ID: ${payload.order_id}`);

    try {
      // The dispute payload gives a numeric order_id (e.g., 123456789)
      // Our database uses the GraphQL format, so we construct it:
      const orderGid = `gid://shopify/Order/${payload.order_id}`;

      // 2. Find the order and flip the "hasDispute" switch to true
      await prisma.shopify_store_order.updateMany({
        where: { 
          shopifyOrderId: orderGid,
          shop: shop
        },
        data: {
          hasDispute: true, // This adds 5 points to their risk score forever!
        },
      });
      
      console.log(` Order ${payload.order_id} marked as Disputed in local Data Warehouse.`);
    } catch (error) {
      console.error(" Error updating dispute status in local DB:", error.message);
    }
  }

  // 3. Always return a 200 Response to tell Shopify we successfully handled it
  return new Response();
};