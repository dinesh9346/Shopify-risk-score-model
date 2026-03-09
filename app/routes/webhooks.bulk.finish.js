import { authenticate } from "../shopify.server";
// 1. Bring back your traffic cop!
import { enqueueWebhook } from "../models/queue.server"; 

export const action = async ({ request }) => {
  try {
    // We only need topic, shop, and payload to pass to the queue
    const { topic, shop, payload } = await authenticate.webhook(request);

    console.log(`[WEBHOOK] ${topic} received from ${shop}`);

    if (topic === "BULK_OPERATIONS_FINISH") {
      console.log("[WEBHOOK] Bulk operation finished. Dropping into SQS Queue.");
      
      // 2. Safely throw the heavy lifting into the background
      await enqueueWebhook(topic, shop, payload);
    } else {
      console.log(`[WEBHOOK] Unhandled topic: ${topic}`);
    }

    // 3. Instantly tell Shopify "We got it!" so they never time out
    return new Response("Webhook queued successfully", { status: 200 });

  } catch (error) {
    console.error("[WEBHOOK] Processing error:", error);
    return new Response("Auth failed", { status: 200 });
  }
};

// import { authenticate } from "../shopify.server";
// import { handleBulkFinishWebhook } from "../models/bulkWebhook.server";
// export const action = async ({ request }) => {

//   const { topic, shop, payload, admin } =
//     await authenticate.webhook(request);

//   console.log(`[WEBHOOK] ${topic} received from ${shop}`);

//   try {

//     switch (topic) {

//       case "BULK_OPERATIONS_FINISH":

//         console.log("[WEBHOOK] Bulk operation finished");
//         console.log("[WEBHOOK] Payload:", payload);

//         if (admin) {
//           await handleBulkFinishWebhook(admin, payload, shop);
//         } else {
//           console.warn("[WEBHOOK] Admin client unavailable for bulk operation");
//         }

//         break;

//       default:
//         console.log(`[WEBHOOK] Unhandled topic: ${topic}`);
//     }

//   } catch (error) {

//     console.error("[WEBHOOK] Processing error:", error);

//   }

//   return new Response("Webhook processed", { status: 200 });
// };