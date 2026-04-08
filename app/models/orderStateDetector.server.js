import prisma from "../db.server.js";

/**
 * Detects what actually changed in an order by comparing with previous state
 * Only returns events for ACTUAL state changes (not the initial creation)
 */
export async function detectOrderStateChanges(shop, payload) {
  const orderGid = payload.admin_graphql_api_id;
  
  try {
    // Get the PREVIOUS state from database
    const previousOrder = await prisma.shopify_store_order.findUnique({
      where: {
        shop_shopifyOrderId: { shop, shopifyOrderId: orderGid }
      },
      select: {
        financialStatus: true,
        fulfillmentStatus: true,
        cancelledAt: true,
        previousFinancialStatus: true,
        previousFulfillmentStatus: true,
      }
    });

    // If no previous record, this is a new order (handled by ORDERS_CREATE)
    if (!previousOrder) {
      return [];
    }

    // Extract current state from webhook
    const currentFinancialStatus = payload.financial_status;
    const currentFulfillmentStatus = payload.fulfillment_status;
    const currentCancelledAt = payload.cancelled_at ? new Date(payload.cancelled_at) : null;

    const changes = [];

    // ========== FINANCIAL STATUS CHANGES ==========

    // PAYMENT_CONFIRMED: financial_status changed FROM non-paid TO "paid"
    if (
      previousOrder.financialStatus !== "paid" &&
      currentFinancialStatus === "paid"
    ) {
      changes.push({
        event: "PAYMENT_CONFIRMED",
        stage: "PAYMENT_CONFIRMED",
        timestamp: new Date(),
        details: {
          previousStatus: previousOrder.financialStatus,
          currentStatus: currentFinancialStatus,
          amount: payload.total_price ? parseFloat(payload.total_price) : 0
        }
      });
    }

    // PAYMENT_PENDING: financial_status changed TO "pending" (rare but possible)
    if (
      previousOrder.financialStatus !== "pending" &&
      currentFinancialStatus === "pending"
    ) {
      changes.push({
        event: "PAYMENT_PENDING",
        stage: "PAYMENT_PENDING",
        timestamp: new Date(),
        details: {
          previousStatus: previousOrder.financialStatus,
          currentStatus: currentFinancialStatus
        }
      });
    }

    // ORDER_REFUNDED: financial_status changed TO "refunded"
    if (
      previousOrder.financialStatus !== "refunded" &&
      currentFinancialStatus === "refunded"
    ) {
      changes.push({
        event: "ORDER_REFUNDED",
        stage: "ORDER_REFUNDED",
        timestamp: new Date(),
        details: {
          previousStatus: previousOrder.financialStatus,
          currentStatus: currentFinancialStatus,
          refundReason: payload.cancel_reason || "unknown"
        }
      });
    }

    // ========== FULFILLMENT STATUS CHANGES ==========

    if (previousOrder.fulfillmentStatus !== currentFulfillmentStatus) {
      // Map fulfillment statuses to notification events
      const fulfillmentMap = {
        unfullfilled: { event: "ORDER_UNFULLFILLED", stage: "ORDER_UNFULLFILLED" },
        partial: { event: "ORDER_PARTIALLY_SHIPPED", stage: "ORDER_PARTIALLY_SHIPPED" },
        fulfilled: { event: "ORDER_FULLY_PACKED", stage: "ORDER_FULLY_PACKED" },
        restocked: { event: "ORDER_RESTOCKED", stage: "ORDER_RESTOCKED" },
        cancelled: { event: "ORDER_CANCELLED_FULFILLMENT", stage: "ORDER_CANCELLED_FULFILLMENT" }
      };

      if (fulfillmentMap[currentFulfillmentStatus]) {
        changes.push({
          event: fulfillmentMap[currentFulfillmentStatus].event,
          stage: fulfillmentMap[currentFulfillmentStatus].stage,
          timestamp: new Date(),
          details: {
            previousStatus: previousOrder.fulfillmentStatus,
            currentStatus: currentFulfillmentStatus
          }
        });
      }
    }

    // ========== CANCELLATION ==========

    // ORDER_CANCELLED: cancelled_at was just set (went from null to a timestamp)
    if (!previousOrder.cancelledAt && currentCancelledAt) {
      changes.push({
        event: "ORDER_CANCELLED",
        stage: "ORDER_CANCELLED",
        timestamp: new Date(),
        details: {
          cancelledAt: currentCancelledAt,
          cancelReason: payload.cancel_reason || "Unknown",
          cancelledBy: payload.cancelled_at ? "Shopify" : "Unknown"
        }
      });
    }

    console.log(
      `[State Detector] Order ${payload.id}: Detected ${changes.length} changes - `,
      changes.map(c => c.event).join(", ")
    );

    return changes;
  } catch (error) {
    console.error(`[State Detector Error] Failed to detect changes:`, error.message);
    return [];
  }
}

/**
 * Updates the stored state in the database for next comparison
 * Called after detecting changes to maintain state history
 */
export async function updateStoredOrderState(shop, payload) {
  const orderGid = payload.admin_graphql_api_id;
  const currentFinancialStatus = payload.financial_status;
  const currentFulfillmentStatus = payload.fulfillment_status;
  const currentCancelledAt = payload.cancelled_at ? new Date(payload.cancelled_at) : null;

  try {
    const existingOrder = await prisma.shopify_store_order.findUnique({
      where: {
        shop_shopifyOrderId: { shop, shopifyOrderId: orderGid }
      },
      select: {
        id: true,
        financialStatus: true,
        fulfillmentStatus: true,
        cancelledAt: true
      }
    });

    if (!existingOrder) {
      return; // No record to update
    }

    // Update with new state and store previous state for audit trail
    await prisma.shopify_store_order.update({
      where: { id: existingOrder.id },
      data: {
        financialStatus: currentFinancialStatus,
        fulfillmentStatus: currentFulfillmentStatus,
        cancelledAt: currentCancelledAt,
        previousFinancialStatus: existingOrder.financialStatus,
        previousFulfillmentStatus: existingOrder.fulfillmentStatus,
        lastFinancialStatusChange:
          existingOrder.financialStatus !== currentFinancialStatus
            ? new Date()
            : undefined, // Only update if changed
        lastFulfillmentStatusChange:
          existingOrder.fulfillmentStatus !== currentFulfillmentStatus
            ? new Date()
            : undefined, // Only update if changed
      }
    });

    console.log(`[State Detector] Updated stored state for order ${payload.id}`);
  } catch (error) {
    console.error(`[State Detector Update Error]:`, error.message);
  }
}
