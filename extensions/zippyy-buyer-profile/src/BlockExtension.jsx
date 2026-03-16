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
  const [profile, setProfile] = useState(null);

  const orderId = data?.selected?.[0]?.id;

  useEffect(() => {
    let isMounted = true;
    let pollCount = 0;
    const MAX_POLLS = 4; // Tries immediately, then up to 4 more times (8 seconds max)

    async function fetchRiskData() {
      if (!orderId || !isMounted) return;

      try {
        const token = await shopify.auth.idToken();

        const response = await fetch(`${APP_URL}/api/buyer-profile?orderId=${encodeURIComponent(orderId)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);

        const result = await response.json();
        
        // 1. SUCCESS: Profile found. Stop loading instantly.
        if (result.profile) {
          if (isMounted) {
            setProfile(result.profile);
            setLoading(false);
          }
        } 
        // 2. MISSING: Profile not found yet. Is it a new buyer or a slow webhook?
        else {
          pollCount++;
          if (pollCount <= MAX_POLLS) {
            // Webhook might still be saving to DB. Wait 2 seconds and ask again.
            setTimeout(fetchRiskData, 2000); 
          } else {
            // We tried 5 times. The DB is definitely empty. This is a First Time Buyer.
            if (isMounted) {
              setProfile(null);
              setLoading(false);
            }
          }
        }

      } catch (err) {
        console.error("Error fetching risk data:", err);
        if (isMounted) {
          setError(true);
          setLoading(false);
        }
      }
    }

    // Call immediately! No more 5-second artificial wait.
    fetchRiskData();

    // Cleanup: If the user closes the page before polling finishes, cancel it
    return () => {
      isMounted = false;
    };

  }, [orderId]);

  // For the first few seconds of polling, this will be the only thing the merchant sees
  if (loading) {
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-text>Connecting to Zippyy database</s-text>
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

  // If after all polling the DB still says there is no history, it really is a new buyer
  if (!profile) {
    return (
      <s-admin-block heading="Zippyy Buyer Profile">
        <s-stack direction="block" gap="none">
          <s-banner tone="info">
            <s-stack direction="block" gap="none">
              <s-text type="strong">First Time Buyer</s-text>
              <s-text>No previous history found. Standard fulfillment processing.</s-text>
            </s-stack>
          </s-banner>
          <s-divider></s-divider>
          <s-button onClick={() => {
            shopify["navigation"].navigate("shopify:admin/apps/new-risk-score/app/additional");
          }}>
            Open Zippyy Dashboard
          </s-button>
        </s-stack>
      </s-admin-block>
    );
  }

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount || 0);
  };

  /** @type {"critical" | "success" | "info" | "warning"} */
  let bannerTone = "info"; 
  let bannerMessage = "Standard fulfillment processing.";

  // --- START UPDATED SEGMENTATION LOGIC ---
  if (profile.buyerSegment === "High Risk") {
    bannerTone = "critical";
    bannerMessage = "Do not fulfill without review.";
  } else if (profile.buyerSegment === "Watchlist") {
    bannerTone = "warning";
    bannerMessage = "Review before fulfilling.";
  } else if (profile.buyerSegment === "VIP" || profile.buyerSegment === "Repeat Buyer") {
    bannerTone = "success"; 
    bannerMessage = "Excellent order history. Prioritize fulfillment.";
  } else {
    // This covers "New" or any other default state
    bannerTone = "info";
    bannerMessage = "Standard fulfillment processing.";
  }
  // --- END UPDATED SEGMENTATION LOGIC ---

  return (
    <s-admin-block heading="Zippyy Buyer Profile">
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
            <s-text>Cancellations:</s-text>
            <s-text type="strong">{profile.cancelledCount}</s-text>
          </s-stack>

        </s-stack>
        <s-divider></s-divider>

        <s-button onClick={() => {
            shopify["navigation"].navigate("shopify:admin/apps/new-risk-score/app/buyer-profile");
        }}>
            Full Buyer's Profile
        </s-button>

      </s-stack>
    </s-admin-block>
  );
}









// import "@shopify/ui-extensions/preact";
// import { render } from 'preact';
// import { useState, useEffect } from 'preact/hooks';

// // Dynamically swapped by the Shopify CLI
// const APP_URL = process.env.APP_URL;

// export default async () => {
//   render(<Extension />, document.body);
// }

// function Extension() {
//   const { data } = shopify;
  
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState(false);
//   const [profile, setProfile] = useState(null);

//   const orderId = data?.selected?.[0]?.id;

//   useEffect(() => {
//     let isMounted = true;
//     let pollCount = 0;
//     const MAX_POLLS = 4; // Tries immediately, then up to 4 more times (8 seconds max)

//     async function fetchRiskData() {
//       if (!orderId || !isMounted) return;

//       try {
//         const token = await shopify.auth.idToken();

//         const response = await fetch(`${APP_URL}/api/buyer-profile?orderId=${encodeURIComponent(orderId)}`, {
//           headers: {
//             Authorization: `Bearer ${token}`,
//             'Content-Type': 'application/json',
//           },
//         });

//         if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);

//         const result = await response.json();
        
//         // 1. SUCCESS: Profile found. Stop loading instantly.
//         if (result.profile) {
//           if (isMounted) {
//             setProfile(result.profile);
//             setLoading(false);
//           }
//         } 
//         // 2. MISSING: Profile not found yet. Is it a new buyer or a slow webhook?
//         else {
//           pollCount++;
//           if (pollCount <= MAX_POLLS) {
//             // Webhook might still be saving to DB. Wait 2 seconds and ask again.
//             setTimeout(fetchRiskData, 2000); 
//           } else {
//             // We tried 5 times. The DB is definitely empty. This is a First Time Buyer.
//             if (isMounted) {
//               setProfile(null);
//               setLoading(false);
//             }
//           }
//         }

//       } catch (err) {
//         console.error("Error fetching risk data:", err);
//         if (isMounted) {
//           setError(true);
//           setLoading(false);
//         }
//       }
//     }

//     // Call immediately! No more 5-second artificial wait.
//     fetchRiskData();

//     // Cleanup: If the user closes the page before polling finishes, cancel it
//     return () => {
//       isMounted = false;
//     };

//   }, [orderId]);

//   // For the first few seconds of polling, this will be the only thing the merchant sees
//   if (loading) {
//     return (
//       <s-admin-block heading="Zippyy Buyer Profile">
//         <s-text>Connecting to Zippyy database</s-text>
//       </s-admin-block>
//     );
//   }

//   if (error) {
//     return (
//       <s-admin-block heading="Zippyy Buyer Profile">
//         <s-banner tone="critical">
//           <s-text>Unable to load buyer profile at this time. Please check your connection.</s-text>
//         </s-banner>
//       </s-admin-block>
//     );
//   }

//   // If after all polling the DB still says there is no history, it really is a new buyer
//   if (!profile) {
//     return (
//       <s-admin-block heading="Zippyy Buyer Profile">
//         <s-stack direction="block" gap="none">
//           <s-banner tone="info">
//             <s-stack direction="block" gap="none">
//               <s-text type="strong">First Time Buyer</s-text>
//               <s-text>No previous history found. Standard fulfillment processing.</s-text>
//             </s-stack>
//           </s-banner>
//           <s-divider></s-divider>
//           <s-button onClick={() => {
//             shopify["navigation"].navigate("shopify:admin/apps/new-risk-score/app/additional");
//           }}>
//             Open Zippyy Dashboard
//           </s-button>
//         </s-stack>
//       </s-admin-block>
//     );
//   }

//   const formatCurrency = (amount) => {
//     return new Intl.NumberFormat("en-IN", {
//       style: "currency",
//       currency: "INR",
//       minimumFractionDigits: 0,
//       maximumFractionDigits: 2,
//     }).format(amount || 0);
//   };

//   /** @type {"critical" | "success" | "info" | "warning"} */
//   let bannerTone = "info"; 
//   let bannerMessage = "Standard fulfillment processing.";

//   // LOGIC TO CHECK FOR "HIGH RISK" HAS BEEN REMOVED
  
//   if (profile.buyerSegment === "VIP" || profile.buyerSegment === "Repeat Buyer") {
//     bannerTone = "success"; 
//     bannerMessage = "Excellent order history. Prioritize fulfillment.";
//   }

//   return (
//     <s-admin-block heading="Zippyy Buyer Profile">
//       <s-stack direction="block">
        
//         <s-banner tone={bannerTone}>
//           <s-stack direction="block" gap="none">
//             <s-text type="strong">{profile.buyerSegment} Customer</s-text>
//             <s-text>{bannerMessage}</s-text>
//           </s-stack>
//         </s-banner>

//         <s-stack direction="block" gap="none">
//           <s-stack direction="inline" inline-alignment="space-between">
//             <s-text>Total Spend (Valid):</s-text>
//             <s-text type="strong">{formatCurrency(profile.totalSpend)}</s-text> 
//           </s-stack>

//           <s-stack direction="inline" inline-alignment="space-between">
//             <s-text>Valid Orders:</s-text>
//             <s-text type="strong">{profile.validOrderCount}</s-text>
//           </s-stack>
          
//           <s-stack direction="inline" inline-alignment="space-between">
//             <s-text>Checkout Attempts:</s-text>
//             <s-text type="strong">{profile.totalCheckoutAttempts}</s-text>
//           </s-stack>
//         </s-stack>

//         <s-divider></s-divider>
//          <s-stack direction="block" gap="none">
//           <s-stack direction="inline" inline-alignment="space-between">
//             <s-text>COD Orders:</s-text>
//             <s-text type="strong">{profile.codCount}</s-text>
//           </s-stack>

//           <s-stack direction="inline" inline-alignment="space-between">
//             <s-text>Successfully Fulfilled:</s-text>
//             <s-text type="strong">{profile.fulfilledCount}</s-text>
//           </s-stack>

//           <s-stack direction="inline" inline-alignment="space-between">
//             <s-text>RTOs / Returns:</s-text>
//             <s-text type="strong">{profile.rtoCount}</s-text>
//           </s-stack>

//           <s-stack direction="inline" inline-alignment="space-between">
//             <s-text>Cancellations:</s-text>
//             <s-text type="strong">{profile.cancelledCount}</s-text>
//           </s-stack>

//         </s-stack>
//         <s-divider></s-divider>

//         <s-button onClick={() => {
//             shopify["navigation"].navigate("shopify:admin/apps/new-risk-score/app/buyer-profile");
//         }}>
//             Full Buyer's Profile
//         </s-button>

//       </s-stack>
//     </s-admin-block>
//   );
// }










