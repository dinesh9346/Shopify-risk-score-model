import { useLoaderData, Form, useActionData } from "react-router";
import prisma from "../db.server"; 
import { updateShopifyOrderAddress } from "../models/updateAddress.server";
// // 1. LOADER: Fetches the order securely using the token
// export async function loader({ params }) {
//   const token = params.token;
  
//   if (!token || token.trim() === "") {
//     return Response.json({ order: null, error: "Invalid token" });
//   }

//   console.log(`[Edit Address] Loading order with token: ${token}`);
  
//   // Step 1: Find the current order tied to this specific link
//   const order = await prisma.shopify_store_order.findUnique({
//     where: { addressEditToken: token },
//     select: {
//       id: true,
//       shop: true,
//       shopifyOrderId: true,
//       shippingAddress1: true,
//       shippingCity: true,
//       shippingProvince: true,
//       shippingZip: true,
//       customerPhone: true,
//       firstName: true,
//       lastName: true
//     }
//   });

//   if (!order) {
//     return Response.json({ order: null });
//   }

//   // Check if this phone number has a previously VERIFIED address in our DB
//   const previousVerifiedOrder = await prisma.shopify_store_order.findFirst({
//     where: {
//       customerPhone: order.customerPhone,
//       addressVerified: true, // Only grab it if they successfully updated/confirmed it
//     },
//     orderBy: { 
//       updatedAt: 'desc' // Get the most recent one!
//     }
//   });

//   // If we found a previously verified address, overwrite the raw Shopify data!
//   if (previousVerifiedOrder) {
//     console.log(`[Edit Address] Found previously verified address for ${order.customerPhone}. Pre-filling form!`);
    
//     order.shippingAddress1 = previousVerifiedOrder.shippingAddress1;
//     order.shippingCity = previousVerifiedOrder.shippingCity;
//     order.shippingProvince = previousVerifiedOrder.shippingProvince;
//     order.shippingZip = previousVerifiedOrder.shippingZip;
//   }

//   // Return the order (either with raw Shopify data, or our smart pre-filled data)
//   return Response.json({ order });
// }
// 1. LOADER: Fetches the order securely using the token
export async function loader({ params }) {
  const token = params.token;
  
  if (!token || token.trim() === "") {
    return Response.json({ order: null, error: "Invalid token" });
  }

  const order = await prisma.shopify_store_order.findUnique({
    where: { addressEditToken: token },
    select: {
      id: true,
      shop: true,
      shopifyOrderId: true,
      shippingAddress1: true,
      shippingCity: true,
      shippingProvince: true,
      shippingZip: true,
      customerPhone: true,
    }
  });

  if (!order) {
    return Response.json({ order: null });
  }

  // Create a copy of the order to safely modify for the UI
  let displayOrder = { ...order };

  // ==========================================
  // SMART PRE-FILL LOGIC (BULLETPROOF VERSION)
  // ==========================================
  const previousVerifiedOrder = await prisma.shopify_store_order.findFirst({
    where: {
      customerPhone: displayOrder.customerPhone,
      addressVerified: true, 
      // FIX 1: Never pull data from the exact order we are currently editing
      id: { not: displayOrder.id } 
    },
    // FIX 2: Sort by when the order was PLACED, ignoring background webhook updates
    orderBy: { createdAt: 'desc' } 
  });

  if (previousVerifiedOrder) {
    console.log(`[Smart Pre-fill] Overwriting with past order: ${previousVerifiedOrder.shopifyOrderId}`);
    
    displayOrder.shippingAddress1 = previousVerifiedOrder.shippingAddress1;
    displayOrder.shippingCity = previousVerifiedOrder.shippingCity;
    displayOrder.shippingProvince = previousVerifiedOrder.shippingProvince;
    displayOrder.shippingZip = previousVerifiedOrder.shippingZip;
  } 

  return Response.json({ order: displayOrder });
}

// 2. ACTION: Runs when the customer hits "Save"
export async function action({ request, params }) {
  const formData = await request.formData();
  const token = params.token;
  
  const order = await prisma.shopify_store_order.findUnique({
    where: { addressEditToken: token }
  });

  if (!order) return Response.json({ error: "Invalid token" }, { status: 400 });

  const newAddress = {
    firstName: order.firstName || "",
    lastName: order.lastName || "Customer", 
    address1: formData.get("address1"),
    city: formData.get("city"),
    province: formData.get("province"),
    zip: formData.get("zip"),
  };

  try {
    // A. Update Shopify
    await updateShopifyOrderAddress(order.shop, order.shopifyOrderId, newAddress);

    // B. Update local Database and DESTROY the token
    await prisma.shopify_store_order.update({
      where: { id: order.id },
      data: {
        shippingAddress1: newAddress.address1,
        shippingCity: newAddress.city,
        shippingProvince: newAddress.province,
        shippingZip: newAddress.zip,
        addressVerified: true, 
        addressEditToken: null // Invalidate link
      }
    });

    // Note: Skipped WhatsApp Adapter plain-text confirmation to avoid 400 Campaign errors.
    // The visual success screen below is sufficient confirmation for the user.

    return Response.json({ success: true });

  } catch (error) {
    console.error("🔥 [Edit Address Action Error]:", error);
    return Response.json({ error: "Something went wrong: " + error.message }, { status: 500 });
  }
}

// 3. UI: The mobile-friendly form
export default function EditAddress() {
  const { order } = useLoaderData();
  const actionData = useActionData();

  // If they just submitted the form successfully, show this!
  if (actionData?.success) {
    return (
      <div style={{ padding: "30px", textAlign: "center", fontFamily: "sans-serif" }}>
        <h2 style={{ color: "#10b981" }}>Address Confirmed! ✓</h2>
        <p>Your GoDash delivery details have been securely updated in Shopify. You can close this tab and return to WhatsApp.</p>
      </div>
    );
  }

  // If they click an old link (or after the page reloads behind the scenes), show this!
  if (!order) {
    return (
      <div style={{ padding: "30px", textAlign: "center", fontFamily: "sans-serif" }}>
        <h2 style={{ color: "#f43f5e" }}>Link Expired</h2>
        <p>This address confirmation link has already been used or is invalid. If you need to make changes, please message us again.</p>
      </div>
    );
  }

  // Otherwise, show the form
  return (
    <div style={{ padding: "20px", maxWidth: "400px", margin: "0 auto", fontFamily: "sans-serif" }}>
      <h2 style={{ marginBottom: "20px" }}>Confirm Shipping Details</h2>
      
      {actionData?.error && <p style={{ color: "red", padding: "10px", backgroundColor: "#ffebeb" }}>{actionData.error}</p>}

      <Form method="post" style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px" }}>Street Address</span>
          <input type="text" name="address1" defaultValue={order.shippingAddress1} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px", boxSizing: "border-box" }} />
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px" }}>City</span>
          <input type="text" name="city" defaultValue={order.shippingCity} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px", boxSizing: "border-box" }}/>
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px" }}>State/Province</span>
          <input type="text" name="province" defaultValue={order.shippingProvince} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px", boxSizing: "border-box" }}/>
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px" }}>Pincode</span>
          <input type="text" name="zip" defaultValue={order.shippingZip} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px", boxSizing: "border-box" }}/>
        </label>

        <button type="submit" style={{ padding: "14px", backgroundColor: "#000", color: "#fff", border: "none", borderRadius: "6px", fontSize: "16px", marginTop: "10px", cursor: "pointer" }}>
          Save & Confirm Order
        </button>
      </Form>
    </div>
  );
}