// import prisma from "../db.server.js";
// import { updateSingleBuyerProfile } from "./Sync.server.js";

// export async function processDisputeUpdate(topic,shop, payload) {
//   console.log(`[Dispute Update] Processing dispute for order: ${payload.order_id}`);

//   try {
//     const orderGid = `gid://shopify/Order/${payload.order_id}`;

//     // 1. Mark the specific order as disputed in the raw table
//     await prisma.shopify_store_order.updateMany({
//       where: {
//         shopifyOrderId: orderGid,
//         shop: shop
//       },
//       data: {
//         hasDispute: true,
//       }
//     });

//     console.log(`[Dispute Update] Local database updated successfully for order ${payload.order_id}`);

//     // 2. Fetch the order to identify the customer
//     const orderData = await prisma.shopify_store_order.findFirst({
//       where: { shopifyOrderId: orderGid, shop: shop }
//     });

//     // 3. Recalculate their profile
//     if (orderData) {
//       await updateSingleBuyerProfile(
//         shop,
//         orderData.customerEmail,
//         orderData.customerPhone,
//         orderData.customerId,
//         payload.order_id.toString()
//       );
//     }

//   } catch (error) {
//     console.error("[Dispute Update Error]: Failed to process dispute", error.message);
//   }
// }

import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";

export async function processDisputeUpdate(topic, shop, payload) {
  console.log(`[Dispute Update] Processing ${topic} for order: ${payload.order_id}`);

  try {
    const disputeId = payload.id?.toString();
    const shopifyOrderIdStr = payload.order_id?.toString();
    
    // Webhooks usually send raw integer IDs, but our DB stores GraphQL IDs for orders
    const orderGid = shopifyOrderIdStr.includes("gid://") 
      ? shopifyOrderIdStr 
      : `gid://shopify/Order/${shopifyOrderIdStr}`;

    // 1. Fetch the local order first to get its primary key (id) for the relation
    const localOrder = await prisma.shopify_store_order.findFirst({
      where: { shopifyOrderId: orderGid, shop: shop }
    });

    if (!localOrder) {
      // If the order isn't in our DB, we can't link a dispute to it. 
      // This is rare but happens if the app was installed after the order was placed.
      console.warn(`[Dispute Warning] Order ${orderGid} not found locally. Skipping dispute sync.`);
      return; 
    }

    // 2. Extract specific dispute payload data
    const amount = parseFloat(payload.amount || "0");
    const currency = payload.currency || "USD";
    const reason = payload.reason || "unknown"; // e.g., 'fraudulent', 'product_not_received'
    const status = payload.status || "needs_response"; // e.g., 'won', 'lost', 'charge_refunded'
    const evidenceDueBy = payload.evidence_due_by ? new Date(payload.evidence_due_by) : null;

    // 3. UPSERT the Dispute Record
    // This handles both `disputes/create` and `disputes/update` gracefully
    await prisma.shopify_dispute.upsert({
      where: {
        shop_shopifyDisputeId: { shop, shopifyDisputeId: disputeId }
      },
      create: {
        shop,
        shopifyDisputeId: disputeId,
        orderId: localOrder.id, // Relate it to the local store order ID
        status,
        reason,
        amount,
        currency,
        evidenceDueBy
      },
      update: {
        status,
        reason,
        amount,
        currency,
        evidenceDueBy
      }
    });

    // 4. Update the parent order's boolean flag (for legacy UI checks)
    await prisma.shopify_store_order.update({
      where: { id: localOrder.id },
      data: { hasDispute: true }
    });

    console.log(`[Dispute Update] Successfully synced dispute ${disputeId} (${status}) for order ${shopifyOrderIdStr}`);

    // 5. Recalculate their Buyer Profile
    // We pass the new dispute data down the line so the profile can aggregate fraud vs. lost stats
    await updateSingleBuyerProfile(
      shop,
      localOrder.customerEmail,
      localOrder.customerPhone,
      localOrder.customerId,
      orderGid
    );

  } catch (error) {
    // Crucial: Throwing the error ensures your webhook endpoint returns a 500, 
    // forcing Shopify to retry sending the webhook later if the database is temporarily locked.
    console.error("[Dispute Update Error]: Failed to process dispute payload:", error);
    throw error; 
  }
}