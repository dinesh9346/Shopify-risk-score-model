import { json } from '../utils/responses.server.js';
import { authenticate } from '../shopify.server.js';
import { NotificationService } from '../models/notification.server.js';

export const action = async ({ request }) => {
  const { session, cors } = await authenticate.admin(request);
  const { shop } = session;

  if (request.method !== 'POST') {
    return cors(json({ error: 'Method not allowed' }, { status: 405 }));
  }

  try {
    const body = await request.json();
    const { recipient, message, templateId, templateData } = body;

    if (!recipient) {
      return cors(json({ error: 'Recipient is required' }, { status: 400 }));
    }

    if (!templateId && !message) {
      return cors(json({
        error: 'Either templateId or message is required'
      }, { status: 400 }));
    }

    const notificationService = new NotificationService();
    const result = await notificationService.sendWhatsAppNotification({
      shop,
      recipient,
      message,
      templateId,
      templateData,
    });

    return cors(json(result, { status: result.success ? 200 : 500 }));
  } catch (error) {
    console.error('WhatsApp notification API error:', error);
    return cors(json({ error: 'Internal server error' }, { status: 500 }));
  }
};