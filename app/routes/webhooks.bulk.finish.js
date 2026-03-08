// import { authenticate } from "../shopify.server";
// import { handleBulkFinishWebhook } from "../models/bulkWebhook.server";

export const action = async ({ request }) => {

  const { topic, shop, payload, admin } =
    await authenticate.webhook(request);

  console.log(`[WEBHOOK] ${topic} received from ${shop}`);

  try {

    switch (topic) {

      case "BULK_OPERATIONS_FINISH":

        console.log("[WEBHOOK] Bulk operation finished");
        console.log("[WEBHOOK] Payload:", payload);

        if (admin) {
          await handleBulkFinishWebhook(admin, payload, shop);
        } else {
          console.warn("[WEBHOOK] Admin client unavailable for bulk operation");
        }

        break;

      default:
        console.log(`[WEBHOOK] Unhandled topic: ${topic}`);
    }

  } catch (error) {

    console.error("[WEBHOOK] Processing error:", error);

  }

  return new Response("Webhook processed", { status: 200 });
};