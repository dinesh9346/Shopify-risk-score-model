
import prisma from "../db.server.js";
import { enqueueOutboundRisk } from "./queue.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";

export async function calculateAndApplyRiskScore(shop, payload) {
  // IDEMPOTENCY CHECK
  if (payload.tags && payload.tags.includes("Zippyy:")) {
    console.log(`[Idempotency] Order ${payload.id} already assessed. Skipping duplicate webhook.`);
    return new Response();
  }

  console.log(`Starting Risk Assessment for Order: ${payload.id}`);

  // Extract Order Data
  const orderGid = payload.admin_graphql_api_id;
  const customer = payload.customer;

  const customerId = customer?.admin_graphql_api_id || customer?.id?.toString() || null;
  const customerEmail = customer?.email || payload.email || null;

  const customerPhone = payload.phone || payload.shipping_address?.phone || null;
  const shippingAddress1 = payload.shipping_address?.address1?.trim() || "";
  const shippingAddress2 = payload.shipping_address?.address2?.trim() || "";
  const shippingCity = payload.shipping_address?.city?.trim() || "";
  const shippingProvince = payload.shipping_address?.province?.trim() || payload.shipping_address?.province_code?.trim() || "";
  const shippingZip = payload.shipping_address?.zip?.trim() || "";
  const shippingCountry = payload.shipping_address?.country?.trim() || payload.shipping_address?.country_code?.trim() || "";
  const billingAddress1 = payload.billing_address?.address1?.trim() || "";
  const billingAddress2 = payload.billing_address?.address2?.trim() || "";
  const billingCity = payload.billing_address?.city?.trim() || "";
  const billingProvince = payload.billing_address?.province?.trim() || payload.billing_address?.province_code?.trim() || "";
  const billingZip = payload.billing_address?.zip?.trim() || "";
  const billingCountry = payload.billing_address?.country?.trim() || payload.billing_address?.country_code?.trim() || "";

  const firstName = customer?.first_name || payload.shipping_address?.first_name || payload.billing_address?.first_name || null;
  const lastName = customer?.last_name || payload.shipping_address?.last_name || payload.billing_address?.last_name || null;
  const orderValue = parseFloat(payload.total_price || "0");

  // Extract standard payment type
  let paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";

  // --- NEW: CATCH ADMIN-CREATED COD ORDERS ---
  const isDraftOrder = payload.source_name === "shopify_draft_order" || payload.source_name === "2932204";
  const isPendingPayment = payload.financial_status === "pending";
  
  // Safely grab tags and notes to check for merchant clues
  const orderTags = (payload.tags || "").toLowerCase();
  const orderNote = (payload.note || "").toLowerCase();

  if (isDraftOrder && isPendingPayment) {
    // 1. If it's a pending draft order with COD clues, flag it as COD (This covers the common case of merchants creating COD orders manually from the admin)
    const hasCodClue = orderTags.includes("cod") || 
                       orderTags.includes("cash") || 
                       orderNote.includes("cod") || 
                       orderNote.includes("cash");

    if (hasCodClue) {
      paymentType = "Admin_Draft_COD"; // Special flag for admin-created COD orders, so we can track them separately in the dashboard and apply specific rules if needed.
    } 
    // 2. If no clues, but it's an unknown pending draft, flag it as manual
    else if (paymentType === "UNKNOWN") {
      paymentType = "Manual_Pending_Order"; 
    }
  }


  // --- NEW: Extract product IDs from the current order ---
  const currentProductIds = payload.line_items?.map(item => item.product_id).filter(Boolean) || [];

  // Sync order locally (UPSERT)
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
        shippingAddress1,
        shippingAddress2,
        shippingCity,
        shippingProvince,
        shippingZip,
        shippingCountry,
        billingAddress1,
        billingAddress2,
        billingCity,
        billingProvince,
        billingZip,
        billingCountry,
        firstName,
        lastName,
        lineItemsData: JSON.stringify(currentProductIds)
      },
      create: {
        shop,
        shopifyOrderId: orderGid,
        customerId,
        firstName,
        lastName,
        customerEmail,
        orderValue,
        paymentGateway: paymentType,
        customerPhone,
        shippingAddress1,
        shippingAddress2,
        shippingCity,
        shippingProvince,
        shippingZip,
        shippingCountry,
        billingAddress1,
        billingAddress2,
        billingCity,
        billingProvince,
        billingZip,
        billingCountry,
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        lineItemsData: JSON.stringify(currentProductIds) 
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

  // Risk Engine
  let score = 0;
  let reasons = [];

  
  //  COD risk
  const currentGatewayStr = paymentType.toLowerCase();
  const isCurrentCod = currentGatewayStr.includes("cod") || 
                       currentGatewayStr.includes("cash") || 
                       currentGatewayStr.includes("pay on delivery") || 
                       currentGatewayStr.includes("pod");

  if (!customer && isCurrentCod) {
    score += 3;
    reasons.push({ description: `Guest checkout with COD.`, sentiment: "NEGATIVE" });
  }

  
  // 1. Name Check (Missing or 2 characters or less)
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (!fullName || fullName.length <= 2) {
    score += 5; // Heavy penalty for bot names
    reasons.push({ description: "Suspicious Name (Missing or too short)", sentiment: "NEGATIVE" });
  }

  // 2. Address Check (Missing address OR missing house number)
  const shippingStreetLines = [shippingAddress1, shippingAddress2]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!shippingStreetLines) {
    score += 7;
    reasons.push({ description: "Missing Shipping Address", sentiment: "NEGATIVE" });
  } else {
    // Look for at least one digit in the actual street address
    const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);

    if (!hasHouseNumber) {
      score += 7;
      reasons.push({ description: " House Number missing in address", sentiment: "NEGATIVE" });
    }
  }

  // Trackers
  let totalOrders = 0;
  let totalSpend = 0;
  let cancelledCount = 0;
  let disputedCount = 0;
  let rtoCount = 0;
  let refundCount = 0;
  let codCount = 0;
  
  // Strict Trackers
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
    if (totalOrders === 0) {
      reasons.push({ description: "New Customer (No prior order history)", sentiment: "NEUTRAL" });
    }

    history.forEach(o => {
      const fStatus = o.financialStatus?.toUpperCase();
      const fulfillment = o.fulfillmentStatus?.toUpperCase();
      
      const pastGatewayStr = o.paymentGateway?.toLowerCase() || "";
      const isCod = pastGatewayStr.includes("cod") || 
                    pastGatewayStr.includes("cash") || 
                    pastGatewayStr.includes("pay on delivery") || 
                    pastGatewayStr.includes("pod");

      if (isCod) codCount++;
      if (o.hasDispute) disputedCount++;
      if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

      // Logistics Tracking
      if (o.cancelledAt || fulfillment === "CANCELLED") {
        cancelledCount++;
      } 
      else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") {
        rtoCount++;
      }

      // Valid Order Gatekeeper
      const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
      if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
        validOrderCount++;
        validTotalSpend += Number(o.orderValue || 0);
      }

      totalSpend += Number(o.orderValue || 0);
    });

    let cancelRate = totalOrders > 0 ? cancelledCount / totalOrders : 0;
    let rtoRate = totalOrders > 0 ? rtoCount / totalOrders : 0;
    let refundRate = totalOrders > 0 ? refundCount / totalOrders : 0;
    let codRate = totalOrders > 0 ? codCount / totalOrders : 0;
    
    // Calculate the success rate (prevent division by zero)
    const successRate = totalOrders > 0 ? (validOrderCount / totalOrders) : 0;
    
    // --- NEW: SAME PRODUCT ABUSE LOGIC ---
    if (currentProductIds.length > 0 && history.length > 0) {
      let maxUnpaidSameProduct = 0;
      let hasSuccessfulSameProduct = false;

      currentProductIds.forEach(productId => {
        let unpaidCount = 0;
        let successCount = 0;

        history.forEach(pastOrder => {
          let pastProductIds = [];
          try {
            // Safely parse the stored line items
            pastProductIds = pastOrder.lineItemsData ? JSON.parse(pastOrder.lineItemsData) : [];
          } catch (e) { /* Ignore parse errors on older records */ }

          if (pastProductIds.includes(productId)) {
            const fStatus = pastOrder.financialStatus?.toUpperCase();
            const fulfillment = pastOrder.fulfillmentStatus?.toUpperCase();
            const isClean = !pastOrder.cancelledAt && !(pastOrder.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !pastOrder.hasDispute;

            if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
              successCount++;
            } else {
              unpaidCount++;
            }
          }
        });

        if (unpaidCount > maxUnpaidSameProduct) {
          maxUnpaidSameProduct = unpaidCount;
        }
        if (successCount > 0) {
          hasSuccessfulSameProduct = true;
        }
      });

      // Apply the Risk Scores (Only if there are NO successful purchases of the particular same  product)
      if (!hasSuccessfulSameProduct) {
        if (maxUnpaidSameProduct >= 5) {
          score += 7; // HIGH RISK
          reasons.push({ 
            description: `Targeted Hoarding: Customer has ordered this exact product ${maxUnpaidSameProduct} times previously without successfully paying or fulfilling.`, 
            sentiment: "NEGATIVE" 
          });
        } else if (maxUnpaidSameProduct >= 3) {
          score += 4; // MEDIUM RISK
          reasons.push({ 
            description: `Suspicious Repeat Item: Customer has ordered this exact product ${maxUnpaidSameProduct} times previously without completing the purchase.`, 
            sentiment: "NEGATIVE" 
          });
        }
      }
    }
  

    // Behavioural Rules with Strict Valid Order Tracking
    if (totalOrders > 0) {
      
      // --- 1. Tiered Cancellation Rules ---
      if (cancelledCount >= 10 || (totalOrders >= 10 && cancelRate >= 0.20)) {
        score += 7;
        reasons.push({ description: `High Cancellation: ${cancelledCount} orders cancelled (${Math.round(cancelRate * 100)}%).`, sentiment: "NEGATIVE" });
      } else if (cancelledCount >= 5) {
        score += 4;
        reasons.push({ description: `This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else if (cancelledCount >= 1) {
        score += 2;
        reasons.push({ description: `This customer has cancelled/returned ${cancelledCount} orders out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else {
        reasons.push({ description: `This customer has cancelled/returned 0 orders out of the recent ${totalOrders} orders.`, sentiment: "POSITIVE" });
      }

      // --- 2. Dispute Tracking ---
      if (disputedCount > 0) {
        score += 7;
        reasons.push({ description: `This customer has disputed ${disputedCount} orders out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else {
        reasons.push({ description: `This customer has disputed 0 orders out of the recent ${totalOrders} orders.`, sentiment: "POSITIVE" });
      }

      // --- 3. RTO Tracking ---
      if (rtoCount >= 3) {
        score += 4;
        reasons.push({ description: `This customer has ${rtoCount} orders marked as RTO out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else if (rtoCount >= 1) {
        score += 2;
        reasons.push({ description: `This customer has ${rtoCount} orders marked as RTO out of the recent ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      } else {
        reasons.push({ description: `This customer has 0 orders marked as RTO out of the recent ${totalOrders} orders.`, sentiment: "POSITIVE" });
      }

      // --- 4. Serial Abandoner Rules (Tiered) ---
      if (totalOrders >= 10 && validOrderCount === 0) {
        score += 6;
        reasons.push({ description: `Serial order abandoner: ${totalOrders} orders but 0 successful purchases.`, sentiment: "NEGATIVE" });
      } else if (totalOrders >= 15 && successRate <= 0.05) {
        score += 7;
        reasons.push({ description: `Severe abandonment rate: ${totalOrders} orders placed, but only ${validOrderCount} successful (${Math.round(successRate * 100)}%).`, sentiment: "NEGATIVE" });
      } else if (totalOrders >= 10 && successRate <= 0.15) {
        score += 4; 
        reasons.push({ description: `High abandonment rate: ${totalOrders} orders placed, but only ${validOrderCount} successful.`, sentiment: "NEGATIVE" });
      }

      // --- 5. Suspicious Zero-Value Orders ---
      if (totalOrders >= 20 && totalSpend === 0) {
        score += 5;
        reasons.push({ description: `Suspicious buyer: ${totalOrders} orders with zero purchase value.`, sentiment: "NEGATIVE" });
      }

      // --- 6. Refund abuse ---
      if (refundRate >= 0.5 && totalOrders >= 3) {
        score += 4;
        reasons.push({ description: `High refund rate (${Math.round(refundRate * 100)}%).`, sentiment: "NEGATIVE" });
      }
      

      // --- 7. Payment Abuse (Pending payments, especially with digital/prepaid gateways)
      if (isPendingPayment && !isCurrentCod && paymentType !== "Manual_Pending_Order") {
        score += 5; 
        reasons.push({ 
        description: `Suspicious Payment: Status is 'pending' for a digital/prepaid gateway (${paymentType}). Do not fulfill until funds clear.`, 
        sentiment: "NEGATIVE" 
        });
     }

      // --- 8. COD abuse ---
      if (codRate >= 0.7 && rtoCount >= 1 && totalOrders >= 3) {
        score += 4;
        reasons.push({ description: `COD abuse suspected (${codCount}/${totalOrders} COD orders with RTO history).`, sentiment: "NEGATIVE" });
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

    // Loyalty Signals (Strictly based on Paid & Delivered history)
    if (validOrderCount >= 5) {
      score -= 3;
      reasons.push({
        description: `Loyal repeat buyer (${validOrderCount} paid & delivered orders).`,
        sentiment: "POSITIVE"
      });
    }
  }

  // --- FIX: Address fraud network (Requires a valid address length) ---
  if (shippingAddress1 && shippingAddress1.trim().length > 5) {
    const addressOrders = await prisma.shopify_store_order.findMany({
      where: { shop, shippingAddress1: shippingAddress1.trim() }
    });

    const uniqueCustomers = new Set(addressOrders.map(o => o.customerEmail).filter(Boolean));

    if (uniqueCustomers.size >= 4) {
      score += 5;
      reasons.push({ description: `Fraud network suspected: ${uniqueCustomers.size} buyers shipping to the same address.`, sentiment: "NEGATIVE" });
    }
  }

  // --- FIX: Phone fraud network (Requires a valid phone length) ---
  if (customerPhone && customerPhone.trim().length > 6) {
    const phoneOrders = await prisma.shopify_store_order.findMany({
      where: { shop, customerPhone: customerPhone.trim() }
    });

    const uniqueCustomers = new Set(phoneOrders.map(o => o.customerEmail).filter(Boolean));

    if (uniqueCustomers.size >= 4) {
      score += 5;
      reasons.push({ description: `Fraud network suspected: phone number used by ${uniqueCustomers.size} customers.`, sentiment: "NEGATIVE" });
    }
  }

  // Final Risk Level
  let riskLevel = "LOW";

  if (score >= 7) riskLevel = "HIGH";
  else if (score >= 3) riskLevel = "MEDIUM";
  
  // Sort reasons by sentiment for better readability
  reasons.sort((a, b) => {
    const sortOrder = { "NEGATIVE": 1, "NEUTRAL": 2, "POSITIVE": 3 };
    const rankA = sortOrder[a.sentiment] || 4; // Default to 4 if sentiment is missing
    const rankB = sortOrder[b.sentiment] || 4;
    return rankA - rankB;
  });

  console.log(`\n=== RISK ASSESSMENT RESULT ===`);
  console.log(`Risk Level: ${riskLevel} (Score: ${score})`);
  console.log(`Reasons:`, reasons);
  console.log(`==============================\n`);
 
  // --- UPSERT THE BUYER PROFILE FOR THE DASHBOARD ---
  await updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid);
  
  // Save Score (UPSERT) the risk score to our local database for quick retrieval
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


