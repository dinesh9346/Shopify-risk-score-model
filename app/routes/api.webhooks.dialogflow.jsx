import prisma from "../db.server.js";
import { NotificationService } from "../models/notification.server.js";
import { WHATSAPP_TEMPLATES } from "../config/templates.js";
import { WhatsAppAdapter } from "../models/whatsapp-adapter.server.js";
import crypto from "crypto";

// =====================================================================
// SHOPIFY UTILITY FUNCTIONS (Used for Canceling and Tagging Orders)
// =====================================================================
async function cancelShopifyOrder(shop, orderId) {
  const session = await prisma.session.findFirst({ where: { shop } });
  if (!session) throw new Error("No active session for shop");

  // Ensure the ID is formatted correctly for Shopify GraphQL
  const formattedId = String(orderId).includes("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  // FIX: Added 'restock: true' to satisfy Shopify's strict GraphQL requirements
  const query = `
    mutation orderCancel($orderId: ID!) {
      orderCancel(orderId: $orderId, reason: CUSTOMER, notifyCustomer: false, restock: true) {
        job { id }
        userErrors { field message }
      }
    }
  `;

  const response = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables: { orderId: formattedId } }),
  });

  const data = await response.json();

  // Catch top-level GraphQL errors so it doesn't fail silently!
  if (data.errors && data.errors.length > 0) {
    console.error("[Shopify GraphQL Error]:", JSON.stringify(data.errors, null, 2));
    throw new Error(`Shopify API Error: ${data.errors[0].message}`);
  }

  // Catch user errors (like trying to cancel an already fulfilled order)
  if (data.data?.orderCancel?.userErrors?.length > 0) {
    throw new Error(data.data.orderCancel.userErrors[0].message);
  }

  console.log(`[Shopify] Successfully triggered cancellation for ${formattedId}`);
  return true;
}

async function addTagToShopifyOrder(shop, orderGid, tag) {
  const session = await prisma.session.findFirst({ where: { shop } });
  if (!session) return;

  const query = `
    mutation tagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { message }
      }
    }
  `;

  await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables: { id: orderGid, tags: [tag] } }),
  });
}

// Helper function to safely prefix tokens for cross-platform acknowledgement
const markTokenAsUsed = (token, prefix) => {
  if (!token) return token;
  // Strip any existing prefix just in case it was already used
  const baseToken = token.replace(/^(WA_USED_|WEB_USED_)/, '');
  return `${prefix}${baseToken}`;
};

// MAIN WEBHOOK ACTION HANDLER

export const action = async ({ request }) => {
  // 1. Ensure it's a POST request
  if (request.method !== "POST") {
    return Response.json({ message: "Method not allowed" }, { status: 405 });
  }

  try {
    // 2. Parse the incoming JSON from Dialogflow
    const reqBody = await request.json();

    // DEBUG: Log the entire payload for inspection
    console.log(`[Dialogflow] ========== WEBHOOK RECEIVED ==========`);
    console.log(`[Dialogflow] Intent: ${reqBody.queryResult?.intent?.displayName}`);
    console.log(`[Dialogflow] QueryText: ${reqBody.queryResult?.queryText}`);
    console.log(`[Dialogflow] Full Webhook Body (first 1000 chars):`, JSON.stringify(reqBody).substring(0, 1000));
    console.log(`[Dialogflow] AiSensy Payload Keys:`, Object.keys(reqBody.originalDetectIntentRequest?.payload || {}));
    console.log(`[Dialogflow] Full AiSensy Payload:`, JSON.stringify(reqBody.originalDetectIntentRequest?.payload, null, 2));
    console.log(`[Dialogflow] =====================================`);

    // 3. Extract data from the Dialogflow / AiSensy Payload
    const intentName = reqBody.queryResult?.intent?.displayName || "";
    const queryText = reqBody.queryResult?.queryText || "No Text";

    const aiSensyPayload = reqBody.originalDetectIntentRequest?.payload;
    const rawPhone = aiSensyPayload?.AiSensyMobileNumber;

    if (!rawPhone) {
      console.log("[Dialogflow] No phone number in payload, skipping.");
      return Response.json({ fulfillmentText: "Ignored: No phone number." });
    }

    // Clean phone number (remove the '+' if present to match your DB)
    const cleanPhone = rawPhone.replace('+', '');

    // 4. Try to find order using orderId from multiple sources
    let recentOrder = null;

    // First: Check if orderId is in the Dialogflow payload (from button context)
    let orderIdFromPayload = aiSensyPayload?.orderId || aiSensyPayload?.shopifyOrderId || aiSensyPayload?.order_id;

    // Second: Check queryText for orderId (sometimes passed as text)
    if (!orderIdFromPayload && queryText) {
      const orderIdMatch = queryText.match(/(\d+)/) || queryText.match(/gid:\/\/shopify\/Order\/(\d+)/);
      if (orderIdMatch) {
        orderIdFromPayload = orderIdMatch[1];
        console.log(`[Dialogflow] Extracted orderId from queryText: ${orderIdFromPayload}`);
      }
    }
    // Third: Lookup the most recent NOTIFICATION sent to this customer (this has orderId tracking!)
    if (!orderIdFromPayload) {
      const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
      const phoneNumeric = cleanPhone.replace(/\D/g, '');

      const recentNotifications = await prisma.notification.findMany({
        where: {
          recipient: { contains: phoneNumeric.substring(Math.max(0, phoneNumeric.length - 10)) },
          orderId: { not: null },
          createdAt: { gte: sixtyMinutesAgo }
        },
        orderBy: { createdAt: 'desc' }
      });

      const uniqueRecentOrderIds = [...new Set(recentNotifications.map(n => n.orderId))];

      if (uniqueRecentOrderIds.length > 1) {
        // SMART FILTER: We have multiple recent notifications. Let's check how many are STILL ACTIVE.
        const pureNumbers = uniqueRecentOrderIds.map(id => {
          const match = String(id).match(/\d+/);
          return match ? match[0] : String(id);
        });

        const activeOrders = await prisma.shopify_store_order.findMany({
          where: {
            OR: [
              { shopifyOrderId: { in: pureNumbers } },
              { shopifyOrderId: { in: pureNumbers.map(num => `gid://shopify/Order/${num}`) } },
              { shopifyOrderId: { in: uniqueRecentOrderIds } }
            ],
            cancelledAt: null,
            financialStatus: { not: "voided" },
            fulfillmentStatus: { not: "cancelled" }
          },
          select: { shopifyOrderId: true }
        });

        // Get the list of IDs that are still active
        const activeOrderIds = [...new Set(activeOrders.map(o => {
          const match = String(o.shopifyOrderId).match(/\d+/);
          return match ? match[0] : String(o.shopifyOrderId);
        }))];

        if (activeOrderIds.length > 1) {
          console.log(`[Dialogflow] CONFLICT: Multiple ACTIVE recent orders found for ${cleanPhone}. Prompting user to clarify.`);

          let actionWord = "confirm order";
          if (intentName.toUpperCase().includes("CANCEL") || queryText.toLowerCase().includes("cancel")) {
            actionWord = "cancel order";
          }

          return Response.json({
            fulfillmentText: `We noticed you have multiple active orders. To ensure we process the correct one, please reply with '${actionWord}' followed by your exact Order ID.\n\nExample: *${actionWord} 7836573958437*`
          });
        } else if (activeOrderIds.length === 1) {
          // Perfect! Only ONE order is actually active. We can safely assume this is the one they want.
          orderIdFromPayload = activeOrderIds[0];
          console.log(`[Dialogflow] Resolved conflict: Only one active order found: ${orderIdFromPayload}`);
        } else {
          // Multiple notifications, but NONE are active (all are cancelled). 
          // Just grab the most recent one so the standard "already cancelled" logic catches it below!
          orderIdFromPayload = uniqueRecentOrderIds[0];
          console.log(`[Dialogflow] All recent orders are cancelled. Defaulting to most recent: ${orderIdFromPayload}`);
        }

      } else if (uniqueRecentOrderIds.length === 1) {
        orderIdFromPayload = uniqueRecentOrderIds[0];
        console.log(`[Dialogflow] Found exactly one recent orderId from notifications: ${orderIdFromPayload}`);
      } else {
        console.log(`[Dialogflow] No recent notification found with orderId for phone: ${phoneNumeric}`);
      }
    }
    if (orderIdFromPayload) {
      // Safely extract just the numeric part of the Shopify ID
      const numericIdMatch = String(orderIdFromPayload).match(/\d+/);
      const pureNumber = numericIdMatch ? numericIdMatch[0] : String(orderIdFromPayload);

      // Search ONLY against shopifyOrderId, because local 'id' is a CUID
      recentOrder = await prisma.shopify_store_order.findFirst({
        where: {
          OR: [
            { shopifyOrderId: pureNumber },
            { shopifyOrderId: `gid://shopify/Order/${pureNumber}` },
            { shopifyOrderId: { contains: pureNumber } }
          ]
        }
      });

      console.log(`[Dialogflow] Found order using orderId from payload: ${pureNumber}`);
    }

    // Fallback: Find most recent order by phone if orderId not provided
    if (!recentOrder) {
      console.log(`[Dialogflow] WARNING: No orderId found in payload or notifications. Using MOST RECENT order as last resort.`);
      recentOrder = await prisma.shopify_store_order.findFirst({
        where: {
          customerPhone: { contains: cleanPhone.substring(2) }
        },
        orderBy: { createdAt: 'desc' }
      });
      console.log(`[Dialogflow] Fallback: Using most recent order for phone ${cleanPhone}`);
    }

    const shopDomain = recentOrder?.shop || "unknown-shop";

    // 5. Save EVERY reply into the CustomerReply table
    await prisma.customerReply.create({
      data: {
        shop: shopDomain,
        orderId: recentOrder?.id || null,
        customerPhone: cleanPhone,
        messageType: "DIALOGFLOW_INTENT",
        messageBody: queryText,
        rawPayload: reqBody,
        isProcessed: false
      }
    });
    console.log(`[DB] Saved customer reply: "${queryText}" from ${cleanPhone}`);

    // =================================================================
    // 6. INTENT ROUTING (The 3 Core Flows)
    // =================================================================

    // NEW: Check if the order is already cancelled before we process ANY buttons
    const isOrderCancelled = recentOrder?.cancelledAt || recentOrder?.financialStatus === "voided" || recentOrder?.fulfillmentStatus === "cancelled";

    // --- FLOW 1: ORDER CONFIRMED (Generates Token & Sends Edit Link) ---
    if (intentName === "Order_Confirmed" && recentOrder) {
      // Catch already cancelled orders!
      if (isOrderCancelled) {
        console.log(`[Dialogflow] Blocked confirmation because order is already cancelled: ${recentOrder.shopifyOrderId}`);
        return Response.json({
          fulfillmentText: "This order has already been cancelled, so we cannot confirm it. Please place a new order if you'd still like to purchase these items! 🛍️"
        });
      }

      // Check if already confirmed cross-platform
      if (recentOrder.confirmToken && recentOrder.confirmToken.startsWith("WEB_USED_")) {
        console.log(`[Dialogflow] Blocked confirmation because order is already confirmed via email: ${recentOrder.shopifyOrderId}`);
        return Response.json({
          fulfillmentText: "You have already confirmed this order via email! ✅"
        });
      }
      if (recentOrder.confirmToken && recentOrder.confirmToken.startsWith("WA_USED_")) {
        console.log(`[Dialogflow] Blocked confirmation because order is already confirmed via WhatsApp: ${recentOrder.shopifyOrderId}`);
        return Response.json({
          fulfillmentText: "You have already confirmed this order via WhatsApp! ✅"
        });
      }

      console.log(`[Dialogflow] Processing Order_Confirmed for ${cleanPhone}`);

      // Generate or Fetch the edit token
      let editToken = recentOrder.addressEditToken;

      // Update the confirmToken to mark it as WA_USED so email links show the correct UI
      const updatedConfirmToken = markTokenAsUsed(recentOrder.confirmToken, 'WA_USED_');

      if (!editToken) {
        editToken = crypto.randomUUID();
      }

      await prisma.shopify_store_order.update({
        where: { id: recentOrder.id },
        data: {
          addressEditToken: editToken,
          confirmToken: updatedConfirmToken
        }
      });
      console.log(`[Dialogflow] Updated tokens for Order_Confirmed on ${recentOrder.shopifyOrderId}`);

      // Construct Data for WhatsApp
      const addressParts = [
        recentOrder.shippingAddress1,
        recentOrder.shippingAddress2,
        recentOrder.shippingCity,
        recentOrder.shippingProvince,
        recentOrder.shippingZip
      ].filter(Boolean);

      const fullAddress = addressParts.length > 0 ? addressParts.join(', ') : "Address not provided";
      const safeName = recentOrder.firstName || aiSensyPayload?.AiSensyName || "Customer";

      const templateData = {
        customerName: safeName,
        shippingAddress: fullAddress,
        editUrl: editToken,
        orderId: recentOrder.shopifyOrderId,  // Include orderId for accurate event tracking
        localOrderId: recentOrder.id
      };

      console.log('[Dialogflow] Template data being sent:', templateData);

      const notificationService = new NotificationService();
      await notificationService.sendWhatsAppNotification({
        shop: shopDomain,
        recipient: cleanPhone,
        templateId: WHATSAPP_TEMPLATES.RSM_ADDRESS_VERIFY || 'rsm_address_verification',
        templateData,
        orderId: recentOrder.shopifyOrderId,  // Track which order this notification belongs to
        localOrderId: recentOrder.id
      });

      console.log(`[WHATSAPP] Sent Address Verify template to ${cleanPhone} with token ${editToken}`);
    }

    // --- FLOW 2: CONFIRM ADDRESS (No Edits Needed) ---
    else if (intentName === "CONFIRM ADDRESS" && recentOrder) {
      // Catch already cancelled orders!
      if (isOrderCancelled) {
        console.log(`[Dialogflow] Blocked address confirm because order is already cancelled: ${recentOrder.shopifyOrderId}`);
        return Response.json({
          fulfillmentText: "This order has already been cancelled, so we cannot update or confirm it. Please place a new order if you'd still like to purchase these items! 🛍️"
        });
      }

      // Check if already verified cross-platform
      if (recentOrder.addressEditToken && recentOrder.addressEditToken.startsWith("WEB_USED_")) {
        console.log(`[Dialogflow] Blocked address confirm because address is already verified via email: ${recentOrder.shopifyOrderId}`);
        return Response.json({
          fulfillmentText: "You have already verified your address via email! ✅"
        });
      }
      if (recentOrder.addressEditToken && recentOrder.addressEditToken.startsWith("WA_USED_")) {
        console.log(`[Dialogflow] Blocked address confirm because address is already verified via WhatsApp: ${recentOrder.shopifyOrderId}`);
        return Response.json({
          fulfillmentText: "You have already verified your address via WhatsApp! ✅"
        });
      }

      console.log(`[Dialogflow] Processing Address_Confirmed for ${cleanPhone} | OrderID: ${recentOrder.shopifyOrderId}`);

      try {
        // A. Mark as verified in local database and prefix token
        await prisma.shopify_store_order.update({
          where: { id: recentOrder.id },
          data: {
            addressVerified: true,
            addressEditToken: markTokenAsUsed(recentOrder.addressEditToken, 'WA_USED_')
          }
        });

        // B. Add a tag in Shopify so the merchant knows it's verified
        await addTagToShopifyOrder(shopDomain, recentOrder.shopifyOrderId, "Address: Verified");
        console.log(`[Dialogflow] Address verified for order ${recentOrder.shopifyOrderId}`);

        // C. FIX: Skip the adapter and let Dialogflow reply directly!
        return Response.json({
          fulfillmentText: "Thank you! Your address is confirmed and your order is now being processed for dispatch. 🚚"
        });

      } catch (confirmError) {
        console.error("[Dialogflow] Failed to process address confirmation:", confirmError);
        return Response.json({
          fulfillmentText: "We received your confirmation, but there was a slight delay updating the system. We will process it shortly."
        });
      }
    }

    // --- FLOW 3: CANCEL ORDER ---
    else if (intentName === "CANCEL ORDER" && recentOrder) {
      // Catch already cancelled orders (prevents errors if they click cancel twice!)
      if (isOrderCancelled) {
        console.log(`[Dialogflow] Blocked double-cancel. Order is already cancelled: ${recentOrder.shopifyOrderId}`);

        let viaMsg = "";
        if (recentOrder.cancelToken && recentOrder.cancelToken.startsWith("WEB_USED_")) {
          viaMsg = " via email";
        } else if (recentOrder.cancelToken && recentOrder.cancelToken.startsWith("WA_USED_")) {
          viaMsg = " via WhatsApp";
        }

        return Response.json({
          fulfillmentText: `Your order has already been successfully cancelled${viaMsg}! Have a great day. ✅`
        });
      }

      console.log(`[Dialogflow] Processing Order_Cancel for ${cleanPhone} | OrderID: ${recentOrder.shopifyOrderId}`);

      try {
        // A. Cancel the order in Shopify
        await cancelShopifyOrder(shopDomain, recentOrder.shopifyOrderId);
        console.log(`[Dialogflow] Successfully cancelled order ${recentOrder.shopifyOrderId} in Shopify`);

        // B. Update local PostgreSQL database
        await prisma.shopify_store_order.update({
          where: { id: recentOrder.id },
          data: {
            financialStatus: "voided",
            fulfillmentStatus: "cancelled",
            cancelledAt: new Date(),
            cancelToken: markTokenAsUsed(recentOrder.cancelToken, 'WA_USED_'),
            confirmToken: null,
            addressEditToken: null
          }
        });
        console.log(`[Dialogflow] Updated local DB for order ${recentOrder.shopifyOrderId}`);

        // C. FIX: Just return the text. Dialogflow will automatically send it to WhatsApp!
        return Response.json({
          fulfillmentText: "Your order has been successfully cancelled. If you have any questions, please contact support. Have a great day!"
        });

      } catch (cancelError) {
        console.error("[Dialogflow] Failed to cancel order in Shopify:", cancelError);
        return Response.json({
          fulfillmentText: "We received your cancellation request, but it requires manual approval. Our team will process it shortly."
        });
      }
    }

    // 7. Return standard Dialogflow response
    return Response.json({
      fulfillmentText: "Webhook processed successfully."
    });

  } catch (error) {
    console.error("[Dialogflow Webhook Error]:", error);
    return Response.json({ fulfillmentText: "Error processing request." }, { status: 500 });
  }
};