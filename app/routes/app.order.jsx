import {
  Page,
  Layout,
  Card,
  IndexTable,
  useIndexResourceState,
  Text,
  Badge,
  BlockStack,
  Tabs,
  Link,
  Box,
} from "@shopify/polaris";
import { useState, useMemo } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// 1. SERVER-SIDE LOADER: Fetch recent orders and enrich them with Risk Profiles
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Fetch the 50 most recent orders
  const recentOrders = await prisma.shopify_store_order.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Fetch all buyer profiles for this shop to map the risk segments
  const profiles = await prisma.zippyy_buyer_profile.findMany({
    where: { shop },
  });

  // Map profiles to a quick lookup dictionary based on identifiers
  const profileMap = {};
  profiles.forEach(p => {
    if (p.customerEmail) profileMap[p.customerEmail] = p;
    if (p.customerPhone) profileMap[p.customerPhone] = p;
    if (p.customerId) profileMap[p.customerId] = p;
  });

  // Enrich the orders with their risk data
  const enrichedOrders = recentOrders.map(order => {
    // Find the matching profile
    const profile = profileMap[order.customerEmail] || profileMap[order.customerPhone] || profileMap[order.customerId];
    
    // Extract the numeric Shopify ID from the GID (gid://shopify/Order/123456789)
    const numericId = order.shopifyOrderId.split("/").pop();
    
    return {
      id: order.id,
      numericId: numericId,
      // UPDATED: Using the App Bridge deep link format
      orderUrl: `shopify:admin/orders/${numericId}`,
      customerName: order.customerEmail || order.customerPhone || "Guest",
      total: order.orderValue,
      date: new Date(order.createdAt).toLocaleDateString(),
      financialStatus: order.financialStatus || "PENDING",
      segment: profile?.buyerSegment || "New",
      riskReasons: profile?.riskReasons || "",
    };
  });

  return Response.json({ orders: enrichedOrders, shop });
};

// 2. CLIENT-SIDE COMPONENT
export default function OrdersAnalysis() {
  const { orders } = useLoaderData();
  const [selectedTab, setSelectedTab] = useState(0);

  // Define our tabs for easy filtering
  const tabs = [
    { id: "all", content: "All Analyzed Orders" },
    { id: "high-risk", content: "High Risk Alerts" },
    { id: "vip", content: "VIP & Repeat" },
  ];

  // Filter the orders based on the selected tab
  const filteredOrders = useMemo(() => {
    if (selectedTab === 1) return orders.filter(o => o.segment === "High Risk");
    if (selectedTab === 2) return orders.filter(o => o.segment === "VIP" || o.segment === "Repeat Buyer");
    return orders;
  }, [orders, selectedTab]);

  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(filteredOrders);

  // Helper function to color-code the risk badges
  const getRiskBadge = (segment) => {
    switch (segment) {
      case "High Risk": return <Badge tone="critical">High Risk</Badge>;
      case "VIP": return <Badge tone="success">VIP</Badge>;
      case "Repeat Buyer": return <Badge tone="info">Repeat</Badge>;
      default: return <Badge>New</Badge>;
    }
  };

  // Helper function to color-code the financial status
  const getFinancialBadge = (status) => {
    const s = status.toUpperCase();
    if (s === "PAID") return <Badge tone="success">Paid</Badge>;
    if (s === "REFUNDED") return <Badge tone="warning">Refunded</Badge>;
    if (s === "PENDING") return <Badge tone="attention">Pending</Badge>;
    return <Badge>{status}</Badge>;
  };

  // Build the rows for the IndexTable
  const rowMarkup = filteredOrders.map(
    ({ id, numericId, orderUrl, customerName, total, date, financialStatus, segment, riskReasons }, index) => (
      <IndexTable.Row
        id={id}
        key={id}
        selected={selectedResources.includes(id)}
        position={index}
      >
        <IndexTable.Cell>
          <Link url={orderUrl} removeUnderline>
            <Text variant="bodyMd" fontWeight="bold" as="span">
              #{numericId}
            </Text>
          </Link>
        </IndexTable.Cell>
        <IndexTable.Cell>{date}</IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack>
            <Text variant="bodyMd" as="span">{customerName}</Text>
            {segment === "High Risk" && riskReasons && (
              <Text variant="bodySm" tone="critical" as="span">
                {riskReasons}
              </Text>
            )}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text variant="bodyMd" as="span">INR {parseFloat(total).toFixed(2)}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{getFinancialBadge(financialStatus)}</IndexTable.Cell>
        <IndexTable.Cell>{getRiskBadge(segment)}</IndexTable.Cell>
      </IndexTable.Row>
    )
  );

  return (
    <Page 
      title="Order Risk Analysis" 
      subtitle="Review recent orders and their assigned risk segments."
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} fitted />
            
            <Box paddingBlockStart="200">
              <IndexTable
                resourceName={{ singular: "order", plural: "orders" }}
                itemCount={filteredOrders.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: "Order" },
                  { title: "Date" },
                  { title: "Customer & Alerts" },
                  { title: "Total" },
                  { title: "Payment Status" },
                  { title: "Risk Segment" },
                ]}
                selectable={false} 
              >
                {rowMarkup}
              </IndexTable>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}









