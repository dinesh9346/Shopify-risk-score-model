
import prisma from "../db.server.js";

function isEligibleForRevenueOrder(fStatus, fulfillment, hasDispute, disputeCount, cancelledAt, isRTO) {
  const hasKnownDispute = hasDispute || disputeCount > 0;
  return (fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") &&
         (fulfillment === "FULFILLED" || fulfillment === "SUCCESS" || fulfillment === "DELIVERED") &&
         !hasKnownDispute &&
         !cancelledAt &&
         !isRTO;
}
// Add monthsBack as an optional parameter
export async function triggerBulkOrderSync(admin, shop, monthsBack = null) {
  console.log(`[BULK SYNC] Starting bulk order sync for ${shop}. Timeframe: ${monthsBack ? `${monthsBack} months` : 'All time'}`);

  // 1. Calculate the cutoff date if a timeframe is selected
  let queryFilter = "";
  if (monthsBack) {
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);
    // Format to ISO string which Shopify GraphQL expects
    const formattedDate = cutoffDate.toISOString(); 
    queryFilter = `(query: "created_at:>='${formattedDate}'")`;
  }

  try {
    const response = await admin.graphql(`
      mutation {
        bulkOperationRunQuery(
          query: """
          {
            # 2. Inject the query filter dynamically here
            orders${queryFilter} { 
              edges {
                node {
                  id
                  createdAt
                  email
                  clientIp
                  cancelledAt
                  displayFinancialStatus
                  displayFulfillmentStatus
                  paymentGatewayNames
                  tags
                  
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
                    address2
                    city
                    province
                    zip
                    countryCode
                    phone
                  }

                  billingAddress {
                    address1
                    address2
                    city
                    province
                    zip
                    countryCode
                  }
                  
                  lineItems {
                    edges {
                      node {
                        id
                        title
                        sku
                        quantity
                        originalTotalSet {
                          shopMoney {
                            amount
                          }
                        }
                      }
                    }
                  }
                  
                  fulfillments {
                    id
                    displayStatus
                    trackingInfo {
                      company
                      number
                      url
                    }
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
        identityMap.set(order.customerId, { email: null, phone: null, firstName: null, lastName: null });
      }
      const idRecord = identityMap.get(order.customerId);
      if (order.customerEmail && !idRecord.email) idRecord.email = order.customerEmail.trim().toLowerCase();
      if (order.customerPhone && !idRecord.phone) idRecord.phone = order.customerPhone.trim();
      
      if (order.firstName && !idRecord.firstName) idRecord.firstName = order.firstName.trim();
      if (order.lastName && !idRecord.lastName) idRecord.lastName = order.lastName.trim();
    }
  });

  const customerMap = new Map();

  const normalizeEmail = (email) => (email ? email.trim().toLowerCase() : null);
  const normalizePhone = (phone) => (phone ? phone.trim() : null);

  allOrders.forEach((order) => {
    let safeEmail = normalizeEmail(order.customerEmail);
    let safePhone = normalizePhone(order.customerPhone);
    const safeCustId = order.customerId?.trim() || null;

    let safeFirstName = order.firstName?.trim() || null;
    let safeLastName = order.lastName?.trim() || null;

    // Strict Identifier Hierarchy (No cross-merging)
    const buyerIdentifier = safeCustId || safeEmail || safePhone || `guest-${order.shopifyOrderId}`;

    if (!customerMap.has(buyerIdentifier)) {
      customerMap.set(buyerIdentifier, {
        buyerIdentifier,
        customerEmail: safeEmail,
        customerPhone: safePhone,
        customerId: safeCustId,
        firstName: safeFirstName,
        lastName: safeLastName,
        totalorders: 0,
        validOrderCount: 0,
        totalSpend: 0,
        fulfilledCount: 0,
        cancelledCount: 0,
        rtoCount: 0,
        codCount: 0,
        unpaidCount: 0,
        disputeCount: 0,
        refundCount: 0,
        orderIds: [] // Track which orders belong to this profile
      });
    }

    const profile = customerMap.get(buyerIdentifier);

    profile.customerEmail = profile.customerEmail || safeEmail;
    profile.customerPhone = profile.customerPhone || safePhone;
    profile.customerId = profile.customerId || safeCustId;
    profile.firstName = profile.firstName || safeFirstName;
    profile.lastName = profile.lastName || safeLastName;

    profile.totalorders += 1;
    profile.orderIds.push(order.id); // Save the order relation

    const fStatus = order.financialStatus?.toUpperCase();
    const fulfillment = order.fulfillmentStatus?.toUpperCase();
    const shipment = (order.shipmentStatus || "").toUpperCase();
    const isCod = order.paymentGateway?.toLowerCase().includes("cod") || order.paymentGateway?.toLowerCase().includes("cash");
    
    if (isCod) profile.codCount += 1;
    if (order.hasDispute || (order.disputes?.length || 0) > 0) profile.disputeCount += 1;

    if (fulfillment === "FULFILLED" || fulfillment === "SUCCESS") {
      profile.fulfilledCount += 1;
    }

    if (order.cancelledAt || fulfillment === "CANCELLED") {
      profile.cancelledCount += 1;
    } else if (
      order.isRTO || 
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
      profile.rtoCount += 1;
    }

    if (fStatus === "PENDING" && !isCod) profile.unpaidCount += 1;
    else if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") profile.refundCount += 1;

    const orderValue = Number(order.orderValue || 0);
    const isEligibleForRevenue = isEligibleForRevenueOrder(
      fStatus,
      fulfillment,
      order.hasDispute,
      order.disputes?.length || 0,
      order.cancelledAt,
      order.isRTO
    );

    if (isEligibleForRevenue) {
      profile.totalSpend += orderValue;
      profile.validOrderCount += 1;
    }
  });

  let batchPromises = [];
  let totalSaved = 0;

  for (const [identifier, profile] of customerMap.entries()) {
    const { segment, riskReasons } = calculateRiskSegment(profile);
    
    // Extract order IDs to use in the Prisma connect query
    const linkedOrders = profile.orderIds.map(id => ({ id }));
    
    // Remove the temporary orderIds array so it doesn't break the Prisma payload
    delete profile.orderIds;
    delete profile.buyerIdentifier; // Extracted to the 'where' clause

    batchPromises.push(
      prisma.zippyy_buyer_profile.upsert({
        where: { shop_buyerIdentifier: { shop, buyerIdentifier: identifier } },
        update: { 
          ...profile, 
          buyerSegment: segment, 
          riskReasons: riskReasons,
          orders: { connect: linkedOrders } // Automatically links orders!
        },
        create: { 
          shop, 
          buyerIdentifier: identifier, 
          ...profile, 
          buyerSegment: segment, 
          riskReasons: riskReasons,
          orders: { connect: linkedOrders } // Automatically links orders!
        }
      })
    );

    // Run in batches of 250 to avoid database timeouts
    if (batchPromises.length >= 250) {
      await prisma.$transaction(batchPromises);
      totalSaved += batchPromises.length;
      console.log(`[BULK] Saved ${totalSaved} buyer profiles...`);
      batchPromises = [];
    }
  }

  // Catch the remaining profiles
  if (batchPromises.length > 0) {
    await prisma.$transaction(batchPromises);
    totalSaved += batchPromises.length;
  }

  console.log(`[BULK COMPLETE] Total Buyer Profiles Built: ${totalSaved}`);
  
  // Now capture ML Training Data for historical terminal orders
  const { bulkCaptureMLTrainingData } = await import("./mlTrainingPipeline.server.js");
  await bulkCaptureMLTrainingData(shop);
}

/* ================= 3. SINGLE PROFILE UPDATER (WEBHOOKS) ================= */
export async function updateSingleBuyerProfile(shop, customerEmail, customerPhone, customerId, orderGid) {
  try {
    let safeEmail = customerEmail?.trim().toLowerCase() || null;
    let safePhone = customerPhone?.trim() || null;
    const safeCustId = customerId?.trim() || null;

    let safeFirstName = null;
    let safeLastName = null;

    // Strict Identifier Hierarchy
    let buyerIdentifier = safeCustId || safeEmail || safePhone || `guest-${orderGid}`;

    // 1. If a Shopify customerId is present, only reconcile against that stable identity.
    //    This prevents a new customer from merging into an old profile just because
    //    the email or phone was recycled later.
    let existingProfile = await prisma.zippyy_buyer_profile.findFirst({
      where: {
        shop,
        buyerIdentifier
      }
    });

    if (existingProfile) {
      safeEmail = safeEmail || existingProfile.customerEmail;
      safePhone = safePhone || existingProfile.customerPhone;
      safeFirstName = existingProfile.firstName || null;
      safeLastName = existingProfile.lastName || null;
    }

    // Restrict the query to only fetch orders belonging exactly to this identity
    const orderWhereClause = { shop, OR: [] };
    
    if (safeCustId) {
      orderWhereClause.OR.push({ customerId: safeCustId });
    } else if (safeEmail) {
      orderWhereClause.OR.push({ customerEmail: safeEmail, customerId: null });
    } else if (safePhone) {
      orderWhereClause.OR.push({ customerPhone: safePhone, customerId: null, customerEmail: null });
    }
    
    orderWhereClause.OR.push({ shopifyOrderId: `gid://shopify/Order/${orderGid}` });
    orderWhereClause.OR.push({ shopifyOrderId: orderGid });
    
    if (existingProfile) {
      orderWhereClause.OR.push({ buyerProfileId: existingProfile.id });
    }

    // Now fetch their order history...
    // CRITICAL UPDATE: We must include the related disputes from Phase 1
    const allCustomerOrders = await prisma.shopify_store_order.findMany({
      where: orderWhereClause,
      include: {
        disputes: true // Pulls the related records from shopify_dispute
      }
    });

    // Extract the best available name
    const orderWithName = allCustomerOrders.find(o => o.firstName || o.lastName);
    if (orderWithName) {
      safeFirstName = safeFirstName || orderWithName.firstName;
      safeLastName = safeLastName || orderWithName.lastName;
    }

    // Initialize all counters, including the new dispute vectors
    let profile = {
      totalorders: allCustomerOrders.length,
      validOrderCount: 0,
      totalSpend: 0,
      fulfilledCount: 0,
      cancelledCount: 0,
      rtoCount: 0,
      codCount: 0,
      unpaidCount: 0,
      disputeCount: 0,
      fraudDisputeCount: 0, // NEW
      wonDisputeCount: 0,   // NEW
      lostDisputeCount: 0,  // NEW
      refundCount: 0,
    };
    
    allCustomerOrders.forEach(o => {
      const fStatus = o.financialStatus?.toUpperCase();
      const fulfillment = o.fulfillmentStatus?.toUpperCase();
      const shipment = (o.shipmentStatus || "").toUpperCase();
      const isCod = o.paymentGateway?.toLowerCase().includes("cod") || o.paymentGateway?.toLowerCase().includes("cash");
      
      if (isCod) profile.codCount += 1;
      
      // Fallback for legacy boolean check
      if (o.hasDispute || (o.disputes?.length || 0) > 0) {
        profile.disputeCount += 1;
      }

      // NEW: Granular Dispute Tallying
      if (o.disputes && o.disputes.length > 0) {
        o.disputes.forEach(dispute => {
          profile.disputeCount += 1; // Increment total known disputes

          const reasonStr = (dispute.reason || "").toLowerCase();
          const statusStr = (dispute.status || "").toLowerCase();

          if (reasonStr === "fraudulent") {
            profile.fraudDisputeCount += 1;
          }

          if (statusStr === "won") {
            profile.wonDisputeCount += 1;
          } else if (statusStr === "lost" || statusStr === "charge_refunded") {
            // Shopify sometimes classifies a lost dispute simply as 'charge_refunded'
            profile.lostDisputeCount += 1;
          }
        });
      }

      // Logistics Tracking
      if (o.cancelledAt || fulfillment === "CANCELLED") {
        profile.cancelledCount += 1;
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
        profile.rtoCount += 1;
      } else if (fulfillment === "FULFILLED" || fulfillment === "SUCCESS" || fulfillment === "DELIVERED") {
        profile.fulfilledCount += 1;
      }
      
      if (fStatus === "PENDING" && !isCod) profile.unpaidCount += 1;
      
      if (fStatus === "REFUNDED" || fStatus === "PARTIALLY_REFUNDED") {
        profile.refundCount += 1;
      }

      const orderValue = Number(o.orderValue || 0);
      const isEligibleForRevenue = isEligibleForRevenueOrder(
        fStatus,
        fulfillment,
        o.hasDispute,
        o.disputes?.length || 0,
        o.cancelledAt,
        o.isRTO
      );

      if (isEligibleForRevenue) {
        profile.totalSpend += orderValue;
        profile.validOrderCount += 1;
      }
    });

    // CALL THE HELPER FUNCTION HERE (Ensure your calculateRiskSegment is aware of these new fields if needed)
    const { segment, riskReasons } = calculateRiskSegment(profile);

    await prisma.zippyy_buyer_profile.upsert({
      where: { shop_buyerIdentifier: { shop, buyerIdentifier } },
      update: { 
        ...profile, 
        buyerSegment: segment, 
        riskReasons: riskReasons, 
        customerEmail: safeEmail, 
        customerPhone: safePhone, 
        customerId: safeCustId,
        firstName: safeFirstName, 
        lastName: safeLastName,
        orders: { connect: allCustomerOrders.map(o => ({ id: o.id })) }
      },
      create: { 
        shop, 
        buyerIdentifier, 
        ...profile, 
        buyerSegment: segment, 
        riskReasons: riskReasons, 
        customerEmail: safeEmail, 
        customerPhone: safePhone, 
        customerId: safeCustId,
        firstName: safeFirstName, 
        lastName: safeLastName,
        orders: { connect: allCustomerOrders.map(o => ({ id: o.id })) }
      }
    });

    console.log(` [PROFILE UPDATER] Successfully updated profile for ${buyerIdentifier}`);
  } catch (error) {
    console.error("[PROFILE UPDATER ERROR]:", error);
  }
}


/* ================= 1. HELPER: SEGMENTATION BRAIN (DRY) ================= */
const SEGMENT_WEIGHTS = {
  cancelWeight: 35,
  disputeWeight: 50,
  rtoWeight: 35,
  abandonWeight: 25,
  refundWeight: 25,
  pendingPaymentPenalty: 20,
  codAbuseWeight: 20,
  loyaltyBonus: 5,
  highCancelBonusPenalty: 20,
  medCancelBonusPenalty: 10,
  highRtoBonusPenalty: 15,
  extremeAbandonPenalty: 35,
  highAbandonPenalty: 20,
  fraudDisputePenalty: 100,
  openDisputePenalty: 40,
  wonDisputePenalty: 15
};

export function calculateRiskSegment(profile) {
  const reasons = [];

  const total = Number(profile.totalorders || profile.totalorderplaced) || 0;
  const rto = Number(profile.rtoCount) || 0;
  const cancelled = Number(profile.cancelledCount) || 0;
  const disputes = Number(profile.disputeCount) || 0;
  const unpaid = Number(profile.unpaidCount) || 0;
  const cod = Number(profile.codCount) || 0;
  const refund = Number(profile.refundCount) || 0;
  const fulfilled = Number(profile.fulfilledCount) || 0;
  const valid = Number(profile.validOrderCount) || 0;
  const fraudDisputes = Number(profile.fraudDisputeCount) || 0;
  const wonDisputes = Number(profile.wonDisputeCount) || 0;
  const lostDisputes = Number(profile.lostDisputeCount) || 0;

  if (total === 0) {
    return {
      segment: "New",
      riskReasons: "New Customer (no order history)"
    };
  }

  const cancelRate = total > 0 ? cancelled / total : 0;
  const rtoRate = total > 0 ? rto / total : 0;
  const disputeRate = total > 0 ? disputes / total : 0;
  const refundRate = total > 0 ? refund / total : 0;
  const unpaidRate = total > 0 ? unpaid / total : 0;
  const codRate = total > 0 ? cod / total : 0;
  const successRate = total > 0 ? valid / total : 0;

  let riskScore = 0;

  if (fraudDisputes > 0) {
    riskScore += SEGMENT_WEIGHTS.fraudDisputePenalty;
    reasons.push("Known fraud dispute history");
  }

  if (disputes > 0) {
    riskScore += SEGMENT_WEIGHTS.openDisputePenalty;
    reasons.push("Dispute history detected");
  }

  if (lostDisputes > 0) {
    riskScore += Math.round(disputeRate * SEGMENT_WEIGHTS.disputeWeight);
    reasons.push(`Lost dispute history (${lostDisputes})`);
  }

  if (wonDisputes > 0 && lostDisputes === 0) {
    riskScore += SEGMENT_WEIGHTS.wonDisputePenalty;
    reasons.push("High chargeback friction buyer");
  }

  if (cancelled > 0) {
    let cancelRisk = Math.round(cancelRate * SEGMENT_WEIGHTS.cancelWeight);
    if (cancelled >= 10) cancelRisk += SEGMENT_WEIGHTS.highCancelBonusPenalty;
    else if (cancelled >= 5) cancelRisk += SEGMENT_WEIGHTS.medCancelBonusPenalty;
    riskScore += cancelRisk;
    reasons.push(`Cancellation history: ${cancelled} orders`);
  }

  if (rto > 0) {
    let rtoRisk = Math.round(rtoRate * SEGMENT_WEIGHTS.rtoWeight);
    if (rto >= 5) rtoRisk += SEGMENT_WEIGHTS.highRtoBonusPenalty;
    riskScore += rtoRisk;
    reasons.push(`RTO history: ${rto} orders`);
  }

  if (total >= 5 && successRate <= 0.20) {
    let abandonRisk = Math.round((1 - successRate) * SEGMENT_WEIGHTS.abandonWeight);
    if (total >= 20 && valid <= 1) abandonRisk += SEGMENT_WEIGHTS.extremeAbandonPenalty;
    else if (total >= 10 && valid === 0) abandonRisk += SEGMENT_WEIGHTS.highAbandonPenalty;
    riskScore += abandonRisk;
    reasons.push(`Low success rate: ${Math.round(successRate * 100)}%`);
  }

  if (refund > 0) {
    riskScore += Math.round(refundRate * SEGMENT_WEIGHTS.refundWeight);
    reasons.push(`Refund history: ${refund} orders`);
  }

  if (codRate >= 0.7 && rto >= 1 && total >= 3) {
    riskScore += Math.round(codRate * SEGMENT_WEIGHTS.codAbuseWeight);
    reasons.push("COD abuse suspicion");
  }

  if (unpaid > 0) {
    riskScore += Math.round(unpaidRate * SEGMENT_WEIGHTS.pendingPaymentPenalty);
    reasons.push(`Pending payment history: ${unpaid} orders`);
  }

  if (valid >= 3) {
    const loyaltyDiscount = Math.min(30, valid * SEGMENT_WEIGHTS.loyaltyBonus);
    riskScore -= loyaltyDiscount;
    reasons.push(`Loyal buyer: ${valid} clean orders`);
  }

  riskScore = Math.max(0, Math.min(100, riskScore));

  const trustRatio = total > 0 ? valid / total : 0;
  const poorPerformanceRate = cancelRate + rtoRate + refundRate + unpaidRate;
  const isLowSuccessLargeProfile = total >= 10 && valid <= 1;
  const isHighRiskBySuccess = total >= 5 && trustRatio < 0.08;

  let segment = "Watchlist";

  if (valid >= 5 && cancelRate < 0.05 && rtoRate < 0.05 && disputes === 0 && refundRate < 0.05 && unpaidRate < 0.20) {
    segment = "VIP";
  } else if (isLowSuccessLargeProfile || riskScore >= 70 || isHighRiskBySuccess) {
    segment = "High Risk";
  } else if (valid >= 3 && trustRatio >= 0.35 && poorPerformanceRate < 0.45) {
    segment = "Repeat Buyer";
  } else if (valid >= 2 && trustRatio >= 0.25 && poorPerformanceRate < 0.55) {
    segment = "Repeat Buyer";
  } else {
    segment = "Watchlist";
  }

  if (segment === "Watchlist" && total === 1 && valid === 0 && riskScore < 20) {
    segment = "Watchlist";
  }

  return {
    segment,
    riskReasons: reasons.length > 0 ? reasons.join(", ") : null
  };
}







