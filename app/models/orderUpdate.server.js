import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";

export async function processOrderUpdate(shop, payload) {
  console.log(`[Order Update] Processing update for order: ${payload.id}`);

  try {
    // 1. Update the raw order data
    await prisma.shopify_store_order.updateMany({
      where: {
        shopifyOrderId: payload.admin_graphql_api_id,
        shop: shop
      },
      data: {
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        isRTO: ["returned", "restocked", "refunded"].includes(payload.fulfillment_status?.toLowerCase()) || 
           payload.financial_status?.toLowerCase() === "refunded",
        shippingAddress1: payload.shipping_address?.address1?.trim() || undefined,
        shippingAddress2: payload.shipping_address?.address2?.trim() || undefined,
        shippingCity: payload.shipping_address?.city?.trim() || undefined,
        shippingProvince: payload.shipping_address?.province?.trim() || payload.shipping_address?.province_code?.trim() || undefined,
        shippingZip: payload.shipping_address?.zip?.trim() || undefined,
        shippingCountry: payload.shipping_address?.country?.trim() || payload.shipping_address?.country_code?.trim() || undefined,
      }
    });

    console.log(` [Order Update] Local database updated successfully for order ${payload.id}`);

    //  2. Extract customer identity from the webhook payload
    const customerEmail = payload.email || payload.customer?.email || null;
    const customerPhone = payload.shipping_address?.phone || payload.customer?.phone || null;
    const customerId = payload.customer?.id ? `gid://shopify/Customer/${payload.customer.id}` : null;
    const numericOrderId = payload.id.toString();

    //  3. Instantly recalculate the buyer's profile!
    await updateSingleBuyerProfile(
      shop,
      customerEmail,
      customerPhone,
      customerId,
      numericOrderId
    );

  } catch (error) {
    console.error(` [Order Update Error] Failed to update local DB:`, error.message);
    // Throwing the error tells SQS to keep the message in the queue and try again later
    throw error;
  }
}

// import prisma from "../db.server.js";

// export async function processOrderUpdate(shop, payload) {
//   console.log(`[Order Update] Processing update for order: ${payload.id}`);

//   try {
//     await prisma.shopify_store_order.updateMany({
//       where: { 
//         shopifyOrderId: payload.admin_graphql_api_id,
//         shop: shop
//       },
//       data: {
//         financialStatus: payload.financial_status,
//         fulfillmentStatus: payload.fulfillment_status,
//         cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
//       },
//     });
    
//     console.log(` [Order Update] Local database updated successfully for order ${payload.id}`);
//   } catch (error) {
//     console.error(` [Order Update Error] Failed to update local DB:`, error.message);
//     // Throwing the error tells SQS to keep the message in the queue and try again later
//     throw error; 
//   }
// }