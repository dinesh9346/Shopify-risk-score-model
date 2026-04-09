

import { enqueueWebhook } from "../models/queue.server.js";

export const action = async ({ request }) => {
  // 1. Safety check
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const payload = await request.json();

    // 2. Validate it's a message (simple check)
    if (!payload.from) {
      return response.json({ error: "Invalid payload" }, { status: 400 });
    }

    // 3. Queue the task
    // We use a specific topic so our SQS router knows this is an inbound reply
    await enqueueWebhook("WHATSAPP_INBOUND_REPLY", "whatsapp-system", payload);

    // 4. Respond to MyOperator immediately
    return response.json({ success: true });
  } catch (error) {
    console.error("[Webhook Error]:", error);
    return response.json({ error: "Internal Server Error" }, { status: 500 });
  }
};