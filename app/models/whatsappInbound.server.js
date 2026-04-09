

// models/whatsapp-logic.server.js
import prisma from "../db.server.js";

export async function handleWhatsAppReply(payload) {
  const phone = (payload.from || "").replace(/\D/g, '');
  const messageType = payload.type || "text";
  const rawBody = payload.interactive?.button_reply?.id || payload.text?.body || "";

  // 1. Find the order context
  const order = await prisma.shopify_store_order.findFirst({
    where: { customerPhone: { contains: phone } },
    orderBy: { createdAt: 'desc' },
  });

  if (!order) return;

  // 2. Record the reply in CustomerReply table
  await prisma.customerReply.create({
    data: {
      shop: order.shop,
      orderId: order.id,
      customerPhone: phone,
      messageType,
      messageBody: rawBody,
      providerMessageId: payload.id || `wa_${Date.now()}`,
      rawPayload: payload
    }
  });

  // 3. Process Intent (The "Future-Proof" part)
  const intent = rawBody.toUpperCase().trim();

  // CASE: Order Confirmation
  if (["CONFIRM", "YES", "CONFIRM_ORDER"].includes(intent)) {
    await prisma.shopify_store_order.update({
      where: { id: order.id },
      data: { 
        customerAccepted: true,
        customerAcceptedAt: new Date()
      }
    });
  }

  // FUTURE CASE: Order Cancellation
  if (intent === "CANCEL_ORDER") {
    // await handleCancellationRequest(order);
  }
  
  // FUTURE CASE: NDR Feedback
  if (intent.startsWith("REATTEMPT_")) {
    // await handleNDR(order, intent);
  }
}