
import { useLoaderData, Form, useActionData } from "@remix-run/react";
import prisma from "../db.server"; // Adjust path to your Prisma client
import { updateShopifyOrderAddress } from "../models/updateAddress.server";

// 1. LOADER: Fetches the order securely using the token
export async function loader({ params }) {
  const token = params.token;
  
  const order = await prisma.shopify_store_order.findUnique({
    where: { addressEditToken: token },
    select: {
      id: true,
      shippingAddress1: true,
      shippingCity: true,
      shippingProvince: true,
      shippingZip: true,
    }
  });

  if (!order) {
    throw new Response("This link is invalid or has already been used.", { status: 404 });
  }

  return Response.json({ order });
}

// 2. ACTION: Runs when the customer hits "Save"
export async function action({ request, params }) {
  const formData = await request.formData();
  const token = params.token;
  
  // Find the full order to get the shop and shopifyOrderId
  const order = await prisma.shopify_store_order.findUnique({
    where: { addressEditToken: token }
  });

  if (!order) return Response.json({ error: "Invalid token" }, { status: 400 });

  const newAddress = {
    address1: formData.get("address1"),
    city: formData.get("city"),
    province: formData.get("province"),
    zip: formData.get("zip"),
  };

  try {
    // A. Update Shopify using our unauthenticated graphql function
    await updateShopifyOrderAddress(order.shop, order.shopifyOrderId, newAddress);

    // B. Update local PostgreSQL database and DESTROY the token so link expires
    await prisma.shopify_store_order.update({
      where: { id: order.id },
      data: {
        shippingAddress1: newAddress.address1,
        shippingCity: newAddress.city,
        shippingProvince: newAddress.province,
        shippingZip: newAddress.zip,
        addressVerified: true, // Mark it as verified!
        addressEditToken: null // Invalidate link
      }
    });

    // C. (Optional) Trigger MyOperator API here to send a final "Address Updated!" WhatsApp message

    return Response.json({ success: true });

  } catch (error) {
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}

// 3. UI: The mobile-friendly form
export default function EditAddress() {
  const { order } = useLoaderData();
  const actionData = useActionData();

  if (actionData?.success) {
    return (
      <div style={{ padding: "30px", textAlign: "center", fontFamily: "sans-serif" }}>
        <h2 style={{ color: "#10b981" }}>Address Confirmed! ✓</h2>
        <p>Your GoDash delivery details have been securely updated. You can close this tab and return to WhatsApp.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "20px", maxWidth: "400px", margin: "0 auto", fontFamily: "sans-serif" }}>
      <h2 style={{ marginBottom: "20px" }}>Confirm Shipping Details</h2>
      
      {actionData?.error && <p style={{ color: "red" }}>{actionData.error}</p>}

      <Form method="post" style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px" }}>Street Address</span>
          <input type="text" name="address1" defaultValue={order.shippingAddress1} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px" }} />
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px" }}>City</span>
          <input type="text" name="city" defaultValue={order.shippingCity} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px" }}/>
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px" }}>State/Province</span>
          <input type="text" name="province" defaultValue={order.shippingProvince} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px" }}/>
        </label>

        <label>
          <span style={{ display: "block", marginBottom: "5px", fontSize: "14px" }}>Pincode</span>
          <input type="text" name="zip" defaultValue={order.shippingZip} required style={{ width: "100%", padding: "12px", border: "1px solid #ccc", borderRadius: "6px" }}/>
        </label>

        <button type="submit" style={{ padding: "14px", backgroundColor: "#000", color: "#fff", border: "none", borderRadius: "6px", fontSize: "16px", marginTop: "10px", cursor: "pointer" }}>
          Save & Confirm Order
        </button>
      </Form>
    </div>
  );
}