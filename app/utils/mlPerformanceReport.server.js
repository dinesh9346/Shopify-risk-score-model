import prisma from "../db.server.js";
import { NotificationService } from "../models/notification.server.js";

const notificationService = new NotificationService();

/**
 * CALCULATE ML MODEL PERFORMANCE METRICS
 * Analyzes orders from the past month and calculates accuracy, precision, recall
 */
export async function calculateMLPerformanceMetrics(shop = null) {
  try {
    console.log(`[ML REPORT] Starting performance calculation for shop: ${shop || 'ALL'}`);

    // Get data from last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Filter condition
    const whereCondition = {
      createdAt: { gte: thirtyDaysAgo }
    };
    if (shop) {
      whereCondition.shop = shop;
    }

    // ====== FETCH ALL RISK SCORES ======
    const allRiskScores = await prisma.zippyy_risk_score.findMany({
      where: whereCondition,
      include: {
        order: {
          include: {
            disputes: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    console.log(`[ML REPORT] Total risk scores found: ${allRiskScores.length}`);

    // Separate ML vs Manual assessments
    const mlAssessments = allRiskScores.filter(r => 
      r.assessmentMethod?.toUpperCase().includes('AUTO') || 
      r.assessmentMethod?.toUpperCase().includes('ML')
    );
    const manualAssessments = allRiskScores.filter(r => 
      r.assessmentMethod?.toUpperCase().includes('MANUAL') || 
      !r.assessmentMethod
    );

    console.log(`[ML REPORT] ML assessments: ${mlAssessments.length}, Manual assessments: ${manualAssessments.length}`);

    // ====== DETERMINE ACTUAL OUTCOMES ======
    function getActualOutcome(riskScore) {
      const order = riskScore.order;
      if (!order) return { status: 'UNKNOWN', label: '❓ Unknown' };

      const isDelivered = !order.isRTO && 
        order.fulfillmentStatus?.toUpperCase() === "FULFILLED" &&
        order.shipmentStatus?.toUpperCase() !== "UNDELIVERED";

      const isRTO = order.isRTO || 
        order.fulfillmentStatus?.toUpperCase() === "RETURNED" ||
        order.shipmentStatus?.toUpperCase()?.includes("RTO");

      const isCancelled = order.fulfillmentStatus?.toUpperCase() === "CANCELLED";
      const hasDispute = order.hasDispute || (order.disputes && order.disputes.length > 0);

      if (hasDispute) return { status: 'DISPUTE', label: '⚠️ Chargeback/Dispute' };
      if (isRTO) return { status: 'RTO', label: '📦 Return/RTO' };
      if (isCancelled) return { status: 'CANCELLED', label: '❌ Cancelled' };
      if (isDelivered) return { status: 'DELIVERED', label: '✅ Delivered' };
      
      return { status: 'PENDING', label: '⏳ Pending' };
    }

    // ====== CALCULATE METRICS FOR ML ======
    let mlMetrics = {
      totalOrders: mlAssessments.length,
      highRiskOrders: 0,
      mediumRiskOrders: 0,
      lowRiskOrders: 0,
      truePositives: 0,      // HIGH predicted & failed (RTO/Dispute/Cancelled)
      trueNegatives: 0,      // LOW predicted & delivered
      falsePositives: 0,     // HIGH predicted but delivered
      falseNegatives: 0,     // LOW predicted but failed
      correctPredictions: 0,
      predictions: []
    };

    // Process each ML assessment
    mlAssessments.forEach(riskScore => {
      const outcome = getActualOutcome(riskScore);
      const riskLevel = riskScore.riskLevel || 'MEDIUM';
      
      // Count risk levels
      if (riskLevel === 'HIGH') mlMetrics.highRiskOrders++;
      if (riskLevel === 'MEDIUM') mlMetrics.mediumRiskOrders++;
      if (riskLevel === 'LOW') mlMetrics.lowRiskOrders++;

      // Determine if prediction was correct
      const isFailed = ['DISPUTE', 'RTO', 'CANCELLED'].includes(outcome.status);
      const isSuccessful = outcome.status === 'DELIVERED';

      if (riskLevel === 'HIGH' && isFailed) {
        mlMetrics.truePositives++;
        mlMetrics.correctPredictions++;
      } else if (riskLevel === 'LOW' && isSuccessful) {
        mlMetrics.trueNegatives++;
        mlMetrics.correctPredictions++;
      } else if (riskLevel === 'HIGH' && isSuccessful) {
        mlMetrics.falsePositives++;
      } else if (riskLevel === 'LOW' && isFailed) {
        mlMetrics.falseNegatives++;
      }

      // Store prediction details
      mlMetrics.predictions.push({
        orderId: riskScore.order?.shopifyOrderId,
        predicted: riskLevel,
        actual: outcome.label,
        score: riskScore.score,
        correct: (riskLevel === 'HIGH' && isFailed) || (riskLevel === 'LOW' && isSuccessful)
      });
    });

    // Calculate accuracy, precision, recall
    mlMetrics.accuracy = mlMetrics.totalOrders > 0 
      ? ((mlMetrics.correctPredictions / mlMetrics.totalOrders) * 100).toFixed(2) 
      : 0;

    mlMetrics.precision = (mlMetrics.truePositives + mlMetrics.falsePositives) > 0
      ? ((mlMetrics.truePositives / (mlMetrics.truePositives + mlMetrics.falsePositives)) * 100).toFixed(2)
      : 0;

    mlMetrics.recall = (mlMetrics.truePositives + mlMetrics.falseNegatives) > 0
      ? ((mlMetrics.truePositives / (mlMetrics.truePositives + mlMetrics.falseNegatives)) * 100).toFixed(2)
      : 0;

    // ====== CALCULATE METRICS FOR MANUAL ======
    let manualMetrics = {
      totalOrders: manualAssessments.length,
      highRiskOrders: 0,
      mediumRiskOrders: 0,
      lowRiskOrders: 0,
      truePositives: 0,
      trueNegatives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      correctPredictions: 0,
      predictions: []
    };

    // Process each manual assessment
    manualAssessments.forEach(riskScore => {
      const outcome = getActualOutcome(riskScore);
      const riskLevel = riskScore.riskLevel || 'MEDIUM';
      
      if (riskLevel === 'HIGH') manualMetrics.highRiskOrders++;
      if (riskLevel === 'MEDIUM') manualMetrics.mediumRiskOrders++;
      if (riskLevel === 'LOW') manualMetrics.lowRiskOrders++;

      const isFailed = ['DISPUTE', 'RTO', 'CANCELLED'].includes(outcome.status);
      const isSuccessful = outcome.status === 'DELIVERED';

      if (riskLevel === 'HIGH' && isFailed) {
        manualMetrics.truePositives++;
        manualMetrics.correctPredictions++;
      } else if (riskLevel === 'LOW' && isSuccessful) {
        manualMetrics.trueNegatives++;
        manualMetrics.correctPredictions++;
      } else if (riskLevel === 'HIGH' && isSuccessful) {
        manualMetrics.falsePositives++;
      } else if (riskLevel === 'LOW' && isFailed) {
        manualMetrics.falseNegatives++;
      }

      manualMetrics.predictions.push({
        orderId: riskScore.order?.shopifyOrderId,
        predicted: riskLevel,
        actual: outcome.label,
        score: riskScore.score,
        correct: (riskLevel === 'HIGH' && isFailed) || (riskLevel === 'LOW' && isSuccessful)
      });
    });

    manualMetrics.accuracy = manualMetrics.totalOrders > 0 
      ? ((manualMetrics.correctPredictions / manualMetrics.totalOrders) * 100).toFixed(2) 
      : 0;

    manualMetrics.precision = (manualMetrics.truePositives + manualMetrics.falsePositives) > 0
      ? ((manualMetrics.truePositives / (manualMetrics.truePositives + manualMetrics.falsePositives)) * 100).toFixed(2)
      : 0;

    manualMetrics.recall = (manualMetrics.truePositives + manualMetrics.falseNegatives) > 0
      ? ((manualMetrics.truePositives / (manualMetrics.truePositives + manualMetrics.falseNegatives)) * 100).toFixed(2)
      : 0;

    console.log(`[ML REPORT] Metrics calculated. ML Accuracy: ${mlMetrics.accuracy}%, Manual Accuracy: ${manualMetrics.accuracy}%`);

    return {
      period: {
        startDate: thirtyDaysAgo.toLocaleDateString(),
        endDate: new Date().toLocaleDateString()
      },
      mlMetrics,
      manualMetrics,
      totalOrders: allRiskScores.length
    };

  } catch (error) {
    console.error(`[ML REPORT ERROR] Failed to calculate metrics:`, error);
    throw error;
  }
}

/**
 * GENERATE AND SEND ML PERFORMANCE REPORT EMAIL
 * Sends to specified team members with complete performance analysis
 */
export async function generateAndSendMLPerformanceReport(teamEmails = []) {
  try {
    console.log(`[ML REPORT] Generating performance report for ${teamEmails.length} recipients`);

    if (teamEmails.length === 0) {
      console.warn(`[ML REPORT] No team emails provided. Skipping report.`);
      return;
    }

    // Calculate metrics across all shops
    const report = await calculateMLPerformanceMetrics(null);

    const { mlMetrics, manualMetrics, period, totalOrders } = report;

    // Generate comparison HTML
    const comparisonHtml = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0;">
        <!-- ML MODEL SECTION -->
        <div style="background: #e0f2fe; padding: 20px; border-radius: 8px; border-left: 4px solid #0284c7;">
          <h3 style="margin-top: 0; color: #0c4a6e;">🤖 ML Model Performance</h3>
          <table style="width: 100%; font-size: 14px;">
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #bae6fd;"><strong>Total Orders</strong></td>
              <td style="padding: 8px; border-bottom: 1px solid #bae6fd; text-align: right;"><strong>${mlMetrics.totalOrders}</strong></td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #bae6fd;">🟢 Low Risk</td>
              <td style="padding: 8px; border-bottom: 1px solid #bae6fd; text-align: right;">${mlMetrics.lowRiskOrders}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #bae6fd;">🟡 Medium Risk</td>
              <td style="padding: 8px; border-bottom: 1px solid #bae6fd; text-align: right;">${mlMetrics.mediumRiskOrders}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #bae6fd;">🔴 High Risk</td>
              <td style="padding: 8px; border-bottom: 1px solid #bae6fd; text-align: right;">${mlMetrics.highRiskOrders}</td>
            </tr>
          </table>
        </div>

        <!-- MANUAL MODE SECTION -->
        <div style="background: #fef3c7; padding: 20px; border-radius: 8px; border-left: 4px solid #d97706;">
          <h3 style="margin-top: 0; color: #78350f;">👤 Manual Mode Performance</h3>
          <table style="width: 100%; font-size: 14px;">
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #fcd34d;"><strong>Total Orders</strong></td>
              <td style="padding: 8px; border-bottom: 1px solid #fcd34d; text-align: right;"><strong>${manualMetrics.totalOrders}</strong></td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #fcd34d;">🟢 Low Risk</td>
              <td style="padding: 8px; border-bottom: 1px solid #fcd34d; text-align: right;">${manualMetrics.lowRiskOrders}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #fcd34d;">🟡 Medium Risk</td>
              <td style="padding: 8px; border-bottom: 1px solid #fcd34d; text-align: right;">${manualMetrics.mediumRiskOrders}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #fcd34d;">🔴 High Risk</td>
              <td style="padding: 8px; border-bottom: 1px solid #fcd34d; text-align: right;">${manualMetrics.highRiskOrders}</td>
            </tr>
          </table>
        </div>
      </div>
    `;

    // Accuracy comparison
    const accuracyComparison = `
      <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #16a34a;">
        <h3 style="margin-top: 0; color: #15803d;">📊 Accuracy Metrics Comparison</h3>
        <table style="width: 100%; font-size: 14px;">
          <thead>
            <tr style="background: #86efac; border-bottom: 2px solid #22c55e;">
              <th style="padding: 12px; text-align: left;">Metric</th>
              <th style="padding: 12px; text-align: center;">ML Model</th>
              <th style="padding: 12px; text-align: center;">Manual Mode</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom: 1px solid #dcfce7;">
              <td style="padding: 12px;"><strong>Overall Accuracy</strong></td>
              <td style="padding: 12px; text-align: center; background: ${mlMetrics.accuracy >= 75 ? '#d1fae5' : '#fee2e2'};">${mlMetrics.accuracy}%</td>
              <td style="padding: 12px; text-align: center; background: ${manualMetrics.accuracy >= 75 ? '#d1fae5' : '#fee2e2'};">${manualMetrics.accuracy}%</td>
            </tr>
            <tr style="border-bottom: 1px solid #dcfce7;">
              <td style="padding: 12px;"><strong>Precision (Fraud Detection)</strong></td>
              <td style="padding: 12px; text-align: center;">${mlMetrics.precision}%</td>
              <td style="padding: 12px; text-align: center;">${manualMetrics.precision}%</td>
            </tr>
            <tr style="border-bottom: 1px solid #dcfce7;">
              <td style="padding: 12px;"><strong>Recall (True Positives)</strong></td>
              <td style="padding: 12px; text-align: center;">${mlMetrics.recall}%</td>
              <td style="padding: 12px; text-align: center;">${manualMetrics.recall}%</td>
            </tr>
            <tr style="border-bottom: 1px solid #dcfce7;">
              <td style="padding: 12px;"><strong>Correct Predictions</strong></td>
              <td style="padding: 12px; text-align: center;">${mlMetrics.correctPredictions} / ${mlMetrics.totalOrders}</td>
              <td style="padding: 12px; text-align: center;">${manualMetrics.correctPredictions} / ${manualMetrics.totalOrders}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    // Prediction breakdown
    const predictionBreakdown = `
      <div style="background: #fdf2f8; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #be185d;">
        <h3 style="margin-top: 0; color: #831843;">🎯 Prediction Breakdown</h3>
        <table style="width: 100%;">
          <thead>
            <tr style="background: #fbcfe8; border-bottom: 2px solid #ec4899;">
              <th style="padding: 12px; text-align: left;">Category</th>
              <th style="padding: 12px; text-align: center;">ML Model</th>
              <th style="padding: 12px; text-align: center;">Manual Mode</th>
            </tr>
          </thead>
          <tbody>
            <tr style="background: #e0f2fe; border-bottom: 1px solid #fbcfe8;">
              <td style="padding: 12px;">✅ True Positives (Correctly Flagged Fraud)</td>
              <td style="padding: 12px; text-align: center;"><strong>${mlMetrics.truePositives}</strong></td>
              <td style="padding: 12px; text-align: center;"><strong>${manualMetrics.truePositives}</strong></td>
            </tr>
            <tr style="border-bottom: 1px solid #fbcfe8;">
              <td style="padding: 12px;">✅ True Negatives (Correctly Approved Safe Orders)</td>
              <td style="padding: 12px; text-align: center;"><strong>${mlMetrics.trueNegatives}</strong></td>
              <td style="padding: 12px; text-align: center;"><strong>${manualMetrics.trueNegatives}</strong></td>
            </tr>
            <tr style="background: #fef3c7; border-bottom: 1px solid #fbcfe8;">
              <td style="padding: 12px;">❌ False Positives (Incorrectly Flagged as Fraud)</td>
              <td style="padding: 12px; text-align: center;"><strong>${mlMetrics.falsePositives}</strong></td>
              <td style="padding: 12px; text-align: center;"><strong>${manualMetrics.falsePositives}</strong></td>
            </tr>
            <tr style="background: #fee2e2;">
              <td style="padding: 12px;">❌ False Negatives (Missed Fraud Cases)</td>
              <td style="padding: 12px; text-align: center;"><strong>${mlMetrics.falseNegatives}</strong></td>
              <td style="padding: 12px; text-align: center;"><strong>${manualMetrics.falseNegatives}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { 
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
    background-color: #f9fafb; 
    margin: 0; 
    padding: 20px 0; 
  }
  .container { 
    max-width: 900px; 
    margin: 0 auto; 
    background-color: #ffffff; 
    border-radius: 12px; 
    overflow: hidden; 
    box-shadow: 0 10px 25px rgba(0,0,0,0.1); 
  }
  .header { 
    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); 
    color: #ffffff; 
    padding: 40px; 
    text-align: center; 
  }
  .header h1 { 
    margin: 0; 
    font-size: 28px; 
    font-weight: 700; 
  }
  .header p { 
    margin: 10px 0 0 0; 
    opacity: 0.9; 
    font-size: 16px; 
  }
  .content { 
    padding: 40px; 
  }
  .period { 
    background: #f0f9ff; 
    padding: 15px; 
    border-radius: 6px; 
    margin-bottom: 20px; 
    border-left: 4px solid #0284c7; 
    font-size: 14px; 
  }
  .footer { 
    text-align: center; 
    padding: 30px; 
    font-size: 13px; 
    color: #6b7280; 
    background-color: #f3f4f6; 
    border-top: 1px solid #e5e7eb; 
  }
  table { 
    width: 100%; 
    border-collapse: collapse; 
  }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 ML Model Performance Report</h1>
      <p>Monthly Performance Analysis - ML vs Manual Mode</p>
    </div>
    
    <div class="content">
      <div class="period">
        📅 <strong>Report Period:</strong> ${period.startDate} to ${period.endDate} | <strong>Total Orders Analyzed:</strong> ${totalOrders}
      </div>

      ${comparisonHtml}

      ${accuracyComparison}

      ${predictionBreakdown}

      <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h4 style="margin-top: 0;">📈 Key Insights</h4>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.8;">
          <li>
            <strong>ML Model:</strong> Processed <strong>${mlMetrics.totalOrders}</strong> orders with <strong>${mlMetrics.accuracy}%</strong> accuracy 
            (${mlMetrics.correctPredictions} correct predictions)
          </li>
          <li>
            <strong>Manual Mode:</strong> Processed <strong>${manualMetrics.totalOrders}</strong> orders with <strong>${manualMetrics.accuracy}%</strong> accuracy 
            (${manualMetrics.correctPredictions} correct predictions)
          </li>
          <li>
            <strong>Fraud Detection:</strong> ML Precision: ${mlMetrics.precision}% | Manual Precision: ${manualMetrics.precision}%
          </li>
          <li>
            <strong>False Positives (Customer Impact):</strong> ML: ${mlMetrics.falsePositives} | Manual: ${manualMetrics.falsePositives}
          </li>
          <li>
            <strong>False Negatives (Fraud Missed):</strong> ML: ${mlMetrics.falseNegatives} | Manual: ${manualMetrics.falseNegatives}
          </li>
        </ul>
      </div>

    </div>
    
    <div class="footer">
      ML Performance Report generated automatically by Zippyy Risk Score Model<br>
      © ${new Date().getFullYear()} Zippyy Logistics. All rights reserved.
    </div>
  </div>
</body>
</html>
    `;

    const subject = `📊 ML Model Performance Report - ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}`;
    const textBody = `ML Model Performance Report for ${period.startDate} to ${period.endDate}. Please view this email in an HTML-compatible client.`;

    // Send to each team member
    for (const email of teamEmails) {
      try {
        await notificationService.sendEmailNotification({
          recipient: email,
          subject: subject,
          text: textBody,
          html: htmlBody,
          shop: 'INTERNAL'  // Internal report, not shop-specific
        });
        console.log(`[ML REPORT] Email sent successfully to ${email}`);
      } catch (emailError) {
        console.error(`[ML REPORT] Failed to send email to ${email}:`, emailError);
      }
    }

    console.log(`[ML REPORT] Performance report sent to ${teamEmails.length} recipients`);

  } catch (error) {
    console.error(`[ML REPORT ERROR] Failed to generate report:`, error);
    throw error;
  }
}
