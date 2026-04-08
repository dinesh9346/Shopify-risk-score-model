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

// NEW: Enqueue lifecycle stage notifications (PAYMENT_CONFIRMED, DELIVERED, etc.)
export async function enqueueLifecycleNotification(shop, orderId, stage, orderData = {}) {
  const safeShop = shop || "unknown-shop";
  const safeOrderId = orderId ? orderId.replace(/[^0-9]/g, '') : "unknown-id";

  const params = {
    QueueUrl: OUTBOUND_QUEUE_URL,
    MessageBody: JSON.stringify({
      taskType: "LIFECYCLE_UPDATE",
      shop,
      orderId,
      stage, // e.g., "PAYMENT_CONFIRMED", "IN_TRANSIT", "DELIVERED", "ORDER_CANCELLED", "ORDER_REFUNDED"
      orderData, // Contains customer info, tracking data, etc.
      timestamp: new Date().toISOString()
    }),
    MessageGroupId: safeShop,
    MessageDeduplicationId: `lifecycle-${safeOrderId}-${stage}-${Date.now()}`
  };

  try {
    await sqsClient.send(new SendMessageCommand(params));
    console.log(` [LIFECYCLE PRODUCER] Queued ${stage} notification for ${orderId}`);
  } catch (error) {
    console.error(` [LIFECYCLE PRODUCER ERROR] Failed to queue ${stage}:`, error);
    throw error;
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

          // ROUTE 1: PUSH RISK SCORE TO SHOPIFY

          if (taskType === "RISK_PUSH") {
            console.log(` [OUTBOUND CONSUMER] Pushing Risk Score for ${payload.orderId}...`);
            await pushRiskToShopify(payload.shop, payload.orderId, payload.riskLevel, payload.riskFacts);
          } 
          
          
          // ROUTE 2: SEND NOTIFICATIONS 
     
          else if (taskType === "NOTIFICATION") {
            const { shop, orderId, phone, email, customerName, riskLevel, isCod } = payload;
            const orderValue = payload.orderValue ?? 0;
            console.log(` [OUTBOUND CONSUMER] Sending Notifications for ${orderId} | Risk: ${riskLevel}`);
            
            const safeName = customerName || "Customer";
            const cleanOrderId = orderId.split('/').pop();
            const tasks = [];

            // 🚨 FORCED EMAIL TEMPLATE TEST 🚨
            if (email) {
              console.log("--> FIRING SENDGRID TEMPLATE TEST <--");
              tasks.push(notificationService.sendEmailNotification({
                shop, 
                recipient: email,
                // Using the exact ID from your company's JSON for IN shipment_created
                templateId: 'd-aa96a93348b34b0ca20c10795f4cd2be', 
                
                templateData: {
                  customer_name: safeName, 
                  order_id: cleanOrderId,
                  tracking_url: `https://${shop}/apps/zippyy/track` // Mock data
                }
              }));
            }

             if (phone) {
              console.log("--> FIRING WHATSAPP SHIPMENT BOOKED NOTIFICATION <--");
              tasks.push(notificationService.sendWhatsAppNotification({
                shop,
                recipient: phone,
                templateId: WHATSAPP_TEMPLATES.SHIPMENT_CREATED,
                templateData: {
                  customerName: safeName,
                  orderId: cleanOrderId,
                  productDetails: payload.productDetails || "Order Items",
                  orderType: isCod ? "COD" : "Prepaid",
                  orderAmount: payload.orderValue || 0,
                  sellerCompanyName: payload.sellerCompanyName || "Zippyy",
                },
                customerName: safeName,
              }));
            }

            // --- 1. LOW RISK (Standard Confirmation) ---
            if (riskLevel === "LOW") {
               console.log("[Test Mode] Order is LOW risk. Shipment booked WhatsApp sent.");
            }
            // --- 2. MEDIUM RISK (COD Verification) ---
            else if (riskLevel === "MEDIUM") {
              if (isCod) {
                if (email) {
                  const confirmUrl = `https://${shop}/api/confirm-cod?orderId=${cleanOrderId}&phone=${phone}`;
                  tasks.push(notificationService.sendEmailNotification({
                    shop, recipient: email,
                    subject: `Action Required: Verify Your Order (#${cleanOrderId})`,
                    text: `Hi ${safeName},\n\nWe received your COD order. Please click the link below to confirm so we can ship it out:\n\n${confirmUrl}`,
                  }));
                }
              }
            }
            // --- 3. HIGH RISK (Alert / Fraud Warning) ---
            else if (riskLevel === "HIGH") {
              if (email) tasks.push(notificationService.sendEmailNotification({
                shop, recipient: email,
                subject: `Important Update regarding your Order (#${cleanOrderId})`,
                text: `Hi ${safeName},\n\nOur system flagged an issue verifying your order details. To avoid cancellation, please reply to this email or contact support to confirm your shipping address.`,
              }));
            }

            // Execute all identified notification tasks
            await Promise.allSettled(tasks);
          }

          // ROUTE 3: SEND LIFECYCLE STAGE NOTIFICATIONS (NEW)
          else if (taskType === "LIFECYCLE_UPDATE") {
            const { shop, orderId, stage, orderData } = payload;
            const customerEmail = orderData?.customerEmail;
            const customerPhone = orderData?.customerPhone;
            const customerName = orderData?.customerName || "Customer";
            
            const cleanOrderId = orderId.split('/').pop();
            const tasks = [];

            console.log(` [LIFECYCLE CONSUMER] Processing ${stage} for ${cleanOrderId}`);

            // Map each lifecycle stage to notification handlers
            switch (stage) {
              case "PAYMENT_CONFIRMED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Payment Confirmed for Order #${cleanOrderId}`,
                    text: `Hi ${customerName},\n\nWe've received your payment. Your order is being prepared for shipment.\n\nOrder ID: ${cleanOrderId}`
                  }));
                }
                if (customerPhone) {
                  tasks.push(notificationService.sendWhatsAppNotification({
                    shop,
                    recipient: customerPhone,
                    templateId: WHATSAPP_TEMPLATES.ORDER_CONFIRMATION,
                    templateData: {
                      customerName,
                      orderId: cleanOrderId
                    }
                  }));
                }
                break;

              case "ORDER_FULLY_PACKED":
              case "SHIPMENT_CREATED":
                if (customerPhone) {
                  tasks.push(notificationService.sendWhatsAppNotification({
                    shop,
                    recipient: customerPhone,
                    templateId: WHATSAPP_TEMPLATES.SHIPMENT_CREATED,
                    templateData: {
                      customerName,
                      orderId: cleanOrderId,
                      productDetails: orderData?.productDetails || "Order Items",
                      orderType: orderData?.orderType || "Standard",
                      orderAmount: orderData?.orderAmount || 0,
                      sellerCompanyName: orderData?.sellerCompanyName || "Zippyy"
                    }
                  }));
                }
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Your Order #${cleanOrderId} is Being Shipped`,
                    text: `Hi ${customerName},\n\nYour order is being packed and will ship soon. Track it using the link in your account.`
                  }));
                }
                break;

              case "IN_TRANSIT":
                if (customerPhone) {
                  tasks.push(notificationService.sendWhatsAppNotification({
                    shop,
                    recipient: customerPhone,
                    templateId: WHATSAPP_TEMPLATES.SHIPMENT_IN_TRANSIT,
                    templateData: {
                      customerName,
                      orderId: cleanOrderId,
                      trackingNumber: orderData?.trackingNumber || "N/A",
                      trackingUrl: orderData?.trackingUrl || ""
                    }
                  }));
                }
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Order #${cleanOrderId} is In Transit`,
                    text: `Hi ${customerName},\n\nYour order is on its way! Tracking: ${orderData?.trackingNumber || "Available in your account"}`
                  }));
                }
                break;

              case "OUT_FOR_DELIVERY":
                if (customerPhone) {
                  tasks.push(notificationService.sendWhatsAppNotification({
                    shop,
                    recipient: customerPhone,
                    templateId: WHATSAPP_TEMPLATES.SHIPMENT_OUT_FOR_DELIVERY_COD,
                    templateData: {
                      customerName,
                      orderId: cleanOrderId
                    }
                  }));
                }
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Order #${cleanOrderId} - Out for Delivery Today!`,
                    text: `Hi ${customerName},\n\nYour order is out for delivery today. Please be available to receive it.`
                  }));
                }
                break;

              case "DELIVERED":
                if (customerPhone) {
                  tasks.push(notificationService.sendWhatsAppNotification({
                    shop,
                    recipient: customerPhone,
                    templateId: WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED,
                    templateData: {
                      customerName,
                      orderId: cleanOrderId,
                      productDetails: orderData?.productDetails || "Order Items",
                      orderType: orderData?.orderType || "Standard",
                      sellerCompanyName: orderData?.sellerCompanyName || "Zippyy",
                      trackingId: orderData?.trackingId || "N/A"
                    }
                  }));
                }
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Order #${cleanOrderId} Delivered!`,
                    text: `Hi ${customerName},\n\nYour order has been successfully delivered. Thank you for your purchase!`
                  }));
                }
                break;

              case "ORDER_CANCELLED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Order #${cleanOrderId} Has Been Cancelled`,
                    text: `Hi ${customerName},\n\nYour order has been cancelled. Reason: ${orderData?.cancelReason || "Unknown"}\n\nPlease contact support if you have questions.`
                  }));
                }
                break;

              case "ORDER_REFUNDED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Refund Processed for Order #${cleanOrderId}`,
                    text: `Hi ${customerName},\n\nA refund of ${orderData?.refundAmount || "N/A"} has been processed. It may take 5-7 business days to reflect in your account.`
                  }));
                }
                break;

              case "ORDER_PARTIALLY_SHIPPED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Part of Your Order #${cleanOrderId} Has Shipped`,
                    text: `Hi ${customerName},\n\nPart of your order has been shipped. The remaining items will ship separately soon.`
                  }));
                }
                break;

              case "ORDER_RESTOCKED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Order #${cleanOrderId} Status Update`,
                    text: `Hi ${customerName},\n\nYour order items have been restocked and will be shipped shortly.`
                  }));
                }
                break;

              default:
                console.log(`[LIFECYCLE CONSUMER] No handler for stage: ${stage}`);
            }

            // Execute all lifecycle notification tasks
            await Promise.allSettled(tasks);
          }

          // If successful (any route), delete the message!
          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: OUTBOUND_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle,
          }));
          console.log(` [OUTBOUND CONSUMER] Success! Deleted ${taskType} from AWS.`);
        } catch (error) {
          console.error(" [OUTBOUND PROCESSING ERROR]", error.message);
        }
      }
    } catch (error) {
      console.error("[OUTBOUND NETWORK ERROR] Polling failed. Retrying in 5 seconds...", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}