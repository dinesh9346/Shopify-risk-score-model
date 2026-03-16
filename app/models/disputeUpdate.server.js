import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";

export async function processDisputeUpdate(shop, payload) {
  console.log(`[Dispute Update] Processing dispute for order: ${payload.order_id}`);

  try {
    const orderGid = `gid://shopify/Order/${payload.order_id}`;

    // 1. Mark the specific order as disputed in the raw table
    await prisma.shopify_store_order.updateMany({
      where: {
        shopifyOrderId: orderGid,
        shop: shop
      },
      data: {
        hasDispute: true,
      }
    });

    console.log(`[Dispute Update] Local database updated successfully for order ${payload.order_id}`);

    // 2. Fetch the order to identify the customer
    const orderData = await prisma.shopify_store_order.findFirst({
      where: { shopifyOrderId: orderGid, shop: shop }
    });

    // 3. Recalculate their profile
    if (orderData) {
      await updateSingleBuyerProfile(
        shop,
        orderData.customerEmail,
        orderData.customerPhone,
        orderData.customerId,
        payload.order_id.toString()
      );
    }

  } catch (error) {
    console.error("[Dispute Update Error]: Failed to process dispute", error.message);
  }
}