import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";

export async function processOrderUpdate(shop, payload) {
  console.log(`[Order Update] Processing update for order: ${payload.id}`);

  try {
    
    const isRtoStatus = ["returned", "restocked", "refunded"].includes(payload.fulfillment_status?.toLowerCase()) || 
               payload.financial_status?.toLowerCase() === "refunded";
    await prisma.shopify_store_order.upsert({
      where: {
        
        shop_shopifyOrderId: {
          shop: shop,
          shopifyOrderId: payload.admin_graphql_api_id
        }
      },
      update: {
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        isRTO: isRtoStatus,
        shippingAddress1: payload.shipping_address?.address1?.trim() || null,
        shippingAddress2: payload.shipping_address?.address2?.trim() || null,
        shippingCity: payload.shipping_address?.city?.trim() || null,
        shippingProvince: payload.shipping_address?.province?.trim() || payload.shipping_address?.province_code?.trim() || null,
        shippingZip: payload.shipping_address?.zip?.trim() || null,
        shippingCountry: payload.shipping_address?.country?.trim() || payload.shipping_address?.country_code?.trim() || null,
      },
      create: {
        shop: shop,
        shopifyOrderId: payload.admin_graphql_api_id,
        // orderValue is REQUIRED in your schema, so we extract total_price from the webhook
        orderValue: payload.total_price ? parseFloat(payload.total_price) : 0, 
        customerEmail: payload.email || payload.customer?.email || null,
        customerPhone: payload.shipping_address?.phone || payload.customer?.phone || null,
        customerId: payload.customer?.id ? `gid://shopify/Customer/${payload.customer.id}` : null,
        firstName: payload.customer?.first_name || null,
        lastName: payload.customer?.last_name || null,
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        isRTO: isRtoStatus,
        shippingAddress1: payload.shipping_address?.address1?.trim() || null,
        shippingAddress2: payload.shipping_address?.address2?.trim() || null,
        shippingCity: payload.shipping_address?.city?.trim() || null,
        shippingProvince: payload.shipping_address?.province?.trim() || payload.shipping_address?.province_code?.trim() || null,
        shippingZip: payload.shipping_address?.zip?.trim() || null,
        shippingCountry: payload.shipping_address?.country?.trim() || payload.shipping_address?.country_code?.trim() || null,
      }
    });

    console.log(` [Order Update] Local database successfully upserted for order ${payload.id}`);

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
