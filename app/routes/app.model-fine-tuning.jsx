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
  Divider,
  Tabs,
  Button,
  Icon,
  Banner,
  EmptyState
} from "@shopify/polaris";
import { AlertTriangleIcon, CheckIcon, InfoIcon } from '@shopify/polaris-icons';
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// --- LOADER: Fetch edge case orders for model fine-tuning ---
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    // Get orders processed by MANUAL model
    const manualOrders = await prisma.zippyy_risk_score.findMany({
      where: { 
        shop,
        assessmentMethod: "MANUAL"
      },
      include: {
        order: {
          include: {
            disputes: true
          }
        }
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });

    // Classify orders into categories
    const falsePositives = []; // HIGH risk but delivered successfully
    const falseNegatives = []; // LOW risk but resulted in fraud/chargeback/cancellation

    manualOrders.forEach((riskScore) => {
      const order = riskScore.order;
      if (!order) return;

      // Determine actual outcome
      const isDelivered = !order.isRTO && 
        order.fulfillmentStatus?.toUpperCase() === "FULFILLED" &&
        order.shipmentStatus?.toUpperCase() !== "UNDELIVERED";

      const isRTO = order.isRTO || 
        order.fulfillmentStatus?.toUpperCase() === "RETURNED" ||
        order.shipmentStatus?.toUpperCase()?.includes("RTO");

      const isCancelled = order.fulfillmentStatus?.toUpperCase() === "CANCELLED";
      const hasDispute = order.hasDispute || (order.disputes && order.disputes.length > 0);
      const isChargeback = isCancelled || isRTO || hasDispute;

      // FALSE POSITIVE: HIGH risk but delivered
      if (riskScore.riskLevel === "HIGH" && isDelivered) {
        falsePositives.push({
          id: riskScore.id,
          orderId: order.shopifyOrderId,
          customerId: order.customerId,
          customerName: [order.firstName, order.lastName].filter(Boolean).join(" ") || "Guest",
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone,
          orderValue: Number(order.orderValue),
          paymentGateway: order.paymentGateway,
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          shippingAddress1: order.shippingAddress1,
          shippingCity: order.shippingCity,
          shippingProvince: order.shippingProvince,
          shippingZip: order.shippingZip,
          shippingCountry: order.shippingCountry,
          createdAt: order.createdAt,
          riskScore: riskScore.score,
          riskLevel: riskScore.riskLevel,
          reasons: riskScore.reasons || "",
          settingsSnapshot: riskScore.settingsSnapshot || {},
          caseType: "FALSE_POSITIVE"
        });
      }

      // FALSE NEGATIVE: LOW risk but resulted in chargeback/fraud/cancellation
      if (riskScore.riskLevel === "LOW" && isChargeback) {
        falseNegatives.push({
          id: riskScore.id,
          orderId: order.shopifyOrderId,
          customerId: order.customerId,
          customerName: [order.firstName, order.lastName].filter(Boolean).join(" ") || "Guest",
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone,
          orderValue: Number(order.orderValue),
          paymentGateway: order.paymentGateway,
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          shippingAddress1: order.shippingAddress1,
          shippingCity: order.shippingCity,
          shippingProvince: order.shippingProvince,
          shippingZip: order.shippingZip,
          shippingCountry: order.shippingCountry,
          createdAt: order.createdAt,
          riskScore: riskScore.score,
          riskLevel: riskScore.riskLevel,
          reasons: riskScore.reasons || "",
          settingsSnapshot: riskScore.settingsSnapshot || {},
          caseType: "FALSE_NEGATIVE",
          outcome: isChargeback ? "CHARGEBACK" : isRTO ? "RTO" : "CANCELLED"
        });
      }
    });

    return Response.json({
      error: null,
      falsePositives,
      falseNegatives,
      totalManualOrders: manualOrders.length
    });

  } catch (error) {
    console.error("Loader error:", error);
    return Response.json({
      error: error.message,
      falsePositives: [],
      falseNegatives: [],
      totalManualOrders: 0
    });
  }
};

// --- WEIGHT RECOMMENDATION COMPONENT ---
function WeightRecommendations({ reasons, caseType, weights }) {
  const reasonsList = reasons
    ? reasons.split(/[|,\n]/).map((r) => r.trim()).filter(Boolean)
    : [];

  const recommendations = [];

  if (caseType === "FALSE_POSITIVE") {
    // HIGH risk but delivered - reduce these weights
    recommendations.push({
      action: "REDUCE",
      title: "Reduce Conservative Weights",
      description: "These weights were too strict and caused a false positive",
      items: reasonsList.map(reason => ({
        reason,
        currentWeight: "See weight configuration below",
        suggestion: `Evaluate reducing weight for: ${reason}`
      }))
    });
  } else if (caseType === "FALSE_NEGATIVE") {
    // LOW risk but failed - increase these weights
    recommendations.push({
      action: "INCREASE",
      title: "Increase Risk Weights",
      description: "These risk factors were missed or underweighted, causing a false negative",
      items: reasonsList.map(reason => ({
        reason,
        suggestion: `Consider increasing weight for: ${reason}`
      }))
    });
  }

  return (
    <BlockStack gap="200">
      {recommendations.map((rec, idx) => (
        <Box 
          key={idx} 
          padding="300" 
          background={rec.action === "REDUCE" ? "bg-surface-success-subdued" : "bg-surface-critical-subdued"}
          borderRadius="200"
        >
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Icon 
                source={rec.action === "REDUCE" ? CheckIcon : AlertTriangleIcon}
                tone={rec.action === "REDUCE" ? "success" : "critical"}
              />
              <Text fontWeight="bold">{rec.title}</Text>
            </InlineStack>
            <Text tone="subdued" variant="bodySm">{rec.description}</Text>
            
            <BlockStack gap="150" paddingBlockStart="100">
              {rec.items.map((item, itemIdx) => (
                <Box key={itemIdx} paddingBlockStart="100">
                  <Text variant="bodySm"><strong>• {item.reason}</strong></Text>
                  {item.currentWeight && (
                    <Text variant="bodySm" tone="subdued" paddingBlockStart="50">
                      Current: {item.currentWeight}
                    </Text>
                  )}
                  <Text variant="bodySm" tone="subdued" paddingBlockStart="50">
                    Action: {item.suggestion}
                  </Text>
                </Box>
              ))}
            </BlockStack>
          </BlockStack>
        </Box>
      ))}
    </BlockStack>
  );
}

// --- ORDER CASE CARD COMPONENT ---
function OrderCaseCard({ order, index }) {
  const reasonsList = order.reasons
    ? order.reasons.split(/[|,\n]/).map((r) => r.trim()).filter(Boolean)
    : [];

  const formattedDate = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(order.createdAt));

  const getOutcomeColor = () => {
    if (order.caseType === "FALSE_POSITIVE") return "success";
    return "critical";
  };

  const getOutcomeLabel = () => {
    if (order.caseType === "FALSE_POSITIVE") return "Delivered (Safe Order)";
    return `${order.outcome} (Risky Order)`;
  };

  return (
    <Card key={order.id}>
      <BlockStack gap="300">
        {/* Header */}
        <InlineStack gap="200" align="space-between" blockAlign="center">
          <BlockStack gap="100" grow>
            <Text as="h3" variant="headingMd">Order #{order.orderId || "N/A"}</Text>
            <Text tone="subdued" variant="bodySm">
              {formattedDate} • ₹{order.orderValue.toFixed(2)}
            </Text>
          </BlockStack>
          <Box>
            <Badge tone={getOutcomeColor()} size="large">
              {getOutcomeLabel()}
            </Badge>
          </Box>
        </InlineStack>

        <Divider />

        {/* Customer & Order Details */}
        <Grid columns={{ xs: 1, md: 2 }}>
          <BlockStack gap="200">
            <Text variant="headingMd" as="h4" tone="subdued">Customer Details</Text>
            <BlockStack gap="150">
              <InlineStack gap="200">
                <Text tone="subdued" variant="bodySm" minWidth="80px">Name:</Text>
                <Text variant="bodySm">{order.customerName}</Text>
              </InlineStack>
              {order.customerEmail && (
                <InlineStack gap="200">
                  <Text tone="subdued" variant="bodySm" minWidth="80px">Email:</Text>
                  <Text variant="bodySm">{order.customerEmail}</Text>
                </InlineStack>
              )}
              {order.customerPhone && (
                <InlineStack gap="200">
                  <Text tone="subdued" variant="bodySm" minWidth="80px">Phone:</Text>
                  <Text variant="bodySm">{order.customerPhone}</Text>
                </InlineStack>
              )}
            </BlockStack>
          </BlockStack>

          <BlockStack gap="200">
            <Text variant="headingMd" as="h4" tone="subdued">Order Details</Text>
            <BlockStack gap="150">
              <InlineStack gap="200">
                <Text tone="subdued" variant="bodySm" minWidth="80px">Payment:</Text>
                <Text variant="bodySm">{order.paymentGateway || "Unknown"}</Text>
              </InlineStack>
              <InlineStack gap="200">
                <Text tone="subdued" variant="bodySm" minWidth="80px">Status:</Text>
                <Text variant="bodySm">{order.fulfillmentStatus || "Unknown"}</Text>
              </InlineStack>
              <InlineStack gap="200">
                <Text tone="subdued" variant="bodySm" minWidth="80px">Financial:</Text>
                <Text variant="bodySm">{order.financialStatus || "Unknown"}</Text>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Grid>

        {/* Shipping Address */}
        {order.shippingAddress1 && (
          <>
            <Divider />
            <BlockStack gap="100">
              <Text variant="headingMd" as="h4" tone="subdued">Shipping Address</Text>
              <Text variant="bodySm">
                {order.shippingAddress1}
                {order.shippingCity && `, ${order.shippingCity}`}
                {order.shippingProvince && `, ${order.shippingProvince}`}
                {order.shippingZip && ` ${order.shippingZip}`}
              </Text>
            </BlockStack>
          </>
        )}

        {/* Risk Assessment */}
        <Divider />
        <BlockStack gap="200">
          <Text variant="headingMd" as="h4" tone="subdued">Model Prediction</Text>
          <InlineStack gap="300">
            <BlockStack gap="100">
              <Text tone="subdued" variant="bodySm">Risk Score</Text>
              <Badge tone={order.riskLevel === "HIGH" ? "critical" : "success"}>
                {order.riskScore}% - {order.riskLevel}
              </Badge>
            </BlockStack>
          </InlineStack>
        </BlockStack>

        {/* Risk Reasons */}
        {reasonsList.length > 0 && (
          <>
            <Divider />
            <BlockStack gap="200">
              <Text variant="headingMd" as="h4" tone="subdued">Risk Factors That Triggered</Text>
              <BlockStack gap="100">
                {reasonsList.map((reason, idx) => (
                  <InlineStack key={idx} gap="100" blockAlign="start">
                    <Text variant="bodySm">•</Text>
                    <Text variant="bodySm">{reason}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </>
        )}

        {/* Weight Recommendations */}
        <Divider />
        <WeightRecommendations 
          reasons={order.reasons} 
          caseType={order.caseType}
          weights={order.settingsSnapshot}
        />
      </BlockStack>
    </Card>
  );
}

// --- MAIN PAGE COMPONENT ---
export default function ModelFineTuning() {
  const data = useLoaderData();
  const navigate = useNavigate();
  const [selectedTab, setSelectedTab] = useState(0);

  if (data.error) {
    return (
      <Page title="Model Fine-Tuning">
        <Layout>
          <Layout.Section>
            <Banner tone="critical" title="Error Loading Data">
              <p>{data.error}</p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const { falsePositives, falseNegatives, totalManualOrders } = data;

  const tabs = [
    { 
      id: "false-positives", 
      content: `False Positives (${falsePositives.length})`,
      description: "HIGH risk predicted but order delivered successfully"
    },
    { 
      id: "false-negatives", 
      content: `False Negatives (${falseNegatives.length})`,
      description: "LOW risk predicted but order resulted in fraud/chargeback/cancellation"
    }
  ];

  const displayOrders = selectedTab === 0 ? falsePositives : falseNegatives;

  return (
    <Page 
      title="Model Fine-Tuning Dashboard" 
      subtitle="Review edge cases and adjust model weights"
      backAction={{ onAction: () => navigate("/app/assessments") }}
    >
      <Layout>
        {/* Info Banner */}
        <Layout.Section>
          <Banner tone="info">
            <p>
              This page shows orders processed by the manual model with edge cases where predictions didn't match outcomes. 
              Use these cases to fine-tune your model weights for better accuracy. Total manual orders analyzed: <strong>{totalManualOrders}</strong>
            </p>
          </Banner>
        </Layout.Section>

        {/* Tabs */}
        <Layout.Section>
          <Card padding="0">
            <Tabs 
              tabs={tabs.map(tab => ({ id: tab.id, content: tab.content }))}
              selected={selectedTab}
              onSelect={setSelectedTab}
              fitted
            />
          </Card>
        </Layout.Section>

        {/* Tab Content */}
        <Layout.Section>
          {displayOrders.length === 0 ? (
            <Card>
              <Box padding="600">
                <BlockStack gap="300" align="center">
                  <Icon source={CheckIcon} tone="success" />
                  <BlockStack gap="100" align="center">
                    <Text variant="headingMd" as="h3">
                      {selectedTab === 0 
                        ? "No False Positives Found!" 
                        : "No False Negatives Found!"}
                    </Text>
                    <Text tone="subdued">
                      {selectedTab === 0
                        ? "All HIGH risk orders resulted in issues (no safe orders were wrongly flagged). Your model is performing well!"
                        : "All LOW risk orders were delivered safely. No risky orders were missed. Great job!"}
                    </Text>
                    <Text tone="subdued" variant="bodySm" paddingBlockStart="200">
                      This page is designed to help you fine-tune the weights used to evaluate orders. When edge cases appear, adjust the weights accordingly to improve accuracy.
                    </Text>
                  </BlockStack>
                </BlockStack>
              </Box>
            </Card>
          ) : (
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">
                {selectedTab === 0 
                  ? `${falsePositives.length} False Positive Cases`
                  : `${falseNegatives.length} False Negative Cases`}
              </Text>
              <Text tone="subdued">
                {selectedTab === 0
                  ? "These orders were flagged as HIGH risk but delivered successfully. Consider reducing the weights of these risk factors."
                  : "These orders were flagged as LOW risk but resulted in fraud/chargebacks/cancellations. Consider increasing the weights of these risk factors."}
              </Text>

              {displayOrders.map((order, idx) => (
                <OrderCaseCard key={order.id} order={order} index={idx} />
              ))}
            </BlockStack>
          )}
        </Layout.Section>

        {/* Footer Actions */}
        <Layout.Section>
          <InlineStack gap="200">
            <Button 
              onClick={() => navigate("/app/risk-engine")} 
              variant="primary"
            >
              Go to Weight Configuration
            </Button>
            <Button 
              onClick={() => navigate("/app/assessments")}
              variant="secondary"
            >
              Back to Assessments
            </Button>
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
