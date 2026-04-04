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
  // 1. FAST IDEMPOTENCY CHECK (Webhook Tags)
  if (payload.tags && payload.tags.includes("Zippyy:")) {
    console.log(`[Idempotency] Order ${payload.id} already assessed via tags. Skipping.`);
    return new Response(null, { status: 200 });
  }

  console.log(`Starting Risk Assessment for Order: ${payload.id}`);
  const orderGid = payload.admin_graphql_api_id;

  try {
    // 2. STRICT DB IDEMPOTENCY (Avoid expensive operations if already scored)
    const existingLocalOrder = await prisma.shopify_store_order.findUnique({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId: orderGid } }
    });

    if (existingLocalOrder) {
      const existingRisk = await prisma.zippyy_risk_score.findUnique({
        where: { orderId: existingLocalOrder.id }
      });
      if (existingRisk) {
        console.log(`[Idempotency] Risk score already exists in DB for order ${payload.id}. Skipping.`);
        return new Response(null, { status: 200 });
      }
    }

    // 3. EXTRACT ORDER DATA
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
      if (hasCodClue) paymentType = "Admin_Draft_COD"; 
      else if (paymentType === "UNKNOWN") paymentType = "Manual_Pending_Order"; 
    }

    const currentProductIds = payload.line_items?.map(item => item.product_id).filter(Boolean) || [];

    // Address Fingerprint
    const currentFingerprint = [shippingAddress1, shippingZip, shippingCountry]
      .filter(Boolean).join("").toLowerCase().replace(/[\s,]/g, "");

    // 4. SYNC ORDER LOCALLY (UPSERT)
    const orderRecord = await prisma.shopify_store_order.upsert({
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

    const storeOrderId = orderRecord.id;

    // 5. FETCH MERCHANT SETTINGS & CUSTOMER HISTORY
    let historyWhere = { shop, shopifyOrderId: { not: orderGid } }; // Immediately exclude current order
    let hasCustomerIdentifier = false;

    if (customerId && customerEmail) {
      historyWhere.OR = [{ customerId }, { customerEmail }];
      hasCustomerIdentifier = true;
    } else if (customerId) {
      historyWhere.customerId = customerId;
      hasCustomerIdentifier = true;
    } else if (customerEmail) {
      historyWhere.customerEmail = customerEmail;
      hasCustomerIdentifier = true;
    }
    
    const [fetchedSettings, pastOrders] = await Promise.all([
      prisma.zippyy_risk_settings.findUnique({ where: { shop } }),
      hasCustomerIdentifier ? prisma.shopify_store_order.findMany({ 
        where: historyWhere,
        include: { disputes: true } // Pull detailed chargeback history
      }) : Promise.resolve([])
    ]);
    
    let shopSettings = { ...DEFAULT_WEIGHTS, ...(fetchedSettings || {}) };
    const history = pastOrders || [];
    console.log(`[Risk Settings] Weights loaded for ${shop}`);
    
    // 6. ADDRESS VALIDATION API & CACHING
    let isAddressValid = null;
    let needsApiCheck = true;

    if (currentFingerprint.length > 5 && hasCustomerIdentifier) {
      const previousOrder = history.find(o => o.addressFingerprint === currentFingerprint && o.addressVerified !== null);
      if (previousOrder) {
        console.log(`[Address Check] CACHE HIT: Exact address matched past Order. Skipping API. (Result: ${previousOrder.addressVerified})`);
        isAddressValid = previousOrder.addressVerified;
        needsApiCheck = false;
      }
    }

    if (needsApiCheck) {
      console.log(`[Address Check] LIVE API CALL: Triggering external API for Order ${payload.id}...`);
      const fullAddressString = [shippingAddress1, shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry].filter(Boolean).join(" ");
      isAddressValid = await checkAddressValidity(payload.id, fullAddressString);
      console.log(`[Address Check] LIVE API RESULT: Order ${payload.id} returned match -> ${isAddressValid}`);
    }

    // 7. RISK ENGINE & RULES
    let riskPercentage = 0;
    let reasons = [];
    
    const currentGatewayStr = paymentType.toLowerCase();
    const isCurrentCod = currentGatewayStr.includes("cod") || currentGatewayStr.includes("cash") || currentGatewayStr.includes("pay on delivery");
    
    // Guest COD
    if (!customer && isCurrentCod) {
      riskPercentage += shopSettings.guestCodPenalty;
      reasons.push({ description: `Guest checkout with COD.`, sentiment: "NEGATIVE" });
    }

    // Suspicious Name Length
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (!fullName || fullName.length <= 3) {
      riskPercentage += shopSettings.shortNamePenalty; 
      reasons.push({ description: `Suspicious Name: Missing or too short.`, sentiment: "NEGATIVE" });
    }

    // Suspicious Timing (Night Time Penalty)
    const orderDate = new Date(payload.created_at || Date.now());
    const orderHour = orderDate.getHours(); 
    if (orderHour >= 2 && orderHour <= 5) { // Between 2:00 AM and 5:59 AM
      riskPercentage += 40; 
      reasons.push({ description: `Suspicious Timing: Order placed during late night hours (${orderHour}:00).`, sentiment: "NEGATIVE" });
    }

    // Unified Address, House Number & Pincode Checks
    const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
    const cleanZip = shippingZip.replace(/[\s-]/g, "");
    
    if (!shippingStreetLines) {
      riskPercentage += shopSettings.missingAddressPenalty;
      reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
    } else {
      if (isAddressValid === false) {
        riskPercentage += 80; 
        reasons.push({ description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, sentiment: "NEGATIVE" });
      } else {
        const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
        
        if (!hasHouseNumber) {
          riskPercentage += shopSettings.missingHouseNoPenalty;
          reasons.push({ description: `Logistics API Alert: Verified real-world address, but missing a specific house/apartment number.`, sentiment: "NEGATIVE" });
        }

        if (shippingCountry === "IN" || shippingCountry === "India") {
          if (!/^[1-9][0-9]{5}$/.test(cleanZip)) {
            riskPercentage += isAddressValid ? 80 : 30; 
            reasons.push({ description: `Logistics API Alert: Invalid Indian PIN Code format (${shippingZip}).`, sentiment: "NEGATIVE" });
          } else {
            const validPin = await prisma.india_valid_pincodes.findUnique({ where: { postalCode: cleanZip } });
            if (!validPin) {
              riskPercentage += isAddressValid ? 80 : 40; 
              reasons.push({ description: `Logistics Geo-Alert: The postal code (${shippingZip}) does not exist in India. Highly suspicious.`, sentiment: "NEGATIVE" });
            }
          }
        } else {
          if (!cleanZip || cleanZip.length < 4) {
            riskPercentage += 20; 
            reasons.push({ description: `Logistics API Alert: Postal/ZIP Code is missing or incomplete.`, sentiment: "NEGATIVE" });
          } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
            riskPercentage += 30; 
            reasons.push({ description: `Logistics API Alert: Fake Postal/ZIP Code sequence detected (${shippingZip}).`, sentiment: "NEGATIVE" });
          }
        }
      }
    }

    // Historical Behavior & Amplifiers
    let totalSpend = 0, cancelledCount = 0;
    let rtoCount = 0, refundCount = 0, codCount = 0, validOrderCount = 0, validTotalSpend = 0;
    
    // Dispute Counters
    let hasFraudHistory = false;
    let openDisputes = 0;
    let wonDisputes = 0;
    let lostDisputes = 0;

    const totalOrders = history.length;

    if (totalOrders === 0) {
      reasons.push({ description: "New Customer (No prior order history).", sentiment: "NEUTRAL" });
    } else {
      history.forEach(o => {
        const fStatus = o.financialStatus?.toUpperCase();
        const fulfillment = o.fulfillmentStatus?.toUpperCase();
        const pastGatewayStr = o.paymentGateway?.toLowerCase() || "";
        const isCod = pastGatewayStr.includes("cod") || pastGatewayStr.includes("cash");

        if (isCod) codCount++;
        if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

        if (o.cancelledAt || fulfillment === "CANCELLED") cancelledCount++;
        else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") rtoCount++;

        // Deep Dispute Analysis
        if (o.disputes && o.disputes.length > 0) {
          o.disputes.forEach(d => {
            const reason = (d.reason || "").toLowerCase();
            const status = (d.status || "").toLowerCase();

            if (reason === "fraudulent") hasFraudHistory = true;

            if (["needs_response", "under_review"].includes(status)) {
              openDisputes++;
            } else if (status === "won") {
              wonDisputes++;
            } else if (["lost", "charge_refunded"].includes(status)) {
              lostDisputes++;
            }
          });
        } else if (o.hasDispute) {
          lostDisputes++; 
        }

        const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
        if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
          validOrderCount++;
          validTotalSpend += Number(o.orderValue || 0);
        }
        totalSpend += Number(o.orderValue || 0);
      });

      let cancelRate = cancelledCount / totalOrders;
      let rtoRate = rtoCount / totalOrders;
      let refundRate = refundCount / totalOrders;
      let codRate = codCount / totalOrders;
      const successRate = validOrderCount / totalOrders;
      
      // THE DISPUTE DEFENSE GATES
      if (hasFraudHistory) {
        riskPercentage += shopSettings.fraudHistoryPenalty || 100; 
        reasons.push({ description: `CRITICAL ALERT: Buyer has a known history of 'Fraudulent' chargebacks on this store.`, sentiment: "NEGATIVE" });
      }

      if (openDisputes > 0) {
        riskPercentage += shopSettings.openDisputePenalty || 40;
        reasons.push({ description: `Active Risk: Customer is attempting a new purchase while having ${openDisputes} unresolved dispute(s) pending.`, sentiment: "NEGATIVE" });
      }

      if (lostDisputes > 0) {
        let disputeRate = lostDisputes / totalOrders;
        riskPercentage += Math.round(disputeRate * shopSettings.disputeWeight);
        reasons.push({ description: `Financial Loss: Buyer has ${lostDisputes} lost chargeback(s) on record.`, sentiment: "NEGATIVE" });
      }

      if (wonDisputes > 0 && lostDisputes === 0) {
        riskPercentage += 15; 
        reasons.push({ description: `High Friction Buyer: Customer frequently files chargebacks, though the merchant usually wins.`, sentiment: "NEUTRAL" });
      }

      // Hoarding Assessment
      if (currentProductIds.length > 0) {
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
    
      // Volume Cancellations
      if (cancelRate > 0) {
        let cancelRiskCalc = Math.round(cancelRate * shopSettings.cancelWeight);
        if (cancelledCount >= 10) cancelRiskCalc += 20; 
        else if (cancelledCount >= 5) cancelRiskCalc += 10;
        riskPercentage += cancelRiskCalc;
        reasons.push({ description: `High Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // RTO Volume
      if (rtoRate > 0) {
        let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
        if (rtoCount >= 5) rtoRiskCalc += 15;
        riskPercentage += rtoRiskCalc;
        reasons.push({ description: `High RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // Serial Abandoner
      if (totalOrders >= 5 && successRate <= 0.20) {
        let abandonRiskCalc = Math.round((1 - successRate) * shopSettings.abandonWeight);
        if (totalOrders >= 20 && validOrderCount <= 1) abandonRiskCalc += 35;
        else if (totalOrders >= 10 && validOrderCount === 0) abandonRiskCalc += 20;
        riskPercentage += abandonRiskCalc;
        reasons.push({ description: `Serial order abandoner: ${totalOrders} orders but only ${validOrderCount} successful purchases.`, sentiment: "NEGATIVE" });
      }

      // Zero Value Buyer
      if (totalOrders >= 5 && totalSpend === 0) {
        riskPercentage += shopSettings.zeroValuePenalty;
        reasons.push({ description: `Suspicious buyer: ${totalOrders} orders with 0 total successful spend.`, sentiment: "NEGATIVE" });
      }

      // Refund Abuse
      if (refundRate >= 0.5 && totalOrders >= 3) {
        riskPercentage += Math.round(refundRate * shopSettings.refundWeight);
        reasons.push({ description: `High refund rate: ${refundCount} out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // Pending Payments
      if (isPendingPayment && !isCurrentCod && paymentType !== "Manual_Pending_Order") {
        riskPercentage += shopSettings.pendingPaymentPenalty; 
        reasons.push({ description: `Suspicious Payment: Pending digital gateway (${paymentType}). Do not fulfill.`, sentiment: "NEGATIVE" });
      }

      // COD Abuse
      if (codRate >= 0.7 && rtoCount >= 1 && totalOrders >= 3) {
        riskPercentage += Math.round(codRate * shopSettings.codAbuseWeight); 
        reasons.push({ description: `COD abuse suspected: ${codCount} COD orders with RTO history.`, sentiment: "NEGATIVE" });
      }
    }

    // Value Anomaly
    const avgValidSpend = validOrderCount > 0 ? validTotalSpend / validOrderCount : 0;
    if (orderValue > avgValidSpend * 5 && avgValidSpend > 0) {
      riskPercentage += shopSettings.valueAnomalyPenalty;
      reasons.push({ description: `Order value unusually high compared to successful history.`, sentiment: "NEGATIVE" });
    }

    // Loyalty Discount
    if (validOrderCount >= 3) {
      let loyaltyDiscount = Math.min(30, validOrderCount * shopSettings.loyaltyBonus); 
      riskPercentage -= loyaltyDiscount;
      reasons.push({ description: `Loyal repeat buyer: ${validOrderCount} paid & delivered orders.`, sentiment: "POSITIVE" });
    }

    // 8. FRAUD NETWORKS 
    if (shippingAddress1 && shippingAddress1.trim().length > 5) {
      const uniqueCustomersAtAddress = await prisma.shopify_store_order.groupBy({
        by: ['customerEmail'],
        where: { shop, shippingAddress1: shippingAddress1.trim(), customerEmail: { not: null } }
      });
      if (uniqueCustomersAtAddress.length >= 4) {
        riskPercentage += shopSettings.addressFraudPenalty;
        reasons.push({ description: `Fraud network suspected: ${uniqueCustomersAtAddress.length} buyers using exact same address.`, sentiment: "NEGATIVE" });
      }
    }

    if (customerPhone && customerPhone.trim().length > 6) {
      const uniqueCustomersWithPhone = await prisma.shopify_store_order.groupBy({
        by: ['customerEmail'],
        where: { shop, customerPhone: customerPhone.trim(), customerEmail: { not: null } }
      });
      if (uniqueCustomersWithPhone.length >= 4) {
        riskPercentage += shopSettings.phoneFraudPenalty;
        reasons.push({ description: `Fraud network suspected: phone number used by ${uniqueCustomersWithPhone.length} different customers.`, sentiment: "NEGATIVE" });
      }
    }

    // 9. FINALIZE & ROUTE OUTBOUND DATA
    const score = Math.max(0, Math.min(100, Math.round(riskPercentage)));
    let riskLevel = score >= 70 ? "HIGH" : (score >= 40 ? "MEDIUM" : "LOW");

    reasons.sort((a, b) => {
      const sortOrder = { "NEGATIVE": 1, "NEUTRAL": 2, "POSITIVE": 3 };
      return (sortOrder[a.sentiment] || 4) - (sortOrder[b.sentiment] || 4);
    });

    console.log(`\n=== RISK ASSESSMENT RESULT ===\nRisk Level: ${riskLevel} (Score: ${score}%)\nReasons:`, reasons, `\n==============================\n`);

    // Finalize DB Caching for external API
    if (isAddressValid !== null) {
      try {
        await prisma.shopify_store_order.update({
          where: { id: storeOrderId },
          data: { addressVerified: isAddressValid, addressFingerprint: currentFingerprint }
        });
      } catch (error) {
        console.error("Failed to save final address validation status:", error);
      }
    }

    // Dashboard & Risk Score Saving
    await updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid);
    
    await prisma.zippyy_risk_score.upsert({
      where: { orderId: storeOrderId },
      update: { score, riskLevel, reasons: reasons.map(r => r.description).join(" | ") },
      create: { shop, orderId: storeOrderId, score, riskLevel, reasons: reasons.map(r => r.description).join(" | ") }
    });
    console.log(`✓ Saved Risk Score for order ${payload.id}`);

    // Push out to Outbound Integrations Queue
    const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));
    await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);
    console.log(`[INBOUND COMPLETE] Successfully routed ${riskLevel} risk score to Outbound Queue.`);

    // SUCCESS - Tell Shopify to stop retrying
    return new Response(null, { status: 200 });

  } catch (error) {
    // return 500 so Shopify's webhook retry system kicks in if the database drops.
    console.error(`[CRITICAL ERROR] Failed to process Risk Score for Order ${payload.id}:`, error);
    return new Response("Internal Server Error", { status: 500 });
  }
}




















// export async function calculateAndApplyRiskScore(shop, payload) {
//   // 1. FAST IDEMPOTENCY CHECK (Webhook Tags)
//   if (payload.tags && payload.tags.includes("Zippyy:")) {
//     console.log(`[Idempotency] Order ${payload.id} already assessed via tags. Skipping.`);
//     return new Response(null, { status: 200 });
//   }

//   console.log(`Starting Risk Assessment for Order: ${payload.id}`);
//   const orderGid = payload.admin_graphql_api_id;

//   try {
//     // 2. STRICT DB IDEMPOTENCY (Avoid expensive operations if already scored)
//     const existingLocalOrder = await prisma.shopify_store_order.findUnique({
//       where: { shop_shopifyOrderId: { shop, shopifyOrderId: orderGid } }
//     });

//     if (existingLocalOrder) {
//       const existingRisk = await prisma.zippyy_risk_score.findUnique({
//         where: { orderId: existingLocalOrder.id }
//       });
//       if (existingRisk) {
//         console.log(`[Idempotency] Risk score already exists in DB for order ${payload.id}. Skipping.`);
//         return new Response(null, { status: 200 });
//       }
//     }

//     // 3. EXTRACT ORDER DATA

//     const customer = payload.customer;
//     const customerId = customer?.admin_graphql_api_id || customer?.id?.toString() || null;
//     const customerEmail = customer?.email || payload.email || null;
//     const customerPhone = payload.phone || payload.shipping_address?.phone || null;

//     const shippingAddress1 = payload.shipping_address?.address1?.trim() || "";
//     const shippingAddress2 = payload.shipping_address?.address2?.trim() || "";
//     const shippingCity = payload.shipping_address?.city?.trim() || "";
//     const shippingProvince = payload.shipping_address?.province?.trim() || payload.shipping_address?.province_code?.trim() || "";
//     const shippingZip = payload.shipping_address?.zip?.trim() || "";
//     const shippingCountry = payload.shipping_address?.country?.trim() || payload.shipping_address?.country_code?.trim() || "";

//     const billingAddress1 = payload.billing_address?.address1?.trim() || "";
//     const billingAddress2 = payload.billing_address?.address2?.trim() || "";
//     const billingCity = payload.billing_address?.city?.trim() || "";
//     const billingProvince = payload.billing_address?.province?.trim() || payload.billing_address?.province_code?.trim() || "";
//     const billingZip = payload.billing_address?.zip?.trim() || "";
//     const billingCountry = payload.billing_address?.country?.trim() || payload.billing_address?.country_code?.trim() || "";

//     const firstName = customer?.first_name || payload.shipping_address?.first_name || payload.billing_address?.first_name || null;
//     const lastName = customer?.last_name || payload.shipping_address?.last_name || payload.billing_address?.last_name || null;
//     const orderValue = parseFloat(payload.total_price || "0");

//     let paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";
//     const isDraftOrder = payload.source_name === "shopify_draft_order" || payload.source_name === "2932204";
//     const isPendingPayment = payload.financial_status === "pending";
    
//     const orderTags = (payload.tags || "").toLowerCase();
//     const orderNote = (payload.note || "").toLowerCase();

//     if (isDraftOrder && isPendingPayment) {
//       const hasCodClue = orderTags.includes("cod") || orderTags.includes("cash") || orderNote.includes("cod") || orderNote.includes("cash");
//       if (hasCodClue) paymentType = "Admin_Draft_COD"; 
//       else if (paymentType === "UNKNOWN") paymentType = "Manual_Pending_Order"; 
//     }

//     const currentProductIds = payload.line_items?.map(item => item.product_id).filter(Boolean) || [];

//     // Address Fingerprint
//     const currentFingerprint = [shippingAddress1, shippingZip, shippingCountry]
//       .filter(Boolean).join("").toLowerCase().replace(/[\s,]/g, "");


//    // 4. SYNC ORDER LOCALLY (UPSERT)
//     const orderRecord = await prisma.shopify_store_order.upsert({
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

//     const storeOrderId = orderRecord.id;

//     // 5. FETCH MERCHANT SETTINGS & CUSTOMER HISTORY
//     let historyWhere = { shop, shopifyOrderId: { not: orderGid } }; // Immediately exclude current order
//     let hasCustomerIdentifier = false;

//     if (customerId && customerEmail) {
//       historyWhere.OR = [{ customerId }, { customerEmail }];
//       hasCustomerIdentifier = true;
//     } else if (customerId) {
//       historyWhere.customerId = customerId;
//       hasCustomerIdentifier = true;
//     } else if (customerEmail) {
//       historyWhere.customerEmail = customerEmail;
//       hasCustomerIdentifier = true;
//     }

//     // Promise.all speeds up data retrieval safely
//     const [fetchedSettings, pastOrders] = await Promise.all([
//       prisma.zippyy_risk_settings.findUnique({ where: { shop } }),
//       hasCustomerIdentifier ? prisma.shopify_store_order.findMany({ where: historyWhere }) : Promise.resolve([])
//     ]);

//     let shopSettings = { ...DEFAULT_WEIGHTS, ...(fetchedSettings || {}) };
//     const history = pastOrders || [];
//     console.log(`[Risk Settings] Weights loaded for ${shop}`);

//     // 6. ADDRESS VALIDATION API & CACHING
  
//     let isAddressValid = null;
//     let needsApiCheck = true;

//     if (currentFingerprint.length > 5 && hasCustomerIdentifier) {
//       // Find an exact match in the past history data we already fetched
//       const previousOrder = history.find(o => o.addressFingerprint === currentFingerprint && o.addressVerified !== null);
//       if (previousOrder) {
//         console.log(`[Address Check] CACHE HIT: Exact address matched past Order. Skipping API. (Result: ${previousOrder.addressVerified})`);
//         isAddressValid = previousOrder.addressVerified;
//         needsApiCheck = false;
//       }
//     }

//     if (needsApiCheck) {
//       console.log(`[Address Check] LIVE API CALL: Triggering external API for Order ${payload.id}...`);
//       const fullAddressString = [shippingAddress1, shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry].filter(Boolean).join(" ");
//       isAddressValid = await checkAddressValidity(payload.id, fullAddressString);
//       console.log(`[Address Check] LIVE API RESULT: Order ${payload.id} returned match -> ${isAddressValid}`);
//     }

  
//     // 7. RISK ENGINE & RULES

//     let riskPercentage = 0;
//     let reasons = [];

//     const currentGatewayStr = paymentType.toLowerCase();
//     const isCurrentCod = currentGatewayStr.includes("cod") || currentGatewayStr.includes("cash") || currentGatewayStr.includes("pay on delivery");

//     // Guest COD
//     if (!customer && isCurrentCod) {
//       riskPercentage += shopSettings.guestCodPenalty;
//       reasons.push({ description: `Guest checkout with COD.`, sentiment: "NEGATIVE" });
//     }

//     // Suspicious Name Length
//     const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
//     if (!fullName || fullName.length <= 3) {
//       riskPercentage += shopSettings.shortNamePenalty; 
//       reasons.push({ description: `Suspicious Name: Missing or too short.`, sentiment: "NEGATIVE" });
//     }

//     // NEW: Suspicious Timing (Night Time Penalty)
//     const orderDate = new Date(payload.created_at || Date.now());
//     const orderHour = orderDate.getHours(); // Local server hour representation (0-23)
//     if (orderHour >= 2 && orderHour <= 5) { // Between 2:00 AM and 5:59 AM
//       riskPercentage += 40; // High enough to bump straight to 'Medium' risk
//       reasons.push({ description: `Suspicious Timing: Order placed during late night hours (${orderHour}:00).`, sentiment: "NEGATIVE" });
//     }

//     // Unified Address, House Number & Pincode Checks
//     const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
//     const cleanZip = shippingZip.replace(/[\s-]/g, "");
    
//     if (!shippingStreetLines) {
//       riskPercentage += shopSettings.missingAddressPenalty;
//       reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
//     } else {
//       if (isAddressValid === false) {
//         // SCENARIO 1: Fake Address
//         riskPercentage += 80; 
//         reasons.push({ description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, sentiment: "NEGATIVE" });
//       } else {
//         // SCENARIO 2 & 3: Valid Address or Fallback API Null 
//         const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
        
//         if (!hasHouseNumber) {
//           riskPercentage += shopSettings.missingHouseNoPenalty;
//           reasons.push({ description: `Logistics API Alert: Verified real-world address, but missing a specific house/apartment number.`, sentiment: "NEGATIVE" });
//         }

//         if (shippingCountry === "IN" || shippingCountry === "India") {
//           if (!/^[1-9][0-9]{5}$/.test(cleanZip)) {
//             riskPercentage += isAddressValid ? 80 : 30; 
//             reasons.push({ description: `Logistics API Alert: Invalid Indian PIN Code format (${shippingZip}).`, sentiment: "NEGATIVE" });
//           } else {
//             const validPin = await prisma.india_valid_pincodes.findUnique({ where: { postalCode: cleanZip } });
//             if (!validPin) {
//               riskPercentage += isAddressValid ? 80 : 40; 
//               reasons.push({ description: `Logistics Geo-Alert: The postal code (${shippingZip}) does not exist in India. Highly suspicious.`, sentiment: "NEGATIVE" });
//             }
//           }
//         } else {
//           if (!cleanZip || cleanZip.length < 4) {
//             riskPercentage += 20; 
//             reasons.push({ description: `Logistics API Alert: Postal/ZIP Code is missing or incomplete.`, sentiment: "NEGATIVE" });
//           } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
//             riskPercentage += 30; 
//             reasons.push({ description: `Logistics API Alert: Fake Postal/ZIP Code sequence detected (${shippingZip}).`, sentiment: "NEGATIVE" });
//           }
//         }
//       }
//     }

//     // Historical Behavior & Amplifiers
//     let totalSpend = 0, cancelledCount = 0, disputedCount = 0;
//     let rtoCount = 0, refundCount = 0, codCount = 0, validOrderCount = 0, validTotalSpend = 0;
//     const totalOrders = history.length;

//     if (totalOrders === 0) {
//       reasons.push({ description: "New Customer (No prior order history).", sentiment: "NEUTRAL" });
//     } else {
//       history.forEach(o => {
//         const fStatus = o.financialStatus?.toUpperCase();
//         const fulfillment = o.fulfillmentStatus?.toUpperCase();
//         const pastGatewayStr = o.paymentGateway?.toLowerCase() || "";
//         const isCod = pastGatewayStr.includes("cod") || pastGatewayStr.includes("cash");

//         if (isCod) codCount++;
//         if (o.hasDispute) disputedCount++;
//         if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

//         if (o.cancelledAt || fulfillment === "CANCELLED") cancelledCount++;
//         else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") rtoCount++;

//         const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
//         if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
//           validOrderCount++;
//           validTotalSpend += Number(o.orderValue || 0);
//         }
//         totalSpend += Number(o.orderValue || 0);
//       });

//       let cancelRate = cancelledCount / totalOrders;
//       let rtoRate = rtoCount / totalOrders;
//       let refundRate = refundCount / totalOrders;
//       let disputeRate = disputedCount / totalOrders;
//       let codRate = codCount / totalOrders;
//       const successRate = validOrderCount / totalOrders;
      
//       // Hoarding Assessment
//       if (currentProductIds.length > 0) {
//         let maxUnpaidSameProduct = 0;
//         let hasSuccessfulSameProduct = false;

//         currentProductIds.forEach(productId => {
//           let unpaidCount = 0, successCount = 0;
//           history.forEach(pastOrder => {
//             let pastProductIds = [];
//             try { pastProductIds = pastOrder.lineItemsData ? JSON.parse(pastOrder.lineItemsData) : []; } catch (e) {}

//             if (pastProductIds.includes(productId)) {
//               const fStatus = pastOrder.financialStatus?.toUpperCase();
//               const fulfillment = pastOrder.fulfillmentStatus?.toUpperCase();
//               const isClean = !pastOrder.cancelledAt && !(pastOrder.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !pastOrder.hasDispute;

//               if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) successCount++;
//               else unpaidCount++;
//             }
//           });

//           if (unpaidCount > maxUnpaidSameProduct) maxUnpaidSameProduct = unpaidCount;
//           if (successCount > 0) hasSuccessfulSameProduct = true;
//         });

//         if (!hasSuccessfulSameProduct) {
//           if (maxUnpaidSameProduct >= 5) {
//             riskPercentage += shopSettings.hoardingHighPenalty; 
//             reasons.push({ description: `Targeted Hoarding: Ordered exact product ${maxUnpaidSameProduct} times without fulfilling.`, sentiment: "NEGATIVE" });
//           } else if (maxUnpaidSameProduct >= 3) {
//             riskPercentage += shopSettings.hoardingMedPenalty; 
//             reasons.push({ description: `Suspicious Repeat Item: Ordered exact product ${maxUnpaidSameProduct} times without fulfilling.`, sentiment: "NEGATIVE" });
//           }
//         }
//       }
    
//       // Volume Cancellations
//       if (cancelRate > 0) {
//         let cancelRiskCalc = Math.round(cancelRate * shopSettings.cancelWeight);
//         if (cancelledCount >= 10) cancelRiskCalc += 20; 
//         else if (cancelledCount >= 5) cancelRiskCalc += 10;
//         riskPercentage += cancelRiskCalc;
//         reasons.push({ description: `High Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // Disputes
//       if (disputeRate > 0) {
//         riskPercentage += Math.round(disputeRate * shopSettings.disputeWeight);
//         reasons.push({ description: `Customer has disputed ${disputedCount} out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // RTO Volume
//       if (rtoRate > 0) {
//         let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
//         if (rtoCount >= 5) rtoRiskCalc += 15;
//         riskPercentage += rtoRiskCalc;
//         reasons.push({ description: `High RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // Serial Abandoner
//       if (totalOrders >= 5 && successRate <= 0.20) {
//         let abandonRiskCalc = Math.round((1 - successRate) * shopSettings.abandonWeight);
//         if (totalOrders >= 20 && validOrderCount <= 1) abandonRiskCalc += 35;
//         else if (totalOrders >= 10 && validOrderCount === 0) abandonRiskCalc += 20;
//         riskPercentage += abandonRiskCalc;
//         reasons.push({ description: `Serial order abandoner: ${totalOrders} orders but only ${validOrderCount} successful purchases.`, sentiment: "NEGATIVE" });
//       }

//       // Zero Value Buyer
//       if (totalOrders >= 5 && totalSpend === 0) {
//         riskPercentage += shopSettings.zeroValuePenalty;
//         reasons.push({ description: `Suspicious buyer: ${totalOrders} orders with 0 total successful spend.`, sentiment: "NEGATIVE" });
//       }

//       // Refund Abuse
//       if (refundRate >= 0.5 && totalOrders >= 3) {
//         riskPercentage += Math.round(refundRate * shopSettings.refundWeight);
//         reasons.push({ description: `High refund rate: ${refundCount} out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // Pending Payments
//       if (isPendingPayment && !isCurrentCod && paymentType !== "Manual_Pending_Order") {
//         riskPercentage += shopSettings.pendingPaymentPenalty; 
//         reasons.push({ description: `Suspicious Payment: Pending digital gateway (${paymentType}). Do not fulfill.`, sentiment: "NEGATIVE" });
//       }

//       // COD Abuse
//       if (codRate >= 0.7 && rtoCount >= 1 && totalOrders >= 3) {
//         riskPercentage += Math.round(codRate * shopSettings.codAbuseWeight); 
//         reasons.push({ description: `COD abuse suspected: ${codCount} COD orders with RTO history.`, sentiment: "NEGATIVE" });
//       }
//     }

//     // Value Anomaly
//     const avgValidSpend = validOrderCount > 0 ? validTotalSpend / validOrderCount : 0;
//     if (orderValue > avgValidSpend * 5 && avgValidSpend > 0) {
//       riskPercentage += shopSettings.valueAnomalyPenalty;
//       reasons.push({ description: `Order value unusually high compared to successful history.`, sentiment: "NEGATIVE" });
//     }

//     // Loyalty Discount
//     if (validOrderCount >= 3) {
//       let loyaltyDiscount = Math.min(30, validOrderCount * shopSettings.loyaltyBonus); 
//       riskPercentage -= loyaltyDiscount;
//       reasons.push({ description: `Loyal repeat buyer: ${validOrderCount} paid & delivered orders.`, sentiment: "POSITIVE" });
//     }


//     // 8. FRAUD NETWORKS 

//     if (shippingAddress1 && shippingAddress1.trim().length > 5) {
//       const uniqueCustomersAtAddress = await prisma.shopify_store_order.groupBy({
//         by: ['customerEmail'],
//         where: { shop, shippingAddress1: shippingAddress1.trim(), customerEmail: { not: null } }
//       });
//       if (uniqueCustomersAtAddress.length >= 4) {
//         riskPercentage += shopSettings.addressFraudPenalty;
//         reasons.push({ description: `Fraud network suspected: ${uniqueCustomersAtAddress.length} buyers using exact same address.`, sentiment: "NEGATIVE" });
//       }
//     }

//     if (customerPhone && customerPhone.trim().length > 6) {
//       const uniqueCustomersWithPhone = await prisma.shopify_store_order.groupBy({
//         by: ['customerEmail'],
//         where: { shop, customerPhone: customerPhone.trim(), customerEmail: { not: null } }
//       });
//       if (uniqueCustomersWithPhone.length >= 4) {
//         riskPercentage += shopSettings.phoneFraudPenalty;
//         reasons.push({ description: `Fraud network suspected: phone number used by ${uniqueCustomersWithPhone.length} different customers.`, sentiment: "NEGATIVE" });
//       }
//     }


//     // 9. FINALIZE & ROUTE OUTBOUND DATA
//     const score = Math.max(0, Math.min(100, Math.round(riskPercentage)));
//     let riskLevel = score >= 70 ? "HIGH" : (score >= 40 ? "MEDIUM" : "LOW");

//     reasons.sort((a, b) => {
//       const sortOrder = { "NEGATIVE": 1, "NEUTRAL": 2, "POSITIVE": 3 };
//       return (sortOrder[a.sentiment] || 4) - (sortOrder[b.sentiment] || 4);
//     });

//     console.log(`\n=== RISK ASSESSMENT RESULT ===\nRisk Level: ${riskLevel} (Score: ${score}%)\nReasons:`, reasons, `\n==============================\n`);

//     // Finalize DB Caching for external API
//     if (isAddressValid !== null) {
//       try {
//         await prisma.shopify_store_order.update({
//           where: { id: storeOrderId },
//           data: { addressVerified: isAddressValid, addressFingerprint: currentFingerprint }
//         });
//       } catch (error) {
//         console.error("Failed to save final address validation status:", error);
//       }
//     }

//     // Dashboard & Risk Score Saving
//     await updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid);
    
//     await prisma.zippyy_risk_score.upsert({
//       where: { orderId: storeOrderId },
//       update: { score, riskLevel, reasons: reasons.map(r => r.description).join(" | ") },
//       create: { shop, orderId: storeOrderId, score, riskLevel, reasons: reasons.map(r => r.description).join(" | ") }
//     });
//     console.log(`✓ Saved Risk Score for order ${payload.id}`);

//     // Push out to Outbound Integrations Queue
//     const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));
//     await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);
//     console.log(`[INBOUND COMPLETE] Successfully routed ${riskLevel} risk score to Outbound Queue.`);

//     // SUCCESS - Tell Shopify to stop retrying
//     return new Response(null, { status: 200 });

//   } catch (error) {
//     //  return 500 so Shopify's webhook retry system kicks in if the database drops.
//     console.error(`[CRITICAL ERROR] Failed to process Risk Score for Order ${payload.id}:`, error);
//     return new Response("Internal Server Error", { status: 500 });
//   }
// }


















