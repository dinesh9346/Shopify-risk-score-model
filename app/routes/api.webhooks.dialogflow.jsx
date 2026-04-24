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

// =====================================================================
// MAIN WEBHOOK ACTION HANDLER
// =====================================================================
export const action = async ({ request }) => {
  // 1. Ensure it's a POST request
  if (request.method !== "POST") {
    return Response.json({ message: "Method not allowed" }, { status: 405 });
  }

  try {
    // 2. Parse the incoming JSON from Dialogflow
    const reqBody = await request.json();
    
    // 3. Extract data from the Dialogflow / AiSensy Payload
    const intentName = reqBody.queryResult?.intent?.displayName; 
    const queryText = reqBody.queryResult?.queryText || "No Text"; 
    
    const aiSensyPayload = reqBody.originalDetectIntentRequest?.payload;
    const rawPhone = aiSensyPayload?.AiSensyMobileNumber; 
    
    if (!rawPhone) {
      console.log("[Dialogflow] No phone number in payload, skipping.");
      return Response.json({ fulfillmentText: "Ignored: No phone number." });
    }

    // Clean phone number (remove the '+' if present to match your DB)
    const cleanPhone = rawPhone.replace('+', '');

    // 4. Find the most recent order for this customer
    const recentOrder = await prisma.shopify_store_order.findFirst({
      where: { 
        customerPhone: { contains: cleanPhone.substring(2) } 
      },
      orderBy: { createdAt: 'desc' }
    });

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
    
    // --- FLOW 1: ORDER CONFIRMED (Generates Token & Sends Edit Link) ---
    if (intentName === "Order_Confirmed" && recentOrder) {
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
        editUrl: editToken 
      };

      console.log('[Dialogflow] Template data being sent:', templateData);

      const notificationService = new NotificationService();
      await notificationService.sendWhatsAppNotification({
        shop: shopDomain,
        recipient: cleanPhone,
        templateId: WHATSAPP_TEMPLATES.RSM_ADDRESS_VERIFY || 'rsm_address_verification', 
        templateData
      });
      
      console.log(`[WHATSAPP] Sent Address Verify template to ${cleanPhone} with token ${editToken}`);
    }

    // --- FLOW 2: CONFIRM ADDRESS (No Edits Needed) ---
    else if (intentName === "CONFIRM ADDRESS" && recentOrder) {
      console.log(`[Dialogflow] Processing Address_Confirmed for ${cleanPhone}`);
      
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
      console.log(`[Dialogflow] Processing Order_Cancel for ${cleanPhone}`);
      
      try {
        // A. Cancel the order in Shopify
        await cancelShopifyOrder(shopDomain, recentOrder.shopifyOrderId);

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






