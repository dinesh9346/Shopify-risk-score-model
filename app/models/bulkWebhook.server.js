import prisma from "../db.server";
import readline from "readline";
import { Readable } from "stream";

export async function handleBulkFinishWebhook(admin, payload, shop) {

  if (!payload || !payload.admin_graphql_api_id) {
    console.log("No bulk operation ID found in payload");
    return;
  }

  // IDEMPOTENCY CHECK: Prevent reprocessing the same bulk operation
  const operationId = payload.admin_graphql_api_id;
  const cacheKey = `bulk_${shop}_${operationId}`;
  
  // Simple in-memory cache to prevent duplicate processing within 30 seconds
  if (!global.processedBulkOps) {
    global.processedBulkOps = {};
  }
  
  if (global.processedBulkOps[cacheKey]) {
    const timeSinceLastProcess = Date.now() - global.processedBulkOps[cacheKey];
    if (timeSinceLastProcess < 30000) {
      console.log(`[BULK IDEMPOTENCY] Bulk operation ${operationId} already processed ${timeSinceLastProcess}ms ago. Skipping.`);
      return;
    }
  }

  // Mark as processing NOW to catch concurrent requests
  global.processedBulkOps[cacheKey] = Date.now();

  console.log("[BULK] Checking bulk operation status");

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

  await processBulkOrders(operation.url, shop);
}



async function processBulkOrders(fileUrl, shop) {

  const response = await fetch(fileUrl);

  if (!response.body) {
    throw new Error("Bulk file empty");
  }

  const stream = Readable.fromWeb(response.body);

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  let batch = [];
  let total = 0;

  for await (const line of rl) {

    let record;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (!record.id) continue;

    const primaryGateway = record.paymentGatewayNames?.[0] || null;

    const isReturned =
      record.displayFulfillmentStatus === "RETURNED";

    const orderData = {
      shop,
      shopifyOrderId: record.id,
      customerId: record.customer?.id || null,
      customerEmail: record.email || null,
      customerPhone: record.customer?.phone || null,
      orderValue: parseFloat(
        record.totalPriceSet?.shopMoney?.amount || "0"
      ),
      financialStatus: record.displayFinancialStatus,
      fulfillmentStatus: record.displayFulfillmentStatus,
      cancelledAt: record.cancelledAt
        ? new Date(record.cancelledAt)
        : null,
      paymentGateway: primaryGateway,
      isRTO: isReturned
    };

    batch.push(orderData);

    if (batch.length >= 500) {

      await saveBatch(batch);

      total += batch.length;

      console.log(`[BULK] Synced ${total} orders`);

      batch = [];
    }
  }

  if (batch.length > 0) {

    await saveBatch(batch);

    total += batch.length;
  }

  console.log(`[BULK COMPLETE] Total Orders Synced: ${total}`);
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