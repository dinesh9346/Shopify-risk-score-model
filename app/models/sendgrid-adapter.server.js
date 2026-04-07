import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export class SendGridAdapter {
  async sendEmail({ to, subject, html, text, from = 'support@godash.ai' }) {
    try {
      const msg = {
        to,
        from,
        subject,
        html,
        text,
      };

      const result = await sgMail.send(msg);

      return {
        success: true,
        providerMessageId: result[0]?.headers?.['x-message-id'] || `sg-${Date.now()}`,
        response: result[0],
      };
    } catch (error) {
      console.error('SendGrid send error:', error);
      return {
        success: false,
        error: error.message,
        response: error,
      };
    }
  }

  async sendTemplate({ to, templateId, templateData, from = 'noreply@zippyy.com' }) {
    try {
      const msg = {
        to,
        from,
        templateId,
        dynamicTemplateData: templateData,
      };

      const result = await sgMail.send(msg);

      return {
        success: true,
        providerMessageId: result[0]?.headers?.['x-message-id'] || `sg-${Date.now()}`,
        response: result[0],
      };
    } catch (error) {
      console.error('SendGrid template send error:', error);
      return {
        success: false,
        error: error.message,
        response: error,
      };
    }
  }
}