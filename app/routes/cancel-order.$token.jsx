import { useLoaderData, Form, useActionData, useNavigation } from "react-router";
import prisma from "../db.server"; 

// Helper function to cancel the order in Shopify using an offline session
async function cancelShopifyOrder(shop, orderId) {
  const session = await prisma.session.findFirst({ 
    where: { shop: shop, isOnline: false },
    orderBy: { expires: 'desc' }
  });
  
  if (!session || !session.accessToken) {
    throw new Error("No active session or missing access token for shop");
  }

  const formattedId = String(orderId).includes("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const query = `
    mutation orderCancel($orderId: ID!) {
      orderCancel(orderId: $orderId, reason: CUSTOMER, notifyCustomer: false, restock: true) {
        job { id }
        userErrors { field message }
      }
    }
  `;

  const response = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables: { orderId: formattedId } }),
  });

  const data = await response.json();
  if (data.errors && data.errors.length > 0) throw new Error(`Shopify API Error: ${data.errors[0].message}`);
  if (data.data?.orderCancel?.userErrors?.length > 0) throw new Error(data.data.orderCancel.userErrors[0].message);
  
  return true;
}

// 1. LOADER: Securely fetch the order when the page opens
export async function loader({ params }) {
  const token = params.token;
  if (!token) return Response.json({ order: null });

  const order = await prisma.shopify_store_order.findUnique({
    where: { cancelToken: token },
    select: {
      id: true,
      shopifyOrderId: true,
      financialStatus: true,
      cancelledAt: true,
      shop: true
    }
  });

  return Response.json({ order });
}

// 2. ACTION: Runs ONLY when the user clicks the "Yes, Cancel" button
export async function action({ params }) {
  const token = params.token;
  
  const order = await prisma.shopify_store_order.findUnique({
    where: { cancelToken: token }
  });

  if (!order) return Response.json({ error: "Invalid or expired token" }, { status: 400 });

  try {
    // 1. Cancel in Shopify
    await cancelShopifyOrder(order.shop, order.shopifyOrderId);

    // 2. Update DB and destroy tokens so it can't be clicked again
    await prisma.shopify_store_order.update({
      where: { id: order.id },
      data: { 
        financialStatus: "voided", 
        fulfillmentStatus: "cancelled",
        cancelledAt: new Date(),
        cancelToken: null,
        confirmToken: null,
        addressEditToken: null 
      }
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: "Failed to cancel: " + error.message }, { status: 500 });
  }
}

// 3. UI: The webpage the customer sees
export default function CancelOrderPage() {
  const { order } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // SUCCESS UI
  if (actionData?.success) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#10b981" }}>Order Cancelled ✓</h2>
        <p>Your order has been successfully cancelled. If you have already paid, your refund will be processed shortly.</p>
      </div>
    );
  }

  // INVALID/EXPIRED UI
  if (!order) {
    return (
      <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2 style={{ color: "#f43f5e" }}>Link Expired</h2>
        <p>This cancellation link is invalid or has already been used.</p>
      </div>
    );
  }

  // ALREADY CANCELLED UI
  if (order.financialStatus === "voided" || order.cancelledAt) {
    return (
       <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
        <h2>Order Already Cancelled</h2>
        <p>Order #{order.shopifyOrderId.split('/').pop()} was already cancelled previously.</p>
      </div>
    );
  }

  // DEFAULT UI (Ask for confirmation)
  return (
    <div style={{ maxWidth: "400px", margin: "40px auto", textAlign: "center", fontFamily: "sans-serif", padding: "20px" }}>
      <h2>Cancel Order?</h2>
      <p>Are you sure you want to cancel order <strong>#{order.shopifyOrderId.split('/').pop()}</strong>?</p>
      
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
            backgroundColor: isSubmitting ? "#ccc" : "#f43f5e",
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
          {isSubmitting ? "Cancelling..." : "Yes, Cancel My Order"}
        </button>
      </Form>
    </div>
  );
}