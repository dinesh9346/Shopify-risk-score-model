
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

//   if (!admin) {
//     console.error("Error: Admin context missing.");
//     return new Response(); 
//   }

//   // 🔹 1. Extract Data
//   const orderGid = payload.admin_graphql_api_id;
//   const customer = payload.customer;
//   // prefer stable Shopify customer ID; guests will be null
//   const customerId = customer?.admin_graphql_api_id || customer?.id?.toString() || null;
//   const customerEmail = customer?.email || payload.email || null;
//   const orderValue = parseFloat(payload.total_price || "0");
//   const paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";

//   // 🔹 2. Sync current order to local Data Warehouse (UPSERT)
//   try {
//     await prisma.storeOrder.upsert({
//       where: { shopifyOrderId: orderGid },
//       update: {
//         financialStatus: payload.financial_status,
//         fulfillmentStatus: payload.fulfillment_status,
//         cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
//       },
//       create: {
//         shop: shop,
//         shopifyOrderId: orderGid,
//         customerId: customer?.admin_graphql_api_id || customer?.id?.toString() || null,
//         customerEmail: customerEmail,
//         orderValue: orderValue,
//         financialStatus: payload.financial_status,
//         fulfillmentStatus: payload.fulfillment_status,
//         cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
//       },
//     });
//   } catch (error) {
//     console.error("Local Sync Error:", error);
//   }

//   // 🔹 3. Fast Local History Lookup
//   let score = 0;
//   let reasons = [];
//   let cancelledCount = 0;
//   let totalOrders = 0;
//   let completedCount = 0; 
//   let disputedCount = 0;
//   let rtoCount = 0;

//   // historyFilter: if we have both ID and email, query either one so we don't miss orders saved with only the other
//   let historyWhere = { shop: shop };
//   if (customerId && customerEmail) {
//     historyWhere.OR = [
//       { customerId },
//       { customerEmail }
//     ];
//   } else if (customerId) {
//     historyWhere.customerId = customerId;
//   } else if (customerEmail) {
//     historyWhere.customerEmail = customerEmail;
//   }

//   if (historyWhere.customerId || historyWhere.customerEmail || historyWhere.OR) {
//     const pastOrders = await prisma.storeOrder.findMany({
//       where: historyWhere,
//     });

//     // We exclude the current order from the "past" stats
//     const history = pastOrders.filter(o => o.shopifyOrderId !== orderGid);
//     totalOrders = history.length;
//     cancelledCount = history.filter(o => o.cancelledAt !== null).length;
//     disputedCount = history.filter(o => o.hasDispute === true).length;
//     completedCount = history.filter(o => 
//       o.financialStatus === "paid" && o.fulfillmentStatus === "fulfilled"
//     ).length;
//     rtoCount = history.filter(o => o.isRTO === true).length;

//     if (totalOrders > 0) {
//       // Dispute Logic
//       if (disputedCount > 0) {
//         score += 5;
//         reasons.push(`This customer has disputed ${disputedCount} orders out of the recent ${totalOrders} orders.`);
//       } else {
//         reasons.push(`Trusted: This customer has disputed 0 orders out of the recent ${totalOrders} orders.`);
//       }

//       // Cancellation Logic
//       if (cancelledCount >= 5) {
//         score += 4;
//         reasons.push(`This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`);
//       } else if (cancelledCount >= 1) {
//         score += 2;
//         reasons.push(`This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`);
//       } else {
//         reasons.push(`Trusted: This customer has cancelled/returned 0 orders out of the recent ${totalOrders} orders.`);
//       }
//       // RTO Logic
//       if (rtoCount >= 3) {
//         score += 4;
//         reasons.push(`This customer has ${rtoCount} orders marked as RTO out of the recent ${totalOrders} orders.`);
//       } else if (rtoCount >= 1) {
//         score += 2;
//         reasons.push(`This customer has ${rtoCount} orders marked as RTO out of the recent ${totalOrders} orders.`);
//       } else {
//         reasons.push(`Trusted: This customer has 0 orders marked as RTO out of the recent ${totalOrders} orders.`);
//       }   
//     }
//   } else {
//     console.log("No customer identifier (email or id); skipping history lookup.");
//   }

//   // 🔹 4.5. Integrate Shopify's Native Fraud Analysis
//   try {
//     console.log("Waiting 4 seconds for Shopify native fraud analysis...");
//     await new Promise(resolve => setTimeout(resolve, 4000));
    
//     // 👈 FIXED GRAPHQL QUERY
//     const riskQuery = `
//       query getOrderRisks($id: ID!) {
//         order(id: $id) {
//           risk {
//             assessments {
//               facts {
//                 description
//                 sentiment
//               }
//             }
//           }
//         }
//       }
//     `;
    
//     const riskResponse = await admin.graphql(riskQuery, { variables: { id: orderGid } });
//     const riskJson = await riskResponse.json();

//     // 👈 NEW: Log any GraphQL errors so we aren't flying blind!
//     if (riskJson.errors) {
//        console.error("GraphQL Error:", JSON.stringify(riskJson.errors, null, 2));
//     }

//     // 👈 FIXED DATA PATH
//     const nativeAssessments = riskJson.data?.order?.risk?.assessments || [];

//     nativeAssessments.forEach(assessment => {
//       assessment.facts.forEach(fact => {
//         // Negative facts = Higher Risk (e.g., "CVV isn't available", "Web proxy detected")
//         if (fact.sentiment === "NEGATIVE") {
//           score += 2; 
//           reasons.push(`Shopify Flag: ${fact.description}`);
//         } 
//         // Positive facts = Lower Risk (e.g., "Billing country matches IP", "No proxy")
//         else if (fact.sentiment === "POSITIVE") {
//           score -= 1; 
//           reasons.push(`Shopify Trust: ${fact.description}`);
//         }
//       });
//     });
//   } catch (error) {
//     console.error("Error fetching native Shopify risk facts:", error);
//   }
//   //  5. Customer Loyalty Scoring
//   if (!customer) {
//     score += 2; 
//     reasons.push(`Guest checkout (No customer ID).`);
//   } else if (totalOrders ==0) {
//     score += 2; 
//     reasons.push(`New customer (1st order).`); 
//   } else if (completedCount >= 5) {
//     score -= 2; 
//     reasons.push(`Trusted: Repeat buyer (${completedCount} fully delivered & paid orders).`);
//   }

//   // 🔹 6. Final Risk Level Calculation
//   let riskLevel = "LOW";
//   if (score >= 7) riskLevel = "HIGH";
//   else if (score >= 4) riskLevel = "MEDIUM";

//    // 🔹 Print the final result and reasons to the terminal
//   console.log(`\n=== RISK ASSESSMENT RESULT ===`);
//   console.log(`Risk Level: ${riskLevel}`);
//   console.log(`Reasons:`);
//   if (reasons.length > 0) {
//     reasons.forEach((reason) => console.log(`  - ${reason}`));
//   } else {
//     console.log(`  - No specific risk factors flagged.`);
//   }
//   console.log(`==============================\n`);

//   // 🔹 7. Save Final Score to Local Database (RiskScore Table)
//   const reasonsString = reasons.length > 0 ? reasons.join(" | ") : "No specific risk factors flagged.";
  
//   try {
//     await prisma.riskScore.upsert({
//       where: { orderId: orderGid },
//       update: {
//         score,
//         riskLevel,
//         orderValue,
//         paymentType,
//         reasons: reasonsString
//       },
//       create: {
//         shop: shop,
//         orderId: orderGid,
//         customerId: customer?.admin_graphql_api_id || customer?.id?.toString() || null,
//         orderValue,
//         paymentType,
//         score,
//         riskLevel,
//         reasons: reasonsString
//       }
//     });
//     console.log(` Saved Risk Score locally for order ${payload.id}`);
//   } catch (error) {
//     console.error(" Error saving Risk Score locally:", error);
//   }

//   //NATIVE SHOPIFY RISK ASSESSMENT 

//     const riskFacts = reasons.map((reason) => {
//     let factSentiment = "NEUTRAL"; 

//     // If we explicitly marked it as a good thing
//     if (reason.includes("Trusted")) {
//       factSentiment = "POSITIVE";
//     } 
//     // If it is a clear red flag
//     else if (reason.includes("cancelled") || reason.includes("disputed") || reason.includes("COD") || reason.includes("RTO") || reason.includes("Guest")) {
//       factSentiment = "NEGATIVE";
//     }

//     return {
//       description: reason.replace("Trusted: ", ""), 
//       sentiment: factSentiment 
//     };
//   })
//   const riskAssessmentMutation = `
//     mutation CreateRiskAssessment($input: OrderRiskAssessmentCreateInput!) {
//       orderRiskAssessmentCreate(orderRiskAssessmentInput: $input) {
//         orderRiskAssessment {
//           riskLevel
//           provider {
//             title
//           }
//         }
//         userErrors {
//           field
//           message
//         }
//       }
//     }
//   `;

//   const variables = {
//     input: {
//       orderId: orderGid,
//       riskLevel: riskLevel, // "HIGH", "MEDIUM", or "LOW"
//       facts: riskFacts      
//     }
//   };

//   try {
//     const response = await admin.graphql(riskAssessmentMutation, { variables });
//     const result = await response.json();
    
//     if (result.data.orderRiskAssessmentCreate.userErrors.length > 0) {
//       console.error("Errors creating native risk assessment:", result.data.orderRiskAssessmentCreate.userErrors);
//     } else {
//       console.log("Successfully created Native Shopify Risk Assessment!");
//     }
//   } catch (error) {
//     console.error("GraphQL Error on Native Risk Assessment:", error);
//   }

//   //  ADD ORDER TAGS

//   if (riskLevel === "HIGH" || riskLevel === "MEDIUM") {
//     const addTagMutation = `
//       mutation addTags($id: ID!, $tags: [String!]!) {
//         tagsAdd(id: $id, tags: $tags) {
//           node { id }
//           userErrors { field message }
//         }
//       }
//     `;

//     const riskTag = `Zippyy: ${riskLevel} Risk`; 

//     try {
//       const tagResponse = await admin.graphql(addTagMutation, {
//         variables: {
//           id: orderGid,
//           tags: [riskTag]
//         }
//       });
      
//       const tagResult = await tagResponse.json();
//       if (tagResult.data.tagsAdd.userErrors.length > 0) {
//          console.error("Errors adding tag:", tagResult.data.tagsAdd.userErrors);
//       } else {
//          console.log(`Successfully added tag: ${riskTag}`);
//       }
//     } catch (error) {
//       console.error("GraphQL Error adding tag:", error);
//     }
//   }

//   return new Response();
// };

console.log("WEBHOOK FILE LOADED: orders/updated");

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
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

  if (!admin) return new Response();

  // Only process ORDERS_CREATE webhooks. ORDERS_UPDATED is handled separately.
  if (topic !== "ORDERS_CREATE") {
    console.log(`[Webhook] Ignoring ${topic} webhook for order ${payload.id}`);
    return new Response();
  } 

  // 1. IDEMPOTENCY CHECK (THE INFINITE LOOP PREVENTER)
  // Check if we have already fully assessed and tagged this order.
  // If we have, exit immediately so we don't process it a second time!
  if (payload.tags && payload.tags.includes("Zippyy:")) {
    console.log(`[Idempotency] Order ${payload.id} already assessed. Skipping duplicate webhook.`);
    return new Response();
  }

  console.log(`Starting Risk Assessment for Order: ${payload.id}`);

  // 🔹 2. Extract Data
  const orderGid = payload.admin_graphql_api_id;
  const customer = payload.customer;
  const customerId = customer?.admin_graphql_api_id || customer?.id?.toString() || null;
  const customerEmail = customer?.email || payload.email || null;
  const orderValue = parseFloat(payload.total_price || "0");
  const paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";

  // 🔹 3. Sync current order to local Data Warehouse (UPSERT)
  let storeOrderId = null;
  try {
    const result = await prisma.shopify_store_order.upsert({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId: orderGid } },
      update: {
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
      },
      create: {
        shop,
        shopifyOrderId: orderGid,
        customerId,
        customerEmail,
        orderValue,
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
      },
    });
    storeOrderId = result.id;
  } catch (error) {
    console.error("Local Sync Error:", error);
    return new Response();
  }

  // 🔹 3b. IDEMPOTENCY CHECK #2 - Check if risk score already exists (handles webhook retries)
  if (storeOrderId) {
    const existingRisk = await prisma.zippyy_risk_score.findUnique({
      where: { orderId: storeOrderId }
    });
    if (existingRisk) {
      console.log(`[Idempotency] Risk score already exists for order ${payload.id}. Skipping.`);
      return new Response();
    }
  }

  // 🔹 4. Fast Local History Lookup
  let score = 0;
  let reasons = []; 
  let cancelledCount = 0;
  let totalOrders = 0;
  let completedCount = 0; 
  let disputedCount = 0;
  let rtoCount = 0;

  let historyWhere = { shop: shop };
  if (customerId && customerEmail) {
    historyWhere.OR = [ { customerId }, { customerEmail } ];
  } else if (customerId) {
    historyWhere.customerId = customerId;
  } else if (customerEmail) {
    historyWhere.customerEmail = customerEmail;
  }

  if (historyWhere.customerId || historyWhere.customerEmail || historyWhere.OR) {
    const pastOrders = await prisma.shopify_store_order.findMany({ where: historyWhere });
    const history = pastOrders.filter(o => o.shopifyOrderId !== orderGid);
    
    totalOrders = history.length;
    cancelledCount = history.filter(o => o.cancelledAt !== null).length;
    disputedCount = history.filter(o => o.hasDispute === true).length;
    completedCount = history.filter(o => o.financialStatus === "paid" && o.fulfillmentStatus === "fulfilled").length;
    rtoCount = history.filter(o => o.isRTO === true).length;

    if (totalOrders > 0) {
      if (disputedCount > 0) {
        score += 5;
        reasons.push({ description: `This customer has disputed ${disputedCount} orders out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else {
        reasons.push({ description: `Trusted: This customer has disputed 0 orders out of the recent ${totalOrders} orders.`, sentiment: "POSITIVE" });
      }

      if (cancelledCount >= 5) {
        score += 4;
        reasons.push({ description: `This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else if (cancelledCount >= 1) {
        score += 2;
        reasons.push({ description: `This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else {
        reasons.push({ description: `Trusted: This customer has cancelled/returned 0 orders out of the recent ${totalOrders} orders.`, sentiment: "POSITIVE" });
      }
      
      if (rtoCount >= 3) {
        score += 4;
        reasons.push({ description: `This customer has ${rtoCount} orders marked as RTO out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else if (rtoCount >= 1) {
        score += 2;
        reasons.push({ description: `This customer has ${rtoCount} orders marked as RTO out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else {
        reasons.push({ description: `Trusted: This customer has 0 orders marked as RTO out of the recent ${totalOrders} orders.`, sentiment: "POSITIVE" });
      }   
    }
  }

  // 🔹 5. Scoring Logic (Order Value & Payment)
  if (orderValue > 5000) score += 3;
  else if (orderValue > 1000) score += 2;
  else score += 1;

  if (paymentType.toLowerCase().includes("cod")) {
    score += 3;
    reasons.push({ description: `The order is COD.`, sentiment: "NEGATIVE" });
  }

  // // 🔹 6. Integrate Shopify's Native Fraud Analysis (NO TIMEOUT NEEDED)
  // try {
  //   const riskQuery = `
  //     query getOrderRisks($id: ID!) {
  //       order(id: $id) {
  //         risk {
  //           assessments {
  //             provider { title }
  //             facts { description sentiment }
  //           }
  //         }
  //       }
  //     }
  //   `;
    
  //   const riskResponse = await admin.graphql(riskQuery, { variables: { id: orderGid } });
  //   const riskJson = await riskResponse.json();

  //   const nativeAssessments = riskJson.data?.order?.risk?.assessments || [];

  //   nativeAssessments.forEach(assessment => {
  //     if (assessment.provider === null) {
  //       assessment.facts.forEach(fact => {
  //         if (fact.sentiment === "NEGATIVE") {
  //           score += 2; 
  //           reasons.push({ description: fact.description, sentiment: "NEGATIVE" });
  //         } else if (fact.sentiment === "POSITIVE") {
  //           score -= 0.5; 
  //           reasons.push({ description: fact.description, sentiment: "POSITIVE" });
  //         } else {
  //           reasons.push({ description: fact.description, sentiment: "NEUTRAL" });
  //         }
  //       });
  //     }
  //   });
  // } catch (error) {
  //   console.error("Error fetching native Shopify risk facts:", error);
  // }

  // 🔹 7. Customer Loyalty Scoring
  if (!customer) {
    score += 2; 
    reasons.push({ description: `Guest checkout (No customer ID).`, sentiment: "NEGATIVE" });
  } else if (totalOrders === 0) {
    score += 2; 
    reasons.push({ description: `New customer (1st order).`, sentiment: "NEUTRAL" }); 
  } else if (completedCount >= 5) {
    score -= 2; 
    reasons.push({ description: `Trusted: Repeat buyer (${completedCount} fully delivered & paid orders).`, sentiment: "POSITIVE" });
  }

  // 🔹 8. Final Risk Level Calculation
  let riskLevel = "LOW";
  if (score >= 7) riskLevel = "HIGH";
  else if (score >= 4) riskLevel = "MEDIUM";

  console.log(`\n=== RISK ASSESSMENT RESULT ===`);
  console.log(`Risk Level: ${riskLevel} (Score: ${score})`);
  console.log(`==============================\n`);

  // 🔹 9. Save Final Score to Local Database
  const reasonsString = reasons.length > 0 ? reasons.map(r => r.description).join(" | ") : "No specific risk factors flagged.";
  
  try {
    await prisma.zippyy_risk_score.create({
      data: {
        shop,
        orderId: storeOrderId,
        score,
        riskLevel,
        reasons: reasonsString
      }
    });
    console.log(`✓ Saved Risk Score for order ${payload.id}`);
  } catch (error) {
    // P2002 = unique constraint violation (orderId already exists)
    // This means another webhook already processed this order
    if (error.code === "P2002") {
      console.log(`[Idempotency] Another assessment already in flight for order ${payload.id}. Skipping.`);
      return new Response();
    }
    console.error("Error saving Risk Score locally:", error);
    return new Response();
  }

  // 🔹 10. Push Native Risk Assessment to Shopify
  const riskFacts = reasons.map((reasonObj) => ({
      description: reasonObj.description, 
      sentiment: reasonObj.sentiment 
  }));

  const riskAssessmentMutation = `
    mutation CreateRiskAssessment($input: OrderRiskAssessmentCreateInput!) {
      orderRiskAssessmentCreate(orderRiskAssessmentInput: $input) {
        userErrors { message }
      }
    }
  `;

  try {
    await admin.graphql(riskAssessmentMutation, { 
      variables: { input: { orderId: orderGid, riskLevel: riskLevel, facts: riskFacts } } 
    });
  } catch (error) {
    console.error("GraphQL Error on Native Risk Assessment:", error);
  }

  // 🔹 11. ADD ORDER TAGS (CRITICAL: WE MUST TAG ALL LEVELS FOR IDEMPOTENCY TO WORK)
  const addTagMutation = `
    mutation addTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { message }
      }
    }
  `;

  // We add a tag regardless of the risk level. This is what stops the infinite loop on the next webhook run!
  const riskTag = `Zippyy: ${riskLevel} Risk`; 

  try {
    await admin.graphql(addTagMutation, {
      variables: { id: orderGid, tags: [riskTag] }
    });
    console.log(`Successfully completed assessment and added tag: ${riskTag}`);
  } catch (error) {
    console.error("GraphQL Error adding tag:", error);
  }

  return new Response();
};