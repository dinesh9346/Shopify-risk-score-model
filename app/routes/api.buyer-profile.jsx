import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  // --- CORS PREFLIGHT BYPASS ---
  // Shopify's authenticate.admin() strict mode returns 410 for OPTIONS requests 
  // because they lack the Authorization header. We must intercept OPTIONS 
  // at the very top of the loader to return our own CORS headers.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, ngrok-skip-browser-warning",
      },
    });
  }

  // 1. Authenticate and get the built-in CORS helper
  const { session, cors, admin } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const rawOrderId = url.searchParams.get("orderId");

  if (!rawOrderId) {
    return cors(Response.json({ error: "Missing orderId parameter" }, { status: 400 }));
  }
  
  // Extract only the numeric part of the order ID to handle both formats
  const numericOrderId = rawOrderId.replace(/\D/g, ""); 

  console.log(` DEBUG SEARCH: Looking for Order ID [${numericOrderId}] on Shop [${shop}]`);
  
  // temporary debug: Check if the order ID exists in any format in the database to rule out formatting issues
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
      console.log(`DEBUG: Order ${numericOrderId} not in local DB. Querying Shopify GraphQL...`);
      let customerEmail = null;
      let customerPhone = null;
      let customerId = null;

      try {
        const graphqlQuery = `
          query {
            order(id: "gid://shopify/Order/${numericOrderId}") {
              customer {
                id
                email
                phone
              }
              email
              phone
            }
          }
        `;
        const response = await admin.graphql(graphqlQuery);
        const json = await response.json();
        const orderData = json.data?.order;
        
        if (orderData) {
          customerEmail = orderData.customer?.email || orderData.email;
          customerPhone = orderData.customer?.phone || orderData.phone;
          if (orderData.customer?.id) {
            customerId = String(orderData.customer.id).replace(/\D/g, "");
          }
        }
      } catch (err) {
        console.error("DEBUG: GraphQL query failed:", err);
      }

      // If we found customer info from Shopify, try to find the profile
      const safeEmail = customerEmail?.trim().toLowerCase();
      const safeCustId = customerId?.trim();
      const safePhone = customerPhone?.trim();

      const orConditions = [];
      if (safeEmail) orConditions.push({ customerEmail: safeEmail });
      if (safeCustId) orConditions.push({ customerId: safeCustId });
      if (safePhone) orConditions.push({ customerPhone: safePhone });

      let fallbackProfile = null;
      if (orConditions.length > 0) {
         fallbackProfile = await prisma.zippyy_buyer_profile.findFirst({
           where: {
              shop: shop,
              OR: orConditions
           }
         });
      }

      if (!fallbackProfile) {
        console.log("DEBUG: No profile found via GraphQL fallback. Returning default 'New' profile.");
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

      // If we DID find a profile via GraphQL fallback:
      return cors(Response.json({
        profile: {
          buyerSegment: fallbackProfile.buyerSegment || "New",
          riskReasons: fallbackProfile.riskReasons ? fallbackProfile.riskReasons.split(",").map(r => r.trim()).filter(Boolean) : [],
          validOrderCount: fallbackProfile.validOrderCount,
          rtoCount: fallbackProfile.rtoCount,
          cancelledCount: fallbackProfile.cancelledCount,
          disputeCount: fallbackProfile.disputeCount,
          refundCount: fallbackProfile.refundCount,
          totalSpend: fallbackProfile.totalSpend,
          totalorders: fallbackProfile.totalorders, 
          codCount: fallbackProfile.codCount,
          fulfilledCount: fallbackProfile.fulfilledCount,
          unpaidCount: fallbackProfile.unpaidCount
        }
      }));
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
  
}

export const action = async ({ request }) => {
  const { cors } = await authenticate.admin(request);
  return cors(new Response(null, { status: 204 }));
};