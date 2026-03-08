import prisma from "../db.server.js";

export async function processOrderUpdate(shop, payload) {
  console.log(`[Order Update] Processing update for order: ${payload.id}`);

  try {
    await prisma.shopify_store_order.updateMany({
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
    
    console.log(`✅ [Order Update] Local database updated successfully for order ${payload.id}`);
  } catch (error) {
    console.error("❌ [Order Update Error] Failed to update local DB:", error.message);
    // Throwing the error tells SQS to keep the message in the queue and try again later
    throw error; 
  }
}