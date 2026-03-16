import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";

export async function processFulfillmentUpdate(shop, payload) {
  console.log(`[Fulfillment Update] Processing fulfillment for order: ${payload.order_id}`);

  try {
    const orderGid = `gid://shopify/Order/${payload.order_id}`;
    
    // Extract courier data from the payload
    const trackingCompany = payload.tracking_company || null;
    const trackingNumber = payload.tracking_number || null;
    const trackingUrl = payload.tracking_url || null;
    const fulfillmentStatus = payload.status || null; 
    const shipmentStatus = payload.shipment_status || null; // e.g., "failure", "delivered"

    // Determine if this shipment is an RTO
    const isRTO = (shipmentStatus === "failure" || shipmentStatus === "returned");

    // 1. Mark the specific order with logistics data in the raw table
    await prisma.shopify_store_order.updateMany({
      where: {
        shopifyOrderId: orderGid,
        shop: shop
      },
      data: {
        carrier: trackingCompany,
        trackingNumber: trackingNumber,
        trackingUrl: trackingUrl,
        fulfillmentStatus: fulfillmentStatus,
        shipmentStatus: shipmentStatus,
        isRTO: isRTO, // Updates the boolean flag on the order so Sync.server.js can easily count it
      }
    });

    console.log(`[Fulfillment Update] Local database updated successfully for order ${payload.order_id}`);

    // 2. Fetch the order to identify the customer
    const orderData = await prisma.shopify_store_order.findFirst({
      where: { shopifyOrderId: orderGid, shop: shop }
    });

    if (orderData) {
      console.log(`[Fulfillment Update] Recalculating profile for customer...`);
      await updateSingleBuyerProfile(
        shop,
        orderData.customerEmail,
        orderData.customerPhone,
        orderData.customerId,
        payload.order_id.toString()
      );
    }

  } catch (error) {
    console.error("[Fulfillment Update Error]: Failed to process fulfillment", error.message);
    throw error; // Crucial to throw here so SQS keeps the message in the queue for a retry if the DB locks up
  }
}