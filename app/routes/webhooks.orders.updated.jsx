import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  // 1. Authenticate the incoming webhook
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "ORDERS_UPDATED") {
    console.log(`📦 Order Updated webhook received for order: ${payload.id}`);

    try {
      // 2. Update the specific order in your local database
      await prisma.storeOrder.updateMany({
        where: { 
          shopifyOrderId: payload.admin_graphql_api_id,
          shop: shop
        },
        data: {
          financialStatus: payload.financial_status,
          fulfillmentStatus: payload.fulfillment_status,
          cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        },
      });
      console.log(`✅ Local Data Warehouse updated for order ${payload.id}`);
    } catch (error) {
      console.error("❌ Error updating local DB (Order might not exist yet):", error.message);
    }
  }

  // Always return a 200 response so Shopify knows you received it
  return new Response();
};