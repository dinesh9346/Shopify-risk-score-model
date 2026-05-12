
import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  IndexTable,
  BlockStack,
  InlineStack,
  Button,
  Icon,
  Modal,
  Scrollable,
  Divider,
  Tabs,
  Avatar,
  Box
} from "@shopify/polaris";
import {
  ChatIcon,
  EmailIcon,
  ViewIcon,
  AlertBubbleIcon,
  ArrowLeftIcon,
  PersonIcon
} from "@shopify/polaris-icons";
import { useState, useMemo } from "react";

// Replace with your actual Prisma client and auth imports
import prisma from "../db.server"; 
import { authenticate } from "../shopify.server";

// --- 1. BACKEND: Fetching & Unifying Data ---
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // 1. Fetch KPI Stats
  const stats = await prisma.notification.groupBy({
    by: ['status'],
    where: { shop },
    _count: { status: true },
  });

  const statusCounts = { SENT: 0, DELIVERED: 0, FAILED: 0, PENDING: 0 };
  stats.forEach(stat => { statusCounts[stat.status] = stat._count.status; });

  const totalReplies = await prisma.customerReply.count({ where: { shop } });

  // 2. Fetch Notifications & Replies
  const notifications = await prisma.notification.findMany({
    where: { shop },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { events: { orderBy: { receivedAt: 'desc' } } },
  });

  const replies = await prisma.customerReply.findMany({
    where: { shop },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  // 3. Fetch unique customers from orders to map emails/phones to Names
  const recentOrders = await prisma.shopify_store_order.findMany({
    where: { shop },
    select: { 
      firstName: true, 
      lastName: true, 
      customerEmail: true, 
      customerPhone: true, 
      customerId: true 
    },
    distinct: ['customerId'], // Ensure unique customers
  });

  return Response.json({ notifications, statusCounts, totalReplies, replies, recentOrders });
}

// --- 2. FRONTEND: Premium UI Components ---
export default function NotificationTracker() {
  const { notifications, statusCounts, totalReplies, replies, recentOrders } = useLoaderData();
  
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedNotification, setSelectedNotification] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // --- DATA PROCESSING: Build Unified Customer Profiles ---
  const unifiedCustomers = useMemo(() => {
    const customerMap = new Map();

    // 1. Seed the map with known customers from orders
    recentOrders.forEach(order => {
      if (!order.customerId) return;
      customerMap.set(order.customerId, {
        id: order.customerId,
        name: `${order.firstName || ''} ${order.lastName || ''}`.trim() || 'Unknown Customer',
        email: order.customerEmail,
        phone: order.customerPhone,
        whatsappMsgs: [],
        emailMsgs: [],
        whatsappReplies: [],
        emailReplies: [],
      });
    });

    // Helper to find customer by phone or email if ID is missing
    const findCustomerByIdentifier = (identifier) => {
      for (const [id, customer] of customerMap.entries()) {
        if (customer.email === identifier || customer.phone === identifier) return customer;
      }
      return null;
    };

    // 2. Map Notifications to Customers
    notifications.forEach(notif => {
      let customer = findCustomerByIdentifier(notif.recipient);
      
      // Create a fallback "Guest" profile if no matching order exists
      if (!customer) {
        const fallbackId = `guest_${notif.recipient}`;
        if (!customerMap.has(fallbackId)) {
          customerMap.set(fallbackId, {
            id: fallbackId,
            name: 'Guest User',
            email: notif.channel === 'EMAIL' ? notif.recipient : null,
            phone: notif.channel === 'WHATSAPP' ? notif.recipient : null,
            whatsappMsgs: [], emailMsgs: [], whatsappReplies: [], emailReplies: []
          });
        }
        customer = customerMap.get(fallbackId);
      }

      if (notif.channel === "WHATSAPP") customer.whatsappMsgs.push(notif);
      if (notif.channel === "EMAIL") customer.emailMsgs.push(notif);
    });

    // 3. Map Replies to Customers
    replies.forEach(reply => {
      let customer = findCustomerByIdentifier(reply.customerPhone) || findCustomerByIdentifier(reply.customerEmail);
      if (customer) {
        if (reply.channel === "EMAIL") customer.emailReplies.push(reply);
        else customer.whatsappReplies.push(reply);
      }
    });

    // Filter out customers who have 0 interactions
    return Array.from(customerMap.values())
      .filter(c => c.whatsappMsgs.length + c.emailMsgs.length + c.whatsappReplies.length + c.emailReplies.length > 0)
      .sort((a, b) => {
        // Sort by total interaction volume
        const aTotal = a.whatsappMsgs.length + a.emailMsgs.length;
        const bTotal = b.whatsappMsgs.length + b.emailMsgs.length;
        return bTotal - aTotal;
      });
  }, [notifications, replies, recentOrders]);

  const activeCustomer = useMemo(() => 
    unifiedCustomers.find(c => c.id === selectedCustomerId), 
  [selectedCustomerId, unifiedCustomers]);


  // --- UI HELPERS ---
  const formatDate = (dateString) => new Date(dateString).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const getStatusBadge = (status) => {
    switch (status) {
      case "DELIVERED": return <Badge tone="success">Delivered</Badge>;
      case "FAILED": return <Badge tone="critical">Failed</Badge>;
      case "SENT": return <Badge tone="info">Sent</Badge>;
      case "PENDING": return <Badge tone="warning">Pending</Badge>;
      default: return <Badge>{status}</Badge>;
    }
  };

  // --- VIEW: MASTER DIRECTORY ---
  const renderMasterView = () => (
    <Card padding="0">
      <IndexTable
        resourceName={{ singular: "customer", plural: "customers" }}
        itemCount={unifiedCustomers.length}
        selectable={false}
        headings={[
          { title: "Customer" },
          { title: "Contact Info" },
          { title: "Total Interactions" },
          { title: "" }, // Actions
        ]}
      >
        {unifiedCustomers.map((customer, index) => {
          const totalMsgs = customer.whatsappMsgs.length + customer.emailMsgs.length;
          const totalReps = customer.whatsappReplies.length + customer.emailReplies.length;

          return (
            <IndexTable.Row id={customer.id} key={customer.id} position={index}>
              <IndexTable.Cell>
                <InlineStack gap="300" blockAlign="center">
                  <Avatar customer size="md" name={customer.name} />
                  <Text variant="bodyMd" fontWeight="bold">{customer.name}</Text>
                </InlineStack>
              </IndexTable.Cell>
              
              <IndexTable.Cell>
                <BlockStack gap="100">
                  {customer.phone && <Text variant="bodySm" tone="subdued">📞 {customer.phone}</Text>}
                  {customer.email && <Text variant="bodySm" tone="subdued">✉️ {customer.email}</Text>}
                </BlockStack>
              </IndexTable.Cell>

              <IndexTable.Cell>
                <InlineStack gap="200">
                  <Badge tone="info" icon={ChatIcon}>{customer.whatsappMsgs.length + customer.whatsappReplies.length} WhatsApp</Badge>
                  <Badge tone="base" icon={EmailIcon}>{customer.emailMsgs.length + customer.emailReplies.length} Email</Badge>
                </InlineStack>
              </IndexTable.Cell>

              <IndexTable.Cell>
                <Button size="medium" variant="secondary" onClick={() => {
                  setSelectedCustomerId(customer.id);
                  setSelectedTab(0);
                }}>
                  View Hub
                </Button>
              </IndexTable.Cell>
            </IndexTable.Row>
          );
        })}
      </IndexTable>
    </Card>
  );

  // --- VIEW: DETAIL (CUSTOMER HUB) ---
  const renderDetailView = () => {
    if (!activeCustomer) return null;

    const tabs = [
      { id: 'wa-sent', content: `WhatsApp Sent (${activeCustomer.whatsappMsgs.length})` },
      { id: 'wa-rep', content: `WhatsApp Replies (${activeCustomer.whatsappReplies.length})` },
      { id: 'em-sent', content: `Email Sent (${activeCustomer.emailMsgs.length})` },
      { id: 'em-rep', content: `Email Replies (${activeCustomer.emailReplies.length})` },
    ];

    const renderNotificationTable = (notifs) => (
      <IndexTable
        resourceName={{ singular: "message", plural: "messages" }}
        itemCount={notifs.length}
        selectable={false}
        headings={[{ title: "Template" }, { title: "Status" }, { title: "Timestamp" }, { title: "Audit Trail" }]}
      >
        {notifs.map((notif, i) => (
          <IndexTable.Row id={notif.id} key={notif.id} position={i}>
            <IndexTable.Cell><Text fontWeight="medium">{notif.templateId || "Custom Text"}</Text></IndexTable.Cell>
            <IndexTable.Cell>{getStatusBadge(notif.status)}</IndexTable.Cell>
            <IndexTable.Cell>{formatDate(notif.createdAt)}</IndexTable.Cell>
            <IndexTable.Cell>
              <Button size="micro" icon={ViewIcon} onClick={() => {
                setSelectedNotification(notif);
                setIsModalOpen(true);
              }}>Log</Button>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
    );

    const renderReplyTable = (reps) => (
      <IndexTable
        resourceName={{ singular: "reply", plural: "replies" }}
        itemCount={reps.length}
        selectable={false}
        headings={[{ title: "Message Content" }, { title: "Timestamp" }]}
      >
        {reps.map((reply, i) => (
          <IndexTable.Row id={reply.id} key={reply.id} position={i}>
            <IndexTable.Cell>
              <Box maxWidth="400px"><Text truncate>{reply.messageBody}</Text></Box>
            </IndexTable.Cell>
            <IndexTable.Cell>{formatDate(reply.createdAt)}</IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
    );

    return (
      <BlockStack gap="500">
        <Button icon={ArrowLeftIcon} variant="plain" onClick={() => setSelectedCustomerId(null)}>
          Back to Directory
        </Button>

        <Layout>
          {/* LEFT COLUMN: Customer Profile Card */}
          <Layout.Section variant="oneThird">
            <Card background="bg-surface-secondary">
              <BlockStack gap="400" align="center">
                <Avatar customer size="xl" name={activeCustomer.name} />
                <BlockStack gap="100" inlineAlign="center">
                  <Text variant="headingLg" as="h2">{activeCustomer.name}</Text>
                  <Text tone="subdued">Customer ID: {activeCustomer.id.replace('guest_', '')}</Text>
                </BlockStack>
                <Divider />
                <BlockStack gap="200" inlineAlign="start">
                  {activeCustomer.phone && (
                    <InlineStack gap="200" wrap={false}>
                      <Icon source={ChatIcon} tone="base" />
                      <Text variant="bodyMd">{activeCustomer.phone}</Text>
                    </InlineStack>
                  )}
                  {activeCustomer.email && (
                    <InlineStack gap="200" wrap={false}>
                      <Icon source={EmailIcon} tone="base" />
                      <Text variant="bodyMd">{activeCustomer.email}</Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* RIGHT COLUMN: Message History Tabs */}
          <Layout.Section>
            <Card padding="0">
              <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
                {selectedTab === 0 && renderNotificationTable(activeCustomer.whatsappMsgs)}
                {selectedTab === 1 && renderReplyTable(activeCustomer.whatsappReplies)}
                {selectedTab === 2 && renderNotificationTable(activeCustomer.emailMsgs)}
                {selectedTab === 3 && renderReplyTable(activeCustomer.emailReplies)}
              </Tabs>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    );
  };

  return (
    <Page title="Omnichannel Communications Hub" fullWidth>
      <Layout>
        {/* KPI CARDS (Always Visible) */}
        <Layout.Section>
          <InlineStack gap="400" wrap={false} blockAlign="stretch">
            <KPI title="Total Delivered" value={statusCounts.DELIVERED || 0} tone="success" />
            <KPI title="Currently Pending" value={statusCounts.PENDING || 0} tone="warning" />
            <KPI title="Delivery Failures" value={statusCounts.FAILED || 0} tone="critical" />
            <KPI title="Total Replies" value={totalReplies || 0} tone="info" icon={AlertBubbleIcon} />
          </InlineStack>
        </Layout.Section>

        {/* DYNAMIC CONTENT */}
        <Layout.Section>
          {!selectedCustomerId ? renderMasterView() : renderDetailView()}
        </Layout.Section>
      </Layout>

      {/* EVENT TIMELINE MODAL */}
      <Modal open={isModalOpen} onClose={() => setIsModalOpen(false)} title="Audit Trail" size="large">
        <Modal.Section>
          {selectedNotification && (
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd">To: {selectedNotification.recipient}</Text>
                {getStatusBadge(selectedNotification.status)}
              </InlineStack>
              <Text tone="subdued">Template: {selectedNotification.templateId}</Text>
              <Divider />
              <Scrollable style={{ height: '300px' }}>
                <BlockStack gap="300">
                  {selectedNotification.events?.map((event) => (
                    <Card key={event.id} background="bg-surface-secondary">
                      <InlineStack align="space-between">
                        <Text variant="bodyMd" fontWeight="bold">
                          {event.eventType} {event.providerStatus ? `(${event.providerStatus})` : ''}
                        </Text>
                        <Text tone="subdued" variant="bodySm">{formatDate(event.receivedAt)}</Text>
                      </InlineStack>
                    </Card>
                  ))}
                </BlockStack>
              </Scrollable>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  );
}

// Internal Component: KPI Cards
function KPI({ title, value, tone = "base", icon }) {
  return (
    <div style={{ flex: 1 }}>
      <Card background={tone === "critical" ? "bg-surface-critical" : tone === "success" ? "bg-surface-success" : "bg-surface"}>
        <BlockStack gap="200">
          <InlineStack align="space-between">
             <Text tone="subdued" variant="headingSm" as="h3">{title}</Text>
             {icon && <Icon source={icon} tone={tone} />}
          </InlineStack>
          <Text variant="heading2xl" as="p">{value}</Text>
        </BlockStack>
      </Card>
    </div>
  );
}