
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState, useCallback } from "react";

import "@shopify/polaris/build/esm/styles.css";
import enTranslations from "@shopify/polaris/locales/en.json";

import {
  AppProvider,
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  IndexTable,
  useIndexResourceState,
  Grid,
  Banner,
  Box,
  Popover,
  Button
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
// import { syncHistoricalOrders } from "../models/Sync.server"; 
// ^ Uncomment syncHistoricalOrders if you are using it

/* ================= BACKEND LOADER ================= */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const orderCount = await prisma.shopify_store_order.count({
      where: { shop }
    });

    // 🚨 Uncomment this block if you want auto-syncing
    // if (orderCount === 0) {
    //   console.log(`⚠️ No orders found. Running historical sync for ${shop}`);
    //   syncHistoricalOrders(admin, shop).catch(console.error);
    // }

    // Fetch scores AND include the associated order details
    const recentScores = await prisma.zippyy_risk_score.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        order: true // 🔥 Joins the shopify_store_order table
      }
    });

    // Flatten and serialize the data so React Router doesn't crash on Dates/Decimals
    const safeScores = recentScores.map((score) => ({
      id: score.id,
      // Extract the Shopify Order ID from the joined table
      orderId: score.order?.shopifyOrderId || score.orderId, 
      // Convert Prisma Decimal to standard Number safely
      orderValue: Number(score.order?.orderValue ?? 0),
      
      // 🔥 THE FIX: Map financialStatus to paymentType so it actually shows the data
      paymentType: score.order?.financialStatus || "UNKNOWN",
      
      riskLevel: score.riskLevel,
      score: score.score,
      reasons: score.reasons,
      createdAt: score.createdAt ? score.createdAt.toISOString() : null,
    }));

    const highRiskCount = safeScores.filter((o) => o.riskLevel === "HIGH").length;
    const mediumRiskCount = safeScores.filter((o) => o.riskLevel === "MEDIUM").length;

    return Response.json({
      error: null,
      orderCount,
      recentScores: safeScores,
      kpis: {
        totalAnalyzed: safeScores.length,
        highRiskCount,
        mediumRiskCount
      }
    });

  } catch (error) {
    console.error("Loader error:", error);
    // 🔥 If it crashes, it safely sends the error message instead of blanking out
    return Response.json({
      error: error.message,
      orderCount: 0,
      recentScores: [],
      kpis: { totalAnalyzed: 0, highRiskCount: 0, mediumRiskCount: 0 }
    });
  }
};
/* ================= COMPONENTS ================= */

const RiskBadge = ({ level, score }) => {
  let tone = "success";
  if (level === "HIGH") tone = "critical";
  if (level === "MEDIUM") tone = "warning";

  return (
    <Badge tone={tone}>
      {level} ({score} pts)
    </Badge>
  );
};

const ReasonsPopover = ({ reasons }) => {
  const [active, setActive] = useState(false);
  const toggleActive = useCallback(() => setActive((active) => !active), []);

  const reasonsList = reasons
    ? reasons.split(/[|,\n]/).map((r) => r.trim()).filter(Boolean)
    : [];

  return (
    <Popover
      active={active}
      activator={
        <Button onClick={toggleActive} plain monochrome removeUnderline>
          <Text variant="bodyMd" tone="subdued" decoration="underline">
            {reasonsList.length > 0 ? "View Reasons" : "No reasons"}
          </Text>
        </Button>
      }
      onClose={toggleActive}
      sectioned={false}
    >
      <Box padding="400" width="350px">
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">Assessment Reasons</Text>
          <BlockStack gap="200">
            {reasonsList.length > 0 ? (
              reasonsList.map((reason, index) => (
                <Box 
                  key={index} 
                  padding="200" 
                  background="bg-surface-secondary" 
                  borderRadius="100"
                  borderWidth="100"
                  borderColor="border-subdued"
                >
                  <Text variant="bodySm" as="p">
                    • {reason}
                  </Text>
                </Box>
              ))
            ) : (
              <Text tone="subdued">No detailed reasons provided.</Text>
            )}
          </BlockStack>
        </BlockStack>
      </Box>
    </Popover>
  );
};

/* ================= DASHBOARD UI ================= */

function DashboardUI() {
  // 1. SAFETY NET: Default to an empty object if loader is undefined
  const data = useLoaderData() || {};

  // 2. ERROR HANDLING: Show error banner if loader caught an error
  if (!data || data.error) {
    return (
      <Page title="System Error">
        <Banner tone="critical" title="Data Load Error">
          <p>{data?.error || "Could not retrieve dashboard data. Please check your database connection."}</p>
        </Banner>
      </Page>
    );
  }

  // 3. MORE SAFETY NETS: Default fallback arrays
  const recentScores = data.recentScores || [];
  const kpis = data.kpis || { totalAnalyzed: 0, highRiskCount: 0, mediumRiskCount: 0 };
  const orderCount = data.orderCount || 0;

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(recentScores);

  const rows = recentScores.map(
    ({ id, orderId, orderValue, paymentType, riskLevel, score, reasons }, index) => {
      // Clean up the shopify order ID for display (e.g., removing gid://)
      const cleanId = orderId ? orderId.replace("gid://shopify/Order/", "") : "N/A";

      return (
        <IndexTable.Row
          id={id}
          key={id}
          position={index}
          selected={selectedResources.includes(id)}
        >
          <IndexTable.Cell>
            <Text fontWeight="bold" as="span">#{cleanId}</Text>
          </IndexTable.Cell>

          <IndexTable.Cell>
            <Text as="span" numeric>₹{Number(orderValue || 0).toFixed(2)}</Text>
          </IndexTable.Cell>

          <IndexTable.Cell>
            <Badge tone="info">{paymentType || "UNKNOWN"}</Badge>
          </IndexTable.Cell>

          <IndexTable.Cell>
            <RiskBadge level={riskLevel} score={score} />
          </IndexTable.Cell>

          <IndexTable.Cell>
            <ReasonsPopover reasons={reasons} />
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }
  );

  return (
    <Page title="Zippyy Risk Engine" subtitle="Real-time fraud analysis and prevention">
      <Layout>
        {/* Top Sync Status */}
        <Layout.Section>
          <Banner tone="info">
            <p>
              Your Data Warehouse is synced and actively monitoring <strong>{orderCount}</strong> historical orders.
            </p>
          </Banner>
        </Layout.Section>

        {/* KPI Scoreboard */}
        <Layout.Section>
          <Grid>
            <Grid.Cell columnSpan={{ xs: 6, md: 4 }}>
              <Card background="bg-surface-secondary">
                <BlockStack gap="100">
                  <Text variant="headingSm" tone="subdued">Recent Orders Assessed</Text>
                  <Text variant="headingXl" as="p">{kpis.totalAnalyzed}</Text>
                </BlockStack>
              </Card>
            </Grid.Cell>

            <Grid.Cell columnSpan={{ xs: 6, md: 4 }}>
              <Card background="bg-surface-critical-subdued">
                <BlockStack gap="100">
                  <Text variant="headingSm" tone="critical">High Risk Intercepted</Text>
                  <Text variant="headingXl" as="p" tone="critical">{kpis.highRiskCount}</Text>
                </BlockStack>
              </Card>
            </Grid.Cell>

            <Grid.Cell columnSpan={{ xs: 6, md: 4 }}>
              <Card background="bg-surface-warning-subdued">
                <BlockStack gap="100">
                  <Text variant="headingSm" tone="caution">Medium Risk Flagged</Text>
                  <Text variant="headingXl" as="p">{kpis.mediumRiskCount}</Text>
                </BlockStack>
              </Card>
            </Grid.Cell>
          </Grid>
        </Layout.Section>

        {/* Data Log */}
        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <Text variant="headingMd" as="h2">Actionable Intelligence Log</Text>
            </Box>
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={recentScores.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Order ID" },
                { title: "Value" },
                { title: "Payment Method" },
                { title: "Risk Score" },
                { title: "Reasons" },
              ]}
              emptyState={
                <Box padding="400">
                  <Text alignment="center" tone="subdued">
                    No risk scores generated yet.
                  </Text>
                </Box>
              }
            >
              {rows}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

/* ================= APP WRAPPER ================= */

export default function Index() {
  return (
    <AppProvider i18n={enTranslations}>
      <DashboardUI />
    </AppProvider>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};