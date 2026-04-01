import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../models/queue.server"; 

console.log(" [WEBHOOK ROUTE] Webhook route loaded and ready to receive messages.");

export const action = async ({ request }) => {
  try {
    // 1. Authenticate the request (Throws an error if HMAC is invalid)
    const { topic, shop, payload } = await authenticate.webhook(request);
    console.log(`[WEBHOOK ROUTE] Received ${topic} from Shopify for ${shop}`);

    try {
      // 2. Attempt to drop the payload into the SQS queue
      await enqueueWebhook(topic, shop, payload);
    } catch (queueError) {
      //  If SQS fails, return 500 so Shopify RETRIES later
      console.error("[WEBHOOK ROUTE] SQS Queue Error:", queueError);
      return new Response("Internal Server Error - Queue Failed", { status: 500 });
    }

    // 3. Success! Return 200 OK instantly.
    return new Response("Webhook queued successfully", { status: 200 });
    
  } catch (authError) {
   
    console.error("[WEBHOOK ROUTE] Authentication failed:", authError);
    return new Response("Unauthorized", { status: 401 }); 
  }
};

