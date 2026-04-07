/**
 * WhatsApp Template Configuration
 * These templates must be created in your MyOperator WhatsApp Business Account
 */

export const WHATSAPP_TEMPLATES = {
  ORDER_CONFIRMATION: 'Order_delivery_confirmation',
  SHIPMENT_CREATED: 'in_shipment_created',
  SHIPMENT_IN_TRANSIT: 'tracking_link_in_transit_new',
  SHIPMENT_OUT_FOR_DELIVERY_PREPAID: 'tracking_link_out_for_delivery_prepaid_new2',
  SHIPMENT_OUT_FOR_DELIVERY_COD: 'tracking_link_out_for_delivery_cod_new',
  SHIPMENT_DELIVERED: 'tracking_link_delivered_new2',
  SHIPMENT_UNDELIVERED: 'in_shipment_undelivered',
  ORDER_VALIDATION: 'Order_delivery_confirmation',
  NDR_VERIFICATION: 'ndr_verification_in',
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
    case WHATSAPP_TEMPLATES.ORDER_CONFIRMATION:
      // Order template params
      if (data.orderId) params.push({ type: 'text', text: data.orderId });
      if (data.customerName) params.push({ type: 'text', text: data.customerName });
      if (data.orderDate) params.push({ type: 'text', text: data.orderDate });
      if (data.orderTotal) params.push({ type: 'text', text: data.orderTotal });
      break;

    case WHATSAPP_TEMPLATES.SHIPMENT_CREATED:
      // Shipment created template params - for order confirmation
      if (data.customerName) params.push({ type: 'text', text: data.customerName });
      if (data.orderId) params.push({ type: 'text', text: data.orderId });
      if (data.trackingId) params.push({ type: 'text', text: data.trackingId });
      if (data.trackingLink) params.push({ type: 'text', text: data.trackingLink });
      if (data.estimatedDelivery) params.push({ type: 'text', text: data.estimatedDelivery });
      break;

    case WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED:
      if (data.trackingId) params.push({ type: 'text', text: data.trackingId });
      if (data.deliveryDate) params.push({ type: 'text', text: data.deliveryDate });
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
