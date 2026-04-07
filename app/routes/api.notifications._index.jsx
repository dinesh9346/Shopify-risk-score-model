import { json } from '../utils/responses.server.js';
import { authenticate } from '../shopify.server.js';
import { NotificationService } from '../models/notification.server.js';

export const loader = async ({ request, params }) => {
  const { session, cors } = await authenticate.admin(request);
  const { shop } = session;
  const { id } = params;

  if (!id) {
    return cors(json({ error: 'Notification ID is required' }, { status: 400 }));
  }

  try {
    const notificationService = new NotificationService();
    const status = await notificationService.getNotificationStatus(id);

    // Verify the notification belongs to the current shop
    if (status.shop !== shop) {
      return cors(json({ error: 'Notification not found' }, { status: 404 }));
    }

    return cors(json(status));
  } catch (error) {
    console.error('Get notification status API error:', error);
    if (error.message === 'Notification not found') {
      return cors(json({ error: 'Notification not found' }, { status: 404 }));
    }
    return cors(json({ error: 'Internal server error' }, { status: 500 }));
  }
};