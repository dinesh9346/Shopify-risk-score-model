import { useState, useCallback, useEffect } from "react";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { 
  Page, Layout, Card, Text, BlockStack, InlineStack, 
  Badge, Divider, Box, TextField, InlineGrid, Tooltip, Icon
} from "@shopify/polaris";
import { ViewIcon } from '@shopify/polaris-icons';
import prisma from "../db.server"; 
import { authenticate } from "../shopify.server"; 

// --- 1. DEFAULT WEIGHTS ---
const DEFAULT_WEIGHTS = {
  invalidEmailPenalty: 40, guestCodPenalty: 15, shortNamePenalty: 30,
  missingEmailPenalty: 15, suspiciousTimingPenalty: 40, pendingPaymentPenalty: 20,
  
  invalidPostalCodePenalty: 80, missingAddressPenalty: 30, 
  missingHouseNoPenalty: 25, fakeAddressPenalty: 80,
  
  cancelWeight: 35, rtoWeight: 35, refundWeight: 25, 
  zeroValuePenalty: 25, codAbuseWeight: 20, valueAnomalyPenalty: 15,
  
  hoardingPenalty: 30, emailFraudPenalty: 35, phoneFraudPenalty: 30,
  disputeWeight: 50, openDisputePenalty: 40, fraudHistoryPenalty: 100,
  
  loyaltyBonus: 5,

  addressFraudPenalty: 35, 
  abandonWeight: 25, 
  nonExistentPinPenalty: 80
};

// --- 2. LOADER ---
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let settings = await prisma.zippyy_risk_settings.findUnique({ where: { shop } });
  const currentSettings = settings ? { ...DEFAULT_WEIGHTS, ...settings } : DEFAULT_WEIGHTS;

  return { settings: currentSettings };
};

// --- 3. ACTION ---
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const data = await request.json();

  const sanitizedData = {};
  Object.keys(DEFAULT_WEIGHTS).forEach(key => {
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

// --- 4. EXTRACTED UI COMPONENT ---
const WeightInput = ({ id, label, helpText, isBonus = false, formData, handleChange, handleBlur, handleFocus }) => (
  <Box paddingBlockEnd="200">
    <BlockStack gap="100">
      <InlineStack gap="200" align="start" blockAlign="center">
        <Text as="p" fontWeight="medium">{label}</Text>
        
        <Tooltip content={helpText} preferredPosition="above">
          <span style={{ cursor: 'help', display: 'flex', alignItems: 'center' }}>
            <Icon source={ViewIcon} tone="subdued" />
          </span>
        </Tooltip>

        <Badge tone={isBonus ? "success" : "attention"} size="small">
          {isBonus ? "Reward" : "Risk Weight"}
        </Badge>
      </InlineStack>

      <TextField
        inputMode="numeric"
        value={formData[id]}
        onChange={(val) => handleChange(val, id)}
        onBlur={() => handleBlur(id)}
        onFocus={handleFocus} // <--- Added Focus Handler
        autoComplete="off"
        placeholder="0"
        suffix="pts"
        align="right"
      />
    </BlockStack>
  </Box>
);

// --- 5. MAIN UI COMPONENT ---
export default function RiskEngineSettings() {
  const { settings } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData();
  const isSaving = navigation.state === "submitting";

  const [formData, setFormData] = useState(() => {
    const stringData = {};
    Object.keys(settings).forEach(key => stringData[key] = settings[key]?.toString() || "0");
    return stringData;
  });
  const [hasChanges, setHasChanges] = useState(false);

  const checkHasChanges = useCallback((currentForm, originalSettings) => {
    return Object.keys(DEFAULT_WEIGHTS).some(key => 
      parseInt(currentForm[key] || 0, 10) !== parseInt(originalSettings[key] || 0, 10)
    );
  }, []);

  // Fix for cursor jumping to end on focus
  const handleFocus = useCallback((event) => {
    const val = event.target.value;
    event.target.setSelectionRange(val.length, val.length);
  }, []);

  const handleChange = useCallback((value, id) => {
    let cleanValue = value.replace(/[^\d]/g, '');

    // Strips leading zeros but allows single "0"
    if (cleanValue.length > 1 && cleanValue.startsWith('0')) {
        cleanValue = cleanValue.replace(/^0+/, '');
    }

    setFormData((prev) => {
      const newData = { ...prev, [id]: cleanValue };
      setHasChanges(checkHasChanges(newData, settings));
      return newData;
    });
  }, [settings, checkHasChanges]);

  const handleBlur = useCallback((id) => {
    setFormData((prev) => {
      let value = prev[id];
      
      if (value === '' || isNaN(parseInt(value, 10))) {
        value = "0";
      } else {
        let numValue = Math.max(0, Math.min(100, parseInt(value, 10)));
        value = numValue.toString();
      }
      
      const newData = { ...prev, [id]: value };
      setHasChanges(checkHasChanges(newData, settings));
      return newData;
    });
  }, [settings, checkHasChanges]);

  const handleSave = () => {
    const payload = {};
    Object.keys(formData).forEach(key => {
      let val = parseInt(formData[key], 10);
      if (isNaN(val) || formData[key] === "") val = 0;
      payload[key] = Math.max(0, Math.min(100, val));
    });

    submit(payload, { method: "post", encType: "application/json" });
  };

  const handleResetToDefaults = () => {
    const stringDefaults = {};
    Object.keys(DEFAULT_WEIGHTS).forEach(key => stringDefaults[key] = DEFAULT_WEIGHTS[key].toString());
    setFormData(stringDefaults);
    setHasChanges(true); 
    if (typeof shopify !== 'undefined' && shopify.toast) {
      shopify.toast.show("Reset to defaults. Click Save to apply.");
    }
  };

  useEffect(() => {
    if (actionData?.success && !isSaving) {
      setHasChanges(false);
      if (typeof shopify !== 'undefined' && shopify.toast) {
        shopify.toast.show("Risk settings updated successfully");
      }
    }
  }, [actionData, isSaving]);

  return (
    <Page 
      title="Risk Engine Configuration" 
      primaryAction={{
        content: isSaving ? 'Saving...' : 'Save Configuration',
        onAction: handleSave,
        disabled: !hasChanges || isSaving,
        loading: isSaving,
      }}
      secondaryActions={[{
        content: 'Reset to Defaults',
        onAction: handleResetToDefaults,
        disabled: isSaving,
      }]}
    >
      <Layout>
        <Layout.Section>
          <Box paddingBlockEnd="200">
            <Card background="bg-surface-brand">
              <BlockStack gap="400" align="center" inlineAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h1" variant="heading2xl" color="text-brand-on-bg-fill">Zippyy.ai</Text>
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

        {/* --- SECTION 1: Identity & Checkout --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Identity & Checkout Validation</Text>
                <Divider />
              </BlockStack>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                <WeightInput id="invalidEmailPenalty" label="Fake Email" helpText=" Applied for emails that are fake or non-existent." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="guestCodPenalty" label="Guest Checkout + COD" helpText="Applied when an unlogged user selects Cash on Delivery." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="shortNamePenalty" label="Suspicious/Short Name" helpText="Applied for missing names or names with 3 characters or less." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="missingEmailPenalty" label="Missing Email Address" helpText="Applied when no email address is provided with the order." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="suspiciousTimingPenalty" label="Suspicious Timing" helpText="Applied for orders placed between 2:00 AM and 5:59 AM." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="pendingPaymentPenalty" label="Pending Payment" helpText="Digital payment gateway status is stuck on pending." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- SECTION 2: Address & Logistics --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Address & Logistics Validation</Text>
                <Divider />
              </BlockStack>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                <WeightInput id="missingAddressPenalty" label="Missing Shipping Address" helpText="Heavy weight if the street lines are completely empty." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="missingHouseNoPenalty" label="Missing House No." helpText="Address exists but lacks specific house/door numbers." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="fakeAddressPenalty" label="Fake Delivery Address" helpText="External mapping API explicitly returns the address as fake or unreachable." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- SECTION 3: Historical Behavior --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Historical Order Behavior</Text>
                <Divider />
              </BlockStack>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                <WeightInput id="cancelWeight" label="Cancellation Rate" helpText="Base weight applied against their historical cancellation rate." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="rtoWeight" label="RTO (Return to Origin)" helpText="Base weight applied against their Return-To-Origin rate." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="refundWeight" label="Refund Request Rate" helpText="Base weight applied against their historical refund request rate." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="zeroValuePenalty" label="Zero Value Customer" helpText="Customer has a history of orders but $0 in successful spend." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="codAbuseWeight" label="COD Abuse Pattern" helpText="Customer frequently uses COD but has a history of rejecting packages." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="valueAnomalyPenalty" label="Order Value Anomaly" helpText="Current order value is highly abnormal compared to their average spend." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- SECTION 4: Severe Fraud Signals --- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Fraud Networks & Disputes</Text>
                <Divider />
              </BlockStack>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                <WeightInput id="hoardingPenalty" label="Targeted Hoarding" helpText="Triggers when attempting to order the exact same SKU multiple times without paying." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="emailFraudPenalty" label="Email Network Abuse" helpText="Triggers if 3 or more different phone numbers use the exact same email address." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="phoneFraudPenalty" label="Phone Network Abuse" helpText="Triggers if 3 or more different emails are linked to the exact same phone number." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="disputeWeight" label="Chargeback Loss Rate" helpText="Base weight applied against their historical chargeback loss rate." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="openDisputePenalty" label="Active Dispute Risk" helpText="Trying to place a new order while a previous chargeback is actively under review." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
                <WeightInput id="fraudHistoryPenalty" label="Known Fraud History" helpText="Automatic rejection if a previous dispute was explicitly categorized as fraudulent." formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- SECTION 5: Rewards --- */}
        <Layout.Section>
          <Card background="bg-surface-success">
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">Customer Loyalty Adjustments</Text>
                <Divider />
              </BlockStack>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                <WeightInput id="loyaltyBonus" label="Loyalty Score Reduction" helpText="Subtracts this % for every historically successful, paid, and delivered order." isBonus={true} formData={formData} handleChange={handleChange} handleBlur={handleBlur} handleFocus={handleFocus} />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <div style={{ height: '40px' }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}


// import { useState, useCallback, useEffect } from "react";
// import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
// import { 
//   Page, Layout, Card, Text, BlockStack, InlineStack, 
//   Badge, Divider, Box, TextField, InlineGrid, Tooltip, Icon
// } from "@shopify/polaris";
// import { ViewIcon } from '@shopify/polaris-icons';
// import prisma from "../db.server"; 
// import { authenticate } from "../shopify.server"; 

// // --- 1. DEFAULT WEIGHTS ---
// // Includes both visible UI settings and hidden backend settings 
// // to ensure the DB doesn't erase your backend logic on save.
// const DEFAULT_WEIGHTS = {
//   // Visible: Identity & Checkout
//   invalidEmailPenalty: 40, guestCodPenalty: 15, shortNamePenalty: 30,
//   missingEmailPenalty: 15, suspiciousTimingPenalty: 40, pendingPaymentPenalty: 20,
  
//   // Visible: Address & Logistics
//   invalidPostalCodePenalty: 80, missingAddressPenalty: 30, 
//   missingHouseNoPenalty: 25, fakeAddressPenalty: 80,
  
//   // Visible: Historical Behavior
//   cancelWeight: 35, rtoWeight: 35, refundWeight: 25, 
//   zeroValuePenalty: 25, codAbuseWeight: 20, valueAnomalyPenalty: 15,
  
//   // Visible: Fraud Networks & Disputes
//   hoardingPenalty: 30, emailFraudPenalty: 35, phoneFraudPenalty: 30,
//   disputeWeight: 50, openDisputePenalty: 40, fraudHistoryPenalty: 100,
  
//   // Visible: Loyalty
//   loyaltyBonus: 5,

//   // --- HIDDEN BACKEND VARIABLES ---
//   // Kept here so they are preserved during the Prisma upsert
//   addressFraudPenalty: 35, 
//   abandonWeight: 25, 
//   nonExistentPinPenalty: 80
// };

// // --- 2. LOADER: Fetch Data ---
// export const loader = async ({ request }) => {
//   const { session } = await authenticate.admin(request);
//   const shop = session.shop;

//   let settings = await prisma.zippyy_risk_settings.findUnique({ where: { shop } });
//   const currentSettings = settings ? { ...DEFAULT_WEIGHTS, ...settings } : DEFAULT_WEIGHTS;

//   return { settings: currentSettings };
// };

// // --- 3. ACTION: Save Data ---
// export const action = async ({ request }) => {
//   const { session } = await authenticate.admin(request);
//   const shop = session.shop;
//   const data = await request.json();

//   const sanitizedData = {};
//   Object.keys(DEFAULT_WEIGHTS).forEach(key => {
//     let val = parseInt(data[key], 10);
//     if (isNaN(val)) val = 0;
//     sanitizedData[key] = Math.max(0, Math.min(100, val));
//   });

//   await prisma.zippyy_risk_settings.upsert({
//     where: { shop },
//     update: sanitizedData,
//     create: { shop, ...sanitizedData }
//   });

//   return { success: true };
// };

// // --- 4. EXTRACTED UI COMPONENT (Fixes the Focus Bug) ---
// // Extracted outside the main function so React doesn't unmount it while typing
// const WeightInput = ({ id, label, helpText, isBonus = false, formData, handleChange, handleBlur }) => (
//   <Box paddingBlockEnd="200">
//     <BlockStack gap="100">
//       <InlineStack gap="200" align="start" blockAlign="center">
//         <Text as="p" fontWeight="medium">{label}</Text>
        
//         {/* The Eye Icon with Hover Tooltip */}
//         <Tooltip content={helpText} preferredPosition="above">
//           <span style={{ cursor: 'help', display: 'flex', alignItems: 'center' }}>
//             <Icon source={ViewIcon} tone="subdued" />
//           </span>
//         </Tooltip>

//         {/* Removed the word "Penalty" from the UI badge */}
//         <Badge tone={isBonus ? "success" : "attention"} size="small">
//           {isBonus ? "Reward" : "Risk Weight"}
//         </Badge>
//       </InlineStack>

//       <TextField
//         inputMode="numeric"
//         value={formData[id] || "0"}
//         onChange={(val) => handleChange(val, id)}
//         onBlur={() => handleBlur(id)}
//         autoComplete="off"
//         placeholder="0"
//         suffix="pts"
//         align="right"
//       />
//     </BlockStack>
//   </Box>
// );

// // --- 5. MAIN UI COMPONENT ---
// export default function RiskEngineSettings() {
//   const { settings } = useLoaderData();
//   const submit = useSubmit();
//   const navigation = useNavigation();
//   const actionData = useActionData();
//   const isSaving = navigation.state === "submitting";

//   const [formData, setFormData] = useState(() => {
//     const stringData = {};
//     Object.keys(settings).forEach(key => stringData[key] = settings[key]?.toString() || "0");
//     return stringData;
//   });
//   const [hasChanges, setHasChanges] = useState(false);

//   // Safe object comparison utility
//   const checkHasChanges = useCallback((currentForm, originalSettings) => {
//     return Object.keys(DEFAULT_WEIGHTS).some(key => 
//       parseInt(currentForm[key] || 0, 10) !== parseInt(originalSettings[key] || 0, 10)
//     );
//   }, []);

//   const handleChange = useCallback((value, id) => {
//     setFormData((prev) => {
//       const newData = { ...prev, [id]: value };
//       setHasChanges(checkHasChanges(newData, settings));
//       return newData;
//     });
//   }, [settings, checkHasChanges]);

//   const handleBlur = useCallback((id) => {
//     setFormData((prev) => {
//       let value = prev[id];
//       if (typeof value === 'string') value = value.replace(/[^\d]/g, ''); 
//       let numValue = parseInt(value, 10);
//       if (isNaN(numValue) || value === '') numValue = 0;
//       else numValue = Math.max(0, Math.min(100, numValue));
      
//       const newData = { ...prev, [id]: numValue.toString() };
//       setHasChanges(checkHasChanges(newData, settings));
//       return newData;
//     });
//   }, [settings, checkHasChanges]);

//   const handleSave = () => {
//     const payload = {};
//     Object.keys(formData).forEach(key => {
//       let val = parseInt(formData[key], 10);
//       if (isNaN(val) || formData[key] === "") val = 0;
//       payload[key] = Math.max(0, Math.min(100, val));
//     });

//     submit(payload, { method: "post", encType: "application/json" });
//   };

//   const handleResetToDefaults = () => {
//     const stringDefaults = {};
//     Object.keys(DEFAULT_WEIGHTS).forEach(key => stringDefaults[key] = DEFAULT_WEIGHTS[key].toString());
//     setFormData(stringDefaults);
//     setHasChanges(true); 
//     if (typeof shopify !== 'undefined' && shopify.toast) {
//       shopify.toast.show("Reset to defaults. Click Save to apply.");
//     }
//   };

//   useEffect(() => {
//     if (actionData?.success && !isSaving) {
//       setHasChanges(false);
//       if (typeof shopify !== 'undefined' && shopify.toast) {
//         shopify.toast.show("Risk settings updated successfully");
//       }
//     }
//   }, [actionData, isSaving]);

//   return (
//     <Page 
//       title="Risk Engine Configuration" 
//       primaryAction={{
//         content: isSaving ? 'Saving...' : 'Save Configuration',
//         onAction: handleSave,
//         disabled: !hasChanges || isSaving,
//         loading: isSaving,
//       }}
//       secondaryActions={[{
//         content: 'Reset to Defaults',
//         onAction: handleResetToDefaults,
//         disabled: isSaving,
//       }]}
//     >
//       <Layout>
//         <Layout.Section>
//           <Box paddingBlockEnd="200">
//             <Card background="bg-surface-brand">
//               <BlockStack gap="400" align="center" inlineAlign="center">
//                 <InlineStack gap="200" blockAlign="center">
//                   <Text as="h1" variant="heading2xl" color="text-brand-on-bg-fill">Zippyy.ai</Text>
//                   <Badge tone="info" size="large">Risk Engine</Badge>
//                 </InlineStack>
//                 <Text as="p" alignment="center" tone="subdued">
//                   Fine-tune the mathematical weights of the AI assessment algorithm. 
//                   Adjust how strictly different behaviors impact the final 0-100% risk score.
//                 </Text>
//               </BlockStack>
//             </Card>
//           </Box>
//         </Layout.Section>

//         {/* --- SECTION 1: Identity & Checkout --- */}
//         <Layout.Section>
//           <Card>
//             <BlockStack gap="400">
//               <BlockStack gap="200">
//                 <Text as="h2" variant="headingLg">Identity & Checkout Validation</Text>
//                 <Divider />
//               </BlockStack>
//               <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
//                 <WeightInput id="invalidEmailPenalty" label="Fake Email" helpText=" Applied for emails that are fake or non-existent." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="guestCodPenalty" label="Guest Checkout + COD" helpText="Applied when an unlogged user selects Cash on Delivery." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="shortNamePenalty" label="Suspicious/Short Name" helpText="Applied for missing names or names with 3 characters or less." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="missingEmailPenalty" label="Missing Email Address" helpText="Applied when no email address is provided with the order." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="suspiciousTimingPenalty" label="Suspicious Timing" helpText="Applied for orders placed between 2:00 AM and 5:59 AM." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="pendingPaymentPenalty" label="Pending Payment" helpText="Digital payment gateway status is stuck on pending." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//               </InlineGrid>
//             </BlockStack>
//           </Card>
//         </Layout.Section>

//         {/* --- SECTION 2: Address & Logistics --- */}
//         <Layout.Section>
//           <Card>
//             <BlockStack gap="400">
//               <BlockStack gap="200">
//                 <Text as="h2" variant="headingLg">Address & Logistics Validation</Text>
//                 <Divider />
//               </BlockStack>
//               <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
//                 <WeightInput id="missingAddressPenalty" label="Missing Shipping Address" helpText="Heavy weight if the street lines are completely empty." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="missingHouseNoPenalty" label="Missing House No." helpText="Address exists but lacks specific house/door numbers." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="fakeAddressPenalty" label="Fake Delivery Address" helpText="External mapping API explicitly returns the address as fake or unreachable." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//               </InlineGrid>
//             </BlockStack>
//           </Card>
//         </Layout.Section>

//         {/* --- SECTION 3: Historical Behavior --- */}
//         <Layout.Section>
//           <Card>
//             <BlockStack gap="400">
//               <BlockStack gap="200">
//                 <Text as="h2" variant="headingLg">Historical Order Behavior</Text>
//                 <Divider />
//               </BlockStack>
//               <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
//                 <WeightInput id="cancelWeight" label="Cancellation Rate" helpText="Base weight applied against their historical cancellation rate." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="rtoWeight" label="RTO (Return to Origin)" helpText="Base weight applied against their Return-To-Origin rate." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="refundWeight" label="Refund Request Rate" helpText="Base weight applied against their historical refund request rate." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="zeroValuePenalty" label="Zero Value Customer" helpText="Customer has a history of orders but $0 in successful spend." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="codAbuseWeight" label="COD Abuse Pattern" helpText="Customer frequently uses COD but has a history of rejecting packages." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="valueAnomalyPenalty" label="Order Value Anomaly" helpText="Current order value is highly abnormal compared to their average spend." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//               </InlineGrid>
//             </BlockStack>
//           </Card>
//         </Layout.Section>

//         {/* --- SECTION 4: Severe Fraud Signals --- */}
//         <Layout.Section>
//           <Card>
//             <BlockStack gap="400">
//               <BlockStack gap="200">
//                 <Text as="h2" variant="headingLg">Fraud Networks & Disputes</Text>
//                 <Divider />
//               </BlockStack>
//               <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
//                 <WeightInput id="hoardingPenalty" label="Targeted Hoarding" helpText="Triggers when attempting to order the exact same SKU multiple times without paying." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
                
//                 {/* NEW EMAIL FRAUD INPUT */}
//                 <WeightInput id="emailFraudPenalty" label="Email Network Abuse" helpText="Triggers if 3 or more different phone numbers use the exact same email address." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
                
//                 <WeightInput id="phoneFraudPenalty" label="Phone Network Abuse" helpText="Triggers if 3 or more different emails are linked to the exact same phone number." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="disputeWeight" label="Chargeback Loss Rate" helpText="Base weight applied against their historical chargeback loss rate." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="openDisputePenalty" label="Active Dispute Risk" helpText="Trying to place a new order while a previous chargeback is actively under review." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//                 <WeightInput id="fraudHistoryPenalty" label="Known Fraud History" helpText="Automatic rejection if a previous dispute was explicitly categorized as fraudulent." formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//               </InlineGrid>
//             </BlockStack>
//           </Card>
//         </Layout.Section>

//         {/* --- SECTION 5: Rewards --- */}
//         <Layout.Section>
//           <Card background="bg-surface-success">
//             <BlockStack gap="400">
//               <BlockStack gap="200">
//                 <Text as="h2" variant="headingLg">Customer Loyalty Adjustments</Text>
//                 <Divider />
//               </BlockStack>
//               <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
//                 <WeightInput id="loyaltyBonus" label="Loyalty Score Reduction" helpText="Subtracts this % for every historically successful, paid, and delivered order." isBonus={true} formData={formData} handleChange={handleChange} handleBlur={handleBlur} />
//               </InlineGrid>
//             </BlockStack>
//           </Card>
//         </Layout.Section>

//         <Layout.Section>
//           <div style={{ height: '40px' }} />
//         </Layout.Section>
//       </Layout>
//     </Page>
//   );
// }

