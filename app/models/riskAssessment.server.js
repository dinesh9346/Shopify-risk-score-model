import prisma from "../db.server.js";
import { enqueueOutboundRisk } from "./queue.server.js";

export async function calculateAndApplyRiskScore(shop, payload) {

  // IDEMPOTENCY CHECK
  if (payload.tags && payload.tags.includes("Zippyy:")) {
    console.log(`[Idempotency] Order ${payload.id} already assessed. Skipping duplicate webhook.`);
    return new Response();
  }

  console.log(`Starting Risk Assessment for Order: ${payload.id}`);

  // 🔹 Extract Order Data
  const orderGid = payload.admin_graphql_api_id;
  const customer = payload.customer;

  const customerId = customer?.admin_graphql_api_id || customer?.id?.toString() || null;
  const customerEmail = customer?.email || payload.email || null;

  const customerPhone = payload.phone || payload.shipping_address?.phone || null;
  const shippingAddress1 = payload.shipping_address?.address1 || null;

  const orderValue = parseFloat(payload.total_price || "0");
  const paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";

  // 🔹 Sync order locally (UPSERT)
  let storeOrderId = null;

  try {
    const result = await prisma.shopify_store_order.upsert({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId: orderGid } },
      update: {
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        paymentGateway: paymentType,
        customerPhone,
        shippingAddress1
      },
      create: {
        shop,
        shopifyOrderId: orderGid,
        customerId,
        customerEmail,
        orderValue,
        paymentGateway: paymentType,
        customerPhone,
        shippingAddress1,
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null
      }
    });

    storeOrderId = result.id;
  } catch (error) {
    console.error("Local Sync Error:", error);
    return new Response();
  }

  // IDEMPOTENCY CHECK 2
  if (storeOrderId) {
    const existingRisk = await prisma.zippyy_risk_score.findUnique({
      where: { orderId: storeOrderId }
    });

    if (existingRisk) {
      console.log(`[Idempotency] Risk score already exists for order ${payload.id}. Skipping.`);
      return new Response();
    }
  }

  // 🔹 Risk Engine
  let score = 0;
  let reasons = [];

  // Trackers
  let totalOrders = 0;
  let totalSpend = 0;
  let cancelledCount = 0;
  let disputedCount = 0;
  let rtoCount = 0;
  let refundCount = 0;
  let codCount = 0;
  
  // 🔥 NEW: Strict Trackers
  let validOrderCount = 0;
  let validTotalSpend = 0;

  let historyWhere = { shop };

  if (customerId && customerEmail) {
    historyWhere.OR = [{ customerId }, { customerEmail }];
  } else if (customerId) {
    historyWhere.customerId = customerId;
  } else if (customerEmail) {
    historyWhere.customerEmail = customerEmail;
  }

  if (historyWhere.customerId || historyWhere.customerEmail || historyWhere.OR) {
    const pastOrders = await prisma.shopify_store_order.findMany({
      where: historyWhere
    });

    const history = pastOrders.filter(o => o.shopifyOrderId !== orderGid);

    totalOrders = history.length;
    cancelledCount = history.filter(o => o.cancelledAt !== null).length;
    disputedCount = history.filter(o => o.hasDispute === true).length;
    rtoCount = history.filter(o => o.isRTO === true).length;
    refundCount = history.filter(o => ["REFUNDED", "PARTIALLY_REFUNDED"].includes(o.financialStatus?.toUpperCase())).length;
    codCount = history.filter(o => o.paymentGateway?.toLowerCase().includes("cod") || o.paymentGateway?.toLowerCase().includes("cash")).length;

    // Calculate Spends & Valid Orders
    history.forEach(o => {
      const val = Number(o.orderValue || 0);
      totalSpend += val;

      const isPaid = o.financialStatus?.toUpperCase() === "PAID";
      const isFulfilled = o.fulfillmentStatus?.toUpperCase() === "FULFILLED";

      // Strict validation: Paid + Fulfilled + No Disputes + No Cancels + No RTO
      if (isPaid && isFulfilled && !o.hasDispute && !o.cancelledAt && !o.isRTO) {
        validOrderCount++;
        validTotalSpend += val;
      }
    });

    let cancelRate = totalOrders > 0 ? cancelledCount / totalOrders : 0;
    let rtoRate = totalOrders > 0 ? rtoCount / totalOrders : 0;
    let refundRate = totalOrders > 0 ? refundCount / totalOrders : 0;
    let codRate = totalOrders > 0 ? codCount / totalOrders : 0;
    //  Behavioural Rules with Strict Valid Order Tracking
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
    // Serial Abandoner Rule (Now strictly requires 0 Valid Orders)
    if (totalOrders >= 10 && validOrderCount === 0) {
      score += 6;
      reasons.push({ description: `Serial order abandoner: ${totalOrders} orders but 0 successful purchases.`, sentiment: "NEGATIVE" });
    }

    // Suspicious Zero-Value Orders
    if (totalOrders >= 20 && totalSpend === 0) {
      score += 5;
      reasons.push({ description: `Suspicious buyer: ${totalOrders} orders with zero purchase value.`, sentiment: "NEGATIVE" });
    }

    // Refund abuse
    if (refundRate >= 0.5 && totalOrders >= 3) {
      score += 4;
      reasons.push({ description: `High refund rate (${Math.round(refundRate * 100)}%).`, sentiment: "NEGATIVE" });
    }

    // COD abuse
    if (codRate >= 0.7 && rtoCount >= 1 && totalOrders >= 3) {
      score += 4;
      reasons.push({ description: `COD abuse suspected (${codCount}/${totalOrders} COD orders with RTO history).`, sentiment: "NEGATIVE" });
    }
  }

  // Guest COD risk
  if (!customer && paymentType.toLowerCase().includes("cod")) {
    score += 4;
    reasons.push({ description: `Guest checkout with COD.`, sentiment: "NEGATIVE" });
  }

  // Address fraud network
  if (shippingAddress1) {
    const addressOrders = await prisma.shopify_store_order.findMany({
      where: { shop, shippingAddress1 }
    });

    const uniqueCustomers = new Set(addressOrders.map(o => o.customerEmail).filter(Boolean));

    if (uniqueCustomers.size >= 4) {
      score += 5;
      reasons.push({ description: `Fraud network suspected: ${uniqueCustomers.size} buyers shipping to the same address.`, sentiment: "NEGATIVE" });
    }
  }

  // Phone fraud network
  if (customerPhone) {
    const phoneOrders = await prisma.shopify_store_order.findMany({
      where: { shop, customerPhone }
    });

    const uniqueCustomers = new Set(phoneOrders.map(o => o.customerEmail).filter(Boolean));

    if (uniqueCustomers.size >= 4) {
      score += 5;
      reasons.push({ description: `Fraud network suspected: phone number used by ${uniqueCustomers.size} customers.`, sentiment: "NEGATIVE" });
    }
  }

  // Bot detection
  if (customerEmail) {
    const recentOrders = await prisma.shopify_store_order.findMany({
      where: {
        shop,
        customerEmail,
        createdAt: {
          gte: new Date(Date.now() - 15 * 60 * 1000)
        }
      }
    });

    if (recentOrders.length >= 4) {
      score += 4;
      reasons.push({ description: `Bot-like behaviour detected (${recentOrders.length} orders within 15 minutes).`, sentiment: "NEGATIVE" });
    }
  }

  // Value Anomaly (Strictly based on Paid & Delivered history)
  const avgValidSpend = validOrderCount > 0 ? validTotalSpend / validOrderCount : 0;

  if (orderValue > avgValidSpend * 5 && avgValidSpend > 0) {
    score += 3;
    reasons.push({
      description: `Order value unusually high compared to customer's successful purchase history.`,
      sentiment: "NEGATIVE"
    });
  }

  //  Loyalty Signals (Strictly based on Paid & Delivered history)
  if (validOrderCount >= 5) {
    score -= 3;
    reasons.push({
      description: `Loyal repeat buyer (${validOrderCount} paid & delivered orders).`,
      sentiment: "POSITIVE"
    });
  }

  if (validTotalSpend > 50000) {
    score -= 2;
    reasons.push({
      description: `High lifetime value customer (over ₹50,000 in verified successful purchases).`,
      sentiment: "POSITIVE"
    });
  }

  // Final Risk Level
  let riskLevel = "LOW";

  if (score >= 7) riskLevel = "HIGH";
  else if (score >= 3) riskLevel = "MEDIUM";

  console.log(`\n=== RISK ASSESSMENT RESULT ===`);
  console.log(`Risk Level: ${riskLevel} (Score: ${score})`);
  console.log(`Reasons:`, reasons);
  console.log(`==============================\n`);
 // --- BUILD THE UNIVERSAL IDENTIFIER ---
  const safeEmail = customerEmail?.trim() || null;
  const safePhone = customerPhone?.trim() || null;
  const safeCustId = customerId?.trim() || null;
  
  // The Fallback Chain
  const buyerIdentifier = safePhone || safeEmail || safeCustId || `guest-${orderGid}`;

  // --- UPSERT THE BUYER PROFILE FOR THE DASHBOARD ---
  try {
    let segment = "New";
    if (reasons.length > 0) segment = "High Risk";
    else if (validOrderCount >= 3) segment = "VIP";
    else if (validOrderCount >= 1) segment = "Repeat Buyer";

    await prisma.zippyy_buyer_profile.upsert({
      where: { shop_buyerIdentifier: { shop, buyerIdentifier } },
      update: {
        customerEmail: safeEmail,
        customerPhone: safePhone,
        customerId: safeCustId,
        totalCheckoutAttempts: totalOrders, 
        validOrderCount,
        totalSpend,
        cancelledCount,
        disputeCount,
        rtoCount,
        refundCount,
        codCount,
        buyerSegment: segment,
        riskReasons: reasons.map(r => r.description).join(", ")
      },
      create: {
        shop,
        buyerIdentifier,
        customerEmail: safeEmail,
        customerPhone: safePhone,
        customerId: safeCustId,
        totalCheckoutAttempts: totalOrders,
        validOrderCount,
        totalSpend,
        cancelledCount,
        disputeCount,
        rtoCount,
        refundCount,
        codCount,
        buyerSegment: segment,
        riskReasons: reasons.map(r => r.description).join(", ")
      }
    });
    console.log(`✓ Updated Buyer Profile for ${buyerIdentifier}`);
  } catch (profileError) {
    console.error("Error saving Buyer Profile:", profileError);
  }
  // Save Score (UPSERT)
  try {
    await prisma.zippyy_risk_score.upsert({
      where: { orderId: storeOrderId },
      update: { score, riskLevel, reasons: reasons.map(r => r.description).join(" | ") },
      create: {
        shop,
        orderId: storeOrderId,
        score,
        riskLevel,
        reasons: reasons.map(r => r.description).join(" | ")
      }
    });

    console.log(`✓ Saved Risk Score for order ${payload.id}`);
  } catch (error) {
    console.error("Error saving Risk Score locally:", error);
    return new Response();
  }

  // 2. Format the reasons to pass to the Outbound Queue
  const riskFacts = reasons.map(r => ({
    description: r.description,
    sentiment: r.sentiment || "NEUTRAL"
  }));

  // 3. Hand-off to the Outbound Queue!
  try {
    await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);
    console.log(` [INBOUND COMPLETE] Successfully routed ${riskLevel} risk score to Outbound Queue.`);
  } catch (error) {
    console.error(` Failed to route outbound data:`, error);
    throw error;
  }

  return new Response();
}
