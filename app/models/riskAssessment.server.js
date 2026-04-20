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
      return null; 
    }

    const responseData = await response.json();
    console.log(`[Address API] Response received for order ${orderId}:`, JSON.stringify(responseData, null, 2));

    // --- OLA MAPS LOGIC PARSER ---
    if (responseData && responseData.result) {
      if (responseData.result.validated === true) return true; 
      else if (responseData.result.validated === false) return false; 
    }

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
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch (error) {
    return false;
  }
}

// --- 1. MERCHANT CONFIGURABLE DEFAULTS (Fetched from DB) ---
const DEFAULT_WEIGHTS = {
  riskMode: "MANUAL", thresholdMedium: 40, thresholdHigh: 70,
  invalidEmailPenalty: 40, guestCodPenalty: 15, shortNamePenalty: 30,
  missingEmailPenalty: 15, suspiciousTimingPenalty: 40, pendingPaymentPenalty: 20,
  invalidPostalCodePenalty: 80, missingAddressPenalty: 30, 
  missingHouseNoPenalty: 25, fakeAddressPenalty: 80,
  cancelWeight: 35, rtoWeight: 35, refundWeight: 25, 
  zeroValuePenalty: 25, codAbuseWeight: 20, valueAnomalyPenalty: 15,
  hoardingPenalty: 30, emailFraudPenalty: 35, phoneFraudPenalty: 30,
  disputeWeight: 50, openDisputePenalty: 40, fraudHistoryPenalty: 100,
  loyaltyBonus: 5
};

// --- 2. FIXED SYSTEM CONSTANTS ---
const SYSTEM_CONSTANTS = {
  addressFraudPenalty: 35, 
  abandonWeight: 25, 
  extremeAbandonPenalty: 35,
  highAbandonPenalty: 20,
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
    // 2. STRICT DB IDEMPOTENCY
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

    // ADDED THESE BACK IN:
    const firstName = customer?.first_name || payload.shipping_address?.first_name || payload.billing_address?.first_name || null;
    const lastName = customer?.last_name || payload.shipping_address?.last_name || payload.billing_address?.last_name || null;
    const orderValue = parseFloat(payload.total_price || "0");

    const customerName = [firstName, lastName].filter(Boolean).join(' ') || 'Customer';

    let paymentType = payload.payment_gateway_names?.join(", ") || "UNKNOWN";
    if (!paymentType || paymentType.trim() === "") paymentType = "UNKNOWN";

    const isDraftOrder = payload.source_name === "shopify_draft_order" || payload.source_name === "2932204";
    const isPendingPayment = payload.financial_status === "pending";
    
    const orderTags = (payload.tags || "").toLowerCase();
    const orderNote = (payload.note || "").toLowerCase();

    // NEW: Explicitly track if this is a "Payment due later" draft order
    let isAdminDraftPending = false;

    if (isDraftOrder && isPendingPayment) {
      const hasCodClue = orderTags.includes("cod") || orderTags.includes("cash") || orderNote.includes("cod") || orderNote.includes("cash");
      if (hasCodClue) {
        paymentType = "Admin_Draft_COD"; 
      } else if (paymentType === "UNKNOWN") {
        paymentType = "Manual_Pending_Order"; 
        isAdminDraftPending = true; 
      }
    }

    const currentProductIds = payload.line_items?.map(item => item.product_id).filter(Boolean) || [];
    const currentFingerprint = [shippingAddress1, shippingZip, shippingCountry]
      .filter(Boolean).join("").toLowerCase().replace(/[\s,]/g, "");

    // 4. SYNC ORDER LOCALLY (UPSERT)
    const orderRecord = await prisma.shopify_store_order.upsert({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId: orderGid } },
      update: {
        financialStatus: payload.financial_status, fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        paymentGateway: paymentType, customerPhone, shippingAddress1, shippingAddress2,
        shippingCity, shippingProvince, shippingZip, shippingCountry,
        firstName, lastName, lineItemsData: JSON.stringify(currentProductIds)
      },
      create: {
        shop, shopifyOrderId: orderGid, customerId, firstName, lastName, customerEmail,
        orderValue, paymentGateway: paymentType, customerPhone, shippingAddress1,
        shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry,
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : null,
        lineItemsData: JSON.stringify(currentProductIds)
      }
    });

    const storeOrderId = orderRecord.id;

    // 5. FETCH MERCHANT SETTINGS, CUSTOMER HISTORY & ZIPCODE HISTORY
    let historyWhere = { shop, shopifyOrderId: { not: orderGid } }; 
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
    
    const cleanZip = shippingZip ? shippingZip.replace(/[\s-]/g, "") : "";

    const [fetchedSettings, pastOrders, zipHistory] = await Promise.all([
      prisma.zippyy_risk_settings.findUnique({ where: { shop } }),
      hasCustomerIdentifier ? prisma.shopify_store_order.findMany({ 
        where: historyWhere,
        include: { disputes: true }
      }) : Promise.resolve([]),
      cleanZip ? prisma.shopify_store_order.findMany({ 
        where: { shop, shippingZip: cleanZip, shopifyOrderId: { not: orderGid } } 
      }) : Promise.resolve([])
    ]);
    
    let shopSettings = { ...DEFAULT_WEIGHTS, ...(fetchedSettings || {}) };
    const history = pastOrders || [];
    const totalOrders = history.length;
    
    // 6. ADDRESS CACHE CHECK & LIVE VALIDATIONS
    let isAddressValid = null;
    let needsApiCheck = true;

    if (currentFingerprint.length > 5 && hasCustomerIdentifier) {
      const previousOrder = history.find(o => o.addressFingerprint === currentFingerprint && o.addressVerified !== null);
      if (previousOrder) {
        isAddressValid = previousOrder.addressVerified;
        needsApiCheck = false; 
      }
    }
    
    // Live Address Check
    if (needsApiCheck && cleanZip) {
      const fullStr = [shippingAddress1, shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry].filter(Boolean).join(" ");
      const check = await checkAddressValidity(payload.id, fullStr);
      if (check !== null) isAddressValid = check;
    }
    
    // Live Email Check
    let isEmailDomainValid = 1;
    if (customerEmail) {
      const isDomainValid = await checkEmailDomain(customerEmail.trim().toLowerCase());
      if (!isDomainValid) isEmailDomainValid = 0;
    }

    // =========================================================
    // 7. SHARED HISTORICAL CALCULATIONS (Used by both modes)
    // =========================================================
    let cancelledCount = 0, rtoCount = 0, refundCount = 0, codCount = 0, validOrderCount = 0, totalSpend = 0;
    let hasFraudHistory = false, openDisputes = 0, wonDisputes = 0, lostDisputes = 0;
    let firstOrderDate = new Date();

    if (totalOrders > 0) {
      history.forEach(o => {
        const fStatus = (o.financialStatus || "").toUpperCase();
        const fulfillment = (o.fulfillmentStatus || "").toUpperCase();
        const shipment = (o.shipmentStatus || "").toUpperCase();
        const pastGatewayStr = (o.paymentGateway || "").toLowerCase();
        const isCod = pastGatewayStr.includes("cod") || pastGatewayStr.includes("cash");

        if (isCod) codCount++;
        if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

        if (o.cancelledAt || fulfillment === "CANCELLED") cancelledCount++;
        else if (
          o.isRTO || 
          fulfillment === "RETURNED" || 
          fulfillment === "RESTOCKED" || 
          fStatus === "REFUNDED" || 
          shipment === "RTO" || 
          shipment === "RETURN_TO_ORIGIN" || 
          shipment === "RETURNED" || 
          shipment === "FAILURE" || 
          shipment === "FAILED" || 
          shipment === "UNDELIVERED" || 
          shipment === "DELIVERY_FAILED" ||
          shipment === "LOST" ||
          shipment === "EXCEPTION"
        ) rtoCount++;

        if (o.disputes && o.disputes.length > 0) {
          o.disputes.forEach(d => {
            const reason = (d.reason || "").toLowerCase();
            const status = (d.status || "").toLowerCase();
            if (reason === "fraudulent") hasFraudHistory = true;
            if (["needs_response", "under_review"].includes(status)) openDisputes++;
            else if (status === "won") wonDisputes++;
            else if (["lost", "charge_refunded"].includes(status)) lostDisputes++;
          });
        } else if (o.hasDispute) {
          lostDisputes++; 
        }

        const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
        if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
          validOrderCount++;
          totalSpend += Number(o.orderValue || 0);
        }
        
        if (new Date(o.createdAt) < firstOrderDate) firstOrderDate = new Date(o.createdAt);
      });
    }

    // Shared Hoarding Check
    let maxUnpaidSameProduct = 0;
    let hasSuccessfulSameProduct = false;
    
    if (currentProductIds.length > 0) {
      currentProductIds.forEach(productId => {
        let unpaidCount = 0, successCount = 0;
        history.forEach(pastOrder => {
          let pastProductIds = [];
          try { pastProductIds = pastOrder.lineItemsData ? JSON.parse(pastOrder.lineItemsData) : []; } catch (e) {}

          if (pastProductIds.includes(productId)) {
            const fStatus = (pastOrder.financialStatus || "").toUpperCase();
            const fulfillment = (pastOrder.fulfillmentStatus || "").toUpperCase();
            const isClean = !pastOrder.cancelledAt && !(pastOrder.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !pastOrder.hasDispute;

            if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) successCount++;
            else unpaidCount++;
          }
        });

        if (unpaidCount > maxUnpaidSameProduct) maxUnpaidSameProduct = unpaidCount;
        if (successCount > 0) hasSuccessfulSameProduct = true;
      });
    }

    // Rates
    let cancelRate = totalOrders > 0 ? (cancelledCount / totalOrders) : 0;
    let rtoRate = totalOrders > 0 ? (rtoCount / totalOrders) : 0;
    let refundRate = totalOrders > 0 ? (refundCount / totalOrders) : 0;
    let codRate = totalOrders > 0 ? (codCount / totalOrders) : 0;
    const successRate = totalOrders > 0 ? (validOrderCount / totalOrders) : 0;

   // Globals for engine
    let riskPercentage = 0;
    let reasons = [];
    
    // Improved robust gateway string matching
    const currentGatewayStr = paymentType.toLowerCase();
    const isCurrentCod = currentGatewayStr.includes("cod") || 
                         currentGatewayStr.includes("cash") || 
                         currentGatewayStr.includes("pay on delivery") || 
                         currentGatewayStr.includes("ondelivery");

    // NEW: Calculate the exact order type for the ML model
    let OrderType = "PREPAID"; 
    if (isCurrentCod) {
      OrderType = "COD";
    } else if (isAdminDraftPending) {
      OrderType = "COD"; 
    }

    // =========================================================
    // MODE 1: AUTO (MACHINE LEARNING API CALL)
    // =========================================================
    if (shopSettings.riskMode === "AUTO") {
      console.log(`[Risk Engine] AUTO Mode active for ${shop}. Generating ML Payload...`);

      // Time Calculations for ML
      const daysSinceFirstOrder = Math.max(1, Math.floor((new Date() - firstOrderDate) / (1000 * 60 * 60 * 24)));
      const customer_order_frequency = totalOrders > 0 ? (totalOrders / daysSinceFirstOrder) : 0;

      // Zipcode Calculations for ML
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let zip_rtos = 0;
      let zip_monthly_orders = 0;
      let zip_monthly_rtos = 0;

      history.forEach(o => {
        const fStatus = (o.financialStatus || "").toUpperCase();
        const fulfillment = (o.fulfillmentStatus || "").toUpperCase();
        const shipment = (o.shipmentStatus || "").toUpperCase(); // <-- NEW: Grab shipment status
        const pastGatewayStr = (o.paymentGateway || "").toLowerCase();
        const isCod = pastGatewayStr.includes("cod") || pastGatewayStr.includes("cash");

        if (isCod) codCount++;
        if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

        // Add shipment status to the RTO/Cancellation checks!
        if (o.cancelledAt || fulfillment === "CANCELLED") {
            cancelledCount++;
        } else if (
            o.isRTO || 
            fulfillment === "RETURNED" || 
            fulfillment === "RESTOCKED" || 
            fStatus === "REFUNDED" || 
            shipment === "RTO" || 
            shipment === "RETURN_TO_ORIGIN" || 
            shipment === "RETURNED" || 
            shipment === "FAILURE" || 
            shipment === "FAILED" || 
            shipment === "UNDELIVERED" || 
            shipment === "DELIVERY_FAILED" ||
            shipment === "LOST" ||
            shipment === "EXCEPTION"
        ) {
            rtoCount++;
        }

        if (o.disputes && o.disputes.length > 0) {
          o.disputes.forEach(d => {
            const reason = (d.reason || "").toLowerCase();
            const status = (d.status || "").toLowerCase();
            if (reason === "fraudulent") hasFraudHistory = true;
            if (["needs_response", "under_review"].includes(status)) openDisputes++;
            else if (status === "won") wonDisputes++;
            else if (["lost", "charge_refunded"].includes(status)) lostDisputes++;
          });
        } else if (o.hasDispute) {
          lostDisputes++; 
        }

        const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
        if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
          validOrderCount++;
          totalSpend += Number(o.orderValue || 0);
        }
        
        if (new Date(o.createdAt) < firstOrderDate) firstOrderDate = new Date(o.createdAt);
      });

      const zipcode_order_volume = zipHistory.length;
      const zipcode_return_rate = zipcode_order_volume > 0 ? (zip_rtos / zipcode_order_volume) : 0;
      const zipcode_monthly_return_rate = zip_monthly_orders > 0 ? (zip_monthly_rtos / zip_monthly_orders) : 0;

      // Seasonality
      const orderDate = new Date(payload.created_at || Date.now());
      const month = orderDate.getMonth() + 1; 
      const hour = orderDate.getHours();
      const day = orderDate.getDay(); 

      const is_weekend = (day === 0 || day === 6) ? 1 : 0;
      const is_night = (hour >= 22 || hour < 6) ? 1 : 0;
      const is_holiday_season = (month === 11 || month === 12) ? 1 : 0;
      const is_rainy_season = (month >= 6 && month <= 9) ? 1 : 0;

      let order_value_bin = "LOW";
      if (orderValue >= 5000) order_value_bin = "HIGH";
      else if (orderValue >= 1500) order_value_bin = "MEDIUM";

      const cleanFirstName = (firstName || "").trim();
      const cleanLastName = (lastName || "").trim();
      const fullName = [cleanFirstName, cleanLastName].filter(Boolean).join(" ");
      const isCombinedValid = fullName.length > 3;
      const hasValidComponent = cleanFirstName.length >= 3 || cleanLastName.length >= 3;
      const is_name_valid = (isCombinedValid && hasValidComponent) ? 1 : 0;

      // Build ML Payload
      const mlPayload = {
        customer_zipcode: cleanZip,
        order_type:OrderType,
        order_value_bin: order_value_bin,
        email_domain: customerEmail ? customerEmail.split('@')[1].toLowerCase() : "unknown",
        order_month: month,
        is_weekend: is_weekend,
        is_night: is_night,
        is_holiday_season: is_holiday_season,
        is_rainy_season: is_rainy_season,
        customer_return_rate: rtoRate,
        customer_order_frequency: customer_order_frequency,
        is_new_customer: totalOrders === 0 ? 1 : 0,
        zipcode_order_volume: zipcode_order_volume,
        zipcode_return_rate: zipcode_return_rate,
        zipcode_monthly_return_rate: zipcode_monthly_return_rate,
        is_address_valid: isAddressValid === false ? 0 : 1,
        is_email_domain_valid: isEmailDomainValid,
        customer_cancel_rate: cancelRate,
        customer_success_rate: successRate,
        hoarding_count: maxUnpaidSameProduct,
        is_name_valid: is_name_valid
      };

      console.log("\n================ ML PAYLOAD OUTBOUND ================");
      console.log(JSON.stringify(mlPayload, null, 2));
      console.log("=====================================================\n");

      try {
        const pythonServerUrl = process.env.ML_SERVER_URL || 'http://localhost:8000/predict';
        const mlResponse = await fetch(pythonServerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mlPayload)
        });

        if (!mlResponse.ok) throw new Error("ML Server returned an error.");
        
        const mlData = await mlResponse.json();

// 1. Get the risk percentage (Handling both possible variable names from Python)
       riskPercentage = (mlData.risk_score || mlData.rto_probability) * 100;

  // 2. Check if Python sent dynamic reasons
       if (mlData.reasons && mlData.reasons.length > 0) {
    // Loop through the reasons from Python and push them to Shopify
         mlData.reasons.forEach((reason) => {
          reasons.push({ 
              description: reason.description || reason, // Handles both dict or string formats
              sentiment: reason.sentiment || "NEGATIVE" 
           });
       });
    }     else {
    // 3. Fallback ONLY if Python's reasons list is somehow empty
          reasons.push({ 
             description: `AI Prediction: Algorithm detected an unusual combination of order behavior.`, 
              sentiment: riskPercentage >= shopSettings.thresholdMedium ? "NEGATIVE" : "POSITIVE" 
          });
}

      } catch (mlError) {
        console.error("[ML ROUTING ERROR] Failed to reach Python server. Falling back to MANUAL rules.", mlError);
        shopSettings.riskMode = "MANUAL"; // Fail-safe
      }
    }

    // =========================================================
    // MODE 2: MANUAL (YOUR EXACT ORIGINAL CODE)
    // =========================================================
    if (shopSettings.riskMode === "MANUAL") {
      
      // Guest COD
      if (!customer && isCurrentCod) {
        riskPercentage += shopSettings.guestCodPenalty;
        reasons.push({ description: `Guest checkout with COD.`, sentiment: "NEGATIVE" });
      }

      // Suspicious Name Component & Length Check
      const cleanFirstName = (firstName || "").trim();
      const cleanLastName = (lastName || "").trim();
      const fullName = [cleanFirstName, cleanLastName].filter(Boolean).join(" ");

      const isCombinedValid = fullName.length > 3;
      const hasValidComponent = cleanFirstName.length >= 3 || cleanLastName.length >= 3;

      if (!isCombinedValid || !hasValidComponent) {
        riskPercentage += shopSettings.shortNamePenalty; 
        reasons.push({ description: `Suspicious Name: Name is too short or lacks a valid 3-character first/last name.`, sentiment: "NEGATIVE" });
      }

      // Email Domain Validation
      if (customerEmail) {
        const cleanEmail = customerEmail.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        
        if (!emailRegex.test(cleanEmail)) {
          riskPercentage += shopSettings.invalidEmailPenalty; 
          reasons.push({ description: `Identity Alert: Invalid email format provided (${cleanEmail}).`, sentiment: "NEGATIVE" });
        } else if (isEmailDomainValid === 0) {
          riskPercentage += shopSettings.invalidEmailPenalty; 
          reasons.push({ description: `Identity Alert: Email domain does not exist or cannot receive mail (${cleanEmail}).`, sentiment: "NEGATIVE" });
        }
      } else {
        riskPercentage += shopSettings.missingEmailPenalty;
        reasons.push({ description: `Identity Alert: No email address provided.`, sentiment: "NEGATIVE" });
      }
      
      // Suspicious Timing (Night Time Penalty - Universal Support Fallback)
      const storeTimezone = shopSettings.timezone || "Asia/Kolkata";
      const rawDate = payload.created_at ? new Date(payload.created_at) : new Date();
      
      try {
        const localTimeString = rawDate.toLocaleString("en-US", { timeZone: storeTimezone });
        const localDate = new Date(localTimeString);
        const orderHour = localDate.getHours(); 

        if (orderHour >= 2 && orderHour <= 5) {
          riskPercentage += shopSettings.suspiciousTimingPenalty; 
          reasons.push({ description: `Suspicious Timing: Order placed during late night hours (${orderHour}:00).`, sentiment: "NEGATIVE" });
        }
      } catch (e) {
        console.log("Timezone parsing failed. Skipping night time penalty.");
      }
      
      // --- UNIFIED ADDRESS, HOUSE NUMBER & PINCODE EVALUATION ---
      const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
      
      if (!shippingStreetLines) {
        riskPercentage += shopSettings.missingAddressPenalty;
        reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
      } else {
        
        let isPinValidLocally = true; 

        if (shippingCountry === "IN" || shippingCountry === "India") {
          if (!/^[1-9][0-9]{5}$/.test(cleanZip)) {
            isPinValidLocally = false;
            riskPercentage += shopSettings.invalidPostalCodePenalty; 
            reasons.push({ description: `Logistics API Alert: Invalid PIN Code format (${shippingZip}).`, sentiment: "NEGATIVE" });
          } else {
            const validPin = await prisma.india_valid_pincodes.findUnique({ where: { postalCode: cleanZip } });
            if (!validPin) {
              isPinValidLocally = false;
              riskPercentage += SYSTEM_CONSTANTS.nonExistentPinPenalty; 
              reasons.push({ description: `Logistics Geo-Alert: The postal code (${shippingZip}) does not exist in India. Highly suspicious.`, sentiment: "NEGATIVE" });
            }
          }
        } else {
          if (!cleanZip || cleanZip.length < 4) {
            isPinValidLocally = false;
            riskPercentage += shopSettings.invalidPostalCodePenalty; 
            reasons.push({ description: `Logistics API Alert: Postal/ZIP Code is missing or incomplete.`, sentiment: "NEGATIVE" });
          } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
            isPinValidLocally = false;
            riskPercentage += shopSettings.invalidPostalCodePenalty; 
            reasons.push({ description: `Logistics API Alert: Fake Postal/ZIP Code sequence detected (${shippingZip}).`, sentiment: "NEGATIVE" });
          }
        }

        if (isPinValidLocally) {
          if (isAddressValid === false) {
            riskPercentage += shopSettings.fakeAddressPenalty; 
            reasons.push({ description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, sentiment: "NEGATIVE" });
          } else if (isAddressValid !== null) {
            const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
            if (!hasHouseNumber) {
              riskPercentage += shopSettings.missingHouseNoPenalty;
              reasons.push({ description: `Logistics API Alert: Verified real-world address, but missing a specific house/apartment number.`, sentiment: "NEGATIVE" });
            }
          }
        }
      }

      // History Rules Execution
      if (totalOrders === 0) {
        reasons.push({ description: "New Customer (No prior order history).", sentiment: "NEUTRAL" });
      } else {
        
        // THE DISPUTE DEFENSE GATES
        if (hasFraudHistory) {
          riskPercentage += shopSettings.fraudHistoryPenalty || 100; 
          reasons.push({ description: `CRITICAL ALERT: Buyer has a known history of 'Fraudulent' chargebacks.`, sentiment: "NEGATIVE" });
        }

        if (openDisputes > 0) {
          riskPercentage += shopSettings.openDisputePenalty || 40;
          reasons.push({ description: `Active Risk: Customer has ${openDisputes} unresolved dispute(s) pending.`, sentiment: "NEGATIVE" });
        }

        if (lostDisputes > 0) {
          let disputeRate = lostDisputes / totalOrders;
          riskPercentage += Math.round(disputeRate * shopSettings.disputeWeight);
          reasons.push({ description: `Financial Loss: Buyer has ${lostDisputes} lost chargeback(s) on record.`, sentiment: "NEGATIVE" });
        }

        if (wonDisputes > 0 && lostDisputes === 0) {
          riskPercentage += SYSTEM_CONSTANTS.wonDisputePenalty; 
          reasons.push({ description: `High Friction Buyer: Customer frequently files chargebacks, though merchant wins.`, sentiment: "NEUTRAL" });
        }

        // STRICT COD HOARDING CHECK
        if (!hasSuccessfulSameProduct && (isCurrentCod || isPendingPayment)) {
          if (maxUnpaidSameProduct >= 2) {
            riskPercentage += shopSettings.hoardingPenalty; 
            reasons.push({ description: `Targeted Hoarding (COD): Attempting to order the exact same product for a 3rd+ time without past payment.`, sentiment: "NEGATIVE" });
          } 
          else if (maxUnpaidSameProduct === 1) {
            riskPercentage += Math.round(shopSettings.hoardingPenalty / 2); 
            reasons.push({ description: `Suspicious Repeat Item (COD): Attempting a 2nd unpaid order for the exact same product.`, sentiment: "NEGATIVE" });
          }
        }
        
        // Volume Cancellations
        if (cancelRate > 0) {
          let cancelRiskCalc = Math.round(cancelRate * shopSettings.cancelWeight);
          if (cancelledCount >= 10) cancelRiskCalc += SYSTEM_CONSTANTS.highCancelBonusPenalty; 
          else if (cancelledCount >= 5) cancelRiskCalc += SYSTEM_CONSTANTS.medCancelBonusPenalty;
          riskPercentage += cancelRiskCalc;
          reasons.push({ description: `Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
        }

        // RTO Volume
        if (rtoRate > 0) {
          let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
          if (rtoCount >= 5) rtoRiskCalc += SYSTEM_CONSTANTS.highRtoBonusPenalty;
          riskPercentage += rtoRiskCalc;
          reasons.push({ description: `RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
        }

        // Serial Abandoner 
        if (totalOrders >= 5 && successRate <= 0.20) {
          let abandonRiskCalc = Math.round((1 - successRate) * SYSTEM_CONSTANTS.abandonWeight);
          if (totalOrders >= 20 && validOrderCount <= 1) abandonRiskCalc += SYSTEM_CONSTANTS.extremeAbandonPenalty;
          else if (totalOrders >= 10 && validOrderCount === 0) abandonRiskCalc += SYSTEM_CONSTANTS.highAbandonPenalty;
          
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
      const avgValidSpend = validOrderCount > 0 ? (totalSpend / validOrderCount) : 0;
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
      
      // Hidden Address Fraud Logic 
      if (shippingAddress1 && shippingAddress1.trim().length > 5) {
        const uniqueCustomersAtAddress = await prisma.shopify_store_order.groupBy({
          by: ['customerEmail'],
          where: { shop, shippingAddress1: shippingAddress1.trim(), customerEmail: { not: null } }
        });
        if (uniqueCustomersAtAddress.length >= 4) {
          riskPercentage += SYSTEM_CONSTANTS.addressFraudPenalty;
          reasons.push({ description: `Fraud network suspected: ${uniqueCustomersAtAddress.length} buyers using exact same address.`, sentiment: "NEGATIVE" });
        }
      }
    }

    // 9. FINALIZE & ROUTE OUTBOUND DATA (DYNAMIC THRESHOLDS)
    const score = Math.max(0, Math.min(100, Math.round(riskPercentage)));
    
    // Apply dynamic merchant thresholds
    const medThreshold = shopSettings.thresholdMedium || 40;
    const highThreshold = shopSettings.thresholdHigh || 70;

    let riskLevel = "LOW";
    if (score >= highThreshold) {
      riskLevel = "HIGH";
    } else if (score >= medThreshold) {
      riskLevel = "MEDIUM";
    }

    reasons.sort((a, b) => {
      const sortOrder = { "NEGATIVE": 1, "NEUTRAL": 2, "POSITIVE": 3 };
      return (sortOrder[a.sentiment] || 4) - (sortOrder[b.sentiment] || 4);
    });

    console.log(`\n=== RISK ASSESSMENT RESULT ===\nMode: ${shopSettings.riskMode}\nRisk Level: ${riskLevel} (Score: ${score}%)\nReasons:`, reasons, `\n==============================\n`);

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

    await updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid);
    
    // Save Risk Score and Tracking Mechanism (assessmentMethod)
    await prisma.zippyy_risk_score.upsert({
      where: { orderId: storeOrderId },
      update: { 
        score, 
        riskLevel, 
        assessmentMethod: shopSettings.riskMode, 
        reasons: reasons.map(r => r.description).join(" | "),
        settingsSnapshot: shopSettings 
      },
      create: { 
        shop, 
        orderId: storeOrderId, 
        score, 
        riskLevel, 
        assessmentMethod: shopSettings.riskMode, 
        reasons: reasons.map(r => r.description).join(" | "),
        settingsSnapshot: shopSettings 
      }
    });
    const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));
    await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);

    // 10. TRIGGER OMNICHANNEL NOTIFICATIONS
    try {
        if (customerPhone || customerEmail) {
            await enqueueNotification(
                shop, orderGid, customerPhone, customerEmail, 
                customerName, riskLevel, isCurrentCod, orderValue
            );
        }
    } catch (notificationError) {
        console.error("[Notification Queue Error]:", notificationError);
    }

    return new Response(null, { status: 200 });
    
  } catch (error) {
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
//       if (responseData.result.validated === true) return true; 
//       else if (responseData.result.validated === false) return false; 
//     }

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
//     const records = await dns.resolveMx(domain);
//     return records && records.length > 0;
//   } catch (error) {
//     return false;
//   }
// }

// // --- 1. MERCHANT CONFIGURABLE DEFAULTS (Fetched from DB) ---
// const DEFAULT_WEIGHTS = {
//   riskMode: "MANUAL", thresholdMedium: 40, thresholdHigh: 70, // <-- Added new variables
//   invalidEmailPenalty: 40, guestCodPenalty: 15, shortNamePenalty: 30,
//   missingEmailPenalty: 15, suspiciousTimingPenalty: 40, pendingPaymentPenalty: 20,
//   invalidPostalCodePenalty: 80, missingAddressPenalty: 30, 
//   missingHouseNoPenalty: 25, fakeAddressPenalty: 80,
//   cancelWeight: 35, rtoWeight: 35, refundWeight: 25, 
//   zeroValuePenalty: 25, codAbuseWeight: 20, valueAnomalyPenalty: 15,
//   hoardingPenalty: 30, emailFraudPenalty: 35, phoneFraudPenalty: 30,
//   disputeWeight: 50, openDisputePenalty: 40, fraudHistoryPenalty: 100,
//   loyaltyBonus: 5
// };

// // --- 2. FIXED SYSTEM CONSTANTS (Hardcoded, cannot be changed by UI) ---
// const SYSTEM_CONSTANTS = {
//   addressFraudPenalty: 35, 
//   abandonWeight: 25, 
//   extremeAbandonPenalty: 35,
//   highAbandonPenalty: 20,
//   nonExistentPinPenalty: 80,
//   highCancelBonusPenalty: 20, 
//   medCancelBonusPenalty: 10,
//   highRtoBonusPenalty: 15,
//   wonDisputePenalty: 15
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
//     // 2. STRICT DB IDEMPOTENCY
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

//     // 5. FETCH MERCHANT SETTINGS, CUSTOMER HISTORY & ZIPCODE HISTORY
//     let historyWhere = { shop, shopifyOrderId: { not: orderGid } }; 
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
    
//     const cleanZip = shippingZip ? shippingZip.replace(/[\s-]/g, "") : "";

//     const [fetchedSettings, pastOrders, zipHistory] = await Promise.all([
//       prisma.zippyy_risk_settings.findUnique({ where: { shop } }),
//       hasCustomerIdentifier ? prisma.shopify_store_order.findMany({ 
//         where: historyWhere,
//         include: { disputes: true }
//       }) : Promise.resolve([]),
//       // NEW: Fetch Zipcode History for ML Engine
//       cleanZip ? prisma.shopify_store_order.findMany({ 
//         where: { shop, shippingZip: cleanZip, shopifyOrderId: { not: orderGid } } 
//       }) : Promise.resolve([])
//     ]);
    
//     let shopSettings = { ...DEFAULT_WEIGHTS, ...(fetchedSettings || {}) };
//     const history = pastOrders || [];
    
//     // 6. ADDRESS CACHE CHECK
//     let isAddressValid = null;
//     let needsApiCheck = true;

//     if (currentFingerprint.length > 5 && hasCustomerIdentifier) {
//       const previousOrder = history.find(o => o.addressFingerprint === currentFingerprint && o.addressVerified !== null);
//       if (previousOrder) {
//         isAddressValid = previousOrder.addressVerified;
//         needsApiCheck = false; 
//       }
//     }

//     // 7. RISK ENGINE & RULES
//     let riskPercentage = 0;
//     let reasons = [];
    
//     const currentGatewayStr = paymentType.toLowerCase();
//     const isCurrentCod = currentGatewayStr.includes("cod") || currentGatewayStr.includes("cash") || currentGatewayStr.includes("pay on delivery");
    
//     const totalOrders = history.length;

//     // =========================================================
//     // MODE 1: AUTO (MACHINE LEARNING API CALL)
//     // =========================================================
//     if (shopSettings.riskMode === "AUTO") {
//       console.log(`[Risk Engine] AUTO Mode active for ${shop}. Generating ML Payload...`);

//       // A. Independent Validations for ML
//       let ml_address_valid = 1;
//       if (needsApiCheck && cleanZip) {
//           const fullStr = [shippingAddress1, shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry].filter(Boolean).join(" ");
//           const check = await checkAddressValidity(payload.id, fullStr);
//           if (check === false) ml_address_valid = 0;
//       } else if (isAddressValid === false) {
//           ml_address_valid = 0;
//       }

//       let ml_email_valid = 1;
//       if (customerEmail) {
//           const isDomainValid = await checkEmailDomain(customerEmail.trim().toLowerCase());
//           if (!isDomainValid) ml_email_valid = 0;
//       }

//       // B. Customer Stats
//       let customer_rtos = 0;
//       let firstOrderDate = new Date();
//       history.forEach(o => {
//         if (o.isRTO || o.fulfillmentStatus === "RETURNED" || o.financialStatus === "REFUNDED") customer_rtos++;
//         if (new Date(o.createdAt) < firstOrderDate) firstOrderDate = new Date(o.createdAt);
//       });
      
//       const is_new_customer = totalOrders === 0 ? 1 : 0;
//       const customer_return_rate = totalOrders > 0 ? (customer_rtos / totalOrders) : 0;
//       const daysSinceFirstOrder = Math.max(1, Math.floor((new Date() - firstOrderDate) / (1000 * 60 * 60 * 24)));
//       const customer_order_frequency = totalOrders > 0 ? (totalOrders / daysSinceFirstOrder) : 0;

//       // C. Zipcode Stats
//       const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
//       let zip_rtos = 0;
//       let zip_monthly_orders = 0;
//       let zip_monthly_rtos = 0;

//       zipHistory.forEach(o => {
//         const isRto = o.isRTO || o.fulfillmentStatus === "RETURNED";
//         if (isRto) zip_rtos++;
//         if (new Date(o.createdAt) >= thirtyDaysAgo) {
//           zip_monthly_orders++;
//           if (isRto) zip_monthly_rtos++;
//         }
//       });

//       const zipcode_order_volume = zipHistory.length;
//       const zipcode_return_rate = zipcode_order_volume > 0 ? (zip_rtos / zipcode_order_volume) : 0;
//       const zipcode_monthly_return_rate = zip_monthly_orders > 0 ? (zip_monthly_rtos / zip_monthly_orders) : 0;

//       // D. Time & Seasonal Stats
//       const orderDate = new Date(payload.created_at || Date.now());
//       const month = orderDate.getMonth() + 1; 
//       const hour = orderDate.getHours();
//       const day = orderDate.getDay(); 

//       const is_weekend = (day === 0 || day === 6) ? 1 : 0;
//       const is_night = (hour >= 22 || hour < 6) ? 1 : 0;
//       const is_holiday_season = (month === 11 || month === 12) ? 1 : 0;
//       const is_rainy_season = (month >= 6 && month <= 9) ? 1 : 0;

//       let order_value_bin = "LOW";
//       if (orderValue >= 5000) order_value_bin = "HIGH";
//       else if (orderValue >= 1500) order_value_bin = "MEDIUM";

//       // E. Build Payload
//       const mlPayload = {
//         customer_zipcode: cleanZip,
//         order_type: isCurrentCod ? "COD" : "PREPAID",
//         order_value_bin: order_value_bin,
//         email_domain: customerEmail ? customerEmail.split('@')[1].toLowerCase() : "unknown",
//         order_month: month,
//         is_weekend: is_weekend,
//         is_night: is_night,
//         is_holiday_season: is_holiday_season,
//         is_rainy_season: is_rainy_season,
//         customer_return_rate: customer_return_rate,
//         customer_order_frequency: customer_order_frequency,
//         is_new_customer: is_new_customer,
//         zipcode_order_volume: zipcode_order_volume,
//         zipcode_return_rate: zipcode_return_rate,
//         zipcode_monthly_return_rate: zipcode_monthly_return_rate,
//         is_address_valid: ml_address_valid,
//         is_email_domain_valid: ml_email_valid,
//         customer_cancel_rate: totalOrders > 0 ? (cancelledCount / totalOrders) : 0,
//         customer_success_rate: totalOrders > 0 ? (validOrderCount / totalOrders) : 0,
//         hoarding_count: maxUnpaidSameProduct
//       };
//       // Print the generated JSON payload to your Node.js terminal
//       console.log("\n================ ML PAYLOAD OUTBOUND ================");
//       console.log(JSON.stringify(mlPayload, null, 2));
//       console.log("=====================================================\n");
//       try {
//         const pythonServerUrl = process.env.ML_SERVER_URL || 'http://localhost:8000/predict';
//         const mlResponse = await fetch(pythonServerUrl, {
//           method: 'POST',
//           headers: { 'Content-Type': 'application/json' },
//           body: JSON.stringify(mlPayload)
//         });

//         if (!mlResponse.ok) throw new Error("ML Server returned an error.");
        
//         const mlData = await mlResponse.json();
//         riskPercentage = mlData.rto_probability * 100;
//         reasons.push({ 
//           description: `AI Prediction: Machine learning model analyzed historical customer and zip code behavior.`, 
//           sentiment: riskPercentage >= shopSettings.thresholdMedium ? "NEGATIVE" : "POSITIVE" 
//         });

//       } catch (mlError) {
//         console.error("[ML ROUTING ERROR] Failed to reach Python server. Falling back to MANUAL rules.", mlError);
//         shopSettings.riskMode = "MANUAL"; // Fail-safe
//       }
//     }

//     // =========================================================
//     // MODE 2: MANUAL (YOUR EXACT ORIGINAL CODE)
//     // =========================================================
//     if (shopSettings.riskMode === "MANUAL") {
      
//       // Guest COD
//       if (!customer && isCurrentCod) {
//         riskPercentage += shopSettings.guestCodPenalty;
//         reasons.push({ description: `Guest checkout with COD.`, sentiment: "NEGATIVE" });
//       }

//       // Suspicious Name Component & Length Check
//       const cleanFirstName = (firstName || "").trim();
//       const cleanLastName = (lastName || "").trim();
//       const fullName = [cleanFirstName, cleanLastName].filter(Boolean).join(" ");

//       const isCombinedValid = fullName.length > 3;
//       const hasValidComponent = cleanFirstName.length >= 3 || cleanLastName.length >= 3;

//       if (!isCombinedValid || !hasValidComponent) {
//         riskPercentage += shopSettings.shortNamePenalty; 
//         reasons.push({ description: `Suspicious Name: Name is too short or lacks a valid 3-character first/last name.`, sentiment: "NEGATIVE" });
//       }

//       // Email Domain Validation
//       if (customerEmail) {
//         const cleanEmail = customerEmail.trim().toLowerCase();
//         const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        
//         if (!emailRegex.test(cleanEmail)) {
//           riskPercentage += shopSettings.invalidEmailPenalty; 
//           reasons.push({ description: `Identity Alert: Invalid email format provided (${cleanEmail}).`, sentiment: "NEGATIVE" });
//         } else {
//           const isDomainValid = await checkEmailDomain(cleanEmail);
//           if (!isDomainValid) {
//             riskPercentage += shopSettings.invalidEmailPenalty; 
//             reasons.push({ description: `Identity Alert: Email domain does not exist or cannot receive mail (${cleanEmail}).`, sentiment: "NEGATIVE" });
//           }
//         }
//       } else {
//         riskPercentage += shopSettings.missingEmailPenalty;
//         reasons.push({ description: `Identity Alert: No email address provided.`, sentiment: "NEGATIVE" });
//       }
      
//       // Suspicious Timing (Night Time Penalty - Universal Support Fallback)
//       const storeTimezone = shopSettings.timezone || "Asia/Kolkata";
//       const rawDate = payload.created_at ? new Date(payload.created_at) : new Date();
      
//       try {
//         const localTimeString = rawDate.toLocaleString("en-US", { timeZone: storeTimezone });
//         const localDate = new Date(localTimeString);
//         const orderHour = localDate.getHours(); 

//         if (orderHour >= 2 && orderHour <= 5) {
//           riskPercentage += shopSettings.suspiciousTimingPenalty; 
//           reasons.push({ description: `Suspicious Timing: Order placed during late night hours (${orderHour}:00).`, sentiment: "NEGATIVE" });
//         }
//       } catch (e) {
//         console.log("Timezone parsing failed. Skipping night time penalty.");
//       }
      
//       // --- UNIFIED ADDRESS, HOUSE NUMBER & PINCODE EVALUATION ---
//       const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
      
//       if (!shippingStreetLines) {
//         riskPercentage += shopSettings.missingAddressPenalty;
//         reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
//       } else {
        
//         let isPinValidLocally = true; 

//         if (shippingCountry === "IN" || shippingCountry === "India") {
//           if (!/^[1-9][0-9]{5}$/.test(cleanZip)) {
//             isPinValidLocally = false;
//             riskPercentage += shopSettings.invalidPostalCodePenalty; 
//             reasons.push({ description: `Logistics API Alert: Invalid PIN Code format (${shippingZip}).`, sentiment: "NEGATIVE" });
//           } else {
//             const validPin = await prisma.india_valid_pincodes.findUnique({ where: { postalCode: cleanZip } });
//             if (!validPin) {
//               isPinValidLocally = false;
//               // Uses FIXED SYSTEM CONSTANT
//               riskPercentage += SYSTEM_CONSTANTS.nonExistentPinPenalty; 
//               reasons.push({ description: `Logistics Geo-Alert: The postal code (${shippingZip}) does not exist in India. Highly suspicious.`, sentiment: "NEGATIVE" });
//             }
//           }
//         } else {
//           if (!cleanZip || cleanZip.length < 4) {
//             isPinValidLocally = false;
//             riskPercentage += shopSettings.invalidPostalCodePenalty; 
//             reasons.push({ description: `Logistics API Alert: Postal/ZIP Code is missing or incomplete.`, sentiment: "NEGATIVE" });
//           } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
//             isPinValidLocally = false;
//             riskPercentage += shopSettings.invalidPostalCodePenalty; 
//             reasons.push({ description: `Logistics API Alert: Fake Postal/ZIP Code sequence detected (${shippingZip}).`, sentiment: "NEGATIVE" });
//           }
//         }

//         if (isPinValidLocally) {
//           if (needsApiCheck) {
//             const fullAddressString = [shippingAddress1, shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry].filter(Boolean).join(" ");
//             isAddressValid = await checkAddressValidity(payload.id, fullAddressString);
//           }

//           if (isAddressValid === false) {
//             riskPercentage += shopSettings.fakeAddressPenalty; 
//             reasons.push({ description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, sentiment: "NEGATIVE" });
//           } else {
//             const hasHouseNumber = /(^|[^\w])(#|no\.?|flat|house|plot|apt|unit)?\s*\d+[a-zA-Z]?/i.test(shippingStreetLines);
//             if (!hasHouseNumber) {
//               riskPercentage += shopSettings.missingHouseNoPenalty;
//               reasons.push({ description: `Logistics API Alert: Verified real-world address, but missing a specific house/apartment number.`, sentiment: "NEGATIVE" });
//             }
//           }
//         }
//       }

//       // Historical Behavior & Amplifiers
//       let totalSpend = 0, cancelledCount = 0;
//       let rtoCount = 0, refundCount = 0, codCount = 0, validOrderCount = 0, validTotalSpend = 0;
//       let hasFraudHistory = false, openDisputes = 0, wonDisputes = 0, lostDisputes = 0;

//       if (totalOrders === 0) {
//         reasons.push({ description: "New Customer (No prior order history).", sentiment: "NEUTRAL" });
//       } else {
//         history.forEach(o => {
//           const fStatus = o.financialStatus?.toUpperCase();
//           const fulfillment = o.fulfillmentStatus?.toUpperCase();
//           const pastGatewayStr = o.paymentGateway?.toLowerCase() || "";
//           const isCod = pastGatewayStr.includes("cod") || pastGatewayStr.includes("cash");

//           if (isCod) codCount++;
//           if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") refundCount++;

//           if (o.cancelledAt || fulfillment === "CANCELLED") cancelledCount++;
//           else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") rtoCount++;

//           if (o.disputes && o.disputes.length > 0) {
//             o.disputes.forEach(d => {
//               const reason = (d.reason || "").toLowerCase();
//               const status = (d.status || "").toLowerCase();
//               if (reason === "fraudulent") hasFraudHistory = true;
//               if (["needs_response", "under_review"].includes(status)) openDisputes++;
//               else if (status === "won") wonDisputes++;
//               else if (["lost", "charge_refunded"].includes(status)) lostDisputes++;
//             });
//           } else if (o.hasDispute) {
//             lostDisputes++; 
//           }

//           const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
//           if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
//             validOrderCount++;
//             validTotalSpend += Number(o.orderValue || 0);
//           }
          
//           const orderValue = Number(o.orderValue || 0);
//           let amountToSubtract = 0;

//           const hasLostDispute = o.disputes?.some(d => 
//             (d.status || "").toLowerCase() === "lost" || (d.status || "").toLowerCase() === "charge_refunded"
//           );

//           if (hasLostDispute || o.cancelledAt || fulfillment === "CANCELLED" || fStatus === "REFUNDED") {
//             amountToSubtract = orderValue;
//           } else if (fStatus === "PARTIALLY_REFUNDED") {
//             amountToSubtract = 0; 
//           }

//           totalSpend = (totalSpend + orderValue) - amountToSubtract;
//         });

//         let cancelRate = cancelledCount / totalOrders;
//         let rtoRate = rtoCount / totalOrders;
//         let refundRate = refundCount / totalOrders;
//         let codRate = codCount / totalOrders;
//         const successRate = validOrderCount / totalOrders;
        
//         // THE DISPUTE DEFENSE GATES
//         if (hasFraudHistory) {
//           riskPercentage += shopSettings.fraudHistoryPenalty || 100; 
//           reasons.push({ description: `CRITICAL ALERT: Buyer has a known history of 'Fraudulent' chargebacks.`, sentiment: "NEGATIVE" });
//         }

//         if (openDisputes > 0) {
//           riskPercentage += shopSettings.openDisputePenalty || 40;
//           reasons.push({ description: `Active Risk: Customer has ${openDisputes} unresolved dispute(s) pending.`, sentiment: "NEGATIVE" });
//         }

//         if (lostDisputes > 0) {
//           let disputeRate = lostDisputes / totalOrders;
//           riskPercentage += Math.round(disputeRate * shopSettings.disputeWeight);
//           reasons.push({ description: `Financial Loss: Buyer has ${lostDisputes} lost chargeback(s) on record.`, sentiment: "NEGATIVE" });
//         }

//         if (wonDisputes > 0 && lostDisputes === 0) {
//           // Uses FIXED SYSTEM CONSTANT
//           riskPercentage += SYSTEM_CONSTANTS.wonDisputePenalty; 
//           reasons.push({ description: `High Friction Buyer: Customer frequently files chargebacks, though merchant wins.`, sentiment: "NEUTRAL" });
//         }

//        // Hoarding Assessment (Updated for Strict COD Logic)
//         if (currentProductIds.length > 0) {
//           let maxUnpaidSameProduct = 0;
//           let hasSuccessfulSameProduct = false;

//           currentProductIds.forEach(productId => {
//             let unpaidCount = 0, successCount = 0;
//             history.forEach(pastOrder => {
//               let pastProductIds = [];
//               try { pastProductIds = pastOrder.lineItemsData ? JSON.parse(pastOrder.lineItemsData) : []; } catch (e) {}

//               if (pastProductIds.includes(productId)) {
//                 const fStatus = pastOrder.financialStatus?.toUpperCase();
//                 const fulfillment = pastOrder.fulfillmentStatus?.toUpperCase();
//                 const isClean = !pastOrder.cancelledAt && !(pastOrder.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !pastOrder.hasDispute;

//                 if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) successCount++;
//                 else unpaidCount++;
//               }
//             });

//             if (unpaidCount > maxUnpaidSameProduct) maxUnpaidSameProduct = unpaidCount;
//             if (successCount > 0) hasSuccessfulSameProduct = true;
//           });

//           // STRICT COD HOARDING CHECK
//           if (!hasSuccessfulSameProduct && (isCurrentCod || isPendingPayment)) {
            
//             // High Risk: They already have 2+ past unpaid orders (This is their 3rd+ attempt)
//             if (maxUnpaidSameProduct >= 2) {
//               riskPercentage += shopSettings.hoardingPenalty; 
//               reasons.push({ description: `Targeted Hoarding (COD): Attempting to order the exact same product for a 3rd+ time without past payment.`, sentiment: "NEGATIVE" });
//             } 
//             // Medium Risk: They have 1 past unpaid order (This is their 2nd attempt)
//             else if (maxUnpaidSameProduct === 1) {
//               riskPercentage += Math.round(shopSettings.hoardingPenalty / 2); 
//               reasons.push({ description: `Suspicious Repeat Item (COD): Attempting a 2nd unpaid order for the exact same product.`, sentiment: "NEGATIVE" });
//             }
//           }
//         }
//         // Volume Cancellations
//         if (cancelRate > 0) {
//           let cancelRiskCalc = Math.round(cancelRate * shopSettings.cancelWeight);
//           // Uses FIXED SYSTEM CONSTANTS
//           if (cancelledCount >= 10) cancelRiskCalc += SYSTEM_CONSTANTS.highCancelBonusPenalty; 
//           else if (cancelledCount >= 5) cancelRiskCalc += SYSTEM_CONSTANTS.medCancelBonusPenalty;
//           riskPercentage += cancelRiskCalc;
//           reasons.push({ description: `Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//         }

//         // RTO Volume
//         if (rtoRate > 0) {
//           let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
//           // Uses FIXED SYSTEM CONSTANT
//           if (rtoCount >= 5) rtoRiskCalc += SYSTEM_CONSTANTS.highRtoBonusPenalty;
//           riskPercentage += rtoRiskCalc;
//           reasons.push({ description: `RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//         }

//         // Serial Abandoner 
//         if (totalOrders >= 5 && successRate <= 0.20) {
//           let abandonRiskCalc = Math.round((1 - successRate) * SYSTEM_CONSTANTS.abandonWeight);
//           if (totalOrders >= 20 && validOrderCount <= 1) abandonRiskCalc += SYSTEM_CONSTANTS.extremeAbandonPenalty;
//           else if (totalOrders >= 10 && validOrderCount === 0) abandonRiskCalc += SYSTEM_CONSTANTS.highAbandonPenalty;
          
//           riskPercentage += abandonRiskCalc;
//           reasons.push({ description: `Serial order abandoner: ${totalOrders} orders but only ${validOrderCount} successful purchases.`, sentiment: "NEGATIVE" });
//         }

//         // Zero Value Buyer
//         if (totalOrders >= 5 && totalSpend === 0) {
//           riskPercentage += shopSettings.zeroValuePenalty;
//           reasons.push({ description: `Suspicious buyer: ${totalOrders} orders with 0 total successful spend.`, sentiment: "NEGATIVE" });
//         }

//         // Refund Abuse
//         if (refundRate >= 0.5 && totalOrders >= 3) {
//           riskPercentage += Math.round(refundRate * shopSettings.refundWeight);
//           reasons.push({ description: `High refund rate: ${refundCount} out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//         }

//         // Pending Payments
//         if (isPendingPayment && !isCurrentCod && paymentType !== "Manual_Pending_Order") {
//           riskPercentage += shopSettings.pendingPaymentPenalty; 
//           reasons.push({ description: `Suspicious Payment: Pending digital gateway (${paymentType}). Do not fulfill.`, sentiment: "NEGATIVE" });
//         }

//         // COD Abuse
//         if (codRate >= 0.7 && rtoCount >= 1 && totalOrders >= 3) {
//           riskPercentage += Math.round(codRate * shopSettings.codAbuseWeight); 
//           reasons.push({ description: `COD abuse suspected: ${codCount} COD orders with RTO history.`, sentiment: "NEGATIVE" });
//         }
//       }

//       // Value Anomaly
//       const avgValidSpend = validOrderCount > 0 ? validTotalSpend / validOrderCount : 0;
//       if (orderValue > avgValidSpend * 5 && avgValidSpend > 0) {
//         riskPercentage += shopSettings.valueAnomalyPenalty;
//         reasons.push({ description: `Order value unusually high compared to successful history.`, sentiment: "NEGATIVE" });
//       }

//       // Loyalty Discount
//       if (validOrderCount >= 3) {
//         let loyaltyDiscount = Math.min(30, validOrderCount * shopSettings.loyaltyBonus); 
//         riskPercentage -= loyaltyDiscount;
//         reasons.push({ description: `Loyal repeat buyer: ${validOrderCount} paid & delivered orders.`, sentiment: "POSITIVE" });
//       }

//       // 8. FRAUD NETWORKS
//       if (customerEmail && customerEmail.trim().length > 5) {
//         const uniquePhonesWithEmail = await prisma.shopify_store_order.groupBy({
//           by: ['customerPhone'],
//           where: { shop, customerEmail: customerEmail.trim(), customerPhone: { not: null } }
//         });
//         if (uniquePhonesWithEmail.length >= 3) {
//           riskPercentage += shopSettings.emailFraudPenalty; 
//           reasons.push({ description: `Identity Network: The email (${customerEmail}) is being used across ${uniquePhonesWithEmail.length} different phone numbers.`, sentiment: "NEGATIVE" });
//         }
//       }

//       if (customerPhone && customerPhone.trim().length > 6) {
//         const uniqueEmailsWithPhone = await prisma.shopify_store_order.groupBy({
//           by: ['customerEmail'],
//           where: { shop, customerPhone: customerPhone.trim(), customerEmail: { not: null } }
//         });
//         if (uniqueEmailsWithPhone.length >= 3) {
//           riskPercentage += shopSettings.phoneFraudPenalty; 
//           reasons.push({ description: `Identity Network: The phone number is being shared across ${uniqueEmailsWithPhone.length} different email addresses.`, sentiment: "NEGATIVE" });
//         }
//       }
      
//       // Hidden Address Fraud Logic 
//       if (shippingAddress1 && shippingAddress1.trim().length > 5) {
//         const uniqueCustomersAtAddress = await prisma.shopify_store_order.groupBy({
//           by: ['customerEmail'],
//           where: { shop, shippingAddress1: shippingAddress1.trim(), customerEmail: { not: null } }
//         });
//         if (uniqueCustomersAtAddress.length >= 4) {
//           riskPercentage += SYSTEM_CONSTANTS.addressFraudPenalty;
//           reasons.push({ description: `Fraud network suspected: ${uniqueCustomersAtAddress.length} buyers using exact same address.`, sentiment: "NEGATIVE" });
//         }
//       }
//     }

//     // 9. FINALIZE & ROUTE OUTBOUND DATA (DYNAMIC THRESHOLDS)
//     const score = Math.max(0, Math.min(100, Math.round(riskPercentage)));
    
//     // Apply dynamic merchant thresholds
//     const medThreshold = shopSettings.thresholdMedium || 40;
//     const highThreshold = shopSettings.thresholdHigh || 70;

//     let riskLevel = "LOW";
//     if (score >= highThreshold) {
//       riskLevel = "HIGH";
//     } else if (score >= medThreshold) {
//       riskLevel = "MEDIUM";
//     }

//     reasons.sort((a, b) => {
//       const sortOrder = { "NEGATIVE": 1, "NEUTRAL": 2, "POSITIVE": 3 };
//       return (sortOrder[a.sentiment] || 4) - (sortOrder[b.sentiment] || 4);
//     });

//     console.log(`\n=== RISK ASSESSMENT RESULT ===\nMode: ${shopSettings.riskMode}\nRisk Level: ${riskLevel} (Score: ${score}%)\nReasons:`, reasons, `\n==============================\n`);

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

//     await updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid);
    
//     // Save Risk Score and Tracking Mechanism (assessmentMethod)
//     await prisma.zippyy_risk_score.upsert({
//       where: { orderId: storeOrderId },
//       update: { 
//         score, 
//         riskLevel, 
//         assessmentMethod: shopSettings.riskMode, 
//         reasons: reasons.map(r => r.description).join(" | "),
//         settingsSnapshot: shopSettings 
//       },
//       create: { 
//         shop, 
//         orderId: storeOrderId, 
//         score, 
//         riskLevel, 
//         assessmentMethod: shopSettings.riskMode, 
//         reasons: reasons.map(r => r.description).join(" | "),
//         settingsSnapshot: shopSettings 
//       }
//     });
//     const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));
//     await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);

//     // 10. TRIGGER OMNICHANNEL NOTIFICATIONS
//     try {
//         if (customerPhone || customerEmail) {
//             await enqueueNotification(
//                 shop, orderGid, customerPhone, customerEmail, 
//                 customerName, riskLevel, isCurrentCod, orderValue
//             );
//         }
//     } catch (notificationError) {
//         console.error("[Notification Queue Error]:", notificationError);
//     }

//     return new Response(null, { status: 200 });
    
//   } catch (error) {
//     console.error(`[CRITICAL ERROR] Failed to process Risk Score for Order ${payload.id}:`, error);
//     return new Response("Internal Server Error", { status: 500 });
//   }
// }














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
//       if (responseData.result.validated === true) return true; 
//       else if (responseData.result.validated === false) return false; 
//     }

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
//     const records = await dns.resolveMx(domain);
//     return records && records.length > 0;
//   } catch (error) {
//     return false;
//   }
// }

// // --- 1. MERCHANT CONFIGURABLE DEFAULTS (Fetched from DB) ---
// const DEFAULT_WEIGHTS = {
//   invalidEmailPenalty: 40, guestCodPenalty: 15, shortNamePenalty: 30,
//   missingEmailPenalty: 15, suspiciousTimingPenalty: 40, pendingPaymentPenalty: 20,
//   invalidPostalCodePenalty: 80, missingAddressPenalty: 30, 
//   missingHouseNoPenalty: 25, fakeAddressPenalty: 80,
//   cancelWeight: 35, rtoWeight: 35, refundWeight: 25, 
//   zeroValuePenalty: 25, codAbuseWeight: 20, valueAnomalyPenalty: 15,
//   hoardingPenalty: 30, emailFraudPenalty: 35, phoneFraudPenalty: 30,
//   disputeWeight: 50, openDisputePenalty: 40, fraudHistoryPenalty: 100,
//   loyaltyBonus: 5
// };

// // --- 2. FIXED SYSTEM CONSTANTS (Hardcoded, cannot be changed by UI) ---
// const SYSTEM_CONSTANTS = {
//   addressFraudPenalty: 35, 
//   abandonWeight: 25, 
//   extremeAbandonPenalty: 35,
//   highAbandonPenalty: 20,
//   nonExistentPinPenalty: 80,
//   highCancelBonusPenalty: 20, 
//   medCancelBonusPenalty: 10,
//   highRtoBonusPenalty: 15,
//   wonDisputePenalty: 15
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
//     // 2. STRICT DB IDEMPOTENCY
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
//     let historyWhere = { shop, shopifyOrderId: { not: orderGid } }; 
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
//         include: { disputes: true }
//       }) : Promise.resolve([])
//     ]);
    
//     let shopSettings = { ...DEFAULT_WEIGHTS, ...(fetchedSettings || {}) };
//     const history = pastOrders || [];
    
//     // 6. ADDRESS CACHE CHECK
//     let isAddressValid = null;
//     let needsApiCheck = true;

//     if (currentFingerprint.length > 5 && hasCustomerIdentifier) {
//       const previousOrder = history.find(o => o.addressFingerprint === currentFingerprint && o.addressVerified !== null);
//       if (previousOrder) {
//         isAddressValid = previousOrder.addressVerified;
//         needsApiCheck = false; 
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

//     // Suspicious Name Component & Length Check
//     const cleanFirstName = (firstName || "").trim();
//     const cleanLastName = (lastName || "").trim();
//     const fullName = [cleanFirstName, cleanLastName].filter(Boolean).join(" ");

//     const isCombinedValid = fullName.length > 3;
//     const hasValidComponent = cleanFirstName.length >= 3 || cleanLastName.length >= 3;

//     if (!isCombinedValid || !hasValidComponent) {
//       riskPercentage += shopSettings.shortNamePenalty; 
//       reasons.push({ description: `Suspicious Name: Name is too short or lacks a valid 3-character first/last name.`, sentiment: "NEGATIVE" });
//     }

//     // Email Domain Validation
//     if (customerEmail) {
//       const cleanEmail = customerEmail.trim().toLowerCase();
//       const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      
//       if (!emailRegex.test(cleanEmail)) {
//         riskPercentage += shopSettings.invalidEmailPenalty; 
//         reasons.push({ description: `Identity Alert: Invalid email format provided (${cleanEmail}).`, sentiment: "NEGATIVE" });
//       } else {
//         const isDomainValid = await checkEmailDomain(cleanEmail);
//         if (!isDomainValid) {
//           riskPercentage += shopSettings.invalidEmailPenalty; 
//           reasons.push({ description: `Identity Alert: Email domain does not exist or cannot receive mail (${cleanEmail}).`, sentiment: "NEGATIVE" });
//         }
//       }
//     } else {
//       riskPercentage += shopSettings.missingEmailPenalty;
//       reasons.push({ description: `Identity Alert: No email address provided.`, sentiment: "NEGATIVE" });
//     }
    
//     // Suspicious Timing (Night Time Penalty - Universal Support Fallback)
//     const storeTimezone = shopSettings.timezone || "Asia/Kolkata";
//     const rawDate = payload.created_at ? new Date(payload.created_at) : new Date();
    
//     try {
//       const localTimeString = rawDate.toLocaleString("en-US", { timeZone: storeTimezone });
//       const localDate = new Date(localTimeString);
//       const orderHour = localDate.getHours(); 

//       if (orderHour >= 2 && orderHour <= 5) {
//         riskPercentage += shopSettings.suspiciousTimingPenalty; 
//         reasons.push({ description: `Suspicious Timing: Order placed during late night hours (${orderHour}:00).`, sentiment: "NEGATIVE" });
//       }
//     } catch (e) {
//       console.log("Timezone parsing failed. Skipping night time penalty.");
//     }
    
//     // --- UNIFIED ADDRESS, HOUSE NUMBER & PINCODE EVALUATION ---
//     const shippingStreetLines = [shippingAddress1, shippingAddress2].filter(Boolean).join(" ").trim();
//     const cleanZip = shippingZip ? shippingZip.replace(/[\s-]/g, "") : "";
    
//     if (!shippingStreetLines) {
//       riskPercentage += shopSettings.missingAddressPenalty;
//       reasons.push({ description: `Missing Shipping Address.`, sentiment: "NEGATIVE" });
//     } else {
      
//       let isPinValidLocally = true; 

//       if (shippingCountry === "IN" || shippingCountry === "India") {
//         if (!/^[1-9][0-9]{5}$/.test(cleanZip)) {
//           isPinValidLocally = false;
//           riskPercentage += shopSettings.invalidPostalCodePenalty; 
//           reasons.push({ description: `Logistics API Alert: Invalid PIN Code format (${shippingZip}).`, sentiment: "NEGATIVE" });
//         } else {
//           const validPin = await prisma.india_valid_pincodes.findUnique({ where: { postalCode: cleanZip } });
//           if (!validPin) {
//             isPinValidLocally = false;
//             // Uses FIXED SYSTEM CONSTANT
//             riskPercentage += SYSTEM_CONSTANTS.nonExistentPinPenalty; 
//             reasons.push({ description: `Logistics Geo-Alert: The postal code (${shippingZip}) does not exist in India. Highly suspicious.`, sentiment: "NEGATIVE" });
//           }
//         }
//       } else {
//         if (!cleanZip || cleanZip.length < 4) {
//           isPinValidLocally = false;
//           riskPercentage += shopSettings.invalidPostalCodePenalty; 
//           reasons.push({ description: `Logistics API Alert: Postal/ZIP Code is missing or incomplete.`, sentiment: "NEGATIVE" });
//         } else if (/^(0+|1+|12345\d*)$/.test(cleanZip)) {
//           isPinValidLocally = false;
//           riskPercentage += shopSettings.invalidPostalCodePenalty; 
//           reasons.push({ description: `Logistics API Alert: Fake Postal/ZIP Code sequence detected (${shippingZip}).`, sentiment: "NEGATIVE" });
//         }
//       }

//       if (isPinValidLocally) {
//         if (needsApiCheck) {
//           const fullAddressString = [shippingAddress1, shippingAddress2, shippingCity, shippingProvince, shippingZip, shippingCountry].filter(Boolean).join(" ");
//           isAddressValid = await checkAddressValidity(payload.id, fullAddressString);
//         }

//         if (isAddressValid === false) {
//           riskPercentage += shopSettings.fakeAddressPenalty; 
//           reasons.push({ description: `Logistics API Alert: The provided delivery address could not be matched or does not exist.`, sentiment: "NEGATIVE" });
//         } else {
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
//     let hasFraudHistory = false, openDisputes = 0, wonDisputes = 0, lostDisputes = 0;

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

//         if (o.disputes && o.disputes.length > 0) {
//           o.disputes.forEach(d => {
//             const reason = (d.reason || "").toLowerCase();
//             const status = (d.status || "").toLowerCase();
//             if (reason === "fraudulent") hasFraudHistory = true;
//             if (["needs_response", "under_review"].includes(status)) openDisputes++;
//             else if (status === "won") wonDisputes++;
//             else if (["lost", "charge_refunded"].includes(status)) lostDisputes++;
//           });
//         } else if (o.hasDispute) {
//           lostDisputes++; 
//         }

//         const isClean = !o.cancelledAt && !(o.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !o.hasDispute;
//         if ((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean) {
//           validOrderCount++;
//           validTotalSpend += Number(o.orderValue || 0);
//         }
        
//         const orderValue = Number(o.orderValue || 0);
//         let amountToSubtract = 0;

//         const hasLostDispute = o.disputes?.some(d => 
//           (d.status || "").toLowerCase() === "lost" || (d.status || "").toLowerCase() === "charge_refunded"
//         );

//         if (hasLostDispute || o.cancelledAt || fulfillment === "CANCELLED" || fStatus === "REFUNDED") {
//           amountToSubtract = orderValue;
//         } else if (fStatus === "PARTIALLY_REFUNDED") {
//           amountToSubtract = 0; 
//         }

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
//         reasons.push({ description: `CRITICAL ALERT: Buyer has a known history of 'Fraudulent' chargebacks.`, sentiment: "NEGATIVE" });
//       }

//       if (openDisputes > 0) {
//         riskPercentage += shopSettings.openDisputePenalty || 40;
//         reasons.push({ description: `Active Risk: Customer has ${openDisputes} unresolved dispute(s) pending.`, sentiment: "NEGATIVE" });
//       }

//       if (lostDisputes > 0) {
//         let disputeRate = lostDisputes / totalOrders;
//         riskPercentage += Math.round(disputeRate * shopSettings.disputeWeight);
//         reasons.push({ description: `Financial Loss: Buyer has ${lostDisputes} lost chargeback(s) on record.`, sentiment: "NEGATIVE" });
//       }

//       if (wonDisputes > 0 && lostDisputes === 0) {
//         // Uses FIXED SYSTEM CONSTANT
//         riskPercentage += SYSTEM_CONSTANTS.wonDisputePenalty; 
//         reasons.push({ description: `High Friction Buyer: Customer frequently files chargebacks, though merchant wins.`, sentiment: "NEUTRAL" });
//       }

//      // Hoarding Assessment (Updated for Strict COD Logic)
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

//         // STRICT COD HOARDING CHECK
//         // Only triggers if they have no successful past purchases of this item
//         // AND the current order is not paid upfront (COD or Pending)
//         if (!hasSuccessfulSameProduct && (isCurrentCod || isPendingPayment)) {
          
//           // High Risk: They already have 2+ past unpaid orders (This is their 3rd+ attempt)
//           if (maxUnpaidSameProduct >= 2) {
//             riskPercentage += shopSettings.hoardingPenalty; 
//             reasons.push({ description: `Targeted Hoarding (COD): Attempting to order the exact same product for a 3rd+ time without past payment.`, sentiment: "NEGATIVE" });
//           } 
//           // Medium Risk: They have 1 past unpaid order (This is their 2nd attempt)
//           else if (maxUnpaidSameProduct === 1) {
//             riskPercentage += Math.round(shopSettings.hoardingPenalty / 2); 
//             reasons.push({ description: `Suspicious Repeat Item (COD): Attempting a 2nd unpaid order for the exact same product.`, sentiment: "NEGATIVE" });
//           }
//         }
//       }
//       // Volume Cancellations
//       if (cancelRate > 0) {
//         let cancelRiskCalc = Math.round(cancelRate * shopSettings.cancelWeight);
//         // Uses FIXED SYSTEM CONSTANTS
//         if (cancelledCount >= 10) cancelRiskCalc += SYSTEM_CONSTANTS.highCancelBonusPenalty; 
//         else if (cancelledCount >= 5) cancelRiskCalc += SYSTEM_CONSTANTS.medCancelBonusPenalty;
//         riskPercentage += cancelRiskCalc;
//         reasons.push({ description: `Cancellation: ${cancelledCount} orders cancelled out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // RTO Volume
//       if (rtoRate > 0) {
//         let rtoRiskCalc = Math.round(rtoRate * shopSettings.rtoWeight);
//         // Uses FIXED SYSTEM CONSTANT
//         if (rtoCount >= 5) rtoRiskCalc += SYSTEM_CONSTANTS.highRtoBonusPenalty;
//         riskPercentage += rtoRiskCalc;
//         reasons.push({ description: `RTO Rate: ${rtoCount} orders marked as RTO out of ${totalOrders} orders.`, sentiment: "NEGATIVE" });
//       }

//       // Serial Abandoner 
//       if (totalOrders >= 5 && successRate <= 0.20) {
//         let abandonRiskCalc = Math.round((1 - successRate) * SYSTEM_CONSTANTS.abandonWeight);
//         if (totalOrders >= 20 && validOrderCount <= 1) abandonRiskCalc += SYSTEM_CONSTANTS.extremeAbandonPenalty;
//         else if (totalOrders >= 10 && validOrderCount === 0) abandonRiskCalc += SYSTEM_CONSTANTS.highAbandonPenalty;
        
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
//     if (customerEmail && customerEmail.trim().length > 5) {
//       const uniquePhonesWithEmail = await prisma.shopify_store_order.groupBy({
//         by: ['customerPhone'],
//         where: { shop, customerEmail: customerEmail.trim(), customerPhone: { not: null } }
//       });
//       if (uniquePhonesWithEmail.length >= 3) {
//         riskPercentage += shopSettings.emailFraudPenalty; 
//         reasons.push({ description: `Identity Network: The email (${customerEmail}) is being used across ${uniquePhonesWithEmail.length} different phone numbers.`, sentiment: "NEGATIVE" });
//       }
//     }

//     if (customerPhone && customerPhone.trim().length > 6) {
//       const uniqueEmailsWithPhone = await prisma.shopify_store_order.groupBy({
//         by: ['customerEmail'],
//         where: { shop, customerPhone: customerPhone.trim(), customerEmail: { not: null } }
//       });
//       if (uniqueEmailsWithPhone.length >= 3) {
//         riskPercentage += shopSettings.phoneFraudPenalty; 
//         reasons.push({ description: `Identity Network: The phone number is being shared across ${uniqueEmailsWithPhone.length} different email addresses.`, sentiment: "NEGATIVE" });
//       }
//     }
    
//     // Hidden Address Fraud Logic 
//     if (shippingAddress1 && shippingAddress1.trim().length > 5) {
//       const uniqueCustomersAtAddress = await prisma.shopify_store_order.groupBy({
//         by: ['customerEmail'],
//         where: { shop, shippingAddress1: shippingAddress1.trim(), customerEmail: { not: null } }
//       });
//       if (uniqueCustomersAtAddress.length >= 4) {
//         riskPercentage += SYSTEM_CONSTANTS.addressFraudPenalty;
//         reasons.push({ description: `Fraud network suspected: ${uniqueCustomersAtAddress.length} buyers using exact same address.`, sentiment: "NEGATIVE" });
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

//     await updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid);
    
//    // shopSettings was already defined in Step 5 of your code!
//     await prisma.zippyy_risk_score.upsert({
//       where: { orderId: storeOrderId },
//       update: { 
//         score, 
//         riskLevel, 
//         reasons: reasons.map(r => r.description).join(" | "),
//         settingsSnapshot: shopSettings 
//       },
//       create: { 
//         shop, 
//         orderId: storeOrderId, 
//         score, 
//         riskLevel, 
//         reasons: reasons.map(r => r.description).join(" | "),
//         settingsSnapshot: shopSettings 
//       }
//     });
//     const riskFacts = reasons.map(r => ({ description: r.description, sentiment: r.sentiment || "NEUTRAL" }));
//     await enqueueOutboundRisk(shop, orderGid, score, riskLevel, riskFacts);

//     // 10. TRIGGER OMNICHANNEL NOTIFICATIONS
//     try {
//         if (customerPhone || customerEmail) {
//             await enqueueNotification(
//                 shop, orderGid, customerPhone, customerEmail, 
//                 customerName, riskLevel, isCurrentCod, orderValue
//             );
//         }
//     } catch (notificationError) {
//         console.error("[Notification Queue Error]:", notificationError);
//     }

//     return new Response(null, { status: 200 });
    
//   } catch (error) {
//     console.error(`[CRITICAL ERROR] Failed to process Risk Score for Order ${payload.id}:`, error);
//     return new Response("Internal Server Error", { status: 500 });
//   }
// }

