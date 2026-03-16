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
  Box,
  Scrollable
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

  // 1. Fetch profiles (1 Database Connection)
  const profilesData = await prisma.zippyy_buyer_profile.findMany({
    where: { shop },
    orderBy: { totalCheckoutAttempts: "desc" },
  });

  // 🔥 THE FIX: Fetch all relevant tracking data in ONE bulk query instead of a loop! (1 Database Connection)
  const allStoreOrders = await prisma.shopify_store_order.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" }, // Still sorted by newest so the .find() grabs the latest one
    select: { 
      carrier: true, 
      trackingNumber: true, 
      trackingUrl: true, 
      shipmentStatus: true, 
      fulfillmentStatus: true,
      customerEmail: true,
      customerPhone: true,
      customerId: true
    }
  });

  let totalSecuredRevenue = 0;
  let totalValidOrders = 0;
  let totalCheckouts = 0;
  let totalFulfilled = 0;

  const segmentCounts = { VIP: 0, "Repeat Buyer": 0, Watchlist: 0, New: 0, "High Risk": 0 };
  const logisticsData = { fulfilled: 0, rto: 0, cancelled: 0, unpaid: 0 };

  // 🔥 THE FIX: Removed Promise.all and async. This is now instant, synchronous JavaScript math!
  const profiles = profilesData.map((p) => {
    totalSecuredRevenue += p.totalSpend;
    totalValidOrders += p.validOrderCount;
    totalCheckouts += p.totalCheckoutAttempts;
    totalFulfilled += p.fulfilledCount;

    if (segmentCounts[p.buyerSegment] !== undefined) {
      segmentCounts[p.buyerSegment] += 1;
    }
    
    logisticsData.fulfilled += p.fulfilledCount;
    logisticsData.rto += p.rtoCount;
    logisticsData.cancelled += p.cancelledCount;
    logisticsData.unpaid += p.unpaidCount;

    let displayName = [p.firstName, p.lastName].filter(Boolean).join(" ");
    
    if (!displayName) displayName = p.customerEmail;
    if (!displayName) displayName = p.customerPhone;
    if (!displayName) {
      if (p.buyerIdentifier.includes('Customer/')) {
        displayName = `Shopify User #${p.buyerIdentifier.split('/').pop()}`;
      } else if (p.buyerIdentifier.includes('Order/')) {
        displayName = `Guest Buyer`;
      } else {
        displayName = "Anonymous";
      }
    }

    // 🔥 THE FIX: Search the pre-loaded array in memory instead of hitting the database!
    let latestOrder = null;
    if (p.customerEmail || p.customerPhone || p.customerId) {
      latestOrder = allStoreOrders.find(o => 
        (p.customerEmail && o.customerEmail === p.customerEmail) ||
        (p.customerPhone && o.customerPhone === p.customerPhone) ||
        (p.customerId && o.customerId === p.customerId)
      ) || null;
    }

    return {
      ...p,
      displayName,
      latestOrder, 
      riskReasons: p.riskReasons ? p.riskReasons.split(",").map(r => r.trim()).filter(Boolean) : [],
    };
  });

  const segmentChartData = [
    { name: "VIP", value: segmentCounts["VIP"], color: "#008060" },
    { name: "Repeat", value: segmentCounts["Repeat Buyer"], color: "#2c6ecb" },
    { name: "Watchlist", value: segmentCounts["Watchlist"], color: "#e67300" }, 
    { name: "New", value: segmentCounts["New"], color: "#8c9196" },
    { name: "High Risk", value: segmentCounts["High Risk"], color: "#d82c0d" },
  ].filter((item) => item.value > 0);

  const logisticsChartData = [
    { name: "Fulfilled", count: logisticsData.fulfilled, fill: "#008060" },
    { name: "RTO", count: logisticsData.rto, fill: "#d82c0d" },
    { name: "Cancelled", count: logisticsData.cancelled, fill: "#ffc453" },
    { name: "Unpaid", count: logisticsData.unpaid, fill: "#8c9196" },
  ];

  const safeFulfillmentRate = totalCheckouts > 0 ? Math.round((totalFulfilled / totalCheckouts) * 100) : 0;

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

/* ================= FRONTEND UI ================= */

export default function Index() {
  const { profiles, dashboardStats } = useLoaderData() || { profiles: [], dashboardStats: {} };
  const navigation = useNavigation();
  const submit = useSubmit();

  const isRefreshing = navigation.state === "submitting" || navigation.state === "loading";

  const [activeModal, setActiveModal] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState(null); 
  const [isMounted, setIsMounted] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const toggleModal = useCallback(() => {
    setActiveModal((active) => !active);
    if (activeModal) setSelectedProfileId(null);
  }, [activeModal]);

  const handleRowClick = (profile) => {
    setSelectedProfileId(profile.id);
    setActiveModal(true);
  };

  const handleRefresh = () => {
    submit({}, { method: "post" });
  };

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
      case "Watchlist": return <Badge tone="warning">Watchlist</Badge>; 
      case "High Risk": return <Badge tone="critical">High Risk</Badge>;
      default: return <Badge>New</Badge>;
    }
  };

  const tabs = [
    { id: "all", content: "All Customers" },
    { id: "risk", content: "High Risk", badge: dashboardStats?.highRiskCount > 0 ? dashboardStats.highRiskCount.toString() : undefined },
    { id: "watchlist", content: "Watchlist" }, 
    { id: "vip", content: "VIPs" },
    { id: "repeat", content: "Repeat Buyers" },
    { id: "new", content: "New" },
  ];

  const filteredProfiles = profiles.filter((profile) => {
    if (selectedTab === 0) return true; 
    if (selectedTab === 1) return profile.buyerSegment === "High Risk";
    if (selectedTab === 2) return profile.buyerSegment === "Watchlist"; 
    if (selectedTab === 3) return profile.buyerSegment === "VIP";
    if (selectedTab === 4) return profile.buyerSegment === "Repeat Buyer";
    if (selectedTab === 5) return profile.buyerSegment === "New";
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
          <BlockStack gap="0">
            <Text variant="bodyMd" fontWeight="bold" as="span">{profile.displayName}</Text>
            {profile.customerPhone && (
              <Text variant="bodySm" tone="subdued">{profile.customerPhone}</Text>
            )}
          </BlockStack>
        </IndexTable.Cell>

        <IndexTable.Cell>{getSegmentBadge(profile.buyerSegment)}</IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" alignment="end" fontWeight="bold">{profile.totalCheckoutAttempts}</Text>
        </IndexTable.Cell>
        
        <IndexTable.Cell>
          <Text as="span" alignment="end" tone={profile.validOrderCount === 0 ? "critical" : "success"}>
            {profile.validOrderCount}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" alignment="end">{formatCurrency(profile.totalSpend)}</Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          {profile.riskReasons?.length > 0 ? (
            <InlineStack gap="100" wrap>
              {profile.riskReasons.map((reason, i) => (
                <Badge tone="critical" key={i}>{reason}</Badge>
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
              <EmptyState heading="Awaiting customer data sync" action={{ content: "Refresh Dashboard", onAction: handleRefresh, loading: isRefreshing }}>
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
      <style>{`
        .Polaris-IndexTable__StickyTable {
          display: none !important;
        }
        .Polaris-IndexTable__Table thead th {
          position: sticky !important;
          top: 0 !important;
          z-index: 30 !important;
          background-color: var(--p-color-bg-surface) !important;
          box-shadow: 0 1px 0 0 var(--p-color-border-subdued) !important;
        }
      `}</style>

      <Layout>
        {/* HERO KPIs */}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Total Verified Revenue</Text>
                <Text as="p" variant="headingLg" tone="success">{formatCurrency(dashboardStats.totalSecuredRevenue)}</Text>
              </BlockStack>
            </Card>
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Total Valid Orders</Text>
                <Text as="p" variant="headingLg">{dashboardStats.totalValidOrders}</Text>
              </BlockStack>
            </Card>
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Safe Fulfillment</Text>
                <Text as="p" variant="headingLg">{dashboardStats.safeFulfillmentRate}%</Text>
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
                        <Pie data={dashboardStats.segmentChartData} innerRadius={65} outerRadius={90} paddingAngle={5} dataKey="value">
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

        {/* MODERN UI: SCROLLABLE TABLE */}
        <Layout.Section>
          <Card padding="0">
            <Box padding="200">
              <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} fitted />
            </Box>
            
            <Divider />

            {/* This container locks the height and allows clean internal scrolling */}
            <Scrollable style={{ height: "450px" }} focusable>
              <IndexTable
                resourceName={{ singular: "customer", plural: "customers" }}
                itemCount={filteredProfiles.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: "Customer Identity" },
                  { title: "Segment" },
                  { title: "Total Checkouts", alignment: "end" },
                  { title: "Valid Orders", alignment: "end" },
                  { title: "Verified Revenue", alignment: "end" },
                  { title: "Risk Factors" },
                ]}
              >
                {rowMarkup}
              </IndexTable>
            </Scrollable>
          </Card>
        </Layout.Section>
      </Layout>

      {/* CUSTOMER DEEP DIVE MODAL */}
      {selectedProfile && (
        <Modal
          open={activeModal}
          onClose={toggleModal}
          title={`Customer Insight`}
          primaryAction={{ content: "Close", onAction: toggleModal }}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h3">{selectedProfile.displayName}</Text>
                {getSegmentBadge(selectedProfile.buyerSegment)}
              </InlineStack>

              <BlockStack gap="200">
                <Text as="p" tone="subdued">Email: {selectedProfile.customerEmail || "Not Provided"}</Text>
                <Text as="p" tone="subdued">Phone: {selectedProfile.customerPhone || "Not Provided"}</Text>
              </BlockStack>

              {(selectedProfile.buyerSegment === "High Risk" || selectedProfile.buyerSegment === "Watchlist") && selectedProfile.riskReasons.length > 0 && (
                <Banner 
                  tone={selectedProfile.buyerSegment === "High Risk" ? "critical" : "warning"} 
                  title={`${selectedProfile.buyerSegment} Customer Flags`}
                >
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
                    <Text as="span">Returned to Origin (RTO)</Text>
                    <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.rtoCount || 0}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span">Disputes / Chargebacks</Text>
                    <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.disputeCount}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* Latest Logistics & Tracking Card - ONLY SHOWS IF DATA EXISTS */}
              {(selectedProfile.latestOrder?.carrier || selectedProfile.latestOrder?.trackingNumber) && (
                <>
                  <Divider />
                  <Text variant="headingMd" as="h3">Latest Tracking</Text>
                  <Card roundedAbove="sm" background="bg-surface-secondary">
                    <BlockStack gap="300">
                      <InlineStack align="space-between">
                        <Text as="span" tone="subdued">Courier Name</Text>
                        <Text as="span" fontWeight="bold">
                          {selectedProfile.latestOrder?.carrier || "Pending Dispatch"}
                        </Text>
                      </InlineStack>

                      <InlineStack align="space-between">
                        <Text as="span" tone="subdued">Status</Text>
                        {selectedProfile.latestOrder?.shipmentStatus === "failure" || selectedProfile.latestOrder?.shipmentStatus === "returned" ? (
                          <Badge tone="critical">RTO / Failed Delivery</Badge>
                        ) : selectedProfile.latestOrder?.shipmentStatus === "delivered" ? (
                          <Badge tone="success">Delivered</Badge>
                        ) : selectedProfile.latestOrder?.fulfillmentStatus?.toUpperCase() === "SUCCESS" || selectedProfile.latestOrder?.fulfillmentStatus?.toUpperCase() === "FULFILLED" ? (
                          <Badge tone="info">In Transit</Badge> 
                        ) : (
                          <Badge>Processing</Badge>
                        )}
                      </InlineStack>

                      {selectedProfile.latestOrder?.trackingNumber && (
                        <InlineStack align="space-between">
                          <Text as="span" tone="subdued">Tracking Number</Text>
                          {selectedProfile.latestOrder?.trackingUrl ? (
                            <Button variant="plain" url={selectedProfile.latestOrder.trackingUrl} external>
                              {selectedProfile.latestOrder.trackingNumber}
                            </Button>
                          ) : (
                            <Text as="span" fontWeight="bold">{selectedProfile.latestOrder.trackingNumber}</Text>
                          )}
                        </InlineStack>
                      )}
                    </BlockStack>
                  </Card>
                </>
              )}

            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}

export { boundary };






// import { useLoaderData, useNavigation, useSubmit } from "react-router";
// import { useState, useCallback, useEffect } from "react";
// import { boundary } from "@shopify/shopify-app-react-router/server";
// import {
//   Page,
//   Layout,
//   Card,
//   IndexTable,
//   useIndexResourceState,
//   Text,
//   Badge,
//   Modal,
//   BlockStack,
//   InlineStack,
//   Divider,
//   Button,
//   EmptyState,
//   InlineGrid,
//   Tabs,
//   Banner,
//   Box,
//   Scrollable
// } from "@shopify/polaris";
// import {
//   PieChart,
//   Pie,
//   Cell,
//   BarChart,
//   Bar,
//   XAxis,
//   YAxis,
//   Tooltip as RechartsTooltip,
//   ResponsiveContainer,
//   Legend,
// } from "recharts";
// import { authenticate } from "../shopify.server";
// import prisma from "../db.server";

// /* ================= BACKEND LOADER ================= */

// export const loader = async ({ request }) => {
//   const { session } = await authenticate.admin(request);
//   const shop = session.shop;

//   const profilesData = await prisma.zippyy_buyer_profile.findMany({
//     where: { shop },
//     orderBy: { totalCheckoutAttempts: "desc" },
//   });

//   let totalSecuredRevenue = 0;
//   let totalValidOrders = 0;
//   let totalCheckouts = 0;
//   let totalFulfilled = 0;

//   const segmentCounts = { VIP: 0, "Repeat Buyer": 0, Watchlist: 0, New: 0, "High Risk": 0 };
//   const logisticsData = { fulfilled: 0, rto: 0, cancelled: 0, unpaid: 0 };

//   const profiles = profilesData.map((p) => {
//     totalSecuredRevenue += p.totalSpend;
//     totalValidOrders += p.validOrderCount;
//     totalCheckouts += p.totalCheckoutAttempts;
//     totalFulfilled += p.fulfilledCount;

//     if (segmentCounts[p.buyerSegment] !== undefined) {
//       segmentCounts[p.buyerSegment] += 1;
//     }
    
//     logisticsData.fulfilled += p.fulfilledCount;
//     logisticsData.rto += p.rtoCount;
//     logisticsData.cancelled += p.cancelledCount;
//     logisticsData.unpaid += p.unpaidCount;

//     let displayName = p.customerEmail;
//     if (!displayName) displayName = p.customerPhone;
//     if (!displayName) {
//       if (p.buyerIdentifier.includes('Customer/')) {
//         displayName = `Shopify User #${p.buyerIdentifier.split('/').pop()}`;
//       } else if (p.buyerIdentifier.includes('Order/')) {
//         displayName = `Guest Buyer`;
//       } else {
//         displayName = "Anonymous";
//       }
//     }

//     return {
//       ...p,
//       displayName,
//       riskReasons: p.riskReasons ? p.riskReasons.split(",").map(r => r.trim()).filter(Boolean) : [],
//     };
//   });

//   const segmentChartData = [
//     { name: "VIP", value: segmentCounts["VIP"], color: "#008060" },
//     { name: "Repeat", value: segmentCounts["Repeat Buyer"], color: "#2c6ecb" },
//     { name: "Watchlist", value: segmentCounts["Watchlist"], color: "#e67300" }, 
//     { name: "New", value: segmentCounts["New"], color: "#8c9196" },
//     { name: "High Risk", value: segmentCounts["High Risk"], color: "#d82c0d" },
//   ].filter((item) => item.value > 0);

//   const logisticsChartData = [
//     { name: "Fulfilled", count: logisticsData.fulfilled, fill: "#008060" },
//     { name: "RTO", count: logisticsData.rto, fill: "#d82c0d" },
//     { name: "Cancelled", count: logisticsData.cancelled, fill: "#ffc453" },
//     { name: "Unpaid", count: logisticsData.unpaid, fill: "#8c9196" },
//   ];

//   const safeFulfillmentRate = totalCheckouts > 0 ? Math.round((totalFulfilled / totalCheckouts) * 100) : 0;

//   return Response.json({
//     profiles,
//     dashboardStats: {
//       totalSecuredRevenue,
//       totalValidOrders,
//       safeFulfillmentRate,
//       segmentChartData,
//       logisticsChartData,
//       highRiskCount: segmentCounts["High Risk"]
//     },
//   });
// };

// export const action = async ({ request }) => {
//   await authenticate.admin(request);
//   return Response.json({ ok: true });
// };

// /* ================= FRONTEND UI ================= */

// export default function Index() {
//   const { profiles, dashboardStats } = useLoaderData() || { profiles: [], dashboardStats: {} };
//   const navigation = useNavigation();
//   const submit = useSubmit();

//   const isRefreshing = navigation.state === "submitting" || navigation.state === "loading";

//   const [activeModal, setActiveModal] = useState(false);
//   const [selectedProfileId, setSelectedProfileId] = useState(null); 
//   const [isMounted, setIsMounted] = useState(false);
//   const [selectedTab, setSelectedTab] = useState(0);

//   const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

//   useEffect(() => {
//     setIsMounted(true);
//   }, []);

//   const toggleModal = useCallback(() => {
//     setActiveModal((active) => !active);
//     if (activeModal) setSelectedProfileId(null);
//   }, [activeModal]);

//   const handleRowClick = (profile) => {
//     setSelectedProfileId(profile.id);
//     setActiveModal(true);
//   };

//   const handleRefresh = () => {
//     submit({}, { method: "post" });
//   };

//   const formatCurrency = (amount) => {
//     return new Intl.NumberFormat("en-IN", {
//       style: "currency",
//       currency: "INR",
//       minimumFractionDigits: 0,
//       maximumFractionDigits: 2,
//     }).format(amount || 0);
//   };

//   const getSegmentBadge = (segment) => {
//     switch (segment) {
//       case "VIP": return <Badge tone="success">VIP</Badge>;
//       case "Repeat Buyer": return <Badge tone="info">Repeat Buyer</Badge>;
//       case "Watchlist": return <Badge tone="warning">Watchlist</Badge>; 
//       case "High Risk": return <Badge tone="critical">High Risk</Badge>;
//       default: return <Badge>New</Badge>;
//     }
//   };

//   const tabs = [
//     { id: "all", content: "All Customers" },
//     { id: "risk", content: "High Risk", badge: dashboardStats?.highRiskCount > 0 ? dashboardStats.highRiskCount.toString() : undefined },
//     { id: "watchlist", content: "Watchlist" }, 
//     { id: "vip", content: "VIPs" },
//     { id: "repeat", content: "Repeat Buyers" },
//     { id: "new", content: "New" },
//   ];

//   const filteredProfiles = profiles.filter((profile) => {
//     if (selectedTab === 0) return true; 
//     if (selectedTab === 1) return profile.buyerSegment === "High Risk";
//     if (selectedTab === 2) return profile.buyerSegment === "Watchlist"; 
//     if (selectedTab === 3) return profile.buyerSegment === "VIP";
//     if (selectedTab === 4) return profile.buyerSegment === "Repeat Buyer";
//     if (selectedTab === 5) return profile.buyerSegment === "New";
//     return true;
//   });

//   const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(filteredProfiles);

//   const rowMarkup = filteredProfiles.map((profile, index) => {
//     return (
//       <IndexTable.Row
//         id={profile.id}
//         key={profile.id}
//         selected={selectedResources.includes(profile.id)}
//         position={index}
//         onClick={() => handleRowClick(profile)}
//       >
//         <IndexTable.Cell>
//           <BlockStack gap="0">
//             <Text variant="bodyMd" fontWeight="bold" as="span">{profile.displayName}</Text>
//             {profile.customerPhone && (
//               <Text variant="bodySm" tone="subdued">{profile.customerPhone}</Text>
//             )}
//           </BlockStack>
//         </IndexTable.Cell>

//         <IndexTable.Cell>{getSegmentBadge(profile.buyerSegment)}</IndexTable.Cell>

//         <IndexTable.Cell>
//           <Text as="span" alignment="end" fontWeight="bold">{profile.totalCheckoutAttempts}</Text>
//         </IndexTable.Cell>
        
//         <IndexTable.Cell>
//           <Text as="span" alignment="end" tone={profile.validOrderCount === 0 ? "critical" : "success"}>
//             {profile.validOrderCount}
//           </Text>
//         </IndexTable.Cell>

//         <IndexTable.Cell>
//           <Text as="span" alignment="end">{formatCurrency(profile.totalSpend)}</Text>
//         </IndexTable.Cell>

//         <IndexTable.Cell>
//           {profile.riskReasons?.length > 0 ? (
//             <InlineStack gap="100" wrap>
//               {profile.riskReasons.map((reason, i) => (
//                 <Badge tone="critical" key={i}>{reason}</Badge>
//               ))}
//             </InlineStack>
//           ) : (
//             <Text tone="subdued">Clean History</Text>
//           )}
//         </IndexTable.Cell>
//       </IndexTable.Row>
//     );
//   });

//   if (!profiles || profiles.length === 0) {
//     return (
//       <Page title="Buyer Profiling CRM">
//         <Layout>
//           <Layout.Section>
//             <Card>
//               <EmptyState heading="Awaiting customer data sync" action={{ content: "Refresh Dashboard", onAction: handleRefresh, loading: isRefreshing }}>
//                 <p>We are processing historical orders to build buyer profiles.</p>
//               </EmptyState>
//             </Card>
//           </Layout.Section>
//         </Layout>
//       </Page>
//     );
//   }

//   return (
//     <Page 
//       title="Buyer Profiling CRM" 
//       primaryAction={<Button onClick={handleRefresh} loading={isRefreshing}>Refresh Data</Button>}
      
//     >
//       <style>{`
//         .Polaris-IndexTable__StickyTable {
//           display: none !important;
//         }
//         .Polaris-IndexTable__Table thead th {
//           position: sticky !important;
//           top: 0 !important;
//           z-index: 30 !important;
//           background-color: var(--p-color-bg-surface) !important;
//           box-shadow: 0 1px 0 0 var(--p-color-border-subdued) !important;
//         }
//       `}</style>

//       <Layout>
//         {/* HERO KPIs */}
//         <Layout.Section>
//           <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
//             <Card roundedAbove="sm">
//               <BlockStack gap="200">
//                 <Text as="h3" variant="headingSm" tone="subdued">Total Verified Revenue</Text>
//                 <Text as="p" variant="headingLg" tone="success">{formatCurrency(dashboardStats.totalSecuredRevenue)}</Text>
//               </BlockStack>
//             </Card>
//             <Card roundedAbove="sm">
//               <BlockStack gap="200">
//                 <Text as="h3" variant="headingSm" tone="subdued">Total Valid Orders</Text>
//                 <Text as="p" variant="headingLg">{dashboardStats.totalValidOrders}</Text>
//               </BlockStack>
//             </Card>
//             <Card roundedAbove="sm">
//               <BlockStack gap="200">
//                 <Text as="h3" variant="headingSm" tone="subdued">Safe Fulfillment</Text>
//                 <Text as="p" variant="headingLg">{dashboardStats.safeFulfillmentRate}%</Text>
//               </BlockStack>
//             </Card>
//           </InlineGrid>
//         </Layout.Section>

//         {/* VISUAL CHARTS */}
//         <Layout.Section>
//           <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
//             <Card roundedAbove="sm">
//               <BlockStack gap="400">
//                 <Text variant="headingMd" as="h3">Customer Segments</Text>
//                 <div style={{ height: "250px", width: "100%" }}>
//                   {isMounted && (
//                     <ResponsiveContainer width="100%" height="100%">
//                       <PieChart>
//                         <Pie data={dashboardStats.segmentChartData} innerRadius={65} outerRadius={90} paddingAngle={5} dataKey="value">
//                           {dashboardStats.segmentChartData.map((entry, index) => (
//                             <Cell key={`cell-${index}`} fill={entry.color} />
//                           ))}
//                         </Pie>
//                         <RechartsTooltip formatter={(value) => [`${value} Customers`, "Count"]} />
//                         <Legend verticalAlign="bottom" height={36} />
//                       </PieChart>
//                     </ResponsiveContainer>
//                   )}
//                 </div>
//               </BlockStack>
//             </Card>

//             <Card roundedAbove="sm">
//               <BlockStack gap="400">
//                 <Text variant="headingMd" as="h3">Logistics Breakdown</Text>
//                 <div style={{ height: "250px", width: "100%" }}>
//                   {isMounted && (
//                     <ResponsiveContainer width="100%" height="100%">
//                       <BarChart data={dashboardStats.logisticsChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
//                         <XAxis dataKey="name" tick={{ fontSize: 12 }} />
//                         <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
//                         <RechartsTooltip cursor={{ fill: "rgba(0,0,0,0.05)" }} />
//                         <Bar dataKey="count" radius={[4, 4, 0, 0]}>
//                           {dashboardStats.logisticsChartData.map((entry, index) => (
//                             <Cell key={`cell-${index}`} fill={entry.fill} />
//                           ))}
//                         </Bar>
//                       </BarChart>
//                     </ResponsiveContainer>
//                   )}
//                 </div>
//               </BlockStack>
//             </Card>
//           </InlineGrid>
//         </Layout.Section>

//         {/* MODERN UI: SCROLLABLE TABLE */}
//         <Layout.Section>
//           <Card padding="0">
//             <Box padding="200">
//               <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} fitted />
//             </Box>
            
//             <Divider />

//             {/* This container locks the height and allows clean internal scrolling */}
//             <Scrollable style={{ height: "450px" }} focusable>
//               <IndexTable
//                 resourceName={{ singular: "customer", plural: "customers" }}
//                 itemCount={filteredProfiles.length}
//                 selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
//                 onSelectionChange={handleSelectionChange}
//                 headings={[
//                   { title: "Customer Identity" },
//                   { title: "Segment" },
//                   { title: "Total Checkouts", alignment: "end" },
//                   { title: "Valid Orders", alignment: "end" },
//                   { title: "Verified Revenue", alignment: "end" },
//                   { title: "Risk Factors" },
//                 ]}
//               >
//                 {rowMarkup}
//               </IndexTable>
//             </Scrollable>
//           </Card>
//         </Layout.Section>
//       </Layout>

//       {/* CUSTOMER DEEP DIVE MODAL */}
//       {selectedProfile && (
//         <Modal
//           open={activeModal}
//           onClose={toggleModal}
//           title={`Customer Insight`}
//           primaryAction={{ content: "Close", onAction: toggleModal }}
//         >
//           <Modal.Section>
//             <BlockStack gap="400">
//               <InlineStack align="space-between" blockAlign="center">
//                 <Text variant="headingMd" as="h3">{selectedProfile.displayName}</Text>
//                 {getSegmentBadge(selectedProfile.buyerSegment)}
//               </InlineStack>

//               <BlockStack gap="200">
//                 <Text as="p" tone="subdued">Email: {selectedProfile.customerEmail || "Not Provided"}</Text>
//                 <Text as="p" tone="subdued">Phone: {selectedProfile.customerPhone || "Not Provided"}</Text>
//               </BlockStack>

//               {(selectedProfile.buyerSegment === "High Risk" || selectedProfile.buyerSegment === "Watchlist") && selectedProfile.riskReasons.length > 0 && (
//                 <Banner 
//                   tone={selectedProfile.buyerSegment === "High Risk" ? "critical" : "warning"} 
//                   title={`${selectedProfile.buyerSegment} Customer Flags`}
//                 >
//                   <BlockStack gap="200">
//                     <Text as="p">This buyer was flagged for the following patterns:</Text>
//                     <ul>
//                       {selectedProfile.riskReasons.map((reason, idx) => (
//                         <li key={idx}><Text as="span" fontWeight="bold">{reason}</Text></li>
//                       ))}
//                     </ul>
//                   </BlockStack>
//                 </Banner>
//               )}
              
//               <Divider />
//               <Text variant="headingMd" as="h3">Logistics & Incident Overview</Text>
//               <Card roundedAbove="sm" background="bg-surface-secondary">
//                 <BlockStack gap="300">
//                   <InlineStack align="space-between">
//                     <Text as="span">Total Checkout Attempts</Text>
//                     <Text as="span" fontWeight="bold">{selectedProfile.totalCheckoutAttempts}</Text>
//                   </InlineStack>
//                   <InlineStack align="space-between">
//                     <Text as="span">Successfully Fulfilled</Text>
//                     <Text as="span" tone="success" fontWeight="bold">{selectedProfile.fulfilledCount}</Text>
//                   </InlineStack>
//                   <InlineStack align="space-between">
//                     <Text as="span">Cancelled / Rejected</Text>
//                     <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.cancelledCount}</Text>
//                   </InlineStack>
//                   <InlineStack align="space-between">
//                     <Text as="span">Returned to Origin (RTO)</Text>
//                     <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.rtoCount || 0}</Text>
//                   </InlineStack>
//                   <InlineStack align="space-between">
//                     <Text as="span">Disputes / Chargebacks</Text>
//                     <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.disputeCount}</Text>
//                   </InlineStack>
//                 </BlockStack>
//               </Card>
//             </BlockStack>
//           </Modal.Section>
//         </Modal>
//       )}
//     </Page>
//   );
// }

// export { boundary };











// // import { useLoaderData, useNavigation, useSubmit } from "react-router";
// // import { useState, useCallback, useEffect } from "react";
// // import { boundary } from "@shopify/shopify-app-react-router/server";
// // import {
// //   Page,
// //   Layout,
// //   Card,
// //   IndexTable,
// //   useIndexResourceState,
// //   Text,
// //   Badge,
// //   Modal,
// //   BlockStack,
// //   InlineStack,
// //   Divider,
// //   Button,
// //   EmptyState,
// //   InlineGrid,
// //   Tabs,
// //   Banner,
// // } from "@shopify/polaris";
// // import {
// //   PieChart,
// //   Pie,
// //   Cell,
// //   BarChart,
// //   Bar,
// //   XAxis,
// //   YAxis,
// //   Tooltip as RechartsTooltip,
// //   ResponsiveContainer,
// //   Legend,
// // } from "recharts";
// // import { authenticate } from "../shopify.server";
// // import prisma from "../db.server";

// // /* ================= BACKEND LOADER ================= */

// // export const loader = async ({ request }) => {
// //   const { session } = await authenticate.admin(request);
// //   const shop = session.shop;

// //   const profilesData = await prisma.zippyy_buyer_profile.findMany({
// //     where: { shop },
// //     orderBy: { totalCheckoutAttempts: "desc" },
// //   });

// //   let totalSecuredRevenue = 0;
// //   let totalValidOrders = 0;
// //   let totalCheckouts = 0;
// //   let totalFulfilled = 0;

// //   const segmentCounts = { VIP: 0, "Repeat Buyer": 0, New: 0, "High Risk": 0 };
// //   const logisticsData = { fulfilled: 0, rto: 0, cancelled: 0, unpaid: 0 };

// //   const profiles = profilesData.map((p) => {
// //     totalSecuredRevenue += p.totalSpend;
// //     totalValidOrders += p.validOrderCount;
// //     totalCheckouts += p.totalCheckoutAttempts;
// //     totalFulfilled += p.fulfilledCount;

// //     if (segmentCounts[p.buyerSegment] !== undefined) {
// //       segmentCounts[p.buyerSegment] += 1;
// //     }
    
// //     logisticsData.fulfilled += p.fulfilledCount;
// //     logisticsData.rto += p.rtoCount;
// //     logisticsData.cancelled += p.cancelledCount;
// //     logisticsData.unpaid += p.unpaidCount;

// //     let displayName = p.customerEmail;
// //     if (!displayName) displayName = p.customerPhone;
// //     if (!displayName) {
// //       if (p.buyerIdentifier.includes('Customer/')) {
// //         displayName = `Shopify User #${p.buyerIdentifier.split('/').pop()}`;
// //       } else if (p.buyerIdentifier.includes('Order/')) {
// //         displayName = `Guest Buyer`;
// //       } else {
// //         displayName = "Anonymous";
// //       }
// //     }

// //     return {
// //       ...p,
// //       displayName,
// //       riskReasons: p.riskReasons ? p.riskReasons.split(",").map(r => r.trim()).filter(Boolean) : [],
// //     };
// //   });

// //   const segmentChartData = [
// //     { name: "VIP", value: segmentCounts["VIP"], color: "#008060" },
// //     { name: "Repeat", value: segmentCounts["Repeat Buyer"], color: "#2c6ecb" },
// //     { name: "New", value: segmentCounts["New"], color: "#8c9196" },
// //     { name: "High Risk", value: segmentCounts["High Risk"], color: "#d82c0d" },
// //   ].filter((item) => item.value > 0);

// //   const logisticsChartData = [
// //     { name: "Fulfilled", count: logisticsData.fulfilled, fill: "#008060" },
// //     { name: "RTO", count: logisticsData.rto, fill: "#d82c0d" },
// //     { name: "Cancelled", count: logisticsData.cancelled, fill: "#ffc453" },
// //     { name: "Unpaid", count: logisticsData.unpaid, fill: "#8c9196" },
// //   ];

// //   const safeFulfillmentRate = totalCheckouts > 0 ? Math.round((totalFulfilled / totalCheckouts) * 100) : 0;

// //   return Response.json({
// //     profiles,
// //     dashboardStats: {
// //       totalSecuredRevenue,
// //       totalValidOrders,
// //       safeFulfillmentRate,
// //       segmentChartData,
// //       logisticsChartData,
// //       highRiskCount: segmentCounts["High Risk"]
// //     },
// //   });
// // };

// // export const action = async ({ request }) => {
// //   await authenticate.admin(request);
// //   return Response.json({ ok: true });
// // };

// // /* ================= FRONTEND UI ================= */

// // export default function Index() {
// //   const { profiles, dashboardStats } = useLoaderData() || { profiles: [], dashboardStats: {} };
// //   const navigation = useNavigation();
// //   const submit = useSubmit();

// //   const isRefreshing = navigation.state === "submitting" || navigation.state === "loading";

// //   const [activeModal, setActiveModal] = useState(false);
// //   const [selectedProfileId, setSelectedProfileId] = useState(null); 
// //   const [isMounted, setIsMounted] = useState(false);
// //   const [selectedTab, setSelectedTab] = useState(0);

// //   //  DERIVED STATE: Always get the freshest data from 'profiles' for the modal
// //   const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

// //   useEffect(() => {
// //     setIsMounted(true);
// //   }, []);

// //   const toggleModal = useCallback(() => {
// //     setActiveModal((active) => !active);
// //     if (activeModal) setSelectedProfileId(null);
// //   }, [activeModal]);

// //   const handleRowClick = (profile) => {
// //     setSelectedProfileId(profile.id);
// //     setActiveModal(true);
// //   };

// //   const handleRefresh = () => {
// //     submit({}, { method: "post" });
// //   };

// //   const formatCurrency = (amount) => {
// //     return new Intl.NumberFormat("en-IN", {
// //       style: "currency",
// //       currency: "INR",
// //       minimumFractionDigits: 0,
// //       maximumFractionDigits: 2,
// //     }).format(amount || 0);
// //   };

// //   const getSegmentBadge = (segment) => {
// //     switch (segment) {
// //       case "VIP": return <Badge tone="success">VIP</Badge>;
// //       case "Repeat Buyer": return <Badge tone="info">Repeat Buyer</Badge>;
// //       case "High Risk": return <Badge tone="critical">High Risk</Badge>;
// //       default: return <Badge>New</Badge>;
// //     }
// //   };

// //   const tabs = [
// //     { id: "all", content: "All Customers" },
// //     { id: "risk", content: "High Risk", badge: dashboardStats?.highRiskCount > 0 ? dashboardStats.highRiskCount.toString() : undefined },
// //     { id: "vip", content: "VIPs" },
// //     { id: "repeat", content: "Repeat Buyers" },
// //     { id: "new", content: "New" },
// //   ];

// //   const filteredProfiles = profiles.filter((profile) => {
// //     if (selectedTab === 0) return true; 
// //     if (selectedTab === 1) return profile.buyerSegment === "High Risk";
// //     if (selectedTab === 2) return profile.buyerSegment === "VIP";
// //     if (selectedTab === 3) return profile.buyerSegment === "Repeat Buyer";
// //     if (selectedTab === 4) return profile.buyerSegment === "New";
// //     return true;
// //   });

// //   const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(filteredProfiles);

// //   const rowMarkup = filteredProfiles.map((profile, index) => {
// //     return (
// //       <IndexTable.Row
// //         id={profile.id}
// //         key={profile.id}
// //         selected={selectedResources.includes(profile.id)}
// //         position={index}
// //         onClick={() => handleRowClick(profile)}
// //       >
// //         <IndexTable.Cell>
// //           <BlockStack gap="0">
// //             <Text variant="bodyMd" fontWeight="bold" as="span">{profile.displayName}</Text>
// //             {profile.customerPhone && (
// //               <Text variant="bodySm" tone="subdued">{profile.customerPhone}</Text>
// //             )}
// //           </BlockStack>
// //         </IndexTable.Cell>

// //         <IndexTable.Cell>{getSegmentBadge(profile.buyerSegment)}</IndexTable.Cell>

// //         <IndexTable.Cell>
// //           <Text as="span" alignment="end" fontWeight="bold">{profile.totalCheckoutAttempts}</Text>
// //         </IndexTable.Cell>
        
// //         <IndexTable.Cell>
// //           <Text as="span" alignment="end" tone={profile.validOrderCount === 0 ? "critical" : "success"}>
// //             {profile.validOrderCount}
// //           </Text>
// //         </IndexTable.Cell>

// //         <IndexTable.Cell>
// //           <Text as="span" alignment="end">{formatCurrency(profile.totalSpend)}</Text>
// //         </IndexTable.Cell>

// //         <IndexTable.Cell>
// //           {profile.riskReasons?.length > 0 ? (
// //             <InlineStack gap="100" wrap>
// //               {profile.riskReasons.map((reason, i) => (
// //                 <Badge tone="critical" key={i}>{reason}</Badge>
// //               ))}
// //             </InlineStack>
// //           ) : (
// //             <Text tone="subdued">Clean History</Text>
// //           )}
// //         </IndexTable.Cell>
// //       </IndexTable.Row>
// //     );
// //   });

// //   return (
// //     <Page 
// //       title="Buyer Profiling CRM" 
// //       primaryAction={<Button onClick={handleRefresh} loading={isRefreshing}>Refresh Data</Button>}
// //     >
// //       <Layout>
// //         {/* HERO KPIs */}
// //         <Layout.Section>
// //           <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
// //             <Card roundedAbove="sm">
// //               <BlockStack gap="200">
// //                 <Text as="h3" variant="headingSm" tone="subdued">Total Verified Revenue</Text>
// //                 <Text as="p" variant="headingLg" tone="success">{formatCurrency(dashboardStats.totalSecuredRevenue)}</Text>
// //               </BlockStack>
// //             </Card>
// //             <Card roundedAbove="sm">
// //               <BlockStack gap="200">
// //                 <Text as="h3" variant="headingSm" tone="subdued">Total Valid Orders</Text>
// //                 <Text as="p" variant="headingLg">{dashboardStats.totalValidOrders}</Text>
// //               </BlockStack>
// //             </Card>
// //             <Card roundedAbove="sm">
// //               <BlockStack gap="200">
// //                 <Text as="h3" variant="headingSm" tone="subdued">Safe Fulfillment</Text>
// //                 <Text as="p" variant="headingLg">{dashboardStats.safeFulfillmentRate}%</Text>
// //               </BlockStack>
// //             </Card>
// //           </InlineGrid>
// //         </Layout.Section>

// //         {/* VISUAL CHARTS */}
// //         <Layout.Section>
// //           <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
// //             <Card roundedAbove="sm">
// //               <BlockStack gap="400">
// //                 <Text variant="headingMd" as="h3">Customer Segments</Text>
// //                 <div style={{ height: "250px", width: "100%" }}>
// //                   {isMounted && (
// //                     <ResponsiveContainer width="100%" height="100%">
// //                       <PieChart>
// //                         <Pie data={dashboardStats.segmentChartData} innerRadius={65} outerRadius={90} paddingAngle={5} dataKey="value">
// //                           {dashboardStats.segmentChartData.map((entry, index) => (
// //                             <Cell key={`cell-${index}`} fill={entry.color} />
// //                           ))}
// //                         </Pie>
// //                         <RechartsTooltip formatter={(value) => [`${value} Customers`, "Count"]} />
// //                         <Legend verticalAlign="bottom" height={36} />
// //                       </PieChart>
// //                     </ResponsiveContainer>
// //                   )}
// //                 </div>
// //               </BlockStack>
// //             </Card>

// //             <Card roundedAbove="sm">
// //               <BlockStack gap="400">
// //                 <Text variant="headingMd" as="h3">Logistics Breakdown</Text>
// //                 <div style={{ height: "250px", width: "100%" }}>
// //                   {isMounted && (
// //                     <ResponsiveContainer width="100%" height="100%">
// //                       <BarChart data={dashboardStats.logisticsChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
// //                         <XAxis dataKey="name" tick={{ fontSize: 12 }} />
// //                         <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
// //                         <RechartsTooltip cursor={{ fill: "rgba(0,0,0,0.05)" }} />
// //                         <Bar dataKey="count" radius={[4, 4, 0, 0]}>
// //                           {dashboardStats.logisticsChartData.map((entry, index) => (
// //                             <Cell key={`cell-${index}`} fill={entry.fill} />
// //                           ))}
// //                         </Bar>
// //                       </BarChart>
// //                     </ResponsiveContainer>
// //                   )}
// //                 </div>
// //               </BlockStack>
// //             </Card>
// //           </InlineGrid>
// //         </Layout.Section>

// //         {/* INTERACTIVE CRM TABLE */}
// //         <Layout.Section>
// //           <Card padding="0">
// //             <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
// //               <IndexTable
// //                 resourceName={{ singular: "customer", plural: "customers" }}
// //                 itemCount={filteredProfiles.length}
// //                 selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
// //                 onSelectionChange={handleSelectionChange}
// //                 headings={[
// //                   { title: "Customer Identity" },
// //                   { title: "Segment" },
// //                   { title: "Total Checkouts", alignment: "end" },
// //                   { title: "Valid Orders", alignment: "end" },
// //                   { title: "Verified Revenue", alignment: "end" },
// //                   { title: "Risk Factors" },
// //                 ]}
// //               >
// //                 {rowMarkup}
// //               </IndexTable>
// //             </Tabs>
// //           </Card>
// //         </Layout.Section>
// //       </Layout>

// //       {/* CUSTOMER DEEP DIVE MODAL */}
// //       {selectedProfile && (
// //         <Modal
// //           open={activeModal}
// //           onClose={toggleModal}
// //           title={`Customer Insight`}
// //           primaryAction={{ content: "Close", onAction: toggleModal }}
// //         >
// //           <Modal.Section>
// //             <BlockStack gap="400">
// //               <InlineStack align="space-between" blockAlign="center">
// //                 <Text variant="headingMd" as="h3">{selectedProfile.displayName}</Text>
// //                 {getSegmentBadge(selectedProfile.buyerSegment)}
// //               </InlineStack>

// //               <BlockStack gap="200">
// //                 <Text as="p" tone="subdued">Email: {selectedProfile.customerEmail || "Not Provided"}</Text>
// //                 <Text as="p" tone="subdued">Phone: {selectedProfile.customerPhone || "Not Provided"}</Text>
// //               </BlockStack>

// //               {selectedProfile.buyerSegment === "High Risk" && selectedProfile.riskReasons.length > 0 && (
// //                 <Banner tone="critical" title="High Risk Customer Flags">
// //                   <BlockStack gap="200">
// //                     <Text as="p">This buyer was flagged for the following patterns:</Text>
// //                     <ul>
// //                       {selectedProfile.riskReasons.map((reason, idx) => (
// //                         <li key={idx}><Text as="span" fontWeight="bold">{reason}</Text></li>
// //                       ))}
// //                     </ul>
// //                   </BlockStack>
// //                 </Banner>
// //               )}
              
// //               <Divider />
// //               <Text variant="headingMd" as="h3">Logistics & Incident Overview</Text>
// //               <Card roundedAbove="sm" background="bg-surface-secondary">
// //                 <BlockStack gap="300">
// //                   <InlineStack align="space-between">
// //                     <Text as="span">Total Checkout Attempts</Text>
// //                     <Text as="span" fontWeight="bold">{selectedProfile.totalCheckoutAttempts}</Text>
// //                   </InlineStack>
// //                   <InlineStack align="space-between">
// //                     <Text as="span">Successfully Fulfilled</Text>
// //                     <Text as="span" tone="success" fontWeight="bold">{selectedProfile.fulfilledCount}</Text>
// //                   </InlineStack>
// //                   <InlineStack align="space-between">
// //                     <Text as="span">Cancelled / Rejected</Text>
// //                     <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.cancelledCount}</Text>
// //                   </InlineStack>
// //                   <InlineStack align="space-between">
// //                     <Text as="span">Returned to Origin (RTO)</Text>
// //                     <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.rtoCount || 0}</Text>
// //                   </InlineStack>
// //                   <InlineStack align="space-between">
// //                     <Text as="span">Disputes / Chargebacks</Text>
// //                     <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.disputeCount}</Text>
// //                   </InlineStack>
// //                 </BlockStack>
// //               </Card>
// //             </BlockStack>
// //           </Modal.Section>
// //         </Modal>
// //       )}
// //     </Page>
// //   );
// // }

// // export { boundary };

