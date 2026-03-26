import { useLoaderData, useNavigation, useSubmit } from "react-router";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  EmptyState,
  InlineGrid,
  Divider,
  Box,
} from "@shopify/polaris";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Legend, LineChart, Line, ComposedChart, CartesianGrid, AreaChart, Area
} from "recharts";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  // 1. Authenticate and get the specific shop session
  const { session } = await authenticate.admin(request);
  
  // 2. DYNAMIC QUERY: Fetch ONLY the profiles for the currently authenticated shop
  const profiles = await prisma.zippyy_buyer_profile.findMany({
    where: { shop: session.shop },
    orderBy: { totalSpend: "desc" },
  });

  // --- DYNAMIC DATA AGGREGATION ENGINE ---
  
  // Core Metrics
  let totalSecuredRevenue = 0;
  let totalRevenueAtRisk = 0; 
  let highRiskCount = 0;
  
  // Operational Metrics
  let totalCheckouts = 0;
  let totalValidOrders = 0;
  let totalFulfilled = 0;
  let totalRTO = 0;
  let totalCancelled = 0;
  
  // Payment Metrics
  let codTotal = 0; let codFulfilled = 0; let codFailed = 0; 
  let prepaidTotal = 0; let prepaidFulfilled = 0; let prepaidFailed = 0;

  // Dynamic Segment Buckets (Handles any segment name in the DB)
  const segmentStats = {};

  // Risk Scoring Tiers
  const riskTiers = { "Safe (0-10%)": 0, "Moderate (11-30%)": 0, "High (31-60%)": 0, "Severe (60%+)": 0 };
  profiles.forEach(profile => {
    const spend = Number(profile.totalSpend) || 0;
    const disputed = Number(profile.disputeCount) || 0; 
    const totalPlaced = Number(profile.totalorders) || 0;
    const validOrders = Number(profile.validOrderCount) || 0;
    const fulfilled = Number(profile.fulfilledCount) || 0;
    const rtos = Number(profile.rtoCount) || 0;
    const cancelled = Number(profile.cancelledCount) || 0;
    const cod = Number(profile.codCount) || 0;

    // 1. Accumulate Global Totals
    totalSecuredRevenue += spend;
    totalRevenueAtRisk += disputed; 
    totalCheckouts += totalPlaced;
    totalValidOrders += validOrders;
    totalFulfilled += fulfilled;
    totalRTO += rtos;
    totalCancelled += cancelled;

    if (profile.buyerSegment === "High Risk") highRiskCount += 1;

    // 2. Accumulate Dynamic Segment Data
    const segment = profile.buyerSegment || "New";
    if (!segmentStats[segment]) {
      segmentStats[segment] = { count: 0, revenue: 0, orders: 0, rtos: 0, disputes: 0 };
    }
    segmentStats[segment].count += 1;
    segmentStats[segment].revenue += spend;
    segmentStats[segment].orders += validOrders;
    segmentStats[segment].rtos += rtos;
    segmentStats[segment].disputes += disputed;

    // 3. Calculate Payment Success/Failure
    const prepaid = totalPlaced > cod ? (totalPlaced - cod) : 0;
    
    codTotal += cod;
    prepaidTotal += prepaid;

    // Dynamic failure rate based on actual DB records
    const failureRate = totalPlaced > 0 ? ((rtos + cancelled) / totalPlaced) : 0;
    codFailed += Math.round(cod * failureRate);
    codFulfilled += Math.round(cod * (1 - failureRate));
    
    prepaidFailed += Math.round(prepaid * failureRate);
    prepaidFulfilled += Math.round(prepaid * (1 - failureRate));

    // 4. Calculate Individual Risk Tiers
    const userRiskRate = totalPlaced > 0 ? ((cancelled + rtos) / totalPlaced) * 100 : 0;
    if (userRiskRate <= 10) riskTiers["Safe (0-10%)"] += 1;
    else if (userRiskRate <= 30) riskTiers["Moderate (11-30%)"] += 1;
    else if (userRiskRate <= 60) riskTiers["High (31-60%)"] += 1;
    else riskTiers["Severe (60%+)"] += 1;
  });

  // --- CHART DATA FORMATTING ---
  
  // Helper to assign consistent colors to standard segments, and random for custom ones
  const getSegmentColor = (segment) => {
    const colors = { "VIP": "#008060", "Repeat Buyer": "#2c6ecb", "New": "#8c9196", "High Risk": "#d82c0d" };
    return colors[segment] || "#" + Math.floor(Math.random()*16777215).toString(16); 
  };

  const segmentKeys = Object.keys(segmentStats);

  // Graph 1: Composition
  const segmentChartData = segmentKeys.map(key => ({
    name: key, value: segmentStats[key].count, color: getSegmentColor(key)
  })).filter(item => item.value > 0); 

  // Graph 2: AOV
  const aovChartData = segmentKeys.map(key => ({
    name: key, 
    aov: segmentStats[key].orders > 0 ? Math.round(segmentStats[key].revenue / segmentStats[key].orders) : 0, 
    fill: getSegmentColor(key)
  }));

  // Graph 3: Risk Tiers
  const riskTierData = Object.keys(riskTiers).map(key => ({
    name: key, Accounts: riskTiers[key]
  }));

  // Graph 4: Disputes
  const disputeData = segmentKeys.map(key => ({
    name: key, Disputes: segmentStats[key].disputes, fill: getSegmentColor(key)
  }));

  // Graph 5: Intent vs Valid
  const intentChartData = [
    { name: "Valid Orders", value: totalValidOrders, color: "#008060" },
    { name: "Abandoned Intents", value: totalCheckouts > totalValidOrders ? (totalCheckouts - totalValidOrders) : 0, color: "#ffc453" }
  ];

  // Graph 6: Logistics Funnel
  const logisticsChartData = [
    { name: "Checkout Intents", count: totalCheckouts, fill: "#e4e5e7" },
    { name: "Fulfilled", count: totalFulfilled, fill: "#008060" },
    { name: "Cancelled", count: totalCancelled, fill: "#ffc453" },
    { name: "RTO", count: totalRTO, fill: "#d82c0d" },
  ];

  // Graph 7: Revenue vs RTO
  const revenueRtoData = segmentKeys.map(key => ({
    name: key, revenue: segmentStats[key].revenue, rtos: segmentStats[key].rtos
  }));

  // Graph 8: Payment Risk
  const paymentRiskData = [
    { name: "COD", Success: codFulfilled, Failed: codFailed },
    { name: "Prepaid", Success: prepaidFulfilled, Failed: prepaidFailed },
  ];

  const safeFulfillmentRate = totalCheckouts > 0 ? Math.round((totalFulfilled / totalCheckouts) * 100) : 0;
  const globalRtoRate = totalCheckouts > 0 ? ((totalRTO / totalCheckouts) * 100).toFixed(1) : 0;

  return { 
    profilesLength: profiles.length, 
    dashboardStats: {
      totalSecuredRevenue, totalRevenueAtRisk, highRiskCount, safeFulfillmentRate, globalRtoRate,
      segmentChartData, aovChartData, riskTierData, disputeData, intentChartData, 
      revenueRtoData, logisticsChartData, paymentRiskData
    }
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  return { ok: true };
};

export default function Analytics() {
  const { profilesLength, dashboardStats } = useLoaderData();
  const navigation = useNavigation();
  const submit = useSubmit();
  
  const isRefreshing = navigation.state === "submitting" || navigation.state === "loading";
  const [isMounted, setIsMounted] = useState(false);
  
  useEffect(() => { setIsMounted(true); }, []);

  const handleRefresh = () => { submit({}, { method: "post" }); };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency: "INR", minimumFractionDigits: 0,
    }).format(amount);
  };

  if (!profilesLength || profilesLength === 0) {
    return (
      <Page title="Risk Score & Analytics Dashboard">
        <Card>
          <EmptyState
            heading="Awaiting customer data sync"
            action={{ content: "Run Data Engine", onAction: handleRefresh, loading: isRefreshing }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>Your database is currently empty for this shop. We need to process historical orders to build your analytical models.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Risk Score & Analytics Dashboard" primaryAction={<Button onClick={handleRefresh} loading={isRefreshing}>Refresh Dashboard</Button>} fullWidth>
      <Layout>
        {/* --- EXECUTIVE KPIs --- */}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 5 }} gap="400">
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Verified LTV (Spend)</Text>
                <Text as="p" variant="headingLg" tone="success">{formatCurrency(dashboardStats.totalSecuredRevenue)}</Text>
              </BlockStack>
            </Card>
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Disputed Revenue Risk</Text>
                <Text as="p" variant="headingLg" tone="critical">{formatCurrency(dashboardStats.totalRevenueAtRisk)}</Text>
              </BlockStack>
            </Card>
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Identified Threats</Text>
                <Text as="p" variant="headingLg" tone="critical">{dashboardStats.highRiskCount} <Text as="span" variant="bodySm">Accounts</Text></Text>
              </BlockStack>
            </Card>
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Global RTO Rate</Text>
                <Text as="p" variant="headingLg" tone="caution">{dashboardStats.globalRtoRate}%</Text>
              </BlockStack>
            </Card>
            <Card roundedAbove="sm">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Fulfillment Success</Text>
                <Text as="p" variant="headingLg">{dashboardStats.safeFulfillmentRate}%</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        {/* --- SECTION 1: AUDIENCE & REVENUE --- */}
        <Layout.Section>
          <Box paddingBlockStart="400" paddingBlockEnd="400">
             <Divider />
             <Box paddingBlockStart="400"><Text variant="headingLg" as="h2">Audience & Revenue Insights</Text></Box>
          </Box>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {/* Graph 1: Base Composition */}
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Customer Base Composition</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={dashboardStats.segmentChartData} innerRadius={60} outerRadius={90} paddingAngle={3} dataKey="value">
                          {dashboardStats.segmentChartData.map((e, i) => <Cell key={`cell-${i}`} fill={e.color} />)}
                        </Pie>
                        <RechartsTooltip formatter={(val) => [`${val} Profiles`, "Volume"]} />
                        <Legend verticalAlign="bottom" height={36}/>
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>

            {/* Graph 2: AOV by Segment */}
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Average Order Value (AOV) by Segment</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer>
                      <BarChart data={dashboardStats.aovChartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} tickFormatter={(val) => `₹${val}`} />
                        <RechartsTooltip formatter={(val) => [formatCurrency(val), "AOV"]} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                        <Bar dataKey="aov" radius={[4, 4, 0, 0]}>
                          {dashboardStats.aovChartData.map((e, i) => <Cell key={`cell-${i}`} fill={e.fill} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        {/* --- SECTION 2: RISK & FRAUD --- */}
        <Layout.Section>
          <Box paddingBlockStart="400" paddingBlockEnd="400">
             <Divider />
             <Box paddingBlockStart="400"><Text variant="headingLg" as="h2">Risk & Fraud Intelligence</Text></Box>
          </Box>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            
            {/* Graph 3: Risk Tiers */}
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Account Risk Tiers</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer>
                      <AreaChart data={dashboardStats.riskTierData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                        <RechartsTooltip />
                        <Area type="monotone" dataKey="Accounts" stroke="#d82c0d" fill="#ffc453" />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>

            {/* Graph 4: Disputes */}
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Chargeback Exposure</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer>
                      <BarChart data={dashboardStats.disputeData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(val) => `₹${val/1000}k`} />
                        <RechartsTooltip formatter={(val) => [formatCurrency(val), "Disputed"]} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                        <Bar dataKey="Disputes" radius={[4, 4, 0, 0]}>
                          {dashboardStats.disputeData.map((e, i) => <Cell key={`cell-${i}`} fill={e.fill} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>

            {/* Graph 5: Intent Validity */}
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Checkout Intent Validity</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={dashboardStats.intentChartData} innerRadius={0} outerRadius={80} dataKey="value">
                          {dashboardStats.intentChartData.map((e, i) => <Cell key={`cell-${i}`} fill={e.color} />)}
                        </Pie>
                        <RechartsTooltip formatter={(val) => [val, "Count"]} />
                        <Legend verticalAlign="bottom" height={36}/>
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        {/* --- SECTION 3: LOGISTICS & PAYMENTS --- */}
        <Layout.Section>
          <Box paddingBlockStart="400" paddingBlockEnd="400">
             <Divider />
             <Box paddingBlockStart="400"><Text variant="headingLg" as="h2">Logistics & Payments Performance</Text></Box>
          </Box>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            
            {/* Graph 6: Logistics Funnel */}
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Operations Funnel</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer>
                      <BarChart data={dashboardStats.logisticsChartData} layout="vertical" margin={{ top: 0, right: 20, left: 30, bottom: 0 }}>
                        <XAxis type="number" hide />
                        <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                        <RechartsTooltip cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                        <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={25}>
                          {dashboardStats.logisticsChartData.map((e, i) => <Cell key={`cell-${i}`} fill={e.fill} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>

            {/* Graph 7: RTO vs Revenue */}
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Spend vs RTO Volume</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer>
                      <ComposedChart data={dashboardStats.revenueRtoData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(val) => `₹${val/1000}k`} />
                        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                        <RechartsTooltip />
                        <Bar yAxisId="left" dataKey="revenue" name="Total Spend" fill="#008060" radius={[4, 4, 0, 0]} barSize={20} />
                        <Line yAxisId="right" type="monotone" dataKey="rtos" name="RTO Events" stroke="#d82c0d" strokeWidth={2} dot={{ r: 4 }} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>

            {/* Graph 8: COD vs Prepaid */}
            <Card roundedAbove="sm">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Payment Integrity</Text>
                <div style={{ height: "250px", width: "100%" }}>
                  {isMounted && (
                    <ResponsiveContainer>
                      <BarChart data={dashboardStats.paymentRiskData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <RechartsTooltip cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                        <Legend verticalAlign="bottom" height={36}/>
                        <Bar dataKey="Success" stackId="a" fill="#008060" radius={[0, 0, 4, 4]} />
                        <Bar dataKey="Failed" stackId="a" fill="#d82c0d" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </BlockStack>
            </Card>

          </InlineGrid>
        </Layout.Section>

      </Layout>
    </Page>
  );
}