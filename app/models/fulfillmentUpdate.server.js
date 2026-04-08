import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";
import { enqueueLifecycleNotification } from "./queue.server.js";

const normalize = (value) =>
  (value || "").toString().trim().toLowerCase().replace(/\s+/g, "_").replace(/-+/g, "_");

const RTO_STATUSES = new Set([
  "failure",
  "failed",
  "returned",
  "return_to_origin",
  "undelivered",
  "attempted_delivery",
  "delivery_failed",
  "not_delivered",
  "lost",
  "canceled",
  "cancelled",
  "exception"
]);

export async function processFulfillmentUpdate(a, b, c) {
  let topic;
  let shop;
  let payload;

  // 1. Map arguments based on signature
  if (typeof a === "string" && typeof b === "object" && c === undefined) {
    // Old signature: (shop, payload)
    shop = a;
    payload = b;
    topic = payload?.topic || payload?.webhookTopic || "UNKNOWN";
  } else {
    // New signature: (topic, shop, payload)
    topic = a;
    shop = b;
    payload = c;
  }

  // 2. SAFEGUARD: If SQS passed the payload as a raw string, parse it into an object
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      console.error(`[Webhook Processor] Failed to parse stringified payload for ${topic}`);
      return; // Added return to drop the message if it can't be parsed
    }
  }

  // 3. SAFEGUARD: If payload is completely missing, exit cleanly so SQS drops the message
  // instead of crashing and retrying infinitely.
  if (!payload) {
    console.error(`[Webhook Processor] CRITICAL: Payload is undefined for ${topic}. Check queue.server.js (Line 127).`);
    return;
  }

  // 4. Normalize Shopify's nested structures
  if (payload?.data && !payload?.order_id) payload = payload.data;
  if (payload?.payload && !payload?.order_id) payload = payload.payload;

  // 5. Safely extract the Order ID
  const orderIdRaw =
    payload?.order_id ||
    payload?.order?.id ||
    payload?.order?.order_id ||
    payload?.order?.admin_graphql_api_id ||
    null;

  if (!orderIdRaw) {
    console.log(`[Webhook Processor] Missing order_id for ${topic}. Skipping.`);
    return;
  }

  const orderIdStr = orderIdRaw.toString();
  const orderIdNumeric = orderIdStr.includes("gid://") ? orderIdStr.split("/").pop() : orderIdStr;
  const orderGid = orderIdStr.includes("gid://") ? orderIdStr : `gid://shopify/Order/${orderIdNumeric}`;

  console.log(`[Webhook Processor] Processing ${topic} for order: ${orderIdNumeric}`);

  try {
    const trackingInfo = Array.isArray(payload.tracking_info) ? payload.tracking_info[0] : null;

    const trackingCompany =
      payload.tracking_company ||
      trackingInfo?.company ||
      null;

    const trackingNumber =
      payload.tracking_number ||
      (Array.isArray(payload.tracking_numbers) ? payload.tracking_numbers[0] : null) ||
      trackingInfo?.number ||
      null;

    const trackingUrl =
      payload.tracking_url ||
      (Array.isArray(payload.tracking_urls) ? payload.tracking_urls[0] : null) ||
      trackingInfo?.url ||
      null;

    const fulfillmentStatus =
      payload.status ||
      payload.fulfillment_status ||
      null;

    const shipmentStatusRaw =
      payload.shipment_status ||
      payload.latest_shipment_status ||
      payload.tracking_status ||
      null;

    const shipmentStatus = shipmentStatusRaw ? normalize(shipmentStatusRaw) : null;

    const isRTO = shipmentStatus ? RTO_STATUSES.has(shipmentStatus) : false;

    // Get PREVIOUS fulfillment state for change detection
    let previousOrder = null;
    if (orderGid) {
      previousOrder = await prisma.shopify_store_order.findFirst({
        where: { shopifyOrderId: orderGid, shop: shop },
        select: {
          fulfillmentStatus: true,
          shipmentStatus: true,
          financialStatus: true,
          customerEmail: true,
          customerPhone: true,
          firstName: true,
          lastName: true
        }
      });
    }

    if (topic === "FULFILLMENTS_CREATE" || topic === "FULFILLMENTS_UPDATE") {
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
          shipmentStatus: shipmentStatusRaw,
          previousFulfillmentStatus: previousOrder?.fulfillmentStatus,
          lastFulfillmentStatusChange: 
            previousOrder?.fulfillmentStatus !== fulfillmentStatus ? new Date() : undefined,
          isRTO: isRTO,
        }
      });

      // QUEUE LIFECYCLE NOTIFICATIONS for fulfillment status changes
      if (previousOrder && previousOrder.fulfillmentStatus !== fulfillmentStatus) {
        const customerEmail = previousOrder.customerEmail;
        const customerPhone = previousOrder.customerPhone;
        const customerName = [previousOrder.firstName, previousOrder.lastName].filter(Boolean).join(' ') || 'Customer';

        // Map specific statuses to lifecycle notifications
        if (fulfillmentStatus === "fulfilled" || fulfillmentStatus === "success") {
          await enqueueLifecycleNotification(shop, orderGid, "DELIVERED", {
            customerEmail, customerPhone, customerName,
            productDetails: "Order Items",
            orderType: "Standard",
            sellerCompanyName: "Zippyy",
            trackingId: trackingNumber || "N/A"
          });
        } else if (fulfillmentStatus?.toLowerCase().includes("in_transit")) {
          await enqueueLifecycleNotification(shop, orderGid, "IN_TRANSIT", {
            customerEmail, customerPhone, customerName,
            trackingNumber: trackingNumber,
            trackingUrl: trackingUrl
          });
        } else if (fulfillmentStatus?.toLowerCase().includes("out_for_delivery")) {
          await enqueueLifecycleNotification(shop, orderGid, "OUT_FOR_DELIVERY", {
            customerEmail, customerPhone, customerName
          });
        } else if (fulfillmentStatus === "delivered") {
          await enqueueLifecycleNotification(shop, orderGid, "DELIVERED", {
            customerEmail, customerPhone, customerName,
            trackingId: trackingNumber || "N/A"
          });
        } else if (fulfillmentStatus === "partial") {
          await enqueueLifecycleNotification(shop, orderGid, "ORDER_PARTIALLY_SHIPPED", {
            customerEmail, customerPhone, customerName
          });
        } else if (fulfillmentStatus === "restocked") {
          await enqueueLifecycleNotification(shop, orderGid, "ORDER_RESTOCKED", {
            customerEmail, customerPhone, customerName
          });
        }
        console.log(`[Fulfillment Update] Queued lifecycle notification for status: ${fulfillmentStatus}`);
      }
    }

    if (topic === "FULFILLMENT_EVENTS_CREATE") {
      const eventStatusRaw = payload.status || payload.event_status || null;
      const eventStatus = eventStatusRaw ? normalize(eventStatusRaw) : null;
      const eventIsRTO = eventStatus ? RTO_STATUSES.has(eventStatus) : false;

      await prisma.shopify_store_order.updateMany({
        where: { shopifyOrderId: orderGid, shop: shop },
        data: {
          shipmentStatus: eventStatusRaw,
          isRTO: eventIsRTO
        }
      });
    }

    if (topic === "RETURNS_UPDATE" || topic === "RETURNS_CLOSE") {
      await prisma.shopify_store_order.updateMany({
        where: { shopifyOrderId: orderGid, shop: shop },
        data: {
          shipmentStatus: "return_to_origin",
          isRTO: true
        }
      });
    }

    if (topic === "REFUNDS_CREATE") {
      // Get order info for refund notification
      const orderBeforeRefund = await prisma.shopify_store_order.findFirst({
        where: { shopifyOrderId: orderGid, shop: shop },
        select: {
          financialStatus: true,
          customerEmail: true,
          customerPhone: true,
          firstName: true,
          lastName: true
        }
      });

      await prisma.shopify_store_order.updateMany({
        where: { shopifyOrderId: orderGid, shop: shop },
        data: {
          financialStatus: "PARTIALLY_REFUNDED",
          previousFinancialStatus: orderBeforeRefund?.financialStatus,
          lastFinancialStatusChange: new Date()
        }
      });

      // Queue refund notification if this is a new refund
      if (orderBeforeRefund?.financialStatus !== "PARTIALLY_REFUNDED") {
        const customerEmail = orderBeforeRefund?.customerEmail;
        const customerPhone = orderBeforeRefund?.customerPhone;
        const customerName = [orderBeforeRefund?.firstName, orderBeforeRefund?.lastName].filter(Boolean).join(' ') || 'Customer';

        await enqueueLifecycleNotification(shop, orderGid, "ORDER_REFUNDED", {
          customerEmail, customerPhone, customerName,
          refundReason: "Refund processed"
        });
        console.log(`[Refund Update] Queued refund notification for order`);
      }
    }

    const orderData = await prisma.shopify_store_order.findFirst({
      where: { shopifyOrderId: orderGid, shop: shop }
    });

    if (orderData) {
      await updateSingleBuyerProfile(
        shop,
        orderData.customerEmail,
        orderData.customerPhone,
        orderData.customerId,
        orderIdNumeric.toString()
      );
    }

  } catch (error) {
    console.error("[Webhook Processor Error]: Failed to process webhook", error.message);
    throw error;
  }
}