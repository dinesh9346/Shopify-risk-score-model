import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// Dynamically swapped by the Shopify CLI
const APP_URL = process.env.APP_URL;

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  const { data } = shopify;
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [profileData, setProfileData] = useState(null);

  const orderId = data?.selected?.[0]?.id;

  useEffect(() => {
    async function fetchRiskData() {
      if (!orderId) return;

      try {
        // FIX 1: Use idToken() as expected by the Admin UI Extension Preact API
        const token = await shopify.auth.idToken();

        const response = await fetch(`${APP_URL}/api/buyer-profile?orderId=${encodeURIComponent(orderId)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);

        const result = await response.json();

        if (result.profile) {
          setProfileData(result.profile);
        } else {
          setProfileData(null); 
        }
      } catch (err) {
        console.error("Error fetching risk data:", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    }

    fetchRiskData();
  }, [orderId]);

  if (loading) {
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-text>Connecting to Zippyy database...</s-text>
      </s-admin-block>
    );
  }

  if (error) {
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-banner tone="critical">
          <s-text>Unable to load buyer profile at this time. Please check your connection.</s-text>
        </s-banner>
      </s-admin-block>
    );
  }

  const profile = profileData || {
    buyerSegment: "New",
    riskReasons: [],
    validOrderCount: 0,
    rtoCount: 0,
    cancelledCount: 0,
    disputeCount: 0,
    refundCount: 0,
    totalSpend: 0,
    totalCheckoutAttempts: 0,
    codCount: 0,
    fulfilledCount: 0,
    unpaidCount: 0
  };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount || 0);
  };

  // FIX 3: Use a JSDoc comment to force the type checker to recognize these exact string literals
  /** @type {"critical" | "success" | "info" | "warning"} */
  let bannerTone = "info"; 
  let bannerMessage = "This is a new customer. Standard fulfillment processing.";

  if (profile.buyerSegment === "High Risk") {
    bannerTone = "critical"; 
    bannerMessage = profile.riskReasons?.length > 0 
      ? `Warning: ${profile.riskReasons.join(", ")}. Verify before shipping.` 
      : "Warning: High RTO/Returns. Verify before shipping COD.";
  } else if (profile.buyerSegment === "VIP" || profile.buyerSegment === "Repeat Buyer") {
    bannerTone = "success"; 
    bannerMessage = "Excellent order history. Prioritize fulfillment.";
  }

  return (
    <s-admin-block heading="Zippyy Buyer Profile">
      {/* FIX 2: Removed 'gap' completely to use the system default without throwing type errors */}
      <s-stack direction="block">
        
        <s-banner tone={bannerTone}>
          <s-stack direction="block" gap="none">
            <s-text type="strong">{profile.buyerSegment} Customer</s-text>
            <s-text>{bannerMessage}</s-text>
          </s-stack>
        </s-banner>

        <s-stack direction="block" gap="none">
          <s-stack direction="inline" inline-alignment="space-between">
            <s-text>Total Spend (Valid):</s-text>
            <s-text type="strong">{formatCurrency(profile.totalSpend)}</s-text> 
          </s-stack>

          <s-stack direction="inline" inline-alignment="space-between">
            <s-text>Valid Orders:</s-text>
            <s-text type="strong">{profile.validOrderCount}</s-text>
          </s-stack>
          
          <s-stack direction="inline" inline-alignment="space-between">
            <s-text>Checkout Attempts:</s-text>
            <s-text type="strong">{profile.totalCheckoutAttempts}</s-text>
          </s-stack>
        </s-stack>

        <s-divider></s-divider>

        <s-stack direction="block" gap="none">
          <s-stack direction="inline" inline-alignment="space-between">
            <s-text>COD Orders:</s-text>
            <s-text type="strong">{profile.codCount}</s-text>
          </s-stack>

          <s-stack direction="inline" inline-alignment="space-between">
            <s-text>Successfully Fulfilled:</s-text>
            <s-text type="strong">{profile.fulfilledCount}</s-text>
          </s-stack>

          <s-stack direction="inline" inline-alignment="space-between">
            <s-text>RTOs / Returns:</s-text>
            <s-text type="strong">{profile.rtoCount}</s-text>
          </s-stack>

          <s-stack direction="inline" inline-alignment="space-between">
            <s-text>Cancellations / Refunds:</s-text>
            <s-text type="strong">{profile.cancelledCount + profile.refundCount}</s-text>
          </s-stack>
        </s-stack>

        <s-divider></s-divider>

        <s-button onClick={() => {
           shopify["navigation"].navigate("shopify:admin/apps/new-risk-score/app/additional");
        }}>
           Full Buyer's Profile
        </s-button>

      </s-stack>
    </s-admin-block>
  );
}