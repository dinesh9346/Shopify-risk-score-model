import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../models/queue.server"; 

export const action = async ({ request }) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);
    
    console.log(`[WEBHOOK ROUTE] Received ${topic} from Shopify for ${shop}`);

    // 1. Immediately drop the payload into the SQS queue
    await enqueueWebhook(topic, shop, payload);

    // 2. Return 200 OK to Shopify instantly so they don't timeout
    return new Response("Webhook queued successfully", { status: 200 });
    
  } catch (error) {
    console.error("Webhook authentication failed:", error);
    return new Response("Auth failed", { status: 200 }); 
  }
};