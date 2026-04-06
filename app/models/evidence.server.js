import prisma from "../db.server.js";
import { PDFCompiler } from "./pdfCompiler.server.js";

export async function compileDisputeEvidence(shop, shopifyDisputeId) {
  console.log(`[Evidence Engine] Initiating strategic compilation for dispute ${shopifyDisputeId}`);

  try {
    // 1. FETCH BASE DISPUTE AND ORDER DATA
    const disputeRecord = await prisma.shopify_dispute.findUnique({
      where: { shop_shopifyDisputeId: { shop, shopifyDisputeId } },
      include: {
        order: {
          include: { buyerProfile: true }
        }
      }
    });

    if (!disputeRecord || !disputeRecord.order) {
      throw new Error(`Dispute ${shopifyDisputeId} or related order not found in database.`);
    }

    const order = disputeRecord.order;
    const reasonCode = (disputeRecord.reason || "").toLowerCase();

    const normalizeValue = (value) => {
      if (value === null || value === undefined) return value;
      if (typeof value === "object" && typeof value.toString === "function") {
        return value.toString();
      }
      return value;
    };

    // 2. FALLBACK PROFILE FETCH
    let profile = order.buyerProfile;
    if (!profile && (order.customerEmail || order.customerPhone || order.customerId)) {
      profile = await prisma.zippyy_buyer_profile.findFirst({
        where: {
          shop,
          OR: [
            order.customerEmail ? { customerEmail: order.customerEmail } : undefined,
            order.customerPhone ? { customerPhone: order.customerPhone } : undefined,
            order.customerId ? { customerId: order.customerId } : undefined
          ].filter(Boolean)
        }
      });
    }

    // 3. HISTORICAL DATA MINING (The Incumbent Gap Filler)
    let pastOrders = [];
    if (order.customerEmail || order.customerId) {
      pastOrders = await prisma.shopify_store_order.findMany({
        where: {
          shop,
          OR: [
            order.customerEmail ? { customerEmail: order.customerEmail } : undefined,
            order.customerId ? { customerId: order.customerId } : undefined
          ].filter(Boolean),
          shopifyOrderId: { not: order.shopifyOrderId } // Exclude current
        },
        select: {
          id: true, createdAt: true, orderValue: true, trackingNumber: true, 
          shippingAddress1: true, ipAddress: true, hasDispute: true,
          financialStatus: true, fulfillmentStatus: true
        },
        orderBy: { createdAt: 'desc' }
      });
    }

    // 4. VISA COMPELLING EVIDENCE 3.0 (CE 3.0) ISOLATION
    // We explicitly hunt for undisputed orders between 120 and 365 days old.
    const now = new Date();
    const days120Ago = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000);
    const days365Ago = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const ce3QualifyingOrders = pastOrders.filter(po => 
      !po.hasDispute &&
      po.financialStatus === "PAID" &&
      po.fulfillmentStatus === "FULFILLED" &&
      po.createdAt <= days120Ago && 
      po.createdAt >= days365Ago &&
      (po.ipAddress === order.ipAddress || po.shippingAddress1 === order.shippingAddress1)
    );

    const meetsVisaCE3Criteria = ce3QualifyingOrders.length >= 2;

    // 5. VELOCITY & HOARDING DETECTION (Catching Serial Abuse)
    // Check for other orders placed within 48 hours of this disputed order
    const orderTime = new Date(order.createdAt).getTime();
    const velocityOrders = pastOrders.filter(po => {
      const poTime = new Date(po.createdAt).getTime();
      const diffHours = Math.abs(poTime - orderTime) / (1000 * 60 * 60);
      return diffHours <= 48;
    });

    const isVelocityAbuse = velocityOrders.length >= 3;

    // 6. DYNAMIC STRATEGY ENGINE
    // Dictates how the PDF layout should be structured based on the specific reason
    let defenseStrategy = "STANDARD";
    let strategicFocus = "";

    if (reasonCode.includes("fraud") || reasonCode.includes("unauthorized")) {
      defenseStrategy = "AUTHORIZATION_AND_IDENTITY";
      strategicFocus = "Prioritize AVS, CVV, IP matches, and historical device continuity. Push logistics to page 2.";
    } else if (reasonCode.includes("not_received") || reasonCode.includes("delivery")) {
      defenseStrategy = "LOGISTICS_AND_FULFILLMENT";
      strategicFocus = "Prioritize carrier tracking timeline, Address/AVS exact match mapping, and past delivery success to this address.";
    } else if (reasonCode.includes("unacceptable") || reasonCode.includes("defective")) {
      defenseStrategy = "PRODUCT_AND_POLICY";
      strategicFocus = "Prioritize product description match, terms of service screenshots, and lack of merchant contact prior to chargeback.";
    }

    // 7. FORMATTED DATA WRAPPERS
    const fullShippingAddress = [
      order.shippingAddress1, order.shippingAddress2, order.shippingCity, 
      order.shippingProvince, order.shippingZip, order.shippingCountry
    ].filter(Boolean).join(", ");

    const fullBillingAddress = [
      order.billingAddress1, order.billingAddress2, order.billingCity, 
      order.billingProvince, order.billingZip, order.billingCountry
    ].filter(Boolean).join(", ");

    const isExactAddressMatch = (fullShippingAddress.toLowerCase() === fullBillingAddress.toLowerCase()) && fullShippingAddress.length > 5;

    // SLA Countdown
    let daysRemaining = "Unknown";
    if (disputeRecord.evidenceDueBy) {
      const diffTime = Math.abs(new Date(disputeRecord.evidenceDueBy) - now);
      daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    // 8. ASSEMBLE THE MASTER PAYLOAD
    const evidencePayload = {
      meta: {
        shopDomain: shop,
        generatedAt: now.toISOString(),
        disputeDeadline: disputeRecord.evidenceDueBy,
        daysRemaining: daysRemaining,
        isUrgent: daysRemaining <= 3
      },
      disputeDetails: {
        disputeId: disputeRecord.shopifyDisputeId,
        status: disputeRecord.status || "unknown",
        reason: disputeRecord.reason || "unknown",
        amountContested: normalizeValue(disputeRecord.amount) || "unknown",
        currency: disputeRecord.currency || "unknown",
        evidenceDeadline: disputeRecord.evidenceDueBy,
        orderId: order.shopifyOrderId,
      },
      representmentStrategy: {
        reasonCodeCategory: reasonCode.toUpperCase(),
        recommendedLayout: defenseStrategy,
        strategicFocus: strategicFocus
      },
      targetedOrderDetails: {
        orderId: order.shopifyOrderId,
        datePlaced: order.createdAt,
        totalValue: `${normalizeValue(order.orderValue)} ${disputeRecord.currency}`,
        shippingAddress: fullShippingAddress,
        billingAddress: fullBillingAddress,
        isBillingShippingMatch: isExactAddressMatch ? "TRUE - Perfect Match" : "FALSE - Mismatch",
      },
     cryptographicAuthorization: {
        customerIP: order.ipAddress || "Not captured",
        paymentGateway: order.paymentGateway || "Unknown",
        requiresTransactionAPIFetch: true 
      },
      fulfillmentProof: {
        trackingNumber: order.trackingNumber || "Untracked",
        carrier: order.carrier || "Unknown",
        addressVerificationAPIResult: order.addressVerified ? "VALIDATED BY EXTERNAL LOGISTICS DB" : "UNCHECKED"
      },
      buyerBehavioralAnalysis: profile ? {
        buyerSegment: profile.buyerSegment,
        totalLifetimeOrders: profile.totalorders,
        historicalDisputeCount: profile.disputeCount,
        disputeRatio: `${Math.round((profile.disputeCount / profile.totalorders) * 100)}%`,
        networkFraudWarning: profile.fraudDisputeCount > 0 ? "YES - History of Fraud Claims" : "NO"
      } : null,
      friendlyFraudProof: {
        visaCE3Qualified: meetsVisaCE3Criteria,
        ce3EligibleOrders: ce3QualifyingOrders.map(po => ({
          datePlaced: po.createdAt,
          amountPaid: normalizeValue(po.orderValue),
          shippedToExactSameAddress: po.shippingAddress1 === order.shippingAddress1,
          purchasedFromExactSameIP: po.ipAddress === order.ipAddress
        })),
        velocityAbuseDetected: isVelocityAbuse,
        velocityOrderCount48hr: velocityOrders.length,
        allPastSuccessfulDeliveries: pastOrders
          .filter(po => po.fulfillmentStatus === "FULFILLED" && !po.hasDispute)
          .slice(0, 5)
          .map(po => ({
            datePlaced: po.createdAt,
            trackingNumber: po.trackingNumber || "Untracked"
          }))
      }
    };

    // 9. PDF COMPILER: ENFORCE DOCUMENT CONSTRAINTS (Mastercard 19 pages, Visa 2MB)
    const documentSizeEstimate = PDFCompiler.estimateDocumentSize(evidencePayload);
    let finalPayload = evidencePayload;

    // If document exceeds limits, apply truncation
    if (!documentSizeEstimate.mastercardCompliant || !documentSizeEstimate.visaCompliant) {
      console.log(`[PDF Compiler] Document exceeds limits. Applying truncation...`);
      const truncationResult = PDFCompiler.truncateNarrativeContent(evidencePayload);
      finalPayload = truncationResult.truncatedPayload;
      console.log(`[PDF Compiler] Reduced from ${truncationResult.originalSizeKB}KB to ${truncationResult.newSizeKB}KB`);
    }

    // 10. ATTACH COMPLIANCE METADATA
    finalPayload.complianceMetadata = {
      documentSizeEstimate: documentSizeEstimate,
      ocrOptimizedStyles: PDFCompiler.getOCROptimizedStyles(),
      complianceReport: PDFCompiler.generateComplianceReport(evidencePayload)
    };

    console.log(`[Evidence Engine] Payload generated. CE 3.0 Qualified: ${meetsVisaCE3Criteria} | Velocity Abuse: ${isVelocityAbuse}`);
    return finalPayload;

  } catch (error) {
    console.error("[Evidence Engine Error]:", error);
    throw error;
  }
}