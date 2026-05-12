export const EMAIL_TEMPLATES = {
  SHIPMENT_CREATED: "d-aa96a93348b34b0ca20c10795f4cd2be",
  IN_TRANSIT: "d-03e799dd473e4c89a50467b2ee4553b8",
  OUT_FOR_DELIVERY: "d-9fa970d027c14e52b1a0173f5b947ab4",
  DELIVERED: "d-9961bddf4644410c8aa65c8c94d633e4",
  CANCELLED: "d-7efe100129d744c2aed70ea75cc4a95f",
  REFUNDED: "d-6fbb6446de9e4cb29445f6140c5f479b",
};

export const WHATSAPP_TEMPLATES = {
  ORDER_CONFIRMATION: 'risk_score_model_order_confirmation',
  ORDER_VERFICATION: 'address_correction_required',
  RSM_ADDRESS_VERIFY: 'address_verification',
  SHIPMENT_CREATED: 'rsm_order_fully_packed',
  SHIPMENT_IN_TRANSIT: 'rsm_shipment_in_transit',
  PAYMENT_CONFIRMATION: 'order_payment_confirmed',
  SHIPMENT_DELIVERED: 'rsm_order_delivered'
};

export const WHATSAPP_CAMPAIGNS = {
  [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: 'risk_score_model_order_confirmation',
  [WHATSAPP_TEMPLATES.RSM_ADDRESS_VERIFY]: 'address_verification',
  [WHATSAPP_TEMPLATES.ORDER_VERFICATION]: 'address_correction_required',
  [WHATSAPP_TEMPLATES.PAYMENT_CONFIRMATION]: 'order_payment_confirmed',
  [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: 'rsm_order_fully_packed',
  [WHATSAPP_TEMPLATES.SHIPMENT_IN_TRANSIT]: 'rsm_shipment_in_transit_new',
  [WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED]: 'rsm_order_delivered',
};

export const TEMPLATE_DESCRIPTIONS = {
  [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: 'Used for order confirmation notifications',
  [WHATSAPP_TEMPLATES.ORDER_VERFICATION]: 'Used for order verification notifications',
  [WHATSAPP_TEMPLATES.PAYMENT_CONFIRMATION]: 'Used for payment confirmation notifications',
  [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: 'Shipment created notification',
  [WHATSAPP_TEMPLATES.SHIPMENT_IN_TRANSIT]: 'Shipment in transit with tracking link',
  [WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED]: 'Shipment delivered',
};

const TEMPLATE_PARAM_ORDER = {
  [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: [
    'customerName',
    'sellerCompanyName',
    'orderId',
    'productDetails',
    'orderAmount'
  ],
  [WHATSAPP_TEMPLATES.ORDER_VERFICATION]: [
    'customerName',
    'sellerCompanyName',
    'orderId',
    'orderAmount',
    'productDetails'

  ],
  [WHATSAPP_TEMPLATES.PAYMENT_CONFIRMATION]: [
    'customerName',
    'orderId',
    'sellerCompanyName'
  ],
  [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: [
    'customerName',
    'orderId',
    'sellerCompanyName',
    'productDetails',
    'orderType',
    'orderAmount'
  ],
  [WHATSAPP_TEMPLATES.RSM_ADDRESS_VERIFY]: [
    'customerName',      // {{1}}
    'shippingAddress'   // {{2}}
  ],
  [WHATSAPP_TEMPLATES.SHIPMENT_IN_TRANSIT]: [
    'customerName',
    'orderId',
    'productDetails',
    'orderType',
    'orderAmount',
    'trackingUrl',
    'sellerCompanyName'
    // For Dynamic CTA Button
  ],
  [WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED]: [
    'customerName',
    'orderId',
    'productDetails',
    'orderType',
    'sellerCompanyName'
  ]
};

const DEFAULT_TEMPLATE_VALUES = {
  customerName: 'Customer',
  sellerCompanyName: 'Zippyy',
  orderId: 'N/A',
  productDetails: 'Order Items',
  orderType: 'Standard',
  orderAmount: '0',
  shippingAddress: 'Address not provided',
  editUrl: 'N/A',
  trackingUrl: 'N/A'
};

/**
 * Map MyOperator template parameters to our payload
 * MyOperator expects specific field names for template parameters
 */
export function formatTemplateParams(templateId, data = {}) {
  const params = [];
  const orderedFields = TEMPLATE_PARAM_ORDER[templateId];

  console.log('[formatTemplateParams] templateId:', templateId);
  console.log('[formatTemplateParams] orderedFields:', orderedFields);
  console.log('[formatTemplateParams] input data:', data);

  if (orderedFields) {
    for (const field of orderedFields) {
      const value = data[field] ?? DEFAULT_TEMPLATE_VALUES[field] ?? '';
      params.push(String(value));
      console.log(`[formatTemplateParams] Added field "${field}":`, String(value));
    }
    console.log('[formatTemplateParams] Final params:', params);
    return params;
  }

  switch (templateId) {
    case WHATSAPP_TEMPLATES.NDR_VERIFICATION:
      if (data.trackingId) params.push({ type: 'text', text: data.trackingId });
      if (data.ndrCode) params.push({ type: 'text', text: data.ndrCode });
      break;

    default:
      // Generic template params
      if (data.components?.length) {
        return data.components;
      }
      if (Array.isArray(data.templateParams)) {
        return data.templateParams;
      }
      if (Object.keys(data).length) {
        return Object.values(data).map(value => String(value));
      }
  }

  return params;
}








