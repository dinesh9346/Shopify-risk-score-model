import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { NotificationService } from "../models/notification.server.js";
import { WHATSAPP_TEMPLATES } from "../config/templates.js";
// 1. IMPORT YOUR DEDICATED SERVICE FILES
import { handleBulkFinishWebhook } from "./bulkWebhook.server.js";
import { calculateAndApplyRiskScore } from "./riskAssessment.server.js";
import { processOrderUpdate } from "./orderUpdate.server.js";
import {syncCustomerProfile}  from "./orderUpdate.server.js";
import { pushRiskToShopify } from "./pushRiskScore.server.js";
import { processFulfillmentUpdate } from "./fulfillmentUpdate.server.js";
import { processDisputeUpdate } from "./disputeUpdate.server.js";
const QUEUE_URL = process.env.SQS_QUEUE_URL || "https://sqs.us-west-1.amazonaws.com/571109166839/apac-shopify-data-collection-queue-dev.fifo";

const sqsClient = new SQSClient({
  region: "us-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});


// 1. THE PRODUCER: Pushes webhooks to the SQS FIFO Queue
 
export async function enqueueWebhook(topic, shop, payload) {
  const params = {
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify({ topic, shop, data: payload, timestamp: new Date().toISOString() }),
    MessageGroupId: shop, 
    
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
  if (process.env.NODE_ENV !== "production" && global.__inboundWorkerStarted) {
    console.log(" [SQS CONSUMER] Worker already running. Skipping duplicate start.");
    return; 
  }
  global.__inboundWorkerStarted = true;
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
    case "CUSTOMERS_UPDATE":
      console.log(`[SQS ROUTER] Routing to Customer Update logic for ${shop}`);
      // CUSTOMERS_UPDATE payload is the customer object, so passing payload directly is correct here
      await syncCustomerProfile(shop, payload);
      break;
    
    case "DISPUTES_CREATE":
    case "DISPUTES_UPDATE":
      console.log(`[SQS ROUTER] Routing to Dispute Update logic for ${shop}`);
      await processDisputeUpdate(topic,shop, payload);
      break;

    case 'BULK_OPERATIONS_FINISH':
      console.log(`[SQS ROUTER] Routing to Bulk Sync logic for ${shop}`);
      await handleBulkFinishWebhook(shop, payload); 
      break;
    case 'FULFILLMENTS_CREATE':
    case 'FULFILLMENTS_UPDATE':
    case 'FULFILLMENT_EVENTS_CREATE':
    case 'RETURNS_UPDATE':
    case 'RETURNS_CLOSE':
    case 'REFUNDS_CREATE': 
      console.log(`[SQS ROUTER] Routing to Fulfillment Update logic for ${shop}`);
      await processFulfillmentUpdate(topic, shop, payload);
      break;

    default:
      console.log(` [SQS ROUTER WARNING] No routing defined for topic: ${topic}`);
  }
}

// Grab the new URL from your environment variables
const OUTBOUND_QUEUE_URL = process.env.OUTBOUND_SQS_QUEUE_URL;
export async function enqueueOutboundRisk(shop, orderId, riskScore, riskLevel, riskFacts) { 
  const safeShop = shop || "unknown-shop"; 
  const safeOrderId = orderId ? orderId.replace(/[^0-9]/g, '') : "unknown-id";

  const params = {
    QueueUrl: OUTBOUND_QUEUE_URL,
    MessageBody: JSON.stringify({ 
      taskType: "RISK_PUSH", // <--- ADD THIS LINE
      shop, orderId, riskScore, riskLevel, riskFacts, timestamp: new Date().toISOString() 
    }),
    MessageGroupId: safeShop, 
    MessageDeduplicationId: `risk-${safeOrderId}-${Date.now()}` 
  };

  try {
    await sqsClient.send(new SendMessageCommand(params));
    console.log(` [OUTBOUND PRODUCER] Queued Risk Push for ${orderId}`);
  } catch (error) {
    console.error(` [OUTBOUND PRODUCER ERROR] Failed to queue risk push:`, error);
    throw error; 
  }
}
export async function enqueueNotification(shop, orderId, phone, email, customerName, riskLevel, isCod, orderValue) {
  const safeShop = shop || "unknown-shop"; 
  const safeOrderId = orderId ? orderId.replace(/[^0-9]/g, '') : "unknown-id";

  const params = {
    QueueUrl: OUTBOUND_QUEUE_URL, // <--- Using your existing queue
    MessageBody: JSON.stringify({ 
      taskType: "NOTIFICATION", // <--- THE TRAFFIC TAG
      shop, orderId, phone, email, customerName, riskLevel, isCod, orderValue, timestamp: new Date().toISOString() 
    }),
    MessageGroupId: safeShop, 
    MessageDeduplicationId: `notify-${safeOrderId}-${Date.now()}` 
  };

  try {
    await sqsClient.send(new SendMessageCommand(params));
    console.log(` [NOTIFICATION PRODUCER] Queued Notification for ${orderId}`);
  } catch (error) {
    console.error(` [NOTIFICATION PRODUCER ERROR] Failed to queue notification:`, error);
  }
}
export async function startOutboundQueueListener() {
  if (process.env.NODE_ENV !== "production" && global.__outboundWorkerStarted) {
    console.log(" [OUTBOUND CONSUMER] Worker already running. Skipping duplicate start.");
    return; 
  }
  global.__outboundWorkerStarted = true;
  
  const notificationService = new NotificationService(); // Initialize the service

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
        
        // Default to RISK_PUSH just in case there are old messages stuck in the queue right now
        const taskType = payload.taskType || "RISK_PUSH"; 
        
        try {
          // =====================================
          // ROUTE 1: PUSH RISK SCORE TO SHOPIFY
          // =====================================
          if (taskType === "RISK_PUSH") {
            console.log(` [OUTBOUND CONSUMER] Pushing Risk Score for ${payload.orderId}...`);
            await pushRiskToShopify(payload.shop, payload.orderId, payload.riskLevel, payload.riskFacts);
          } 
          
          // =====================================
          // ROUTE 2: SEND NOTIFICATIONS (ALL RISK LEVELS)
          // =====================================
          else if (taskType === "NOTIFICATION") {
            const { shop, orderId, phone, email, customerName, riskLevel, isCod } = payload;
            const orderValue = payload.orderValue ?? 0; // Default to 0 if undefined (handles old queue messages)
            console.log(` [OUTBOUND CONSUMER] Sending Notifications for ${orderId} | Risk: ${riskLevel}`);
            
            const safeName = customerName || "Customer";
            const tasks = [];

            // --- 1. LOW RISK (Standard Confirmation) ---
            if (riskLevel === "LOW") {
              if (email) tasks.push(notificationService.sendEmailNotification({
                shop, recipient: email,
                subject: `Your Zippyy Order is Confirmed! (#${orderId})`,
                text: `Hi ${safeName},\n\nThank you for shopping with us! We've received your order and are packing it right now. We'll send tracking details soon!`,
              }));
              if (phone) tasks.push(notificationService.sendWhatsAppNotification({
                shop, recipient: phone,
                templateId: 'in_shipment_created',
                templateData: {
                  customerName: safeName,
                  orderId: orderId.split('/').pop(),
                },
                customerName: safeName,
              }));
            } 
            
            // --- 2. MEDIUM RISK (COD Verification) ---
            else if (riskLevel === "MEDIUM") {
              if (isCod) {
                if (email) {
                  const confirmUrl = `https://${shop}/api/confirm-cod?orderId=${orderId.split('/').pop()}&phone=${phone}`;
                  tasks.push(notificationService.sendEmailNotification({
                    shop, recipient: email,
                    subject: `Action Required: Verify Your Order (#${orderId})`,
                    text: `Hi ${safeName},\n\nWe received your COD order. Please click the link below to confirm so we can ship it out:\n\n${confirmUrl}`,
                  }));
                }
                if (phone) tasks.push(notificationService.sendWhatsAppNotification({
                  shop, recipient: phone,
                  message: `Hi ${safeName}! We received your COD order #${orderId.split('/').pop()}. Please reply with 'YES' to confirm.`,
                  customerName: safeName,
                }));
              } else {
                // If it's Medium Risk but ALREADY PAID, just send a confirmation
                if (phone) tasks.push(notificationService.sendWhatsAppNotification({
                   shop, recipient: phone,
                   message: `Hi ${safeName}! Your Zippyy order #${orderId.split('/').pop()} is confirmed and being processed.`,
                   customerName: safeName,
                }));
              }
            }

            // --- 3. HIGH RISK (Alert / Fraud Warning) ---
            else if (riskLevel === "HIGH") {
              if (email) tasks.push(notificationService.sendEmailNotification({
                shop, recipient: email,
                subject: `Important Update regarding your Order (#${orderId})`,
                text: `Hi ${safeName},\n\nOur system flagged an issue verifying your order details. To avoid cancellation, please reply to this email or contact support to confirm your shipping address.`,
              }));
              
              if (phone) tasks.push(notificationService.sendWhatsAppNotification({
                shop, recipient: phone,
                message: `Hi ${safeName}! Your Zippyy order #${orderId.split('/').pop()} requires verification. Our team will contact you shortly.`,
                customerName: safeName,
              }));
            }

            // Execute all identified notification tasks
            await Promise.allSettled(tasks);
          }

          // If successful (either route), delete the message!
          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: OUTBOUND_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle,
          }));
          console.log(` [OUTBOUND CONSUMER] Success! Deleted ${taskType} from AWS.`);
          
        } catch (taskError) {
          console.error(` [OUTBOUND TASK ERROR] Failed to process ${taskType}:`, taskError.message);
        }
      }
    } catch (error) {
      console.error(" [OUTBOUND NETWORK ERROR]", error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}