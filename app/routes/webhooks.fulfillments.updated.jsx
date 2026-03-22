import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../models/queue.server";
export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "FULFILLMENTS_UPDATED") {
    console.log(`[WEBHOOK ROUTE] Received ${topic} from Shopify for ${shop}`);
    
    // Immediately push to SQS and free up the connection
    await enqueueWebhook(topic, shop, payload);
    console.log(`[SQS PRODUCER] Success: Queued ${topic} for ${shop}`);
  }

  return new Response();
}