
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session, cors } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const rawOrderId = url.searchParams.get("orderId");

  if (!rawOrderId) {
    return cors(Response.json({ error: "Missing orderId parameter" }, { status: 400 }));
  }
// Extract only the numeric part of the order ID to handle both formats
  const numericOrderId = rawOrderId.replace(/\D/g, ""); 


  console.log(` DEBUG SEARCH: Looking for Order ID [${numericOrderId}] on Shop [${shop}]`);
  
  //  temporary debug: Check if the order ID exists in any format in the database to rule out formatting issues
  const dbCheck = await prisma.shopify_store_order.findMany({
    where: { shopifyOrderId: { contains: numericOrderId } }
  });
  
  console.log(` DB CHECK: Found ${dbCheck.length} rows matching this ID across ALL shops.`);
  if (dbCheck.length > 0) {
    console.log(` DB ROW DETAILS -> Shop: [${dbCheck[0].shop}] | Saved ID: [${dbCheck[0].shopifyOrderId}]`);
  }
  

 
  try {
    // 1. Fetch the order AND its attached buyer profile in one single query!
    const order = await prisma.shopify_store_order.findFirst({
      where: { 
        shop: shop,
        shopifyOrderId: { contains: numericOrderId } 
      },
      include: {
        buyerProfile: true 
      }
    });

    if (!order) {
       console.log("DEBUG: Order not yet in DB. Forcing frontend retry...");
       return cors(Response.json({ error: "Order not yet processed" }, { status: 202 })); 
    }

    let profile = order.buyerProfile;

    // 2. FALLBACK: If the profile isn't directly linked, search by explicit email/ID
    if (!profile) {
      const safeEmail = order.customerEmail?.trim().toLowerCase();
      const safeCustId = order.customerId?.trim();
      const safePhone = order.customerPhone?.trim();

      const orConditions = [];
      if (safeEmail) orConditions.push({ customerEmail: safeEmail });
      if (safeCustId) orConditions.push({ customerId: safeCustId });
      if (safePhone) orConditions.push({ customerPhone: safePhone });

      if (orConditions.length > 0) {
         profile = await prisma.zippyy_buyer_profile.findFirst({
           where: {
              shop: shop,
              OR: orConditions
           }
         });
      }
    }

    console.log("DEBUG: Final Profile Found ->", profile !== null);

    // 3. If STILL no profile, they are genuinely a new customer
    if (!profile) {
      console.log("DEBUG: No profile found. Returning default 'New' profile.");
      return cors(Response.json({ 
        profile: {
          buyerSegment: "New",
          riskReasons: [],
          validOrderCount: 0,
          rtoCount: 0,
          cancelledCount: 0,
          disputeCount: 0,
          refundCount: 0,
          totalSpend: 0,
          totalorders: 0,
          codCount: 0,
          fulfilledCount: 0,
          unpaidCount: 0
        } 
      }));
    }

    // 4. Success! Return the real data!
    return cors(Response.json({
      profile: {
        buyerSegment: profile.buyerSegment || "New",
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