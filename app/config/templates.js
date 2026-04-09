/**
 * WhatsApp Template Configuration
 * These templates must be created in your MyOperator WhatsApp Business Account
 */

export const WHATSAPP_TEMPLATES = {
  ORDER_CONFIRMATION: 'rsm_order_confirmation',
  SHIPMENT_CREATED: 'in_shipment_created_wa_message',
  SHIPMENT_IN_TRANSIT: 'tracking_link_in_transit_new',
  SHIPMENT_OUT_FOR_DELIVERY_PREPAID: 'tracking_link_out_for_delivery_prepaid_new2',
  SHIPMENT_OUT_FOR_DELIVERY_COD: 'tracking_link_out_for_delivery_cod_new',
  SHIPMENT_DELIVERED: 'tracking_link_delivered_new2',
  SHIPMENT_UNDELIVERED: 'in_shipment_undelivered',
  ORDER_VALIDATION: 'Order_delivery_confirmation',
  NDR_VERIFICATION: 'ndr_verification_in',
};

export const WHATSAPP_CAMPAIGNS = {
  [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: 'Shipment booked',
  [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: 'rsm_order_confirmation',
};

export const TEMPLATE_DESCRIPTIONS = {
  [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: 'Used for order confirmation notifications',
  [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: 'Shipment created notification',
  [WHATSAPP_TEMPLATES.SHIPMENT_IN_TRANSIT]: 'Shipment in transit with tracking link',
  [WHATSAPP_TEMPLATES.SHIPMENT_OUT_FOR_DELIVERY_PREPAID]: 'Out for delivery (Prepaid)',
  [WHATSAPP_TEMPLATES.SHIPMENT_OUT_FOR_DELIVERY_COD]: 'Out for delivery (COD)',
  [WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED]: 'Shipment delivered',
  [WHATSAPP_TEMPLATES.SHIPMENT_UNDELIVERED]: 'Shipment undelivered',
  [WHATSAPP_TEMPLATES.NDR_VERIFICATION]: 'NDR verification request',
};

/**
 * Map MyOperator template parameters to our payload
 * MyOperator expects specific field names for template parameters
 */
export function formatTemplateParams(templateId, data = {}) {
  const params = [];

  switch (templateId) {
    // case WHATSAPP_TEMPLATES.ORDER_CONFIRMATION:
    //   // Order template params
    //   if (data.customerName) params.push(data.customerName);
    //   if (data.sellerCompanyName) params.push(data.sellerCompanyName);
    //   if (data.orderId) params.push(data.orderId);
    //   if (data.productDetails) params.push(data.productDetails);
    //   if (data.orderTotal) params.push(data.orderTotal);
    //   break;
    case WHATSAPP_TEMPLATES.ORDER_CONFIRMATION:
      params.push(String(data.customerName || 'Customer'));
      params.push(String(data.sellerCompanyName || 'Zippyy'));
      params.push(String(data.orderId || 'N/A'));
      params.push(String(data.productDetails || 'Order Items'));
      
      const total = data.orderAmount || data.orderTotal || '0';
      params.push(String(total));
      break;
    case WHATSAPP_TEMPLATES.SHIPMENT_CREATED:
      // Shipment created template expects exactly 6 parameters
      // {{1}} Customer Name, {{2}} Order Number, {{3}} Product Details, {{4}} Order Type, {{5}} Order Amount, {{6}} Seller/Brand Name
      if (data.customerName) params.push(data.customerName);
      if (data.orderId) params.push(data.orderId);
      if (data.productDetails) params.push(data.productDetails);
      if (data.orderType) params.push(data.orderType);
      if (data.orderAmount) params.push(String(data.orderAmount)); // Convert to string for consistency
      if (data.sellerCompanyName) params.push(data.sellerCompanyName);
      break;

    case WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED:
      // Updated to match actual template: customer_name, order_number, product_details, order_type, seller_company_name
      if (data.customerName) params.push(data.customerName);
      if (data.orderId) params.push(data.orderId);
      if (data.productDetails) params.push(data.productDetails);
      if (data.orderType) params.push(data.orderType);
      if (data.sellerCompanyName) params.push(data.sellerCompanyName);
      break;

    case WHATSAPP_TEMPLATES.NDR_VERIFICATION:
      if (data.trackingId) params.push({ type: 'text', text: data.trackingId });
      if (data.ndrCode) params.push({ type: 'text', text: data.ndrCode });
      break;

    default:
      // Generic template params
      if (data.components?.length) {
        return data.components;
      }
  }

  return params;
}
