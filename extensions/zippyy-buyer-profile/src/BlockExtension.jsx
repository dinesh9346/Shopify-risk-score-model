import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// Dynamically swapped by the Shopify CLI
/** @ts-ignore */
const RAW_APP_URL = process.env.APP_URL;

// FIX: Strip the CLI port if it exists so ngrok doesn't crash
const APP_URL = RAW_APP_URL ? RAW_APP_URL.replace(/:\d+$/, '') : '';

console.log("[ZIPPYY-DEBUG] [GLOBAL] RAW_APP_URL from env:", RAW_APP_URL);
console.log("[ZIPPYY-DEBUG] [GLOBAL] Cleaned APP_URL used for fetch:", APP_URL);

export default async () => {
  console.log("[ZIPPYY-DEBUG] [MOUNT] Extension starting render...");
  render(<Extension />, document.body);
}

function Extension() {
  // Safely access the shopify API
  const shopifyApi = typeof shopify !== 'undefined' ? shopify : null;
  
  if (!shopifyApi) {
    console.error("[ZIPPYY-DEBUG] [ERROR] Shopify API not available");
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
  
  // Try multiple ways to get the order ID
  /** @type {string | null} */
  let orderGid = null;
  /** @type {string | null} */
  let orderId = null;
  
  try {
    // Method 1: Direct data.id property
    /** @ts-ignore */
    if (data?.id) {
      /** @ts-ignore */
      orderGid = String(data.id);
    } 
    // Method 2: data.order object
    /** @ts-ignore */
    else if (data?.order?.id) {
      /** @ts-ignore */
      orderGid = String(data.order.id);
    }
    // Method 3: selected array (fallback)
    /** @ts-ignore */
    else if (data?.selected?.[0]?.id) {
      /** @ts-ignore */
      orderGid = String(data.selected[0].id);
    }
    
    // Extract numeric ID
    if (orderGid) {
      const extracted = orderGid.includes('/') ? orderGid.split('/').pop() : orderGid;
      orderId = extracted || null;
      console.log("[ZIPPYY-DEBUG] [INIT] Extracted orderId:", orderId);
    } else {
      console.warn("[ZIPPYY-DEBUG] [INIT] Could not find order ID in data object");
    }
  } catch (err) {
    console.error("[ZIPPYY-DEBUG] [ERROR] Exception while extracting order ID:", err);
  }

  const [loading, setLoading] = useState(true);
  const [riskData, setRiskData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    console.log("[ZIPPYY-DEBUG] [EFFECT] Component mounted. orderId:", orderId);
    let isMounted = true;
    /** @type {any} */
    let timeoutId;
    const maxAttempts = 8; 
    let attempt = 0;

    async function fetchRiskProfile() {
      console.log(`[ZIPPYY-DEBUG] [FETCH-START] Attempt ${attempt + 1}. orderId exists? ${!!orderId}, isMounted? ${isMounted}`);
      
      if (!orderId || !isMounted) {
        console.log(`[ZIPPYY-DEBUG] [FETCH-ABORT] Missing orderId or component unmounted.`);
        return;
      }
      attempt++;
      
      try {
        console.log(`[ZIPPYY-DEBUG] [FETCH-${attempt}] Requesting auth token from Shopify...`);
        if (!shopifyApi?.auth?.idToken) {
          throw new Error("shopifyApi.auth.idToken not available");
        }
        
        // POTENTIAL FREEZE POINT 1: Getting the token
        const token = await shopifyApi.auth.idToken();
        console.log(`[ZIPPYY-DEBUG] [FETCH-${attempt}] Auth token received successfully!`);
        
        const url = `${APP_URL}/api/buyer-profile?orderId=${encodeURIComponent(orderId)}`;
        console.log(`[ZIPPYY-DEBUG] [FETCH-${attempt}] Initiating network fetch to: ${url}`);
        
        // POTENTIAL FREEZE POINT 2: The actual fetch
        const fetchStartTime = Date.now();
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': 'true'
          },
        });

        console.log(`[ZIPPYY-DEBUG] [FETCH-${attempt}] Network fetch completed in ${Date.now() - fetchStartTime}ms. Status: ${response.status}`);
        
        if (response.ok) {
           const result = await response.json();
           console.log(`[ZIPPYY-DEBUG] [FETCH-${attempt}] JSON parsed:`, result);
           
           if (result.profile && isMounted) {
             console.log(`[ZIPPYY-DEBUG] [SUCCESS] Profile found! Setting data and ending loading state.`);
             setRiskData(result.profile);
             setLoading(false); // ENDS LOADING
             return; 
           } else {
             console.warn(`[ZIPPYY-DEBUG] [FETCH-${attempt}] Request OK, but no profile object in response.`);
             if (isMounted) {
               setError(`API Error: No profile object in response.`);
               setLoading(false);
               return;
             }
           }
        } else {
          const errorText = await response.text();
          console.error(`[ZIPPYY-DEBUG] [FETCH-${attempt}] HTTP Error ${response.status}: ${errorText}`);
          if (isMounted) {
            setError(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
            setLoading(false); // ENDS LOADING IMMEDIATELY
            return;
          }
        }

      } catch (errorObj) {
        const errorMsg = errorObj instanceof Error ? errorObj.message : String(errorObj);
        console.error(`[ZIPPYY-DEBUG] [FETCH-${attempt}] Catch Block Error:`, errorMsg);
        if (isMounted) {
          setError(`Network/JSON Error: ${errorMsg}`);
          setLoading(false); // ENDS LOADING IMMEDIATELY
          return;
        }
      }
    }

    // Start the first fetch immediately
    fetchRiskProfile();

    // Cleanup
    return () => {
      console.log("[ZIPPYY-DEBUG] [CLEANUP] Component unmounting, clearing timeouts.");
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [orderId]);


  // UI RENDER LOGIC (Untouched)
  
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
              shopifyApi.navigation.navigate(`shopify:admin/apps/new-risk-score/app/buyer-profile?orderId=${encodeURIComponent(orderId)}`);
            }
        }}>
          View Full Buyer's Profile
        </s-button>
        

      </s-stack>
      
    </s-admin-block>
    
  );
}