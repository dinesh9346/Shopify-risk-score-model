// import prisma from "../db.server.js";
// import shopify from "../shopify.server.js";
// import readline from "readline";
// import { Readable } from "stream";
// import { buildHistoricalBuyerProfiles } from "./Sync.server.js"; 

// export async function handleBulkFinishWebhook(shop, payload) {

//   if (!payload || !payload.admin_graphql_api_id) {
//     console.log("No bulk operation ID found in payload");
//     return;
//   }

//   // IDEMPOTENCY CHECK
//   const operationId = payload.admin_graphql_api_id;
//   const cacheKey = `bulk_${shop}_${operationId}`;

//   if (!global.processedBulkOps) global.processedBulkOps = {};

//   if (global.processedBulkOps[cacheKey]) {
//     const timeSinceLastProcess = Date.now() - global.processedBulkOps[cacheKey];
//     if (timeSinceLastProcess < 30000) {
//       console.log(`[BULK IDEMPOTENCY] Bulk operation ${operationId} already processed ${timeSinceLastProcess}ms ago. Skipping.`);
//       return;
//     }
//   }

//   global.processedBulkOps[cacheKey] = Date.now();
//   console.log("[BULK] Checking bulk operation status");

//   // 2. GENERATE OFFLINE ADMIN: Build the GraphQL client for background tasks
//   const { admin } = await shopify.unauthenticated.admin(shop);

//   const response = await admin.graphql(`
//     query {
//       node(id: "${payload.admin_graphql_api_id}") {
//         ... on BulkOperation {
//           status
//           url
//         }
//       }
//     }
//   `);

//   const result = await response.json();
//   const operation = result?.data?.node;

//   if (!operation) {
//     console.log("[BULK] Bulk operation not found");
//     return;
//   }

//   if (operation.status !== "COMPLETED") {
//     console.log(`[BULK] Operation status: ${operation.status}`);
//     return;
//   }

//   if (!operation.url) {
//     console.log("[BULK] No file URL returned");
//     return;
//   }

//   console.log("[BULK] Downloading JSONL file");

//   // 3. WAIT for the raw orders to finish saving to the database completely
//   await processBulkOrders(operation.url, shop);

//   // 4. THE FIX: Placed inside the function safely!
//   console.log(`[BULK SYNC] Raw data saved. Firing Profile Aggregation...`);
//   await buildHistoricalBuyerProfiles(shop);
  
// }

// async function processBulkOrders(fileUrl, shop) {
//   const response = await fetch(fileUrl);
//   if (!response.body) throw new Error("Bulk file empty");

//   const stream = Readable.fromWeb(response.body);
//   const rl = readline.createInterface({
//     input: stream,
//     crlfDelay: Infinity
//   });

//   let batch = [];
//   let total = 0;
//   let firstRecordLogged = false;

//   for await (const line of rl) {
//     let record;
//     try {
//       record = JSON.parse(line);
//     } catch {
//       continue;
//     }

//     if (!record.id) continue;

//     if (!firstRecordLogged) {
//       console.log("[BULK SAMPLE RECORD]", JSON.stringify(record, null, 2));
//       firstRecordLogged = true;
//     }

//     const primaryGateway = record.paymentGatewayNames?.[0] || null;
//     const isReturned = record.displayFulfillmentStatus === "RETURNED";
    
//     // Evaluate if the historical order contains any disputes
//     const orderHasDispute = record.disputes && record.disputes.length > 0;

//     const orderData = {
//       shop: shop, 
//       shopifyOrderId: record.id,
//       customerId: record.customer?.id || null,
//       firstName: record.customer?.firstName || null,
//       lastName: record.customer?.lastName || null,
//       customerEmail: record.email || null,
//       customerPhone: record.shippingAddress?.phone || record.customer?.phone || null,
//       ipAddress: record.clientIp || null,
//       shippingAddress1: record.shippingAddress?.address1 || null,
//       shippingCountry: record.shippingAddress?.countryCode || null,
//       billingCountry: record.billingAddress?.countryCode || null,
//       orderValue: parseFloat(record.totalPriceSet?.shopMoney?.amount || "0"),
//       financialStatus: record.displayFinancialStatus,
//       fulfillmentStatus: record.displayFulfillmentStatus,
//       cancelledAt: record.cancelledAt ? new Date(record.cancelledAt) : null,
//       paymentGateway: primaryGateway,
//       isRTO: isReturned,
//       hasDispute: orderHasDispute 
//     };

//     batch.push(orderData);

//     if (batch.length >= 500) {
//       await saveBatch(batch);
//       total += batch.length;
//       console.log(`[BULK] Synced ${total} orders`);
//       batch = [];
//     }
//   }

//   if (batch.length > 0) {
//     await saveBatch(batch);
//     total += batch.length;
//   }

//   console.log(`[BULK COMPLETE] Total Orders Synced: ${total}`);
// }

// async function saveBatch(batch) {
//   await prisma.$transaction(
//     batch.map(order =>
//       prisma.shopify_store_order.upsert({
//         where: {
//           shop_shopifyOrderId: {
//             shop: order.shop,
//             shopifyOrderId: order.shopifyOrderId
//           }
//         },
//         update: order,
//         create: order
//       })
//     )
//   );
// }


import prisma from "../db.server.js";
import shopify from "../shopify.server.js";
import readline from "readline";
import { Readable } from "stream";
import { buildHistoricalBuyerProfiles } from "./Sync.server.js"; 

export async function handleBulkFinishWebhook(shop, payload) {

  if (!payload || !payload.admin_graphql_api_id) {
    console.log("No bulk operation ID found in payload");
    return;
  }

  // IDEMPOTENCY CHECK
  const operationId = payload.admin_graphql_api_id;
  const cacheKey = `bulk_${shop}_${operationId}`;

  if (!global.processedBulkOps) global.processedBulkOps = {};

  if (global.processedBulkOps[cacheKey]) {
    const timeSinceLastProcess = Date.now() - global.processedBulkOps[cacheKey];
    // Increased to 10 minutes to prevent aggressive SQS retries from duplicating the sync
    if (timeSinceLastProcess < 600000) { 
      console.log(`[BULK IDEMPOTENCY] Bulk operation ${operationId} already processed ${timeSinceLastProcess}ms ago. Skipping.`);
      return;
    }
  }

  global.processedBulkOps[cacheKey] = Date.now();
  console.log("[BULK] Checking bulk operation status");

  // 2. GENERATE OFFLINE ADMIN: Build the GraphQL client for background tasks
  const { admin } = await shopify.unauthenticated.admin(shop);

  const response = await admin.graphql(`
    query {
      node(id: "${payload.admin_graphql_api_id}") {
        ... on BulkOperation {
          status
          url
        }
      }
    }
  `);

  const result = await response.json();
  const operation = result?.data?.node;

  if (!operation) {
    console.log("[BULK] Bulk operation not found");
    return;
  }

  if (operation.status !== "COMPLETED") {
    console.log(`[BULK] Operation status: ${operation.status}`);
    return;
  }

  if (!operation.url) {
    console.log("[BULK] No file URL returned");
    return;
  }

  console.log("[BULK] Downloading JSONL file");

  // 3. WAIT for the raw orders to finish saving to the database completely
  await processBulkOrders(operation.url, shop);

  // 4. Fire Profile Aggregation
  console.log(`[BULK SYNC] Raw data saved. Firing Profile Aggregation...`);
  await buildHistoricalBuyerProfiles(shop);
}

async function processBulkOrders(fileUrl, shop) {
  const response = await fetch(fileUrl);
  if (!response.body) throw new Error("Bulk file empty");

  const stream = Readable.fromWeb(response.body);
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  let batch = [];
  let total = 0;
  let firstRecordLogged = false;

  // Variables to group a parent order with its child nodes (line items, fulfillments)
  let currentOrder = null;
  let currentLineItems = [];
  let currentFulfillments = [];

  // Helper function to format and save the aggregated order object
  const processCurrentOrder = async () => {
    if (!currentOrder || !currentOrder.id) return;

    const primaryGateway = currentOrder.paymentGatewayNames?.[0] || null;
    const orderHasDispute = currentOrder.disputes && currentOrder.disputes.length > 0;
    
    // RTO Logic
    const hasRtoTag = currentOrder.tags ? currentOrder.tags.includes("RTO") : false;
    const isReturned = currentOrder.displayFulfillmentStatus === "RETURNED" || hasRtoTag;

    // Tracking Data extraction (handles both inline arrays and separate lines)
    let fulfillment = currentOrder.fulfillments && currentOrder.fulfillments.length > 0 
      ? currentOrder.fulfillments[0] 
      : (currentFulfillments.length > 0 ? currentFulfillments[0] : null);
      
    const trackingInfo = fulfillment?.trackingInfo?.[0] || {};

    const orderData = {
      shop: shop, 
      shopifyOrderId: currentOrder.id,
      createdAt: currentOrder.createdAt ? new Date(currentOrder.createdAt) : new Date(),
      customerId: currentOrder.customer?.id || null,
      firstName: currentOrder.customer?.firstName || null,
      lastName: currentOrder.customer?.lastName || null,
      customerEmail: currentOrder.email || null,
      customerPhone: currentOrder.shippingAddress?.phone || currentOrder.customer?.phone || null,
      ipAddress: currentOrder.clientIp || null,
      
      // Full Shipping Address
      shippingAddress1: currentOrder.shippingAddress?.address1 || null,
      shippingAddress2: currentOrder.shippingAddress?.address2 || null,
      shippingCity: currentOrder.shippingAddress?.city || null,
      shippingProvince: currentOrder.shippingAddress?.province || null,
      shippingZip: currentOrder.shippingAddress?.zip || null,
      shippingCountry: currentOrder.shippingAddress?.countryCode || null,
      
      // Full Billing Address
      billingAddress1: currentOrder.billingAddress?.address1 || null,
      billingAddress2: currentOrder.billingAddress?.address2 || null,
      billingCity: currentOrder.billingAddress?.city || null,
      billingProvince: currentOrder.billingAddress?.province || null,
      billingZip: currentOrder.billingAddress?.zip || null,
      billingCountry: currentOrder.billingAddress?.countryCode || null,

      orderValue: parseFloat(currentOrder.totalPriceSet?.shopMoney?.amount || "0"),
      financialStatus: currentOrder.displayFinancialStatus,
      fulfillmentStatus: currentOrder.displayFulfillmentStatus,
      
      // Tracking & Fulfillment Data
      carrier: trackingInfo.company || null,
      trackingNumber: trackingInfo.number || null,
      trackingUrl: trackingInfo.url || null,
      shipmentStatus: fulfillment?.displayStatus || null,
      
      // Stringify the aggregated line items for your @db.Text column
      lineItemsData: currentLineItems.length > 0 ? JSON.stringify(currentLineItems) : null,

      cancelledAt: currentOrder.cancelledAt ? new Date(currentOrder.cancelledAt) : null,
      paymentGateway: primaryGateway,
      isRTO: isReturned,
      hasDispute: orderHasDispute 
    };

    batch.push(orderData);

    // BATCH SIZE LOWERED TO 250 to ensure DB connections don't time out
    if (batch.length >= 250) {
      await saveBatch(batch);
      total += batch.length;
      console.log(`[BULK] Synced ${total} actual orders`);
      batch = [];
    }
  };

  for await (const line of rl) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (!firstRecordLogged) {
      console.log("[BULK SAMPLE RECORD]", JSON.stringify(record, null, 2));
      firstRecordLogged = true;
    }

    // 1. Is this a child node? (Line Item or Fulfillment)
    // Shopify bulk children ALWAYS have a __parentId.
    if (record.__parentId) {
      if (record.id && record.id.includes("LineItem")) {
        currentLineItems.push({
          id: record.id,
          title: record.title,
          sku: record.sku,
          quantity: record.quantity,
          price: record.originalTotalSet?.shopMoney?.amount || "0"
        });
      } else if (record.id && record.id.includes("Fulfillment")) {
        currentFulfillments.push(record);
      }
      continue; // CRITICAL: Skip to the next line so we don't treat this as an order
    }

    // 2. Is this a brand new Order node? (Root nodes have NO __parentId)
    if (!record.__parentId && record.id && record.id.includes("Order")) {
      // If we were already building an order, save it first!
      if (currentOrder) {
        await processCurrentOrder();
      }
      // Start fresh for the new order
      currentOrder = record;
      currentLineItems = [];
      currentFulfillments = [];
    }
  }

  // 3. Don't forget to process the very last order in the file!
  if (currentOrder) {
    await processCurrentOrder();
  }

  if (batch.length > 0) {
    await saveBatch(batch);
    total += batch.length;
  }

  console.log(`[BULK COMPLETE] Total Actual Orders Synced: ${total}`);
}

async function saveBatch(batch) {
  await prisma.$transaction(
    batch.map(order =>
      prisma.shopify_store_order.upsert({
        where: {
          shop_shopifyOrderId: {
            shop: order.shop,
            shopifyOrderId: order.shopifyOrderId
          }
        },
        update: order,
        create: order
      })
    )
  );
}