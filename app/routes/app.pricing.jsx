// import { Page, Layout, Card, Text, Button, BlockStack, Box } from "@shopify/polaris";
// import { Form, useLoaderData } from "react-router";
// import { authenticate, MONTHLY_PLAN } from "../shopify.server";

// // --- LOADER: Check if the user is already subscribed ---
// export const loader = async ({ request }) => {
//   const { billing } = await authenticate.admin(request);
  
//   // Check if they have an active payment for our specific plan
//   const { hasActivePayment, appSubscriptions } = await billing.check({
//     plans: [MONTHLY_PLAN],
//     isTest: true, // Keep true for development!
//   });

//   return { 
//     hasActivePayment, 
//     // If they have an active sub, get its ID so we can cancel it if needed
//     subscriptionId: appSubscriptions?.[0]?.id || null 
//   };
// };

// // --- ACTION: Handle Subscribe and Cancel button clicks ---
// export const action = async ({ request }) => {
//   const { billing } = await authenticate.admin(request);
//   const formData = await request.formData();
//   const intent = formData.get("intent");

//   if (intent === "subscribe") {
//     // Redirects to Shopify's secure approval screen
//     await billing.require({
//       plans: [MONTHLY_PLAN],
//       isTest: true, // Keep true for development!
//       onFailure: async () => billing.request({
//         plan: MONTHLY_PLAN,
//         isTest: true,
//         returnUrl: `https://${new URL(request.url).host}/app`, 
//       }),
//     });
//   } 
  
//   if (intent === "cancel") {
//     // Cancels the subscription and reloads the page
//     const subscriptionId = formData.get("subscriptionId");
//     if (subscriptionId) {
//       await billing.cancel({
//         subscriptionId: String(subscriptionId),
//         isTest: true,
//         prorate: true,
//       });
//     }
//   }

//   return null;
// };

// // --- UI: The visual pricing page ---
// export default function PricingPage() {
//   const { hasActivePayment, subscriptionId } = useLoaderData();

//   return (
//     <Page title="Pricing Plans">
//       <Layout>
//         <Layout.Section>
//           <Card>
//             <BlockStack gap="400">
//               <Text as="h2" variant="headingLg">Zippyy Pro Plan</Text>
//               <Text as="p" variant="heading3xl">₹999 / month</Text>
//               <Text as="p" tone="subdued">
//                 Unlock unlimited buyer profiles, advanced risk scoring, and priority support.
//               </Text>
              
//               <Box paddingBlockStart="200">
//                 {hasActivePayment ? (
//                   <BlockStack gap="300" inlineAlign="start">
//                     <Text as="p" tone="success">You are currently subscribed to this plan.</Text>
//                     <Form method="post">
//                       <input type="hidden" name="intent" value="cancel" />
//                       <input type="hidden" name="subscriptionId" value={subscriptionId} />
//                       <Button submit tone="critical">Cancel Subscription</Button>
//                     </Form>
//                   </BlockStack>
//                 ) : (
//                   <Form method="post">
//                     <input type="hidden" name="intent" value="subscribe" />
//                     <Button submit primary>Subscribe to Pro</Button>
//                   </Form>
//                 )}
//               </Box>
//             </BlockStack>
//           </Card>
//         </Layout.Section>
//       </Layout>
//     </Page>
//   );
// }

import { Page, Layout, Card, Text, Button, BlockStack, Box, Banner } from "@shopify/polaris";
import { Form, useLoaderData, useNavigation, useActionData } from "react-router";
import { useEffect } from "react";
import { authenticate, MONTHLY_PLAN } from "../shopify.server";

// --- LOADER: Check if the user is already subscribed ---
export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [MONTHLY_PLAN],
    isTest: true, 
  });

  return { 
    hasActivePayment, 
    subscriptionId: appSubscriptions?.[0]?.id || null 
  };
};

// --- ACTION: Handle Subscribe and Cancel button clicks ---
export const action = async ({ request }) => {
  const { admin, billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "subscribe") {
    const appUrl = (process.env.SHOPIFY_APP_URL || `https://${new URL(request.url).host}`).replace(/\/$/, "");

    // 1. We use the raw GraphQL that we KNOW worked from your diagnostic test
    const response = await admin.graphql(`
      mutation {
        appSubscriptionCreate(
          name: "${MONTHLY_PLAN}",
          returnUrl: "${appUrl}/app",
          test: true,
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: 999, currencyCode: INR }
                interval: EVERY_30_DAYS
              }
            }
          }]
        ) {
          userErrors { field message }
          confirmationUrl
        }
      }
    `);

    const data = await response.json();
    const confirmationUrl = data.data?.appSubscriptionCreate?.confirmationUrl;
    
    // 2. We return the URL back to the frontend as raw data (No background redirects!)
    if (confirmationUrl) {
      return { redirectUrl: confirmationUrl };
    }
    
    return { error: "Shopify failed to generate the billing link." };
  } 
  
  if (intent === "cancel") {
    const subscriptionId = formData.get("subscriptionId");
    if (subscriptionId) {
      await billing.cancel({
        subscriptionId: String(subscriptionId),
        isTest: true,
        prorate: true,
      });
      return { canceled: true };
    }
  }

  return null;
};

// --- UI: The visual pricing page ---
export default function PricingPage() {
  const { hasActivePayment, subscriptionId } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  
  const isSubscribing = navigation.state === "submitting" && navigation.formData?.get("intent") === "subscribe";

  
  useEffect(() => {
    if (actionData?.redirectUrl) {
    
      window.open(actionData.redirectUrl, "_top");
    }
  }, [actionData]);

  return (
    <Page title="Pricing Plans">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingLg">Zippyy Pro Plan</Text>
              <Text as="p" variant="heading3xl">₹999 / month</Text>
              <Text as="p" tone="subdued">
                Unlock unlimited buyer profiles, advanced risk scoring, and priority support.
              </Text>
              
              {actionData?.error && (
                <Banner tone="critical">{actionData.error}</Banner>
              )}

              <Box paddingBlockStart="200">
                {hasActivePayment ? (
                  <BlockStack gap="300" inlineAlign="start">
                    <Text as="p" tone="success">You are currently subscribed to this plan.</Text>
                    <Form method="post">
                      <input type="hidden" name="intent" value="cancel" />
                      <input type="hidden" name="subscriptionId" value={subscriptionId} />
                      <Button submit tone="critical">Cancel Subscription</Button>
                    </Form>
                  </BlockStack>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="subscribe" />
                    <Button submit primary loading={isSubscribing}>
                      Subscribe to Pro
                    </Button>
                  </Form>
                )}
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}