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
  const orderId = data?.selected?.[0]?.id;

  const [loading, setLoading] = useState(true);
  const [riskData, setRiskData] = useState(null);

  useEffect(() => {
    let isMounted = true;
    let timeoutId;
    const maxAttempts = 8; 
    let attempt = 0;

    async function fetchRiskProfile() {
      if (!orderId || !isMounted) return;
      attempt++;

      try {
        // 1. SECURITY: Always authenticate the request so your data cannot be stolen
        const token = await shopify.auth.idToken();
        
        const response = await fetch(`${APP_URL}/api/buyer-profile?orderId=${encodeURIComponent(orderId)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (response.ok) {
           const result = await response.json();
           
           // 2. SUCCESS: The SQS worker finished and data
           if (result.profile && isMounted) {
             setRiskData(result.profile);
             setLoading(false);
             return; 
           }
        }

        // 3. RACE CONDITION: The SQS worker is still processing. Try again smartly.
        if (attempt < maxAttempts && isMounted) {
          // Exponential backoff: waits 1s, 2s, 4s, 8s.
          const delay = Math.pow(2, attempt - 1) * 1000; 
          timeoutId = setTimeout(fetchRiskProfile, delay);
        } else if (isMounted) {
          setLoading(false);
        }

      } catch (error) {
        console.error("Error fetching risk data:", error);
        if (attempt < maxAttempts && isMounted) {
           const delay = Math.pow(2, attempt - 1) * 1000;
           timeoutId = setTimeout(fetchRiskProfile, delay);
        } else if (isMounted) {
           setLoading(false);
        }
      }
    }

    // Start the first fetch immediately
    fetchRiskProfile();

    // Cleanup if the merchant closes the page before polling finishes
    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [orderId]);

  // UI RENDER LOGIC 

  if (loading) {
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-text>Assessing buyer risk profile...</s-text>
      </s-admin-block>
    );
  }

  // 5. THE FAIL-SAFE FALLBACK: If polling failed or found nothing
  const profileData = riskData || {
    buyerSegment: "New",
    riskReason: "Standard fulfillment processing.",
    validOrderCount: 0,
    rtoCount: 0,
    cancelledCount: 0,
    disputeCount: 0,
    totalSpend: 0,
    totalorders: 0,
    codCount: 0,
    fulfilledCount: 0,
    unpaidCount: 0
  };


/** @type {"info" | "critical" | "success" | "auto" | "warning"} */
  let bannerTone = "info"; 
  let bannerTitle = profileData.buyerSegment || "New";
  
  // Create a clean, one-line message based on the segment (No more hardcoded RTO text!)
  let bannerMessage = `This buyer has been classified as a ${bannerTitle} customer.`;

  if (bannerTitle === "High Risk" || bannerTitle === "COD Abuser" || bannerTitle === "Watchlist") {
    bannerTone = "critical"; 
  } else if (bannerTitle === "VIP" || bannerTitle === "Repeat Buyer") {
    bannerTone = "success"; 
  } else if (bannerTitle === "New") {
    bannerTone = "auto"; 
    bannerMessage = "This is a new customer. Standard fulfillment processing.";
  }
  const formatCurrency = (amount) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount || 0);
  };

  return (
    <s-admin-block heading="Zippyy Buyer Profile">
      {/* Changed outer gap to "tight" to save vertical space */}
      <s-stack direction="block" gap="small">

        <s-banner tone={bannerTone}>
          <s-stack direction="block" gap="none">
            <s-text type="strong">{bannerTitle} Customer</s-text>
            <s-text>{bannerMessage}</s-text>
          </s-stack>
        </s-banner>

        {/* Removed inline-space-between stacks, mapped directly to text lines */}
        <s-stack direction="block" gap="none">
          <s-text>Total Spend:{formatCurrency(profileData.totalSpend)}</s-text>
          <s-text>Order Placed:{profileData.totalorders}</s-text>
          <s-text>COD Orders:{profileData.codCount}</s-text>
        </s-stack>

        <s-divider></s-divider>

        <s-stack direction="block" gap="none">
          <s-text>Successfully Fulfilled:{profileData.fulfilledCount}</s-text>
          <s-text>RTOs / Returns:{profileData.rtoCount}</s-text>
          <s-text>Cancellations / Unpaid:{profileData.cancelledCount + profileData.unpaidCount}</s-text>
          <s-text>Chargebacks:{profileData.disputeCount}</s-text>
        </s-stack>

        <s-divider></s-divider>

        <s-button onClick={() => {
            shopify["navigation"].navigate("shopify:admin/apps/new-risk-score/app/buyer-profile");
        }}>
          View Full Buyer's Profile
        </s-button>

      </s-stack>
    </s-admin-block>
  );
}