import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { NotificationService } from "../models/notification.server.js";
import crypto from "crypto";
import prisma from "../db.server"; // Adjust path if your db.server.js is somewhere else
// 1. IMPORT YOUR DEDICATED SERVICE FILES
import { generateAndSendMerchantReport } from "../utils/merchantReport.server.js";
import { handleBulkFinishWebhook } from "./bulkWebhook.server.js";
import { calculateAndApplyRiskScore } from "./riskAssessment.server.js";
import { processOrderUpdate } from "./orderUpdate.server.js";
import {syncCustomerProfile}  from "./orderUpdate.server.js";
import { pushRiskToShopify } from "./pushRiskScore.server.js";
import { processFulfillmentUpdate } from "./fulfillmentUpdate.server.js";
import { processDisputeUpdate } from "./disputeUpdate.server.js";
import { WHATSAPP_TEMPLATES, EMAIL_TEMPLATES } from "../config/templates.js";
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

// Grab the new URLs from your environment variables
const OUTBOUND_QUEUE_URL = process.env.OUTBOUND_SQS_QUEUE_URL;
const NOTIFICATION_QUEUE_URL = process.env.NOTIFICATION_SQS_QUEUE_URL;


// This stays FIFO, so we keep MessageGroupId and MessageDeduplicationId
export async function enqueueOutboundRisk(shop, orderId, riskScore, riskLevel, riskFacts) { 
  const safeShop = shop || "unknown-shop"; 
  const safeOrderId = orderId ? orderId.replace(/[^0-9]/g, '') : "unknown-id";

  const params = {
    QueueUrl: OUTBOUND_QUEUE_URL, 
    MessageBody: JSON.stringify({ 
      taskType: "RISK_PUSH", 
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

// Standard Queue: Removed MessageGroupId & MessageDeduplicationId
export async function enqueueNotification(shop, orderId, phone, email, customerName, riskLevel, isCod, orderValue) {
  const params = {
    QueueUrl: NOTIFICATION_QUEUE_URL, 
    MessageBody: JSON.stringify({ 
      taskType: "NOTIFICATION", 
      shop, orderId, phone, email, customerName, riskLevel, isCod, orderValue, timestamp: new Date().toISOString() 
    })
  };

  try {
    await sqsClient.send(new SendMessageCommand(params));
    console.log(` [NOTIFICATION PRODUCER] Queued Notification for ${orderId}`);
  } catch (error) {
    console.error(` [NOTIFICATION PRODUCER ERROR] Failed to queue notification:`, error);
  }
}

// Standard Queue: Removed MessageGroupId & MessageDeduplicationId
export async function enqueueLifecycleNotification(shop, orderId, stage, orderData = {}) {
  const params = {
    QueueUrl: NOTIFICATION_QUEUE_URL, 
    MessageBody: JSON.stringify({
      taskType: "LIFECYCLE_UPDATE",
      shop,
      orderId,
      stage, 
      orderData, 
      timestamp: new Date().toISOString()
    })
  };

  try {
    await sqsClient.send(new SendMessageCommand(params));
    console.log(` [LIFECYCLE PRODUCER] Queued ${stage} notification for ${orderId}`);
  } catch (error) {
    console.error(` [LIFECYCLE PRODUCER ERROR] Failed to queue ${stage}:`, error);
    throw error;
  }
}

// Standard Queue: Removed MessageGroupId & MessageDeduplicationId
export async function enqueueMerchantReport(shop, reportType = "weekly") {
  const params = {
    QueueUrl: NOTIFICATION_QUEUE_URL, 
    MessageBody: JSON.stringify({
      taskType: "MERCHANT_REPORT",
      shop,
      reportType, 
      timestamp: new Date().toISOString()
    })
  };

  try {
    await sqsClient.send(new SendMessageCommand(params));
    console.log(` [OUTBOUND PRODUCER] Queued ${reportType} report for ${shop}`);
  } catch (error) {
    console.error(` [OUTBOUND PRODUCER ERROR] Failed to queue report:`, error);
    throw error;
  }
}


// OUTBOUND CONSUMER for sending risk analysis result to shopify order detail page 

export async function startOutboundQueueListener() {
  if (process.env.NODE_ENV !== "production" && global.__outboundWorkerStarted) {
    console.log(" [OUTBOUND CONSUMER] Worker already running. Skipping duplicate start.");
    return; 
  }
  global.__outboundWorkerStarted = true;

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
        const taskType = payload.taskType || "RISK_PUSH"; 
        
        try {
          // ROUTE 1: PUSH RISK SCORE TO SHOPIFY
          if (taskType === "RISK_PUSH") {
            console.log(` [OUTBOUND CONSUMER] Pushing Risk Score for ${payload.orderId}...`);
            await pushRiskToShopify(payload.shop, payload.orderId, payload.riskLevel, payload.riskFacts);
            
            // Delete the message after successful processing
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: OUTBOUND_QUEUE_URL,
              ReceiptHandle: message.ReceiptHandle,
            }));
            console.log(` [OUTBOUND CONSUMER] Success! Deleted ${taskType} from AWS.`);
          }
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


// NOTIFICATION CONSUMER 

export async function startNotificationQueueListener() {
  if (process.env.NODE_ENV !== "production" && global.__notificationWorkerStarted) {
    console.log(" [NOTIFICATION CONSUMER] Worker already running. Skipping duplicate start.");
    return; 
  }
  global.__notificationWorkerStarted = true;
  
  const notificationService = new NotificationService(); // Initialize the service

  while (true) {
    try {
      const receiveParams = {
        QueueUrl: NOTIFICATION_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      };

      const { Messages } = await sqsClient.send(new ReceiveMessageCommand(receiveParams));

      if (!Messages || Messages.length === 0) continue;

      for (const message of Messages) {
        const payload = JSON.parse(message.Body);
        const taskType = payload.taskType; 
        
        try {
          
          // ROUTE : SEND LIFECYCLE STAGE NOTIFICATIONS
           if (taskType === "LIFECYCLE_UPDATE") {
            const { shop, orderId, stage, orderData } = payload;
            
            // 💡 ADD THIS DEBUG LOG TO SEE THE RAW DATA
            console.log(`[DEBUG] Consumer Data for ${stage}:`, JSON.stringify(orderData));

            // Fallback chain: Check orderData, then look at the root payload just in case
            const customerEmail = orderData?.customerEmail || payload?.email || null;
            const customerPhone = orderData?.customerPhone || payload?.phone || null;
            const customerName = orderData?.customerName || "Customer"; 
            const cleanOrderId = orderId.split('/').pop();
            const tasks = [];

            // --- BULLETPROOF SHOP NAME FORMATTER ---
            // Even if orderData tries to pass a raw .myshopify URL, this forces it clean.
            let rawShopName = orderData?.sellerCompanyName || shop;
            if (rawShopName && rawShopName.includes('.myshopify.com')) {
              rawShopName = rawShopName.replace('.myshopify.com', '').split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            }
            const finalCompanyName = rawShopName || "Our Store";

            console.log(` [LIFECYCLE CONSUMER] Processing ${stage} for ${cleanOrderId} | Shop: ${finalCompanyName}`);
            switch (stage) {
              case "ORDER_CONFIRMATION":
                if (customerPhone) {
                  tasks.push(notificationService.sendWhatsAppNotification({
                    shop,
                    recipient: customerPhone,
                    templateId: WHATSAPP_TEMPLATES.ORDER_CONFIRMATION,
                    templateData: {
                      customerName,
                      orderId: cleanOrderId,
                      productDetails: orderData?.productDetails || "Order Items",
                      orderAmount: orderData?.orderAmount || 0,
                      sellerCompanyName: finalCompanyName
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
                
                if (customerEmail) {
                  console.log(`[LIFECYCLE] Generating Email tokens and sending to: ${customerEmail}`);

                  // 1. Generate unique, secure tokens for this specific email
                  const confirmToken = crypto.randomUUID();
                  const cancelToken = crypto.randomUUID();

                  // 2. Save the tokens to the database so your web pages can recognize them later
                  try {
                    const actualOrder = await prisma.shopify_store_order.findFirst({
                      where: { 
                        shop: shop,
                        shopifyOrderId: { contains: cleanOrderId } 
                      }
                    });

                    if (actualOrder) {
                      await prisma.shopify_store_order.update({
                        where: { id: actualOrder.id },
                        data: { confirmToken, cancelToken }
                      });
                    }
                  } catch (dbErr) {
                    console.error("[LIFECYCLE] Error saving email tokens to DB:", dbErr);
                  }

                 // 3. Build the actual URLs that the customer will click in the email
                 // It will use your .env variable in production, but defaults to your ngrok tunnel for local testing!
                   const appBaseUrl = process.env.SHOPIFY_APP_URL || "https://bullhorn-raft-thinness.ngrok-free.dev";

                   const confirmUrl = `${appBaseUrl}/confirm-order/${confirmToken}`;
                   const cancelUrl = `${appBaseUrl}/cancel-order/${cancelToken}`;
                   
                  // 4. Fire off the email with SendGrid, passing the new URLs as dynamic variables!
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    templateId: "d-0f713822c6e849c8ba62a41d2ceb990d", 
                    templateData: {
                      customer_name: customerName,
                      customer_email: customerEmail,
                      order_number: cleanOrderId,
                      
                      // Data specifically for your new template body
                      product_details: orderData?.productDetails || "Order Items",
                      order_amount: orderData?.orderAmount || 0,
                      seller_company_name: finalCompanyName,
                      
                      // Buttons
                      confirm_url: confirmUrl,
                      cancel_url: cancelUrl
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                } else {
                  console.warn(`[LIFECYCLE WARNING] Skipped Email for ${cleanOrderId}: No email address found in payload.`);
                }
                break;
               

              case "PAYMENT_CONFIRMED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Payment Confirmed for Order #${cleanOrderId}`,
                    text: `Hi ${customerName},\n\nWe've received your payment. Your order is being prepared for shipment.\n\nOrder ID: ${cleanOrderId}`,
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
                if (customerPhone) {
                  tasks.push(notificationService.sendWhatsAppNotification({
                    shop,
                    recipient: customerPhone,
                    templateId: WHATSAPP_TEMPLATES.PAYMENT_CONFIRMATION,
                    templateData: {
                      customerName,
                      orderId: cleanOrderId,
                      sellerCompanyName: finalCompanyName
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
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
                      sellerCompanyName: finalCompanyName
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
               if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    templateId: EMAIL_TEMPLATES.SHIPMENT_CREATED,
                    templateData: {
                      customer_name: customerName,
                      customer_email: customerEmail,
                      order_number: cleanOrderId,
                      tracking_id: orderData?.trackingNumber || "", // Add trackingNumber to orderData if you have it!
                      carrier_name: orderData?.carrier || "Standard", 
                      tracking_url: orderData?.trackingUrl || "",
                      destination_address_name: customerName,
                      destination_address_city: orderData?.shippingCity || "",
                      destination_address_state: orderData?.shippingProvince || ""
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
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
                      customerName: customerName,                                 // {{1}}
                      orderId: cleanOrderId,                                      // {{2}}
                      productDetails: orderData?.productDetails || "Order Items", // {{3}}
                      orderType: orderData?.orderType || "Standard",              // {{4}}
                      orderAmount: orderData?.orderAmount || 0,                   // {{5}} 
                     // Pass the raw BlueDart/Delhivery URL directly into the text!
                      trackingUrl: orderData?.trackingUrl || "Link not generated yet", // {{6}}
                      sellerCompanyName: finalCompanyName,                        // {{7}}
                      
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    templateId: EMAIL_TEMPLATES.IN_TRANSIT,
                    templateData: {
                      customer_name: customerName,
                      order_number: cleanOrderId,
                      tracking_url: orderData?.trackingUrl || "Link not generated yet",
                      carrier_image_url: "https://track.zippyy.ai/default-carrier.png" // Fallback if needed
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
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
                      sellerCompanyName: finalCompanyName,
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    templateId: EMAIL_TEMPLATES.DELIVERED,
                    templateData: {
                      customer_name: customerName,
                      order_number: cleanOrderId,
                      tracking_url: orderData?.trackingUrl || "",
                      carrier_name: orderData?.carrier || "Standard",
                      deliveredDate: new Date().toLocaleDateString('en-GB')
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
                break;

              case "ORDER_CANCELLED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    templateId: EMAIL_TEMPLATES.CANCELLED,
                    templateData: {
                      customer_name: customerName,
                      order_number: cleanOrderId,
                      reason: orderData?.cancelReason || "Requested by customer"
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
                break;

              case "ORDER_REFUNDED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    templateId: EMAIL_TEMPLATES.REFUNDED,
                    templateData: {
                      customer_name: customerName,
                      order_number: cleanOrderId,
                      refund_amount: orderData?.refundAmount || "N/A"
                    },
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
                break;
              case "ORDER_PARTIALLY_SHIPPED":
                if (customerEmail) {
                  tasks.push(notificationService.sendEmailNotification({
                    shop,
                    recipient: customerEmail,
                    subject: `Part of Your Order #${cleanOrderId} Has Shipped`,
                    text: `Hi ${customerName},\n\nPart of your order has been shipped. The remaining items will ship separately soon.`,
                    orderId: orderId,
                    localOrderId: orderId.split('/').pop()
                  }));
                }
                break;

              default:
                console.log(`[LIFECYCLE CONSUMER] No handler for stage: ${stage}`);
            }

            await Promise.allSettled(tasks);
          }

          // ROUTE 4: GENERATE AND SEND MERCHANT REPORTS
          else if (taskType === "MERCHANT_REPORT") {
            const { shop, reportType } = payload;
            console.log(` [NOTIFICATION CONSUMER] Processing ${reportType} report for ${shop}`);
            await generateAndSendMerchantReport(shop, reportType);
          }

          // If successful (any route), delete the message!
          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: NOTIFICATION_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle,
          }));
          console.log(` [NOTIFICATION CONSUMER] Success! Deleted ${taskType} from AWS.`);
          
        } catch (error) {
          console.error(" [NOTIFICATION PROCESSING ERROR]", error.message);
        }
      }
    } catch (error) {
      console.error("[NOTIFICATION NETWORK ERROR] Polling failed. Retrying in 5 seconds...", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}


//  Start all queues with one command

export async function startAllQueues() {
  console.log("[SCHEDULER] Starting all SQS consumers...");
  
  // Start the inbound webhook listener
  startQueueListener().catch(err => console.error("Error in Inbound Listener:", err));
  
  // Start the outbound risk pusher
  startOutboundQueueListener().catch(err => console.error("Error in Outbound Risk Listener:", err));
  
  // Start the new notification and reports listener
  startNotificationQueueListener().catch(err => console.error("Error in Notification Listener:", err));
}

