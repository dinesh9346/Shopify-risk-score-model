import { json } from '../utils/responses.server.js';
import { NotificationService } from '../models/notification.server.js';

export const action = async ({ request, params }) => {
  const { provider } = params;

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = await request.json();
    const notificationService = new NotificationService();

    // Handle different provider webhook formats
    if (provider === 'sendgrid') {
      // SendGrid webhook format
      const events = Array.isArray(body) ? body : [body];

      for (const event of events) {
        await notificationService.handleWebhookEvent({
          provider: 'sendgrid',
          eventType: event.event,
          providerMessageId: event.sg_message_id,
          payload: event,
        });
      }
    } else if (provider === 'whatsapp') {
      // WhatsApp webhook format (generic)
      const event = body;
      await notificationService.handleWebhookEvent({
        provider: 'whatsapp',
        eventType: event.type || 'status_update',
        providerMessageId: event.message_id || event.id,
        payload: event,
      });
    } else {
      return json({ error: 'Unknown provider' }, { status: 400 });
    }

    return json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};