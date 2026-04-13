// import { useLoaderData } from "react-router";
// import {
//   Page,
//   Layout,
//   Card,
//   Text,
//   Badge,
//   IndexTable,
//   useIndexResourceState,
//   BlockStack,
//   InlineStack,
//   Button,
//   Icon,
//   Modal,
//   Scrollable,
//   Divider,
// } from "@shopify/polaris";
// import {
//   ChatIcon,
//   EmailIcon,
//   ViewIcon,
//   AlertBubbleIcon,
// } from "@shopify/polaris-icons";
// import { useState } from "react";

// // Replace with your actual Prisma client and auth imports
// import prisma from "../db.server"; 
// import { authenticate } from "../shopify.server";

// // --- 1. BACKEND: Fetching the Data ---
// export async function loader({ request }) {
//   const { session } = await authenticate.admin(request);
//   const shop = session.shop;

//   // Fetch KPI Stats
//   const stats = await prisma.notification.groupBy({
//     by: ['status'],
//     where: { shop },
//     _count: { status: true },
//   });

//   const statusCounts = {
//     SENT: 0, DELIVERED: 0, FAILED: 0, PENDING: 0,
//   };
  
//   stats.forEach(stat => {
//     statusCounts[stat.status] = stat._count.status;
//   });

//   const totalReplies = await prisma.customerReply.count({
//     where: { shop },
//   });

//   // Fetch recent notifications with their events
//   const notifications = await prisma.notification.findMany({
//     where: { shop },
//     orderBy: { createdAt: 'desc' },
//     take: 50,
//     include: {
//       events: {
//         orderBy: { receivedAt: 'desc' },
//       },
//     },
//   });

//   // Fetch replies to map them to the UI
//   const replies = await prisma.customerReply.findMany({
//     where: { shop },
//     orderBy: { createdAt: 'desc' },
//     take: 50,
//   });

//   // UPDATED: Using the standard web Response API instead of @remix-run/node json()
//   return Response.json({ notifications, statusCounts, totalReplies, replies });
// }

// // --- 2. FRONTEND: Premium UI Components ---
// export default function NotificationTracker() {
//   const { notifications, statusCounts, totalReplies, replies } = useLoaderData();
//   const [selectedNotification, setSelectedNotification] = useState(null);
//   const [isModalOpen, setIsModalOpen] = useState(false);

//   const { selectedResources, allResourcesSelected, handleSelectionChange } =
//     useIndexResourceState(notifications);

//   // Helper to format dates
//   const formatDate = (dateString) => {
//     return new Date(dateString).toLocaleString("en-IN", {
//       month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
//     });
//   };

//   // Helper for Status Badges
//   const getStatusBadge = (status) => {
//     switch (status) {
//       case "DELIVERED": return <Badge tone="success">Delivered</Badge>;
//       case "FAILED": return <Badge tone="critical">Failed</Badge>;
//       case "SENT": return <Badge tone="info">Sent</Badge>;
//       case "PENDING": return <Badge tone="warning">Pending</Badge>;
//       default: return <Badge>{status}</Badge>;
//     }
//   };

//   const handleRowClick = (notification) => {
//     setSelectedNotification(notification);
//     setIsModalOpen(true);
//   };

//   const rowMarkup = notifications.map(
//     ({ id, channel, recipient, templateId, status, createdAt }, index) => (
//       <IndexTable.Row
//         id={id}
//         key={id}
//         selected={selectedResources.includes(id)}
//         position={index}
//       >
//         <IndexTable.Cell>
//           <InlineStack gap="200" align="start">
//             <Icon source={channel === "WHATSAPP" ? ChatIcon : EmailIcon} tone={channel === "WHATSAPP" ? "success" : "base"} />
//             <Text variant="bodyMd" fontWeight="bold" as="span">
//               {channel}
//             </Text>
//           </InlineStack>
//         </IndexTable.Cell>
//         <IndexTable.Cell>{recipient}</IndexTable.Cell>
//         <IndexTable.Cell>
//           <Text variant="bodySm" tone="subdued">{templateId || "Custom Text"}</Text>
//         </IndexTable.Cell>
//         <IndexTable.Cell>{getStatusBadge(status)}</IndexTable.Cell>
//         <IndexTable.Cell>{formatDate(createdAt)}</IndexTable.Cell>
//         <IndexTable.Cell>
//           <Button size="micro" icon={ViewIcon} onClick={() => handleRowClick(notifications[index])}>
//             View Log
//           </Button>
//         </IndexTable.Cell>
//       </IndexTable.Row>
//     )
//   );

//   return (
//     <Page title="Communication Command Center" fullWidth>
//       <Layout>
//         {/* KPI CARDS SECTION */}
//         <Layout.Section>
//           <InlineStack gap="400" wrap={false} blockAlign="stretch">
//             <KPI Card title="Total Delivered" value={statusCounts.DELIVERED || 0} tone="success" />
//             <KPI Card title="Currently Pending" value={statusCounts.PENDING || 0} tone="warning" />
//             <KPI Card title="Delivery Failures" value={statusCounts.FAILED || 0} tone="critical" />
//             <KPI Card title="Customer Replies" value={totalReplies || 0} tone="info" icon={AlertBubbleIcon} />
//           </InlineStack>
//         </Layout.Section>

//         {/* MAIN DATA TABLE */}
//         <Layout.Section>
//           <Card padding="0">
//             <IndexTable
//               resourceName={{ singular: "notification", plural: "notifications" }}
//               itemCount={notifications.length}
//               selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
//               onSelectionChange={handleSelectionChange}
//               headings={[
//                 { title: "Channel" },
//                 { title: "Recipient" },
//                 { title: "Template / Campaign" },
//                 { title: "Status" },
//                 { title: "Timestamp" },
//                 { title: "Actions" },
//               ]}
//             >
//               {rowMarkup}
//             </IndexTable>
//           </Card>
//         </Layout.Section>
//       </Layout>

//       {/* EVENT TIMELINE MODAL */}
//       <Modal
//         open={isModalOpen}
//         onClose={() => setIsModalOpen(false)}
//         title="Message Audit Trail"
//         size="large"
//       >
//         <Modal.Section>
//           {selectedNotification && (
//             <BlockStack gap="400">
//               <InlineStack align="space-between">
//                 <Text variant="headingMd" as="h3">
//                   To: {selectedNotification.recipient}
//                 </Text>
//                 {getStatusBadge(selectedNotification.status)}
//               </InlineStack>
//               <Text tone="subdued">Template: {selectedNotification.templateId}</Text>
              
//               <Divider />

//               <Text variant="headingSm" as="h4">Event Timeline</Text>
//               <Scrollable style={{ height: '300px' }}>
//                 <BlockStack gap="300">
//                   {selectedNotification.events.map((event) => (
//                     <Card key={event.id} background="bg-surface-secondary">
//                       <InlineStack align="space-between">
//                         <Text variant="bodyMd" fontWeight="bold">
//                           {event.eventType} {event.providerStatus ? `(${event.providerStatus})` : ''}
//                         </Text>
//                         <Text tone="subdued" variant="bodySm">
//                           {formatDate(event.receivedAt)}
//                         </Text>
//                       </InlineStack>
//                       {/* Show raw payload snippet for debugging */}
//                       <Text variant="bodySm" tone="subdued" as="p">
//                         <pre style={{ margin: 0, fontSize: '11px', whiteSpace: 'pre-wrap' }}>
//                           {JSON.stringify(event.payload, null, 2)}
//                         </pre>
//                       </Text>
//                     </Card>
//                   ))}
//                   {selectedNotification.events.length === 0 && (
//                     <Text tone="subdued">No webhook events received from provider yet.</Text>
//                   )}
//                 </BlockStack>
//               </Scrollable>
//             </BlockStack>
//           )}
//         </Modal.Section>
//       </Modal>
//     </Page>
//   );
// }

// // Simple internal component for the KPI Cards
// function KPI({ title, value, tone = "base", icon }) {
//   return (
//     <div style={{ flex: 1 }}>
//       <Card background={tone === "critical" ? "bg-surface-critical" : tone === "success" ? "bg-surface-success" : "bg-surface"}>
//         <BlockStack gap="200">
//           <InlineStack align="space-between">
//              <Text tone="subdued" variant="headingSm" as="h3">{title}</Text>
//              {icon && <Icon source={icon} tone={tone} />}
//           </InlineStack>
//           <Text variant="heading2xl" as="p">
//             {value}
//           </Text>
//         </BlockStack>
//       </Card>
//     </div>
//   );
// }

import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  IndexTable,
  useIndexResourceState,
  BlockStack,
  InlineStack,
  Button,
  Icon,
  Modal,
  Scrollable,
  Divider,
  Tabs,
} from "@shopify/polaris";
import {
  ChatIcon,
  EmailIcon,
  ViewIcon,
  AlertBubbleIcon,
  ArrowLeftIcon,
} from "@shopify/polaris-icons";
import { useState, useMemo } from "react";

// Replace with your actual Prisma client and auth imports
import prisma from "../db.server"; 
import { authenticate } from "../shopify.server";

// --- 1. BACKEND: Fetching the Data ---
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Fetch KPI Stats
  const stats = await prisma.notification.groupBy({
    by: ['status'],
    where: { shop },
    _count: { status: true },
  });

  const statusCounts = {
    SENT: 0, DELIVERED: 0, FAILED: 0, PENDING: 0,
  };
  
  stats.forEach(stat => {
    statusCounts[stat.status] = stat._count.status;
  });

  const totalReplies = await prisma.customerReply.count({
    where: { shop },
  });

  // Fetch recent notifications with their events
  const notifications = await prisma.notification.findMany({
    where: { shop },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      events: {
        orderBy: { receivedAt: 'desc' },
      },
    },
  });

  // Fetch replies
  const replies = await prisma.customerReply.findMany({
    where: { shop },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return Response.json({ notifications, statusCounts, totalReplies, replies });
}

// --- 2. FRONTEND: Premium UI Components ---
export default function NotificationTracker() {
  const { notifications, statusCounts, totalReplies, replies } = useLoaderData();
  
  // States for Master/Detail View
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [selectedTab, setSelectedTab] = useState(0);
  
  // States for the Event Timeline Modal
  const [selectedNotification, setSelectedNotification] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Extract unique customers/recipients for the Master View
  const uniqueCustomers = useMemo(() => {
    const recipients = new Set();
    notifications.forEach(n => recipients.add(n.recipient));
    // If replies have a different identifier, you might need to add them here too
    return Array.from(recipients).map(recipient => {
      return {
        recipient,
        totalMessages: notifications.filter(n => n.recipient === recipient).length
      };
    });
  }, [notifications]);

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(notifications);

  // Helper to format dates
  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString("en-IN", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  };

  // Helper for Status Badges
  const getStatusBadge = (status) => {
    switch (status) {
      case "DELIVERED": return <Badge tone="success">Delivered</Badge>;
      case "FAILED": return <Badge tone="critical">Failed</Badge>;
      case "SENT": return <Badge tone="info">Sent</Badge>;
      case "PENDING": return <Badge tone="warning">Pending</Badge>;
      default: return <Badge>{status}</Badge>;
    }
  };

  const handleOpenTimeline = (notification) => {
    setSelectedNotification(notification);
    setIsModalOpen(true);
  };

  // TABS CONFIGURATION
  const tabs = [
    { id: 'whatsapp-messages', content: 'WhatsApp Messages' },
    { id: 'whatsapp-replies', content: 'Replies from WhatsApp' },
    { id: 'email-messages', content: 'Email' },
    { id: 'email-replies', content: 'Replies from Email' },
  ];

  // --- RENDER HELPERS ---
  
  // Render the Master View (List of Customers)
  const renderMasterView = () => (
    <Card padding="0">
      <IndexTable
        resourceName={{ singular: "customer", plural: "customers" }}
        itemCount={uniqueCustomers.length}
        headings={[
          { title: "Customer / Recipient" },
          { title: "Total App Messages" },
          { title: "Actions" },
        ]}
        selectable={false}
      >
        {uniqueCustomers.map(({ recipient, totalMessages }, index) => (
          <IndexTable.Row id={recipient} key={recipient} position={index}>
            <IndexTable.Cell>
              <Text variant="bodyMd" fontWeight="bold" as="span">
                {recipient}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>{totalMessages}</IndexTable.Cell>
            <IndexTable.Cell>
              <Button size="micro" onClick={() => {
                setSelectedCustomer(recipient);
                setSelectedTab(0); // Reset to first tab on open
              }}>
                View History
              </Button>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
    </Card>
  );

  // Render the Detail View (Tabs and Messages for the selected customer)
  const renderDetailView = () => {
    // Filter data for the selected customer
    const customerNotifications = notifications.filter(n => n.recipient === selectedCustomer);
    // Note: Adjust 'customerNumber' or 'sender' below based on your actual Prisma Schema for CustomerReply
    const customerReplies = replies.filter(r => r.recipient === selectedCustomer || r.customerPhone === selectedCustomer);

    const whatsappSent = customerNotifications.filter(n => n.channel === "WHATSAPP");
    const emailSent = customerNotifications.filter(n => n.channel === "EMAIL");
    
    // Assuming you have a way to distinguish channel in replies. Adjust if needed.
    const whatsappReplies = customerReplies.filter(r => r.channel === "WHATSAPP" || !r.channel); 
    const emailReplies = customerReplies.filter(r => r.channel === "EMAIL");

    const renderNotificationRows = (notifs) => notifs.map((notif, index) => (
      <IndexTable.Row id={notif.id} key={notif.id} position={index}>
        <IndexTable.Cell>
          <InlineStack gap="200" align="start">
            <Icon source={notif.channel === "WHATSAPP" ? ChatIcon : EmailIcon} tone={notif.channel === "WHATSAPP" ? "success" : "base"} />
            <Text variant="bodyMd" fontWeight="bold" as="span">{notif.channel}</Text>
          </InlineStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text variant="bodySm" tone="subdued">{notif.templateId || "Custom Text"}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{getStatusBadge(notif.status)}</IndexTable.Cell>
        <IndexTable.Cell>{formatDate(notif.createdAt)}</IndexTable.Cell>
        <IndexTable.Cell>
          <Button size="micro" icon={ViewIcon} onClick={() => handleOpenTimeline(notif)}>
            View Log
          </Button>
        </IndexTable.Cell>
      </IndexTable.Row>
    ));

    const renderReplyRows = (reps) => reps.map((reply, index) => (
      <IndexTable.Row id={reply.id} key={reply.id} position={index}>
        <IndexTable.Cell><Text fontWeight="bold">Customer</Text></IndexTable.Cell>
        <IndexTable.Cell>{reply.messageBody || "View Message"}</IndexTable.Cell>
        <IndexTable.Cell>{formatDate(reply.createdAt)}</IndexTable.Cell>
      </IndexTable.Row>
    ));

    return (
      <BlockStack gap="400">
        <InlineStack>
          <Button icon={ArrowLeftIcon} variant="plain" onClick={() => setSelectedCustomer(null)}>
            Back to Customer List
          </Button>
        </InlineStack>
        
        <Text variant="headingLg" as="h2">History for: {selectedCustomer}</Text>

        <Card padding="0">
          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
            {/* TAB 0: WHATSAPP MESSAGES */}
            {selectedTab === 0 && (
              <IndexTable
                resourceName={{ singular: "message", plural: "messages" }}
                itemCount={whatsappSent.length}
                selectable={false}
                headings={[{ title: "Channel" }, { title: "Template" }, { title: "Status" }, { title: "Timestamp" }, { title: "Actions" }]}
              >
                {renderNotificationRows(whatsappSent)}
              </IndexTable>
            )}

            {/* TAB 1: WHATSAPP REPLIES */}
            {selectedTab === 1 && (
              <IndexTable
                resourceName={{ singular: "reply", plural: "replies" }}
                itemCount={whatsappReplies.length}
                selectable={false}
                headings={[{ title: "Sender" }, { title: "Message" }, { title: "Timestamp" }]}
              >
                {renderReplyRows(whatsappReplies)}
              </IndexTable>
            )}

            {/* TAB 2: EMAIL MESSAGES */}
            {selectedTab === 2 && (
              <IndexTable
                resourceName={{ singular: "email", plural: "emails" }}
                itemCount={emailSent.length}
                selectable={false}
                headings={[{ title: "Channel" }, { title: "Campaign" }, { title: "Status" }, { title: "Timestamp" }, { title: "Actions" }]}
              >
                {renderNotificationRows(emailSent)}
              </IndexTable>
            )}

            {/* TAB 3: EMAIL REPLIES */}
            {selectedTab === 3 && (
              <IndexTable
                resourceName={{ singular: "reply", plural: "replies" }}
                itemCount={emailReplies.length}
                selectable={false}
                headings={[{ title: "Sender" }, { title: "Message" }, { title: "Timestamp" }]}
              >
                {renderReplyRows(emailReplies)}
              </IndexTable>
            )}
          </Tabs>
        </Card>
      </BlockStack>
    );
  };

  return (
    <Page title="Communication Command Center" fullWidth>
      <Layout>
        {/* KPI CARDS SECTION (Always Visible) */}
        <Layout.Section>
          <InlineStack gap="400" wrap={false} blockAlign="stretch">
            <KPI title="Total Delivered" value={statusCounts.DELIVERED || 0} tone="success" />
            <KPI title="Currently Pending" value={statusCounts.PENDING || 0} tone="warning" />
            <KPI title="Delivery Failures" value={statusCounts.FAILED || 0} tone="critical" />
            <KPI title="Customer Replies" value={totalReplies || 0} tone="info" icon={AlertBubbleIcon} />
          </InlineStack>
        </Layout.Section>

        {/* DYNAMIC SECTION (Master vs Detail) */}
        <Layout.Section>
          {!selectedCustomer ? renderMasterView() : renderDetailView()}
        </Layout.Section>
      </Layout>

      {/* EVENT TIMELINE MODAL */}
      <Modal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Message Audit Trail"
        size="large"
      >
        <Modal.Section>
          {selectedNotification && (
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h3">
                  To: {selectedNotification.recipient}
                </Text>
                {getStatusBadge(selectedNotification.status)}
              </InlineStack>
              <Text tone="subdued">Template: {selectedNotification.templateId}</Text>
              
              <Divider />

              <Text variant="headingSm" as="h4">Event Timeline</Text>
              <Scrollable style={{ height: '300px' }}>
                <BlockStack gap="300">
                  {selectedNotification.events.map((event) => (
                    <Card key={event.id} background="bg-surface-secondary">
                      <InlineStack align="space-between">
                        <Text variant="bodyMd" fontWeight="bold">
                          {event.eventType} {event.providerStatus ? `(${event.providerStatus})` : ''}
                        </Text>
                        <Text tone="subdued" variant="bodySm">
                          {formatDate(event.receivedAt)}
                        </Text>
                      </InlineStack>
                      <Text variant="bodySm" tone="subdued" as="p">
                        <pre style={{ margin: 0, fontSize: '11px', whiteSpace: 'pre-wrap' }}>
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      </Text>
                    </Card>
                  ))}
                  {selectedNotification.events.length === 0 && (
                    <Text tone="subdued">No webhook events received from provider yet.</Text>
                  )}
                </BlockStack>
              </Scrollable>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  );
}

// Simple internal component for the KPI Cards
function KPI({ title, value, tone = "base", icon }) {
  return (
    <div style={{ flex: 1 }}>
      <Card background={tone === "critical" ? "bg-surface-critical" : tone === "success" ? "bg-surface-success" : "bg-surface"}>
        <BlockStack gap="200">
          <InlineStack align="space-between">
             <Text tone="subdued" variant="headingSm" as="h3">{title}</Text>
             {icon && <Icon source={icon} tone={tone} />}
          </InlineStack>
          <Text variant="heading2xl" as="p">
            {value}
          </Text>
        </BlockStack>
      </Card>
    </div>
  );
}