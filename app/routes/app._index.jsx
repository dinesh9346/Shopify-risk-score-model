// import { useEffect } from "react";
// import { useFetcher } from "react-router";
// import { useAppBridge } from "@shopify/app-bridge-react";
// import { boundary } from "@shopify/shopify-app-react-router/server";
// import { authenticate } from "../shopify.server";

// export const loader = async ({ request }) => {
//   await authenticate.admin(request);

//   return null;
// };

// export const action = async ({ request }) => {
//   const { admin } = await authenticate.admin(request);
//   const color = ["Red", "Orange", "Yellow", "Green"][
//     Math.floor(Math.random() * 4)
//   ];
//   const response = await admin.graphql(
//     `#graphql
//       mutation populateProduct($product: ProductCreateInput!) {
//         productCreate(product: $product) {
//           product {
//             id
//             title
//             handle
//             status
//             variants(first: 10) {
//               edges {
//                 node {
//                   id
//                   price
//                   barcode
//                   createdAt
//                 }
//               }
//             }
//           }
//         }
//       }`,
//     {
//       variables: {
//         product: {
//           title: `${color} Snowboard`,
//         },
//       },
//     },
//   );
//   const responseJson = await response.json();
//   const product = responseJson.data.productCreate.product;
//   const variantId = product.variants.edges[0].node.id;
//   const variantResponse = await admin.graphql(
//     `#graphql
//     mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
//       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
//         productVariants {
//           id
//           price
//           barcode
//           createdAt
//         }
//       }
//     }`,
//     {
//       variables: {
//         productId: product.id,
//         variants: [{ id: variantId, price: "100.00" }],
//       },
//     },
//   );
//   const variantResponseJson = await variantResponse.json();

//   return {
//     product: responseJson.data.productCreate.product,
//     variant: variantResponseJson.data.productVariantsBulkUpdate.productVariants,
//   };
// };

// export default function Index() {
//   const fetcher = useFetcher();
//   const shopify = useAppBridge();
//   const isLoading =
//     ["loading", "submitting"].includes(fetcher.state) &&
//     fetcher.formMethod === "POST";

//   useEffect(() => {
//     if (fetcher.data?.product?.id) {
//       shopify.toast.show("Product created");
//     }
//   }, [fetcher.data?.product?.id, shopify]);
//   const generateProduct = () => fetcher.submit({}, { method: "POST" });

//   return (
//     <s-page heading="Shopify app template">
//       <s-button slot="primary-action" onClick={generateProduct}>
//         Generate a product
//       </s-button>

//       <s-section heading="Congrats on creating a new Shopify app 🎉">
//         <s-paragraph>
//           This embedded app template uses{" "}
//           <s-link
//             href="https://shopify.dev/docs/apps/tools/app-bridge"
//             target="_blank"
//           >
//             App Bridge
//           </s-link>{" "}
//           interface examples like an{" "}
//           <s-link href="/app/additional">additional page in the app nav</s-link>
//           , as well as an{" "}
//           <s-link
//             href="https://shopify.dev/docs/api/admin-graphql"
//             target="_blank"
//           >
//             Admin GraphQL
//           </s-link>{" "}
//           mutation demo, to provide a starting point for app development.
//         </s-paragraph>
//       </s-section>
//       <s-section heading="Get started with products">
//         <s-paragraph>
//           Generate a product with GraphQL and get the JSON output for that
//           product. Learn more about the{" "}
//           <s-link
//             href="https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate"
//             target="_blank"
//           >
//             productCreate
//           </s-link>{" "}
//           mutation in our API references.
//         </s-paragraph>
//         <s-stack direction="inline" gap="base">
//           <s-button
//             onClick={generateProduct}
//             {...(isLoading ? { loading: true } : {})}
//           >
//             Generate a product
//           </s-button>
//           {fetcher.data?.product && (
//             <s-button
//               onClick={() => {
//                 shopify.intents.invoke?.("edit:shopify/Product", {
//                   value: fetcher.data?.product?.id,
//                 });
//               }}
//               target="_blank"
//               variant="tertiary"
//             >
//               Edit product
//             </s-button>
//           )}
//         </s-stack>
//         {fetcher.data?.product && (
//           <s-section heading="productCreate mutation">
//             <s-stack direction="block" gap="base">
//               <s-box
//                 padding="base"
//                 borderWidth="base"
//                 borderRadius="base"
//                 background="subdued"
//               >
//                 <pre style={{ margin: 0 }}>
//                   <code>{JSON.stringify(fetcher.data.product, null, 2)}</code>
//                 </pre>
//               </s-box>

//               <s-heading>productVariantsBulkUpdate mutation</s-heading>
//               <s-box
//                 padding="base"
//                 borderWidth="base"
//                 borderRadius="base"
//                 background="subdued"
//               >
//                 <pre style={{ margin: 0 }}>
//                   <code>{JSON.stringify(fetcher.data.variant, null, 2)}</code>
//                 </pre>
//               </s-box>
//             </s-stack>
//           </s-section>
//         )}
//       </s-section>

//       <s-section slot="aside" heading="App template specs">
//         <s-paragraph>
//           <s-text>Framework: </s-text>
//           <s-link href="https://reactrouter.com/" target="_blank">
//             React Router
//           </s-link>
//         </s-paragraph>
//         <s-paragraph>
//           <s-text>Interface: </s-text>
//           <s-link
//             href="https://shopify.dev/docs/api/app-home/using-polaris-components"
//             target="_blank"
//           >
//             Polaris web components
//           </s-link>
//         </s-paragraph>
//         <s-paragraph>
//           <s-text>API: </s-text>
//           <s-link
//             href="https://shopify.dev/docs/api/admin-graphql"
//             target="_blank"
//           >
//             GraphQL
//           </s-link>
//         </s-paragraph>
//         <s-paragraph>
//           <s-text>Database: </s-text>
//           <s-link href="https://www.prisma.io/" target="_blank">
//             Prisma
//           </s-link>
//         </s-paragraph>
//       </s-section>

//       <s-section slot="aside" heading="Next steps">
//         <s-unordered-list>
//           <s-list-item>
//             Build an{" "}
//             <s-link
//               href="https://shopify.dev/docs/apps/getting-started/build-app-example"
//               target="_blank"
//             >
//               example app
//             </s-link>
//           </s-list-item>
//           <s-list-item>
//             Explore Shopify&apos;s API with{" "}
//             <s-link
//               href="https://shopify.dev/docs/apps/tools/graphiql-admin-api"
//               target="_blank"
//             >
//               GraphiQL
//             </s-link>
//           </s-list-item>
//         </s-unordered-list>
//       </s-section>
//     </s-page>
//   );
// }

// export const headers = (headersArgs) => {
//   return boundary.headers(headersArgs);
// };

// import { useEffect } from "react";
// import { useFetcher, useLoaderData } from "react-router";
// import { useAppBridge } from "@shopify/app-bridge-react";
// import { boundary } from "@shopify/shopify-app-react-router/server";
// import { authenticate } from "../shopify.server";

// // 🔹 Added imports for our database and sync engine
// import prisma from "../db.server";
// import { syncHistoricalOrders } from "../models/Sync.server";

// export const loader = async ({ request }) => {
//   const { admin, session } = await authenticate.admin(request);

//   // 🔹 1. Check if the local database is empty for this store
//   const orderCount = await prisma.storeOrder.count({
//     where: { shop: session.shop }
//   });

//   // 🔹 2. If it is empty, trigger the sync immediately!
//   if (orderCount === 0) {
//     console.log(`🚨 [Safety Net] Database is empty for ${session.shop}. Triggering force-sync...`);
    
//     // We do not 'await' this so the page still loads instantly for the user
//     syncHistoricalOrders(admin, session.shop).catch((err) => {
//       console.error("Force sync failed:", err);
//     });
//   } else {
//     console.log(`✅ [Status] Local DB is ready. Contains ${orderCount} orders.`);
//   }

//   return { orderCount };
// };

// export const action = async ({ request }) => {
//   const { admin } = await authenticate.admin(request);
//   const color = ["Red", "Orange", "Yellow", "Green"][
//     Math.floor(Math.random() * 4)
//   ];
//   const response = await admin.graphql(
//     `#graphql
//       mutation populateProduct($product: ProductCreateInput!) {
//         productCreate(product: $product) {
//           product {
//             id
//             title
//             handle
//             status
//             variants(first: 10) {
//               edges {
//                 node {
//                   id
//                   price
//                   barcode
//                   createdAt
//                 }
//               }
//             }
//           }
//         }
//       }`,
//     {
//       variables: {
//         product: {
//           title: `${color} Snowboard`,
//         },
//       },
//     },
//   );
//   const responseJson = await response.json();
//   const product = responseJson.data.productCreate.product;
//   const variantId = product.variants.edges[0].node.id;
//   const variantResponse = await admin.graphql(
//     `#graphql
//     mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
//       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
//         productVariants {
//           id
//           price
//           barcode
//           createdAt
//         }
//       }
//     }`,
//     {
//       variables: {
//         productId: product.id,
//         variants: [{ id: variantId, price: "100.00" }],
//       },
//     },
//   );
//   const variantResponseJson = await variantResponse.json();

//   return {
//     product: responseJson.data.productCreate.product,
//     variant: variantResponseJson.data.productVariantsBulkUpdate.productVariants,
//   };
// };

// export default function Index() {
//   const fetcher = useFetcher();
//   const shopify = useAppBridge();
//   const loaderData = useLoaderData(); // 🔹 Lets us access the orderCount from the loader

//   const isLoading =
//     ["loading", "submitting"].includes(fetcher.state) &&
//     fetcher.formMethod === "POST";

//   useEffect(() => {
//     if (fetcher.data?.product?.id) {
//       shopify.toast.show("Product created");
//     }
//   }, [fetcher.data?.product?.id, shopify]);
//   const generateProduct = () => fetcher.submit({}, { method: "POST" });

//   return (
//     <s-page heading="Shopify app template">
//       <s-button slot="primary-action" onClick={generateProduct}>
//         Generate a product
//       </s-button>

//       {/* 🔹 Added a small banner to show the merchant their sync status */}
//       <s-section heading="Zippyy Risk Engine Status">
//         <s-box padding="base" background="surface-success" borderRadius="base">
//            <s-text color="success">
//              Data Warehouse is currently holding <strong>{loaderData.orderCount}</strong> historical orders.
//            </s-text>
//         </s-box>
//       </s-section>

//       <s-section heading="Congrats on creating a new Shopify app 🎉">
//         <s-paragraph>
//           This embedded app template uses{" "}
//           <s-link
//             href="https://shopify.dev/docs/apps/tools/app-bridge"
//             target="_blank"
//           >
//             App Bridge
//           </s-link>{" "}
//           interface examples like an{" "}
//           <s-link href="/app/additional">additional page in the app nav</s-link>
//           , as well as an{" "}
//           <s-link
//             href="https://shopify.dev/docs/api/admin-graphql"
//             target="_blank"
//           >
//             Admin GraphQL
//           </s-link>{" "}
//           mutation demo, to provide a starting point for app development.
//         </s-paragraph>
//       </s-section>
//       <s-section heading="Get started with products">
//         <s-paragraph>
//           Generate a product with GraphQL and get the JSON output for that
//           product. Learn more about the{" "}
//           <s-link
//             href="https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate"
//             target="_blank"
//           >
//             productCreate
//           </s-link>{" "}
//           mutation in our API references.
//         </s-paragraph>
//         <s-stack direction="inline" gap="base">
//           <s-button
//             onClick={generateProduct}
//             {...(isLoading ? { loading: true } : {})}
//           >
//             Generate a product
//           </s-button>
//           {fetcher.data?.product && (
//             <s-button
//               onClick={() => {
//                 shopify.intents.invoke?.("edit:shopify/Product", {
//                   value: fetcher.data?.product?.id,
//                 });
//               }}
//               target="_blank"
//               variant="tertiary"
//             >
//               Edit product
//             </s-button>
//           )}
//         </s-stack>
//         {fetcher.data?.product && (
//           <s-section heading="productCreate mutation">
//             <s-stack direction="block" gap="base">
//               <s-box
//                 padding="base"
//                 borderWidth="base"
//                 borderRadius="base"
//                 background="subdued"
//               >
//                 <pre style={{ margin: 0 }}>
//                   <code>{JSON.stringify(fetcher.data.product, null, 2)}</code>
//                 </pre>
//               </s-box>

//               <s-heading>productVariantsBulkUpdate mutation</s-heading>
//               <s-box
//                 padding="base"
//                 borderWidth="base"
//                 borderRadius="base"
//                 background="subdued"
//               >
//                 <pre style={{ margin: 0 }}>
//                   <code>{JSON.stringify(fetcher.data.variant, null, 2)}</code>
//                 </pre>
//               </s-box>
//             </s-stack>
//           </s-section>
//         )}
//       </s-section>

//       <s-section slot="aside" heading="App template specs">
//         <s-paragraph>
//           <s-text>Framework: </s-text>
//           <s-link href="https://reactrouter.com/" target="_blank">
//             React Router
//           </s-link>
//         </s-paragraph>
//         <s-paragraph>
//           <s-text>Interface: </s-text>
//           <s-link
//             href="https://shopify.dev/docs/api/app-home/using-polaris-components"
//             target="_blank"
//           >
//             Polaris web components
//           </s-link>
//         </s-paragraph>
//         <s-paragraph>
//           <s-text>API: </s-text>
//           <s-link
//             href="https://shopify.dev/docs/api/admin-graphql"
//             target="_blank"
//           >
//             GraphQL
//           </s-link>
//         </s-paragraph>
//         <s-paragraph>
//           <s-text>Database: </s-text>
//           <s-link href="https://www.prisma.io/" target="_blank">
//             Prisma
//           </s-link>
//         </s-paragraph>
//       </s-section>

//       <s-section slot="aside" heading="Next steps">
//         <s-unordered-list>
//           <s-list-item>
//             Build an{" "}
//             <s-link
//               href="https://shopify.dev/docs/apps/getting-started/build-app-example"
//               target="_blank"
//             >
//               example app
//             </s-link>
//           </s-list-item>
//           <s-list-item>
//             Explore Shopify&apos;s API with{" "}
//             <s-link
//               href="https://shopify.dev/docs/apps/tools/graphiql-admin-api"
//               target="_blank"
//             >
//               GraphiQL
//             </s-link>
//           </s-list-item>
//         </s-unordered-list>
//       </s-section>
//     </s-page>
//   );
// }

// export const headers = (headersArgs) => {
//   return boundary.headers(headersArgs);
// };


import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

// 🔹 1. Import Polaris Styles & Translations
import "@shopify/polaris/build/esm/styles.css";
import enTranslations from "@shopify/polaris/locales/en.json";

import {
  AppProvider,
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  IndexTable,
  useIndexResourceState,
  Grid,
  Banner,
  Box
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncHistoricalOrders } from "../models/Sync.server";

// 🔹 2. ERROR-PROOF BACKEND LOADER
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    // 1. Initial Sync Logic
    const orderCount = await prisma.storeOrder.count({
      where: { shop: shop }
    });

    if (orderCount === 0) {
      console.log(`🚨 [Safety Net] Database is empty for ${shop}. Triggering force-sync...`);
      syncHistoricalOrders(admin, shop).catch(err => console.error(err));
    }

    // 2. Fetch Risk Scores
    const recentScores = await prisma.riskScore.findMany({
      where: { shop: shop },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // 3. SAFE SERIALIZATION: Prevent React Router from crashing on Date objects
    const safeScores = recentScores.map(score => ({
      ...score,
      createdAt: score.createdAt ? score.createdAt.toISOString() : null
    }));

    const highRiskCount = safeScores.filter(s => s.riskLevel === "HIGH").length;
    const mediumRiskCount = safeScores.filter(s => s.riskLevel === "MEDIUM").length;

    return Response.json({ 
      error: null, // No errors!
      orderCount,
      recentScores: safeScores, 
      kpis: { totalAnalyzed: safeScores.length, highRiskCount, mediumRiskCount } 
    });

  } catch (error) {
    // 🔥 IF ANYTHING CRASHES, IT SENDS THE ERROR TO THE UI INSTEAD OF BLANKING OUT
    console.error("Loader Error:", error);
    return Response.json({ 
      error: error.message, 
      orderCount: 0, 
      recentScores: [], 
      kpis: { totalAnalyzed: 0, highRiskCount: 0, mediumRiskCount: 0 } 
    });
  }
};

const RiskBadge = ({ level, score }) => {
  let tone = "success";
  let progress = "complete";

  if (level === "HIGH") {
    tone = "critical";
    progress = "incomplete";
  } else if (level === "MEDIUM") {
    tone = "warning";
    progress = "partiallyComplete";
  }

  return (
    <Badge tone={tone} progress={progress}>
      {level} ({score} pts)
    </Badge>
  );
};

// 🔹 3. FRONTEND DASHBOARD
function DashboardUI() {
  const data = useLoaderData();

  // 🚨 Did the backend crash? Show the error banner safely!
  if (data.error) {
    return (
      <Page title="System Error">
        <Layout>
          <Layout.Section>
            <Banner tone="critical" title="Backend Error Detected">
              <p><strong>Message:</strong> {data.error}</p>
              <p>Check your VS Code terminal for more details. (Usually, this means a database column is missing or Prisma needs to be synced).</p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // If no errors, render the dashboard normally
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(data.recentScores);

  const rowMarkup = data.recentScores.map(
    ({ id, orderId, orderValue, paymentType, riskLevel, score, reasons }, index) => {
      const cleanOrderId = orderId.includes('/') ? orderId.split('/').pop() : orderId;

      return (
        <IndexTable.Row id={id} key={id} selected={selectedResources.includes(id)} position={index}>
          <IndexTable.Cell>
            <Text variant="bodyMd" fontWeight="bold" as="span">#{cleanOrderId}</Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" numeric>${orderValue.toFixed(2)}</Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Badge tone="info">{paymentType}</Badge>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <RiskBadge level={riskLevel} score={score} />
          </IndexTable.Cell>
          <IndexTable.Cell>
             <Text variant="bodySm" as="span" tone="subdued">{reasons}</Text>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }
  );

  return (
    <Page title="Zippyy Risk Engine" subtitle="Real-time fraud analysis and prevention">
      <Layout>
        <Layout.Section>
          <Banner tone="info">
            <p>Your Data Warehouse is synced and actively monitoring <strong>{data.orderCount}</strong> historical orders.</p>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Grid>
            <Grid.Cell columnSpan={{xs: 6, sm: 4, md: 4, lg: 4, xl: 4}}>
              <Card background="bg-surface-secondary">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="subdued">Recent Orders Assessed</Text>
                  <Text as="p" variant="headingXl">{data.kpis.totalAnalyzed}</Text>
                </BlockStack>
              </Card>
            </Grid.Cell>
            
            <Grid.Cell columnSpan={{xs: 6, sm: 4, md: 4, lg: 4, xl: 4}}>
              <Card background="bg-surface-critical-subdued">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="critical">High Risk Intercepted</Text>
                  <Text as="p" variant="headingXl" tone="critical">{data.kpis.highRiskCount}</Text>
                </BlockStack>
              </Card>
            </Grid.Cell>

            <Grid.Cell columnSpan={{xs: 6, sm: 4, md: 4, lg: 4, xl: 4}}>
              <Card background="bg-surface-warning-subdued">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="caution">Medium Risk Flagged</Text>
                  <Text as="p" variant="headingXl" tone="caution">{data.kpis.mediumRiskCount}</Text>
                </BlockStack>
              </Card>
            </Grid.Cell>
          </Grid>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Actionable Intelligence Log</Text>
              </InlineStack>
            </Box>
            
            <IndexTable
              resourceName={{ singular: 'order assessment', plural: 'order assessments' }}
              itemCount={data.recentScores.length}
              selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: 'Order ID' },
                { title: 'Value' },
                { title: 'Payment Method' },
                { title: 'Risk Score' },
                { title: 'Reasons' },
              ]}
              emptyState={
                <Box padding="400">
                  <Text alignment="center" tone="subdued">No risk scores generated yet. Waiting for new orders...</Text>
                </Box>
              }
            >
              {rowMarkup}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// 🔹 4. PARENT WRAPPER
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