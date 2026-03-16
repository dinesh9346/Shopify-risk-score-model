import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";

// 1. IMPORT YOUR DEDICATED SERVICE FILES
import { handleBulkFinishWebhook } from "./bulkWebhook.server.js";
import { calculateAndApplyRiskScore } from "./riskAssessment.server.js";
import { processOrderUpdate } from "./orderUpdate.server.js";
import { pushRiskToShopify } from "./pushRiskScore.server.js";
import { processFulfillmentUpdate } from "./fulfillmentUpdate.server.js";
const QUEUE_URL = process.env.SQS_QUEUE_URL || "https://sqs.us-west-1.amazonaws.com/571109166839/apac-shopify-data-collection-queue-dev";

const sqsClient = new SQSClient({
  region: "us-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});


 // 1. THE PRODUCER: Pushes webhooks to the SQS Queue
 
export async function enqueueWebhook(topic, shop, payload) {
  const params = {
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify({ topic, shop, data: payload, timestamp: new Date().toISOString() }),
  };

  try {
    const command = new SendMessageCommand(params);
    const response = await sqsClient.send(command);
    console.log(` [SQS PRODUCER] Success: Queued ${topic} for ${shop} | MessageID: ${response.MessageId}`);
  } catch (error) {
    console.error(` [SQS PRODUCER ERROR] Failed to queue ${topic} for ${shop}:`, error);
  }
}

 // 2. THE CONSUMER: Background loop polling SQS and saving to the database

export async function startQueueListener() {
  console.log(" [SQS CONSUMER] Background worker started. Listening for messages...");

  while (true) {
    try {
      const receiveParams = {
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20, // Long polling
      };

      const { Messages } = await sqsClient.send(new ReceiveMessageCommand(receiveParams));

      if (!Messages || Messages.length === 0) {
        continue; // No messages, loop again
      }

      console.log(` [SQS CONSUMER] Received ${Messages.length} messages. Processing...`);

      for (const message of Messages) {
        // Extract 'data' from the SQS message body
        const { topic, shop, data } = JSON.parse(message.Body);
        
        console.log(`[SQS CONSUMER] Processing routing for ${topic} -> ${shop}`);

        try {
          // Send to the router
          await processDatabaseLogic(topic, shop, data);

          // If operation succeeds, delete from queue so it doesn't repeat
          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle,
          }));
          
          console.log(`[SQS CONSUMER] Deleted processed message for ${topic} -> ${shop}`);
          
        } catch (dbError) {
          console.error(`[SQS LOGIC ERROR] Operation failed for ${topic}. Message kept in queue for retry.`, dbError);
        }
      }
    } catch (error) {
      console.error("[SQS NETWORK ERROR] Polling failed. Retrying in 5 seconds...", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}


 // 3. THE ROUTER: Maps webhook topics to their dedicated service files


async function processDatabaseLogic(topic, shop, payload) { 
  switch (topic) {
    case 'ORDERS_CREATE':
      console.log(`[SQS ROUTER] Routing to Risk Assessment for ${shop}`);
      await calculateAndApplyRiskScore(shop, payload);
      break;

    case 'ORDERS_UPDATED':
      console.log(`[SQS ROUTER] Routing to Order Update logic for ${shop}`);
      await processOrderUpdate(shop, payload);
      break;
    
    case "DISPUTES_CREATE":
    case "DISPUTES_UPDATE":
      console.log(`[SQS ROUTER] Routing to Dispute Update logic for ${shop}`);
      await processDisputeUpdate(shop, payload);
      break;

    case 'BULK_OPERATIONS_FINISH':
      console.log(`[SQS ROUTER] Routing to Bulk Sync logic for ${shop}`);
      await handleBulkFinishWebhook(shop, payload); 
      break;
    case 'FULFILLMENTS_CREATE':
    case 'FULFILLMENTS_UPDATE':
      console.log(`[SQS ROUTER] Routing to Fulfillment Update logic for ${shop}`);
      await processFulfillmentUpdate(shop, payload);
      break;

    default:
      console.log(` [SQS ROUTER WARNING] No routing defined for topic: ${topic}`);
  }
}

// Grab the new URL from your environment variables
const OUTBOUND_QUEUE_URL = process.env.OUTBOUND_SQS_QUEUE_URL;

export async function enqueueOutboundRisk(shop, orderId, riskScore, riskLevel, riskFacts) { 
  // Fallback just in case shop is empty
  const safeShop = shop || "unknown-shop"; 
  const safeOrderId = orderId ? orderId.replace(/[^0-9]/g, '') : "unknown-id";

  const params = {
    QueueUrl: OUTBOUND_QUEUE_URL,
    MessageBody: JSON.stringify({ 
      shop, 
      orderId, 
      riskScore, 
      riskLevel,
      riskFacts, 
      timestamp: new Date().toISOString() 
    }),
    MessageGroupId: safeShop, 
    MessageDeduplicationId: `${safeOrderId}-${Date.now()}` 
  };
 
  //  THE DEBUG LOGGER: Let's see what is actually going to AWS
  console.log("[DEBUG] Sending to AWS:", {
    url: params.QueueUrl,
    groupId: params.MessageGroupId,
    dedupId: params.MessageDeduplicationId
  });

  try {
    await sqsClient.send(new SendMessageCommand(params));
    console.log(` [OUTBOUND PRODUCER] Queued Risk Push for ${orderId}`);
  } catch (error) {
    console.error(` [OUTBOUND PRODUCER ERROR] Failed to queue risk push:`, error);
    throw error; 
  }
}
// 4. THE OUTBOUND CONSUMER: Listens to the outbound queue and pushes risk scores to Shopify in the background
export async function startOutboundQueueListener() {
  console.log(" [OUTBOUND CONSUMER]  checking AWS...");

  while (true) {
    try {
      const receiveParams = {
        QueueUrl: OUTBOUND_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      };

      const { Messages } = await sqsClient.send(new ReceiveMessageCommand(receiveParams));

      if (!Messages || Messages.length === 0) continue;

      for (const message of Messages) {
        const payload = JSON.parse(message.Body);
        console.log(` [OUTBOUND CONSUMER] Found message for order ${payload.orderId}. Pushing to Shopify...`);
        
        try {
          await pushRiskToShopify(payload.shop, payload.orderId, payload.riskLevel, payload.riskFacts);

          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: OUTBOUND_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle,
          }));
          console.log(` [OUTBOUND CONSUMER] Success! Deleted from AWS.`);
        } catch (apiError) {
          console.error(` [OUTBOUND API ERROR] Shopify rejected it:`, apiError.message);
        }
      }
    } catch (error) {
      console.error(" [OUTBOUND NETWORK ERROR]", error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}