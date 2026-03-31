// import { authenticate } from "../shopify.server";
// import prisma from "../db.server";

// // Helper: Discover the Buyer's True Identity using the exact same logic as Sync.server.js
// async function getUniversalIdentifier(shop, numericOrderId) {
//   const order = await prisma.shopify_store_order.findFirst({
//     where: { 
//       shop: shop,
//       shopifyOrderId: { contains: numericOrderId } 
//     }
//   });

//   if (!order) return null;

//   // FIX 1: Exact same normalization as your background sync (lowercase email!)
//   let safeEmail = order.customerEmail?.trim().toLowerCase() || null;
//   let safePhone = order.customerPhone?.trim() || null;
//   const safeCustId = order.customerId?.trim() || null;

//   // FIX 2: Identity Resolution
//   if (safeCustId && (!safeEmail || !safePhone)) {
//     const existingProfile = await prisma.zippyy_buyer_profile.findFirst({
//       where: { shop, customerId: safeCustId }
//     });
//     if (existingProfile) {
//       safeEmail = safeEmail || existingProfile.customerEmail;
//       safePhone = safePhone || existingProfile.customerPhone;
//     }
//   }

//   // FIX 3: Priority MUST be Email > Phone > ID to match the database exactly
//   // We use the full GID format for guests to stay consistent with the Sync logic
//   return safeEmail || safePhone || safeCustId || `guest-gid://shopify/Order/${numericOrderId}`;
// }

// export const loader = async ({ request }) => {
//   // CORS is essential for Admin UI Extensions to talk to your App
//   const { session, cors } = await authenticate.admin(request);
//   const { shop } = session;

//   const url = new URL(request.url);
//   const rawOrderId = url.searchParams.get("orderId");

//   if (!rawOrderId) {
//     return cors(Response.json({ error: "Missing orderId parameter" }, { status: 400 }));
//   }

//   // Clean the ID (handles both raw numbers and GIDs)
//   const numericOrderId = rawOrderId.replace("gid://shopify/Order/", "");

//   try {
//     const buyerIdentifier = await getUniversalIdentifier(shop, numericOrderId);

//     if (!buyerIdentifier) {
//        console.log(`[API] No order found in DB for ID: ${numericOrderId}`);
//        return cors(Response.json({ profile: null }));
//     }

//     // INSTANT FETCH: Grab the correct, up-to-date stats using the composite key
//     const profile = await prisma.zippyy_buyer_profile.findUnique({
//       where: { 
//         shop_buyerIdentifier: { 
//           shop: shop, 
//           buyerIdentifier: buyerIdentifier 
//         } 
//       },
//     });

//     if (!profile) {
//       console.log(`[API] No profile found for identifier: ${buyerIdentifier}`);
//       return cors(Response.json({ profile: null }));
//     }

//     // Return the clean profile object to the UI Extension
//     return cors(Response.json({
//       profile: {
//         buyerSegment: profile.buyerSegment,
//         // Send reasons as an array for easy mapping in the UI if needed later
//         riskReasons: profile.riskReasons ? profile.riskReasons.split(",").map(r => r.trim()).filter(Boolean) : [],
//         validOrderCount: profile.validOrderCount,
//         rtoCount: profile.rtoCount,
//         cancelledCount: profile.cancelledCount,
//         disputeCount: profile.disputeCount,
//         refundCount: profile.refundCount,
//         totalSpend: profile.totalSpend,
//         totalordersoutAttempts,
//         codCount: profile.codCount,
//         fulfilledCount: profile.fulfilledCount,
//         unpaidCount: profile.unpaidCount
//       }
//     }));

//   } catch (error) {
//     console.error("API Error - Failed to fetch buyer profile:", error);
//     return cors(Response.json({ error: "Internal Server Error" }, { status: 500 }));
//   }
// };









import { authenticate } from "../shopify.server";
import prisma from "../db.server";


async function getUniversalIdentifier(shop, numericOrderId) {
  const order = await prisma.shopify_store_order.findFirst({
    where: { 
      shop: shop,
      shopifyOrderId: { contains: numericOrderId } 
    }
  });

  if (!order) return null;

  let safeEmail = order.customerEmail?.trim().toLowerCase() || null;
  let safePhone = order.customerPhone?.trim() || null;
  const safeCustId = order.customerId?.trim() || null;

  if (safeCustId && (!safeEmail || !safePhone)) {
    const existingProfile = await prisma.zippyy_buyer_profile.findFirst({
      where: { shop, customerId: safeCustId }
    });
    if (existingProfile) {
      safeEmail = safeEmail || existingProfile.customerEmail;
      safePhone = safePhone || existingProfile.customerPhone;
    }
  }

  return safeEmail || safePhone || safeCustId || `guest-gid://shopify/Order/${numericOrderId}`;
}

export const loader = async ({ request }) => {
  const { session, cors } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const rawOrderId = url.searchParams.get("orderId");

  if (!rawOrderId) {
    return cors(Response.json({ error: "Missing orderId parameter" }, { status: 400 }));
  }

  const numericOrderId = rawOrderId.replace("gid://shopify/Order/", "");

  try {
    const buyerIdentifier = await getUniversalIdentifier(shop, numericOrderId);

    if (!buyerIdentifier) {
       return cors(Response.json({ profile: null }));
    }

   
    const profile = await prisma.zippyy_buyer_profile.findUnique({
      where: { shop_buyerIdentifier: { shop, buyerIdentifier } },
    });

    if (!profile) {
      return cors(Response.json({ profile: null }));
    }

    return cors(Response.json({
      profile: {
        buyerSegment: profile.buyerSegment,
        riskReasons: profile.riskReasons ? profile.riskReasons.split(",").map(r => r.trim()).filter(Boolean) : [],
        validOrderCount: profile.validOrderCount,
        rtoCount: profile.rtoCount,
        cancelledCount: profile.cancelledCount,
        disputeCount: profile.disputeCount,
        refundCount: profile.refundCount,
        totalSpend: profile.totalSpend,
        totalorders: profile.totalorders,
        codCount: profile.codCount,
        fulfilledCount: profile.fulfilledCount,
        unpaidCount: profile.unpaidCount
      }
    }));

  } catch (error) {
    console.error("API Error - Failed to fetch buyer profile:", error);
    return cors(Response.json({ error: "Internal Server Error" }, { status: 500 }));
  }
};