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
import { useLoaderData, useSubmit, useActionData, useNavigation } from "react-router"; 
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { triggerBulkOrderSync } from "../models/Sync.server"; 

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
    // Fetch the last sync period from your session table
    const dbSession = await prisma.session.findUnique({ where: { id: session.id } });
    const lastSyncPeriod = dbSession?.lastSyncPeriod || 0;

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

    const riskRate = totalOrders > 0 
      ? ((highRiskCount / totalOrders) * 100).toFixed(1) 
      : 0;

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
      totalOrders, highRiskCount, vipCount, repeatCount, newCount, liveActivity, shop, lastSyncPeriod
    });
  } catch (error) {
    console.error("[LOADER ERROR] Failed to load dashboard data:", error);
    return Response.json({ 
      error: "Failed to load dashboard data. Please try again.",
      totalOrders: 0, highRiskCount: 0, vipCount: 0, repeatCount: 0, newCount: 0, liveActivity: [], shop: session?.shop || "", lastSyncPeriod: 0
    }, { status: 500 });
  }
};

// 2. SERVER-SIDE ACTION: Handles form submissions and dynamic sync logic
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const intent = formData.get("intent");

  if (intent === "manual_sync") {
    const requestedMonths = parseInt(formData.get("period"), 10);
    
    // 1. Get current sync status
    const dbSession = await prisma.session.findUnique({ where: { id: session.id } });
    const currentSyncedMonths = dbSession?.lastSyncPeriod || 0;

    // 2. Compare logic: If they request what they already have (or less)
    if (requestedMonths <= currentSyncedMonths && currentSyncedMonths !== 0) {
      return Response.json({ 
        success: false, 
        intent: "manual_sync",
        error: `Database already contains ${currentSyncedMonths} months of data. No new sync required.` 
      });
    }

    // 3. Compare logic: If they request more data, clear the old and trigger the new
    try {
      console.log(`[SYNC] Upgrading to ${requestedMonths} months for ${session.shop}`);
      
      // Wipe the slate clean to prevent overlap
      await prisma.$transaction([
        prisma.shopify_store_order.deleteMany({ where: { shop: session.shop } }),
        prisma.zippyy_buyer_profile.deleteMany({ where: { shop: session.shop } })
      ]);

      // Trigger the background GraphQL pull
      await triggerBulkOrderSync(admin, session.shop, requestedMonths);

      // Save the new timeframe setting to the session
      await prisma.session.update({
        where: { id: session.id },
        data: { lastSyncPeriod: requestedMonths }
      });

      return Response.json({ 
        success: true, 
        intent: "manual_sync",
        message: `Upgrading to ${requestedMonths} months of data. Sync started in background. Check back shortly!` 
      });
    } catch (error) {
      console.error("[SYNC ERROR]", error);
      return Response.json({ success: false, intent: "manual_sync", error: "Failed to start sync." }, { status: 500 });
    }
  }

  // Handle standard feedback form submission
  const feedbackText = formData.get("feedback");
  if (feedbackText && feedbackText.trim() !== "") {
    try {
      await prisma.merchant_feedback.create({
        data: { shop: session.shop, message: feedbackText }
      });
      return Response.json({ success: true, intent: "feedback" });
    } catch (error) {
      return Response.json({ success: false, intent: "feedback", error: error.message }, { status: 500 });
    }
  }

  return Response.json({ success: false, error: "The server received an empty message." }, { status: 400 });
};

// 3. CLIENT-SIDE UI COMPONENT
export default function Dashboard() {
  const { 
    totalOrders, highRiskCount, vipCount, repeatCount, newCount, liveActivity, shop, lastSyncPeriod
  } = useLoaderData();
  
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  
  const [feedback, setFeedback] = useState("");
  const isSubmitting = navigation.state === "submitting";
  const isRefreshing = navigation.state === "loading";

  const activeProfilesCount = highRiskCount + vipCount + repeatCount + newCount;

  useEffect(() => {
    if (actionData?.success && actionData?.intent === "feedback") {
      setFeedback("");
    }
  }, [actionData]);

  const handleFeedbackSubmit = () => {
    const formData = new FormData();
    formData.append("intent", "feedback");
    formData.append("feedback", feedback);
    submit(formData, { method: "post", action: "?index" });
  };

  const handleSyncSelection = (months) => {
    const formData = new FormData();
    formData.append("intent", "manual_sync");
    formData.append("period", months.toString());
    submit(formData, { method: "post", action: "?index" });
  };

  const handleRefresh = () => {
    submit(null, { method: "get" });
  };

  // Polaris Action Group creates the clean dropdown button at the top of the page
  const syncActionGroup = [
    {
      title: 'Sync Data',
      actions: [
        { content: 'Last 3 Months', onAction: () => handleSyncSelection(3) },
        { content: 'Last 6 Months', onAction: () => handleSyncSelection(6) },
        { content: 'Last 9 Months', onAction: () => handleSyncSelection(9) },
      ],
    },
  ];

  // Reusable banner block for sync notifications
  const syncNotifications = (
    <>
      {actionData?.intent === "manual_sync" && actionData?.error && (
        <Layout.Section>
          <Banner tone="warning" title="Sync Status">{actionData.error}</Banner>
        </Layout.Section>
      )}
      {actionData?.intent === "manual_sync" && actionData?.success && (
        <Layout.Section>
          <Banner tone="success" title="Sync Initiated">{actionData.message}</Banner>
        </Layout.Section>
      )}
    </>
  );

  // 🔹 INTERCEPT RENDER: EMPTY STATE 🔹
  if (activeProfilesCount === 0) {
    return (
      <Page 
        title="Zippyy Risk Intelligence" 
        actionGroups={syncActionGroup} // Allows triggering sync even when empty
      >
        <Layout>
          {syncNotifications}
          <Layout.Section>
            <Card>
              <EmptyState
                heading={lastSyncPeriod > 0 ? "Building Buyer Profiles..." : "Ready to analyze your store."}
                action={{
                  content: "Refresh Dashboard",
                  onAction: handleRefresh,
                  loading: isRefreshing
                }}
                image="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be5a34ec20c05b94298cb8afd10bf56bd4e9a7e6141e7eb0de.svg"
              >
                <p>
                  {lastSyncPeriod > 0 
                    ? "Zippyy is currently compiling your historical order data in the background. Check back shortly!" 
                    : "Use the 'Sync Data' dropdown in the top right to import your historical orders and train the AI risk model."}
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // 🔹 STANDARD RENDER: POPULATED STATE 🔹
  const riskRate = totalOrders > 0 ? ((highRiskCount / totalOrders) * 100).toFixed(1) : 0;
  const riskRateTone = riskRate > 10 ? "critical" : "subdued";

  return (
    <Page 
      title="Zippyy Risk Intelligence" 
      subtitle="Real-time fraud and RTO prevention"
      actionGroups={syncActionGroup} // Drops down cleanly on the top right
    >
      <BlockStack gap="500">
        <Layout>
          {syncNotifications}
        </Layout>

        <CalloutCard
          title="Your store is heavily guarded."
          illustration="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be5a34ec20c05b94298cb8afd10bf56bd4e9a7e6141e7eb0de.svg"
          primaryAction={{
            content: "Review High-Risk Orders",
            url: "/app/risk-engine?tab=high-risk", 
          }}
        >
          <Text as="p">
            Currently protecting your store using an AI model trained on your last <strong>{lastSyncPeriod || "initial"} months</strong> of historical data.
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
                
                {/* Rectangle Bar Removed, showing clean Badge grid */}
                <InlineGrid columns={3} gap="200">
                  <BlockStack gap="100">
                    <Badge tone="success">Trusted</Badge>
                    <Text as="p" variant="headingLg">{vipCount + repeatCount}</Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Badge tone="info">New Buyers</Badge>
                    <Text as="p" variant="headingLg">{newCount}</Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Badge tone="critical">High Risk</Badge>
                    <Text as="p" variant="headingLg">{highRiskCount}</Text>
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
                
                {actionData?.intent === "feedback" && actionData?.error && (
                  <Banner tone="critical" title="Submission Failed">
                    {actionData.error}
                  </Banner>
                )}

                {actionData?.intent === "feedback" && actionData?.success ? (
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


// import {
//   Page,
//   Layout,
//   Text,
//   Card,
//   Button,
//   BlockStack,
//   InlineGrid,
//   Box,
//   CalloutCard,
//   Badge,
//   List,
//   TextField,
//   FormLayout,
//   Banner,
//   EmptyState,
// } from "@shopify/polaris";
// import { useState, useEffect } from "react";
// import { useLoaderData, useSubmit, useActionData, useNavigation, useNavigate } from "react-router"; 
// import { authenticate } from "../shopify.server";
// import prisma from "../db.server";

// // Helper function for retrying database queries
// const retryQuery = async (queryFn, retries = 3, delay = 1000) => {
//   for (let i = 0; i < retries; i++) {
//     try {
//       return await queryFn();
//     } catch (error) {
//       if (i === retries - 1) throw error;
//       console.warn(`Query failed, retrying (${i + 1}/${retries}):`, error.message);
//       await new Promise(resolve => setTimeout(resolve, delay));
//     }
//   }
// };

// // 1. SERVER-SIDE LOADER: Fetches data when the page loads
// export const loader = async ({ request }) => {
//   const { session } = await authenticate.admin(request);
//   const shop = session.shop;

//   try {
   
//     const [totalOrdersResult, segmentCountsResult, recentUpdatesResult] = await Promise.all([
//       retryQuery(() => prisma.shopify_store_order.count({ where: { shop } })),
//       retryQuery(() => prisma.zippyy_buyer_profile.groupBy({
//         by: ['buyerSegment'],
//         where: { shop },
//         _count: { buyerSegment: true },
//       })),
//       retryQuery(() => prisma.zippyy_buyer_profile.findMany({
//         where: { shop },
//         orderBy: { updatedAt: "desc" },
//         take: 5
//       }))
//     ]);

//     const totalOrders = totalOrdersResult;
//     const segmentCounts = segmentCountsResult;

//     // Extract counts from groupBy result
//     const highRiskCount = segmentCounts.find(s => s.buyerSegment === "High Risk")?._count.buyerSegment || 0;
//     const vipCount = segmentCounts.find(s => s.buyerSegment === "VIP")?._count.buyerSegment || 0;
//     const repeatCount = segmentCounts.find(s => s.buyerSegment === "Repeat Buyer")?._count.buyerSegment || 0;
//     const newCount = segmentCounts.find(s => s.buyerSegment === "New")?._count.buyerSegment || 0;

//     // Add this calculation right above your return statement
//     const riskRate = totalOrders > 0 
//       ? ((highRiskCount / totalOrders) * 100).toFixed(1) 
//       : 0;
//     const riskRateTone = riskRate > 10 ? "critical" : "subdued";

//     const recentUpdates = recentUpdatesResult;

//     const liveActivity = recentUpdates.map(profile => {
//       const rawId = profile.customerEmail || profile.customerPhone || "Guest Buyer";
//       const maskedId = rawId.includes("@") 
//         ? rawId.replace(/(.{1})(.*)(?=@)/, "$1***") 
//         : rawId.substring(0, 3) + "***";

//       let actionData = {};

//       if (profile.buyerSegment === "High Risk") {
//         actionData = { action: "Flagged", tone: "critical", text: `High risk signals detected for ${maskedId}. Reason: ${profile.riskReasons || "Multiple factors"}.` };
//       } else if (profile.buyerSegment === "VIP") {
//         actionData = { action: "Upgraded", tone: "success", text: `${maskedId} reached VIP status.` };
//       } else if (profile.buyerSegment === "Repeat Buyer") {
//         actionData = { action: "Recognized", tone: "success", text: `Trusted repeat buyer ${maskedId} identified.` };
//       } else {
//         actionData = { action: "Analyzed", tone: "info", text: `New buyer profile generated for ${maskedId}.` };
//       }
//       return actionData;
//     });

//     return Response.json({ 
//       totalOrders, highRiskCount, vipCount, repeatCount, newCount, liveActivity, shop 
//     });
//   } catch (error) {
//     console.error("[LOADER ERROR] Failed to load dashboard data:", error);
//     // Return error response or fallback data
//     return Response.json({ 
//       error: "Failed to load dashboard data. Please try again.",
//       totalOrders: 0, highRiskCount: 0, vipCount: 0, repeatCount: 0, newCount: 0, liveActivity: [], shop 
//     }, { status: 500 });
//   }
// };

// // 2. SERVER-SIDE ACTION: Handles form submissions safely and saves to DB
// export const action = async ({ request }) => {
//   const { session } = await authenticate.admin(request);
//   const formData = await request.formData();
//   const feedbackText = formData.get("feedback");

//   if (feedbackText && feedbackText.trim() !== "") {
//     console.log(`[FEEDBACK RECEIVED] Attempting to save: ${feedbackText}`);
    
//     try {
//       // Save the feedback to the PostgreSQL database
//       await prisma.merchant_feedback.create({
//         data: { 
//           shop: session.shop, 
//           message: feedbackText 
//         }
//       });

//       console.log(`[FEEDBACK SAVED] Successfully written to database.`);
//       return Response.json({ success: true });
//     } catch (error) {
//       console.error("[DATABASE ERROR] Failed to save feedback:", error);
//       // Return the exact error message so we can see it in the UI
//       return Response.json({ success: false, error: error.message }, { status: 500 });
//     }
//   }

//   return Response.json({ success: false, error: "The server received an empty message." }, { status: 400 });
// };

// // 3. CLIENT-SIDE UI COMPONENT
// export default function Dashboard() {
//   const { 
//     totalOrders, highRiskCount, vipCount, repeatCount, newCount, liveActivity, shop 
//   } = useLoaderData();
  
//   const actionData = useActionData();
//   const submit = useSubmit();
//   const navigation = useNavigation();
  
//   const [feedback, setFeedback] = useState("");
//   const isSubmitting = navigation.state === "submitting";
//   const isRefreshing = navigation.state === "loading";

//   // Calculate actual profiles generated
//   const activeProfilesCount = highRiskCount + vipCount + repeatCount + newCount;

//   // Clear the text box only if the submission was actually successful
//   useEffect(() => {
//     if (actionData?.success) {
//       setFeedback("");
//     }
//   }, [actionData]);

//   const handleFeedbackSubmit = () => {
//     const formData = new FormData();
//     formData.append("feedback", feedback);
    
//     submit(formData, { method: "post", action: "?index" });
//   };


//   const handleRefresh = () => {
//     submit(null, { method: "get" });
//   };

//   //  Intercept the render if the Bulk Sync hasn't built profiles yet
//   if (activeProfilesCount === 0) {
//     return (
//       <Page title="Zippyy Risk Intelligence">
//         <Layout>
//           <Layout.Section>
//             <Card>
//               <EmptyState
//                 heading="Analyzing your customer history..."
//                 action={{
//                   content: "Refresh Dashboard",
//                   onAction: handleRefresh,
//                   loading: isRefreshing
//                 }}
//                 image="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be5a34ec20c05b94298cb8afd10bf56bd4e9a7e6141e7eb0de.svg"
//               >
//                 <p>
//                   Zippyy is currently scanning your historical order data to build buyer profiles, identify VIPs, and flag serial abandoners. 
//                   <br /><br />
//                   This process runs in the background and may take a few minutes depending on your store's order volume. Check back shortly!
//                 </p>
//               </EmptyState>
//             </Card>
//           </Layout.Section>
//         </Layout>
//       </Page>
//     );
//   }

//   // Safe fallback to prevent division by zero for the UI charts
//   const totalProfiles = activeProfilesCount || 1; 
//   const riskRate = totalOrders > 0 ? ((highRiskCount / totalOrders) * 100).toFixed(1) : 0;
//   const riskRateTone = riskRate > 10 ? "critical" : "subdued";
//   const riskPct = (highRiskCount / totalProfiles) * 100;
//   const vipPct = ((vipCount + repeatCount) / totalProfiles) * 100;
//   const newPct = (newCount / totalProfiles) * 100;

//   return (
//     <Page title="Zippyy Risk Intelligence" subtitle="Real-time fraud and RTO prevention">
//       <BlockStack gap="500">
        
//         <CalloutCard
//           title="Your store is heavily guarded."
//           illustration="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be5a34ec20c05b94298cb8afd10bf56bd4e9a7e6141e7eb0de.svg"
//           primaryAction={{
//             content: "Review High-Risk Orders",
//             url: "/app/risk-engine?tab=high-risk", 
//           }}
//         >
//           <Text as="p">
//             Zippyy is actively scanning every incoming Shopify order against our logistics network. 
//             We are identifying VIPs to reward and blocking serial abandoners to protect your bottom line.
//           </Text>
//         </CalloutCard>

//         <Layout>
//           <Layout.Section>
//             <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
//               <Card background="bg-surface-secondary">
//                 <BlockStack gap="200">
//                   <Text as="h3" variant="headingSm" tone="subdued">Analyzed Orders</Text>
//                   <Text as="p" variant="headingXl">{totalOrders.toLocaleString()}</Text>
//                 </BlockStack>
//               </Card>
//               <Card>
//                 <BlockStack gap="200">
//                   <Text as="h3" variant="headingSm" tone="subdued">VIP & Repeat</Text>
//                   <Text as="p" variant="headingXl" tone="success">{(vipCount + repeatCount).toLocaleString()}</Text>
//                 </BlockStack>
//               </Card>
//               <Card>
//                 <BlockStack gap="200">
//                   <Text as="h3" variant="headingSm" tone="subdued">High Risk</Text>
//                   <Text as="p" variant="headingXl" tone="critical">{highRiskCount.toLocaleString()}</Text>
//                 </BlockStack>
//               </Card>
//               <Card background="bg-surface-magic">
//                 <BlockStack gap="200">
//                   <Text as="h3" variant="headingSm" tone="subdued">Store Risk Rate</Text>
//                   <Text as="p" variant="headingXl" tone={riskRateTone}>{riskRate}%</Text>
//                </BlockStack>
//               </Card>
//             </InlineGrid>
//           </Layout.Section>
//         </Layout>

//         <Layout>
//           <Layout.Section variant="oneHalf">
//             <Card>
//               <BlockStack gap="400">
//                 <Text as="h2" variant="headingMd">Your Buyer DNA</Text>
//                 <Text as="p" tone="subdued">A real-time breakdown of your customer base segmentation.</Text>
                
//                 <div style={{ display: 'flex', height: '42px', borderRadius: '4px', overflow: 'hidden', width: '100%' }}>
//                   <div style={{ width: `${vipPct}%`, backgroundColor: 'var(--p-color-bg-surface-success-strong)', transition: 'width 0.5s' }} title="VIP & Repeat" />
//                   <div style={{ width: `${newPct}%`, backgroundColor: 'var(--p-color-bg-surface-info-strong)', transition: 'width 0.5s' }} title="New Buyers" />
//                   <div style={{ width: `${riskPct}%`, backgroundColor: 'var(--p-color-bg-surface-critical-strong)', transition: 'width 0.5s' }} title="High Risk" />
//                 </div>
                
//                 <InlineGrid columns={3} gap="200">
//                   <BlockStack>
//                     <Badge tone="success">Trusted ({Math.round(vipPct)}%)</Badge>
//                   </BlockStack>
//                   <BlockStack>
//                     <Badge tone="info">New ({Math.round(newPct)}%)</Badge>
//                   </BlockStack>
//                   <BlockStack>
//                     <Badge tone="critical">Risk ({Math.round(riskPct)}%)</Badge>
//                   </BlockStack>
//                 </InlineGrid>
//               </BlockStack>
//             </Card>
//           </Layout.Section>

//           <Layout.Section variant="oneHalf">
//             <Card>
//               <BlockStack gap="400">
//                 <Text as="h2" variant="headingMd">Live Intelligence Log</Text>
//                 <Box paddingBlockEnd="200">
//                   {liveActivity.length > 0 ? (
//                     <List type="bullet">
//                       {liveActivity.map((log, index) => (
//                         <List.Item key={index}>
//                           <Text as="span" tone={log.tone}>{log.action}: </Text>
//                           {log.text}
//                         </List.Item>
//                       ))}
//                     </List>
//                   ) : (
//                     <Text as="p" tone="subdued">Waiting for incoming order data...</Text>
//                   )}
//                 </Box>
//               </BlockStack>
//             </Card>
//           </Layout.Section>
//         </Layout>

//         <Layout>
//           <Layout.Section>
//             <Card background="bg-surface-secondary">
//               <BlockStack gap="400">
//                 <Text as="h2" variant="headingMd">Shape the Future of Zippyy</Text>
//                 <Text as="p">
//                   Our algorithm adapts to your needs. Notice a fraud trend we missed? Speak directly to our engineering team.
//                 </Text>
                
//                 {/* Dynamically show errors if the action fails */}
//                 {actionData?.error && (
//                   <Banner tone="critical" title="Submission Failed">
//                     {actionData.error}
//                   </Banner>
//                 )}

//                 {actionData?.success ? (
//                   <Banner tone="success" title="Feedback received">
//                     Thank you. Our engineering team has received your message.
//                   </Banner>
//                 ) : (
//                   <FormLayout>
//                     <TextField
//                       label="Feedback"
//                       labelHidden
//                       value={feedback}
//                       onChange={setFeedback}
//                       multiline={2}
//                       autoComplete="off"
//                       placeholder="Example: I need a rule that flags all prepaid orders over 10,000 INR..."
//                     />
//                     <InlineGrid columns={{ xs: 1, sm: "auto auto" }} gap="200" alignItems="center">
//                       <Button 
//                         variant="primary" 
//                         onClick={handleFeedbackSubmit} 
//                         loading={isSubmitting}
//                         disabled={!feedback}
//                       >
//                         Submit Directly to Engineers
//                       </Button>
//                     </InlineGrid>
//                   </FormLayout>
//                 )}
//               </BlockStack>
//             </Card>
//           </Layout.Section>
//         </Layout>

//       </BlockStack>
//     </Page>
//   );
// }








