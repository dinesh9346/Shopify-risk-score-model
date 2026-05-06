import { useLoaderData, Form, useActionData, useNavigation } from "react-router";
import prisma from "../db.server";
import { addTagToShopifyOrder } from "../utils/shopifyTags.server.js";

// 1. LOADER: Securely fetch the order when the page opens
export async function loader({ params }) {
  const token = params.token;
  if (!token) return Response.json({ order: null });

  const order = await prisma.shopify_store_order.findFirst({
    where: { addressEditToken: { endsWith: token } }
  });

  return Response.json({ order });
}

// 2. ACTION: Runs when the page loads automatically OR if they click a button
export async function action({ params }) {
  const token = params.token;

  const order = await prisma.shopify_store_order.findFirst({
    where: { addressEditToken: token }
  });

  if (!order) return Response.json({ error: "Invalid or expired token" }, { status: 400 });

  try {
    // Mark address as verified and mark token as used!
    await prisma.shopify_store_order.update({
      where: { id: order.id },
      data: {
        addressVerified: true,
        addressEditToken: `WEB_USED_${token}`
      }
    });

    // 2.5 ADD TAG
    await addTagToShopifyOrder(order.shop, order.shopifyOrderId, "Address: Verified");

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: "Something went wrong: " + error.message }, { status: 500 });
  }
}

// 3. UI: The webpage the customer sees
export default function ConfirmAddressPage() {
  const { order } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // If action was successful, show acknowledgment FIRST!
  if (actionData?.success) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#10b981" }}>Address Confirmed! 📦</h2>
        <p>Thank you for verifying your details. Your order is now being processed for fast dispatch to your address.</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#f43f5e" }}>Link Expired</h2>
        <p>This confirmation link is invalid or has already been used.</p>
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

  return (
    <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
      <h2>Confirm Address</h2>
      <p>Click the button below to permanently verify your delivery details.</p>
      <Form method="post">
        <button
          type="submit"
          disabled={isSubmitting}
          style={{
            backgroundColor: "#10b981", color: "white", padding: "14px 24px", border: "none", borderRadius: "6px", fontSize: "16px", cursor: "pointer", width: "100%", fontWeight: "bold"
          }}
        >
          {isSubmitting ? "Confirming..." : "Verify Address Now"}
        </button>
      </Form>
    </div>
  );
}