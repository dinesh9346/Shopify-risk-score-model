import prisma from "../db.server.js";

export async function triggerBulkOrderSync(admin, shop) {
  console.log(`[BULK SYNC] Starting bulk order sync for ${shop}`);

  try {
    const response = await admin.graphql(`
      mutation {
        bulkOperationRunQuery(
          query: """
          {
            orders(first: 250) {
              edges {
                node {
                  id
                  email
                  clientIp
                  cancelledAt
                  displayFinancialStatus
                  displayFulfillmentStatus
                  paymentGatewayNames
                  totalPriceSet {
                    shopMoney {
                      amount
                    }
                  }
                  disputes {
                    id
                    status
                  }
                  customer {
                    id
                    firstName
                    lastName
                    phone
                  }

                  shippingAddress {
                    address1
                    phone
                    countryCode
                  }

                  billingAddress {
                    countryCode
                  }

                }
              }
            }
          }
          """
        ) {
          bulkOperation {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `);

    const json = await response.json();

    console.log("[BULK SYNC RESPONSE]", JSON.stringify(json, null, 2));

    if (!json.data?.bulkOperationRunQuery) {
      console.error("[BULK SYNC] Invalid response structure:", json);
      return;
    }

    if (json.data.bulkOperationRunQuery.userErrors.length > 0) {
      console.error(
        "[BULK SYNC] Errors:",
        json.data.bulkOperationRunQuery.userErrors
      );
      return;
    }

    console.log(
      `[BULK SYNC] Operation Started:`,
      json.data.bulkOperationRunQuery.bulkOperation.id
    );

  } catch (error) {
    console.error(`[BULK SYNC] Failed to start bulk sync`, error);
  }
}



/* ================= 2. BULK PROFILE BUILDER ================= */
export async function buildHistoricalBuyerProfiles(shop) {
  console.log(`[BULK SYNC] Starting historical profile aggregation for ${shop}...`);

  // Wipe the slate clean before rebuilding to clear ghost profiles
  await prisma.zippyy_buyer_profile.deleteMany({ where: { shop } });

  const allOrders = await prisma.shopify_store_order.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" } 
  });

  const identityMap = new Map();
  allOrders.forEach(order => {
    if (order.customerId) {
      if (!identityMap.has(order.customerId)) {
        // ADDED: Track firstName and lastName in the identity map
        identityMap.set(order.customerId, { email: null, phone: null, firstName: null, lastName: null });
      }
      const idRecord = identityMap.get(order.customerId);
      if (order.customerEmail && !idRecord.email) idRecord.email = order.customerEmail.trim().toLowerCase();
      if (order.customerPhone && !idRecord.phone) idRecord.phone = order.customerPhone.trim();
      
      // ADDED: Capture names from the raw order
      if (order.firstName && !idRecord.firstName) idRecord.firstName = order.firstName.trim();
      if (order.lastName && !idRecord.lastName) idRecord.lastName = order.lastName.trim();
    }
  });

  const customerMap = new Map();

  allOrders.forEach((order) => {
    let safeEmail = order.customerEmail?.trim().toLowerCase() || null;
    let safePhone = order.customerPhone?.trim() || null;
    const safeCustId = order.customerId?.trim() || null;

    // ADDED: Extract safe names
    let safeFirstName = order.firstName?.trim() || null;
    let safeLastName = order.lastName?.trim() || null;

    if (safeCustId && identityMap.has(safeCustId)) {
      const enriched = identityMap.get(safeCustId);
      safeEmail = safeEmail || enriched.email;
      safePhone = safePhone || enriched.phone;

      // ADDED: Pull names from the enriched identity map if available
      safeFirstName = safeFirstName || enriched.firstName;
      safeLastName = safeLastName || enriched.lastName;
    }

    const buyerIdentifier = safeEmail || safePhone || safeCustId || `guest-${order.shopifyOrderId}`;

    if (!customerMap.has(buyerIdentifier)) {
      customerMap.set(buyerIdentifier, {
        buyerIdentifier,
        customerEmail: safeEmail,
        customerPhone: safePhone,
        customerId: safeCustId,
        
        // ADDED: Save names to the profile state
        firstName: safeFirstName,
        lastName: safeLastName,

        totalCheckoutAttempts: 0,
        validOrderCount: 0,
        totalSpend: 0,
        fulfilledCount: 0,
        cancelledCount: 0,
        rtoCount: 0,
        codCount: 0,
        unpaidCount: 0,
        disputeCount: 0,
        refundCount: 0,
      });
    }

    const profile = customerMap.get(buyerIdentifier);
    profile.totalCheckoutAttempts += 1;

    const fStatus = order.financialStatus?.toUpperCase();
    const fulfillment = order.fulfillmentStatus?.toUpperCase();
    const isCod = order.paymentGateway?.toLowerCase().includes("cod") || order.paymentGateway?.toLowerCase().includes("cash");
    
    if (isCod) profile.codCount += 1;
    if (order.hasDispute) profile.disputeCount += 1;

    // --- LOGISTICS TRACKING (Correct Priority) ---
    if (order.cancelledAt || fulfillment === "CANCELLED") {
      profile.cancelledCount += 1;
    } else if (order.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") {
      profile.rtoCount += 1;
    } else if (fulfillment === "FULFILLED") {
      profile.fulfilledCount += 1;
    }

    if (fStatus === "PENDING") profile.unpaidCount += 1;
    else if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") profile.refundCount += 1;

    // Valid Order Gatekeeper
    const isClean = !order.cancelledAt && !(order.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !order.hasDispute;
    if (fStatus === "PAID" && fulfillment === "FULFILLED" && isClean) {
      profile.validOrderCount += 1;
      profile.totalSpend += Number(order.orderValue || 0);
    }
  });

  for (const [identifier, profile] of customerMap.entries()) {
    
    // CALL THE HELPER FUNCTION HERE
    const { segment, riskReasons } = calculateRiskSegment(profile);

    try {
      await prisma.zippyy_buyer_profile.upsert({
        where: { shop_buyerIdentifier: { shop, buyerIdentifier: identifier } },
        update: { ...profile, buyerSegment: segment, riskReasons: riskReasons },
        create: { shop, ...profile, buyerSegment: segment, riskReasons: riskReasons }
      });
    } catch (err) {
      console.error(`[BULK ERROR]`, err.message);
    }
  }
}

/* ================= 3. SINGLE PROFILE UPDATER (WEBHOOKS) ================= */
export async function updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid) {
  try {
    let safeEmail = customerEmail?.trim().toLowerCase() || null;
    let safePhone = customerPhone?.trim() || null;
    const safeCustId = customerId?.trim() || null;

    // ADDED: Setup safe variables for the name
    let safeFirstName = null;
    let safeLastName = null;

    if (safeCustId && (!safeEmail || !safePhone)) {
      const existingProfile = await prisma.zippyy_buyer_profile.findFirst({
        where: { shop, customerId: safeCustId }
      });
      if (existingProfile) {
        safeEmail = safeEmail || existingProfile.customerEmail;
        safePhone = safePhone || existingProfile.customerPhone;
        
        // ADDED: Recover existing names from the database
        safeFirstName = existingProfile.firstName || null;
        safeLastName = existingProfile.lastName || null;
      }
    }

    const buyerIdentifier = safeEmail || safePhone || safeCustId || `guest-${orderGid}`;

    const allCustomerOrders = await prisma.shopify_store_order.findMany({
      where: {
        shop,
        OR: [
          safeEmail ? { customerEmail: safeEmail } : undefined,
          safeCustId ? { customerId: safeCustId } : undefined,
          safePhone ? { customerPhone: safePhone } : undefined,
          { shopifyOrderId: `gid://shopify/Order/${orderGid}` },
          { shopifyOrderId: orderGid }
        ].filter(Boolean)
      }
    });

    // ADDED: Scan past orders to extract the best available name
    const orderWithName = allCustomerOrders.find(o => o.firstName || o.lastName);
    if (orderWithName) {
      safeFirstName = safeFirstName || orderWithName.firstName;
      safeLastName = safeLastName || orderWithName.lastName;
    }

    let profile = {
      totalCheckoutAttempts: allCustomerOrders.length,
      validOrderCount: 0,
      totalSpend: 0,
      fulfilledCount: 0,
      cancelledCount: 0,
      rtoCount: 0,
      codCount: 0,
      unpaidCount: 0,
      disputeCount: 0,
      refundCount: 0,
    };
    
    allCustomerOrders.forEach(o => {
      const fStatus = o.financialStatus?.toUpperCase();
      const fulfillment = o.fulfillmentStatus?.toUpperCase();
      const isCod = o.paymentGateway?.toLowerCase().includes("cod") || o.paymentGateway?.toLowerCase().includes("cash");
      
      if (isCod) profile.codCount += 1;
      if (o.hasDispute) profile.disputeCount += 1;

      // Logistics Tracking
      if (o.cancelledAt || fulfillment === "CANCELLED") {
        profile.cancelledCount += 1;
      } else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") {
        profile.rtoCount += 1;
      } else if (fulfillment === "FULFILLED" || fulfillment === "SUCCESS" || fulfillment === "DELIVERED") {
        profile.fulfilledCount += 1;
      }
      
      if (fStatus === "PENDING") profile.unpaidCount += 1;
      
      if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") {
        profile.refundCount += 1;
      }

      // --- NET REVENUE GATEKEEPER ---
      const isEligibleForRevenue = (fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && 
                                   (fulfillment === "FULFILLED" || fulfillment === "SUCCESS" || fulfillment === "DELIVERED") && 
                                   !o.hasDispute && 
                                   !o.cancelledAt && 
                                   !o.isRTO;

      if (isEligibleForRevenue) {
        profile.validOrderCount += 1;
        const grossValue = Number(o.orderValue || 0);
        const refundedAmount = Number(o.totalRefundedAmount || 0); 
        const netValue = grossValue - refundedAmount;
        profile.totalSpend += netValue;
      }
    });

    // CALL THE HELPER FUNCTION HERE
    const { segment, riskReasons } = calculateRiskSegment(profile);

   
    await prisma.zippyy_buyer_profile.upsert({
      where: { shop_buyerIdentifier: { shop, buyerIdentifier } },
      update: { 
        ...profile, buyerSegment: segment, riskReasons: riskReasons, customerEmail: safeEmail, customerPhone: safePhone, customerId: safeCustId,
        firstName: safeFirstName, lastName: safeLastName
      },
      create: { 
        shop, buyerIdentifier, ...profile, buyerSegment: segment, riskReasons: riskReasons, customerEmail: safeEmail, customerPhone: safePhone, customerId: safeCustId,
        firstName: safeFirstName, lastName: safeLastName
      }
    });

    console.log(` [PROFILE UPDATER] Successfully updated profile for ${buyerIdentifier}`);
  } catch (error) {
    console.error("[PROFILE UPDATER ERROR]:", error);
  }
}

/* ================= 1. HELPER: SEGMENTATION BRAIN (DRY) ================= */
export function calculateRiskSegment(profile) {
  let reasons = [];
  
  // 1. Ensure we are working with strictly numbers
  const total = Number(profile.totalCheckoutAttempts || profile.totalorderplaced) || 0;
  const rto = Number(profile.rtoCount) || 0;
  const cancelled = Number(profile.cancelledCount) || 0;
  const disputes = Number(profile.disputeCount) || 0;
  const unpaid = Number(profile.unpaidCount) || 0; 
  const cod = Number(profile.codCount) || 0;       
  const fulfilled = Number(profile.fulfilledCount) || 0;
  
  // 2. THE COD SAFETY NET (From Logic 1)
  let valid = Number(profile.validOrderCount) || 0; 
  valid = Math.max(valid, fulfilled); 

  // 3. SCALABLE RATES (From Logic 2)
  const rtoRate = total > 0 ? rto / total : 0;
  const cancelRate = total > 0 ? cancelled / total : 0;
  const codRate = total > 0 ? cod / total : 0;

  // 4. EXPLICIT BEHAVIORAL FLAGS (For the UI to display)
  if (disputes > 0) reasons.push("Payment Dispute");
  if (rto >= 2 && rtoRate >= 0.2) reasons.push("Frequent RTO");
  if (cancelled >= 3 && cancelRate >= 0.4) reasons.push("High Cancellation Rate");
  if (total >= 5 && valid === 0) reasons.push("Spam/Bot Behavior");
  if (cod >= 3 && codRate >= 0.8 && valid === 0) reasons.push("High COD Abuse Risk");

  // 5. THE MATHEMATICAL ENGINE
  let segment = "New";

  if (total > 0) {
    const successScore = valid * 1.0;
    const cancelPenalty = cancelled * 1.0;
    const unpaidPenalty = unpaid * 0.5; 
    const rtoPenalty = rto * 2.0;       
    const disputePenalty = disputes * 5.0; 

    const rawScore = successScore - cancelPenalty - unpaidPenalty - rtoPenalty - disputePenalty;
    const trustIndex = rawScore / total;

    // Apply the Mathematical Tiers
    if (trustIndex < 0) {
      const hasSevereOffense = rto > 0 || disputes > 0; 
      
      if (hasSevereOffense || cancelled >= 2 || unpaid >= 3) {
        segment = "High Risk";
        if (reasons.length === 0) reasons.push(`High-Risk Individual`);
      } else {
        segment = "Watchlist";
        if (reasons.length === 0) reasons.push("Needs Monitoring (Negative Score)");
      }
    } 
    else if (trustIndex >= 0.75 && valid >= 2) {
      segment = "VIP";
    } 
    else if (trustIndex >= 0.30 && valid >= 1) {
      segment = "Repeat Buyer";
    } 
    else if (trustIndex >= 0.0 && trustIndex < 0.30 && total > 1) {
      segment = "Watchlist";
    }
  }

  return { 
    segment: segment, 
    riskReasons: reasons.length > 0 ? reasons.join(", ") : null 
  };
}









// /* ================= 2. BULK PROFILE BUILDER ================= */
// export async function buildHistoricalBuyerProfiles(shop) {
//   console.log(`[BULK SYNC] Starting historical profile aggregation for ${shop}...`);

//   // Wipe the slate clean before rebuilding to clear ghost profiles
//   await prisma.zippyy_buyer_profile.deleteMany({ where: { shop } });

//   const allOrders = await prisma.shopify_store_order.findMany({
//     where: { shop },
//     orderBy: { createdAt: "asc" } 
//   });

//   const identityMap = new Map();
//   allOrders.forEach(order => {
//     if (order.customerId) {
//       if (!identityMap.has(order.customerId)) {
//         identityMap.set(order.customerId, { email: null, phone: null });
//       }
//       const idRecord = identityMap.get(order.customerId);
//       if (order.customerEmail && !idRecord.email) idRecord.email = order.customerEmail.trim().toLowerCase();
//       if (order.customerPhone && !idRecord.phone) idRecord.phone = order.customerPhone.trim();
//     }
//   });

//   const customerMap = new Map();

//   allOrders.forEach((order) => {
//     let safeEmail = order.customerEmail?.trim().toLowerCase() || null;
//     let safePhone = order.customerPhone?.trim() || null;
//     const safeCustId = order.customerId?.trim() || null;

//     if (safeCustId && identityMap.has(safeCustId)) {
//       const enriched = identityMap.get(safeCustId);
//       safeEmail = safeEmail || enriched.email;
//       safePhone = safePhone || enriched.phone;
//     }

//     const buyerIdentifier = safeEmail || safePhone || safeCustId || `guest-${order.shopifyOrderId}`;

//     if (!customerMap.has(buyerIdentifier)) {
//       customerMap.set(buyerIdentifier, {
//         buyerIdentifier,
//         customerEmail: safeEmail,
//         customerPhone: safePhone,
//         customerId: safeCustId,
//         totalCheckoutAttempts: 0,
//         validOrderCount: 0,
//         totalSpend: 0,
//         fulfilledCount: 0,
//         cancelledCount: 0,
//         rtoCount: 0,
//         codCount: 0,
//         unpaidCount: 0,
//         disputeCount: 0,
//         refundCount: 0,
//       });
//     }

//     const profile = customerMap.get(buyerIdentifier);
//     profile.totalCheckoutAttempts += 1;

//     const fStatus = order.financialStatus?.toUpperCase();
//     const fulfillment = order.fulfillmentStatus?.toUpperCase();
//     const isCod = order.paymentGateway?.toLowerCase().includes("cod") || order.paymentGateway?.toLowerCase().includes("cash");
    
//     if (isCod) profile.codCount += 1;
//     if (order.hasDispute) profile.disputeCount += 1;

//     // --- LOGISTICS TRACKING (Correct Priority) ---
//     if (order.cancelledAt || fulfillment === "CANCELLED") {
//       profile.cancelledCount += 1;
//     } else if (order.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") {
//       profile.rtoCount += 1;
//     } else if (fulfillment === "FULFILLED") {
//       profile.fulfilledCount += 1;
//     }

//     if (fStatus === "PENDING") profile.unpaidCount += 1;
//     else if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") profile.refundCount += 1;

//     // Valid Order Gatekeeper
//     const isClean = !order.cancelledAt && !(order.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !order.hasDispute;
//     if (fStatus === "PAID" && fulfillment === "FULFILLED" && isClean) {
//       profile.validOrderCount += 1;
//       profile.totalSpend += Number(order.orderValue || 0);
//     }
//   });

//   for (const [identifier, profile] of customerMap.entries()) {
    
//     // CALL THE HELPER FUNCTION HERE
//     const { segment, riskReasons } = calculateRiskSegment(profile);

//     try {
//       await prisma.zippyy_buyer_profile.upsert({
//         where: { shop_buyerIdentifier: { shop, buyerIdentifier: identifier } },
//         update: { ...profile, buyerSegment: segment, riskReasons: riskReasons },
//         create: { shop, ...profile, buyerSegment: segment, riskReasons: riskReasons }
//       });
//     } catch (err) {
//       console.error(`[BULK ERROR]`, err.message);
//     }
//   }
// }

// /* ================= 3. SINGLE PROFILE UPDATER (WEBHOOKS) ================= */
// export async function updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid) {
//   try {
//     let safeEmail = customerEmail?.trim().toLowerCase() || null;
//     let safePhone = customerPhone?.trim() || null;
//     const safeCustId = customerId?.trim() || null;

//     if (safeCustId && (!safeEmail || !safePhone)) {
//       const existingProfile = await prisma.zippyy_buyer_profile.findFirst({
//         where: { shop, customerId: safeCustId }
//       });
//       if (existingProfile) {
//         safeEmail = safeEmail || existingProfile.customerEmail;
//         safePhone = safePhone || existingProfile.customerPhone;
//       }
//     }

//     const buyerIdentifier = safeEmail || safePhone || safeCustId || `guest-${orderGid}`;

//     const allCustomerOrders = await prisma.shopify_store_order.findMany({
//       where: {
//         shop,
//         OR: [
//           safeEmail ? { customerEmail: safeEmail } : undefined,
//           safeCustId ? { customerId: safeCustId } : undefined,
//           safePhone ? { customerPhone: safePhone } : undefined,
//           { shopifyOrderId: `gid://shopify/Order/${orderGid}` },
//           { shopifyOrderId: orderGid }
//         ].filter(Boolean)
//       }
//     });

//     let profile = {
//       totalCheckoutAttempts: allCustomerOrders.length,
//       validOrderCount: 0,
//       totalSpend: 0,
//       fulfilledCount: 0,
//       cancelledCount: 0,
//       rtoCount: 0,
//       codCount: 0,
//       unpaidCount: 0,
//       disputeCount: 0,
//       refundCount: 0,
//     };
    
//     allCustomerOrders.forEach(o => {
//       const fStatus = o.financialStatus?.toUpperCase();
//       const fulfillment = o.fulfillmentStatus?.toUpperCase();
//       const isCod = o.paymentGateway?.toLowerCase().includes("cod") || o.paymentGateway?.toLowerCase().includes("cash");
      
//       if (isCod) profile.codCount += 1;
//       if (o.hasDispute) profile.disputeCount += 1;

//       // Logistics Tracking
//       if (o.cancelledAt || fulfillment === "CANCELLED") {
//         profile.cancelledCount += 1;
//       } else if (o.isRTO || fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED") {
//         profile.rtoCount += 1;
//       } else if (fulfillment === "FULFILLED" ||fulfillment === "SUCCESS"  || fulfillment === "DELIVERED") {
//         profile.fulfilledCount += 1;
//       }
     
//       if (fStatus === "PENDING") profile.unpaidCount += 1;
      
//       if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") {
//         profile.refundCount += 1;
//       }

//       // --- NET REVENUE GATEKEEPER ---
//       const isEligibleForRevenue = (fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && 
//                                    (fulfillment === "FULFILLED" || fulfillment === "SUCCESS" || fulfillment === "DELIVERED") && 
//                                    !o.hasDispute && 
//                                    !o.cancelledAt && 
//                                    !o.isRTO;

//       if (isEligibleForRevenue) {
//         profile.validOrderCount += 1;
//         const grossValue = Number(o.orderValue || 0);
//         const refundedAmount = Number(o.totalRefundedAmount || 0); 
//         const netValue = grossValue - refundedAmount;
//         profile.totalSpend += netValue;
//       }
//     });

//     // CALL THE HELPER FUNCTION HERE
//     const { segment, riskReasons } = calculateRiskSegment(profile);

//     await prisma.zippyy_buyer_profile.upsert({
//       where: { shop_buyerIdentifier: { shop, buyerIdentifier } },
//       update: { ...profile, buyerSegment: segment, riskReasons: riskReasons, customerEmail: safeEmail, customerPhone: safePhone, customerId: safeCustId },
//       create: { shop, buyerIdentifier, ...profile, buyerSegment: segment, riskReasons: riskReasons, customerEmail: safeEmail, customerPhone: safePhone, customerId: safeCustId }
//     });

//     console.log(` [PROFILE UPDATER] Successfully updated profile for ${buyerIdentifier}`);
//   } catch (error) {
//     console.error("[PROFILE UPDATER ERROR]:", error);
//   }
// }









