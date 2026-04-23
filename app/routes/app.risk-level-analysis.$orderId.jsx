import { useLoaderData, useNavigate } from "react-router";
import { useState, useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  Box,
  InlineStack,
  Grid,
  ProgressBar,
  Button,
  Icon,
  Divider,
  InlineGrid,
  Tooltip,
  Banner,
  Link
} from "@shopify/polaris";
import { AlertTriangleIcon, CheckIcon, InfoIcon } from '@shopify/polaris-icons';
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// --- LOADER: Fetch order details and risk score ---
export const loader = async ({ params, request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const { orderId } = params;

  try {
    const riskScore = await prisma.zippyy_risk_score.findUnique({
      where: { 
        id: orderId
      },
      include: {
        order: {
          include: {
            disputes: true
          }
        }
      }
    });

    if (!riskScore || !riskScore.order) {
      return Response.json({ error: "Order not found", order: null }, { status: 404 });
    }

    const order = riskScore.order;
    const settingsSnapshot = riskScore.settingsSnapshot || {};

    // Parse reasons into an array
    const reasonsList = riskScore.reasons
      ? riskScore.reasons.split(/\s*\|\s*/).filter(Boolean)
      : [];

    return Response.json({
      order: {
        id: order.id,
        shopifyOrderId: order.shopifyOrderId,
        customerId: order.customerId,
        customerName: [order.firstName, order.lastName].filter(Boolean).join(" ") || "Guest",
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        orderValue: Number(order.orderValue),
        paymentGateway: order.paymentGateway,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        shipmentStatus: order.shipmentStatus,
        createdAt: order.createdAt,
        shippingAddress1: order.shippingAddress1,
        shippingCity: order.shippingCity,
        shippingProvince: order.shippingProvince,
        shippingZip: order.shippingZip,
        shippingCountry: order.shippingCountry,
        isRTO: order.isRTO,
        hasDispute: order.hasDispute,
        disputes: order.disputes || []
      },
      riskAssessment: {
        id: riskScore.id,
        score: riskScore.score,
        riskLevel: riskScore.riskLevel,
        assessmentMethod: riskScore.assessmentMethod,
        createdAt: riskScore.createdAt,
        reasonsList
      },
      weights: settingsSnapshot
    });

  } catch (error) {
    console.error("Loader error:", error);
    return Response.json({ error: error.message, order: null }, { status: 500 });
  }
};

// --- UTILITY: Generate dynamic suggestions ---
function generateSuggestions(order, riskScore, weights) {
  const suggestions = [];
  const reasonsList = riskScore.reasonsList || [];

  // Determine actual outcome
  const isDelivered = !order.isRTO && 
    order.fulfillmentStatus?.toUpperCase() === "FULFILLED" &&
    order.shipmentStatus?.toUpperCase() !== "UNDELIVERED";

  const isRTO = order.isRTO || 
    order.fulfillmentStatus?.toUpperCase() === "RETURNED" ||
    order.shipmentStatus?.toUpperCase()?.includes("RTO");

  const isCancelled = order.fulfillmentStatus?.toUpperCase() === "CANCELLED";

  const hasDispute = order.hasDispute || (order.disputes && order.disputes.length > 0);

  // LOGIC: High Risk but Delivered
  if (riskScore.riskLevel === "HIGH" && isDelivered) {
    suggestions.push({
      type: "REDUCE_WEIGHT",
      priority: "HIGH",
      title: "Order was delivered despite HIGH risk prediction",
      description: "This order was flagged as HIGH risk but was successfully delivered without issues. This suggests your risk weights may be too conservative.",
      actionableReasons: reasonsList.slice(0, 3),
      recommendations: [
        {
          reason: "Missing House Number",
          currentWeight: weights.missingHouseNoPenalty || 25,
          suggestion: "Reduce from " + (weights.missingHouseNoPenalty || 25) + " to 10-15",
          rationale: "Even without a house number, the order was delivered successfully."
        },
        {
          reason: "Guest Checkout + COD",
          currentWeight: weights.guestCodPenalty || 15,
          suggestion: "Reduce from " + (weights.guestCodPenalty || 15) + " to 5-10",
          rationale: "Guest COD orders can be risky, but many deliver successfully."
        },
        {
          reason: "Fake Address Flag",
          currentWeight: weights.fakeAddressPenalty || 80,
          suggestion: "Reduce from " + (weights.fakeAddressPenalty || 80) + " to 40-50",
          rationale: "The address was validated as fake but the order still delivered."
        },
        {
          reason: "New Customer Penalty",
          suggestion: "Review if new customer threshold is too aggressive",
          rationale: "New customers can be trustworthy; consider loyalty tracking instead."
        }
      ]
    });
  }

  // LOGIC: High Risk and RTO
  if (riskScore.riskLevel === "HIGH" && isRTO) {
    suggestions.push({
      type: "INCREASE_WEIGHT",
      priority: "MEDIUM",
      title: "HIGH risk prediction was accurate - order resulted in RTO",
      description: "Your risk scoring correctly identified this order as HIGH risk, and it resulted in a Return-To-Origin. The weights working as intended.",
      actionableReasons: reasonsList.slice(0, 3),
      recommendations: [
        {
          reason: "RTO History",
          suggestion: "Keep or slightly increase RTO weight of " + (weights.rtoWeight || 35),
          rationale: "The system is working - high RTO history correctly predicts RTO."
        },
        {
          reason: "COD Abuse Pattern",
          suggestion: "Keep COD abuse weight at " + (weights.codAbuseWeight || 20),
          rationale: "COD orders combined with RTO history are reliable risk signals."
        }
      ]
    });
  }

  // LOGIC: Medium Risk but Delivered
  if (riskScore.riskLevel === "MEDIUM" && isDelivered) {
    suggestions.push({
      type: "REDUCE_WEIGHT",
      priority: "LOW",
      title: "Order delivered despite MEDIUM risk - weights may be slightly high",
      description: "This order was MEDIUM risk but delivered successfully. Minor weight reductions could improve conversion rates.",
      recommendations: [
        {
          reason: "General Rebalancing",
          suggestion: "Reduce medium-weight penalties by 5-10 points",
          rationale: "Medium risk orders delivered suggests weights are slightly conservative."
        }
      ]
    });
  }

  // LOGIC: Low Risk but RTO
  if (riskScore.riskLevel === "LOW" && isRTO) {
    suggestions.push({
      type: "INCREASE_WEIGHT",
      priority: "CRITICAL",
      title: "⚠️ Order was LOW risk but resulted in RTO - weights are too low",
      description: "This is a false negative. The system should have flagged this as risky. Increase relevant weights.",
      actionableReasons: reasonsList,
      recommendations: [
        {
          reason: "Check Order Characteristics",
          suggestion: "This customer may need to be added to fraud watch list",
          rationale: "If LOW risk customers often have RTOs, the model is not capturing key signals."
        },
        {
          reason: "Address/Phone/Email",
          suggestion: "Verify if there are network fraud signals (multiple emails, shared addresses)",
          rationale: "Often RTOs correlate with fraudulent networks."
        }
      ]
    });
  }

  // LOGIC: Specific Weight Analysis
  reasonsList.forEach((reason) => {
    if (isDelivered && reason.includes("Missing House No")) {
      suggestions.push({
        type: "FINE_TUNE",
        title: "Delivered without house number - reduce penalty",
        reason: "Missing House No",
        suggestion: "Reduce missingHouseNoPenalty from " + (weights.missingHouseNoPenalty || 25) + " to 10"
      });
    }
    if (isDelivered && reason.includes("Fake") && reason.includes("Address")) {
      suggestions.push({
        type: "FINE_TUNE",
        title: "Fake address marked but delivered successfully",
        reason: "Fake Address Penalty",
        suggestion: "Review address validation API - may have false positives. Reduce from " + (weights.fakeAddressPenalty || 80) + " to 50"
      });
    }
  });

  return suggestions;
}

// --- WEIGHT BREAKDOWN COMPONENT ---
function WeightBreakdown({ weights, reasonsList }) {
  const weightDetails = [
    { key: "invalidEmailPenalty", label: "Fake Email", category: "Identity & Checkout" },
    { key: "guestCodPenalty", label: "Guest Checkout + COD", category: "Identity & Checkout" },
    { key: "shortNamePenalty", label: "Suspicious/Short Name", category: "Identity & Checkout" },
    { key: "missingEmailPenalty", label: "Missing Email", category: "Identity & Checkout" },
    { key: "suspiciousTimingPenalty", label: "Suspicious Timing", category: "Identity & Checkout" },
    { key: "pendingPaymentPenalty", label: "Pending Payment", category: "Identity & Checkout" },
    { key: "missingAddressPenalty", label: "Missing Address", category: "Address & Logistics" },
    { key: "missingHouseNoPenalty", label: "Missing House No.", category: "Address & Logistics" },
    { key: "fakeAddressPenalty", label: "Fake Address", category: "Address & Logistics" },
    { key: "cancelWeight", label: "Cancellation Rate", category: "Historical Behavior" },
    { key: "rtoWeight", label: "RTO Rate", category: "Historical Behavior" },
    { key: "refundWeight", label: "Refund Rate", category: "Historical Behavior" },
    { key: "zeroValuePenalty", label: "Zero Value Customer", category: "Historical Behavior" },
    { key: "codAbuseWeight", label: "COD Abuse", category: "Historical Behavior" },
    { key: "valueAnomalyPenalty", label: "Order Value Anomaly", category: "Historical Behavior" },
    { key: "hoardingPenalty", label: "Targeted Hoarding", category: "Fraud Networks" },
    { key: "emailFraudPenalty", label: "Email Network Abuse", category: "Fraud Networks" },
    { key: "phoneFraudPenalty", label: "Phone Network Abuse", category: "Fraud Networks" },
    { key: "disputeWeight", label: "Chargeback Loss Rate", category: "Fraud Networks" },
    { key: "openDisputePenalty", label: "Active Dispute Risk", category: "Fraud Networks" },
    { key: "fraudHistoryPenalty", label: "Fraud History", category: "Fraud Networks" },
    { key: "loyaltyBonus", label: "Loyalty Bonus", category: "Rewards" }
  ];

  const usedWeights = weightDetails.filter(w => {
    const reason = reasonsList.find(r => r.includes(w.label) || (w.key === "guestCodPenalty" && r.includes("Guest")) || (w.key === "shortNamePenalty" && r.includes("Name")));
    return !!reason;
  });

  const categories = [...new Set(usedWeights.map(w => w.category))];

  return (
    <BlockStack gap="400">
      {categories.map(category => {
        const categoryWeights = usedWeights.filter(w => w.category === category);
        return (
          <div key={category}>
            <Text as="h3" variant="headingMd" tone="subdued">{category}</Text>
            <BlockStack gap="200" paddingBlockStart="200">
              {categoryWeights.map(weight => (
                <Box 
                  key={weight.key} 
                  padding="200" 
                  background="bg-surface-secondary" 
                  borderRadius="100"
                  borderWidth="100"
                  borderColor="border-subdued"
                >
                  <InlineStack gap="200" align="space-between">
                    <BlockStack gap="100" grow>
                      <Text fontWeight="medium">{weight.label}</Text>
                      <Text tone="subdued" variant="bodySm">
                        Weight: {weights[weight.key] ?? 0} points
                      </Text>
                    </BlockStack>
                    {reasonsList.some(r => r.includes(weight.label) || (weight.key === "guestCodPenalty" && r.includes("Guest"))) && (
                      <Badge tone="attention" size="small">Applied</Badge>
                    )}
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </div>
        );
      })}
    </BlockStack>
  );
}

// --- SUGGESTION CARD COMPONENT ---
function SuggestionCard({ suggestion }) {
  const getSentiment = () => {
    if (suggestion.type === "INCREASE_WEIGHT") return { icon: AlertTriangleIcon, tone: "critical" };
    if (suggestion.type === "REDUCE_WEIGHT") return { icon: CheckIcon, tone: "success" };
    return { icon: InfoIcon, tone: "info" };
  };

  const sentiment = getSentiment();

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="start">
          <Box>
            <Icon source={sentiment.icon} tone={sentiment.tone} />
          </Box>
          <BlockStack gap="100" grow>
            <Text fontWeight="bold">{suggestion.title}</Text>
            <Text tone="subdued" variant="bodySm">{suggestion.description}</Text>
          </BlockStack>
        </InlineStack>

        {suggestion.recommendations && suggestion.recommendations.length > 0 && (
          <>
            <Divider />
            <BlockStack gap="200">
              <Text variant="headingMd" as="h4">Specific Recommendations:</Text>
              {suggestion.recommendations.map((rec, idx) => (
                <Box key={idx} paddingBlockStart="100">
                  <BlockStack gap="100">
                    <Text fontWeight="medium" variant="bodySm">{rec.reason}</Text>
                    <Box background="bg-surface-tertiary" padding="150" borderRadius="100">
                      <BlockStack gap="100">
                        <Text variant="bodySm"><strong>Suggestion:</strong> {rec.suggestion}</Text>
                        <Text variant="bodySm" tone="subdued"><strong>Why:</strong> {rec.rationale}</Text>
                      </BlockStack>
                    </Box>
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

// --- MAIN PAGE COMPONENT ---
export default function RiskLevelAnalysis() {
  const data = useLoaderData();
  const navigate = useNavigate();

  if (data.error) {
    return (
      <Page
        title="Risk Level Analysis"
        backAction={{ onAction: () => navigate("/app/assessments") }}
      >
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingLg" tone="critical">Error Loading Order</Text>
                <Text>{data.error}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const { order, riskAssessment, weights } = data;
  const suggestions = useMemo(() => generateSuggestions(order, riskAssessment, weights), [order, riskAssessment, weights]);

  // Determine delivery status
  const isDelivered = !order.isRTO && 
    order.fulfillmentStatus?.toUpperCase() === "FULFILLED" &&
    order.shipmentStatus?.toUpperCase() !== "UNDELIVERED";

  const isRTO = order.isRTO || 
    order.fulfillmentStatus?.toUpperCase() === "RETURNED" ||
    order.shipmentStatus?.toUpperCase()?.includes("RTO");

  const isCancelled = order.fulfillmentStatus?.toUpperCase() === "CANCELLED";

  return (
    <Page
      title={`Risk Level Analysis - #${order.shopifyOrderId}`}
      backAction={{ onAction: () => navigate("/app/assessments") }}
    >
      <Layout>
        {/* --- ORDER HEADER --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h1" variant="heading2xl">Order #{order.shopifyOrderId}</Text>
                  <InlineStack gap="200">
                    <Text tone="subdued" variant="bodySm">
                      {new Date(order.createdAt).toLocaleDateString()} • ₹{order.orderValue.toFixed(2)}
                    </Text>
                  </InlineStack>
                </BlockStack>
                <Box>
                  <Badge tone={isDelivered ? "success" : isRTO ? "critical" : "warning"} size="large">
                    {isDelivered ? "✓ DELIVERED" : isRTO ? "✗ RTO" : isCancelled ? "CANCELLED" : order.fulfillmentStatus || "PENDING"}
                  </Badge>
                </Box>
              </InlineStack>

              <Divider />

              <Grid columns={{ xs: 1, md: 2 }}>
                <BlockStack gap="200">
                  <Text variant="headingMd" as="h3">Customer Details</Text>
                  <Box paddingBlockStart="100">
                    <BlockStack gap="150">
                      <InlineStack gap="200">
                        <Text tone="subdued" variant="bodySm">Name:</Text>
                        <Text variant="bodySm">{order.customerName}</Text>
                      </InlineStack>
                      {order.customerEmail && (
                        <InlineStack gap="200">
                          <Text tone="subdued" variant="bodySm">Email:</Text>
                          <Text variant="bodySm">{order.customerEmail}</Text>
                        </InlineStack>
                      )}
                      {order.customerPhone && (
                        <InlineStack gap="200">
                          <Text tone="subdued" variant="bodySm">Phone:</Text>
                          <Text variant="bodySm">{order.customerPhone}</Text>
                        </InlineStack>
                      )}
                    </BlockStack>
                  </Box>
                </BlockStack>

                <BlockStack gap="200">
                  <Text variant="headingMd" as="h3">Order Details</Text>
                  <Box paddingBlockStart="100">
                    <BlockStack gap="150">
                      <InlineStack gap="200">
                        <Text tone="subdued" variant="bodySm">Payment:</Text>
                        <Text variant="bodySm">{order.paymentGateway || "Unknown"}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Text tone="subdued" variant="bodySm">Financial Status:</Text>
                        <Text variant="bodySm">{order.financialStatus || "Unknown"}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Text tone="subdued" variant="bodySm">Fulfillment:</Text>
                        <Text variant="bodySm">{order.fulfillmentStatus || "Unknown"}</Text>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                </BlockStack>
              </Grid>

              {order.shippingAddress1 && (
                <>
                  <Divider />
                  <BlockStack gap="200">
                    <Text variant="headingMd" as="h3">Shipping Address</Text>
                    <Box paddingBlockStart="100">
                      <Text variant="bodySm">
                        {order.shippingAddress1}
                        {order.shippingAddress2 && `, ${order.shippingAddress2}`}
                        {order.shippingCity && `, ${order.shippingCity}`}
                        {order.shippingProvince && `, ${order.shippingProvince}`}
                        {order.shippingZip && ` ${order.shippingZip}`}
                      </Text>
                    </Box>
                  </BlockStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- RISK ASSESSMENT SUMMARY --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">Risk Assessment Results</Text>
              <Divider />

              <Grid columns={{ xs: 1, md: 3 }}>
                <BlockStack gap="100">
                  <Text tone="subdued" variant="bodySm">Risk Score</Text>
                  <Box paddingBlockStart="200">
                    <ProgressBar progress={riskAssessment.score} size="medium" />
                    <Text as="h3" variant="heading2xl" alignment="center" paddingBlockStart="200">
                      {riskAssessment.score}%
                    </Text>
                  </Box>
                </BlockStack>

                <BlockStack gap="100">
                  <Text tone="subdued" variant="bodySm">Risk Level</Text>
                  <Box paddingBlockStart="200">
                    <Badge 
                      tone={riskAssessment.riskLevel === "HIGH" ? "critical" : riskAssessment.riskLevel === "MEDIUM" ? "warning" : "success"} 
                      size="large"
                    >
                      {riskAssessment.riskLevel}
                    </Badge>
                  </Box>
                </BlockStack>

                <BlockStack gap="100">
                  <Text tone="subdued" variant="bodySm">Assessment Method</Text>
                  <Box paddingBlockStart="200">
                    <Badge tone={riskAssessment.assessmentMethod === "MANUAL" ? "info" : "warning"}>
                      {riskAssessment.assessmentMethod}
                    </Badge>
                  </Box>
                </BlockStack>
              </Grid>

              <Divider />

              <BlockStack gap="200">
                <Text variant="headingMd" as="h3">Risk Factors Applied</Text>
                <BlockStack gap="150">
                  {riskAssessment.reasonsList.map((reason, idx) => (
                    <InlineStack key={idx} gap="200" blockAlign="start">
                      <Box paddingBlockStart="50">
                        <Icon source={AlertTriangleIcon} tone="warning" />
                      </Box>
                      <Text variant="bodySm">{reason}</Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- DYNAMIC SUGGESTIONS --- */}
        {suggestions.length > 0 && (
          <Layout.Section>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">🎯 Optimization Suggestions</Text>

              {suggestions.map((suggestion, idx) => (
                <SuggestionCard key={idx} suggestion={suggestion} />
              ))}
            </BlockStack>
          </Layout.Section>
        )}

        {/* --- WEIGHT BREAKDOWN --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">Weight Configuration Used</Text>
              <Divider />
              <Text tone="subdued" variant="bodySm">
                These are the weights that were active when this order was assessed. Weights with checkmarks were applied to this order's risk calculation.
              </Text>

              <Box paddingBlockStart="300">
                <WeightBreakdown weights={weights} reasonsList={riskAssessment.reasonsList} />
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- ACTION BUTTONS --- */}
        <Layout.Section>
          <InlineStack gap="200">
            <Button 
              onClick={() => navigate("/app/risk-engine")} 
              variant="secondary"
            >
              Adjust Weights
            </Button>
            <Button onClick={() => navigate("/app/assessments")}>
              Back to Assessments
            </Button>
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
