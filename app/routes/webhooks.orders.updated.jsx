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


// import { authenticate } from "../shopify.server";
// import prisma from "../db.server";

// export const action = async ({ request }) => {
//   // 1. Authenticate the incoming webhook
//   const { topic, shop, payload } = await authenticate.webhook(request);

//   if (topic === "ORDERS_UPDATED") {
//     console.log(` Order Updated webhook received for order: ${payload.id}`);

//     try {
//       // 2. Update the specific order in your local database
//       await prisma.shopify_store_order.updateMany({
//         where: { 
//           shopifyOrderId: payload.admin_graphql_api_id,
//           shop: shop
//         },
//         data: {
//           financialStatus: payload.financial_status,
//           fulfillmentStatus: payload.fulfillment_status,
//           cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
//         },
//       });
//       console.log(` Local Data Warehouse updated for order ${payload.id}`);
//     } catch (error) {
//       console.error(" Error updating local DB (Order might not exist yet):", error.message);
//     }
//   }

//   // Always return a 200 response so Shopify knows you received it
//   return new Response();
// };


