import axios from 'axios';
import { formatTemplateParams } from '../config/templates.js';

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
        const campaignName = String(templateId).split('/').pop();
        const params = formatTemplateParams(templateId, templateData);

        if (campaignName !== templateId) {
          console.warn('[WhatsAppAdapter] Normalizing campaign name from templateId:', templateId, '->', campaignName);
        }

        payload = {
          apiKey: this.apiKey,
          campaignName,
          destination: cleanTo,
          userName: templateData?.customerName || '',
          templateParams: params,
          templateData: templateData || {},
        };
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

      return {
        success: true,
        providerMessageId: response.data.messageId || response.data.id || `wa-${Date.now()}`,
        response: response.data,
      };
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;

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