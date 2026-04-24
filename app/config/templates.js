/**
 * WhatsApp Template Configuration
 * These templates must be created in your MyOperator WhatsApp Business Account
 */

export const WHATSAPP_TEMPLATES = {
  ORDER_CONFIRMATION: 'risk_score_model_order_confirmation',
  RSM_ADDRESS_VERIFY: 'address_verification',
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
  [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: 'risk_score_model_order_confirmation',
  [WHATSAPP_TEMPLATES.RSM_ADDRESS_VERIFY]: 'address_verification'
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
  [WHATSAPP_TEMPLATES.RSM_ADDRESS_VERIFY]: 'Address verification and edit link upon order confirm',
};

const TEMPLATE_PARAM_ORDER = {
  [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: [
    'customerName',
    'sellerCompanyName',
    'orderId',
    'productDetails',
    'orderAmount'
  ],
  [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: [
    'customerName',
    'orderId',
    'productDetails',
    'orderType',
    'orderAmount',
    'sellerCompanyName'
  ],
  [WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED]: [
    'customerName',
    'orderId',
    'productDetails',
    'orderType',
    'sellerCompanyName'
  ],
  [WHATSAPP_TEMPLATES.RSM_ADDRESS_VERIFY]: [
    'customerName',      // {{1}}
    'shippingAddress'   // {{2}}
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
  editUrl: 'N/A'
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















// /**
//  * WhatsApp Template Configuration
//  * These templates must be created in your MyOperator WhatsApp Business Account
//  */

// export const WHATSAPP_TEMPLATES = {
//   ORDER_CONFIRMATION: 'risk_score_model_order_confirmation',
//   RSM_ADDRESS_VERIFY: 'rsm_order_confirmation',
//   SHIPMENT_CREATED: 'in_shipment_created_wa_message',
//   SHIPMENT_IN_TRANSIT: 'tracking_link_in_transit_new',
//   SHIPMENT_OUT_FOR_DELIVERY_PREPAID: 'tracking_link_out_for_delivery_prepaid_new2',
//   SHIPMENT_OUT_FOR_DELIVERY_COD: 'tracking_link_out_for_delivery_cod_new',
//   SHIPMENT_DELIVERED: 'tracking_link_delivered_new2',
//   SHIPMENT_UNDELIVERED: 'in_shipment_undelivered',
//   ORDER_VALIDATION: 'Order_delivery_confirmation',
//   NDR_VERIFICATION: 'ndr_verification_in',
// };

// export const WHATSAPP_CAMPAIGNS = {
//   [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: 'Shipment booked',
//   [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: 'risk_score_model_order_confirmation',
//   [WHATSAPP_TEMPLATES.RSM_ADDRESS_VERIFY]: 'rsm_order_confirmation'

// };

// export const TEMPLATE_DESCRIPTIONS = {
//   [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: 'Used for order confirmation notifications',
//   [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: 'Shipment created notification',
//   [WHATSAPP_TEMPLATES.SHIPMENT_IN_TRANSIT]: 'Shipment in transit with tracking link',
//   [WHATSAPP_TEMPLATES.SHIPMENT_OUT_FOR_DELIVERY_PREPAID]: 'Out for delivery (Prepaid)',
//   [WHATSAPP_TEMPLATES.SHIPMENT_OUT_FOR_DELIVERY_COD]: 'Out for delivery (COD)',
//   [WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED]: 'Shipment delivered',
//   [WHATSAPP_TEMPLATES.SHIPMENT_UNDELIVERED]: 'Shipment undelivered',
//   [WHATSAPP_TEMPLATES.NDR_VERIFICATION]: 'NDR verification request',
// };

// const TEMPLATE_PARAM_ORDER = {
//   [WHATSAPP_TEMPLATES.ORDER_CONFIRMATION]: [
//     'customerName',
//     'sellerCompanyName',
//     'orderId',
//     'productDetails',
//     'orderAmount'
//   ],
//   [WHATSAPP_TEMPLATES.SHIPMENT_CREATED]: [
//     'customerName',
//     'orderId',
//     'productDetails',
//     'orderType',
//     'orderAmount',
//     'sellerCompanyName'
//   ],
//   [WHATSAPP_TEMPLATES.SHIPMENT_DELIVERED]: [
//     'customerName',
//     'orderId',
//     'productDetails',
//     'orderType',
//     'sellerCompanyName'
//   ]
// };

// const DEFAULT_TEMPLATE_VALUES = {
//   customerName: 'Customer',
//   sellerCompanyName: 'Zippyy',
//   orderId: 'N/A',
//   productDetails: 'Order Items',
//   orderType: 'Standard',
//   orderAmount: '0'
// };

// /**
//  * Map MyOperator template parameters to our payload
//  * MyOperator expects specific field names for template parameters
//  */
// export function formatTemplateParams(templateId, data = {}) {
//   const params = [];
//   const orderedFields = TEMPLATE_PARAM_ORDER[templateId];

//   if (orderedFields) {
//     for (const field of orderedFields) {
//       const value = data[field] ?? DEFAULT_TEMPLATE_VALUES[field] ?? '';
//       params.push(String(value));
//     }
//     return params;
//   }

//   switch (templateId) {
//     case WHATSAPP_TEMPLATES.NDR_VERIFICATION:
//       if (data.trackingId) params.push({ type: 'text', text: data.trackingId });
//       if (data.ndrCode) params.push({ type: 'text', text: data.ndrCode });
//       break;

//     default:
//       // Generic template params
//       if (data.components?.length) {
//         return data.components;
//       }
//       if (Array.isArray(data.templateParams)) {
//         return data.templateParams;
//       }
//       if (Object.keys(data).length) {
//         return Object.values(data).map(value => String(value));
//       }
//   }

//   return params;
// }
