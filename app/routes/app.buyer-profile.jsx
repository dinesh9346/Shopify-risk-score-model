
import { useLoaderData, useNavigation, useSubmit, useSearchParams } from "react-router";
import { useState, useEffect, useCallback, useMemo } from "react";
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
  Link,
  TextField,
  Icon
} from "@shopify/polaris";
import { ExportIcon, SearchIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// BACKEND LOADER 

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // 1. Parse URL Parameters for Server-Side Filtering
  const url = new URL(request.url);
  const search = url.searchParams.get("q") || "";
  const segmentTab = url.searchParams.get("segment") || "all";
  
  const limit = 250; 
  const skip = 0;

  const segmentMap = {
    risk: "High Risk",
    watchlist: "Watchlist",
    vip: "VIP",
    repeat: "Repeat Buyer",
    new: "New"
  };

  // Build the dynamic Prisma WHERE clause
  const profileWhere = { shop };
  if (segmentMap[segmentTab]) {
    profileWhere.buyerSegment = segmentMap[segmentTab];
  }
  if (search) {
    profileWhere.OR = [
      { customerEmail: { contains: search } }, 
      { customerPhone: { contains: search } },
      { firstName: { contains: search } },
      { lastName: { contains: search } }
    ];
  }

  // 2. PARALLEL EXECUTION: Calculate Dashboard Stats & Fetch Profiles Instantly
  const [
    globalStats,
    segmentGroupings,
    profilesData
  ] = await Promise.all([
    prisma.zippyy_buyer_profile.aggregate({
      where: { shop },
      _sum: {
        totalSpend: true,
        validOrderCount: true,
        totalorders: true,
        fulfilledCount: true,
        rtoCount: true,
        cancelledCount: true,
        unpaidCount: true
      }
    }),
    prisma.zippyy_buyer_profile.groupBy({
      by: ['buyerSegment'],
      where: { shop },
      _count: { buyerSegment: true }
    }),
    prisma.zippyy_buyer_profile.findMany({
      where: profileWhere,
      take: limit,
      skip: skip,
      orderBy: { totalorders: "desc" },
    })
  ]);

  const segmentCounts = { VIP: 0, "Repeat Buyer": 0, Watchlist: 0, New: 0, "High Risk": 0 };
  segmentGroupings.forEach(group => {
    if (group.buyerSegment) segmentCounts[group.buyerSegment] = group._count.buyerSegment;
  });

  const totals = globalStats._sum;
  const safeFulfillmentRate = totals.totalorders > 0 
    ? Math.round((totals.fulfilledCount / totals.totalorders) * 100) 
    : 0;

  // 3. Fetch recent orders for ALL profiles in the current segment 
  const profileIds = profilesData.map(p => p.id);
  const emails = [...new Set(profilesData.map(p => p.customerEmail).filter(Boolean))];
  const phones = [...new Set(profilesData.map(p => p.customerPhone).filter(Boolean))];
  const customerIds = [...new Set(profilesData.map(p => p.customerId).filter(Boolean))];

  const relevantOrders = await prisma.shopify_store_order.findMany({
    where: {
      shop,
      OR: [
        { buyerProfileId: { in: profileIds } },
        { customerEmail: { in: emails } },
        { customerPhone: { in: phones } },
        { customerId: { in: customerIds } }
      ]
    },
    orderBy: { updatedAt: "desc" },
    select: { 
      id: true, shopifyOrderId: true, carrier: true, trackingNumber: true, 
      trackingUrl: true, shipmentStatus: true, fulfillmentStatus: true,
      financialStatus: true, cancelledAt: true, isRTO: true,
      buyerProfileId: true, customerEmail: true, customerPhone: true, customerId: true, updatedAt: true
    }
  });

  // Map orders to profiles
  const ordersByProfileId = new Map();
  const ordersByEmail = new Map();
  const ordersByPhone = new Map();
  const ordersByCustomerId = new Map();

  for (const order of relevantOrders) {
    if (order.buyerProfileId) ordersByProfileId.set(order.buyerProfileId, [...(ordersByProfileId.get(order.buyerProfileId) || []), order]);
    if (order.customerEmail) {
      const emailLower = order.customerEmail.toLowerCase();
      ordersByEmail.set(emailLower, [...(ordersByEmail.get(emailLower) || []), order]);
    }
    if (order.customerPhone) ordersByPhone.set(order.customerPhone, [...(ordersByPhone.get(order.customerPhone) || []), order]);
    if (order.customerId) ordersByCustomerId.set(order.customerId, [...(ordersByCustomerId.get(order.customerId) || []), order]);
  }

  const profiles = profilesData.map((p) => {
    let displayName = [p.firstName, p.lastName].filter(Boolean).join(" ");
    if (!displayName) displayName = p.customerEmail;
    if (!displayName) displayName = p.customerPhone;
    if (!displayName) {
      if (p.buyerIdentifier?.includes('Customer/')) {
        displayName = `Shopify User #${p.buyerIdentifier.split('/').pop()}`;
      } else if (p.buyerIdentifier?.includes('Order/')) {
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

    // Attach orders from any matched identifier
    addOrders(ordersByProfileId.get(p.id));
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

  return Response.json({
    profiles,
    dashboardStats: {
      totalSecuredRevenue: totals.totalSpend || 0,
      totalValidOrders: totals.validOrderCount || 0,
      safeFulfillmentRate,
      highRiskCount: segmentCounts["High Risk"],
      segmentCounts,
    },
  });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  return Response.json({ ok: true });
};

 // FRONTEND UI

export default function Index() {
  const { profiles, dashboardStats } = useLoaderData() || { 
    profiles: [], 
    dashboardStats: { segmentCounts: {} } 
  };
  
  const navigation = useNavigation();
  const submit = useSubmit();
  const [searchParams, setSearchParams] = useSearchParams();

  const isRefreshing = navigation.state === "submitting" || navigation.state === "loading";

  // URL State
  const currentSearch = searchParams.get("q") || "";
  const currentTabId = searchParams.get("segment") || "all";

  // Local State
  const [selectedProfileId, setSelectedProfileId] = useState(null); 
  const [isMounted, setIsMounted] = useState(false);
  const [orderHistoryTab, setOrderHistoryTab] = useState(0);
  const [searchInput, setSearchInput] = useState(currentSearch);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Sync search input with URL param changes
  useEffect(() => {
    if (!isMounted) return;
    
    const delayDebounceFn = setTimeout(() => {
      setSearchParams(prev => {
        const currentQ = prev.get("q") || "";
        // Only update if the value actually changed
        if (searchInput && searchInput !== currentQ) {
          prev.set("q", searchInput);
        } else if (!searchInput && currentQ) {
          prev.delete("q");
        }
        return prev;
      }, { preventScrollReset: true }); 
    }, 400); // Debounce time

    return () => clearTimeout(delayDebounceFn);
  }, [searchInput, setSearchParams, isMounted]);

  // --- Handlers ---
  const handleRowClick = (profile) => {
    setSelectedProfileId(profile.id);
  };

  const handleBackToList = () => {
    setSelectedProfileId(null);
  };

  const handleRefresh = () => {
    submit(searchParams, { method: "get" });
  };

  const handleTabChange = useCallback((selectedTabIndex) => {
    const newTabId = tabs[selectedTabIndex].id;
    setSearchParams(prev => {
      prev.set("segment", newTabId);
      return prev;
    });
  }, [setSearchParams]);

  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchInput("");
    setSearchParams(prev => { 
      prev.delete("q"); 
      return prev; 
    });
  }, [setSearchParams]);

  
  // CSV Export Logic
  const exportToCSV = () => {
    if (!profiles || profiles.length === 0) return;

    const headers = [
      "Customer Name",
      "Email",
      "Phone",
      "Segment",
      "Total Orders",
      "Valid Orders",
      "Total Spend",
      "Risk Reasons"
    ];

    const csvRows = [headers.join(",")];

    profiles.forEach((profile) => {
      const row = [
        `"${(profile.displayName || "").replace(/"/g, '""')}"`,
        `"${(profile.customerEmail || "").replace(/"/g, '""')}"`,
        `"${(profile.customerPhone || "").replace(/"/g, '""')}"`,
        `"${(profile.buyerSegment || "").replace(/"/g, '""')}"`,
        profile.totalorders || 0,
        profile.validOrderCount || 0,
        profile.totalSpend || 0,
        `"${(profile.riskReasons || []).join("; ").replace(/"/g, '""')}"`
      ];
      csvRows.push(row.join(","));
    });

    const csvString = csvRows.join("\n");
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `customers_report.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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

  // Helper to get styled badge text ONLY for the bottom key segments
  const getBadgeText = (text, type = "general") => {
    let style = { 
      padding: '4px 8px', 
      borderRadius: '4px', 
      fontWeight: 'bold', 
      color: 'white', 
      textTransform: 'uppercase',
      fontSize: '0.8rem',
      display: 'inline-block'
    };

    switch(type) {
      case 'critical': style.backgroundColor = '#d32f2f'; break; 
      case 'success': style.backgroundColor = '#2e7d32'; break; 
      case 'warning': style.backgroundColor = '#f57c00'; color: '#333'; break; 
      case 'info': style.backgroundColor = '#1976d2'; break; 
      default: style.backgroundColor = '#e0e0e0'; color: '#333'; break; 
    }

    return <span style={style}>{text}</span>;
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

  const normalizeStatus = (value) =>
    (value || "")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/-+/g, "_");

  const isEmptyLike = (value) => {
    const v = normalizeStatus(value);
    return v === "" || v === "null" || v === "undefined";
  };

  const SHIPMENT_RTO = new Set([
    "failure", "failed", "returned", "rto", "return_to_origin",
    "undelivered", "attempted_delivery", "delivery_failed",
    "not_delivered", "lost", "exception"
  ]);

  const SHIPMENT_IN_TRANSIT = new Set([
    "in_transit", "out_for_delivery", "shipped",
    "arrived_at_facility", "departed_facility",
    "in_transit_to_destination"
  ]);

  // NEW: Pre-Transit Statuses 
  const SHIPMENT_PRE_TRANSIT = new Set([
    "label_created", "label_purchased", "label_printed",
    "ready_for_pickup", "manifested", "picked_up"
  ]);

  const SHIPMENT_PENDING = new Set([
    "confirmed", "booked", "processing", "pending"
  ]);

  // ============================================
  // THE NEW BUCKET LOGIC 
  // ============================================
  const getOrderBucket = (order) => {
    const ship = normalizeStatus(order?.shipmentStatus);
    const fulfill = normalizeStatus(order?.fulfillmentStatus);
    const financial = normalizeStatus(order?.financialStatus);

    const trackingNumber = isEmptyLike(order?.trackingNumber) ? "" : String(order?.trackingNumber).trim();
    const hasTracking = Boolean(trackingNumber || order?.trackingUrl);

    const isUnfulfilled = ["unfulfilled", "null", "undefined", ""].includes(fulfill);
    const isFinanciallyDead = ["refunded", "voided"].includes(financial);
    const isShipmentCancelled = ["cancelled", "canceled"].includes(ship);
    const isShopifyCancelled = Boolean(order?.cancelledAt);

    const isRtoShipment = SHIPMENT_RTO.has(ship);
    const isReturnedFulfill = fulfill === "returned" || fulfill === "restocked";

    if (order?.isRTO || isRtoShipment || isReturnedFulfill) {
      return "rto";
    }

    const physicallyShipped = hasTracking || !isUnfulfilled;

    if (isShopifyCancelled || isFinanciallyDead || isShipmentCancelled) {
      if (physicallyShipped) {
        return "rto";
      }
      return "cancelled";
    }

    if (ship === "delivered" || fulfill === "delivered"||ship ==="Delivered") return "delivered";
    if (SHIPMENT_IN_TRANSIT.has(ship)) return "in_transit";
    if (SHIPMENT_PRE_TRANSIT.has(ship)) return "pre_transit";
    if (SHIPMENT_PENDING.has(ship)) return "pending";

    // REACT MAGIC: If it has tracking, but carrier hasn't scanned it yet, it is Pre-Transit
    if (hasTracking) return "pre_transit";

    // If fulfilled (e.g., local delivery) but no tracking number exists
    if (fulfill === "fulfilled" || fulfill === "success") return "pending";
    
    return "unfulfilled";
  };

  const getShipmentBadge = (order) => {
    const bucket = getOrderBucket(order);
    if (bucket === "unfulfilled") return <Badge tone="attention">Unfulfilled</Badge>;
    if (bucket === "pending") return <Badge>Pending Dispatch</Badge>;
    if (bucket === "pre_transit") return <Badge tone="info">Pre-Transit</Badge>; // <-- NEW BADGE
    if (bucket === "in_transit") return <Badge tone="info">In Transit</Badge>;
    if (bucket === "delivered") return <Badge tone="success">Delivered</Badge>;
    if (bucket === "rto") return <Badge tone="critical">RTO / Failed Delivery</Badge>;
    if (bucket === "cancelled") return <Badge tone="critical">Cancelled</Badge>;
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
  
  const selectedTab = Math.max(0, tabs.findIndex(t => t.id === currentTabId));

  // NEW: Added the Pre-Transit tab here
  const orderHistoryTabs = [
    { id: "unfulfilled", content: "Unfulfilled" },
    { id: "pending-dispatch", content: "Pending Dispatch" },
    { id: "pre-transit", content: "Pre-Transit" }, 
    { id: "in-transit", content: "In Transit" },
    { id: "delivered", content: "Delivered" },
    { id: "rto", content: "RTO / Failed" },
    { id: "cancelled", content: "Cancelled" },
  ];

  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(profiles);

  // Memoize the row markup for performance
  const rowMarkup = useMemo(() => {
    return profiles.map((profile, index) => {
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
            <Text as="span" alignment="end" fontWeight="bold">{profile.totalorders}</Text>
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
              <Text tone="critical">Flagged as {profile.buyerSegment} Customer</Text>
            ) : (
              <Text tone="subdued">Standard Customer Profile</Text>
            )}
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    });
  }, [profiles, selectedResources]);

  if (!profiles || profiles.length === 0) {
    if (currentTabId === "all" && !currentSearch) {
      return (
        <Page title="Customer Directory">
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
  }

  // FULL PAGE DETAIL VIEW
  if (selectedProfile) {
    const detailOrderHistory = selectedProfile.orderHistory || [];

    // Filter updated to match the new tab indices!
    const filteredOrderHistory = detailOrderHistory.filter((order) => {
      const bucket = getOrderBucket(order);
      if (orderHistoryTab === 0) return bucket === "unfulfilled";
      if (orderHistoryTab === 1) return bucket === "pending";
      if (orderHistoryTab === 2) return bucket === "pre_transit"; 
      if (orderHistoryTab === 3) return bucket === "in_transit";
      if (orderHistoryTab === 4) return bucket === "delivered";
      if (orderHistoryTab === 5) return bucket === "rto";
      if (orderHistoryTab === 6) return bucket === "cancelled";
      return true;
    });

    return (
      <Page
        title="Customer Detail"
        backAction={{ content: "Back to list", onAction: handleBackToList }}
        primaryAction={{ content: "Refresh Data", onAction: handleRefresh, loading: isRefreshing }}
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
                  <Text as="p" variant="headingLg">{selectedProfile.totalorders}</Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 4 }} gap="400">
              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Fulfilled</Text>
                  <Text as="p" variant="headingLg" tone="success">{selectedProfile.fulfilledCount || 0}</Text>
                </BlockStack>
              </Card>

              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Cancelled</Text>
                  <Text as="p" variant="headingLg" tone="critical">{selectedProfile.cancelledCount || 0}</Text>
                </BlockStack>
              </Card>

              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">RTO</Text>
                  <Text as="p" variant="headingLg" tone="critical">{selectedProfile.rtoCount || 0}</Text>
                </BlockStack>
              </Card>

              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">COD Orders</Text>
                  <Text as="p" variant="headingLg">{selectedProfile.codCount || 0}</Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Disputes</Text>
                  <Text as="p" variant="headingLg" tone="critical">{selectedProfile.disputeCount || 0}</Text>
                </BlockStack>
              </Card>

              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Refunds</Text>
                  <Text as="p" variant="headingLg" tone="critical">{selectedProfile.refundCount || 0}</Text>
                </BlockStack>
              </Card>

              <Card roundedAbove="sm">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Unpaid</Text>
                  <Text as="p" variant="headingLg" tone="critical">{selectedProfile.unpaidCount || 0}</Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>
         
          {(selectedProfile.buyerSegment === "High Risk" || selectedProfile.buyerSegment === "Watchlist") && (
            <Layout.Section>
              <Banner 
                tone={selectedProfile.buyerSegment === "High Risk" ? "critical" : "warning"} 
                title={`${selectedProfile.buyerSegment} Customer`}
              >
                <Text as="p">
                  This buyer has been classified as a {selectedProfile.buyerSegment} customer based on their historical order patterns.
                </Text>
              </Banner>
            </Layout.Section>
          )}

          <Layout.Section>
            <Card padding="0">
              <Box padding="400">
                <Text variant="headingMd" as="h3">Order & Tracking History</Text>
                <Text tone="subdued">{detailOrderHistory.length || 0} orders found</Text>
              </Box>
              <Tabs tabs={orderHistoryTabs} selected={orderHistoryTab} onSelect={setOrderHistoryTab} fitted />
              <Divider />
              <Scrollable style={{ height: "520px" }} focusable>
                <Box padding="400">
                  <BlockStack gap="300">
                    {filteredOrderHistory.length > 0 ? (
                      filteredOrderHistory.map((order, idx) => {
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

  // ===== MAIN PAGE =====
  return (
    <Page 
      title="Customer Directory" 
      primaryAction={{ content: "Refresh Data", onAction: handleRefresh, loading: isRefreshing }}
      secondaryActions={[{ content: "Download Current Page", icon: ExportIcon, onAction: exportToCSV }]}
    >
      <style>{`
        /* Hide the default sticky header and make table headings sticky */
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

        /* Style tabs to look more integrated like the image */
        .integrated-tabs .Polaris-Tabs__Tab {
          text-align: center;
          font-weight: bold;
          flex: 1;
        }
      `}</style>

      
      <Box padding="0" paddingBlockEnd="0" paddingInlineStart="0" paddingInlineEnd="0" className="integrated-tabs">
        <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange} fitted={false} style={{ border: 'none', boxShadow: 'none', background: 'transparent' }} />
      </Box>

      
      <Box padding="0" style={{ backgroundColor: 'var(--p-color-bg-surface)', border: 'none', borderRadius: 0, boxShadow: 'none' }}>
        
       
        <Box padding="400">
          <BlockStack gap="400">
            <Text variant="headingMd" as="h1" fontWeight="bold">Actionable Intelligence Log</Text>
            {/* LIVE SEARCH BAR */}
            <form onSubmit={(e) => e.preventDefault()}>
              <InlineStack gap="300" align="start">
                <div style={{ flexGrow: 1 }}>
                  <TextField
                    placeholder="Start typing to search customers..."
                    value={searchInput}
                    onChange={handleSearchChange}
                    clearButton
                    onClearButtonClick={handleClearSearch}
                    autoComplete="off"
                    prefix={<Icon source={SearchIcon} tone="base" />}
                  />
                </div>
                
              </InlineStack>
            </form>
          </BlockStack>
        </Box>
        
        <Divider />

        <Scrollable style={{ height: "calc(100vh - 280px)", minHeight: "500px" }} focusable>
          {profiles.length > 0 ? (
            <IndexTable
              resourceName={{ singular: "customer", plural: "customers" }}
              itemCount={profiles.length}
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
          ) : (
            <Box padding="400">
               <EmptyState heading="No customers found">
                <p>Try changing your search query or selecting a different segment tab.</p>
              </EmptyState>
            </Box>
          )}
        </Scrollable>

        {/* Bottom Key Segments Section */}
        {currentTabId === 'all' && (
          <Box padding="400" paddingBlockStart="500">
            <Divider />
            <Box paddingBlockStart="400">
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2" fontWeight="bold" tone="subdued">Key Customer Segments</Text>
                
                <InlineGrid columns={{ xs: 2, sm: 5 }} gap="400">
                  {[
                    { title: "VIPs", count: dashboardStats.segmentCounts?.["VIP"] || 0, badge: getBadgeText("VIP", "success") },
                    { title: "Repeat Buyers", count: dashboardStats.segmentCounts?.["Repeat Buyer"] || 0, badge: getBadgeText("Repeat", "info") },
                    { title: "Watchlist", count: dashboardStats.segmentCounts?.["Watchlist"] || 0, badge: getBadgeText("Watchlist", "warning") },
                    { title: "High Risk", count: dashboardStats.segmentCounts?.["High Risk"] || 0, badge: getBadgeText("Risk", "critical") },
                    { title: "New Customers", count: dashboardStats.segmentCounts?.["New"] || 0, badge: getBadgeText("New") }
                  ].map(segment => (
                    <Box key={segment.title} padding="300" background="bg-surface-secondary" borderRadius="4px" style={{ textAlign: 'center' }}>
                      <BlockStack gap="100" align="center">
                        <Box>{segment.badge}</Box>
                        <Text variant="headingLg" as="p" fontWeight="bold">{segment.count}</Text>
                        <Text as="p" tone="subdued">{segment.title}</Text>
                      </BlockStack>
                    </Box>
                  ))}
                </InlineGrid>
              </BlockStack>
            </Box>
          </Box>
        )}
      </Box>
    </Page>
  );
}

export { boundary };