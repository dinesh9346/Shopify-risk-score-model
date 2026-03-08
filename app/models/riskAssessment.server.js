import prisma from "../db.server.js";
import shopify from "../shopify.server.js";

export async function calculateAndApplyRiskScore(shop, payload) {
  // 1. Get Offline Admin Client to talk to Shopify in the background
  const { admin } = await shopify.unauthenticated.admin(shop);

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