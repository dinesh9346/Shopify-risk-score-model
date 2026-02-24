
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

 //  Fetch order history with correct GraphQL fields and pagination, including disputes
  async function getCustomerOrderStats(admin, customerId) {
    if (!admin || !customerId) return { cancelledCount: 0, totalOrders: 0, completedCount: 0, disputedCount: 0 };

    let hasNextPage = true;
    let cursor = null;
    let cancelledCount = 0;
    let totalOrders = 0;
    let completedCount = 0;
    let disputedCount = 0; // Added dispute tracker

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
                  displayFinancialStatus   
                  displayFulfillmentStatus
                  disputes {
                    id
                    status
                  }
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
      
      // Catch any other GraphQL errors safely
      if (data.errors) {
        console.error("GraphQL Error fetching customer stats:", data.errors);
        break; 
      }

      const orders = data?.data?.customer?.orders?.edges || [];

      totalOrders += orders.length;

      // Evaluate every single order for strict completion
      orders.forEach((edge) => {
        const order = edge.node;
        
        // FIXED: Since disputes is a flat array, we just check its length directly
        if (order.disputes && order.disputes.length > 0) {
          disputedCount += 1;
        }

        if (order.cancelledAt !== null) {
          cancelledCount += 1;
        } else if (
          order.displayFinancialStatus === "PAID" && 
          order.displayFulfillmentStatus === "FULFILLED"
        ) {
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

    return { cancelledCount, totalOrders, completedCount, disputedCount };
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
  let disputedCount = 0;

  if (customer?.id) {
    const stats = await getCustomerOrderStats(admin, customer.id);
    cancelledCount = stats.cancelledCount;
    totalOrders = stats.totalOrders;
    completedCount = stats.completedCount; 
    disputedCount = stats.disputedCount || 0;

    if (totalOrders > 0) { 
      // 🔹 DISPUTE LOGIC
      if (disputedCount > 0) {
        score += 5; 
        reasons.push(`This customer has disputed ${disputedCount} orders out of the recent ${totalOrders} orders.`);
      } else {
        reasons.push(`Trusted: This customer has disputed 0 orders out of the recent ${totalOrders} orders.`);
      }

      // 🔹 CANCELLATION LOGIC
      if (cancelledCount >= 3) {
        cancellationPoints = 4;
        reasons.push(`This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`);
      } else if (cancelledCount >= 1) {
        cancellationPoints = 2;
        reasons.push(`This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`);
      } else {
        reasons.push(`Trusted: This customer has cancelled/returned 0 orders out of the recent ${totalOrders} orders.`);
      }
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
      reasons.push(` New customer (1st order).`);
    } 
    // Reward them ONLY if they have 5 or more STRICTLY completed orders
    else if (completedCount >= 5) {
      score -= 2; 
      reasons.push(`Trusted: Repeat buyer (${completedCount} fully delivered & paid orders).`);
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
  
  //  NATIVE SHOPIFY RISK ASSESSMENT 

  const orderGid = payload.admin_graphql_api_id; 


    const riskFacts = reasons.map((reason) => {
    let factSentiment = "NEUTRAL"; 

    // If we explicitly marked it as a good thing
    if (reason.includes("Trusted")) {
      factSentiment = "POSITIVE";
    } 
    // If it is a clear red flag
    else if (reason.includes("cancelled") || reason.includes("disputed") || reason.includes("COD") || reason.includes("Guest")) {
      factSentiment = "NEGATIVE";
    }

    return {
      description: reason.replace("Trusted: ", ""), 
      sentiment: factSentiment 
    };
  })
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

  //  ADD ORDER TAGS

  if (riskLevel === "HIGH" || riskLevel === "MEDIUM") {
    const addTagMutation = `
      mutation addTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }
    `;

    const riskTag = `Zippyy: ${riskLevel} Risk`; 

    try {
      const tagResponse = await admin.graphql(addTagMutation, {
        variables: {
          id: orderGid,
          tags: [riskTag]
        }
      });
      
      const tagResult = await tagResponse.json();
      if (tagResult.data.tagsAdd.userErrors.length > 0) {
         console.error("Errors adding tag:", tagResult.data.tagsAdd.userErrors);
      } else {
         console.log(`Successfully added tag: ${riskTag}`);
      }
    } catch (error) {
      console.error("GraphQL Error adding tag:", error);
    }
  }

  return new Response();
};

