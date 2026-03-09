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