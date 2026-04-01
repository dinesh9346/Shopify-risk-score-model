import {
  Page,
  Card,
  Text,
  Button,
  BlockStack,
  Box,
  Banner,
  InlineStack,
  Badge,
  Divider,
} from "@shopify/polaris";
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
    subscriptionId: appSubscriptions?.[0]?.id || null,
  };
};

// --- ACTION: Handle Subscribe and Cancel button clicks ---
export const action = async ({ request }) => {
  const { admin, billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "subscribe") {
    const appUrl = (
      process.env.SHOPIFY_APP_URL || `https://${new URL(request.url).host}`
    ).replace(/\/$/, "");

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

// --- UI: Rectangle card layout (Free + Pro) ---
export default function PricingPage() {
  const { hasActivePayment, subscriptionId } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubscribing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "subscribe";

  useEffect(() => {
    if (actionData?.redirectUrl) {
      window.open(actionData.redirectUrl, "_top");
    }
  }, [actionData]);

  const freeFeatures = [
    "Basic risk score",
    "Manual buyer review",
    "Limited buyer profiles",
    "Standard support",
    "Single store",
    "Basic reports",
  ];

  const proFeatures = [
    "Unlimited buyer profiles",
    "Advanced risk scoring",
    "Automated fraud signals",
    "Priority support + onboarding",
    "Live behavior monitoring",
    "Instant chargeback alerts",
  ];

  return (
    <Page title="Select a plan" fullWidth>
      <BlockStack gap="500">
        {/* Embedded styling for black rectangular buttons */}
        <style>{`
          .zippyyPlanButton.Polaris-Button {
            background: #1f2937;
            border: 1px solid #111827;
            border-radius: 10px;
            height: 40px;
            box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
          }
          .zippyyPlanButton.Polaris-Button:hover {
            background: #111827;
          }
          .zippyyPlanButton.Polaris-Button:active {
            background: #0b0f19;
          }
          .zippyyPlanButton .Polaris-Button__Text {
            color: #ffffff;
            font-weight: 600;
          }

          .zippyyPlanButtonSecondary.Polaris-Button {
            background: #ffffff;
            border: 1px solid #d1d5db;
            border-radius: 10px;
            height: 40px;
          }
          .zippyyPlanButtonSecondary.Polaris-Button:hover {
            background: #f9fafb;
          }
          .zippyyPlanButtonSecondary .Polaris-Button__Text {
            color: #111827;
            font-weight: 600;
          }
        `}</style>

        <BlockStack gap="200">
          <Text as="h1" variant="heading2xl">
            Select a plan
          </Text>
          <Text as="p" tone="subdued">
            Choose the plan that fits your store today. Upgrade anytime.
          </Text>
        </BlockStack>

        {actionData?.error && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}

        <Box
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "16px",
          }}
        >
          {/* Free Card */}
          <Card padding="500">
            <BlockStack gap="400">
              <Text as="p" tone="subdued">
                Starter
              </Text>
              <Text as="h2" variant="headingLg">
                Free
              </Text>

              <Divider />

              <BlockStack gap="200">
                {freeFeatures.map((item) => (
                  <Text key={item} as="span" tone="subdued">
                    • {item}
                  </Text>
                ))}
              </BlockStack>

              <Box paddingBlockStart="300">
                {hasActivePayment ? (
                  <Button fullWidth disabled className="zippyyPlanButtonSecondary">
                    Available after canceling Pro
                  </Button>
                ) : (
                  <Button fullWidth className="zippyyPlanButton">
                    Select
                  </Button>
                )}
              </Box>
            </BlockStack>
          </Card>

          {/* Pro Card */}
          <Card padding="500">
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="success">Most Popular</Badge>
              </InlineStack>

              <Text as="p" tone="subdued">
                Pro
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" variant="headingLg">
                  ₹999
                </Text>
                <Text as="span" tone="subdued">
                  / month
                </Text>
              </InlineStack>
              <Text as="p" tone="subdued">
                Premium protection and automation for serious stores.
              </Text>

              <Divider />

              <BlockStack gap="200">
                {proFeatures.map((item) => (
                  <Text key={item} as="span" tone="subdued">
                    • {item}
                  </Text>
                ))}
              </BlockStack>

              <Box paddingBlockStart="300">
                {hasActivePayment ? (
                  <BlockStack gap="300">
                    <Banner tone="success">
                      You are currently subscribed to Pro.
                    </Banner>
                    <Form method="post">
                      <input type="hidden" name="intent" value="cancel" />
                      <input
                        type="hidden"
                        name="subscriptionId"
                        value={subscriptionId}
                      />
                      <Button submit className="zippyyPlanButtonSecondary" fullWidth>
                        Cancel Subscription
                      </Button>
                    </Form>
                  </BlockStack>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="subscribe" />
                    <Button
                      submit
                      className="zippyyPlanButton"
                      loading={isSubscribing}
                      fullWidth
                    >
                      Select
                    </Button>
                  </Form>
                )}
              </Box>
            </BlockStack>
          </Card>
        </Box>
      </BlockStack>
    </Page>
  );
}


