import { PrismaClient } from '@prisma/client';
import { NotificationService } from "../models/notification.server.js";
import { WHATSAPP_TEMPLATES } from "../config/templates.js";
import { WhatsAppAdapter } from "../models/whatsapp-adapter.server.js"; 
import crypto from "crypto"; 

const prisma = new PrismaClient();

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
      // Only use notification if it was sent in the last 60 minutes
      const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      // Extract just the numeric part for flexible matching
      const phoneNumeric = cleanPhone.replace(/\D/g, '');
      
      // Find ALL recent notifications to check for multiple active orders
      const recentNotifications = await prisma.notification.findMany({
        where: {
          recipient: { 
            contains: phoneNumeric.substring(Math.max(0, phoneNumeric.length - 10)) 
          },
          orderId: { not: null },
          createdAt: { gte: sixtyMinutesAgo }
        },
        orderBy: { createdAt: 'desc' }
      });
      
      // Extract unique order IDs to see if there's a conflict
      const uniqueRecentOrderIds = [...new Set(recentNotifications.map(n => n.orderId))];

      if (uniqueRecentOrderIds.length > 1) {
        console.log(`[Dialogflow] CONFLICT: Multiple recent orders found for ${cleanPhone}. Prompting user to clarify.`);
        
        // Dynamically figure out what action the user was trying to take
        let actionWord = "confirm order"; 
        if (intentName.toUpperCase().includes("CANCEL") || queryText.toLowerCase().includes("cancel")) {
            actionWord = "cancel order";
        }

        // Return immediately to Dialogflow and ask the user to type the ID WITH the correct keyword!
        return Response.json({
          fulfillmentText: `We noticed you have multiple recent orders. To ensure we process the correct one, please reply with '${actionWord}' followed by your exact Order ID.\n\nExample: *${actionWord} 7836573958437*`
        });

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

      console.log(`[Dialogflow] Processing Order_Confirmed for ${cleanPhone}`);
      
      // Generate or Fetch the edit token
      let editToken = recentOrder.addressEditToken;
      if (!editToken) {
        editToken = crypto.randomUUID(); 
        await prisma.shopify_store_order.update({
          where: { id: recentOrder.id },
          data: { addressEditToken: editToken }
        });
        console.log(`[Dialogflow] Generated NEW token for order ${recentOrder.shopifyOrderId}: ${editToken}`);
      }
      
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

      console.log(`[Dialogflow] Processing Address_Confirmed for ${cleanPhone} | OrderID: ${recentOrder.shopifyOrderId}`);
      
      try {
        // A. Mark as verified in local database
        await prisma.shopify_store_order.update({
          where: { id: recentOrder.id },
          data: { 
            addressVerified: true,
            addressEditToken: null // Invalidate any edit links if they confirm it's correct
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
        return Response.json({
          fulfillmentText: "Your order has already been successfully cancelled! Have a great day."
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