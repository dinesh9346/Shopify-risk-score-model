import prisma from "../db.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ message: "Method not allowed" }, { status: 405 });
  }

  try {
    const payload = await request.json();
    console.log("[MyOperator Webhook] Received payload:", JSON.stringify(payload, null, 2));

    // MyOperator Webhooks can have different structures depending on the specific event.
    // We try to extract the most common fields defensively.
    let customerPhone = "";
    let messageBody = "";
    let messageType = "unknown";
    let providerMessageId = "";

    // A common structure might look like this:
    // { "data": { "message": { "from": "...", "text": { "body": "..." }, "id": "..." } } }
    
    // Attempt parsing standard structures
    const message = payload?.data?.message || payload?.message || payload;
    
    if (message?.from || message?.sender) {
      customerPhone = message.from || message.sender;
    } else if (payload?.contact?.phone) {
      customerPhone = payload.contact.phone;
    } else if (payload?.destination) {
       customerPhone = payload.destination;
    }

    if (message?.text?.body) {
      messageBody = message.text.body;
      messageType = "text";
    } else if (message?.body) {
      messageBody = message.body;
      messageType = "text";
    } else if (typeof message?.text === 'string') {
      messageBody = message.text;
      messageType = "text";
    } else if (message?.type) {
      messageType = message.type;
      messageBody = `[Received ${messageType} message]`;
    }

    providerMessageId = message?.id || message?.messageId || payload?.id || `webhook-${Date.now()}`;

    // Clean phone number to ensure it matches our DB format
    if (customerPhone) {
      customerPhone = String(customerPhone).replace(/\D/g, '');
    } else {
      console.warn("[MyOperator Webhook] Could not extract customer phone from payload. Skipping.");
      return Response.json({ success: true, message: "Payload ignored - missing phone" });
    }

    // Attempt to find the most recent order for this customer phone to link the reply
    const recentOrder = await prisma.shopify_store_order.findFirst({
      where: {
        customerPhone: {
          contains: customerPhone, // Handle cases where country code might be present/missing
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // We assume the first matching order shop is the shop we want to record this against.
    // If no order is found, we might fallback to a default shop or the one configured in ENV.
    const shop = recentOrder?.shop || process.env.SHOP_NAME || "unknown-shop";

    // Save to the database
    const newReply = await prisma.customerReply.create({
      data: {
        shop,
        orderId: recentOrder?.id || null,
        customerPhone,
        messageType,
        messageBody: messageBody || "No text content",
        providerMessageId,
        rawPayload: payload,
        isProcessed: false,
      }
    });

    console.log(`[MyOperator Webhook] Saved reply from ${customerPhone}: ${messageBody}`);

    return Response.json({ success: true, replyId: newReply.id });

  } catch (error) {
    console.error("[MyOperator Webhook] Error processing request:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
};
