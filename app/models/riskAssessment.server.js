import prisma from "../db.server.js";
import { enqueueOutboundRisk } from "./queue.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";

// --- EXTERNAL API HELPER ---
async function checkAddressValidity(orderId, fullAddress) {
  if (!fullAddress || fullAddress.trim() === "") return null;

  try {
    const cleanAddress = fullAddress.replace(/,/g, '');
    const apiPayload = {
      places: [
        {
          wbn: orderId.toString(),
          address: cleanAddress
        }
      ]
    };

    console.log(`[Address API] Sending Payload for ${orderId}:`, JSON.stringify(apiPayload, null, 2));

    const response = await fetch("https://maponomy2.potterstech.com/api/v3/clients/places/geocode", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "-R2MwSaKhhtkOp0GxrO7BU5ISaOO6qM7xEAlzxSh" 
      },
      body: JSON.stringify(apiPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Address API] HTTP Error ${response.status} Details:`, errorText);
      return null;
    }

    const responseData = await response.json();
    console.log(`[Address API] Response received for order ${orderId}:`, JSON.stringify(responseData, null, 2));
    
    if (responseData.success && responseData.data) {
      // 1. Check the primary 'places' array first
      if (responseData.data.places && responseData.data.places.length > 0) {
        if (responseData.data.places[0].hasOwnProperty('match')) {
          return responseData.data.places[0].match; 
        }
      }
      
      // 2. Check the 'outside_places' array (Fallback)
      if (responseData.data.outside_places && responseData.data.outside_places.length > 0) {
        console.log(`[Address API] Address found in 'outside_places'. Treating as a valid real-world address.`);
        return true;
      }

      // 3. If both arrays are empty, the address could not be found anywhere.
      console.log(`[Address API] Address not found in 'places' or 'outside_places'. Treating as invalid/fake.`);
      return false;
    }

    return null; 
  } catch (error) {
    console.error("[Address API] Failed to validate address:", error);
    return null; 
  }
}

// --- DEFAULT SETTINGS FALLBACK ---
const DEFAULT_WEIGHTS = {
  guestCodPenalty: 15, shortNamePenalty: 20, missingAddressPenalty: 30,
  missingHouseNoPenalty: 15, cancelWeight: 35, disputeWeight: 50,
  rtoWeight: 35, abandonWeight: 25, zeroValuePenalty: 25,
  refundWeight: 25, pendingPaymentPenalty: 20, codAbuseWeight: 20,
  valueAnomalyPenalty: 15, loyaltyBonus: 5, addressFraudPenalty: 30,
  phoneFraudPenalty: 30, hoardingHighPenalty: 30, hoardingMedPenalty: 15
};

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

  let paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";

  const isDraftOrder = payload.source_name === "shopify_draft_order" || payload.source_name === "2932204";
  const isPendingPayment = payload.financial_status === "pending";
  
  const orderTags = (payload.tags || "").toLowerCase();
  const orderNote = (payload.note || "").toLowerCase();

  if (isDraftOrder && isPendingPayment) {
    const hasCodClue = orderTags.includes("cod") || orderTags.includes("cash") || orderNote.includes("cod") || orderNote.includes("cash");
    if (hasCodClue) {
      paymentType = "Admin_Draft_COD"; 
    } 
    else if (paymentType === "UNKNOWN") {
      paymentType = "Manual_Pending_Order"; 
    }
  }

  const currentProductIds = payload.line_items?.map(item => item.product_id).filter(Boolean) || [];

  // --- ADDRESS FINGERPRINT GENERATION ---
  const currentFingerprint = [shippingAddress1, shippingZip, shippingCountry]
    .filter(Boolean).join("").toLowerCase().replace(/[\s,]/g, "");

  // Sync order locally (UPSERT)
  let storeOrderId = null;

  try {
    const result = await prisma.shopify_store_order.upsert({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId: orderGid } },
      update: {
        financialStatus: payload.financial_status, fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        paymentGateway: paymentType, customerPhone, shippingAddress1, shippingAddress2,
        shippingCity, shippingProvince, shippingZip, shippingCountry, billingAddress1,
        billingAddress2, billingCity, billingProvince, billingZip, billingCountry,
        firstName, lastName, lineItemsData: JSON.stringify(currentProductIds)
      },
      create: {
        shop, shopifyOrderId: orderGid, customerId, firstName, lastName, customerEmail,
        orderValue, paymentGateway: paymentType, customerPhone, shippingAddress1,
        shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry,
        billingAddress1, billingAddress2, billingCity, billingProvince, billingZip,
        billingCountry, financialStatus: payload.financial_status,
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

  // --- Fetch Merchant Settings ---
  let shopSettings = DEFAULT_WEIGHTS;
  try {
    const fetchedSettings = await prisma.zippyy_risk_settings.findUnique({ where: { shop } });
    if (fetchedSettings) shopSettings = { ...DEFAULT_WEIGHTS, ...fetchedSettings };
  } catch (error) {
    console.error("Error fetching risk settings, falling back to defaults:", error);
  }
  console.log(`[Risk Settings] Weights loaded for ${shop}:`, shopSettings);

  // --- External API Address Validation (With Caching) ---
  let isAddressValid = null;
  let needsApiCheck = true;

  if (currentFingerprint.length > 5 && (customerEmail || customerId)) {
    const previousOrderWithSameAddress = await prisma.shopify_store_order.findFirst({
      where: {
        shop,
        OR: [{ customerEmail }, { customerId }],
        addressFingerprint: currentFingerprint,
        shopifyOrderId: { not: orderGid } 
      }
    });

    if (previousOrderWithSameAddress && previousOrderWithSameAddress.addressFingerprint !== null) {
      console.log(`[Address Check]  CACHE HIT: Exact address matched past Order ${previousOrderWithSameAddress.shopifyOrderId}. Skipping API. (Result: ${previousOrderWithSameAddress.addressVerified})`);
      isAddressValid = previousOrderWithSameAddress.addressVerified;
      needsApiCheck = false;
    }
  }

  if (needsApiCheck) {
    console.log(`[Address Check]  LIVE API CALL: New or updated address detected. Triggering external API for Order ${payload.id}...`);
    
    const fullAddressString = [
      shippingAddress1, 
      shippingAddress2, 
      shippingCity, 
      shippingProvince, 
      shippingZip, 
      shippingCountry
    ].filter(Boolean).join(" ");
    
    isAddressValid = await checkAddressValidity(payload.id, fullAddressString);
    
    console.log(`[Address Check]  LIVE API RESULT: Order ${payload.id} returned match -> ${isAddressValid}`);
  }

  // RISK ENGINE
  
  let riskPercentage = 0;
  let reasons = [];

  const currentGatewayStr = paymentType.toLowerCase();
  const isCurrentCod = currentGatewayStr.includes("cod") || currentGatewayStr.includes("cash") || currentGatewayStr.includes("pay on delivery");

  if (!customer && isCurrentCod) {
    riskPercentage += shopSettings.guestCodPenalty;
    reasons.push({ description: `Guest checkout with COD.`, sentiment: "NEGATIVE" });
  }

  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (!fullName || fullName.length <= 3) {
    riskPercentage += shopSettings.shortNamePenalty; 
    reasons.push({ description: `Suspicious Name: Missing or too short.`, sentiment: "NEGATIVE" });
  }
  // --- UNIFIED ADDRESS, HOUSE NUMBER & PINCODE EVALUATION ---
  const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
  const cleanZip = shippingZip.replace(/[\s-]/g, "");
  
  if (!shippingStreetLines) {
    riskPercentage += shopSettings.missingAddressPenalty;
    reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
  } else {
    
    if (isAddressValid === false) {
      // SCENARIO 1: Fake Address (Skip house number & pincode checks entirely)
      riskPercentage += 80; 
      reasons.push({ 
        description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, 
        sentiment: "NEGATIVE" 
      });

    } else if (isAddressValid === true) {
      // SCENARIO 2: Valid Address (Check for missing house number & bad pincode)
      const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
      
      if (!hasHouseNumber) {
        riskPercentage += shopSettings.missingHouseNoPenalty;
        reasons.push({ 
          description: `Logistics API Alert: Verified real-world address, but missing a specific house/apartment number.`, 
          sentiment: "NEGATIVE" 
        });
      }

      if (!cleanZip || cleanZip.length < 4) {
        riskPercentage += 20; 
        reasons.push({ 
          description: `Logistics API Alert: Verified real-world address, but Postal/ZIP Code is missing or incomplete.`,
          sentiment: "NEGATIVE" 
        });
      } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
        riskPercentage += 30; 
        reasons.push({ 
          description: `Logistics API Alert: Verified real-world address, but fake Postal/ZIP Code sequence detected (${shippingZip}).`, 
          sentiment: "NEGATIVE" 
        });
      }

    } else {
      // SCENARIO 3: API Failed/Null (Fallback to basic check without 'Verified' tag)
      const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
      
      if (!hasHouseNumber) {
        riskPercentage += shopSettings.missingHouseNoPenalty;
        reasons.push({ 
          description: `Logistics API Alert: House Number missing in address.`, 
          sentiment: "NEGATIVE" 
        });
      }

      if (!cleanZip || cleanZip.length < 4) {
        riskPercentage += 20; 
        reasons.push({ 
          description: `Logistics API Alert: Postal/ZIP Code is missing or incomplete.`, 
          sentiment: "NEGATIVE" 
        });
      } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
        riskPercentage += 30; 
        reasons.push({ 
          description: `Logistics API Alert: Fake Postal/ZIP Code sequence detected (${shippingZip}).`, 
          sentiment: "NEGATIVE" 
        });
      }
    }
  }
  let totalOrders = 0, totalSpend = 0, cancelledCount = 0, disputedCount = 0;
  let rtoCount = 0, refundCount = 0, codCount = 0, validOrderCount = 0, validTotalSpend = 0;

  let historyWhere = { shop };
  if (customerId && customerEmail) historyWhere.OR = [{ customerId }, { customerEmail }];
  else if (customerId) historyWhere.customerId = customerId;
  else if (customerEmail) historyWhere.customerEmail = customerEmail;

  if (historyWhere.customerId || historyWhere.customerEmail || historyWhere.OR) {
    const pastOrders = await prisma.shopify_store_order.findMany({ where: historyWhere });
    const history = pastOrders.filter(o => o.shopifyOrderId !== orderGid);

    totalOrders = history.length;
    if (totalOrders === 0) {
      reasons.push({ description: "New Customer (No prior order history).", sentiment: "NEUTRAL" });
    }

    history.forEach(o => {
      const fStatus = o.financialStatus?.toUpperCase();
      const fulfillment = o.fulfillmentStatus?.toUpperCase();
      const pastGatewayStr = o.paymentGateway?.toLowerCase() || "";
      const isCod = pastGatewayStr.includes("cod") || pastGatewayStr.includes("cash");

      if (isCod) codCount++;
      if (o.hasDispute) disputedCount++;
      if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

      if (o.cancelledAt || fulfillment === "CANCELLED") cancelledCount++;
      else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") rtoCount++;

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
    let disputeRate = totalOrders > 0 ? disputedCount / totalOrders : 0;
    let codRate = totalOrders > 0 ? codCount / totalOrders : 0;
    const successRate = totalOrders > 0 ? (validOrderCount / totalOrders) : 0;
    
    if (currentProductIds.length > 0 && history.length > 0) {
      let maxUnpaidSameProduct = 0;
      let hasSuccessfulSameProduct = false;

      currentProductIds.forEach(productId => {
        let unpaidCount = 0, successCount = 0;
        history.forEach(pastOrder => {
          let pastProductIds = [];
          try { pastProductIds = pastOrder.lineItemsData ? JSON.parse(pastOrder.lineItemsData) : []; } catch (e) {}

          if (pastProductIds.includes(productId)) {
            const fStatus = pastOrder.financialStatus?.toUpperCase();
            const fulfillment = pastOrder.fulfillmentStatus?.toUpperCase();
            const isClean = !pastOrder.cancelledAt && !(pastOrder.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !pastOrder.hasDispute;

            if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) successCount++;
            else unpaidCount++;
          }
        });

        if (unpaidCount > maxUnpaidSameProduct) maxUnpaidSameProduct = unpaidCount;
        if (successCount > 0) hasSuccessfulSameProduct = true;
      });

      if (!hasSuccessfulSameProduct) {
        if (maxUnpaidSameProduct >= 5) {
          riskPercentage += shopSettings.hoardingHighPenalty; 
          reasons.push({ description: `Targeted Hoarding: Ordered exact product ${maxUnpaidSameProduct} times without fulfilling.`, sentiment: "NEGATIVE" });
        } else if (maxUnpaidSameProduct >= 3) {
          riskPercentage += shopSettings.hoardingMedPenalty; 
          reasons.push({ description: `Suspicious Repeat Item: Ordered exact product ${maxUnpaidSameProduct} times without fulfilling.`, sentiment: "NEGATIVE" });
        }
      }
    }
  
    // --- UPDATED BEHAVIOR RULES WITH VOLUME AMPLIFIERS & OLD PHRASING ---
    if (totalOrders > 0) {
      
      // 1. Cancellation Rule (With Volume Penalty)
      if (cancelRate > 0) {
        let cancelRiskCalc = Math.round(cancelRate * shopSettings.cancelWeight);
        // Amplifiers for extreme sheer volume
        if (cancelledCount >= 10) cancelRiskCalc += 20; 
        else if (cancelledCount >= 5) cancelRiskCalc += 10;

        riskPercentage += cancelRiskCalc;
        reasons.push({ description: `High Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // 2. Dispute Rule
      if (disputeRate > 0) {
        let disputeRiskCalc = Math.round(disputeRate * shopSettings.disputeWeight);
        riskPercentage += disputeRiskCalc;
        reasons.push({ description: `Customer has disputed ${disputedCount} out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // 3. RTO Rule (With Volume Penalty)
      if (rtoRate > 0) {
        let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
        if (rtoCount >= 5) rtoRiskCalc += 15;

        riskPercentage += rtoRiskCalc;
        reasons.push({ description: `High RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // 4. Serial Abandoner (With Volume Penalty)
      if (totalOrders >= 5 && successRate <= 0.20) {
        let abandonRiskCalc = Math.round((1 - successRate) * shopSettings.abandonWeight);
        // Extreme volume amplifiers (Catches the 107 orders guy)
        if (totalOrders >= 20 && validOrderCount <= 1) abandonRiskCalc += 35;
        else if (totalOrders >= 10 && validOrderCount === 0) abandonRiskCalc += 20;

        riskPercentage += abandonRiskCalc;
        reasons.push({ description: `Serial order abandoner: ${totalOrders} orders but only ${validOrderCount} successful purchases.`, sentiment: "NEGATIVE" });
      }

      // 5. Zero Value
      if (totalOrders >= 5 && totalSpend === 0) {
        riskPercentage += shopSettings.zeroValuePenalty;
        reasons.push({ description: `Suspicious buyer: ${totalOrders} orders with 0 total successful spend.`, sentiment: "NEGATIVE" });
      }

      // 6. Refund Abuse
      if (refundRate >= 0.5 && totalOrders >= 3) {
        let refundRiskCalc = Math.round(refundRate * shopSettings.refundWeight);
        riskPercentage += refundRiskCalc;
        reasons.push({ description: `High refund rate: ${refundCount} out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // 7. Payment Status Check
      if (isPendingPayment && !isCurrentCod && paymentType !== "Manual_Pending_Order") {
        riskPercentage += shopSettings.pendingPaymentPenalty; 
        reasons.push({ description: `Suspicious Payment: Pending digital gateway (${paymentType}). Do not fulfill.`, sentiment: "NEGATIVE" });
      }

      // 8. COD Abuse
      if (codRate >= 0.7 && rtoCount >= 1 && totalOrders >= 3) {
        let codAbuseRiskCalc = Math.round(codRate * shopSettings.codAbuseWeight); 
        riskPercentage += codAbuseRiskCalc;
        reasons.push({ description: `COD abuse suspected: ${codCount} COD orders with RTO history.`, sentiment: "NEGATIVE" });
      }
    }

    const avgValidSpend = validOrderCount > 0 ? validTotalSpend / validOrderCount : 0;
    if (orderValue > avgValidSpend * 5 && avgValidSpend > 0) {
      riskPercentage += shopSettings.valueAnomalyPenalty;
      reasons.push({ description: `Order value unusually high compared to successful history.`, sentiment: "NEGATIVE" });
    }

    if (validOrderCount >= 3) {
      let loyaltyDiscount = Math.min(30, validOrderCount * shopSettings.loyaltyBonus); 
      riskPercentage -= loyaltyDiscount;
      reasons.push({ description: `Loyal repeat buyer: ${validOrderCount} paid & delivered orders.`, sentiment: "POSITIVE" });
    }
  }

  // --- Fraud Networks ---
  if (shippingAddress1 && shippingAddress1.trim().length > 5) {
    const addressOrders = await prisma.shopify_store_order.findMany({ where: { shop, shippingAddress1: shippingAddress1.trim() } });
    const uniqueCustomers = new Set(addressOrders.map(o => o.customerEmail).filter(Boolean));
    if (uniqueCustomers.size >= 4) {
      riskPercentage += shopSettings.addressFraudPenalty;
      reasons.push({ description: `Fraud network suspected: ${uniqueCustomers.size} buyers using exact same address.`, sentiment: "NEGATIVE" });
    }
  }

  if (customerPhone && customerPhone.trim().length > 6) {
    const phoneOrders = await prisma.shopify_store_order.findMany({ where: { shop, customerPhone: customerPhone.trim() } });
    const uniqueCustomers = new Set(phoneOrders.map(o => o.customerEmail).filter(Boolean));
    if (uniqueCustomers.size >= 4) {
      riskPercentage += shopSettings.phoneFraudPenalty;
      reasons.push({ description: `Fraud network suspected: phone number used by ${uniqueCustomers.size} different customers.`, sentiment: "NEGATIVE" });
    }
  }

  // Final Boundaries
  const score = Math.max(0, Math.min(100, Math.round(riskPercentage)));

  let riskLevel = "LOW";
  if (score >= 70) riskLevel = "HIGH";
  else if (score >= 40) riskLevel = "MEDIUM";
  
  reasons.sort((a, b) => {
    const sortOrder = { "NEGATIVE": 1, "NEUTRAL": 2, "POSITIVE": 3 };
    const rankA = sortOrder[a.sentiment] || 4; 
    const rankB = sortOrder[b.sentiment] || 4;
    return rankA - rankB;
  });

  console.log(`\n=== RISK ASSESSMENT RESULT ===`);
  console.log(`Risk Level: ${riskLevel} (Score: ${score}%)`);
  console.log(`Reasons:`, reasons);
  console.log(`==============================\n`);

  // SAVE FINAL FINGERPRINT AND VALIDATION STATUS 
  // We ONLY save this to the database once the API has given us a definitive result.
  if (isAddressValid !== null) {
    try {
      await prisma.shopify_store_order.update({
        where: { id: storeOrderId },
        data: { 
          addressVerified: isAddressValid, 
          addressFingerprint: currentFingerprint
        }
      });
    } catch (error) {
      console.error("Failed to save final address validation status:", error);
    }
  }

  // --- UPSERT THE BUYER PROFILE FOR THE DASHBOARD ---
  await updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid);
  
  try {
    await prisma.zippyy_risk_score.upsert({
      where: { orderId: storeOrderId },
      update: { score, riskLevel, reasons: reasons.map(r => r.description).join(" | ") },
      create: {
        shop, orderId: storeOrderId, score, riskLevel, reasons: reasons.map(r => r.description).join(" | ")
      }
    });
    console.log(`✓ Saved Risk Score for order ${payload.id}`);
  } catch (error) {
    console.error("Error saving Risk Score locally:", error);
    return new Response();
  }

  const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));

  try {
    await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);
    console.log(` [INBOUND COMPLETE] Successfully routed ${riskLevel} risk score to Outbound Queue.`);
  } catch (error) {
    console.error(` Failed to route outbound data:`, error);
    throw error;
  }

  return new Response();
}











// import prisma from "../db.server.js";
// import { enqueueOutboundRisk } from "./queue.server.js";
// import { updateSingleBuyerProfile } from "./Sync.server.js";

// // --- EXTERNAL API HELPER ---
// async function checkAddressValidity(orderId, fullAddress) {
//   if (!fullAddress || fullAddress.trim() === "") return null;

//   try {
//     // 1. Remove commas to match your API's exact expected format
//     const cleanAddress = fullAddress.replace(/,/g, '');

//     // 2. Build the payload
//     const apiPayload = {
//       places: [
//         {
//           // If the API strictly requires the "JOB" prefix, change this to: `JOB${orderId.toString()}`
//           wbn: orderId.toString(), 
//           address: cleanAddress
//         }
//       ]
//     };

   
//     console.log(`[Address API] Sending Payload for ${orderId}:`, JSON.stringify(apiPayload, null, 2));

//     const response = await fetch("https://maponomy2.potterstech.com/api/v3/clients/places/geocode", {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         "x-api-key": "-R2MwSaKhhtkOp0GxrO7BU5ISaOO6qM7xEAlzxSh" 
//       },
//       body: JSON.stringify(apiPayload)
//     });

//     if (!response.ok) {
//       // Log the actual text response from the API to see the exact validation error
//       const errorText = await response.text();
//       console.error(`[Address API] 422 Error Details:`, errorText);
//       throw new Error(`API HTTP error: ${response.status}`);
//     }

//     const responseData = await response.json();
//     console.log(`[Address API] Response received for order ${orderId}:`, JSON.stringify(responseData, null, 2));
//     if (responseData.success && responseData.data?.places?.length > 0) {
//       return responseData.data.places[0].match; 
//     }

//     return null; 
//   } catch (error) {
//     console.error("[Address API] Failed to validate address:", error);
//     return null; 
//   }
// }


// // --- DEFAULT SETTINGS FALLBACK ---
// const DEFAULT_WEIGHTS = {
//   guestCodPenalty: 15, shortNamePenalty: 20, missingAddressPenalty: 30,
//   missingHouseNoPenalty: 15, cancelWeight: 35, disputeWeight: 50,
//   rtoWeight: 35, abandonWeight: 25, zeroValuePenalty: 25,
//   refundWeight: 25, pendingPaymentPenalty: 20, codAbuseWeight: 20,
//   valueAnomalyPenalty: 15, loyaltyBonus: 5, addressFraudPenalty: 30,
//   phoneFraudPenalty: 30, hoardingHighPenalty: 30, hoardingMedPenalty: 15
// };

// export async function calculateAndApplyRiskScore(shop, payload) {
//   // IDEMPOTENCY CHECK
//   if (payload.tags && payload.tags.includes("Zippyy:")) {
//     console.log(`[Idempotency] Order ${payload.id} already assessed. Skipping duplicate webhook.`);
//     return new Response();
//   }

//   console.log(`Starting Risk Assessment for Order: ${payload.id}`);

//   // Extract Order Data
//   const orderGid = payload.admin_graphql_api_id;
//   const customer = payload.customer;

//   const customerId = customer?.admin_graphql_api_id || customer?.id?.toString() || null;
//   const customerEmail = customer?.email || payload.email || null;

//   const customerPhone = payload.phone || payload.shipping_address?.phone || null;
//   const shippingAddress1 = payload.shipping_address?.address1?.trim() || "";
//   const shippingAddress2 = payload.shipping_address?.address2?.trim() || "";
//   const shippingCity = payload.shipping_address?.city?.trim() || "";
//   const shippingProvince = payload.shipping_address?.province?.trim() || payload.shipping_address?.province_code?.trim() || "";
//   const shippingZip = payload.shipping_address?.zip?.trim() || "";
//   const shippingCountry = payload.shipping_address?.country?.trim() || payload.shipping_address?.country_code?.trim() || "";
//   const billingAddress1 = payload.billing_address?.address1?.trim() || "";
//   const billingAddress2 = payload.billing_address?.address2?.trim() || "";
//   const billingCity = payload.billing_address?.city?.trim() || "";
//   const billingProvince = payload.billing_address?.province?.trim() || payload.billing_address?.province_code?.trim() || "";
//   const billingZip = payload.billing_address?.zip?.trim() || "";
//   const billingCountry = payload.billing_address?.country?.trim() || payload.billing_address?.country_code?.trim() || "";

//   const firstName = customer?.first_name || payload.shipping_address?.first_name || payload.billing_address?.first_name || null;
//   const lastName = customer?.last_name || payload.shipping_address?.last_name || payload.billing_address?.last_name || null;
//   const orderValue = parseFloat(payload.total_price || "0");

//   let paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";

//   const isDraftOrder = payload.source_name === "shopify_draft_order" || payload.source_name === "2932204";
//   const isPendingPayment = payload.financial_status === "pending";
  
//   const orderTags = (payload.tags || "").toLowerCase();
//   const orderNote = (payload.note || "").toLowerCase();

//   if (isDraftOrder && isPendingPayment) {
//     const hasCodClue = orderTags.includes("cod") || orderTags.includes("cash") || orderNote.includes("cod") || orderNote.includes("cash");
//     if (hasCodClue) {
//       paymentType = "Admin_Draft_COD"; 
//     } 
//     else if (paymentType === "UNKNOWN") {
//       paymentType = "Manual_Pending_Order"; 
//     }
//   }

//   const currentProductIds = payload.line_items?.map(item => item.product_id).filter(Boolean) || [];

//   // Sync order locally (UPSERT)
//   let storeOrderId = null;

//   try {
//     const result = await prisma.shopify_store_order.upsert({
//       where: { shop_shopifyOrderId: { shop, shopifyOrderId: orderGid } },
//       update: {
//         financialStatus: payload.financial_status, fulfillmentStatus: payload.fulfillment_status,
//         cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
//         paymentGateway: paymentType, customerPhone, shippingAddress1, shippingAddress2,
//         shippingCity, shippingProvince, shippingZip, shippingCountry, billingAddress1,
//         billingAddress2, billingCity, billingProvince, billingZip, billingCountry,
//         firstName, lastName, lineItemsData: JSON.stringify(currentProductIds)
//       },
//       create: {
//         shop, shopifyOrderId: orderGid, customerId, firstName, lastName, customerEmail,
//         orderValue, paymentGateway: paymentType, customerPhone, shippingAddress1,
//         shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry,
//         billingAddress1, billingAddress2, billingCity, billingProvince, billingZip,
//         billingCountry, financialStatus: payload.financial_status,
//         fulfillmentStatus: payload.fulfillment_status,
//         cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
//         lineItemsData: JSON.stringify(currentProductIds) 
//       }
//     });

//     storeOrderId = result.id;
//   } catch (error) {
//     console.error("Local Sync Error:", error);
//     return new Response();
//   }

//   // IDEMPOTENCY CHECK 2
//   if (storeOrderId) {
//     const existingRisk = await prisma.zippyy_risk_score.findUnique({
//       where: { orderId: storeOrderId }
//     });

//     if (existingRisk) {
//       console.log(`[Idempotency] Risk score already exists for order ${payload.id}. Skipping.`);
//       return new Response();
//     }
//   }

//   // --- Fetch Merchant Settings ---
//   let shopSettings = DEFAULT_WEIGHTS;
//   try {
//     const fetchedSettings = await prisma.zippyy_risk_settings.findUnique({ where: { shop } });
//     if (fetchedSettings) shopSettings = { ...DEFAULT_WEIGHTS, ...fetchedSettings };
//   } catch (error) {
//     console.error("Error fetching risk settings, falling back to defaults:", error);
//   }
//   console.log(`[Risk Settings] Weights loaded for ${shop}:`, shopSettings);

//   // --- External API Address Validation ---
//   console.log(`[Address API] Validating address for order ${payload.id}...`);
//   const fullAddressString = [
//     shippingAddress1, 
//     shippingAddress2, 
//     shippingCity, 
//     shippingProvince, 
//     shippingZip, 
//     shippingCountry
//   ].filter(Boolean).join(", ");

//   const isAddressValid = await checkAddressValidity(payload.id, fullAddressString);

//   // RISK ENGINE
  
//   let riskPercentage = 0;
//   let reasons = [];

//   const currentGatewayStr = paymentType.toLowerCase();
//   const isCurrentCod = currentGatewayStr.includes("cod") || currentGatewayStr.includes("cash") || currentGatewayStr.includes("pay on delivery");

//   if (!customer && isCurrentCod) {
//     riskPercentage += shopSettings.guestCodPenalty;
//     reasons.push({ description: `Guest checkout with COD.`, sentiment: "NEGATIVE" });
//   }

//   const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
//   if (!fullName || fullName.length <= 3) {
//     riskPercentage += shopSettings.shortNamePenalty; 
//     reasons.push({ description: `Suspicious Name: Missing or too short.`, sentiment: "NEGATIVE" });
//   }

//   const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
//   if (!shippingStreetLines) {
//     riskPercentage += shopSettings.missingAddressPenalty;
//     reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
//   } else {
//     const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
//     if (!hasHouseNumber) {
//       riskPercentage += shopSettings.missingHouseNoPenalty;
//       reasons.push({ description: `House Number missing in address.`, sentiment: "NEGATIVE" });
//     }
//   }

//   // --- API Validation Penalty ---
//   if (isAddressValid === false) {
//     riskPercentage += 40; 
//     reasons.push({ 
//       description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, 
//       sentiment: "NEGATIVE" 
//     });
//   }

//   let totalOrders = 0, totalSpend = 0, cancelledCount = 0, disputedCount = 0;
//   let rtoCount = 0, refundCount = 0, codCount = 0, validOrderCount = 0, validTotalSpend = 0;

//   let historyWhere = { shop };
//   if (customerId && customerEmail) historyWhere.OR = [{ customerId }, { customerEmail }];
//   else if (customerId) historyWhere.customerId = customerId;
//   else if (customerEmail) historyWhere.customerEmail = customerEmail;

//   if (historyWhere.customerId || historyWhere.customerEmail || historyWhere.OR) {
//     const pastOrders = await prisma.shopify_store_order.findMany({ where: historyWhere });
//     const history = pastOrders.filter(o => o.shopifyOrderId !== orderGid);

//     totalOrders = history.length;
//     if (totalOrders === 0) {
//       reasons.push({ description: "New Customer (No prior order history).", sentiment: "NEUTRAL" });
//     }

//     history.forEach(o => {
//       const fStatus = o.financialStatus?.toUpperCase();
//       const fulfillment = o.fulfillmentStatus?.toUpperCase();
//       const pastGatewayStr = o.paymentGateway?.toLowerCase() || "";
//       const isCod = pastGatewayStr.includes("cod") || pastGatewayStr.includes("cash");

//       if (isCod) codCount++;
//       if (o.hasDispute) disputedCount++;
//       if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

//       if (o.cancelledAt || fulfillment === "CANCELLED") cancelledCount++;
//       else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") rtoCount++;

//       const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
//       if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
//         validOrderCount++;
//         validTotalSpend += Number(o.orderValue || 0);
//       }
//       totalSpend += Number(o.orderValue || 0);
//     });

//     let cancelRate = totalOrders > 0 ? cancelledCount / totalOrders : 0;
//     let rtoRate = totalOrders > 0 ? rtoCount / totalOrders : 0;
//     let refundRate = totalOrders > 0 ? refundCount / totalOrders : 0;
//     let disputeRate = totalOrders > 0 ? disputedCount / totalOrders : 0;
//     let codRate = totalOrders > 0 ? codCount / totalOrders : 0;
//     const successRate = totalOrders > 0 ? (validOrderCount / totalOrders) : 0;
    
//     if (currentProductIds.length > 0 && history.length > 0) {
//       let maxUnpaidSameProduct = 0;
//       let hasSuccessfulSameProduct = false;

//       currentProductIds.forEach(productId => {
//         let unpaidCount = 0, successCount = 0;
//         history.forEach(pastOrder => {
//           let pastProductIds = [];
//           try { pastProductIds = pastOrder.lineItemsData ? JSON.parse(pastOrder.lineItemsData) : []; } catch (e) {}

//           if (pastProductIds.includes(productId)) {
//             const fStatus = pastOrder.financialStatus?.toUpperCase();
//             const fulfillment = pastOrder.fulfillmentStatus?.toUpperCase();
//             const isClean = !pastOrder.cancelledAt && !(pastOrder.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !pastOrder.hasDispute;

//             if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) successCount++;
//             else unpaidCount++;
//           }
//         });

//         if (unpaidCount > maxUnpaidSameProduct) maxUnpaidSameProduct = unpaidCount;
//         if (successCount > 0) hasSuccessfulSameProduct = true;
//       });

//       if (!hasSuccessfulSameProduct) {
//         if (maxUnpaidSameProduct >= 5) {
//           riskPercentage += shopSettings.hoardingHighPenalty; 
//           reasons.push({ description: `Targeted Hoarding: Ordered exact product ${maxUnpaidSameProduct} times without fulfilling.`, sentiment: "NEGATIVE" });
//         } else if (maxUnpaidSameProduct >= 3) {
//           riskPercentage += shopSettings.hoardingMedPenalty; 
//           reasons.push({ description: `Suspicious Repeat Item: Ordered exact product ${maxUnpaidSameProduct} times without fulfilling.`, sentiment: "NEGATIVE" });
//         }
//       }
//     }
  
//     // --- UPDATED BEHAVIOR RULES WITH VOLUME AMPLIFIERS & OLD PHRASING ---
//     if (totalOrders > 0) {
      
//       // 1. Cancellation Rule (With Volume Penalty)
//       if (cancelRate > 0) {
//         let cancelRiskCalc = Math.round(cancelRate * shopSettings.cancelWeight);
//         // Amplifiers for extreme sheer volume
//         if (cancelledCount >= 10) cancelRiskCalc += 20; 
//         else if (cancelledCount >= 5) cancelRiskCalc += 10;

//         riskPercentage += cancelRiskCalc;
//         reasons.push({ description: `High Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
        
//       }

//       // 2. Dispute Rule
//       if (disputeRate > 0) {
//         let disputeRiskCalc = Math.round(disputeRate * shopSettings.disputeWeight);
//         riskPercentage += disputeRiskCalc;
//         reasons.push({ description: `Customer has disputed ${disputedCount} out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // 3. RTO Rule (With Volume Penalty)
//       if (rtoRate > 0) {
//         let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
//         if (rtoCount >= 5) rtoRiskCalc += 15;

//         riskPercentage += rtoRiskCalc;
//         reasons.push({ description: `High RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // 4. Serial Abandoner (With Volume Penalty)
//       if (totalOrders >= 5 && successRate <= 0.20) {
//         let abandonRiskCalc = Math.round((1 - successRate) * shopSettings.abandonWeight);
//         // Extreme volume amplifiers (Catches the 107 orders guy)
//         if (totalOrders >= 20 && validOrderCount <= 1) abandonRiskCalc += 35;
//         else if (totalOrders >= 10 && validOrderCount === 0) abandonRiskCalc += 20;

//         riskPercentage += abandonRiskCalc;
//         reasons.push({ description: `Serial order abandoner: ${totalOrders} orders but only ${validOrderCount} successful purchases.`, sentiment: "NEGATIVE" });
//       }

//       // 5. Zero Value
//       if (totalOrders >= 5 && totalSpend === 0) {
//         riskPercentage += shopSettings.zeroValuePenalty;
//         reasons.push({ description: `Suspicious buyer: ${totalOrders} orders with 0 total successful spend.`, sentiment: "NEGATIVE" });
//       }

//       // 6. Refund Abuse
//       if (refundRate >= 0.5 && totalOrders >= 3) {
//         let refundRiskCalc = Math.round(refundRate * shopSettings.refundWeight);
//         riskPercentage += refundRiskCalc;
//         reasons.push({ description: `High refund rate: ${refundCount} out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // 7. Payment Status Check
//       if (isPendingPayment && !isCurrentCod && paymentType !== "Manual_Pending_Order") {
//         riskPercentage += shopSettings.pendingPaymentPenalty; 
//         reasons.push({ description: `Suspicious Payment: Pending digital gateway (${paymentType}). Do not fulfill.`, sentiment: "NEGATIVE" });
//       }

//       // 8. COD Abuse
//       if (codRate >= 0.7 && rtoCount >= 1 && totalOrders >= 3) {
//         let codAbuseRiskCalc = Math.round(codRate * shopSettings.codAbuseWeight); 
//         riskPercentage += codAbuseRiskCalc;
//         reasons.push({ description: `COD abuse suspected: ${codCount} COD orders with RTO history.`, sentiment: "NEGATIVE" });
//       }
//     }

//     const avgValidSpend = validOrderCount > 0 ? validTotalSpend / validOrderCount : 0;
//     if (orderValue > avgValidSpend * 5 && avgValidSpend > 0) {
//       riskPercentage += shopSettings.valueAnomalyPenalty;
//       reasons.push({ description: `Order value unusually high compared to successful history.`, sentiment: "NEGATIVE" });
//     }

//     if (validOrderCount >= 3) {
//       let loyaltyDiscount = Math.min(30, validOrderCount * shopSettings.loyaltyBonus); 
//       riskPercentage -= loyaltyDiscount;
//       reasons.push({ description: `Loyal repeat buyer: ${validOrderCount} paid & delivered orders.`, sentiment: "POSITIVE" });
//     }
//   }

//   // --- Fraud Networks ---
//   if (shippingAddress1 && shippingAddress1.trim().length > 5) {
//     const addressOrders = await prisma.shopify_store_order.findMany({ where: { shop, shippingAddress1: shippingAddress1.trim() } });
//     const uniqueCustomers = new Set(addressOrders.map(o => o.customerEmail).filter(Boolean));
//     if (uniqueCustomers.size >= 4) {
//       riskPercentage += shopSettings.addressFraudPenalty;
//       reasons.push({ description: `Fraud network suspected: ${uniqueCustomers.size} buyers using exact same address.`, sentiment: "NEGATIVE" });
//     }
//   }

//   if (customerPhone && customerPhone.trim().length > 6) {
//     const phoneOrders = await prisma.shopify_store_order.findMany({ where: { shop, customerPhone: customerPhone.trim() } });
//     const uniqueCustomers = new Set(phoneOrders.map(o => o.customerEmail).filter(Boolean));
//     if (uniqueCustomers.size >= 4) {
//       riskPercentage += shopSettings.phoneFraudPenalty;
//       reasons.push({ description: `Fraud network suspected: phone number used by ${uniqueCustomers.size} different customers.`, sentiment: "NEGATIVE" });
//     }
//   }

//   // Final Boundaries
//   const score = Math.max(0, Math.min(100, Math.round(riskPercentage)));

//   let riskLevel = "LOW";
//   if (score >= 70) riskLevel = "HIGH";
//   else if (score >= 40) riskLevel = "MEDIUM";
  
//   reasons.sort((a, b) => {
//     const sortOrder = { "NEGATIVE": 1, "NEUTRAL": 2, "POSITIVE": 3 };
//     const rankA = sortOrder[a.sentiment] || 4; 
//     const rankB = sortOrder[b.sentiment] || 4;
//     return rankA - rankB;
//   });

//   console.log(`\n=== RISK ASSESSMENT RESULT ===`);
//   console.log(`Risk Level: ${riskLevel} (Score: ${score}%)`);
//   console.log(`Reasons:`, reasons);
//   console.log(`==============================\n`);

//   // --- UPSERT THE BUYER PROFILE FOR THE DASHBOARD ---
//   await updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid);
  
//   try {
//     await prisma.zippyy_risk_score.upsert({
//       where: { orderId: storeOrderId },
//       update: { score, riskLevel, reasons: reasons.map(r => r.description).join(" | ") },
//       create: {
//         shop, orderId: storeOrderId, score, riskLevel, reasons: reasons.map(r => r.description).join(" | ")
//       }
//     });
//     console.log(`✓ Saved Risk Score for order ${payload.id}`);
//   } catch (error) {
//     console.error("Error saving Risk Score locally:", error);
//     return new Response();
//   }

//   const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));

//   try {
//     await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);
//     console.log(` [INBOUND COMPLETE] Successfully routed ${riskLevel} risk score to Outbound Queue.`);
//   } catch (error) {
//     console.error(` Failed to route outbound data:`, error);
//     throw error;
//   }

//   return new Response();
// }




