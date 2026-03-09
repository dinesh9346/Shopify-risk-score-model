import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  // 1. Authenticate the extension request
  const { session, cors } = await authenticate.admin(request);
  const { shop } = session;

  // 2. Extract and clean the orderId from the URL
  const url = new URL(request.url);
  const rawOrderId = url.searchParams.get("orderId");

  if (!rawOrderId) {
    return cors(Response.json({ error: "Missing orderId parameter" }, { status: 400 }));
  }

  // Shopify passes a GID (e.g., gid://shopify/Order/123456)
  const numericOrderId = rawOrderId.replace("gid://shopify/Order/", "");

  try {
    // 3. Find the current order to identify the customer
    const currentOrder = await prisma.shopify_store_order.findFirst({
      where: { 
        shop: shop,
        shopifyOrderId: { contains: numericOrderId } 
      }
    });

    // If we haven't synced this order yet or there's no customer attached, return null profile
    if (!currentOrder || (!currentOrder.customerEmail && !currentOrder.customerId)) {
      return cors(Response.json({ profile: null })); 
    }

    // 4. Fetch the complete history for this buyer
    const customerOrders = await prisma.shopify_store_order.findMany({
      where: {
        shop: shop,
        OR: [
          // Match by Email (primary) or Customer ID (secondary)
          ...(currentOrder.customerEmail ? [{ customerEmail: currentOrder.customerEmail }] : []),
          ...(currentOrder.customerId ? [{ customerId: currentOrder.customerId }] : []),
        ]
      }
    });

    // 5. Initialize the profile object
    let profile = {
      totalCheckoutAttempts: customerOrders.length,
      validOrderCount: 0,
      totalSpend: 0,
      fulfilledCount: 0,
      cancelledCount: 0,
      rtoCount: 0,
      codCount: 0,
      unpaidCount: 0,
      disputeCount: 0,
      refundCount: 0,
      buyerSegment: "New",
      riskReasons: []
    };

    // 6. Aggregate the data
    customerOrders.forEach(order => {
      const orderValue = Number(order.orderValue || 0);
      const isCod = order.paymentGateway?.toLowerCase().includes("cod") || order.paymentGateway?.toLowerCase().includes("cash");
      
      if (isCod) profile.codCount += 1;

      if (order.isRTO) {
        profile.rtoCount += 1;
      } else if (order.cancelledAt) {
        profile.cancelledCount += 1;
      } else if (order.fulfillmentStatus === "FULFILLED") {
        profile.fulfilledCount += 1;
      }

      if (order.financialStatus === "PENDING") {
        profile.unpaidCount += 1;
      } else if (order.financialStatus === "REFUNDED" || order.financialStatus === "PARTIALLY_REFUNDED") {
        profile.refundCount += 1;
      }

      if (order.hasDispute) {
        profile.disputeCount += 1;
      }

      const isPaid = order.financialStatus && order.financialStatus.toUpperCase() === "PAID";
      const isFulfilled = order.fulfillmentStatus && order.fulfillmentStatus.toUpperCase() === "FULFILLED";

      if (isPaid && isFulfilled && !order.hasDispute && !order.cancelledAt && !order.isRTO) {
        profile.validOrderCount += 1;
        profile.totalSpend += orderValue;
      }
    });

    // 7. Calculate Rates & Apply Risk Rules
    const total = profile.totalCheckoutAttempts;
    const cancelRate = total > 0 ? profile.cancelledCount / total : 0;
    const rtoRate = total > 0 ? profile.rtoCount / total : 0;
    const codRate = total > 0 ? profile.codCount / total : 0;
    const refundRate = total > 0 ? profile.refundCount / total : 0;

    if (profile.disputeCount > 0) profile.riskReasons.push("Dispute History");
    if (profile.rtoCount >= 2 && rtoRate >= 0.3) profile.riskReasons.push("Heavy RTO");
    if (profile.cancelledCount >= 3 && cancelRate >= 0.4) profile.riskReasons.push("Heavy Cancellations");
    if (profile.refundCount >= 2 && refundRate >= 0.3) profile.riskReasons.push("Heavy Refunds");
    if (codRate >= 0.6 && profile.fulfilledCount === 0 && total >= 2) profile.riskReasons.push("COD Abuse (No Deliveries)");
    if (total >= 10 && profile.validOrderCount === 0) profile.riskReasons.push("Serial Abandoner (Bot/Fraud)");
    if (profile.cancelledCount >= 10) profile.riskReasons.push("High Cancellation Volume");
    if (profile.refundCount >= 5) profile.riskReasons.push("High Refund Volume");

    // 8. Assign Final Segment
    if (profile.riskReasons.length > 0) {
      profile.buyerSegment = "High Risk";
    } else if (profile.validOrderCount >= 3) {
      profile.buyerSegment = "VIP";
    } else if (profile.validOrderCount === 2) {
      profile.buyerSegment = "Repeat Buyer";
    }

    // 9. Return the populated profile using the standard Web Response API
    return cors(Response.json({ profile }));

  } catch (error) {
    console.error("API Error - Failed to fetch buyer profile:", error);
    return cors(Response.json({ error: "Internal Server Error" }, { status: 500 }));
  }
};

// import { json } from "@react-router";
// import { authenticate } from "../shopify.server";
// import prisma from "../db.server";

// export const loader = async ({ request }) => {
//   // 1. Authenticate the Session Token sent by the UI Extension
//   const { session, cors } = await authenticate.admin(request);
//   const shop = session.shop;

//   const url = new URL(request.url);
//   const rawOrderId = url.searchParams.get("orderId");

//   if (!rawOrderId) {
//     return cors(json({ error: "Missing orderId" }, { status: 400 }));
//   }

//   // Ensure we just have the numeric part if a GID was passed
//   const numericOrderId = rawOrderId.replace("gid://shopify/Order/", "");

//   try {
//     // 2. Find the order in your database using the shopifyOrderId
//     const currentOrder = await prisma.shopify_store_order.findFirst({
//       where: { 
//         shop: shop,
//         // Using contains just in case you stored it with or without the gid prefix
//         shopifyOrderId: { contains: numericOrderId } 
//       }
//     });

//     if (!currentOrder) {
//       return cors(json({ profile: null })); 
//     }

//     // 3. Find all historical orders for this specific customer to build their profile

//     const customerOrders = await prisma.shopify_store_order.findMany({
//       where: {
//         shop: shop,
//         customerEmail: currentOrder.customerEmail, // Or customerId
//       }
//     });

   
//     let profile = {
//       totalCheckoutAttempts: customerOrders.length,
//       validOrderCount: 0,
//       totalSpend: 0,
//       fulfilledCount: 0,
//       cancelledCount: 0,
//       rtoCount: 0,
//       codCount: 0,
//       unpaidCount: 0,
//       disputeCount: 0,
//       refundCount: 0,
//       buyerSegment: "New",
//       riskReasons: []
//     };

//     customerOrders.forEach(order => {
//       const orderValue = Number(order.orderValue || 0);
//       const isCod = order.paymentGateway?.toLowerCase().includes("cod") || order.paymentGateway?.toLowerCase().includes("cash");
      
//       if (isCod) profile.codCount += 1;
//       if (order.isRTO) profile.rtoCount += 1;
//       else if (order.cancelledAt) profile.cancelledCount += 1;
//       else if (order.fulfillmentStatus === "FULFILLED") profile.fulfilledCount += 1;

//       if (order.financialStatus === "PENDING") profile.unpaidCount += 1;
//       else if (order.financialStatus === "REFUNDED" || order.financialStatus === "PARTIALLY_REFUNDED") profile.refundCount += 1;

//       if (order.hasDispute) profile.disputeCount += 1;

//       const isPaid = order.financialStatus && order.financialStatus.toUpperCase() === "PAID";
//       const isFulfilled = order.fulfillmentStatus && order.fulfillmentStatus.toUpperCase() === "FULFILLED";

//       if (isPaid && isFulfilled && !order.hasDispute && !order.cancelledAt && !order.isRTO) {
//         profile.validOrderCount += 1;
//         profile.totalSpend += orderValue;
//       }
//     });

//     // 5. Apply Risk Rules 
//     if (profile.disputeCount > 0) profile.riskReasons.push("Dispute History");
//     if (profile.rtoCount >= 2 && (profile.rtoCount / profile.totalCheckoutAttempts) >= 0.3) profile.riskReasons.push("Heavy RTO");
//     if (profile.cancelledCount >= 10) profile.riskReasons.push("High Cancellation Volume");

//     if (profile.riskReasons.length > 0) {
//       profile.buyerSegment = "High Risk";
//     } else if (profile.validOrderCount >= 3) {
//       profile.buyerSegment = "VIP";
//     } else if (profile.validOrderCount === 2) {
//       profile.buyerSegment = "Repeat Buyer";
//     }

//     // 6. Return the data to the UI extension
//     return cors(json({ profile }));

//   } catch (error) {
//     console.error("Failed to fetch buyer profile API:", error);
//     return cors(json({ error: "Internal Server Error" }, { status: 500 }));
//   }
// };