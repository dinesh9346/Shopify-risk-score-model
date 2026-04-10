import prisma from "../db.server.js";
import { updateSingleBuyerProfile } from "./Sync.server.js";
import dns from 'dns/promises';
import { enqueueOutboundRisk, enqueueNotification } from "./queue.server.js";

// EXTERNAL API HELPER (OLA MAPS) 
async function checkAddressValidity(orderId, fullAddress) {
  if (!fullAddress || fullAddress.trim() === "") return null;

  try {
    const cleanAddress = fullAddress.replace(/,/g, ' ');
    const apiKey = process.env.ADDRESS_API_KEY;
    
    // Ola Maps requires the address to be URL-encoded and attached to the endpoint
    const encodedAddress = encodeURIComponent(cleanAddress);
    const url = `https://api.olamaps.io/places/v1/addressvalidation?address=${encodedAddress}&api_key=${apiKey}`;

    console.log(`[Address API] Sending GET request to Ola Maps for Order ${orderId}...`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Request-Id": orderId.toString()
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Address API] HTTP Error ${response.status} Details:`, errorText);
      return null; // Failsafe fallback
    }

    const responseData = await response.json();
    console.log(`[Address API] Response received for order ${orderId}:`, JSON.stringify(responseData, null, 2));

    // --- OLA MAPS LOGIC PARSER ---
    if (responseData && responseData.result) {
      // If Ola confirms it's a real address
      if (responseData.result.validated === true) {
        return true; 
      } 
      // If Ola confirms it is fake or mismatched
      else if (responseData.result.validated === false) {
        return false; 
      }
    }

    // If the API structure changes or crashes, return null so we don't unfairly penalize
    return null; 
  } catch (error) {
    console.error("[Address API] Failed to validate address with Ola Maps:", error);
    return null; 
  }
}

// EMAIL DOMAIN VALIDATION (DNS MX CHECK) 
async function checkEmailDomain(email) {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1];
  try {
    // Queries the global DNS system to see if the domain has a mail server
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch (error) {
    // Throws an error if the domain is completely fake or dead
    return false;
  }
}

// --- DEFAULT SETTINGS FALLBACK ---
const DEFAULT_WEIGHTS = {
  // --- 1. UI CONFIGURABLE WEIGHTS (Merchants can update these) ---
  invalidEmailPenalty: 40, guestCodPenalty: 15, shortNamePenalty: 30,
  missingEmailPenalty: 15, suspiciousTimingPenalty: 40, pendingPaymentPenalty: 20,
  invalidPostalCodePenalty: 80, missingAddressPenalty: 30, 
  missingHouseNoPenalty: 25, fakeAddressPenalty: 80,
  cancelWeight: 35, rtoWeight: 35, refundWeight: 25, 
  zeroValuePenalty: 25, codAbuseWeight: 20, valueAnomalyPenalty: 15,
  hoardingPenalty: 30, emailFraudPenalty: 35, phoneFraudPenalty: 30,
  disputeWeight: 50, openDisputePenalty: 40, fraudHistoryPenalty: 100,
  loyaltyBonus: 5,

  // --- 2. BACKEND-ONLY WEIGHTS (Hidden from UI, uses safe defaults) ---
  addressFraudPenalty: 35, 
  abandonWeight: 25, 
  nonExistentPinPenalty: 80,
  highCancelBonusPenalty: 20, 
  medCancelBonusPenalty: 10,
  highRtoBonusPenalty: 15,
  wonDisputePenalty: 15
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

    const customerName = [firstName, lastName].filter(Boolean).join(' ') || 'Customer';

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
    
    // 6. ADDRESS CACHE CHECK (Fingerprinting)
    let isAddressValid = null;
    let needsApiCheck = true;

    if (currentFingerprint.length > 5 && hasCustomerIdentifier) {
      const previousOrder = history.find(o => o.addressFingerprint === currentFingerprint && o.addressVerified !== null);
      if (previousOrder) {
        console.log(`[Address Check] CACHE HIT: Exact address matched past Order. Skipping API. (Result: ${previousOrder.addressVerified})`);
        isAddressValid = previousOrder.addressVerified;
        needsApiCheck = false; // We already know the answer, no need to ping Ola Maps!
      }
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

    // Suspicious Name Component & Length Check
    const cleanFirstName = (firstName || "").trim();
    const cleanLastName = (lastName || "").trim();
    const fullName = [cleanFirstName, cleanLastName].filter(Boolean).join(" ");

    // Rule 1: The total combined name must be longer than 3 characters
    const isCombinedValid = fullName.length > 3;

    // Rule 2: At least ONE of the parts (First OR Last) must have 3+ characters
    const hasValidComponent = cleanFirstName.length >= 3 || cleanLastName.length >= 3;

    // If it fails EITHER of these rules, apply the penalty
    if (!isCombinedValid || !hasValidComponent) {
      riskPercentage += shopSettings.shortNamePenalty; 
      reasons.push({ description: `Suspicious Name: Name is too short or lacks a valid 3-character first/last name.`, sentiment: "NEGATIVE" });
    }
    // email domain validation
    if (customerEmail) {
      const cleanEmail = customerEmail.trim().toLowerCase();
      
      // Level 1: Basic Regex Format Check
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(cleanEmail)) {
        riskPercentage += shopSettings.invalidEmailPenalty; // Unified key
        reasons.push({ description: `Identity Alert: Invalid email format provided (${cleanEmail}).`, sentiment: "NEGATIVE" });
        console.log(`[Email Check]  Invalid format caught: ${cleanEmail}`);
      } else {
        // Level 2: Deep DNS Domain Check
        const isDomainValid = await checkEmailDomain(cleanEmail);
        if (!isDomainValid) {
          riskPercentage += shopSettings.invalidEmailPenalty; // Unified key
          reasons.push({ description: `Identity Alert: Email domain does not exist or cannot receive mail (${cleanEmail}). Highly suspicious.`, sentiment: "NEGATIVE" });
          console.log(`[Email Check]  Fake or dead domain caught: ${cleanEmail}`);
        } else {
          console.log(`[Email Check]  Valid Mail Domain confirmed for: ${cleanEmail}`);
        }
      }
    } else {
      riskPercentage += shopSettings.missingEmailPenalty;
      reasons.push({ description: `Identity Alert: No email address provided.`, sentiment: "NEGATIVE" });
    }
    
    // Suspicious Timing (Night Time Penalty)
    const orderDate = new Date(payload.created_at || Date.now());
    const orderHour = orderDate.getHours(); 
    if (orderHour >= 2 && orderHour <= 5) { // Between 2:00 AM and 5:59 AM
      riskPercentage += shopSettings.suspiciousTimingPenalty; 
      reasons.push({ description: `Suspicious Timing: Order placed during late night hours (${orderHour}:00).`, sentiment: "NEGATIVE" });
    }
    
    // --- UNIFIED ADDRESS, HOUSE NUMBER & PINCODE EVALUATION ---
    const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
    const cleanZip = shippingZip ? shippingZip.replace(/[\s-]/g, "") : "";
    
    if (!shippingStreetLines) {
      riskPercentage += shopSettings.missingAddressPenalty;
      reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
    } else {
      
      let isPinValidLocally = true; 

      // STEP 1: FREE LOCAL CHECKS (Regex & Local Database)
      if (shippingCountry === "IN" || shippingCountry === "India") {
        if (!/^[1-9][0-9]{5}$/.test(cleanZip)) {
          isPinValidLocally = false;
          riskPercentage += shopSettings.invalidPostalCodePenalty; // Unified key
          reasons.push({ description: `Logistics API Alert: Invalid PIN Code format (${shippingZip}).`, sentiment: "NEGATIVE" });
          console.log(`[Pincode DB]  Invalid format: ${cleanZip}. Skipping deep address checks.`);
        } else {
          const validPin = await prisma.india_valid_pincodes.findUnique({ where: { postalCode: cleanZip } });
          if (!validPin) {
            isPinValidLocally = false;
            riskPercentage += shopSettings.nonExistentPinPenalty; // Hidden backend logic preserved
            reasons.push({ description: `Logistics Geo-Alert: The postal code (${shippingZip}) does not exist in India. Highly suspicious.`, sentiment: "NEGATIVE" });
            console.log(`[Pincode DB]  Fake PIN caught locally: ${cleanZip}. Skipping deep address checks.`);
          }
        }
      } else {
        // Generic fallback for non-Indian addresses
        if (!cleanZip || cleanZip.length < 4) {
          isPinValidLocally = false;
          riskPercentage += shopSettings.invalidPostalCodePenalty; // Unified key
          reasons.push({ description: `Logistics API Alert: Postal/ZIP Code is missing or incomplete.`, sentiment: "NEGATIVE" });
        } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
          isPinValidLocally = false;
          riskPercentage += shopSettings.invalidPostalCodePenalty; // Unified key
          reasons.push({ description: `Logistics API Alert: Fake Postal/ZIP Code sequence detected (${shippingZip}).`, sentiment: "NEGATIVE" });
        }
      }

      // STEP 2: DEEP CHECKS (Ola Maps API & House Number)
      if (isPinValidLocally) {
        
        // 2A. Ola Maps LIVE Validation (Only triggers if cache missed)
        if (needsApiCheck) {
          console.log(`[Address Check] LIVE API CALL: Triggering external API for Order ${payload.id}...`);
          const fullAddressString = [shippingAddress1, shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry].filter(Boolean).join(" ");
          
          isAddressValid = await checkAddressValidity(payload.id, fullAddressString);
          console.log(`[Address Check] LIVE API RESULT: Order ${payload.id} returned match -> ${isAddressValid}`);
        }

        // 2B. Evaluate the final address reality
        if (isAddressValid === false) {
          riskPercentage += shopSettings.fakeAddressPenalty; 
          reasons.push({ description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, sentiment: "NEGATIVE" });
        } else {
          // 2C. House Number Syntax Check
          const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
          if (!hasHouseNumber) {
            riskPercentage += shopSettings.missingHouseNoPenalty;
            reasons.push({ description: `Logistics API Alert: Verified real-world address, but missing a specific house/apartment number.`, sentiment: "NEGATIVE" });
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
        
        // NET REVENUE CALCULATION
        const orderValue = Number(o.orderValue || 0);
        let amountToSubtract = 0;

        const hasLostDispute = o.disputes?.some(d => 
          (d.status || "").toLowerCase() === "lost" || (d.status || "").toLowerCase() === "charge_refunded"
        );

        if (hasLostDispute || o.cancelledAt || fulfillment === "CANCELLED" || fStatus === "REFUNDED") {
          amountToSubtract = orderValue;
        } else if (fStatus === "PARTIALLY_REFUNDED") {
          amountToSubtract = 0; // Number(o.totalRefunded || 0);
        }

        totalSpend = (totalSpend + orderValue) - amountToSubtract;
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
        riskPercentage += shopSettings.wonDisputePenalty; 
        reasons.push({ description: `High Friction Buyer: Customer frequently files chargebacks, though the merchant usually wins.`, sentiment: "NEUTRAL" });
      }

      // Hoarding Assessment (Unified Key)
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
            riskPercentage += shopSettings.hoardingPenalty; 
            reasons.push({ description: `Targeted Hoarding: Ordered exact product ${maxUnpaidSameProduct} times without fulfilling.`, sentiment: "NEGATIVE" });
          } else if (maxUnpaidSameProduct >= 3) {
            // Scale the unified penalty down for a medium offense
            riskPercentage += Math.round(shopSettings.hoardingPenalty / 2); 
            reasons.push({ description: `Suspicious Repeat Item: Ordered exact product ${maxUnpaidSameProduct} times without fulfilling.`, sentiment: "NEGATIVE" });
          }
        }
      }
    
      // Volume Cancellations
      if (cancelRate > 0) {
        let cancelRiskCalc = Math.round(cancelRate * shopSettings.cancelWeight);
        if (cancelledCount >= 10) cancelRiskCalc += shopSettings.highCancelBonusPenalty; 
        else if (cancelledCount >= 5) cancelRiskCalc += shopSettings.medCancelBonusPenalty;
        riskPercentage += cancelRiskCalc;
        reasons.push({ description: `High Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // RTO Volume
      if (rtoRate > 0) {
        let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
        if (rtoCount >= 5) rtoRiskCalc += shopSettings.highRtoBonusPenalty;
        riskPercentage += rtoRiskCalc;
        reasons.push({ description: `High RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
      }

      // Serial Abandoner (Hidden backend logic preserved)
      if (totalOrders >= 5 && successRate <= 0.20) {
        let abandonRiskCalc = Math.round((1 - successRate) * shopSettings.abandonWeight);
        // Note: keeping the original extreme/high logic assuming those hidden keys still exist if you want them
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

    // 8. FRAUD NETWORKS (Updated logic)
    
    // A. Email Fraud Network (1 Email used across 3+ different Phone Numbers)
    if (customerEmail && customerEmail.trim().length > 5) {
      const uniquePhonesWithEmail = await prisma.shopify_store_order.groupBy({
        by: ['customerPhone'],
        where: { shop, customerEmail: customerEmail.trim(), customerPhone: { not: null } }
      });
      if (uniquePhonesWithEmail.length >= 3) {
        riskPercentage += shopSettings.emailFraudPenalty; 
        reasons.push({ description: `Identity Network: The email (${customerEmail}) is being used across ${uniquePhonesWithEmail.length} different phone numbers.`, sentiment: "NEGATIVE" });
      }
    }

    // B. Phone Fraud Network (1 Phone Number used across 3+ different Emails)
    if (customerPhone && customerPhone.trim().length > 6) {
      const uniqueEmailsWithPhone = await prisma.shopify_store_order.groupBy({
        by: ['customerEmail'],
        where: { shop, customerPhone: customerPhone.trim(), customerEmail: { not: null } }
      });
      if (uniqueEmailsWithPhone.length >= 3) {
        riskPercentage += shopSettings.phoneFraudPenalty; 
        reasons.push({ description: `Identity Network: The phone number is being shared across ${uniqueEmailsWithPhone.length} different email addresses.`, sentiment: "NEGATIVE" });
      }
    }
    
    // C. Hidden Address Fraud Logic (Preserved as requested)
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

    // Queue the Risk Push to Shopify
    const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));
    await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);
    console.log(`[INBOUND COMPLETE] Successfully routed ${riskLevel} risk score to Outbound Queue.`);

    // 10. TRIGGER OMNICHANNEL NOTIFICATIONS
    try {
        if (customerPhone || customerEmail) {
            await enqueueNotification(
                shop, 
                orderGid, 
                customerPhone, 
                customerEmail, 
                customerName, 
                riskLevel, 
                isCurrentCod,
                orderValue
            );
            console.log(`[Notification] Successfully queued for Order ${orderGid}`);
        } else {
            console.log(`[Notification] Skipped: No phone or email found.`);
        }
    } catch (notificationError) {
        console.error("[Notification Queue Error]:", notificationError);
    }

    // SUCCESS - Return 200 to Shopify
    return new Response(null, { status: 200 });
    
  } catch (error) {
    // Return 500 so Shopify's webhook retry system kicks in if the database drops.
    console.error(`[CRITICAL ERROR] Failed to process Risk Score for Order ${payload.id}:`, error);
    return new Response("Internal Server Error", { status: 500 });
  }
}


// import prisma from "../db.server.js";
// import { updateSingleBuyerProfile } from "./Sync.server.js";
// import dns from 'dns/promises';
// import { enqueueOutboundRisk, enqueueNotification } from "./queue.server.js";
// // EXTERNAL API HELPER (OLA MAPS) 
// async function checkAddressValidity(orderId, fullAddress) {
//   if (!fullAddress || fullAddress.trim() === "") return null;

//   try {
//     const cleanAddress = fullAddress.replace(/,/g, ' ');
//     const apiKey = process.env.ADDRESS_API_KEY;
    
//     // Ola Maps requires the address to be URL-encoded and attached to the endpoint
//     const encodedAddress = encodeURIComponent(cleanAddress);
//     const url = `https://api.olamaps.io/places/v1/addressvalidation?address=${encodedAddress}&api_key=${apiKey}`;

//     console.log(`[Address API] Sending GET request to Ola Maps for Order ${orderId}...`);

//     const response = await fetch(url, {
//       method: "GET",
//       headers: {
//         "X-Request-Id": orderId.toString()
//       }
//     });

//     if (!response.ok) {
//       const errorText = await response.text();
//       console.error(`[Address API] HTTP Error ${response.status} Details:`, errorText);
//       return null; // Failsafe fallback
//     }

//     const responseData = await response.json();
//     console.log(`[Address API] Response received for order ${orderId}:`, JSON.stringify(responseData, null, 2));

//     // --- OLA MAPS LOGIC PARSER ---
//     if (responseData && responseData.result) {
//       // If Ola confirms it's a real address
//       if (responseData.result.validated === true) {
//         return true; 
//       } 
//       // If Ola confirms it is fake or mismatched
//       else if (responseData.result.validated === false) {
//         return false; 
//       }
//     }

//     // If the API structure changes or crashes, return null so we don't unfairly penalize
//     return null; 
//   } catch (error) {
//     console.error("[Address API] Failed to validate address with Ola Maps:", error);
//     return null; 
//   }
// }
// // EMAIL DOMAIN VALIDATION (DNS MX CHECK) 
// async function checkEmailDomain(email) {
//   if (!email || !email.includes('@')) return false;
//   const domain = email.split('@')[1];
//   try {
//     // Queries the global DNS system to see if the domain has a mail server
//     const records = await dns.resolveMx(domain);
//     return records && records.length > 0;
//   } catch (error) {
//     // Throws an error if the domain is completely fake or dead
//     return false;
//   }
// }
// // --- DEFAULT SETTINGS FALLBACK ---
// const DEFAULT_WEIGHTS = {
//   guestCodPenalty: 15, shortNamePenalty: 30, missingAddressPenalty: 30,
//   missingHouseNoPenalty: 25, cancelWeight: 35, disputeWeight: 50,
//   rtoWeight: 35, abandonWeight: 25, zeroValuePenalty: 25,
//   refundWeight: 25, pendingPaymentPenalty: 20, codAbuseWeight: 20,
//   valueAnomalyPenalty: 15, loyaltyBonus: 5, addressFraudPenalty: 35,
//   phoneFraudPenalty: 30, hoardingHighPenalty: 30, hoardingMedPenalty: 15,
//   fraudHistoryPenalty: 100, openDisputePenalty: 40,
//   invalidEmailFormatPenalty: 30, invalidEmailDomainPenalty: 40,
//   missingEmailPenalty: 15, suspiciousTimingPenalty: 40,
//   invalidPinFormatPenalty: 80, nonExistentPinPenalty: 80,
//   incompletePostalCodePenalty: 80, fakePostalCodePenalty: 80,
//   fakeAddressPenalty: 80, wonDisputePenalty: 15,
//   highCancelBonusPenalty: 20, medCancelBonusPenalty: 10,
//   highRtoBonusPenalty: 15, extremeAbandonPenalty: 35,
//   highAbandonPenalty: 20
// };

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

//     const customerName = [firstName, lastName].filter(Boolean).join(' ') || 'Customer';

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

//     // 4. SYNC ORDER LOCALLY (UPSERT)
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
    
//     const [fetchedSettings, pastOrders] = await Promise.all([
//       prisma.zippyy_risk_settings.findUnique({ where: { shop } }),
//       hasCustomerIdentifier ? prisma.shopify_store_order.findMany({ 
//         where: historyWhere,
//         include: { disputes: true } // Pull detailed chargeback history
//       }) : Promise.resolve([])
//     ]);
    
//     let shopSettings = { ...DEFAULT_WEIGHTS, ...(fetchedSettings || {}) };
//     const history = pastOrders || [];
//     console.log(`[Risk Settings] Weights loaded for ${shop}`);
    
//     // 6. ADDRESS CACHE CHECK (Fingerprinting)
//     let isAddressValid = null;
//     let needsApiCheck = true;

//     if (currentFingerprint.length > 5 && hasCustomerIdentifier) {
//       const previousOrder = history.find(o => o.addressFingerprint === currentFingerprint && o.addressVerified !== null);
//       if (previousOrder) {
//         console.log(`[Address Check] CACHE HIT: Exact address matched past Order. Skipping API. (Result: ${previousOrder.addressVerified})`);
//         isAddressValid = previousOrder.addressVerified;
//         needsApiCheck = false; // We already know the answer, no need to ping Ola Maps!
//       }
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
//      // email domain validation
//     if (customerEmail) {
//       const cleanEmail = customerEmail.trim().toLowerCase();
      
//       // Level 1: Basic Regex Format Check
//       const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
//       if (!emailRegex.test(cleanEmail)) {
//         riskPercentage += shopSettings.invalidEmailFormatPenalty;
//         reasons.push({ description: `Identity Alert: Invalid email format provided (${cleanEmail}).`, sentiment: "NEGATIVE" });
//         console.log(`[Email Check]  Invalid format caught: ${cleanEmail}`);
//       } else {
//         // Level 2: Deep DNS Domain Check
//         const isDomainValid = await checkEmailDomain(cleanEmail);
//         if (!isDomainValid) {
//           riskPercentage += shopSettings.invalidEmailDomainPenalty;
//           reasons.push({ description: `Identity Alert: Email domain does not exist or cannot receive mail (${cleanEmail}). Highly suspicious.`, sentiment: "NEGATIVE" });
//           console.log(`[Email Check]  Fake or dead domain caught: ${cleanEmail}`);
//         } else {
//           console.log(`[Email Check]  Valid Mail Domain confirmed for: ${cleanEmail}`);
//         }
//       }
//     } else {
//       riskPercentage += shopSettings.missingEmailPenalty;
//       reasons.push({ description: `Identity Alert: No email address provided.`, sentiment: "NEGATIVE" });
//     }
//     // Suspicious Timing (Night Time Penalty)
//     const orderDate = new Date(payload.created_at || Date.now());
//     const orderHour = orderDate.getHours(); 
//     if (orderHour >= 2 && orderHour <= 5) { // Between 2:00 AM and 5:59 AM
//       riskPercentage += shopSettings.suspiciousTimingPenalty; 
//       reasons.push({ description: `Suspicious Timing: Order placed during late night hours (${orderHour}:00).`, sentiment: "NEGATIVE" });
//     }
//    // --- UNIFIED ADDRESS, HOUSE NUMBER & PINCODE EVALUATION ---
//     const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
//     const cleanZip = shippingZip ? shippingZip.replace(/[\s-]/g, "") : "";
    
//     if (!shippingStreetLines) {
//       riskPercentage += shopSettings.missingAddressPenalty;
//       reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
//     } else {
      
//       let isPinValidLocally = true; 

   
//       // STEP 1: FREE LOCAL CHECKS (Regex & Local Database)

//       if (shippingCountry === "IN" || shippingCountry === "India") {
//         if (!/^[1-9][0-9]{5}$/.test(cleanZip)) {
//           isPinValidLocally = false;
//           riskPercentage += shopSettings.invalidPinFormatPenalty; 
//           reasons.push({ description: `Logistics API Alert: Invalid  PIN Code format (${shippingZip}).`, sentiment: "NEGATIVE" });
//           console.log(`[Pincode DB]  Invalid format: ${cleanZip}. Skipping deep address checks.`);
//         } else {
//           const validPin = await prisma.india_valid_pincodes.findUnique({ where: { postalCode: cleanZip } });
//           if (!validPin) {
//             isPinValidLocally = false;
//             riskPercentage += shopSettings.nonExistentPinPenalty; 
//             reasons.push({ description: `Logistics Geo-Alert: The postal code (${shippingZip}) does not exist in India. Highly suspicious.`, sentiment: "NEGATIVE" });
//             console.log(`[Pincode DB]  Fake PIN caught locally: ${cleanZip}. Skipping deep address checks.`);
//           }
//         }
//       } else {
//         // Generic fallback for non-Indian addresses
//         if (!cleanZip || cleanZip.length < 4) {
//           isPinValidLocally = false;
//           riskPercentage += shopSettings.incompletePostalCodePenalty; 
//           reasons.push({ description: `Logistics API Alert: Postal/ZIP Code is missing or incomplete.`, sentiment: "NEGATIVE" });
//         } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
//           isPinValidLocally = false;
//           riskPercentage += shopSettings.fakePostalCodePenalty; 
//           reasons.push({ description: `Logistics API Alert: Fake Postal/ZIP Code sequence detected (${shippingZip}).`, sentiment: "NEGATIVE" });
//         }
//       }

//      // STEP 2: DEEP CHECKS (Ola Maps API & House Number)
//       // Only runs if the Pincode actually exists!
//       if (isPinValidLocally) {
        
//         // 2A. Ola Maps LIVE Validation (Only triggers if cache missed)
//         if (needsApiCheck) {
//           console.log(`[Address Check] LIVE API CALL: Triggering external API for Order ${payload.id}...`);
//           const fullAddressString = [shippingAddress1, shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry].filter(Boolean).join(" ");
          
//           isAddressValid = await checkAddressValidity(payload.id, fullAddressString);
//           console.log(`[Address Check] LIVE API RESULT: Order ${payload.id} returned match -> ${isAddressValid}`);
//         }

//         // 2B. Evaluate the final address reality
//         if (isAddressValid === false) {
//           // If the street is completely fake, drop the hammer and skip house number checks
//           riskPercentage += shopSettings.fakeAddressPenalty; 
//           reasons.push({ description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, sentiment: "NEGATIVE" });
//         } else {
//           // 2C. House Number Syntax Check (Only runs if the address is ACTUALLY real/verified)
//           // We only check for a house number if Ola Maps (or the cache) said the street exists!
//           const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
//           if (!hasHouseNumber) {
//             riskPercentage += shopSettings.missingHouseNoPenalty;
//             reasons.push({ description: `Logistics API Alert: Verified real-world address, but missing a specific house/apartment number.`, sentiment: "NEGATIVE" });
//           }
//         }
//       }
//     }
//     // Historical Behavior & Amplifiers
//     let totalSpend = 0, cancelledCount = 0;
//     let rtoCount = 0, refundCount = 0, codCount = 0, validOrderCount = 0, validTotalSpend = 0;
    
//     // Dispute Counters
//     let hasFraudHistory = false;
//     let openDisputes = 0;
//     let wonDisputes = 0;
//     let lostDisputes = 0;

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
//         if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

//         if (o.cancelledAt || fulfillment === "CANCELLED") cancelledCount++;
//         else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") rtoCount++;

//         // Deep Dispute Analysis
//         if (o.disputes && o.disputes.length > 0) {
//           o.disputes.forEach(d => {
//             const reason = (d.reason || "").toLowerCase();
//             const status = (d.status || "").toLowerCase();

//             if (reason === "fraudulent") hasFraudHistory = true;

//             if (["needs_response", "under_review"].includes(status)) {
//               openDisputes++;
//             } else if (status === "won") {
//               wonDisputes++;
//             } else if (["lost", "charge_refunded"].includes(status)) {
//               lostDisputes++;
//             }
//           });
//         } else if (o.hasDispute) {
//           lostDisputes++; 
//         }

//         const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
//         if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
//           validOrderCount++;
//           validTotalSpend += Number(o.orderValue || 0);
//         }
        
//         // NET REVENUE CALCULATION: Add all orders initially, then subtract losses
//         const orderValue = Number(o.orderValue || 0);
//         let amountToSubtract = 0;

//         // 1. Check for total loss conditions first (Dispute Lost, Cancelled, Fully Refunded)
//         const hasLostDispute = o.disputes?.some(d => 
//           (d.status || "").toLowerCase() === "lost" || (d.status || "").toLowerCase() === "charge_refunded"
//         );

//         if (hasLostDispute || o.cancelledAt || fulfillment === "CANCELLED" || fStatus === "REFUNDED") {
//           amountToSubtract = orderValue; // Subtract the whole thing
//         } 
//         // 2. Handle Partial Refunds accurately (when we have the exact amount)
//         else if (fStatus === "PARTIALLY_REFUNDED") {
//           // Note: Ensure your data parser is pulling 'totalRefunded' from Shopify
//           // For now, don't subtract anything to avoid over-penalizing legitimate partial refunds
//           amountToSubtract = 0; // Will be: Number(o.totalRefunded || 0);
//         }

//         // Apply the math once
//         totalSpend = (totalSpend + orderValue) - amountToSubtract;
//       });

//       let cancelRate = cancelledCount / totalOrders;
//       let rtoRate = rtoCount / totalOrders;
//       let refundRate = refundCount / totalOrders;
//       let codRate = codCount / totalOrders;
//       const successRate = validOrderCount / totalOrders;
      
//       // THE DISPUTE DEFENSE GATES
//       if (hasFraudHistory) {
//         riskPercentage += shopSettings.fraudHistoryPenalty || 100; 
//         reasons.push({ description: `CRITICAL ALERT: Buyer has a known history of 'Fraudulent' chargebacks on this store.`, sentiment: "NEGATIVE" });
//       }

//       if (openDisputes > 0) {
//         riskPercentage += shopSettings.openDisputePenalty || 40;
//         reasons.push({ description: `Active Risk: Customer is attempting a new purchase while having ${openDisputes} unresolved dispute(s) pending.`, sentiment: "NEGATIVE" });
//       }

//       if (lostDisputes > 0) {
//         let disputeRate = lostDisputes / totalOrders;
//         riskPercentage += Math.round(disputeRate * shopSettings.disputeWeight);
//         reasons.push({ description: `Financial Loss: Buyer has ${lostDisputes} lost chargeback(s) on record.`, sentiment: "NEGATIVE" });
//       }

//       if (wonDisputes > 0 && lostDisputes === 0) {
//         riskPercentage += shopSettings.wonDisputePenalty; 
//         reasons.push({ description: `High Friction Buyer: Customer frequently files chargebacks, though the merchant usually wins.`, sentiment: "NEUTRAL" });
//       }

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
//         if (cancelledCount >= 10) cancelRiskCalc += shopSettings.highCancelBonusPenalty; 
//         else if (cancelledCount >= 5) cancelRiskCalc += shopSettings.medCancelBonusPenalty;
//         riskPercentage += cancelRiskCalc;
//         reasons.push({ description: `High Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // RTO Volume
//       if (rtoRate > 0) {
//         let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
//         if (rtoCount >= 5) rtoRiskCalc += shopSettings.highRtoBonusPenalty;
//         riskPercentage += rtoRiskCalc;
//         reasons.push({ description: `High RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // Serial Abandoner
//       if (totalOrders >= 5 && successRate <= 0.20) {
//         let abandonRiskCalc = Math.round((1 - successRate) * shopSettings.abandonWeight);
//         if (totalOrders >= 20 && validOrderCount <= 1) abandonRiskCalc += shopSettings.extremeAbandonPenalty;
//         else if (totalOrders >= 10 && validOrderCount === 0) abandonRiskCalc += shopSettings.highAbandonPenalty;
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

   
//     // 9. FINALIZE & ROUTE OUTBOUND DATA
//     const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));
    
//     // Queue the Risk Push to Shopify
//     await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);
//     console.log(`[INBOUND COMPLETE] Successfully routed ${riskLevel} risk score to Outbound Queue.`);

//     // 10. TRIGGER OMNICHANNEL NOTIFICATIONS

//     try {
//         if (customerPhone || customerEmail) {
//             await enqueueNotification(
//                 shop, 
//                 orderGid, 
//                 customerPhone, 
//                 customerEmail, 
//                 customerName, 
//                 riskLevel, 
//                 isCurrentCod,
//                 orderValue
//             );
//             console.log(`[Notification] Successfully queued for Order ${orderGid}`);
//         } else {
//             console.log(`[Notification] Skipped: No phone or email found.`);
//         }
//     } catch (notificationError) {
//         console.error("[Notification Queue Error]:", notificationError);
//     }

//     // SUCCESS - Return 200 to Shopify
//     return new Response(null, { status: 200 });
    
//   } catch (error) {
//     // Return 500 so Shopify's webhook retry system kicks in if the database drops.
//     console.error(`[CRITICAL ERROR] Failed to process Risk Score for Order ${payload.id}:`, error);
//     return new Response("Internal Server Error", { status: 500 });
//   }
// }














