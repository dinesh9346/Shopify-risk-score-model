import prisma from "../db.server";
import { NotificationService } from "../models/notification.server.js";

const notificationService = new NotificationService();

export async function generateAndSendMerchantReport(shop, reportType = "weekly") {
  console.log(`[REPORT SERVICE] Generating ${reportType} report for ${shop}`);

  // 1. Determine Date Range
  const now = new Date();
  const startDate = new Date();
  if (reportType === "weekly") {
    startDate.setDate(now.getDate() - 7);
  } else if (reportType === "monthly") {
    startDate.setMonth(now.getMonth() - 1);
  }

  // 2. Aggregate Data using your specific schema
  
  // Total Orders Evaluated
  const totalOrders = await prisma.shopify_store_order.count({
    where: { shop, createdAt: { gte: startDate } }
  });

  // Risk Score Breakdown
  const riskGroups = await prisma.zippyy_risk_score.groupBy({
    by: ['riskLevel'],
    where: { shop, createdAt: { gte: startDate } },
    _count: { riskLevel: true }
  });

  let lowRisk = 0, mediumRisk = 0, highRisk = 0;
  riskGroups.forEach(group => {
    if (group.riskLevel === 'LOW') lowRisk = group._count.riskLevel;
    if (group.riskLevel === 'MEDIUM') mediumRisk = group._count.riskLevel;
    if (group.riskLevel === 'HIGH') highRisk = group._count.riskLevel;
  });

  // Financials: Net Revenue (Ignoring Cancelled Orders)
  const financialStats = await prisma.shopify_store_order.aggregate({
    where: { 
      shop, 
      createdAt: { gte: startDate },
      cancelledAt: null // Exclude cancelled orders for net revenue
    },
    _sum: { orderValue: true }
  });
  const netRevenueProcessed = financialStats._sum.orderValue || 0;

  // Operational Metrics
  const rtoCount = await prisma.shopify_store_order.count({
    where: { shop, createdAt: { gte: startDate }, isRTO: true }
  });

  const disputeCount = await prisma.shopify_store_order.count({
    where: { shop, createdAt: { gte: startDate }, hasDispute: true }
  });

  // 3. Fetch Merchant Email (Assuming you store the merchant's email in the Session or a separate Shop config table)
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false }, // Use offline session to get merchant email
    select: { email: true }
  });

  const merchantEmail = session?.email;

  if (!merchantEmail) {
    console.warn(`[REPORT SERVICE] No email found for shop ${shop}. Skipping report.`);
    return;
  }

  // 4. Build and Send Email
  const subject = `Your Zippyy ${reportType === 'weekly' ? 'Weekly' : 'Monthly'} Risk Report`;
  
  // Add this inside your generateAndSendMerchantReport function (replacing the plain text version)

const htmlBody = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; margin: 0; padding: 40px 0; }
  .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
  .header { background-color: #000000; color: #ffffff; padding: 30px; text-align: center; }
  .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
  .content { padding: 30px; }
  .greeting { font-size: 16px; color: #3f3f46; margin-bottom: 24px; }
  .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 30px; }
  .stat-box { background-color: #f4f4f5; padding: 20px; border-radius: 6px; text-align: center; }
  .stat-value { font-size: 24px; font-weight: bold; color: #18181b; margin-bottom: 4px; }
  .stat-label { font-size: 13px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; }
  .section-title { font-size: 18px; font-weight: 600; color: #18181b; margin-bottom: 16px; border-bottom: 2px solid #f4f4f5; padding-bottom: 8px; }
  .risk-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e4e4e7; }
  .risk-label { font-size: 15px; font-weight: 500; }
  .risk-value { font-size: 15px; font-weight: bold; }
  .low { color: #10b981; }
  .medium { color: #f59e0b; }
  .high { color: #ef4444; }
  .footer { text-align: center; padding: 30px; font-size: 13px; color: #a1a1aa; background-color: #fafafa; border-top: 1px solid #e4e4e7; }
  .btn { display: inline-block; background-color: #000000; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 500; margin-top: 20px; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Zippyy Risk Intelligence</h1>
      <p style="margin-top: 8px; color: #a1a1aa;">Your ${reportType === 'weekly' ? 'Weekly' : 'Monthly'} Performance Report</p>
    </div>
    
    <div class="content">
      <div class="greeting">Hello, here is your store's risk and fraud assessment for the past ${reportType === 'weekly' ? '7' : '30'} days.</div>
      
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-value">${totalOrders}</div>
          <div class="stat-label">Orders Evaluated</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">₹${netRevenueProcessed.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
          <div class="stat-label">Net Revenue</div>
        </div>
      </div>

      <div class="section-title">Traffic Risk Breakdown</div>
      <div class="risk-row low">
        <span class="risk-label">🟢 Safe Orders (Low Risk)</span>
        <span class="risk-value">${lowRisk}</span>
      </div>
      <div class="risk-row medium">
        <span class="risk-label">🟡 Flagged for Review (Medium)</span>
        <span class="risk-value">${mediumRisk}</span>
      </div>
      <div class="risk-row high">
        <span class="risk-label">🔴 High Risk / Fraud Prevented</span>
        <span class="risk-value">${highRisk}</span>
      </div>

      <div style="margin-top: 30px;">
        <div class="section-title">Operational Alerts</div>
        <div class="risk-row">
          <span class="risk-label" style="color: #3f3f46;">RTOs Tracked</span>
          <span class="risk-value" style="color: ${rtoCount > 0 ? '#f59e0b' : '#10b981'};">${rtoCount}</span>
        </div>
        <div class="risk-row" style="border-bottom: none;">
          <span class="risk-label" style="color: #3f3f46;">New Disputes Logged</span>
          <span class="risk-value" style="color: ${disputeCount > 0 ? '#ef4444' : '#10b981'};">${disputeCount}</span>
        </div>
      </div>

      <div style="text-align: center; margin-top: 10px;">
        <a href="https://${shop}/admin/apps/zippyy" class="btn">View Dashboard</a>
      </div>
    </div>
    
    <div class="footer">
      This report was generated automatically by Zippyy Risk Score Model for ${shop}.<br>
      © ${new Date().getFullYear()} Zippyy Logistics. All rights reserved.
    </div>
  </div>
</body>
</html>
`;

  await notificationService.sendEmailNotification({
    shop,
    recipient: merchantEmail,
    subject: subject,
    text: textBody,
    // html: myHtmlTemplate // Add this if your notificationService supports HTML!
  });

  console.log(`[REPORT SERVICE] ${reportType} report successfully sent to ${merchantEmail} for ${shop}`);
}