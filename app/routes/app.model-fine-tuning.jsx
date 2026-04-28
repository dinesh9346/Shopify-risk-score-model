import { useLoaderData, useNavigate } from "react-router";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  Box,
  InlineStack,
  Divider,
  Tabs,
  Button,
  Icon,
  Banner,
  IndexTable // <-- Standard Shopify List Component
} from "@shopify/polaris";
import { AlertTriangleIcon, CheckIcon } from '@shopify/polaris-icons';
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
    const falsePositives = []; 
    const falseNegatives = []; 

    manualOrders.forEach((riskScore) => {
      const order = riskScore.order;
      if (!order) return;

      // Determine actual outcome states
      const isDelivered = !order.isRTO && 
        order.fulfillmentStatus?.toUpperCase() === "FULFILLED" &&
        order.shipmentStatus?.toUpperCase() !== "UNDELIVERED";

      const isRTO = order.isRTO || 
        order.fulfillmentStatus?.toUpperCase() === "RETURNED" ||
        order.shipmentStatus?.toUpperCase()?.includes("RTO");

      const isCancelled = order.fulfillmentStatus?.toUpperCase() === "CANCELLED";
      const hasDispute = order.hasDispute || (order.disputes && order.disputes.length > 0);
      
      const isFailedDelivery = isCancelled || isRTO || hasDispute;

      // Ensure RTO takes priority in the label if applicable
      let specificOutcome = "UNKNOWN";
      if (hasDispute) specificOutcome = "CHARGEBACK";
      else if (isRTO) specificOutcome = "RTO";
      else if (isCancelled) specificOutcome = "CANCELLED";

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
      if (riskScore.riskLevel === "LOW" && isFailedDelivery) {
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
          outcome: specificOutcome 
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

// --- SINGLE COLUMN DATA ROW COMPONENT (For Detail View) ---
function DetailItem({ label, value }) {
  if (!value) return null;
  return (
    <BlockStack gap="0">
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <Text as="span" variant="bodyMd" breakWord fontWeight="medium">{value}</Text>
    </BlockStack>
  );
}

// --- WEIGHT RECOMMENDATION COMPONENT ---
function WeightRecommendations({ reasons, caseType }) {
  const reasonsList = reasons
    ? reasons.split(/[|,\n]/).map((r) => r.trim()).filter(Boolean)
    : [];

  const recommendations = [];

  if (caseType === "FALSE_POSITIVE") {
    recommendations.push({
      action: "REDUCE",
      title: "Reduce Conservative Weights",
      description: "These weights were too strict and caused a false positive.",
      items: reasonsList.map(reason => ({
        reason,
        suggestion: `Evaluate reducing weight for: ${reason}`
      }))
    });
  } else if (caseType === "FALSE_NEGATIVE") {
    recommendations.push({
      action: "INCREASE",
      title: "Increase Risk Weights",
      description: "These risk factors were missed or underweighted, causing a false negative.",
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
          padding="400" 
          background={rec.action === "REDUCE" ? "bg-surface-success-subdued" : "bg-surface-critical-subdued"}
          borderRadius="200"
          borderColor={rec.action === "REDUCE" ? "border-success" : "border-critical"}
          borderWidth="025"
        >
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center" align="space-between">
              <InlineStack gap="200" blockAlign="center">
                <Icon 
                  source={rec.action === "REDUCE" ? CheckIcon : AlertTriangleIcon}
                  tone={rec.action === "REDUCE" ? "success" : "critical"}
                />
                <Text variant="headingSm" as="h4">{rec.title}</Text>
              </InlineStack>
              <Text variant="headingSm" as="span" tone={rec.action === "REDUCE" ? "success" : "critical"}>
                {rec.action === "REDUCE" ? "Safe Order Flagged" : "Risky Order Missed"}
              </Text>
            </InlineStack>
            <Text tone="subdued" variant="bodySm">{rec.description}</Text>
            
            <Box paddingBlockStart="200">
              <BlockStack gap="150">
                {rec.items.map((item, itemIdx) => (
                  <Box key={itemIdx} padding="200" background="bg-surface" borderRadius="100">
                    <BlockStack gap="100">
                      <Text variant="bodyMd" fontWeight="semibold">• {item.reason}</Text>
                      <Text variant="bodySm" tone="subdued">
                        Action: {item.suggestion}
                      </Text>
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            </Box>
          </BlockStack>
        </Box>
      ))}
    </BlockStack>
  );
}

// --- ORDER CASE CARD COMPONENT (Detail View) ---
function OrderCaseCard({ order }) {
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

  const fullShippingAddress = [
    order.shippingAddress1,
    order.shippingCity,
    order.shippingProvince,
    order.shippingZip
  ].filter(Boolean).join(", ");

  return (
    <Card padding="500">
      <BlockStack gap="500">
        {/* Header */}
        <InlineStack gap="200" align="space-between" blockAlign="center">
          <BlockStack gap="100" grow>
            <Text as="h3" variant="headingLg">Order {order.orderId || "N/A"}</Text>
            <Text tone="subdued" variant="bodyMd">
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

        {/* FULL WIDTH STACKING: NO MORE GRIDS */}
        <BlockStack gap="400">
          
          <BlockStack gap="200">
            <Text variant="headingMd" as="h4">Customer Details</Text>
            <Box padding="300" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
              <BlockStack gap="300">
                <DetailItem label="Name" value={order.customerName} />
                <DetailItem label="Email" value={order.customerEmail} />
                <DetailItem label="Phone" value={order.customerPhone} />
              </BlockStack>
            </Box>
          </BlockStack>

          <BlockStack gap="200">
            <Text variant="headingMd" as="h4">Order Details</Text>
            <Box padding="300" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
              <BlockStack gap="300">
                <DetailItem label="Payment Gateway" value={order.paymentGateway || "Unknown"} />
                <DetailItem label="Fulfillment Status" value={order.fulfillmentStatus || "Unknown"} />
                <DetailItem label="Financial Status" value={order.financialStatus || "Unknown"} />
              </BlockStack>
            </Box>
          </BlockStack>

          {fullShippingAddress && (
            <BlockStack gap="200">
              <Text variant="headingMd" as="h4">Shipping Location</Text>
              <Box padding="300" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
                <DetailItem label="Address" value={fullShippingAddress} />
              </Box>
            </BlockStack>
          )}

          <BlockStack gap="200">
            <Text variant="headingMd" as="h4" tone="subdued">Model Prediction</Text>
            <Box padding="300" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
               <DetailItem label="Original Risk Score" value={`${order.riskScore}% - ${order.riskLevel}`} />
            </Box>
          </BlockStack>

        </BlockStack>

        {reasonsList.length > 0 && (
          <>
            <Divider />
            <BlockStack gap="200">
              <Text variant="headingMd" as="h4" tone="subdued">Risk Factors That Triggered</Text>
              <BlockStack gap="100">
                {reasonsList.map((reason, idx) => (
                  <InlineStack key={idx} gap="200" blockAlign="start">
                    <Text variant="bodyMd" tone="subdued">•</Text>
                    <Text variant="bodyMd">{reason}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </>
        )}

        <Box paddingBlockStart="200">
          <WeightRecommendations 
            reasons={order.reasons} 
            caseType={order.caseType}
            weights={order.settingsSnapshot}
          />
        </Box>
      </BlockStack>
    </Card>
  );
}

// --- MAIN PAGE COMPONENT ---
export default function ModelFineTuning() {
  const data = useLoaderData();
  const navigate = useNavigate();
  
  // State for tabs and master-detail routing
  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedOrder, setSelectedOrder] = useState(null);

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

  const handleTabChange = (selectedTabIndex) => {
    setSelectedTab(selectedTabIndex);
    setSelectedOrder(null); // Reset detail view when switching tabs
  };

  // Dynamic Back Action
  const backActionConfig = selectedOrder 
    ? { onAction: () => setSelectedOrder(null) } // Go back to Master List
    : { onAction: () => navigate("/app/assessments") }; // Go back to main app

  return (
    <Page 
      title={selectedOrder ? `Order Details: ${selectedOrder.orderId || "N/A"}` : "Model Fine-Tuning Dashboard"} 
      subtitle={selectedOrder ? "Review detailed predictions and edge cases" : "Review edge cases and adjust model weights"}
      backAction={backActionConfig}
    >
      <Layout>
        
        {/* CONDITIONAL RENDERING */}
        {selectedOrder ? (
          
          /* DETAIL VIEW */
          <Layout.Section>
            <BlockStack gap="400">
              <OrderCaseCard order={selectedOrder} />
            </BlockStack>
          </Layout.Section>

        ) : (
          
          /* MASTER VIEW (LIST) */
          <>
            <Layout.Section>
              <Banner tone="info">
                <p>
                  This page shows orders processed by the manual model with edge cases where predictions didn't match outcomes. 
                  Use these cases to fine-tune your model weights for better accuracy. Total manual orders analyzed: <strong>{totalManualOrders}</strong>
                </p>
              </Banner>
            </Layout.Section>

            <Layout.Section>
              <Card padding="0">
                <Tabs 
                  tabs={tabs.map(tab => ({ id: tab.id, content: tab.content }))}
                  selected={selectedTab}
                  onSelect={handleTabChange}
                  fitted
                />
              </Card>
            </Layout.Section>

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
                            ? "All HIGH risk orders resulted in issues. Your model is performing well!"
                            : "All LOW risk orders were delivered safely. Great job!"}
                        </Text>
                      </BlockStack>
                    </BlockStack>
                  </Box>
                </Card>
              ) : (
                <BlockStack gap="400">
                  <Box paddingBlockEnd="200">
                    <BlockStack gap="100">
                      <Text variant="headingLg" as="h2">
                        {selectedTab === 0 
                          ? `${falsePositives.length} False Positive Cases`
                          : `${falseNegatives.length} False Negative Cases`}
                      </Text>
                      <Text tone="subdued" variant="bodyMd">
                        Click on an order in the list below to investigate the specific details and adjust weights.
                      </Text>
                    </BlockStack>
                  </Box>

                  {/* MASTER LIST (MINIMAL DETAILS) */}
                  <Card padding="0">
                    <IndexTable
                      resourceName={{ singular: 'order', plural: 'orders' }}
                      itemCount={displayOrders.length}
                      selectable={false}
                      headings={[
                        { title: 'Order ID' },
                        { title: 'Date' },
                        { title: 'Customer' },
                        { title: 'Score' },
                        { title: 'Outcome' },
                      ]}
                    >
                      {displayOrders.map((order, index) => {
                        const getOutcomeColor = () => order.caseType === "FALSE_POSITIVE" ? "success" : "critical";
                        const getOutcomeLabel = () => order.caseType === "FALSE_POSITIVE" ? "Delivered" : order.outcome;
                        
                        const formattedDate = new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric'
                        }).format(new Date(order.createdAt));

                        return (
                          <IndexTable.Row
                            id={order.id}
                            key={order.id}
                            position={index}
                            onClick={() => setSelectedOrder(order)} // Opens Detailed View
                            style={{ cursor: 'pointer' }}
                          >
                            <IndexTable.Cell>
                              <Text variant="bodyMd" fontWeight="bold" as="span">
                                {order.orderId || "N/A"}
                              </Text>
                            </IndexTable.Cell>
                            <IndexTable.Cell>{formattedDate}</IndexTable.Cell>
                            <IndexTable.Cell>{order.customerName}</IndexTable.Cell>
                            <IndexTable.Cell>
                              <Badge tone={order.riskLevel === "HIGH" ? "critical" : "success"}>
                                {order.riskScore}%
                              </Badge>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                              <Badge tone={getOutcomeColor()}>
                                {getOutcomeLabel()}
                              </Badge>
                            </IndexTable.Cell>
                          </IndexTable.Row>
                        );
                      })}
                    </IndexTable>
                  </Card>
                </BlockStack>
              )}
            </Layout.Section>
            
            <Layout.Section>
              <Box paddingBlockStart="200" paddingBlockEnd="400">
                <InlineStack gap="300">
                  <Button 
                    onClick={() => navigate("/app/risk-engine")} 
                    variant="primary"
                    size="large"
                  >
                    Go to Weight Configuration
                  </Button>
                </InlineStack>
              </Box>
            </Layout.Section>
          </>
        )}
      </Layout>
    </Page>
  );
}