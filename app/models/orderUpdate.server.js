import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";
import { detectOrderStateChanges, updateStoredOrderState } from "./orderStateDetector.server.js";
import { enqueueLifecycleNotification } from "./queue.server.js";
import { captureMLTrainingData } from "./mlTrainingPipeline.server.js";
const STAGE_RANKS = {
  "ORDER_CONFIRMATION": 1,
  "PAYMENT_CONFIRMED": 2,
  "ORDER_FULLY_PACKED": 3,
  "SHIPMENT_CREATED": 3,
  "IN_TRANSIT": 4,
  "OUT_FOR_DELIVERY": 5,
  "DELIVERED": 6,
  "ORDER_CANCELLED": 99,
  "ORDER_REFUNDED": 99
};
function getProductDetailsFromPayload(payload) {
  const items = payload?.line_items || payload?.lineItems || [];
  if (!Array.isArray(items) || items.length === 0) return null;
  return items
    .map(item => {
      const quantity = item.quantity ?? item.qty ?? 1;
      const title = item.title || item.name || item.product_name || "Item";
      return `${quantity}x ${title}`;
    })
    .join(", ");
}

function getOrderTypeFromPayload(payload) {
  const gateway = [payload?.gateway, ...(payload?.payment_gateway_names || [])].filter(Boolean).join(" ").toLowerCase();
  let isCod = /cod|cash on delivery|pay on delivery/.test(gateway);
  
  if (!isCod && payload?.financial_status === "pending") {
    isCod = true;
  }
  
  return isCod ? "COD" : "Prepaid";
}

export async function processOrderUpdate(shop, payload) {
  console.log(`[Order Update] Processing update for order: ${payload.id}`);

  try {
    // 1. DETECT STATE CHANGES (Before updating the database)
    const stateChanges = await detectOrderStateChanges(shop, payload);

    // FETCH EXISTING ORDER FIRST TO NOT OVERWRITE isRTO blindly
    const existingOrder = await prisma.shopify_store_order.findUnique({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId: payload.admin_graphql_api_id } },
      select: { isRTO: true, shipmentStatus: true }
    });

    const isRtoStatusPayload = ["returned", "restocked", "refunded"].includes(payload.fulfillment_status?.toLowerCase()) ||
      payload.financial_status?.toLowerCase() === "refunded";

    const isShipmentRto = existingOrder?.shipmentStatus
      ? ["failure", "failed", "returned", "return_to_origin", "undelivered", "attempted_delivery", "delivery_failed", "not_delivered", "lost", "canceled", "cancelled", "exception"].includes(existingOrder.shipmentStatus.toLowerCase())
      : false;

    // Use existing isRTO if true, or shipment status, or payload status
    const isRtoStatus = existingOrder?.isRTO || isShipmentRto || isRtoStatusPayload;

    // 2. UPDATE THE DATABASE
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
        paymentGateway: [payload.gateway, ...(payload.payment_gateway_names || [])].filter(Boolean).join(" "),
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
        paymentGateway: [payload.gateway, ...(payload.payment_gateway_names || [])].filter(Boolean).join(" "),
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

    // 3. UPDATE STORED STATE FOR NEXT COMPARISON
    await updateStoredOrderState(shop, payload);

   // 4. QUEUE LIFECYCLE NOTIFICATIONS
   // Fallback chain: Top-level email -> Customer object email -> Database email
   const customerEmail = payload.email || 
                         payload.customer?.email || 
                         existingOrder?.customerEmail || // Fallback to DB
                         null;

   const customerPhone = payload.shipping_address?.phone || 
                         payload.customer?.phone || 
                         existingOrder?.customerPhone || // Fallback to DB
                         null;

   const customerName = [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' ') || 
                        existingOrder?.firstName || 
                        'Customer';
    const orderId = payload.admin_graphql_api_id;

    const productDetails = getProductDetailsFromPayload(payload) || "Order Items";
    const orderType = getOrderTypeFromPayload(payload);
    const orderAmount = payload?.total_price ? parseFloat(payload.total_price) : payload?.subtotal_price ? parseFloat(payload.subtotal_price) : 0;
    const sellerCompanyName = payload?.sellerCompanyName || payload?.shopName || shop || "Zippyy";

    for (const change of stateChanges) {
      try {
        // --- THE GOLDEN RULE GUARDRAIL ---
        // Grab the rank of what is currently in the DB, and the rank of the incoming webhook
        const currentRank = STAGE_RANKS[existingOrder?.shipmentStatus] || 0;
        const incomingRank = STAGE_RANKS[change.stage] || 0;

        // If the incoming webhook is trying to drag us backwards in time, block it!
        // (We ignore 99 because Cancellations/Refunds can happen at any time)
        if (incomingRank <= currentRank && incomingRank !== 99) {
          console.log(`[State Detector]  Ignored outdated state: ${change.stage}. Order is already at rank ${currentRank} (${existingOrder?.shipmentStatus || 'New'})`);
          continue; // Skip queuing this specific notification and move to the next loop!
        }
  

        await enqueueLifecycleNotification(shop, orderId, change.stage, {
          customerEmail,
          customerPhone,
          customerName,
          productDetails,
          orderType,
          orderAmount,
          sellerCompanyName,
          ...change.details
        });
        console.log(`[Order Update] Queued lifecycle notification: ${change.stage}`);
      } catch (notifError) {
        console.error(`[Order Update] Failed to queue ${change.stage}:`, notifError.message);
        // Don't throw - continue processing other notifications
      }
    }

    // 5. UPDATE BUYER PROFILE
    const customerId = payload.customer?.id ? `gid://shopify/Customer/${payload.customer.id}` : null;
    const numericOrderId = payload.id.toString();

    //  Instantly recalculate the buyer's profile!
    await updateSingleBuyerProfile(
      shop,
      customerEmail,
      customerPhone,
      customerId,
      numericOrderId
    );

  // 6. Capture ML Data if RTO
    if (isRtoStatus) {
      // Find the local order ID we just upserted to pass to the ML capture
      const localOrder = await prisma.shopify_store_order.findUnique({
        where: { shop_shopifyOrderId: { shop, shopifyOrderId: payload.admin_graphql_api_id } },
        select: { id: true }
      });
      if (localOrder) {
        await captureMLTrainingData(shop, localOrder.id, 'RTO');
      }
    }
  } catch (error) {
    console.error(` [Order Update Error] Failed to update local DB:`, error.message);
    // Throwing the error tells SQS to keep the message in the queue and try again later
    throw error;
  }
}
export async function syncCustomerProfile(shop, customerPayload) {
  try {
    const customerId = String(customerPayload.id);

    if (!customerId || customerId === 'undefined') {
      return { success: false, error: "Invalid customer ID in payload" };
    }

    // Basic Contact Info mapped to schema names
    const email = customerPayload.email || null;
    const firstName = customerPayload.first_name || null;
    const lastName = customerPayload.last_name || null;
    const phone = customerPayload.phone || null;
    const accountState = customerPayload.state; // 'disabled', 'invited', 'declined', 'enabled'

    // Address & Location Info (Extracted from Shopify's default_address object)
    const defaultAddress = customerPayload.default_address || {};
    const address1 = defaultAddress.address1 || null;
    const country = defaultAddress.country || null;

    // Determine buyerIdentifier consistently with other parts of the system
    // Prioritize: customerId > email > phone > fallback
    let buyerIdentifier = customerId;

    // Check if a profile already exists with any of this customer's identifiers
    const existingProfile = await prisma.zippyy_buyer_profile.findFirst({
      where: {
        shop,
        OR: [
          { buyerIdentifier: customerId },
          { customerId: customerId },
          email ? { customerEmail: email } : undefined,
          phone ? { customerPhone: phone } : undefined,
        ].filter(Boolean)
      }
    });

    if (existingProfile) {
      buyerIdentifier = existingProfile.buyerIdentifier;
    }

    // Upsert into Prisma using the new table name: zippyy_buyer_profile
    const profile = await prisma.zippyy_buyer_profile.upsert({
      where: { shop_buyerIdentifier: { shop, buyerIdentifier } },
      update: {
        customerEmail: email,
        firstName: firstName,
        lastName: lastName,
        customerPhone: phone,

        // Re-added location fields so they update if the customer changes their default address
        shippingAddress1: address1,
        shippingCountry: country,
        billingCountry: country,

        // If the merchant manually disabled the account, force a Watchlist flag.
        ...(accountState === 'disabled' && { buyerSegment: 'Watchlist', riskReasons: 'Account Disabled by Merchant' }),
      },
      create: {
        shop: shop,
        buyerIdentifier: buyerIdentifier,
        customerId: customerId,
        customerEmail: email,
        firstName: firstName,
        lastName: lastName,
        customerPhone: phone,


        shippingAddress1: address1,
        shippingCountry: country,
        billingCountry: country,

        buyerSegment: accountState === 'disabled' ? 'Watchlist' : 'New',
        riskReasons: accountState === 'disabled' ? 'Account Disabled by Merchant' : null,

        // Metric Defaults mapped to schema names
        totalorders: 0,
        validOrderCount: 0,
        totalSpend: 0.0,
        fulfilledCount: 0,
        cancelledCount: 0,
        rtoCount: 0,
        codCount: 0,
        unpaidCount: 0,
        disputeCount: 0,
        refundCount: 0
      }
    });

    console.log(`[Risk Engine] Synced identity for customer ${customerId}`);
    return { success: true, profile };

  } catch (error) {
    console.error(`[Risk Engine Error] Error syncing customer ${customerPayload?.id}:`, error);
    return { success: false, error: error.message };
  }
}