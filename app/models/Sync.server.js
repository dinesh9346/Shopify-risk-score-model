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
//               customer { admin_graphql_api_id }
//             }
//             pageInfo {
//               hasNextPage
//               endCursor
//             }
//           }
//         }`,
//         { variables: { cursor } }
//       );

//       const { data } = await response.json();
//       const orders = data?.orders?.nodes || [];
//       const pageInfo = data?.orders?.pageInfo;

//       // Save this batch
//       for (const order of orders) {
//         await prisma.storeOrder.upsert({
//           where: { shopifyOrderId: order.id },
//           update: {},
//           create: {
//             shop,
//             shopifyOrderId: order.id,
//             customerId: order.customer?.admin_graphql_api_id,
//             customerEmail: order.email,
//             orderValue: parseFloat(order.totalPriceSet.shopMoney.amount),
//             financialStatus: order.displayFinancialStatus,
//             fulfillmentStatus: order.displayFulfillmentStatus,
//             cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
//           }
//         });
//       }

//       totalSynced += orders.length;
//       console.log(`Synced ${totalSynced} orders so far...`);

//       // Check if there are more orders to fetch
//       hasNextPage = pageInfo?.hasNextPage;
//       cursor = pageInfo?.endCursor;

//     } catch (error) {
//       console.error(`❌ Sync interrupted:`, error);
//       hasNextPage = false; // Stop the loop on error
//     }
//   }

//   console.log(`✅ Deep sync complete. Total orders in local DB: ${totalSynced}`);
// }



import prisma from "../db.server";

export async function syncHistoricalOrders(admin, shop) {
  console.log(`Starting deep historical sync for ${shop}...`);

  let hasNextPage = true;
  let cursor = null;
  let totalSynced = 0;

  while (hasNextPage) {
    try {
      const response = await admin.graphql(
        `#graphql
        query GetOrders($cursor: String) {
          orders(first: 250, after: $cursor, reverse: true) {
            nodes {
              id
              email
              totalPriceSet { shopMoney { amount } }
              displayFinancialStatus
              displayFulfillmentStatus
              cancelledAt
              customer { 
                id   # 👈 FIXED: Changed from admin_graphql_api_id
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
        { variables: { cursor } }
      );

      const { data } = await response.json();
      const orders = data?.orders?.nodes || [];
      const pageInfo = data?.orders?.pageInfo;

      // Save this batch
      for (const order of orders) {
        await prisma.storeOrder.upsert({
          where: { shopifyOrderId: order.id },
          update: {},
          create: {
            shop,
            shopifyOrderId: order.id,
            customerId: order.customer?.id || null, // 👈 FIXED HERE TOO
            customerEmail: order.email || null,
            orderValue: parseFloat(order.totalPriceSet?.shopMoney?.amount || "0"),
            financialStatus: order.displayFinancialStatus,
            fulfillmentStatus: order.displayFulfillmentStatus,
            cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
          }
        });
      }

      totalSynced += orders.length;
      console.log(`Synced ${totalSynced} orders so far...`);

      hasNextPage = pageInfo?.hasNextPage;
      cursor = pageInfo?.endCursor;

    } catch (error) {
      console.error(`❌ Sync interrupted:`, error);
      hasNextPage = false; 
    }
  }

  console.log(`✅ Deep sync complete. Total orders in local DB: ${totalSynced}`);
}