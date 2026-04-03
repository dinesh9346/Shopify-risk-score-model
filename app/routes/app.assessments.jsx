import { useLoaderData, useSearchParams, useRevalidator  } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState, useMemo, useEffect } from "react"; 
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
  Grid,
  Banner,
  Box,
  Popover,
  Button,
  Link,
  InlineStack,
  Tabs 
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

//BACKEND LOADER
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const orderCount = await prisma.shopify_store_order.count({
      where: { shop }
    });

    const recentScores = await prisma.zippyy_risk_score.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        order: true
      }
    });

    const safeScores = recentScores.map((score) => ({
      id: score.id,
      orderId: score.order?.shopifyOrderId || score.orderId, 
      orderValue: Number(score.order?.orderValue ?? 0),
      paymentType: score.order?.financialStatus || "UNKNOWN",
      
      // Pulls Email first, then Phone, then defaults to "Guest"
      customerName: score.order?.customerEmail || score.order?.customerPhone || "Guest",
      
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
    return Response.json({
      error: error.message,
      orderCount: 0,
      recentScores: [],
      kpis: { totalAnalyzed: 0, highRiskCount: 0, mediumRiskCount: 0 }
    });
  }
};


const RiskBadge = ({ level }) => {
  let tone = "success";
  if (level === "HIGH") tone = "critical";
  if (level === "MEDIUM") tone = "warning";

  return (
    <Badge tone={tone}>
      {level}
    </Badge>
  );
};

const ReasonsPopover = ({ reasons, active, onToggle }) => {
  const reasonsList = reasons
    ? reasons.split(/[|,\n]/).map((r) => r.trim()).filter(Boolean)
    : [];

  return (
    <Popover
      active={active}
      activator={
        <Button onClick={onToggle} plain monochrome removeUnderline>
          <Text variant="bodyMd" tone="subdued" decoration="underline">
            {reasonsList.length > 0 ? "View Reasons" : "No reasons"}
          </Text>
        </Button>
      }
      onClose={onToggle}
      sectioned={false}
    >
      <Box padding="400" width="350px">
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingSm" as="h3">Assessment Reasons</Text>
            <Button onClick={onToggle} plain tone="critical">Close</Button>
          </InlineStack>

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

 //DASHBOARD UI 

function DashboardUI() {
  const data = useLoaderData() || {};
  const [activePopoverId, setActivePopoverId] = useState(null);
  
  // URL Param checking
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  
  const [selectedTab, setSelectedTab] = useState(0);

  const { revalidate, state } = useRevalidator();

  // Sync the UI tab state with the URL parameter 
  useEffect(() => {
    if (tabParam === "high-risk") setSelectedTab(1);
    else if (tabParam === "medium-risk") setSelectedTab(2);
    else setSelectedTab(0);
  }, [tabParam]);

  if (!data || data.error) {
    return (
      <Page title="System Error">
        <Banner tone="critical" title="Data Load Error">
          <p>{data?.error || "Could not retrieve dashboard data."}</p>
        </Banner>
      </Page>
    );
  }

  const recentScores = data.recentScores || [];
  const kpis = data.kpis || { totalAnalyzed: 0, highRiskCount: 0, mediumRiskCount: 0 };
  const orderCount = data.orderCount || 0;

  const tabs = [
    { id: "all", content: "All Analyzed" },
    { id: "high-risk", content: "High Risk" },
    { id: "medium-risk", content: "Medium Risk" },
  ];

  const handleTabChange = (selectedTabIndex) => {
    setSelectedTab(selectedTabIndex);
    if (selectedTabIndex === 1) setSearchParams({ tab: "high-risk" }, { replace: true });
    else if (selectedTabIndex === 2) setSearchParams({ tab: "medium-risk" }, { replace: true });
    else setSearchParams({}, { replace: true });
  };

  const filteredScores = useMemo(() => {
    if (selectedTab === 1) return recentScores.filter((s) => s.riskLevel === "HIGH");
    if (selectedTab === 2) return recentScores.filter((s) => s.riskLevel === "MEDIUM");
    return recentScores;
  }, [recentScores, selectedTab]);

  const rows = filteredScores.map(
    ({ id, orderId, orderValue, paymentType, riskLevel, score, reasons, createdAt, customerName }, index) => {
      const cleanId = orderId ? orderId.replace("gid://shopify/Order/", "") : "N/A";
      
      const formattedDate = createdAt 
        ? new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }).format(new Date(createdAt))
        : "N/A";

      return (
        <IndexTable.Row id={id} key={id} position={index}>
          <IndexTable.Cell><Text as="span">{formattedDate}</Text></IndexTable.Cell>
          <IndexTable.Cell>
            <Link url={`shopify:admin/orders/${cleanId}`} removeUnderline target="_top">
              <Text fontWeight="bold" as="span">#{cleanId}</Text>
            </Link>
          </IndexTable.Cell>
          <IndexTable.Cell><Text as="span">{customerName}</Text></IndexTable.Cell>
          <IndexTable.Cell><Text as="span" numeric>₹{Number(orderValue || 0).toFixed(2)}</Text></IndexTable.Cell>
          <IndexTable.Cell><Badge tone="info">{paymentType || "UNKNOWN"}</Badge></IndexTable.Cell>
          <IndexTable.Cell><RiskBadge level={riskLevel} /></IndexTable.Cell>
          <IndexTable.Cell>
            <ReasonsPopover 
              reasons={reasons} 
              active={activePopoverId === id}
              onToggle={() => setActivePopoverId(activePopoverId === id ? null : id)}
            />
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }
  );

  return (
    <Page 
      title="Zippyy Risk Engine" 
      subtitle="Real-time fraud analysis and prevention"
      primaryAction={{
        content: "Refresh Data",
        onAction: () => revalidate(),
        loading: state === "loading",
      }}
    >
      <Layout>
        <Layout.Section>
          <Banner tone="info">
            <p>Your Data Warehouse is synced and actively monitoring <strong>{orderCount}</strong> historical orders.</p>
          </Banner>
        </Layout.Section>

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

        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange} fitted />
            
            <Box padding="400">
              <Text variant="headingMd" as="h2">Actionable Intelligence Log</Text>
            </Box>
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={filteredScores.length}
              selectable={false} 
              headings={[
                { title: "Date" },
                { title: "Order ID" },
                { title: "Customer" },
                { title: "Value" },
                { title: "Payment Method" },
                { title: "Risk Score" },
                { title: "Reasons" },
              ]}
              emptyState={
                <Box padding="400">
                  <Text alignment="center" tone="subdued">No matching risk scores found.</Text>
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

//APP WRAPPER 

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

