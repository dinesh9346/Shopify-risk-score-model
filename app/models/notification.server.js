import prisma from '../db.server.js';
import { SendGridAdapter } from './sendgrid-adapter.server.js';
import { WhatsAppAdapter } from './whatsapp-adapter.server.js';

export class NotificationService {
  constructor() {
    this.sendgridAdapter = new SendGridAdapter();
    this.whatsappAdapter = new WhatsAppAdapter();
  }

  async sendEmailNotification({ shop, recipient, subject, html, text, templateId, templateData, orderId, localOrderId }) {
    try {
      // Create notification record
      const notification = await prisma.notification.create({
        data: {
          shop,
          channel: 'EMAIL',
          recipient,
          templateId,
          status: 'PENDING',
          orderId,        // Link to specific order
          localOrderId,   // Local database order ID
        },
      });

      let result;
      if (templateId) {
        result = await this.sendgridAdapter.sendTemplate({
          to: recipient,
          templateId,
          templateData,
        });
      } else {
        result = await this.sendgridAdapter.sendEmail({
          to: recipient,
          subject,
          html,
          text,
        });
      }

      // Update notification record with result
      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: result.success ? 'SENT' : 'FAILED',
          providerMessageId: result.providerMessageId,
          providerResponse: result.response,
        },
      });

      return {
        notificationId: notification.id,
        success: result.success,
        providerMessageId: result.providerMessageId,
        error: result.error,
      };
    } catch (error) {
      console.error('Email notification error:', error);
      throw error;
    }
  }

  async sendWhatsAppNotification({ shop, recipient, message, templateId, templateData, customerName, orderId, localOrderId }) {
    try {
      console.log(`[NotificationService] Sending WhatsApp - orderId: ${orderId}, localOrderId: ${localOrderId}, recipient: ${recipient}, templateId: ${templateId}`);
      
      // Create notification record
      const notification = await prisma.notification.create({
        data: {
          shop,
          channel: 'WHATSAPP',
          recipient,
          templateId,
          status: 'PENDING',
          orderId,        // Link to specific order
          localOrderId,   // Local database order ID
        },
      });

      const result = await this.whatsappAdapter.sendMessage({
        to: recipient,
        message,
        templateId,
        templateData,
        customerName,
      });

      // Update notification record with result
      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: result.success ? 'SENT' : 'FAILED',
          providerMessageId: result.providerMessageId,
          providerResponse: result.response,
        },
      });

      return {
        notificationId: notification.id,
        success: result.success,
        providerMessageId: result.providerMessageId,
        error: result.error,
      };
    } catch (error) {
      console.error('WhatsApp notification error:', error);
      throw error;
    }
  }

  async getNotificationStatus(notificationId) {
    try {
      const notification = await prisma.notification.findUnique({
        where: { id: notificationId },
        include: {
          events: {
            orderBy: { receivedAt: 'desc' },
          },
        },
      });

      if (!notification) {
        throw new Error('Notification not found');
      }

      return {
        id: notification.id,
        channel: notification.channel,
        recipient: notification.recipient,
        status: notification.status,
        providerMessageId: notification.providerMessageId,
        createdAt: notification.createdAt,
        updatedAt: notification.updatedAt,
        events: notification.events,
      };
    } catch (error) {
      console.error('Get notification status error:', error);
      throw error;
    }
  }

  async handleWebhookEvent({ provider, eventType, providerMessageId, payload }) {
    try {
      // Find notification by provider message ID
      const notification = await prisma.notification.findFirst({
        where: { providerMessageId },
      });

      if (!notification) {
        console.warn(`Notification not found for provider message ID: ${providerMessageId}`);
        return { success: false, error: 'Notification not found' };
      }

      // Create event record
      await prisma.notificationEvent.create({
        data: {
          notificationId: notification.id,
          eventType,
          providerStatus: payload.status || payload.event,
          payload,
        },
      });

      // Update notification status based on event
      let newStatus = notification.status;
      if (payload.status === 'delivered' || payload.event === 'delivered') {
        newStatus = 'DELIVERED';
      } else if (payload.status === 'failed' || payload.event === 'failed') {
        newStatus = 'FAILED';
      }

      if (newStatus !== notification.status) {
        await prisma.notification.update({
          where: { id: notification.id },
          data: { status: newStatus },
        });
      }

      return { success: true, notificationId: notification.id };
    } catch (error) {
      console.error('Webhook event handling error:', error);
      throw error;
    }
  }
}