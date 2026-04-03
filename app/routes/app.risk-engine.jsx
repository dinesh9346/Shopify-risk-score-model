import { useState, useCallback, useEffect } from "react";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { 
  Page, Layout, Card, Text, BlockStack, InlineStack, 
  Badge, Divider, Box, TextField, InlineGrid
} from "@shopify/polaris";
import prisma from "../db.server"; // Adjust path if necessary
import { authenticate } from "../shopify.server"; // Adjust path if necessary

// --- 1. DEFAULT WEIGHTS ---
const DEFAULT_WEIGHTS = {
  guestCodPenalty: 15, shortNamePenalty: 20, missingAddressPenalty: 30,
  missingHouseNoPenalty: 15, cancelWeight: 35, disputeWeight: 50,
  rtoWeight: 35, abandonWeight: 25, zeroValuePenalty: 25,
  refundWeight: 25, pendingPaymentPenalty: 20, codAbuseWeight: 20,
  valueAnomalyPenalty: 15, loyaltyBonus: 5, addressFraudPenalty: 30,
  phoneFraudPenalty: 30, hoardingHighPenalty: 30, hoardingMedPenalty: 15
};

// --- 2. LOADER: Fetch Data ---
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let settings = await prisma.zippyy_risk_settings.findUnique({
    where: { shop }
  });

  // Merge with defaults in case new fields were added to the schema later
  const currentSettings = settings ? { ...DEFAULT_WEIGHTS, ...settings } : DEFAULT_WEIGHTS;

  return { settings: currentSettings };
};

// --- 3. ACTION: Save Data ---
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  
  const data = await request.json();

  // Strip out UI-specific or unrelated keys, keep only safe numbers (0-100)
  const sanitizedData = {};
  Object.keys(DEFAULT_WEIGHTS).forEach(key => {
    // If empty string or NaN, default to 0. Clamp between 0 and 100.
    let val = parseInt(data[key], 10);
    if (isNaN(val)) val = 0;
    sanitizedData[key] = Math.max(0, Math.min(100, val));
  });

  await prisma.zippyy_risk_settings.upsert({
    where: { shop },
    update: sanitizedData,
    create: { shop, ...sanitizedData }
  });

  return { success: true };
};

// --- 4. MAIN UI COMPONENT ---
export default function RiskEngineSettings() {
  const { settings } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData();
  const isSaving = navigation.state === "submitting";

  // React State to strictly control the form inputs
  const [formData, setFormData] = useState(settings);
  const [hasChanges, setHasChanges] = useState(false);

  // Handle number input changes with clamping
  const handleChange = useCallback((value, id) => {
    // Allow empty string temporarily so user can delete and type new numbers
    let safeValue = value;
    if (value !== "") {
      // Clamp the visual input between 0 and 100
      safeValue = Math.max(0, Math.min(100, Number(value)));
    }

    setFormData((prev) => {
      const newData = { ...prev, [id]: safeValue };
      // Check if data actually changed from the DB settings to enable Save button
      setHasChanges(JSON.stringify(newData) !== JSON.stringify(settings));
      return newData;
    });
  }, [settings]);

  // Handle form submission via JSON
  const handleSave = () => {
    // Ensure any empty fields are converted to 0 before saving
    const payload = { ...formData };
    Object.keys(payload).forEach(key => {
      if (payload[key] === "") payload[key] = 0;
    });

    submit(payload, { 
      method: "post", 
      encType: "application/json" 
    });
  };

  // Reset "hasChanges" when save is successful and trigger toast
  useEffect(() => {
    if (actionData?.success && !isSaving) {
      setHasChanges(false);
      if (typeof shopify !== 'undefined' && shopify.toast) {
        shopify.toast.show("Risk settings updated successfully");
      }
    }
  }, [actionData, isSaving]);

  // Premium UI Component for a settings input
  const WeightInput = ({ id, label, helpText, isBonus = false }) => (
    <Box>
      <BlockStack gap="100">
        <InlineStack gap="200" align="start" blockAlign="center">
          <Text as="p" fontWeight="medium">{label}</Text>
          <Badge tone={isBonus ? "success" : "critical"} size="small">
            {isBonus ? "Reward" : "Penalty"}
          </Badge>
        </InlineStack>
        <TextField
          type="number"
          value={formData[id].toString()}
          onChange={(val) => handleChange(val, id)}
          helpText={helpText}
          autoComplete="off"
          min={0}
          max={100}
        />
      </BlockStack>
    </Box>
  );

  return (
    <Page 
      title="Risk Engine Configuration" 
      primaryAction={{
        content: isSaving ? 'Saving...' : 'Save Configuration',
        onAction: handleSave,
        disabled: !hasChanges || isSaving,
        loading: isSaving,
      }}
    >
      <Layout>
        {/* --- BRANDING BANNER --- */}
        <Layout.Section>
          <Box paddingBlockEnd="200">
            <Card background="bg-surface-brand">
              <BlockStack gap="400" align="center" inlineAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h1" variant="heading2xl" color="text-brand-on-bg-fill">
                    Zippyy.ai
                  </Text>
                  <Badge tone="info" size="large">Risk Engine</Badge>
                </InlineStack>
                <Text as="p" alignment="center" tone="subdued">
                  Fine-tune the mathematical weights of the AI assessment algorithm. 
                  Adjust how strictly different behaviors impact the final 0-100% risk score.
                </Text>
              </BlockStack>
            </Card>
          </Box>
        </Layout.Section>

        {/* --- SECTION: Identity & Checkout --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Identity & Checkout Signals</Text>
                <Text as="p" tone="subdued">Penalties applied dynamically based on how the order was placed and formatted.</Text>
              </BlockStack>
              <Divider />
              
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <WeightInput 
                  id="guestCodPenalty" 
                  label="Guest Checkout + COD" 
                  helpText="Applied when an unlogged user selects Cash on Delivery." 
                />
                <WeightInput 
                  id="shortNamePenalty" 
                  label="Suspicious/Short Name" 
                  helpText="Applied for missing names or names with 3 characters or less." 
                />
                <WeightInput 
                  id="missingAddressPenalty" 
                  label="Missing Shipping Address" 
                  helpText="Heavy penalty if the street lines are completely empty." 
                />
                <WeightInput 
                  id="missingHouseNoPenalty" 
                  label="Missing House/Apartment No." 
                  helpText="Applied if the address string lacks any numeric digits." 
                />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- SECTION: Historical Behavior --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Historical Logistics</Text>
                <Text as="p" tone="subdued">Weights applied dynamically based on the customer's past failure rates.</Text>
              </BlockStack>
              <Divider />

              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <WeightInput 
                  id="cancelWeight" 
                  label="Cancellation Rate Weight" 
                  helpText="Maximum penalty applied for a 100% cancellation rate." 
                />
                <WeightInput 
                  id="rtoWeight" 
                  label="RTO (Return to Origin) Weight" 
                  helpText="Maximum penalty applied for a 100% package rejection rate." 
                />
                <WeightInput 
                  id="refundWeight" 
                  label="Refund Abuse Weight" 
                  helpText="Penalty scale for users who frequently request refunds." 
                />
                <WeightInput 
                  id="abandonWeight" 
                  label="Serial Abandonment Weight" 
                  helpText="Applied when a user places many orders but fulfills very few." 
                />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- SECTION: Severe Fraud Signals --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">High-Risk Fraud Network Signals</Text>
                <Text as="p" tone="subdued">Severe penalties for behavior indicating coordinated fraud, hoarding, or abuse.</Text>
              </BlockStack>
              <Divider />

              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <WeightInput 
                  id="addressFraudPenalty" 
                  label="Address Fraud Network" 
                  helpText="Triggered when 4+ unique emails ship to the exact same address." 
                />
                <WeightInput 
                  id="phoneFraudPenalty" 
                  label="Phone Network Abuse" 
                  helpText="Triggered when 4+ unique emails use the same phone number." 
                />
                <WeightInput 
                  id="disputeWeight" 
                  label="Chargeback / Dispute Rate" 
                  helpText="Massive penalty applied to users with a history of disputes." 
                />
                <WeightInput 
                  id="hoardingHighPenalty" 
                  label="Targeted Hoarding (5+ attempts)" 
                  helpText="Penalty for attempting to order the exact same SKU 5+ times without paying." 
                />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- SECTION: Rewards --- */}
        <Layout.Section>
          <Card background="bg-surface-success">
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Customer Loyalty Adjustments</Text>
                <Text as="p" tone="subdued">These metrics SUBTRACT points from the final risk score, rewarding good buyers.</Text>
              </BlockStack>
              <Divider />
              
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <WeightInput 
                  id="loyaltyBonus" 
                  label="Loyalty Point Reduction" 
                  helpText="Subtracts this % for every paid & delivered order in their history (Max 30% reduction)." 
                  isBonus={true}
                />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Bottom padding for scrolling clearance */}
        <Layout.Section>
          <div style={{ height: '40px' }} />
        </Layout.Section>

      </Layout>
    </Page>
  );
}