import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// Dynamically swapped by the Shopify CLI
/** @ts-ignore */
const APP_URL = process.env.APP_URL;

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  // Safely access the shopify API
  const shopifyApi = typeof shopify !== 'undefined' ? shopify : null;
  
  if (!shopifyApi) {
    console.error("[ERROR] Shopify API not available");
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-banner tone="critical">
          <s-text type="strong">Shopify API Not Available</s-text>
          <s-text>This extension requires the Shopify Admin UI context.</s-text>
        </s-banner>
      </s-admin-block>
    );
  }

  const { data } = shopifyApi;
  
  console.log("[DEBUG] shopify.data available:", !!data);
  console.log("[DEBUG] shopify.data type:", typeof data);
  console.log("[DEBUG] shopify.data keys:", data ? Object.keys(data) : 'null');
  console.log("[DEBUG] full shopify.data:", JSON.stringify(data, null, 2));
  
  // Try multiple ways to get the order ID
  /** @type {string | null} */
  let orderGid = null;
  /** @type {string | null} */
  let orderId = null;
  
  try {
    // Method 1: Direct data.id property (for order details blocks)
    /** @ts-ignore - data shape varies based on Shopify context */
    if (data?.id) {
      /** @ts-ignore */
      orderGid = String(data.id);
      console.log("[DEBUG] Found order ID via data.id:", orderGid);
    } 
    // Method 2: data.order object
    /** @ts-ignore - data shape varies based on Shopify context */
    else if (data?.order?.id) {
      /** @ts-ignore */
      orderGid = String(data.order.id);
      console.log("[DEBUG] Found order ID via data.order.id:", orderGid);
    }
    // Method 3: selected array (fallback)
    /** @ts-ignore - data shape varies based on Shopify context */
    else if (data?.selected?.[0]?.id) {
      /** @ts-ignore */
      orderGid = String(data.selected[0].id);
      console.log("[DEBUG] Found order ID via data.selected[0].id:", orderGid);
    }
    
    // Extract numeric ID from GraphQL ID (gid://shopify/Order/123456789)
    if (orderGid) {
      const extracted = orderGid.includes('/') ? orderGid.split('/').pop() : orderGid;
      orderId = extracted || null;
      console.log("[DEBUG] Extracted numeric orderId:", orderId);
    } else {
      console.warn("[DEBUG] Could not find order ID in data object");
      console.log("[DEBUG] data object keys available:", data ? Object.keys(data) : 'data is null/undefined');
    }
  } catch (err) {
    console.error("[ERROR] Exception while extracting order ID:", err);
  }

  const [loading, setLoading] = useState(true);
  const [riskData, setRiskData] = useState(null);
  const [error, setError] = useState('');

  // Log initial state
  useEffect(() => {
    console.log("[INIT] Component mounted with orderId:", orderId);
    console.log("[INIT] APP_URL:", APP_URL);
    console.log("[INIT] shopify object available:", typeof shopify !== 'undefined');
  }, []);

  useEffect(() => {
    let isMounted = true;
    /** @type {any} */
    let timeoutId;
    const maxAttempts = 8; 
    let attempt = 0;

    async function fetchRiskProfile() {
      if (!orderId || !isMounted) return;
      attempt++;
      
      console.log(`[FETCH-${attempt}] Attempting to fetch profile for orderId: ${orderId}`);
      console.log(`[FETCH-${attempt}] APP_URL: ${APP_URL}`);
      console.log(`[FETCH-${attempt}] Full URL: ${APP_URL}/api/buyer-profile?orderId=${encodeURIComponent(orderId)}`);

      try {
        // 1. Get auth token - Reverted back to the correct Admin UI Extension API
        if (!shopifyApi?.auth?.idToken) {
          throw new Error("shopifyApi.auth.idToken not available");
        }
        
        const token = await shopifyApi.auth.idToken();
        console.log(`[FETCH-${attempt}] Got auth token successfully`);
        
        const url = `${APP_URL}/api/buyer-profile?orderId=${encodeURIComponent(orderId)}`;
        console.log(`[FETCH-${attempt}] Fetching from URL: ${url}`);
        
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': 'true'
          },
        });

        console.log(`[FETCH-${attempt}] Response status: ${response.status}`);
        console.log(`[FETCH-${attempt}] Response OK: ${response.ok}`);
        
        if (response.ok) {
           const result = await response.json();
           console.log(`[FETCH-${attempt}] Response data:`, result);
           
           // 2. SUCCESS: Got data
           if (result.profile && isMounted) {
             setRiskData(result.profile);
             setLoading(false);
             console.log(`[FETCH-${attempt}] SUCCESS! Got profile data`);
             return; 
           } else {
             console.warn(`[FETCH-${attempt}] Response received but no profile in data`);
           }
        } else {
          const errorText = await response.text();
          console.error(`[FETCH-${attempt}] HTTP Error ${response.status}: ${errorText}`);
          setError(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
        }

        // 3. RACE CONDITION: Try again with backoff
        if (attempt < maxAttempts && isMounted) {
          const delay = Math.pow(2, attempt - 1) * 1000; 
          console.log(`[FETCH-${attempt}] Retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
          timeoutId = setTimeout(fetchRiskProfile, delay);
        } else if (isMounted) {
          console.warn(`[FETCH-${attempt}] Max attempts reached`);
          setLoading(false);
          if (!error) setError(`No data after ${maxAttempts} attempts`);
        }

      } catch (errorObj) {
        const errorMsg = errorObj instanceof Error ? errorObj.message : String(errorObj);
        console.error(`[FETCH-${attempt}] Error caught:`, errorMsg);
        setError(`Error (attempt ${attempt}): ${errorMsg}`);
        
        if (attempt < maxAttempts && isMounted) {
           const delay = Math.pow(2, attempt - 1) * 1000;
           console.log(`[FETCH-${attempt}] Retrying in ${delay}ms`);
           timeoutId = setTimeout(fetchRiskProfile, delay);
        } else if (isMounted) {
           console.warn(`[FETCH-${attempt}] Max attempts reached`);
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
  
  // Show error or loading state
  if (!orderId) {
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-banner tone="warning">
          <s-text type="strong">Order ID Not Found</s-text>
          <s-text>Unable to extract order ID from current page context.</s-text>
          <s-text>[DEBUG] orderGid: {orderGid || 'null'}</s-text>
        </s-banner>
      </s-admin-block>
    );
  }

  if (loading) {
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-text>Assessing buyer risk profile...</s-text>
        <s-text>[Order ID: {orderId}]</s-text>
      </s-admin-block>
    );
  }
  
  if (error && !riskData) {
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-banner tone="critical">
          <s-text type="strong">Failed to Load Profile</s-text>
          <s-text>{error}</s-text>
          <s-text>Order ID: {orderId}</s-text>
          <s-text>App URL: {APP_URL || 'NOT SET'}</s-text>
        </s-banner>
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
  
  // Create a clean, one-line message based on the segment
  let bannerMessage = `This buyer has been classified as a ${bannerTitle} customer.`;

  if (bannerTitle === "High Risk" || bannerTitle === "COD Abuser" || bannerTitle === "Watchlist") {
    bannerTone = "critical"; 
  } else if (bannerTitle === "VIP" || bannerTitle === "Repeat Buyer") {
    bannerTone = "success"; 
  } else if (bannerTitle === "New") {
    bannerTone = "auto"; 
    bannerMessage = "This is a new customer. Standard fulfillment processing.";
  }
  
  /**
   * Format amount as Indian currency
   * @param {number | null | undefined} amount - The amount to format
   * @returns {string} - The formatted currency string
   */
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

        <s-stack direction="block" gap="none">
          <s-text>Total Spend: {formatCurrency(profileData.totalSpend)}</s-text>
          <s-text>Order Placed: {profileData.totalorders}</s-text>
          <s-text>COD Orders: {profileData.codCount}</s-text>
        </s-stack>

        <s-divider></s-divider>

        <s-stack direction="block" gap="none">
          <s-text>Successfully Fulfilled: {profileData.fulfilledCount}</s-text>
          <s-text>RTOs / Returns: {profileData.rtoCount}</s-text>
          <s-text>Cancellations / Unpaid: {profileData.cancelledCount + profileData.unpaidCount}</s-text>
          <s-text>Chargebacks: {profileData.disputeCount}</s-text>
        </s-stack>

        <s-divider></s-divider>

        <s-button onClick={() => {
            if (orderId) {
              // FIXED TO USE SHOPIFY NAVIGATION API (retained fix)
              shopifyApi.navigation.navigate(`shopify:admin/apps/new-risk-score/app/buyer-profile?orderId=${encodeURIComponent(orderId)}`);
            }
        }}>
          View Full Buyer's Profile
        </s-button>

      </s-stack>
    </s-admin-block>
  );
}