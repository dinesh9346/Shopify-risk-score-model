

// console.log("WEBHOOK FILE LOADED");

// import prisma from "../db.server";
// import { authenticate } from "../shopify.server";

// export const action = async ({ request }) => {
//   console.log("step 1 - webhook started");

//   let topic, shop, payload, admin;

//   try {
//     const auth = await authenticate.webhook(request);
//     topic = auth.topic;
//     shop = auth.shop;
//     payload = auth.payload;
//     admin = auth.admin;
//   } catch (error) {
//     console.error("Webhook authentication failed:", error);
//     return new Response("Auth failed", { status: 200 });
//   }

//   console.log("step 2 - webhook authenticated");

//   console.log("Order ID:", payload?.id);
//   console.log("Customer ID:", payload?.customer?.id);

//   if (!admin) {
//     console.error("Error: Admin context missing. Cannot execute GraphQL query.");
//     return new Response(); 
//   }

//   // 🔹 Fetch complete order history and cancellation stats via GraphQL
//   async function getCustomerOrderStats(admin, customerId) {
//     if (!admin || !customerId) return { cancelledCount: 0, totalOrders: 0 };

//     let hasNextPage = true;
//     let cursor = null;
//     let cancelledCount = 0;
//     let totalOrders = 0;

//     while (hasNextPage) {
//       const response = await admin.graphql(
//         `
//         query GetCustomerOrders($customerId: ID!, $cursor: String) {
//           customer(id: $customerId) {
//             orders(first: 50, after: $cursor) {
//               edges {
//                 cursor
//                 node {
//                   cancelledAt
//                 }
//               }
//               pageInfo {
//                 hasNextPage
//               }
//             }
//           }
//         }
//         `,
//         {
//           variables: {
//             customerId: `gid://shopify/Customer/${customerId}`,
//             cursor,
//           },
//         }
//       );

//       const data = await response.json();
//       const orders = data?.data?.customer?.orders?.edges || [];

//       // Count total actual orders found in history
//       totalOrders += orders.length;

//       // Count cancellations
//       cancelledCount += orders.filter(
//         (edge) => edge.node.cancelledAt !== null
//       ).length;

//       hasNextPage = data?.data?.customer?.orders?.pageInfo?.hasNextPage;

//       if (hasNextPage && orders.length > 0) {
//         cursor = orders[orders.length - 1].cursor;
//       } else {
//         hasNextPage = false;
//       }
//     }

//     return { cancelledCount, totalOrders };
//   }

//   const orderValue = parseFloat(payload.total_price);
//   const paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";
//   const customer = payload.customer;

//   let score = 0;
//   let reasons = [];

//   // 🔹 Order value scoring (Scores calculated, NO reasons printed)
//   if (orderValue > 5000) score += 3;
//   else if (orderValue > 1000) score += 2;
//   else score += 1;
  
//   // 🔹 Fetch Customer Stats
//   let cancellationPoints = 0;
//   let cancelledCount = 0;
//   let totalOrders = 0;

//   if (customer?.id) {
//     const stats = await getCustomerOrderStats(admin, customer.id);
//     cancelledCount = stats.cancelledCount;
//     totalOrders = stats.totalOrders;

//     if (cancelledCount >= 3) {
//       cancellationPoints = 4;
//       reasons.push(`This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`);
//     } else if (cancelledCount >= 1) {
//       cancellationPoints = 2;
//       reasons.push(`This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`);
//     }
//   }

//   // 🔹 Payment method scoring (Reason ONLY if COD)
//   if (paymentType.toLowerCase().includes("cod")) {
//     score += 3;
//     reasons.push(`The order is COD.`);
//   } else {
//     score += 1;
//   }

//   // 🔹 Customer scoring
//   if (!customer) {
//     score += 2; 
//     reasons.push(`Guest checkout (No customer ID).`);
//   } else {
//     // Using the reliable totalOrders from our GraphQL query
//     if (totalOrders <= 1) {
//       score += 2; 
//       reasons.push(`New customer (1st order).`);
//     }
//     if (totalOrders >= 5) {
//       score += -2; 
//       reasons.push(`Repeat buyer (${totalOrders} orders).`);
//     }
//   }

//   score += cancellationPoints;

//   let riskLevel = "LOW";
//   if (score >= 7) riskLevel = "HIGH";
//   else if (score >= 4) riskLevel = "MEDIUM";

//   // 🔹 Print the final result and reasons to the terminal
//   console.log(`\n=== RISK ASSESSMENT RESULT ===`);
//   console.log(`Risk Level: ${riskLevel}`);

  
//   console.log(`Reasons:`);
//   if (reasons.length > 0) {
//     reasons.forEach((reason) => console.log(`  - ${reason}`));
//   } else {
//     console.log(`  - No specific risk factors flagged.`);
//   }
//   console.log(`==============================\n`);

//   await prisma.riskScore.upsert({
//     where: { orderId: payload.id.toString() },
//     update: {
//       score,
//       riskLevel,
//       orderValue,
//       paymentType
//     },
//     create: {
//       shop,
//       orderId: payload.id.toString(),
//       customerId: customer?.id?.toString(),
//       orderValue,
//       paymentType,
//       score,
//       riskLevel
//     }
//   });

//   return new Response();
// };


console.log("WEBHOOK FILE LOADED");

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  console.log("step 1 - webhook started");

  let topic, shop, payload, admin;

  try {
    const auth = await authenticate.webhook(request);
    topic = auth.topic;
    shop = auth.shop;
    payload = auth.payload;
    admin = auth.admin;
  } catch (error) {
    console.error("Webhook authentication failed:", error);
    return new Response("Auth failed", { status: 200 });
  }

  if (!admin) {
    console.error("Error: Admin context missing. Cannot execute GraphQL query.");
    return new Response(); 
  }

  // 🔹 Fetch order history with correct GraphQL fields
  async function getCustomerOrderStats(admin, customerId) {
    if (!admin || !customerId) return { cancelledCount: 0, totalOrders: 0, completedCount: 0 };

    let hasNextPage = true;
    let cursor = null;
    let cancelledCount = 0;
    let totalOrders = 0;
    let completedCount = 0;

    while (hasNextPage) {
      const response = await admin.graphql(
        `
        query GetCustomerOrders($customerId: ID!, $cursor: String) {
          customer(id: $customerId) {
            orders(first: 50, after: $cursor) {
              edges {
                cursor
                node {
                  cancelledAt
                  displayFinancialStatus    # 👈 Corrected field name
                  displayFulfillmentStatus
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
        `,
        {
          variables: {
            customerId: `gid://shopify/Customer/${customerId}`,
            cursor,
          },
        }
      );

      const data = await response.json();
      const orders = data?.data?.customer?.orders?.edges || [];

      totalOrders += orders.length;

      // Evaluate every single order for strict completion
      orders.forEach((edge) => {
        const order = edge.node;
        
        if (order.cancelledAt !== null) {
          // It was cancelled
          cancelledCount += 1;
        } else if (
          order.displayFinancialStatus === "PAID" && 
          order.displayFulfillmentStatus === "FULFILLED"
        ) {
          // It was successfully paid AND successfully fulfilled
          completedCount += 1;
        }
      });

      hasNextPage = data?.data?.customer?.orders?.pageInfo?.hasNextPage;

      if (hasNextPage && orders.length > 0) {
        cursor = orders[orders.length - 1].cursor;
      } else {
        hasNextPage = false;
      }
    }

    return { cancelledCount, totalOrders, completedCount };
  }

  const orderValue = parseFloat(payload.total_price);
  const paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";
  const customer = payload.customer;

  let score = 0;
  let reasons = [];

  // 🔹 Order value scoring (Scores calculated, NO reasons printed)
  if (orderValue > 5000) score += 3;
  else if (orderValue > 1000) score += 2;
  else score += 1;
  
  // 🔹 Fetch Customer Stats
  let cancellationPoints = 0;
  let cancelledCount = 0;
  let totalOrders = 0;
  let completedCount = 0; 

  if (customer?.id) {
    const stats = await getCustomerOrderStats(admin, customer.id);
    cancelledCount = stats.cancelledCount;
    totalOrders = stats.totalOrders;
    completedCount = stats.completedCount; 

    if (cancelledCount >= 3) {
      cancellationPoints = 4;
      reasons.push(`This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`);
    } else if (cancelledCount >= 1) {
      cancellationPoints = 2;
      reasons.push(`This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`);
    }
  }

  // 🔹 Payment method scoring (Reason ONLY if COD)
  if (paymentType.toLowerCase().includes("cod")) {
    score += 3;
    reasons.push(`The order is COD.`);
  } 

  // 🔹 Customer scoring
  if (!customer) {
    score += 2; 
    reasons.push(`Guest checkout (No customer ID).`);
  } else {
    if (totalOrders <= 1) {
      score += 2; 
      reasons.push(`New customer (1st order).`);
    } 
    // Reward them ONLY if they have 5 or more STRICTLY completed orders
    else if (completedCount >= 5) {
      score -= 2; 
      reasons.push(`Trusted repeat buyer (${completedCount} fully delivered & paid orders).`);
    }
  }

  score += cancellationPoints;

  let riskLevel = "LOW";
  if (score >= 7) riskLevel = "HIGH";
  else if (score >= 4) riskLevel = "MEDIUM";

  // Format reasons for the database
  const reasonsString = reasons.length > 0 ? reasons.join(" | ") : "No specific risk factors flagged.";

  // 🔹 Print the final result and reasons to the terminal
  console.log(`\n=== RISK ASSESSMENT RESULT ===`);
  console.log(`Risk Level: ${riskLevel}`);
  console.log(`Reasons:`);
  if (reasons.length > 0) {
    reasons.forEach((reason) => console.log(`  - ${reason}`));
  } else {
    console.log(`  - No specific risk factors flagged.`);
  }
  console.log(`==============================\n`);

  await prisma.riskScore.upsert({
    where: { orderId: payload.id.toString() },
    update: {
      score,
      riskLevel,
      orderValue,
      paymentType,
      reasons: reasonsString
    },
    create: {
      shop,
      orderId: payload.id.toString(),
      customerId: customer?.id?.toString(),
      orderValue,
      paymentType,
      score,
      riskLevel,
      reasons: reasonsString
    }
  });
//shopify orders/{order_id}/metafields.json
  const metafieldReasons = reasons.length > 0 ? reasons.join("\n") : "No specific risk factors flagged.";

  const metafieldsResponse = await admin.graphql(
    `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors {
          field
          message
        }
      }
    }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId: `gid://shopify/Order/${payload.id}`,
            namespace: "risk_assessment",
            key: "level",
            type: "single_line_text_field",
            value: riskLevel
          },
          {
            ownerId: `gid://shopify/Order/${payload.id}`,
            namespace: "risk_assessment",
            key: "score",
            type: "number_integer",
            value: score.toString()
          },
          {
            ownerId: `gid://shopify/Order/${payload.id}`,
            namespace: "risk_assessment",
            key: "reasons",
            type: "multi_line_text_field", // 👈 Multi-line makes bullet points look good
            value: metafieldReasons
          }
        ]
      }
    }
  );

  const metafieldData = await metafieldsResponse.json();
  if (metafieldData.data?.metafieldsSet?.userErrors?.length > 0) {
    console.error("Metafield errors:", metafieldData.data.metafieldsSet.userErrors);
  } else {
    console.log("Successfully saved Risk Metafields to Shopify Order!");
  }
  // =================================================================
  // 🔹 NATIVE SHOPIFY RISK ASSESSMENT (Trigger the Red Banner)
  // =================================================================
  
  const orderGid = payload.admin_graphql_api_id; 

  const riskFacts = reasons.map((reason) => {
    return {
      description: reason,
      sentiment: reason.includes("Trusted") ? "POSITIVE" : "NEGATIVE" 
    };
  });

  const riskAssessmentMutation = `
    mutation CreateRiskAssessment($input: OrderRiskAssessmentCreateInput!) {
      orderRiskAssessmentCreate(orderRiskAssessmentInput: $input) {
        orderRiskAssessment {
          riskLevel
          provider {
            title
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      orderId: orderGid,
      riskLevel: riskLevel, // "HIGH", "MEDIUM", or "LOW"
      facts: riskFacts      
    }
  };

  try {
    const response = await admin.graphql(riskAssessmentMutation, { variables });
    const result = await response.json();
    
    if (result.data.orderRiskAssessmentCreate.userErrors.length > 0) {
      console.error("Errors creating native risk assessment:", result.data.orderRiskAssessmentCreate.userErrors);
    } else {
      console.log("Successfully created Native Shopify Risk Assessment!");
    }
  } catch (error) {
    console.error("GraphQL Error on Native Risk Assessment:", error);
  }

  return new Response();
};



