import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  InlineGrid,
  Box,
  CalloutCard,
  Badge,
  List,
  TextField,
  FormLayout,
  Banner,
  EmptyState,
} from "@shopify/polaris";
import { useState, useEffect } from "react";
import { useLoaderData, useSubmit, useActionData, useNavigation, useNavigate } from "react-router"; 
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Helper function for retrying database queries
const retryQuery = async (queryFn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await queryFn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.warn(`Query failed, retrying (${i + 1}/${retries}):`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// 1. SERVER-SIDE LOADER: Fetches data when the page loads
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
   
    const [totalOrdersResult, segmentCountsResult, recentUpdatesResult] = await Promise.all([
      retryQuery(() => prisma.shopify_store_order.count({ where: { shop } })),
      retryQuery(() => prisma.zippyy_buyer_profile.groupBy({
        by: ['buyerSegment'],
        where: { shop },
        _count: { buyerSegment: true },
      })),
      retryQuery(() => prisma.zippyy_buyer_profile.findMany({
        where: { shop },
        orderBy: { updatedAt: "desc" },
        take: 5
      }))
    ]);

    const totalOrders = totalOrdersResult;
    const segmentCounts = segmentCountsResult;

    // Extract counts from groupBy result
    const highRiskCount = segmentCounts.find(s => s.buyerSegment === "High Risk")?._count.buyerSegment || 0;
    const vipCount = segmentCounts.find(s => s.buyerSegment === "VIP")?._count.buyerSegment || 0;
    const repeatCount = segmentCounts.find(s => s.buyerSegment === "Repeat Buyer")?._count.buyerSegment || 0;
    const newCount = segmentCounts.find(s => s.buyerSegment === "New")?._count.buyerSegment || 0;

    // Add this calculation right above your return statement
    const riskRate = totalOrders > 0 
      ? ((highRiskCount / totalOrders) * 100).toFixed(1) 
      : 0;
    const riskRateTone = riskRate > 10 ? "critical" : "subdued";

    const recentUpdates = recentUpdatesResult;

    const liveActivity = recentUpdates.map(profile => {
      const rawId = profile.customerEmail || profile.customerPhone || "Guest Buyer";
      const maskedId = rawId.includes("@") 
        ? rawId.replace(/(.{1})(.*)(?=@)/, "$1***") 
        : rawId.substring(0, 3) + "***";

      let actionData = {};

      if (profile.buyerSegment === "High Risk") {
        actionData = { action: "Flagged", tone: "critical", text: `High risk signals detected for ${maskedId}. Reason: ${profile.riskReasons || "Multiple factors"}.` };
      } else if (profile.buyerSegment === "VIP") {
        actionData = { action: "Upgraded", tone: "success", text: `${maskedId} reached VIP status.` };
      } else if (profile.buyerSegment === "Repeat Buyer") {
        actionData = { action: "Recognized", tone: "success", text: `Trusted repeat buyer ${maskedId} identified.` };
      } else {
        actionData = { action: "Analyzed", tone: "info", text: `New buyer profile generated for ${maskedId}.` };
      }
      return actionData;
    });

    return Response.json({ 
      totalOrders, highRiskCount, vipCount, repeatCount, newCount, liveActivity, shop 
    });
  } catch (error) {
    console.error("[LOADER ERROR] Failed to load dashboard data:", error);
    // Return error response or fallback data
    return Response.json({ 
      error: "Failed to load dashboard data. Please try again.",
      totalOrders: 0, highRiskCount: 0, vipCount: 0, repeatCount: 0, newCount: 0, liveActivity: [], shop 
    }, { status: 500 });
  }
};

// 2. SERVER-SIDE ACTION: Handles form submissions safely and saves to DB
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const feedbackText = formData.get("feedback");

  if (feedbackText && feedbackText.trim() !== "") {
    console.log(`[FEEDBACK RECEIVED] Attempting to save: ${feedbackText}`);
    
    try {
      // Save the feedback to the PostgreSQL database
      await prisma.merchant_feedback.create({
        data: { 
          shop: session.shop, 
          message: feedbackText 
        }
      });

      console.log(`[FEEDBACK SAVED] Successfully written to database.`);
      return Response.json({ success: true });
    } catch (error) {
      console.error("[DATABASE ERROR] Failed to save feedback:", error);
      // Return the exact error message so we can see it in the UI
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return Response.json({ success: false, error: "The server received an empty message." }, { status: 400 });
};

// 3. CLIENT-SIDE UI COMPONENT
export default function Dashboard() {
  const { 
    totalOrders, highRiskCount, vipCount, repeatCount, newCount, liveActivity, shop 
  } = useLoaderData();
  
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  
  const [feedback, setFeedback] = useState("");
  const isSubmitting = navigation.state === "submitting";
  const isRefreshing = navigation.state === "loading";

  // Calculate actual profiles generated
  const activeProfilesCount = highRiskCount + vipCount + repeatCount + newCount;

  // Clear the text box only if the submission was actually successful
  useEffect(() => {
    if (actionData?.success) {
      setFeedback("");
    }
  }, [actionData]);

  const handleFeedbackSubmit = () => {
    const formData = new FormData();
    formData.append("feedback", feedback);
    
    submit(formData, { method: "post", action: "?index" });
  };


  const handleRefresh = () => {
    submit(null, { method: "get" });
  };

  //  Intercept the render if the Bulk Sync hasn't built profiles yet
  if (activeProfilesCount === 0) {
    return (
      <Page title="Zippyy Risk Intelligence">
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Analyzing your customer history..."
                action={{
                  content: "Refresh Dashboard",
                  onAction: handleRefresh,
                  loading: isRefreshing
                }}
                image="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be5a34ec20c05b94298cb8afd10bf56bd4e9a7e6141e7eb0de.svg"
              >
                <p>
                  Zippyy is currently scanning your historical order data to build buyer profiles, identify VIPs, and flag serial abandoners. 
                  <br /><br />
                  This process runs in the background and may take a few minutes depending on your store's order volume. Check back shortly!
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // Safe fallback to prevent division by zero for the UI charts
  const totalProfiles = activeProfilesCount || 1; 
  const riskRate = totalOrders > 0 ? ((highRiskCount / totalOrders) * 100).toFixed(1) : 0;
  const riskRateTone = riskRate > 10 ? "critical" : "subdued";
  const riskPct = (highRiskCount / totalProfiles) * 100;
  const vipPct = ((vipCount + repeatCount) / totalProfiles) * 100;
  const newPct = (newCount / totalProfiles) * 100;

  return (
    <Page title="Zippyy Risk Intelligence" subtitle="Real-time fraud and RTO prevention">
      <BlockStack gap="500">
        
        <CalloutCard
          title="Your store is heavily guarded."
          illustration="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be5a34ec20c05b94298cb8afd10bf56bd4e9a7e6141e7eb0de.svg"
          primaryAction={{
            content: "Review High-Risk Orders",
            url: "/app/risk-engine?tab=high-risk", 
          }}
        >
          <Text as="p">
            Zippyy is actively scanning every incoming Shopify order against our logistics network. 
            We are identifying VIPs to reward and blocking serial abandoners to protect your bottom line.
          </Text>
        </CalloutCard>

        <Layout>
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
              <Card background="bg-surface-secondary">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Analyzed Orders</Text>
                  <Text as="p" variant="headingXl">{totalOrders.toLocaleString()}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">VIP & Repeat</Text>
                  <Text as="p" variant="headingXl" tone="success">{(vipCount + repeatCount).toLocaleString()}</Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">High Risk</Text>
                  <Text as="p" variant="headingXl" tone="critical">{highRiskCount.toLocaleString()}</Text>
                </BlockStack>
              </Card>
              <Card background="bg-surface-magic">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Store Risk Rate</Text>
                  <Text as="p" variant="headingXl" tone={riskRateTone}>{riskRate}%</Text>
               </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Your Buyer DNA</Text>
                <Text as="p" tone="subdued">A real-time breakdown of your customer base segmentation.</Text>
                
                <div style={{ display: 'flex', height: '42px', borderRadius: '4px', overflow: 'hidden', width: '100%' }}>
                  <div style={{ width: `${vipPct}%`, backgroundColor: 'var(--p-color-bg-surface-success-strong)', transition: 'width 0.5s' }} title="VIP & Repeat" />
                  <div style={{ width: `${newPct}%`, backgroundColor: 'var(--p-color-bg-surface-info-strong)', transition: 'width 0.5s' }} title="New Buyers" />
                  <div style={{ width: `${riskPct}%`, backgroundColor: 'var(--p-color-bg-surface-critical-strong)', transition: 'width 0.5s' }} title="High Risk" />
                </div>
                
                <InlineGrid columns={3} gap="200">
                  <BlockStack>
                    <Badge tone="success">Trusted ({Math.round(vipPct)}%)</Badge>
                  </BlockStack>
                  <BlockStack>
                    <Badge tone="info">New ({Math.round(newPct)}%)</Badge>
                  </BlockStack>
                  <BlockStack>
                    <Badge tone="critical">Risk ({Math.round(riskPct)}%)</Badge>
                  </BlockStack>
                </InlineGrid>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Live Intelligence Log</Text>
                <Box paddingBlockEnd="200">
                  {liveActivity.length > 0 ? (
                    <List type="bullet">
                      {liveActivity.map((log, index) => (
                        <List.Item key={index}>
                          <Text as="span" tone={log.tone}>{log.action}: </Text>
                          {log.text}
                        </List.Item>
                      ))}
                    </List>
                  ) : (
                    <Text as="p" tone="subdued">Waiting for incoming order data...</Text>
                  )}
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <Card background="bg-surface-secondary">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Shape the Future of Zippyy</Text>
                <Text as="p">
                  Our algorithm adapts to your needs. Notice a fraud trend we missed? Speak directly to our engineering team.
                </Text>
                
                {/* Dynamically show errors if the action fails */}
                {actionData?.error && (
                  <Banner tone="critical" title="Submission Failed">
                    {actionData.error}
                  </Banner>
                )}

                {actionData?.success ? (
                  <Banner tone="success" title="Feedback received">
                    Thank you. Our engineering team has received your message.
                  </Banner>
                ) : (
                  <FormLayout>
                    <TextField
                      label="Feedback"
                      labelHidden
                      value={feedback}
                      onChange={setFeedback}
                      multiline={2}
                      autoComplete="off"
                      placeholder="Example: I need a rule that flags all prepaid orders over 10,000 INR..."
                    />
                    <InlineGrid columns={{ xs: 1, sm: "auto auto" }} gap="200" alignItems="center">
                      <Button 
                        variant="primary" 
                        onClick={handleFeedbackSubmit} 
                        loading={isSubmitting}
                        disabled={!feedback}
                      >
                        Submit Directly to Engineers
                      </Button>
                    </InlineGrid>
                  </FormLayout>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

      </BlockStack>
    </Page>
  );
}








