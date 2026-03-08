import { useLoaderData, useNavigation, useSubmit } from "react-router";
import { useState, useCallback, useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  useIndexResourceState,
  Text,
  Badge,
  Modal,
  BlockStack,
  InlineStack,
  Divider,
  Button,
  EmptyState,
  InlineGrid,
  Tabs,
  Banner,
} from "@shopify/polaris";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/* ================= BACKEND LOADER ================= */

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // 1. Fetch all orders
  const allOrders = await prisma.shopify_store_order.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  // 2. Aggregate Orders into Buyer Profiles dynamically
  const customerMap = new Map();

  allOrders.forEach((order) => {
    const customerId = order.customerId || `guest-${order.id}`;
    const email = order.customerEmail || "Guest Buyer";
    const orderValue = Number(order.orderValue || 0);

    if (!customerMap.has(customerId)) {
      customerMap.set(customerId, {
        id: customerId,
        email: email,
        phone: order.customerPhone,
        totalCheckoutAttempts: 0,
        validOrderCount: 0,
        totalSpend: 0,
        fulfilledCount: 0,
        cancelledCount: 0,
        rtoCount: 0,
        codCount: 0,
        unpaidCount: 0,
        disputeCount: 0,
        refundCount: 0,
      });
    }

    const profile = customerMap.get(customerId);
    profile.totalCheckoutAttempts += 1;

    // Logistics & Payment Type Check
    const isCod = order.paymentGateway?.toLowerCase().includes("cod") || order.paymentGateway?.toLowerCase().includes("cash");
    if (isCod) profile.codCount += 1;

    if (order.isRTO) {
      profile.rtoCount += 1;
    } else if (order.cancelledAt) {
      profile.cancelledCount += 1;
    } else if (order.fulfillmentStatus === "FULFILLED") {
      profile.fulfilledCount += 1;
    }

    if (order.financialStatus === "PENDING") {
      profile.unpaidCount += 1;
    } else if (order.financialStatus === "REFUNDED" || order.financialStatus === "PARTIALLY_REFUNDED") {
      profile.refundCount += 1;
    }

    if (order.hasDispute) {
      profile.disputeCount += 1;
    }

    // 🔥 VALID ORDER DEFINITION: Must be Paid AND Fulfilled
    const isPaid = order.financialStatus && order.financialStatus.toUpperCase() === "PAID";
    const isFulfilled = order.fulfillmentStatus && order.fulfillmentStatus.toUpperCase() === "FULFILLED";

    if (isPaid && isFulfilled && !order.hasDispute && !order.cancelledAt && !order.isRTO) {
      profile.validOrderCount += 1;
      profile.totalSpend += orderValue;
    }
  });

  // 3. KPI Metrics & Segment Assignments
  let totalSecuredRevenue = 0;
  let totalValidOrders = 0;
  let totalCheckouts = 0;
  let totalFulfilled = 0;

  const segmentCounts = { VIP: 0, "Repeat Buyer": 0, New: 0, "High Risk": 0 };
  const logisticsData = { fulfilled: 0, rto: 0, cancelled: 0, unpaid: 0 };

  const profiles = Array.from(customerMap.values()).map((profile) => {
    // --- EVALUATE RISK FACTORS ---
    let reasons = [];
    const total = profile.totalCheckoutAttempts;
    
    // Calculate Rates
    const cancelRate = total > 0 ? profile.cancelledCount / total : 0;
    const rtoRate = total > 0 ? profile.rtoCount / total : 0;
    const codRate = total > 0 ? profile.codCount / total : 0;
    const refundRate = total > 0 ? profile.refundCount / total : 0;

    // Fraud / Risk Logic Rules
  // Fraud / Risk Logic Rules
    if (profile.disputeCount > 0) reasons.push("Dispute History");
    
    // 1. Original Percentage Rules (Catch people with few orders but high fail rates)
    if (profile.rtoCount >= 2 && rtoRate >= 0.3) reasons.push("Heavy RTO");
    if (profile.cancelledCount >= 3 && cancelRate >= 0.4) reasons.push("Heavy Cancellations");
    if (profile.refundCount >= 2 && refundRate >= 0.3) reasons.push("Heavy Refunds");
    if (codRate >= 0.6 && profile.fulfilledCount === 0 && total >= 2) reasons.push("COD Abuse (No Deliveries)");

    // 2. 🔥 NEW RULE: Catch Serial Abandoners / Bots (Like the one in your photo)
    if (total >= 10 && profile.validOrderCount === 0) reasons.push("Serial Abandoner (Bot/Fraud)");

    // 3. 🔥 NEW RULE: High Volume Overrides (Ignores percentages if they just cancel/refund a ton)
    if (profile.cancelledCount >= 10) reasons.push("High Cancellation Volume");
    if (profile.refundCount >= 5) reasons.push("High Refund Volume");

    // --- DETERMINE SEGMENT ---
    let segment = "New";
    
    if (reasons.length > 0) {
      segment = "High Risk";
    } else if (profile.validOrderCount >= 3) {
      segment = "VIP";
    } else if (profile.validOrderCount === 2) {
      segment = "Repeat Buyer";
    }

    profile.buyerSegment = segment;

    // Tally Dash Stats
    totalSecuredRevenue += profile.totalSpend;
    totalValidOrders += profile.validOrderCount;
    totalCheckouts += profile.totalCheckoutAttempts;
    totalFulfilled += profile.fulfilledCount;

    segmentCounts[segment] += 1;
    logisticsData.fulfilled += profile.fulfilledCount;
    logisticsData.rto += profile.rtoCount;
    logisticsData.cancelled += profile.cancelledCount;
    logisticsData.unpaid += profile.unpaidCount;

    return profile;
  });

  // Sort by highest spend
  profiles.sort((a, b) => b.totalSpend - a.totalSpend);

  // 4. Format Data for Recharts
  const segmentChartData = [
    { name: "VIP", value: segmentCounts["VIP"], color: "#008060" },
    { name: "Repeat", value: segmentCounts["Repeat Buyer"], color: "#2c6ecb" },
    { name: "New", value: segmentCounts["New"], color: "#8c9196" },
    { name: "High Risk", value: segmentCounts["High Risk"], color: "#d82c0d" },
  ].filter((item) => item.value > 0);

  const logisticsChartData = [
    { name: "Fulfilled", count: logisticsData.fulfilled, fill: "#008060" },
    { name: "RTO", count: logisticsData.rto, fill: "#d82c0d" },
    { name: "Cancelled", count: logisticsData.cancelled, fill: "#ffc453" },
    { name: "Unpaid", count: logisticsData.unpaid, fill: "#8c9196" },
  ];

  const safeFulfillmentRate =
    totalCheckouts > 0 ? Math.round((totalFulfilled / totalCheckouts) * 100) : 0;

  return Response.json({
    profiles,
    dashboardStats: {
      totalSecuredRevenue,
      totalValidOrders,
      safeFulfillmentRate,
      segmentChartData,
      logisticsChartData,
      highRiskCount: segmentCounts["High Risk"]
    },
  });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  return Response.json({ ok: true });
};

/* ================= FRONTEND UI ================= */

export default function Index() {
  const { profiles, dashboardStats } = useLoaderData() || { profiles: [], dashboardStats: {} };
  const navigation = useNavigation();
  const submit = useSubmit();

  const isRefreshing = navigation.state === "submitting" || navigation.state === "loading";

  const [activeModal, setActiveModal] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [isMounted, setIsMounted] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const toggleModal = useCallback(() => setActiveModal((active) => !active), []);

  const handleRowClick = (profile) => {
    setSelectedProfile(profile);
    setActiveModal(true);
  };

  const handleRefresh = () => {
    submit({}, { method: "post" });
  };

  // 🔥 CURRENCY FORMATTER: Updated to INR (₹)
  const formatCurrency = (amount) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount || 0);
  };

  const getSegmentBadge = (segment) => {
    switch (segment) {
      case "VIP": return <Badge tone="success">VIP</Badge>;
      case "Repeat Buyer": return <Badge tone="info">Repeat Buyer</Badge>;
      case "High Risk": return <Badge tone="critical">High Risk</Badge>;
      default: return <Badge>New</Badge>;
    }
  };

  /* --- TAB STATE & FILTERING --- */
  const tabs = [
    { id: "all", content: "All Customers" },
    { 
      id: "risk", 
      content: "High Risk",
      badge: dashboardStats?.highRiskCount > 0 ? dashboardStats.highRiskCount.toString() : undefined
    },
    { id: "vip", content: "VIPs" },
    { id: "repeat", content: "Repeat Buyers" },
    { id: "new", content: "New" },
  ];

  const filteredProfiles = profiles.filter((profile) => {
    if (selectedTab === 0) return true; 
    if (selectedTab === 1) return profile.buyerSegment === "High Risk";
    if (selectedTab === 2) return profile.buyerSegment === "VIP";
    if (selectedTab === 3) return profile.buyerSegment === "Repeat Buyer";
    if (selectedTab === 4) return profile.buyerSegment === "New";
    return true;
  });

  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(filteredProfiles);

  const rowMarkup = filteredProfiles.map((profile, index) => {
    return (
      <IndexTable.Row
        id={profile.id}
        key={profile.id}
        selected={selectedResources.includes(profile.id)}
        position={index}
        onClick={() => handleRowClick(profile)}
      >
        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="bold" as="span">{profile.email}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{getSegmentBadge(profile.buyerSegment)}</IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" alignment="end">{profile.validOrderCount}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" alignment="end">{formatCurrency(profile.totalSpend)}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {profile.riskReasons?.length > 0 ? (
            <InlineStack gap="100" wrap>
              {profile.riskReasons.map((reason, i) => (
                <Badge tone="warning" key={i}>{reason}</Badge>
              ))}
            </InlineStack>
          ) : (
            <Text tone="subdued">Clean History</Text>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  if (!profiles || profiles.length === 0) {
    return (
      <Page title="Buyer Profiling CRM">
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Awaiting customer data sync"
                action={{ content: "Refresh Dashboard", onAction: handleRefresh, loading: isRefreshing }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>We are processing historical orders to build buyer profiles.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Buyer Profiling CRM"
      primaryAction={<Button onClick={handleRefresh} loading={isRefreshing}>Refresh Data</Button>}
    >
      <Layout>
        {/* HERO KPIs */}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Total Verified Revenue</Text>
                <Text as="p" variant="headingLg" tone="success">
                  {formatCurrency(dashboardStats.totalSecuredRevenue)}
                </Text>
              </BlockStack>
            </Card>
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Total Valid Orders</Text>
                <Text as="p" variant="headingLg">
                  {dashboardStats.totalValidOrders}
                </Text>
              </BlockStack>
            </Card>
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Safe Fulfillment</Text>
                <Text as="p" variant="headingLg">
                  {dashboardStats.safeFulfillmentRate}%
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        {/* VISUAL CHARTS */}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Customer Segments</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={dashboardStats.segmentChartData}
                          innerRadius={65}
                          outerRadius={90}
                          paddingAngle={5}
                          dataKey="value"
                        >
                          {dashboardStats.segmentChartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <RechartsTooltip formatter={(value) => [`${value} Customers`, "Count"]} />
                        <Legend verticalAlign="bottom" height={36} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>

            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Logistics Breakdown</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dashboardStats.logisticsChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                        <RechartsTooltip cursor={{ fill: "rgba(0,0,0,0.05)" }} />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {dashboardStats.logisticsChartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        {/* INTERACTIVE CRM TABLE */}
        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
              <IndexTable
                resourceName={{ singular: "customer", plural: "customers" }}
                itemCount={filteredProfiles.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: "Customer" },
                  { title: "Segment" },
                  { title: "Valid Orders", alignment: "end" },
                  { title: "Verified Revenue", alignment: "end" },
                  { title: "Risk Factors" },
                ]}
              >
                {rowMarkup}
              </IndexTable>
            </Tabs>
          </Card>
        </Layout.Section>
      </Layout>

      {/* CUSTOMER DEEP DIVE MODAL */}
      {selectedProfile && (
        <Modal
          open={activeModal}
          onClose={toggleModal}
          title={`Profile: ${selectedProfile.email}`}
          primaryAction={{ content: "Close", onAction: toggleModal }}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h3">Contact Information</Text>
                {getSegmentBadge(selectedProfile.buyerSegment)}
              </InlineStack>

              <BlockStack gap="200">
                <Text as="p" tone="subdued">Email: {selectedProfile.email}</Text>
                <Text as="p" tone="subdued">Phone: {selectedProfile.phone || "N/A"}</Text>
              </BlockStack>

              {/* Display Risk Reasons in the Modal if High Risk */}
              {selectedProfile.buyerSegment === "High Risk" && selectedProfile.riskReasons && selectedProfile.riskReasons.length > 0 && (
                <Banner tone="critical" title="High Risk Customer Flags">
                  <BlockStack gap="200">
                    <Text as="p">This buyer was flagged for the following patterns:</Text>
                    <ul>
                      {selectedProfile.riskReasons.map((reason, idx) => (
                        <li key={idx}><Text as="span" fontWeight="bold">{reason}</Text></li>
                      ))}
                    </ul>
                  </BlockStack>
                </Banner>
              )}
              <Divider />
              <Text variant="headingMd" as="h3">Verified Revenue Metrics</Text>
              <InlineStack align="space-between">
                <Card roundedAbove="sm">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm" tone="subdued">Total Spend (Paid & Delivered)</Text>
                    <Text as="p" variant="headingLg">{formatCurrency(selectedProfile.totalSpend)}</Text>
                  </BlockStack>
                </Card>
                <Card roundedAbove="sm">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm" tone="subdued">Valid Orders</Text>
                    <Text as="p" variant="headingLg">{selectedProfile.validOrderCount}</Text>
                  </BlockStack>
                </Card>
              </InlineStack>

              <Divider />
              <Text variant="headingMd" as="h3">Logistics & Incident Overview</Text>
              <Card roundedAbove="sm" background="bg-surface-secondary">
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="span">Total Checkout Attempts</Text>
                    <Text as="span" fontWeight="bold">{selectedProfile.totalCheckoutAttempts}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span">Successfully Fulfilled</Text>
                    <Text as="span" tone="success" fontWeight="bold">{selectedProfile.fulfilledCount}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span">Cancelled / Rejected</Text>
                    <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.cancelledCount}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span">Cash on Delivery (COD)</Text>
                    <Text as="span" fontWeight="bold">{selectedProfile.codCount}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span">Returned to Origin (RTO)</Text>
                    <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.rtoCount || 0}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span">Refunds</Text>
                    <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.refundCount}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span">Disputes / Chargebacks</Text>
                    <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.disputeCount}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}

export { boundary };
