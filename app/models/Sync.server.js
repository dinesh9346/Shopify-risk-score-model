import prisma from "../db.server.js";
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
                  clientIp
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

                  shippingAddress {
                    address1
                    phone
                    countryCode
                  }

                  billingAddress {
                    countryCode
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

export async function buildHistoricalBuyerProfiles(shop) {
  console.log(`[BULK SYNC] Starting historical profile aggregation for ${shop}...`);

  const allOrders = await prisma.shopify_store_order.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" } 
  });

  const customerMap = new Map();

  allOrders.forEach((order) => {
    const safeEmail = order.customerEmail?.trim() || null;
    const safePhone = order.customerPhone?.trim() || null;
    const safeCustId = order.customerId?.trim() || null;
    const buyerIdentifier = safePhone || safeEmail || safeCustId || `guest-${order.shopifyOrderId}`;

    if (!customerMap.has(buyerIdentifier)) {
      customerMap.set(buyerIdentifier, {
        buyerIdentifier,
        customerEmail: safeEmail,
        customerPhone: safePhone,
        customerId: safeCustId,
        totalCheckoutAttempts: 0,
        validOrderCount: 0,
        totalSpend: 0,
        fulfilledCount: 0,
        cancelledCount: 0,
        rtoCount: 0,
        codCount: 0,
        unpaidCount: 0,
        disputeCount: 0,
        refundCount: 0,
      });
    }

    const profile = customerMap.get(buyerIdentifier);
    profile.totalCheckoutAttempts += 1;

    const isCod = order.paymentGateway?.toLowerCase().includes("cod") || order.paymentGateway?.toLowerCase().includes("cash");
    if (isCod) profile.codCount += 1;

    if (order.isRTO) profile.rtoCount += 1;
    else if (order.cancelledAt) profile.cancelledCount += 1;
    else if (order.fulfillmentStatus?.toUpperCase() === "FULFILLED") profile.fulfilledCount += 1;

    if (order.financialStatus?.toUpperCase() === "PENDING") profile.unpaidCount += 1;
    else if (["REFUNDED", "PARTIALLY_REFUNDED"].includes(order.financialStatus?.toUpperCase())) profile.refundCount += 1;

    if (order.hasDispute) profile.disputeCount += 1;

    const isPaid = order.financialStatus?.toUpperCase() === "PAID";
    const isFulfilled = order.fulfillmentStatus?.toUpperCase() === "FULFILLED";

    if (isPaid && isFulfilled && !order.hasDispute && !order.cancelledAt && !order.isRTO) {
      profile.validOrderCount += 1;
      profile.totalSpend += Number(order.orderValue || 0);
    }
  });

  for (const [identifier, profile] of customerMap.entries()) {
    let reasons = [];
    const total = profile.totalCheckoutAttempts;
    
    const cancelRate = total > 0 ? profile.cancelledCount / total : 0;
    const rtoRate = total > 0 ? profile.rtoCount / total : 0;
    const codRate = total > 0 ? profile.codCount / total : 0;

    if (profile.disputeCount > 0) reasons.push("Payment Dispute");
    if (profile.rtoCount >= 2 && rtoRate >= 0.2) reasons.push("Frequent RTO");
    if (profile.cancelledCount >= 5 || cancelRate >= 0.5) reasons.push("High Cancellation");
    if (total >= 10 && profile.validOrderCount === 0) reasons.push("Serial Abandoner (Bot)");
    if (codRate >= 0.8 && profile.rtoCount >= 1) reasons.push("COD Abuse Risk");

    let segment = "New";
    if (reasons.length > 0) segment = "High Risk";
    else if (profile.validOrderCount >= 3) segment = "VIP";
    else if (profile.validOrderCount >= 1) segment = "Repeat Buyer";
    
    try {
      await prisma.zippyy_buyer_profile.upsert({
        where: { shop_buyerIdentifier: { shop, buyerIdentifier: identifier } },
        update: { ...profile, buyerSegment: segment, riskReasons: reasons.join(", ") },
        create: { shop, ...profile, buyerSegment: segment, riskReasons: reasons.join(", ") }
      });
    } catch (err) {
      // 🔥 FIX: Added 'err.message' so we can see exactly why Prisma is mad
      console.error(`[BULK SYNC ERROR] Failed to save profile for ${identifier}:`, err.message);
    }
  }
  console.log(`✅ [BULK SYNC] Successfully built historical profiles for ${shop}`);
}
// export async function triggerBulkOrderSync(admin, shop) {
//   console.log(`[BULK SYNC] Starting bulk order sync for ${shop}`);

//   try {
//     const response = await admin.graphql(`
//       mutation {
//         bulkOperationRunQuery(
//           query: """
//           {
//             orders(first: 250) {
//               edges {
//                 node {
//                   id
//                   email
//                   cancelledAt
//                   displayFinancialStatus
//                   displayFulfillmentStatus
//                   paymentGatewayNames
//                   totalPriceSet {
//                     shopMoney {
//                       amount
//                     }
//                   }
//                   customer {
//                     id
//                     firstName
//                     lastName
//                     phone
//                   }
//                 }
//               }
//             }
//           }
//           """
//         ) {
//           bulkOperation {
//             id
//             status
//           }
//           userErrors {
//             field
//             message
//           }
//         }
//       }
//     `);

//     const json = await response.json();

//     console.log("[BULK SYNC RESPONSE]", JSON.stringify(json, null, 2));

//     if (!json.data?.bulkOperationRunQuery) {
//       console.error("[BULK SYNC] Invalid response structure:", json);
//       return;
//     }

//     if (json.data.bulkOperationRunQuery.userErrors.length > 0) {
//       console.error(
//         "[BULK SYNC] Errors:",
//         json.data.bulkOperationRunQuery.userErrors
//       );
//       return;
//     }

//     console.log(
//       `[BULK SYNC] Operation Started:`,
//       json.data.bulkOperationRunQuery.bulkOperation.id
//     );

//   } catch (error) {
//     console.error(`[BULK SYNC] Failed to start bulk sync`, error);
//   }
// }