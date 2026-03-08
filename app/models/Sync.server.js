

// import prisma from "../db.server";

// export async function syncHistoricalOrders(admin, shop) {
//   console.log(`Starting deep historical sync for ${shop}...`);

//   let hasNextPage = true;
//   let cursor = null;
//   let totalSynced = 0;

//   while (hasNextPage) {
//     try {
//       const response = await admin.graphql(
//         `#graphql
//         query GetOrders($cursor: String) {
//           orders(first: 250, after: $cursor, reverse: true) {
//             nodes {
//               id
//               email
//               totalPriceSet { shopMoney { amount } }
//               displayFinancialStatus
//               displayFulfillmentStatus
//               cancelledAt
//               paymentGatewayNames # 👈 NEW: Fetches things like "Cash on Delivery (COD)", "Stripe"
//               customer { 
//                 id
//                 firstName # 👈 NEW: Customer details
//                 lastName
//                 phone
//               }
//             }
//             pageInfo {
//               hasNextPage
//               endCursor
//             }
//           }
//         }`,
//         { variables: { cursor } }
//       );

//       const json = await response.json();

//       if (json.errors) {
//         console.error("GraphQL Errors:", JSON.stringify(json.errors, null, 2));
//         break; 
//       }

//       const orders = json.data?.orders?.nodes || [];
//       const pageInfo = json.data?.orders?.pageInfo;

//       if (orders.length === 0) break;

//       const upsertPromises = orders.map((order) => {
//         // Shopify returns an array of gateways. We'll grab the primary one (index 0).
//         const primaryGateway = order.paymentGatewayNames?.[0] || null;
        
//         // Basic RTO approximation for historical data
//         const isReturned = order.displayFulfillmentStatus === 'RETURNED';

//         return prisma.shopify_store_order.upsert({
//           where: { shopifyOrderId: order.id },
//           update: {
//             financialStatus: order.displayFinancialStatus,
//             fulfillmentStatus: order.displayFulfillmentStatus,
//             cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
//             paymentGateway: primaryGateway,
//             isRTO: isReturned,
//             // Update customer details in case they changed their name/phone
//             customerPhone: order.customer?.phone || null,
//           },
//           create: {
//             shop,
//             shopifyOrderId: order.id,
//             customerId: order.customer?.id || null, 
//             customerEmail: order.email || null,
//             customerPhone: order.customer?.phone || null,
//             orderValue: parseFloat(order.totalPriceSet?.shopMoney?.amount || "0"),
//             financialStatus: order.displayFinancialStatus,
//             fulfillmentStatus: order.displayFulfillmentStatus,
//             cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
//             paymentGateway: primaryGateway,
//             isRTO: isReturned,
//           }
//         });
//       });

//       await prisma.$transaction(upsertPromises);

//       totalSynced += orders.length;
//       console.log(`Synced ${totalSynced} orders so far...`);

//       hasNextPage = pageInfo?.hasNextPage;
//       cursor = pageInfo?.endCursor;

//     } catch (error) {
//       console.error(`Sync interrupted for ${shop}:`, error);
//       hasNextPage = false; 
//     }
//   }

//   console.log(`Deep sync complete! Total orders processed: ${totalSynced}`);
// }

export async function triggerBulkOrderSync(admin, shop) {
  console.log(`[BULK SYNC] Starting bulk order sync for ${shop}`);

  try {
    const response = await admin.graphql(`
      mutation {
        bulkOperationRunQuery(
          query: """
          {
            orders(first: 250) {
              edges {
                node {
                  id
                  email
                  cancelledAt
                  displayFinancialStatus
                  displayFulfillmentStatus
                  paymentGatewayNames
                  totalPriceSet {
                    shopMoney {
                      amount
                    }
                  }
                  customer {
                    id
                    firstName
                    lastName
                    phone
                  }
                }
              }
            }
          }
          """
        ) {
          bulkOperation {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `);

    const json = await response.json();

    console.log("[BULK SYNC RESPONSE]", JSON.stringify(json, null, 2));

    if (!json.data?.bulkOperationRunQuery) {
      console.error("[BULK SYNC] Invalid response structure:", json);
      return;
    }

    if (json.data.bulkOperationRunQuery.userErrors.length > 0) {
      console.error(
        "[BULK SYNC] Errors:",
        json.data.bulkOperationRunQuery.userErrors
      );
      return;
    }

    console.log(
      `[BULK SYNC] Operation Started:`,
      json.data.bulkOperationRunQuery.bulkOperation.id
    );

  } catch (error) {
    console.error(`[BULK SYNC] Failed to start bulk sync`, error);
  }
}