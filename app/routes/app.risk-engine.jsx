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
  guestCodPenalty: 15, shortNamePenalty: 30, missingAddressPenalty: 30,
  missingHouseNoPenalty: 25, cancelWeight: 35, disputeWeight: 50,
  rtoWeight: 35, abandonWeight: 25, zeroValuePenalty: 25,
  refundWeight: 25, pendingPaymentPenalty: 20, codAbuseWeight: 20,
  valueAnomalyPenalty: 15, loyaltyBonus: 5, addressFraudPenalty: 35,
  phoneFraudPenalty: 30, hoardingHighPenalty: 30, hoardingMedPenalty: 15,
  fraudHistoryPenalty: 100, openDisputePenalty: 40,
  invalidEmailFormatPenalty: 30, invalidEmailDomainPenalty: 40,
  missingEmailPenalty: 15, suspiciousTimingPenalty: 40,
  invalidPinFormatPenalty: 80, nonExistentPinPenalty: 80,
  incompletePostalCodePenalty: 80, fakePostalCodePenalty: 80,
  fakeAddressPenalty: 80, wonDisputePenalty: 15,
  highCancelBonusPenalty: 20, medCancelBonusPenalty: 10,
  highRtoBonusPenalty: 15, extremeAbandonPenalty: 35,
  highAbandonPenalty: 20
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

  // React State to strictly control the form inputs - store as strings for better text input handling
  const [formData, setFormData] = useState(() => {
    const stringData = {};
    Object.keys(settings).forEach(key => {
      stringData[key] = settings[key]?.toString() || "0";
    });
    return stringData;
  });
  const [hasChanges, setHasChanges] = useState(false);

  // Handle number input changes - allow any input, validate on blur
  const handleChange = useCallback((value, id) => {
    setFormData((prev) => {
      const newData = { ...prev, [id]: value };
      // Check if data actually changed from the DB settings to enable Save button
      setHasChanges(JSON.stringify(newData) !== JSON.stringify(settings));
      return newData;
    });
  }, [settings]);

  // Handle input blur to validate and clamp values
  const handleBlur = useCallback((id) => {
    setFormData((prev) => {
      let value = prev[id];
      
      // Extract only digits from the input
      if (typeof value === 'string') {
        value = value.replace(/[^\d]/g, ''); // Remove non-numeric characters
      }
      
      // Convert to number
      let numValue = parseInt(value, 10);
      
      // Validate and clamp
      if (isNaN(numValue) || value === '') {
        numValue = 0;
      } else {
        numValue = Math.max(0, Math.min(100, numValue));
      }
      
      const newData = { ...prev, [id]: numValue };
      setHasChanges(JSON.stringify(newData) !== JSON.stringify(settings));
      return newData;
    });
  }, [settings]);

  // Handle form submission via JSON
  const handleSave = () => {
    // Convert string values to numbers and ensure they're within bounds
    const payload = {};
    Object.keys(formData).forEach(key => {
      let val = parseInt(formData[key], 10);
      if (isNaN(val) || formData[key] === "") val = 0;
      payload[key] = Math.max(0, Math.min(100, val));
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
          inputMode="numeric"
          value={formData[id] || "0"}
          onChange={(val) => handleChange(val, id)}
          onBlur={() => handleBlur(id)}
          helpText={helpText}
          autoComplete="off"
          placeholder="0"
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
                <Text as="h2" variant="headingLg">Identity & Checkout Validation</Text>
                <Text as="p" tone="subdued">Penalties applied for suspicious customer information, email validation, and address verification.</Text>
              </BlockStack>
              <Divider />
              
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
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
                  id="missingEmailPenalty" 
                  label="Missing Email Address" 
                  helpText="Applied when no email address is provided with the order." 
                />
                <WeightInput 
                  id="invalidEmailFormatPenalty" 
                  label="Invalid Email Format" 
                  helpText="Applied when email doesn't match standard format (user@domain.com)." 
                />
                <WeightInput 
                  id="invalidEmailDomainPenalty" 
                  label="Invalid Email Domain" 
                  helpText="Applied when email domain doesn't exist or can't receive mail." 
                />
                <WeightInput 
                  id="suspiciousTimingPenalty" 
                  label="Suspicious Timing (Late Night)" 
                  helpText="Applied for orders placed between 2:00 AM and 5:59 AM." 
                />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- SECTION: Address & Logistics --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Address & Logistics Validation</Text>
                <Text as="p" tone="subdued">Penalties for address verification, PIN code validation, and delivery logistics issues.</Text>
              </BlockStack>
              <Divider />
              
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
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
                <WeightInput 
                  id="incompletePostalCodePenalty" 
                  label="Incomplete Postal Code" 
                  helpText="Applied for missing or incomplete postal/ZIP codes." 
                />
                <WeightInput 
                  id="invalidPinFormatPenalty" 
                  label="Invalid PIN Code Format" 
                  helpText="Applied for Indian PIN codes that don't match 6-digit format." 
                />
                <WeightInput 
                  id="fakePostalCodePenalty" 
                  label="Fake Postal Code Pattern" 
                  helpText="Applied for suspicious postal code sequences (00000, 11111, etc.)." 
                />
                <WeightInput 
                  id="nonExistentPinPenalty" 
                  label="Non-existent PIN Code" 
                  helpText="Applied when PIN code doesn't exist in the official database." 
                />
                <WeightInput 
                  id="fakeAddressPenalty" 
                  label="Fake Address (API Validation)" 
                  helpText="Applied when address fails external API validation." 
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
                <Text as="h2" variant="headingLg">Historical Order Behavior</Text>
                <Text as="p" tone="subdued">Weights applied based on customer's past order patterns, cancellations, and fulfillment history.</Text>
              </BlockStack>
              <Divider />

              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                <WeightInput 
                  id="cancelWeight" 
                  label="Cancellation Rate Weight" 
                  helpText="Maximum penalty applied for a 100% cancellation rate." 
                />
                <WeightInput 
                  id="highCancelBonusPenalty" 
                  label="High Cancellation Bonus (10+)" 
                  helpText="Additional penalty for customers with 10+ cancelled orders." 
                />
                <WeightInput 
                  id="medCancelBonusPenalty" 
                  label="Medium Cancellation Bonus (5+)" 
                  helpText="Additional penalty for customers with 5+ cancelled orders." 
                />
                <WeightInput 
                  id="rtoWeight" 
                  label="RTO (Return to Origin) Weight" 
                  helpText="Maximum penalty applied for a 100% package rejection rate." 
                />
                <WeightInput 
                  id="highRtoBonusPenalty" 
                  label="High RTO Bonus (5+)" 
                  helpText="Additional penalty for customers with 5+ RTO orders." 
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
                <WeightInput 
                  id="extremeAbandonPenalty" 
                  label="Extreme Abandonment (20+ orders, ≤1 success)" 
                  helpText="Additional penalty for customers with 20+ orders but ≤1 successful delivery." 
                />
                <WeightInput 
                  id="highAbandonPenalty" 
                  label="High Abandonment (10+ orders, 0 successes)" 
                  helpText="Additional penalty for customers with 10+ orders but 0 successful deliveries." 
                />
                <WeightInput 
                  id="zeroValuePenalty" 
                  label="Zero Value Customer" 
                  helpText="Penalty for customers with many orders but $0 total successful spend." 
                />
                <WeightInput 
                  id="pendingPaymentPenalty" 
                  label="Pending Payment Status" 
                  helpText="Applied when payment gateway shows pending status." 
                />
                <WeightInput 
                  id="codAbuseWeight" 
                  label="COD Abuse Pattern" 
                  helpText="Penalty for COD users with high RTO/refund history." 
                />
                <WeightInput 
                  id="valueAnomalyPenalty" 
                  label="Order Value Anomaly" 
                  helpText="Applied when order value is unusually high vs. customer history." 
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
                <Text as="h2" variant="headingLg">Fraud Networks & Disputes</Text>
                <Text as="p" tone="subdued">Severe penalties for coordinated fraud, chargeback abuse, and suspicious network patterns.</Text>
              </BlockStack>
              <Divider />

              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
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
                  id="openDisputePenalty" 
                  label="Open Dispute Penalty" 
                  helpText="Applied when customer attempts purchase while dispute is pending." 
                />
                <WeightInput 
                  id="fraudHistoryPenalty" 
                  label="Fraud History Penalty" 
                  helpText="Immediate rejection if past dispute was marked as 'fraudulent'." 
                />
                <WeightInput 
                  id="wonDisputePenalty" 
                  label="Won Dispute Friction" 
                  helpText="Applied to customers who frequently file disputes (even if they win)." 
                />
                <WeightInput 
                  id="hoardingHighPenalty" 
                  label="Targeted Hoarding (5+ attempts)" 
                  helpText="Penalty for attempting to order the exact same SKU 5+ times without paying." 
                />
                <WeightInput 
                  id="hoardingMedPenalty" 
                  label="Medium Hoarding (3+ attempts)" 
                  helpText="Penalty for attempting to order the exact same SKU 3+ times without paying." 
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
              
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
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