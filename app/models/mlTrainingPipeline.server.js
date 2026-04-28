import prisma from "../db.server.js";

export async function captureMLTrainingData(shop, orderId, terminalState) {
  try {
    console.log(`[ML Pipeline] Capturing terminal state '${terminalState}' for order ${orderId}`);

    // 1. Fetch the order from the database
    const order = await prisma.shopify_store_order.findUnique({
      where: { id: orderId }
    });

    if (!order) {
      console.warn(`[ML Pipeline] Order ${orderId} not found in DB. Cannot capture ML data.`);
      return;
    }

    const existingRow = await prisma.zippyy_ml_training_data.findUnique({
      where: { orderId: orderId }
    });

    if (existingRow) {
      // Just update the terminal flags
      await prisma.zippyy_ml_training_data.update({
        where: { orderId: orderId },
        data: {
          isRTO: terminalState === 'RTO' ? true : existingRow.isRTO,
          isDelivered: terminalState === 'DELIVERED' ? true : existingRow.isDelivered,
          isDispute: terminalState === 'DISPUTE' ? true : existingRow.isDispute,
          isTerminal: true
        }
      });
      console.log(`[ML Pipeline] Updated existing ML data for order ${orderId} with ${terminalState}`);
      return;
    }


    // Feature 1: Zipcode
    const cleanZip = order.shippingZip ? order.shippingZip.replace(/[\s-]/g, "") : "000000";

    // Feature 2: Order Type
    const gateway = (order.paymentGateway || "").toLowerCase();
    const isCod = gateway.includes("cod") || gateway.includes("cash") || gateway.includes("pay on delivery");
    const order_type = isCod ? "COD" : "PREPAID";

    // Feature 3: Order Value Bin
    const val = parseFloat(order.orderValue || 0);
    let order_value_bin = "LOW";
    if (val >= 5000) order_value_bin = "HIGH";
    else if (val >= 1500) order_value_bin = "MEDIUM";

    // Feature 4: Email Domain
    const email_domain = order.customerEmail ? order.customerEmail.split('@')[1].toLowerCase() : "unknown";

    // Feature 5,6,7,8,9: Seasonality and Time
    const orderDate = new Date(order.createdAt);
    const month = orderDate.getMonth() + 1;
    const hour = orderDate.getHours();
    const day = orderDate.getDay();

    const is_weekend = (day === 0 || day === 6) ? 1 : 0;
    const is_night = (hour >= 22 || hour < 6) ? 1 : 0;
    const is_holiday_season = (month === 11 || month === 12) ? 1 : 0;
    const is_rainy_season = (month >= 6 && month <= 9) ? 1 : 0;

    //  historical data exactly UP TO the point this order was placed.
    // This prevents data leakage (future orders changing the stats of past orders).
    const history = await prisma.shopify_store_order.findMany({
      where: {
        shop: shop,
        createdAt: { lt: order.createdAt },
        OR: [
          order.customerId ? { customerId: order.customerId } : undefined,
          order.customerEmail ? { customerEmail: order.customerEmail } : undefined
        ].filter(Boolean)
      }
    });

    const totalOrders = history.length;
    let cancelledCount = 0, rtoCount = 0, validOrderCount = 0;
    let firstOrderDate = new Date(order.createdAt);

    history.forEach(o => {
      const fStatus = (o.financialStatus || "").toUpperCase();
      const fulfillment = (o.fulfillmentStatus || "").toUpperCase();
      const shipment = (o.shipmentStatus || "").toUpperCase();

      if (o.cancelledAt || fulfillment === "CANCELLED") {
        cancelledCount++;
      } else if (
        o.isRTO ||
        fulfillment === "RETURNED" || fulfillment === "RESTOCKED" || fStatus === "REFUNDED" ||
        ["RTO", "RETURN_TO_ORIGIN", "RETURNED", "FAILURE", "FAILED", "UNDELIVERED", "DELIVERY_FAILED", "LOST", "EXCEPTION"].includes(shipment)
      ) {
        rtoCount++;
      } else {
        validOrderCount++;
      }

      if (new Date(o.createdAt) < firstOrderDate) firstOrderDate = new Date(o.createdAt);
    });

    const daysSinceFirstOrder = Math.max(1, Math.floor((orderDate - firstOrderDate) / (1000 * 60 * 60 * 24)));

    // Feature 10, 11, 12, 18, 19: Customer History Rates
    const customer_return_rate = totalOrders > 0 ? (rtoCount / totalOrders) : 0;
    const customer_order_frequency = totalOrders > 0 ? (totalOrders / daysSinceFirstOrder) : 0;
    const is_new_customer = totalOrders === 0 ? 1 : 0;
    const customer_cancel_rate = totalOrders > 0 ? (cancelledCount / totalOrders) : 0;
    const customer_success_rate = totalOrders > 0 ? (validOrderCount / totalOrders) : 0;

    // Feature 13, 14, 15: Zipcode History
    const thirtyDaysAgo = new Date(orderDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const zipHistory = await prisma.shopify_store_order.findMany({
      where: {
        shop: shop,
        shippingZip: cleanZip,
        createdAt: { lt: order.createdAt }
      }
    });

    let zip_rtos = 0;
    let zip_monthly_orders = 0;
    let zip_monthly_rtos = 0;

    zipHistory.forEach(o => {
      const isPastRto = o.isRTO || ["RETURNED", "RESTOCKED"].includes((o.fulfillmentStatus || "").toUpperCase());
      if (isPastRto) zip_rtos++;

      if (new Date(o.createdAt) >= thirtyDaysAgo) {
        zip_monthly_orders++;
        if (isPastRto) zip_monthly_rtos++;
      }
    });

    const zipcode_order_volume = zipHistory.length;
    const zipcode_return_rate = zipcode_order_volume > 0 ? (zip_rtos / zipcode_order_volume) : 0;
    const zipcode_monthly_return_rate = zip_monthly_orders > 0 ? (zip_monthly_rtos / zip_monthly_orders) : 0;

    // Feature 16, 17: Validations
    const is_address_valid = order.addressVerified === false ? 0 : 1;
    const is_email_domain_valid = 1; // Assuming valid at checkout unless failed

    // Feature 20: Hoarding Count
    let hoarding_count = 0;
    try {
      const currentProductIds = order.lineItemsData ? JSON.parse(order.lineItemsData) : [];
      if (currentProductIds.length > 0) {
        currentProductIds.forEach(productId => {
          let unpaidCount = 0;
          history.forEach(pastOrder => {
            let pastProductIds = [];
            try { pastProductIds = pastOrder.lineItemsData ? JSON.parse(pastOrder.lineItemsData) : []; } catch (e) { }
            if (pastProductIds.includes(productId)) {
              const fStatus = (pastOrder.financialStatus || "").toUpperCase();
              const fulfillment = (pastOrder.fulfillmentStatus || "").toUpperCase();
              const isClean = !pastOrder.cancelledAt && !(pastOrder.isRTO || fulfillment === "RETURNED" || fStatus === "REFUNDED") && !pastOrder.hasDispute;
              if (!((fStatus === "PAID" || fStatus === "PARTIALLY_REFUNDED") && fulfillment === "FULFILLED" && isClean)) {
                unpaidCount++;
              }
            }
          });
          if (unpaidCount > hoarding_count) hoarding_count = unpaidCount;
        });
      }
    } catch (e) { }

    // Feature 21: Name Validity
    const cleanFirstName = (order.firstName || "").trim();
    const cleanLastName = (order.lastName || "").trim();
    const fullName = [cleanFirstName, cleanLastName].filter(Boolean).join(" ");
    const isCombinedValid = fullName.length > 3;
    const hasValidComponent = cleanFirstName.length >= 3 || cleanLastName.length >= 3;
    const is_name_valid = (isCombinedValid && hasValidComponent) ? 1 : 0;

    // --- 4. INSERT INTO DB ---
    await prisma.zippyy_ml_training_data.create({
      data: {
        shop: shop,
        orderId: orderId,
        customer_zipcode: cleanZip,
        order_type: order_type,
        order_value_bin: order_value_bin,
        email_domain: email_domain,
        order_month: month,
        is_weekend: is_weekend,
        is_night: is_night,
        is_holiday_season: is_holiday_season,
        is_rainy_season: is_rainy_season,
        customer_return_rate: customer_return_rate,
        customer_order_frequency: customer_order_frequency,
        is_new_customer: is_new_customer,
        zipcode_order_volume: zipcode_order_volume,
        zipcode_return_rate: zipcode_return_rate,
        zipcode_monthly_return_rate: zipcode_monthly_return_rate,
        is_address_valid: is_address_valid,
        is_email_domain_valid: is_email_domain_valid,
        customer_cancel_rate: customer_cancel_rate,
        customer_success_rate: customer_success_rate,
        hoarding_count: hoarding_count,
        is_name_valid: is_name_valid,
        isRTO: terminalState === 'RTO',
        isDelivered: terminalState === 'DELIVERED',
        isDispute: terminalState === 'DISPUTE',
        isTerminal: true
      }
    });

    console.log(`[ML Pipeline] Successfully created terminal feature snapshot for order ${orderId}`);

  } catch (error) {
    console.error(`[ML Pipeline Error] Failed to capture ML data:`, error);
  }
}

export async function bulkCaptureMLTrainingData(shop) {
  console.log(`[ML Bulk Pipeline] Starting historical ML training data extraction for ${shop}...`);

  try {
    const allTerminalOrders = await prisma.shopify_store_order.findMany({
      where: {
        shop: shop,
        OR: [
          { isRTO: true },
          { hasDispute: true },
          // Look at shipmentStatus matching terminal states (delivered or RTO-related)
          { shipmentStatus: { in: ['delivered', 'DELIVERED', 'success', 'SUCCESS', 'rto', 'RTO', 'RETURN_TO_ORIGIN', 'RETURNED', 'FAILURE', 'FAILED', 'UNDELIVERED', 'DELIVERY_FAILED', 'LOST', 'EXCEPTION'] } },
          { fulfillmentStatus: { in: ['RETURNED', 'RESTOCKED'] } },
          { financialStatus: 'REFUNDED' }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });

    console.log(`[ML Bulk Pipeline] Found ${allTerminalOrders.length} terminal orders to process.`);

    let processedCount = 0;
    // Process sequentially to avoid database connection pool exhaustion or rate limits
    for (const order of allTerminalOrders) {
      // Determine terminal state based on hierarchy: Dispute > RTO > Delivered
      let terminalState = 'DELIVERED';
      const shipment = (order.shipmentStatus || "").toUpperCase();
      const fulfillment = (order.fulfillmentStatus || "").toUpperCase();
      const fStatus = (order.financialStatus || "").toUpperCase();

      if (order.hasDispute) {
        terminalState = 'DISPUTE';
      } else if (
        order.isRTO || 
        ["RTO", "RETURN_TO_ORIGIN", "RETURNED", "FAILURE", "FAILED", "UNDELIVERED", "DELIVERY_FAILED", "LOST", "EXCEPTION"].includes(shipment) ||
        ["RETURNED", "RESTOCKED"].includes(fulfillment) ||
        fStatus === "REFUNDED"
      ) {
        terminalState = 'RTO';
      }

      await captureMLTrainingData(shop, order.id, terminalState);
      processedCount++;

      if (processedCount % 50 === 0) {
        console.log(`[ML Bulk Pipeline] Processed ${processedCount} / ${allTerminalOrders.length} orders.`);
      }
    }

    console.log(`[ML Bulk Pipeline] Finished historical ML training data extraction. Total processed: ${processedCount}`);
  } catch (error) {
    console.error(`[ML Bulk Pipeline Error] Failed to run bulk capture:`, error);
  }
}