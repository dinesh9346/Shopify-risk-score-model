
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

//   // 1. Fetch profiles (1 Database Connection)
//   const profilesData = await prisma.zippyy_buyer_profile.findMany({
//     where: { shop },
//     orderBy: { totalCheckoutAttempts: "desc" },
//   });

//   // Fetch all tracking data in one bulk query
//   const allStoreOrders = await prisma.shopify_store_order.findMany({
//     where: { shop },
//     orderBy: { updatedAt: "desc" },
//     select: { 
//       id: true,
//       carrier: true, 
//       trackingNumber: true, 
//       trackingUrl: true, 
//       shipmentStatus: true, 
//       fulfillmentStatus: true,
//       customerEmail: true,
//       customerPhone: true,
//       customerId: true,
//       updatedAt: true
//     }
//   });

//   // Build quick lookup maps so each profile gets all of its orders
//   const ordersByEmail = new Map();
//   const ordersByPhone = new Map();
//   const ordersByCustomerId = new Map();

//   const addToMap = (map, key, order) => {
//     if (!key) return;
//     const list = map.get(key) || [];
//     list.push(order);
//     map.set(key, list);
//   };

//   for (const order of allStoreOrders) {
//     if (order.customerEmail) addToMap(ordersByEmail, order.customerEmail.toLowerCase(), order);
//     if (order.customerPhone) addToMap(ordersByPhone, order.customerPhone, order);
//     if (order.customerId) addToMap(ordersByCustomerId, order.customerId, order);
//   }

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

//     let displayName = [p.firstName, p.lastName].filter(Boolean).join(" ");
    
//     if (!displayName) displayName = p.customerEmail;
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

//     // Collect ALL matching orders (not just latest)
//     const orderHistory = [];
//     const seen = new Set();

//     const addOrders = (list) => {
//       if (!list) return;
//       for (const o of list) {
//         if (!seen.has(o.id)) {
//           seen.add(o.id);
//           orderHistory.push(o);
//         }
//       }
//     };

//     if (p.customerEmail) addOrders(ordersByEmail.get(p.customerEmail.toLowerCase()));
//     if (p.customerPhone) addOrders(ordersByPhone.get(p.customerPhone));
//     if (p.customerId) addOrders(ordersByCustomerId.get(p.customerId));

//     orderHistory.sort((a, b) => {
//       const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
//       const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
//       return bTime - aTime;
//     });

//     return {
//       ...p,
//       displayName,
//       latestOrder: orderHistory[0] || null,
//       orderHistory,
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

// /* ================= FRONTEND UI ================= */

// export default function Index() {
//   const { profiles, dashboardStats } = useLoaderData() || { profiles: [], dashboardStats: {} };
//   const navigation = useNavigation();
//   const submit = useSubmit();

//   const isRefreshing = navigation.state === "submitting" || navigation.state === "loading";

//   const [selectedProfileId, setSelectedProfileId] = useState(null); 
//   const [isMounted, setIsMounted] = useState(false);
//   const [selectedTab, setSelectedTab] = useState(0);

//   const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

//   useEffect(() => {
//     setIsMounted(true);
//   }, []);

//   const handleRowClick = (profile) => {
//     setSelectedProfileId(profile.id);
//   };

//   const handleBackToList = () => {
//     setSelectedProfileId(null);
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

//   const formatDateTime = (value) => {
//     if (!value) return "Unknown";
//     const date = new Date(value);
//     if (Number.isNaN(date.getTime())) return "Unknown";
//     return date.toLocaleString("en-IN", {
//       year: "numeric",
//       month: "short",
//       day: "2-digit",
//       hour: "2-digit",
//       minute: "2-digit",
//     });
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

//   const getShipmentBadge = (order) => {
//     if (order?.shipmentStatus === "failure" || order?.shipmentStatus === "returned") {
//       return <Badge tone="critical">RTO / Failed Delivery</Badge>;
//     }
//     if (order?.shipmentStatus === "delivered") {
//       return <Badge tone="success">Delivered</Badge>;
//     }
//     if (order?.fulfillmentStatus?.toUpperCase() === "SUCCESS" || order?.fulfillmentStatus?.toUpperCase() === "FULFILLED") {
//       return <Badge tone="info">In Transit</Badge>;
//     }
//     return <Badge>Processing</Badge>;
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

//   // ===== FULL PAGE DETAIL VIEW =====
//   if (selectedProfile) {
//     return (
//       <Page
//         title="Customer Detail"
//         backAction={{ content: "Back to list", onAction: handleBackToList }}
//         primaryAction={<Button onClick={handleRefresh} loading={isRefreshing}>Refresh Data</Button>}
//       >
//         <Layout>
//           <Layout.Section>
//             <Card>
//               <BlockStack gap="300">
//                 <InlineStack align="space-between" blockAlign="center">
//                   <Text variant="headingMd" as="h3">{selectedProfile.displayName}</Text>
//                   {getSegmentBadge(selectedProfile.buyerSegment)}
//                 </InlineStack>
//                 <BlockStack gap="100">
//                   <Text as="p" tone="subdued">Email: {selectedProfile.customerEmail || "Not Provided"}</Text>
//                   <Text as="p" tone="subdued">Phone: {selectedProfile.customerPhone || "Not Provided"}</Text>
//                   <Text as="p" tone="subdued">Customer ID: {selectedProfile.customerId || "Not Provided"}</Text>
//                   <Text as="p" tone="subdued">Buyer Identifier: {selectedProfile.buyerIdentifier || "Not Provided"}</Text>
//                   <Text as="p" tone="subdued">Profile Created: {formatDateTime(selectedProfile.createdAt)}</Text>
//                   <Text as="p" tone="subdued">Profile Updated: {formatDateTime(selectedProfile.updatedAt)}</Text>
//                 </BlockStack>
//               </BlockStack>
//             </Card>
//           </Layout.Section>

//           <Layout.Section>
//             <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
//               <Card roundedAbove="sm">
//                 <BlockStack gap="200">
//                   <Text as="h3" variant="headingSm" tone="subdued">Total Spend</Text>
//                   <Text as="p" variant="headingLg">{formatCurrency(selectedProfile.totalSpend)}</Text>
//                 </BlockStack>
//               </Card>
//               <Card roundedAbove="sm">
//                 <BlockStack gap="200">
//                   <Text as="h3" variant="headingSm" tone="subdued">Valid Orders</Text>
//                   <Text as="p" variant="headingLg">{selectedProfile.validOrderCount}</Text>
//                 </BlockStack>
//               </Card>
//               <Card roundedAbove="sm">
//                 <BlockStack gap="200">
//                   <Text as="h3" variant="headingSm" tone="subdued">Total Orders</Text>
//                   <Text as="p" variant="headingLg">{selectedProfile.totalCheckoutAttempts}</Text>
//                 </BlockStack>
//               </Card>
//             </InlineGrid>
//           </Layout.Section>

//           {(selectedProfile.buyerSegment === "High Risk" || selectedProfile.buyerSegment === "Watchlist") && selectedProfile.riskReasons.length > 0 && (
//             <Layout.Section>
//               <Banner 
//                 tone={selectedProfile.buyerSegment === "High Risk" ? "critical" : "warning"} 
//                 title={`${selectedProfile.buyerSegment} Customer Flags`}
//               >
//                 <BlockStack gap="200">
//                   <Text as="p">This buyer was flagged for the following patterns:</Text>
//                   <ul>
//                     {selectedProfile.riskReasons.map((reason, idx) => (
//                       <li key={idx}><Text as="span" fontWeight="bold">{reason}</Text></li>
//                     ))}
//                   </ul>
//                 </BlockStack>
//               </Banner>
//             </Layout.Section>
//           )}

//           <Layout.Section>
//             <Card>
//               <BlockStack gap="300">
//                 <Text variant="headingMd" as="h3">Logistics & Incident Overview</Text>
//                 <InlineStack align="space-between">
//                   <Text as="span">Successfully Fulfilled</Text>
//                   <Text as="span" tone="success" fontWeight="bold">{selectedProfile.fulfilledCount}</Text>
//                 </InlineStack>
//                 <InlineStack align="space-between">
//                   <Text as="span">Cancelled / Rejected</Text>
//                   <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.cancelledCount}</Text>
//                 </InlineStack>
//                 <InlineStack align="space-between">
//                   <Text as="span">Returned to Origin (RTO)</Text>
//                   <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.rtoCount || 0}</Text>
//                 </InlineStack>
//                 <InlineStack align="space-between">
//                   <Text as="span">Unpaid Orders</Text>
//                   <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.unpaidCount || 0}</Text>
//                 </InlineStack>
//                 <InlineStack align="space-between">
//                   <Text as="span">Cash on Delivery (COD)</Text>
//                   <Text as="span" fontWeight="bold">{selectedProfile.codCount || 0}</Text>
//                 </InlineStack>
//                 <InlineStack align="space-between">
//                   <Text as="span">Disputes / Chargebacks</Text>
//                   <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.disputeCount || 0}</Text>
//                 </InlineStack>
//                 <InlineStack align="space-between">
//                   <Text as="span">Refunds</Text>
//                   <Text as="span" tone="critical" fontWeight="bold">{selectedProfile.refundCount || 0}</Text>
//                 </InlineStack>
//               </BlockStack>
//             </Card>
//           </Layout.Section>

//           <Layout.Section>
//             <Card padding="0">
//               <Box padding="400">
//                 <Text variant="headingMd" as="h3">Order & Tracking History</Text>
//                 <Text tone="subdued">{selectedProfile.orderHistory?.length || 0} orders found</Text>
//               </Box>
//               <Divider />
//               <Scrollable style={{ height: "520px" }} focusable>
//                 <Box padding="400">
//                   <BlockStack gap="300">
//                     {selectedProfile.orderHistory?.length > 0 ? (
//                       selectedProfile.orderHistory.map((order, idx) => (
//                         <Card key={order.id || idx} roundedAbove="sm" background="bg-surface-secondary">
//                           <BlockStack gap="200">
//                             <InlineStack align="space-between">
//                               <Text as="span" fontWeight="bold">Order #{idx + 1}</Text>
//                               <Text as="span" tone="subdued">Last Updated: {formatDateTime(order.updatedAt)}</Text>
//                             </InlineStack>

//                             <InlineStack align="space-between">
//                               <Text as="span" tone="subdued">Carrier</Text>
//                               <Text as="span" fontWeight="bold">{order.carrier || "Pending Dispatch"}</Text>
//                             </InlineStack>

//                             <InlineStack align="space-between">
//                               <Text as="span" tone="subdued">Status</Text>
//                               {getShipmentBadge(order)}
//                             </InlineStack>

//                             {order.trackingNumber && (
//                               <InlineStack align="space-between">
//                                 <Text as="span" tone="subdued">Tracking Number</Text>
//                                 {order.trackingUrl ? (
//                                   <Button variant="plain" url={order.trackingUrl} external>
//                                     {order.trackingNumber}
//                                   </Button>
//                                 ) : (
//                                   <Text as="span" fontWeight="bold">{order.trackingNumber}</Text>
//                                 )}
//                               </InlineStack>
//                             )}

//                             <InlineStack align="space-between">
//                               <Text as="span" tone="subdued">Shipment Status</Text>
//                               <Text as="span" fontWeight="bold">{order.shipmentStatus || "Unknown"}</Text>
//                             </InlineStack>

//                             <InlineStack align="space-between">
//                               <Text as="span" tone="subdued">Fulfillment Status</Text>
//                               <Text as="span" fontWeight="bold">{order.fulfillmentStatus || "Unknown"}</Text>
//                             </InlineStack>
//                           </BlockStack>
//                         </Card>
//                       ))
//                     ) : (
//                       <Card roundedAbove="sm" background="bg-surface-secondary">
//                         <BlockStack gap="200">
//                           <Text as="p">No tracking records available for this customer yet.</Text>
//                         </BlockStack>
//                       </Card>
//                     )}
//                   </BlockStack>
//                 </Box>
//               </Scrollable>
//             </Card>
//           </Layout.Section>
//         </Layout>
//       </Page>
//     );
//   }

//   // ===== MAIN PAGE (UNCHANGED) =====
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
//                   { title: "Total Orders", alignment: "end" },
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
//     </Page>
//   );
// }

// export { boundary };

import { useLoaderData, useNavigation, useSubmit } from "react-router";
import { useState, useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  useIndexResourceState,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  Divider,
  Button,
  EmptyState,
  InlineGrid,
  Tabs,
  Banner,
  Box,
  Scrollable,
  Link
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

  // Fetch all tracking data in one bulk query
  const allStoreOrders = await prisma.shopify_store_order.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    select: { 
      id: true,
      shopifyOrderId: true,
      carrier: true, 
      trackingNumber: true, 
      trackingUrl: true, 
      shipmentStatus: true, 
      fulfillmentStatus: true,
      customerEmail: true,
      customerPhone: true,
      customerId: true,
      updatedAt: true
    }
  });

  const ordersByEmail = new Map();
  const ordersByPhone = new Map();
  const ordersByCustomerId = new Map();

  const addToMap = (map, key, order) => {
    if (!key) return;
    const list = map.get(key) || [];
    list.push(order);
    map.set(key, list);
  };

  for (const order of allStoreOrders) {
    if (order.customerEmail) addToMap(ordersByEmail, order.customerEmail.toLowerCase(), order);
    if (order.customerPhone) addToMap(ordersByPhone, order.customerPhone, order);
    if (order.customerId) addToMap(ordersByCustomerId, order.customerId, order);
  }

  let totalSecuredRevenue = 0;
  let totalValidOrders = 0;
  let totalCheckouts = 0;
  let totalFulfilled = 0;

  const segmentCounts = { VIP: 0, "Repeat Buyer": 0, Watchlist: 0, New: 0, "High Risk": 0 };
  const logisticsData = { fulfilled: 0, rto: 0, cancelled: 0, unpaid: 0 };

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

    const orderHistory = [];
    const seen = new Set();

    const addOrders = (list) => {
      if (!list) return;
      for (const o of list) {
        if (!seen.has(o.id)) {
          seen.add(o.id);
          orderHistory.push(o);
        }
      }
    };

    if (p.customerEmail) addOrders(ordersByEmail.get(p.customerEmail.toLowerCase()));
    if (p.customerPhone) addOrders(ordersByPhone.get(p.customerPhone));
    if (p.customerId) addOrders(ordersByCustomerId.get(p.customerId));

    orderHistory.sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    });

    return {
      ...p,
      displayName,
      latestOrder: orderHistory[0] || null,
      orderHistory,
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

  const [selectedProfileId, setSelectedProfileId] = useState(null); 
  const [isMounted, setIsMounted] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleRowClick = (profile) => {
    setSelectedProfileId(profile.id);
  };

  const handleBackToList = () => {
    setSelectedProfileId(null);
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

  const formatDateTime = (value) => {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString("en-IN", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
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

  const getShipmentBadge = (order) => {
    if (order?.shipmentStatus === "failure" || order?.shipmentStatus === "returned") {
      return <Badge tone="critical">RTO / Failed Delivery</Badge>;
    }
    if (order?.shipmentStatus === "delivered") {
      return <Badge tone="success">Delivered</Badge>;
    }
    if (order?.fulfillmentStatus?.toUpperCase() === "SUCCESS" || order?.fulfillmentStatus?.toUpperCase() === "FULFILLED") {
      return <Badge tone="info">In Transit</Badge>;
    }
    return <Badge>Processing</Badge>;
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

  // ===== FULL PAGE DETAIL VIEW =====
  if (selectedProfile) {
    return (
      <Page
        title="Customer Detail"
        backAction={{ content: "Back to list", onAction: handleBackToList }}
        primaryAction={<Button onClick={handleRefresh} loading={isRefreshing}>Refresh Data</Button>}
      >
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h3">{selectedProfile.displayName}</Text>
                  {getSegmentBadge(selectedProfile.buyerSegment)}
                </InlineStack>
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">Email: {selectedProfile.customerEmail || "Not Provided"}</Text>
                  <Text as="p" tone="subdued">Phone: {selectedProfile.customerPhone || "Not Provided"}</Text>
                  <Text as="p" tone="subdued">Customer ID: {selectedProfile.customerId || "Not Provided"}</Text>
                  <Text as="p" tone="subdued">Buyer Identifier: {selectedProfile.buyerIdentifier || "Not Provided"}</Text>
                  <Text as="p" tone="subdued">Profile Created: {formatDateTime(selectedProfile.createdAt)}</Text>
                  <Text as="p" tone="subdued">Profile Updated: {formatDateTime(selectedProfile.updatedAt)}</Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Total Spend</Text>
                  <Text as="p" variant="headingLg">{formatCurrency(selectedProfile.totalSpend)}</Text>
                </BlockStack>
              </Card>
              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Valid Orders</Text>
                  <Text as="p" variant="headingLg">{selectedProfile.validOrderCount}</Text>
                </BlockStack>
              </Card>
              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Total Orders</Text>
                  <Text as="p" variant="headingLg">{selectedProfile.totalCheckoutAttempts}</Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>

          {(selectedProfile.buyerSegment === "High Risk" || selectedProfile.buyerSegment === "Watchlist") && selectedProfile.riskReasons.length > 0 && (
            <Layout.Section>
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
            </Layout.Section>
          )}

          <Layout.Section>
            <Card padding="0">
              <Box padding="400">
                <Text variant="headingMd" as="h3">Order & Tracking History</Text>
                <Text tone="subdued">{selectedProfile.orderHistory?.length || 0} orders found</Text>
              </Box>
              <Divider />
              <Scrollable style={{ height: "520px" }} focusable>
                <Box padding="400">
                  <BlockStack gap="300">
                    {selectedProfile.orderHistory?.length > 0 ? (
                      selectedProfile.orderHistory.map((order, idx) => {
                        const numericId = typeof order.shopifyOrderId === "string"
                          ? order.shopifyOrderId.replace("gid://shopify/Order/", "")
                          : "";

                        const orderUrl = numericId
                          ? `shopify:admin/orders/${numericId}`
                          : null;

                        return (
                          <Card key={order.id || idx} roundedAbove="sm" background="bg-surface-secondary">
                            <BlockStack gap="200">
                              <InlineStack align="space-between">
                                <Text as="span" fontWeight="bold">Order ID</Text>
                                {orderUrl ? (
                                  <Link url={orderUrl} removeUnderline>
                                    {numericId}
                                  </Link>
                                ) : (
                                  <Text as="span" fontWeight="bold">{order.shopifyOrderId || order.id}</Text>
                                )}
                              </InlineStack>

                              <InlineStack align="space-between">
                                <Text as="span" tone="subdued">Last Updated</Text>
                                <Text as="span">{formatDateTime(order.updatedAt)}</Text>
                              </InlineStack>

                              <InlineStack align="space-between">
                                <Text as="span" tone="subdued">Carrier</Text>
                                <Text as="span" fontWeight="bold">{order.carrier || "Pending Dispatch"}</Text>
                              </InlineStack>

                              <InlineStack align="space-between">
                                <Text as="span" tone="subdued">Status</Text>
                                {getShipmentBadge(order)}
                              </InlineStack>

                              <InlineStack align="space-between">
                                <Text as="span" tone="subdued">Fulfillment Status</Text>
                                 <Text as="span" fontWeight="bold">{order.fulfillmentStatus || "Unknown"}</Text>
                            </InlineStack>
                              {order.trackingNumber && (
                                <InlineStack align="space-between">
                                  <Text as="span" tone="subdued">Tracking Number</Text>
                                  {order.trackingUrl ? (
                                    <Button variant="plain" url={order.trackingUrl} external>
                                      {order.trackingNumber}
                                    </Button>
                                  ) : (
                                    <Text as="span" fontWeight="bold">{order.trackingNumber}</Text>
                                  )}
                                </InlineStack>
                              )}
                            </BlockStack>
                          </Card>
                        );
                      })
                    ) : (
                      <Card roundedAbove="sm" background="bg-surface-secondary">
                        <BlockStack gap="200">
                          <Text as="p">No tracking records available for this customer yet.</Text>
                        </BlockStack>
                      </Card>
                    )}
                  </BlockStack>
                </Box>
              </Scrollable>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // ===== MAIN PAGE (UNCHANGED) =====
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
                  { title: "Total Orders", alignment: "end" },
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
    </Page>
  );
}

export { boundary };
