
import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../models/queue.server";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const allowedTopics = new Set([
    "FULFILLMENTS_CREATE",
    "FULFILLMENTS_UPDATE",
    "FULFILLMENT_EVENTS_CREATE",
    "RETURNS_UPDATE",
    "RETURNS_CLOSE",
    "REFUNDS_CREATE",
  ]);

  if (allowedTopics.has(topic)) {
    console.log(`[WEBHOOK ROUTE] Received ${topic} from Shopify for ${shop}`);
    await enqueueWebhook(topic, shop, payload);
    console.log(`[SQS PRODUCER] Success: Queued ${topic} for ${shop}`);
  }

  return new Response();
};
