import axios from 'axios';
import { formatTemplateParams, WHATSAPP_CAMPAIGNS } from '../config/templates.js';

export class WhatsAppAdapter {
  constructor() {
    this.apiKey = process.env.WHATSAPP_API_KEY;
    this.baseUrl = process.env.WHATSAPP_BASE_URL; // e.g., https://backend.api-wa.co/campaign/myoperator/api/v2
    this.sendEndpoint = process.env.WHATSAPP_SEND_ENDPOINT || '';

    if (!this.apiKey || !this.baseUrl) {
      console.warn('[WhatsAppAdapter] WHATSAPP_API_KEY or WHATSAPP_BASE_URL is not configured');
    }

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`, // Try Bearer token authentication first
      },
    });
  }

  async sendMessage({ to, message, templateId, templateData, customerName }) {
    let cleanTo = to.replace(/\D/g, '');
    let payload;

    try {
      // 1. Clean the phone number (MyOperator usually wants digits only, no '+')
      cleanTo = to.replace(/\D/g, '');

      // 2. Adjust payload for MyOperator V2 structure
      if (templateId) {
        // FIX: Ensure campaignName is correctly resolved and sanitized of slashes
        let campaignName = WHATSAPP_CAMPAIGNS[templateId] || String(templateId).split('/').pop();
        
        const params = formatTemplateParams(templateId, templateData);

        if (!WHATSAPP_CAMPAIGNS[templateId] && campaignName !== templateId) {
          console.warn('[WhatsAppAdapter] Normalizing campaign name from templateId:', templateId, '->', campaignName);
        }

        // FIX: We use the flat structure for all API campaigns. 
        // MyOperator's API Gateway (AiSensy) expects apiKey and campaignName at the top level.
        // Even with buttons, the dashboard handles the mapping via templateParams.
        payload = {
          apiKey: this.apiKey, // Included here to prevent 401 even in primary attempt
          campaignName: campaignName,
          destination: cleanTo,
          userName: templateData?.customerName || customerName || '',
          templateParams: params,
          source: templateData?.source || 'new-landing-page form',
          media: templateData?.media || {},
          buttons: templateData?.buttons || [],
          carouselCards: templateData?.carouselCards || [],
          location: templateData?.location || {},
          attributes: templateData?.attributes || {},
          paramsFallbackValue: templateData?.paramsFallbackValue || {
            FirstName: templateData?.customerName?.split(' ')[0] || 'user',
          },
        };

        // If you specifically need to pass a dynamic URL for a button in the flat structure,
        // it is usually done by adding it as the last parameter in 'templateParams' 
        // if your MyOperator template is configured for dynamic buttons.
        if (templateData?.editUrl || templateData?.trackingId) {
           console.log(`[WhatsAppAdapter] Including dynamic URL/ID in parameters for ${campaignName}`);
        }

      } else {
        payload = {
          apiKey: this.apiKey,
          destination: cleanTo,
          campaignName: 'text_notifications',
          userName: customerName || 'Customer',
          type: 'text',
          channel: 'whatsapp', // Some MyOperator gateways require this
          text: {
            body: message,
          },
        };
      }

      const response = await this.client.post(this.sendEndpoint, payload);

      console.log(`[WhatsApp Success] Message sent to ${cleanTo}`);
      console.log("[FINAL WHATSAPP PAYLOAD SENT]", JSON.stringify(payload, null, 2));
      console.log("[WHATSAPP RESPONSE]", JSON.stringify(response.data, null, 2));

      return {
        success: true,
        providerMessageId: response.data.messageId || response.data.id || `wa-${Date.now()}`,
        response: response.data,
      };
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;

      // If Bearer token authentication fails with 401, try fallback method with apiKey in payload
      if (status === 401 && payload.apiKey !== undefined) {
        console.log('[WhatsAppAdapter] Bearer token failed, trying fallback with explicit POST...');

        try {
          const fallbackResponse = await axios.post(`${this.baseUrl}${this.sendEndpoint}`, payload, {
            headers: {
              'Content-Type': 'application/json',
            },
          });

          console.log(`[WhatsApp Success] Message sent to ${cleanTo} (fallback method)`);

          return {
            success: true,
            providerMessageId: fallbackResponse.data.messageId || fallbackResponse.data.id || `wa-${Date.now()}`,
            response: fallbackResponse.data,
          };
        } catch (fallbackError) {
          console.error('--- WHATSAPP API ERROR (FALLBACK ALSO FAILED) ---');
          console.error('Fallback Error Message:', fallbackError.message);
          console.error('Fallback Status:', fallbackError.response?.status);
          console.error('Fallback Data:', JSON.stringify(fallbackError.response?.data, null, 2));
        }
      }

      console.error('--- WHATSAPP API ERROR ---');
      console.error('Actual Error Message:', error.message);
      console.error('Status:', status);
      console.error('Data:', JSON.stringify(data, null, 2));

      return {
        success: false,
        error: data?.message || error.message,
        response: data,
      };
    }
  }

  async sendTemplate({ to, templateId, templateData }) {
    return this.sendMessage({ to, templateId, templateData });
  }
}
















// import axios from 'axios';
// import { formatTemplateParams, WHATSAPP_CAMPAIGNS } from '../config/templates.js';

// export class WhatsAppAdapter {
//   constructor() {
//     this.apiKey = process.env.WHATSAPP_API_KEY;
//     this.baseUrl = process.env.WHATSAPP_BASE_URL; // e.g., https://backend.api-wa.co/campaign/myoperator/api/v2
//     this.sendEndpoint = process.env.WHATSAPP_SEND_ENDPOINT || '';

//     if (!this.apiKey || !this.baseUrl) {
//       console.warn('[WhatsAppAdapter] WHATSAPP_API_KEY or WHATSAPP_BASE_URL is not configured');
//     }

//     this.client = axios.create({
//       baseURL: this.baseUrl,
//       headers: {
//         'Content-Type': 'application/json',
//         'Authorization': `Bearer ${this.apiKey}`, // Try Bearer token authentication first
//       },
//     });
//   }

//   async sendMessage({ to, message, templateId, templateData, customerName }) {
//     let cleanTo = to.replace(/\D/g, '');
//     let payload;

//     try {
//       // 1. Clean the phone number (MyOperator usually wants digits only, no '+')
//       cleanTo = to.replace(/\D/g, '');

//       // 2. Adjust payload for MyOperator V2 structure
//       if (templateId) {
//         const campaignName = WHATSAPP_CAMPAIGNS[templateId] || String(templateId).split('/').pop();
//         const params = formatTemplateParams(templateId, templateData);

//         if (!WHATSAPP_CAMPAIGNS[templateId] && campaignName !== templateId) {
//           console.warn('[WhatsAppAdapter] Normalizing campaign name from templateId:', templateId, '->', campaignName);
//         }

//         // Check if this template has button components
//         const hasButtons = templateData?.trackingId || templateData?.trackingNumber || templateData?.editUrl;

//         if (hasButtons) {
//           // Use component-based structure for templates with buttons
//           payload = {
//             to: cleanTo,
//             type: "template",
//             template: {
//               name: templateId,
//               language: {
//                 code: "en"
//               },
//               components: [
//                 {
//                   type: "body",
//                   parameters: params.map(param => ({ type: "text", text: param }))
//                 },
//                 {
//                   type: "button",
//                   sub_type: "url",
//                   index: "0",
//                   parameters: [
//                     { type: "text", text: templateData?.trackingId || templateData?.trackingNumber || templateData?.editUrl || "N/A" }
//                   ]
//                 }
//               ]
//             }
//           };
//         } else {
//           // Use legacy MyOperator format for templates without buttons
//           payload = {
//             apiKey: this.apiKey,
//             campaignName,
//             destination: cleanTo,
//             userName: templateData?.customerName || customerName || '',
//             templateParams: params,
//             source: templateData?.source || 'new-landing-page form',
//             media: templateData?.media || {},
//             buttons: templateData?.buttons || [],
//             carouselCards: templateData?.carouselCards || [],
//             location: templateData?.location || {},
//             attributes: templateData?.attributes || {},
//             paramsFallbackValue: templateData?.paramsFallbackValue || {
//               FirstName: templateData?.customerName?.split(' ')[0] || 'user',
//             },
//           };
//         }
//       } else {
//         payload = {
//           apiKey: this.apiKey,
//           destination: cleanTo,
//           campaignName: 'text_notifications',
//           userName: customerName || 'Customer',
//           type: 'text',
//           channel: 'whatsapp', // Some MyOperator gateways require this
//           text: {
//             body: message,
//           },
//         };
//       }

//       const response = await this.client.post(this.sendEndpoint, payload);

//       console.log(`[WhatsApp Success] Message sent to ${cleanTo}`);
//       console.log("[FINAL WHATSAPP PAYLOAD SENT]", JSON.stringify(payload, null, 2));
//       console.log("[WHATSAPP RESPONSE]", JSON.stringify(response.data, null, 2));

//       return {
//         success: true,
//         providerMessageId: response.data.messageId || response.data.id || `wa-${Date.now()}`,
//         response: response.data,
//       };
//     } catch (error) {
//       const status = error.response?.status;
//       const data = error.response?.data;

//       // If Bearer token authentication fails with 401, try fallback method with apiKey in payload
//       if (status === 401 && payload.apiKey === undefined) {
//         console.log('[WhatsAppAdapter] Bearer token failed, trying fallback with apiKey in payload...');

//         try {
//           const fallbackPayload = { ...payload, apiKey: this.apiKey };
//           const fallbackResponse = await axios.post(`${this.baseUrl}${this.sendEndpoint}`, fallbackPayload, {
//             headers: {
//               'Content-Type': 'application/json',
//             },
//           });

//           console.log(`[WhatsApp Success] Message sent to ${cleanTo} (fallback method)`);

//           return {
//             success: true,
//             providerMessageId: fallbackResponse.data.messageId || fallbackResponse.data.id || `wa-${Date.now()}`,
//             response: fallbackResponse.data,
//           };
//         } catch (fallbackError) {
//           console.error('--- WHATSAPP API ERROR (FALLBACK ALSO FAILED) ---');
//           console.error('Fallback Error Message:', fallbackError.message);
//           console.error('Fallback Status:', fallbackError.response?.status);
//           console.error('Fallback Data:', JSON.stringify(fallbackError.response?.data, null, 2));
//         }
//       }

//       console.error('--- WHATSAPP API ERROR ---');
//       console.error('Actual Error Message:', error.message);
//       console.error('Status:', status);
//       console.error('Data:', JSON.stringify(data, null, 2));

//       return {
//         success: false,
//         error: data?.message || error.message,
//         response: data,
//       };
//     }
//   }

//   async sendTemplate({ to, templateId, templateData }) {
//     return this.sendMessage({ to, templateId, templateData });
//   }
// }