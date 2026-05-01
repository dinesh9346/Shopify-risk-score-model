import { useLoaderData, Form, useActionData, useNavigation } from "react-router";
import prisma from "../db.server"; 
// I commented this out since we replaced it with our new, more powerful helper below!
// import { updateShopifyOrderAddress } from "../models/updateAddress.server";
import { WhatsAppAdapter } from "../models/whatsapp-adapter.server.js"; 

// --- NEW HELPER: Updates the Order AND Customer Profile in Shopify ---
async function updateShopifyOrderAndCustomerAddress(shop, orderId, newAddress) {
  const session = await prisma.session.findFirst({ 
    where: { shop: shop, isOnline: false },
    orderBy: { expires: 'desc' }
  });
  
  if (!session || !session.accessToken) throw new Error("No active Shopify session");

  const formattedId = String(orderId).includes("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  
  // 1. Get Customer ID from this specific order
  const getCustomerQuery = `query { order(id: "${formattedId}") { customer { id } } }`;
  const getCustomerRes = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({ query: getCustomerQuery }),
  });
  const customerData = await getCustomerRes.json();
  const customerId = customerData.data?.order?.customer?.id;

  // 2. Update Order's Shipping Address
  const orderUpdateQuery = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) { userErrors { message } }
    }
  `;
  await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({ 
      query: orderUpdateQuery, 
      variables: { input: { id: formattedId, shippingAddress: newAddress } } 
    }),
  });

  // 3. Update Customer's Default Profile Address (For future orders!)
  if (customerId) {
    const customerUpdateQuery = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) { userErrors { message } }
      }
    `;
    await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({ 
        query: customerUpdateQuery, 
        variables: { input: { id: customerId, addresses: [newAddress] } } 
      }),
    });
  }
  return true;
}

// 1. LOADER: Fetches the order securely using the token
export async function loader({ params }) {
  const token = params.token;
  
  if (!token || token.trim() === "") {
    return Response.json({ order: null, error: "Invalid token" });
  }

  const order = await prisma.shopify_store_order.findFirst({
    where: { addressEditToken: { endsWith: token } },
    select: {
      id: true,
      shop: true,
      shopifyOrderId: true,
      shippingAddress1: true,
      shippingCity: true,
      shippingProvince: true,
      shippingZip: true,
      customerPhone: true,
      firstName: true,
      lastName: true,
      addressEditToken: true
    }
  });

  if (!order) {
    return Response.json({ order: null });
  }

  // Create a copy of the order to safely modify for the UI
  let displayOrder = { ...order };

  // ==========================================
  // SMART PRE-FILL LOGIC
  // ==========================================
  const previousVerifiedOrder = await prisma.shopify_store_order.findFirst({
    where: {
      customerPhone: displayOrder.customerPhone,
      addressVerified: true, 
      id: { not: displayOrder.id } 
    },
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
  
  const order = await prisma.shopify_store_order.findFirst({
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
    // A. Update Shopify (Using our new helper to update BOTH Order and Customer Profile)
    await updateShopifyOrderAndCustomerAddress(order.shop, order.shopifyOrderId, newAddress);

    // B. Update local Database
    // Invalidate the edit link so they can't submit twice.
    await prisma.shopify_store_order.update({
      where: { id: order.id },
      data: {
        shippingAddress1: newAddress.address1,
        shippingCity: newAddress.city,
        shippingProvince: newAddress.province,
        shippingZip: newAddress.zip,
        addressVerified: true,
        addressEditToken: `WEB_USED_${token}`
      }
    });

    // C. SEND WHATSAPP CONFIRMATION 
    try {
      const whatsapp = new WhatsAppAdapter();
      const cleanOrderId = order.shopifyOrderId.split('/').pop();
      const safeName = order.firstName || "Customer";
      
      const successMessage = `✅ *Address Updated Successfully!*\n\nThank you, ${safeName}. Your shipping address for order #${cleanOrderId} has been securely updated in our system.\n\nYour order is now being processed for dispatch! 🚚`;

      await whatsapp.sendMessage({ 
        to: order.customerPhone, 
        message: successMessage,
        customerName: safeName 
      });
      
      console.log(`[Edit Address] Sent WhatsApp confirmation to ${order.customerPhone}`);
    } catch (msgError) {
      console.error("⚠️ [Edit Address] Failed to send WhatsApp confirmation:", msgError);
    }

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
  const navigation = useNavigation();

  // Detect if the form is currently saving
  const isSubmitting = navigation.state === "submitting";

  // 1. SUCCESS STATE: Form just submitted
  if (actionData?.success) {
    return (
      <div style={{ padding: "30px", textAlign: "center", fontFamily: "sans-serif" }}>
        <h2 style={{ color: "#10b981" }}>Address Confirmed! ✓</h2>
        <p>Your delivery details have been securely updated in our system. Your order is being processed for dispatch!</p>
        <p style={{ marginTop: "20px", fontSize: "14px", color: "#666" }}>You can safely close this window and return to your messages.</p>
      </div>
    );
  }

  // 2. EXPIRED STATE: Token doesn't exist at all
  if (!order) {
    return (
      <div style={{ padding: "30px", textAlign: "center", fontFamily: "sans-serif" }}>
        <h2 style={{ color: "#f43f5e" }}>Link Expired</h2>
        <p>This address confirmation link is invalid or has expired. If you need to make changes, please contact support.</p>
      </div>
    );
  }

  // ALREADY USED CROSS-PLATFORM UI
  if (order.addressEditToken && order.addressEditToken.startsWith("WA_USED_")) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px", border: "2px solid #10b981", borderRadius: "8px" }}>
        <h2 style={{ color: "#10b981" }}>Already Verified ✓</h2>
        <p>You have already successfully verified your address via <strong>WhatsApp</strong>!</p>
      </div>
    );
  }

  if (order.addressEditToken && order.addressEditToken.startsWith("WEB_USED_") && !actionData?.success) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#10b981" }}>Already Verified ✓</h2>
        <p>You have already verified your address via email.</p>
      </div>
    );
  }

  // 3. DEFAULT STATE: Show the form
  return (
    <div style={{ padding: "20px", maxWidth: "400px", margin: "0 auto", fontFamily: "sans-serif" }}>
      <h2 style={{ marginBottom: "20px" }}>Confirm Shipping Details</h2>
      
      {actionData?.error && (
        <p style={{ color: "red", padding: "10px", backgroundColor: "#ffebeb", borderRadius: "6px" }}>
          {actionData.error}
        </p>
      )}

      <Form method="post" style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px", fontWeight: "bold" }}>Street Address</span>
          <input type="text" name="address1" defaultValue={order.shippingAddress1} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px", boxSizing: "border-box", fontSize: "16px" }} />
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px", fontWeight: "bold" }}>City</span>
          <input type="text" name="city" defaultValue={order.shippingCity} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px", boxSizing: "border-box", fontSize: "16px" }}/>
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px", fontWeight: "bold" }}>State/Province</span>
          <input type="text" name="province" defaultValue={order.shippingProvince} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px", boxSizing: "border-box", fontSize: "16px" }}/>
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px", fontWeight: "bold" }}>Pincode</span>
          <input type="text" name="zip" defaultValue={order.shippingZip} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px", boxSizing: "border-box", fontSize: "16px" }}/>
        </label>

        <button 
          type="submit" 
          disabled={isSubmitting}
          style={{ 
            padding: "16px", 
            backgroundColor: isSubmitting ? "#ccc" : "#000", 
            color: isSubmitting ? "#666" : "#fff", 
            border: "none", 
            borderRadius: "6px", 
            fontSize: "16px", 
            fontWeight: "bold",
            marginTop: "10px", 
            cursor: isSubmitting ? "not-allowed" : "pointer" 
          }}
        >
          {isSubmitting ? "Saving details..." : "Save & Confirm Order"}
        </button>
      </Form>
    </div>
  );
}