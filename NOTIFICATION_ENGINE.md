# Notification Engine

This notification engine provides email and WhatsApp messaging capabilities for the Zippyy Risk Score Model app.

## Features

- Send email notifications via SendGrid
- Send WhatsApp messages via configurable provider
- Track delivery status and events
- Webhook support for delivery acknowledgments
- Database persistence with Prisma

## API Endpoints

### Send Email Notification
```
POST /api/notifications/email
```

**Request Body:**
```json
{
  "recipient": "user@example.com",
  "subject": "Notification Subject",
  "html": "<p>HTML content</p>",
  "text": "Plain text content",
  "templateId": "optional-template-id",
  "templateData": {
    "key": "value"
  }
}
```

### Send WhatsApp Notification
```
POST /api/notifications/whatsapp
```

**Request Body:**
```json
{
  "recipient": "+1234567890",
  "message": "Hello from Zippyy!",
  "templateId": "optional-template-id",
  "templateData": {
    "components": [...]
  }
}
```

### Get Notification Status
```
GET /api/notifications/{id}
```

**Response:**
```json
{
  "id": "notification-id",
  "channel": "EMAIL",
  "recipient": "user@example.com",
  "status": "DELIVERED",
  "providerMessageId": "sg-12345",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z",
  "events": [...]
}
```

### Webhook for Delivery Events
```
POST /api/notifications/webhook/{provider}
```

Supported providers: `sendgrid`, `whatsapp`

## Environment Variables

```env
SENDGRID_API_KEY=your-sendgrid-api-key
WHATSAPP_API_KEY=your-whatsapp-api-key
WHATSAPP_BASE_URL=https://api.whatsapp.com/v1
NOTIFICATION_WEBHOOK_SECRET=your-webhook-secret
```

## Usage Examples

### Send Email
```javascript
const response = await fetch('/api/notifications/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    recipient: 'customer@example.com',
    subject: 'Risk Assessment Complete',
    html: '<h1>Your risk assessment is ready</h1>'
  })
});
```

### Send WhatsApp
```javascript
const response = await fetch('/api/notifications/whatsapp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    recipient: '+1234567890',
    message: 'Your order has been processed successfully!'
  })
});
```

### Check Status
```javascript
const response = await fetch('/api/notifications/notif-123');
const status = await response.json();
console.log('Status:', status.status);
```