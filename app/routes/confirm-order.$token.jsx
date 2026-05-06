import { useLoaderData, Form, useActionData, useNavigation } from "react-router";
import prisma from "../db.server"; 
import crypto from "crypto";
import { NotificationService } from "../models/notification.server.js"; 
import { addTagToShopifyOrder } from "../utils/shopifyTags.server.js";
const notificationService = new NotificationService();
// 1. LOADER: Securely fetch the order when the page opens
export async function loader({ params }) {
  const token = params.token;
  if (!token) return Response.json({ order: null });

  const order = await prisma.shopify_store_order.findFirst({
    where: { confirmToken: { endsWith: token } },
    select: {
      id: true,
      shopifyOrderId: true,
      financialStatus: true,
      cancelledAt: true,
      addressVerified: true,
      confirmToken: true
    }
  });

  return Response.json({ order });
}

// 2. ACTION: Runs ONLY when the user clicks the "Yes, Confirm Order" button
export async function action({ params, request }) {
  const token = params.token;
  
  // Fetch the order with all the details we need to send the next email
  const order = await prisma.shopify_store_order.findFirst({
    where: { confirmToken: token },
    select: {
      id: true,
      shop: true,
      shopifyOrderId: true,
      customerEmail: true,
      firstName: true,
      addressEditToken: true
    }
  });

  if (!order) return Response.json({ error: "Invalid or expired token" }, { status: 400 });

  try {
    // 1. Generate or fetch the address edit token
    let editToken = order.addressEditToken;
    if (!editToken) {
      editToken = crypto.randomUUID(); 
    }

    // 2. Update DB: Mark token as used via web, and save the address edit token
    await prisma.shopify_store_order.update({
      where: { id: order.id },
      data: { 
        confirmToken: `WEB_USED_${token}`,
        addressEditToken: editToken
      }
    });

    // 2.5 ADD TAG
    await addTagToShopifyOrder(order.shop, order.shopifyOrderId, "Order: Confirmed");

    // 3. SEND THE NEW ADDRESS VALIDATION EMAIL
    if (order.customerEmail) {
      const appBaseUrl = process.env.SHOPIFY_APP_URL || "https://bullhorn-raft-thinness.ngrok-free.dev";
      const editAddressUrl = `${appBaseUrl}/edit-address/${editToken}`;
      const cleanOrderId = order.shopifyOrderId.split('/').pop();

      try {
        // Fetch the full order details so we can print the address in the email
        const fullOrder = await prisma.shopify_store_order.findUnique({
          where: { id: order.id }
        });

        // We use the EXACT same edit token for both buttons!
        // The edit route loads the form, the confirm route instantly marks it verified.
        const confirmAddressUrl = `${appBaseUrl}/confirm-address/${editToken}`;

        await notificationService.sendEmailNotification({
          shop: order.shop,
          recipient: order.customerEmail,
          templateId: "d-1c4e94f52d9e49ac8c3e2556d3e043af", // YOUR NEW ADDRESS TEMPLATE ID
          templateData: {
            customer_name: order.firstName || "Customer",
            order_number: cleanOrderId,
            seller_company_name: order.shop.replace('.myshopify.com', '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
            
            // Send the address data to display in the grey box
            shipping_address: fullOrder.shippingAddress1 || "No Address Provided",
            shipping_city: fullOrder.shippingCity || "",
            shipping_province: fullOrder.shippingProvince || "",
            shipping_zip: fullOrder.shippingZip || "",

            // Send the two button URLs!
            edit_address_url: editAddressUrl,
            confirm_address_url: confirmAddressUrl 
          },
          orderId: order.shopifyOrderId,
          localOrderId: order.id
        });
        console.log(`[Confirm Order] Sent Address Validation email to ${order.customerEmail}`);
      } catch (emailErr) {
        console.error("⚠️ [Confirm Order] Failed to send address email:", emailErr);
      }
    }

    // 4. Return success to update the UI (No more instant redirect!)
    return Response.json({ success: true });

  } catch (error) {
    return Response.json({ error: "Something went wrong: " + error.message }, { status: 500 });
  }
}

// 3. UI: The webpage the customer sees
export default function ConfirmOrderPage() {
  const { order } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // SUCCESS UI: Show this after they click the button
  if (actionData?.success) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#10b981" }}>Order Confirmed! ✓</h2>
        <p>Thank you for confirming. We have just sent you a follow-up email to verify your shipping address.</p>
        <p style={{ marginTop: "20px", fontSize: "14px", color: "#666" }}>Please check your inbox (and spam folder) for the address verification link.</p>
      </div>
    );
  }

  // INVALID/EXPIRED UI
  if (!order) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#f43f5e" }}>Link Expired</h2>
        <p>This confirmation link is invalid or has already been used.</p>
      </div>
    );
  }

  // ALREADY USED CROSS-PLATFORM UI
  if (order.confirmToken && order.confirmToken.startsWith("WA_USED_")) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px", border: "2px solid #10b981", borderRadius: "8px" }}>
        <h2 style={{ color: "#10b981" }}>Already Confirmed ✓</h2>
        <p>You have already successfully confirmed this order via <strong>WhatsApp</strong>!</p>
      </div>
    );
  }

  if (order.confirmToken && order.confirmToken.startsWith("WEB_USED_") && !actionData?.success) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#10b981" }}>Already Confirmed ✓</h2>
        <p>You have already confirmed this order via email.</p>
      </div>
    );
  }

  // ALREADY CANCELLED UI
  if (order.financialStatus === "voided" || order.cancelledAt) {
    return (
       <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#f43f5e" }}>Cannot Confirm</h2>
        <p>Order #{order.shopifyOrderId.split('/').pop()} has been cancelled and cannot be confirmed.</p>
      </div>
    );
  }

//   // ALREADY VERIFIED UI
//   if (order.addressVerified) {
//     return (
//        <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
//         <h2 style={{ color: "#10b981" }}>Already Confirmed ✓</h2>
//         <p>This order and shipping address have already been verified. Your package is being processed for dispatch!</p>
//       </div>
//     );
//   }

  // DEFAULT UI (Ask for confirmation with a physical button)
  return (
    <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
      <h2>Confirm Your Order</h2>
      <p>Please click below to confirm order <strong>#{order.shopifyOrderId.split('/').pop()}</strong>.</p>
      
      {actionData?.error && (
        <p style={{ color: "#f43f5e", backgroundColor: "#ffebeb", padding: "10px", borderRadius: "6px" }}>
          {actionData.error}
        </p>
      )}

      <Form method="post">
        <button 
          type="submit" 
          disabled={isSubmitting}
          style={{
            backgroundColor: isSubmitting ? "#ccc" : "#000",
            color: "white",
            padding: "14px 24px",
            border: "none",
            borderRadius: "6px",
            fontSize: "16px",
            cursor: isSubmitting ? "not-allowed" : "pointer",
            marginTop: "20px",
            width: "100%",
            fontWeight: "bold"
          }}
        >
          {isSubmitting ? "Confirming..." : "Yes, Confirm Order"}
        </button>
      </Form>
    </div>
  );
}