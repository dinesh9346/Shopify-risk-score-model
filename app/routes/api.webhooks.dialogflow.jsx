import { PrismaClient } from '@prisma/client';
import { NotificationService } from "../models/notification.server.js";
import { WHATSAPP_TEMPLATES } from "../config/templates.js";

const prisma = new PrismaClient();

// In Remix, POST requests must be handled by an exported 'action' function
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

    // 6. If the intent is "Order_Confirmed", send the Address Verify Template
    if (intentName === "Order_Confirmed" && recentOrder) {
      console.log(`[Dialogflow] Processing Order_Confirmed for ${cleanPhone}`);
      
      // ---> GENERATE OR FETCH THE EDIT TOKEN <---
      let editToken = recentOrder.addressEditToken;
      if (!editToken) {
        editToken = crypto.randomUUID(); 
        await prisma.shopify_store_order.update({
          where: { id: recentOrder.id },
          data: { addressEditToken: editToken }
        });
        console.log(`[Dialogflow] Generated NEW token for order ${recentOrder.shopifyOrderId}: ${editToken}`);
      }
      
      // ---> CONSTRUCT DATA FOR WHATSAPP <---
      // Note: We send the editToken as the 'editUrl' value. 
      // The WhatsApp Button in the dashboard appends this to the base URL automatically.
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

    // 7. Return standard Dialogflow response
    return Response.json({
      fulfillmentText: "Webhook processed successfully."
    });

  } catch (error) {
    console.error("[Dialogflow Webhook Error]:", error);
    return Response.json({ fulfillmentText: "Error processing request." }, { status: 500 });
  }
};








// export const action = async ({ request }) => {
//   if (request.method !== "POST") {
//     return Response.json({ message: "Method not allowed" }, { status: 405 });
//   }

//   try {
//     const payload = await request.json();
//     console.log("[Dialogflow Webhook] Received:", payload);
    
//     // Handle Dialogflow webhook logic here
    
//     return Response.json({ fulfillmentText: "Response text" });
//   } catch (error) {
//     console.error("[Dialogflow Webhook Error]", error);
//     return Response.json({ error: error.message }, { status: 400 });
//   }
// };