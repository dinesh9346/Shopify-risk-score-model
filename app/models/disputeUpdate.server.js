// import prisma from "../db.server.js";
// import { updateSingleBuyerProfile } from "./Sync.server.js";
import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";
import { captureMLTrainingData } from "./mlTrainingPipeline.server.js";

// export async function processDisputeUpdate(topic, shop, payload) {
//   console.log(`[Dispute Update] Processing ${topic} for order: ${payload.order_id}`);

//   try {
//     const disputeId = payload.id?.toString();
//     const shopifyOrderIdStr = payload.order_id?.toString();

//     // Webhooks usually send raw integer IDs, but our DB stores GraphQL IDs for orders
//     const orderGid = shopifyOrderIdStr.includes("gid://") 
//       ? shopifyOrderIdStr 
//       : `gid://shopify/Order/${shopifyOrderIdStr}`;

//     // 1. Fetch the local order first to get its primary key (id) for the relation
//     const localOrder = await prisma.shopify_store_order.findFirst({
//       where: { shopifyOrderId: orderGid, shop: shop }
//     });

//     if (!localOrder) {
//       // If the order isn't in our DB, we can't link a dispute to it. 
//       // This is rare but happens if the app was installed after the order was placed.
//       console.warn(`[Dispute Warning] Order ${orderGid} not found locally. Skipping dispute sync.`);
//       return; 
//     }

//     // 2. Extract specific dispute payload data
//     const amount = parseFloat(payload.amount || "0");
//     const currency = payload.currency || "USD";
//     const reason = payload.reason || "unknown"; // e.g., 'fraudulent', 'product_not_received'
//     const status = payload.status || "needs_response"; // e.g., 'won', 'lost', 'charge_refunded'
//     const evidenceDueBy = payload.evidence_due_by ? new Date(payload.evidence_due_by) : null;

//     // 3. UPSERT the Dispute Record
//     // This handles both `disputes/create` and `disputes/update` gracefully
//     await prisma.shopify_dispute.upsert({
//       where: {
//         shop_shopifyDisputeId: { shop, shopifyDisputeId: disputeId }
//       },
//       create: {
//         shop,
//         shopifyDisputeId: disputeId,
//         orderId: localOrder.id, // Relate it to the local store order ID
//         status,
//         reason,
//         amount,
//         currency,
//         evidenceDueBy
//       },
//       update: {
//         status,
//         reason,
//         amount,
//         currency,
//         evidenceDueBy
//       }
//     });

//     // 4. Update the parent order's boolean flag (for legacy UI checks)
//     await prisma.shopify_store_order.update({
//       where: { id: localOrder.id },
//       data: { hasDispute: true }
//     });

//     console.log(`[Dispute Update] Successfully synced dispute ${disputeId} (${status}) for order ${shopifyOrderIdStr}`);

//     // 5. Recalculate their Buyer Profile
//     // We pass the new dispute data down the line so the profile can aggregate fraud vs. lost stats
//     await updateSingleBuyerProfile(
//       shop,
//       localOrder.customerEmail,
//       localOrder.customerPhone,
//       localOrder.customerId,
//       orderGid
//     );
//
//     // 6. Capture ML Training Data for Dispute
//     await captureMLTrainingData(shop, localOrder.id, 'DISPUTE');
//
//   } catch (error) {
//     // Crucial: Throwing the error ensures your webhook endpoint returns a 500, 
//     // forcing Shopify to retry sending the webhook later if the database is temporarily locked.
//     console.error("[Dispute Update Error]: Failed to process dispute payload:", error);
//     throw error; 
//   }
// }


//TESTING FUNCTION
export async function processDisputeUpdate(topic, shop, payload) {
  // Override with test order ID regardless of what comes from Shopify
  const testShop = "zippyy-ai.myshopify.com";
  const testOrderId = "7786499473701"; // shopify:admin/orders/7786499473701Always use this test order IDshopify:admin/orders/7786499473701

  console.log(`[WEBHOOK] Original order from Shopify: ${payload.order_id} | Using test order: ${testOrderId}`);

  try {
    const disputeAmount = parseFloat(payload.amount || "150.00");

    // Find the test order in the database
    const orderRecord = await prisma.shopify_store_order.findFirst({
      where: {
        shop: testShop,
        shopifyOrderId: `gid://shopify/Order/${testOrderId}`
      },
      select: {
        id: true,
        customerId: true,
        customerEmail: true,
        customerPhone: true,
        buyerProfileId: true
      }
    });

    if (!orderRecord) {
      console.warn(`[Dispute Alert] Test order ${testOrderId} not found in database.`);
      return;
    }

    // Find the buyer profile
    let profile = null;

    if (orderRecord.buyerProfileId) {
      profile = await prisma.zippyy_buyer_profile.findUnique({
        where: { id: orderRecord.buyerProfileId }
      });
    }

    // Fallback search by customer identifiers
    if (!profile) {
      console.log(`[Fallback] Searching buyer profile by customer identifiers...`);

      profile = await prisma.zippyy_buyer_profile.findFirst({
        where: {
          shop: testShop,
          OR: [
            orderRecord.customerEmail ? { customerEmail: orderRecord.customerEmail } : undefined,
            orderRecord.customerPhone ? { customerPhone: orderRecord.customerPhone } : undefined,
            orderRecord.customerId ? { customerId: orderRecord.customerId } : undefined,
          ].filter(Boolean)
        }
      });
    }

    // Update the buyer profile with dispute data
    if (profile) {
      // Determine dispute type for granular tracking
      const disputeReason = payload.reason || "fraudulent";
      const isFraudDispute = disputeReason === "fraudulent";

      await prisma.zippyy_buyer_profile.update({
        where: { id: profile.id },
        data: {
          disputeCount: { increment: 1 },
          fraudDisputeCount: isFraudDispute ? { increment: 1 } : undefined
        }
      });

      console.log(`[Dispute Alert] Applied dispute penalty to profile ${profile.buyerIdentifier}`);
    }

    // Update the order to mark it as having a dispute
    await prisma.shopify_store_order.update({
      where: { id: orderRecord.id },
      data: { hasDispute: true }
    });

    // Extract dispute data from payload
    const disputeId = payload.id?.toString() || "999888777";
    const amount = parseFloat(payload.amount || "900.00");
    const currency = payload.currency || "INR";
    const reason = payload.reason || "fraudulent";
    const status = payload.status || "needs_response";
    const evidenceDueBy = payload.evidence_due_by
      ? new Date(payload.evidence_due_by)
      : new Date("2026-04-20T23:59:59Z");

    // Create/update the dispute record
    await prisma.shopify_dispute.upsert({
      where: {
        shop_shopifyDisputeId: { shop: testShop, shopifyDisputeId: disputeId }
      },
      create: {
        shop: testShop,
        shopifyDisputeId: disputeId,
        orderId: orderRecord.id,
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

    console.log(`[Dispute Update] ✅ Successfully processed dispute ${disputeId} for test order ${testOrderId}`);

    // Recalculate the buyer profile with updated dispute stats
    if (profile) {
      await updateSingleBuyerProfile(
        testShop,
        orderRecord.customerEmail,
        orderRecord.customerPhone,
        orderRecord.customerId,
        `gid://shopify/Order/${testOrderId}`
      );
    }

    // Capture ML Training Data for Dispute
    await captureMLTrainingData(testShop, orderRecord.id, 'DISPUTE');

  } catch (error) {
    console.error(`[Dispute Error] Failed to process dispute:`, error.message);
    throw error;
  }
}