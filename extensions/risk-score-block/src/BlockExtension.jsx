// import "@shopify/ui-extensions/preact";
// import {render} from 'preact';

// export default async () => {
//   render(<Extension />, document.body);
// }

// function Extension() {
//   const {i18n, data, extension: {target}} = shopify;
//   console.log({data});

//   return (
//     <s-admin-block heading="My Block Extension">
//       <s-stack direction="block">
//         <s-text type="strong">{i18n.translate('welcome', {target})}</s-text>
//       </s-stack>
//     </s-admin-block>
//   );
// }
//2


import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  const { data } = shopify;
  const [riskData, setRiskData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRiskScore() {
      const orderId = data?.selected?.[0]?.id;
      if (!orderId) {
        setLoading(false);
        return;
      }

      try {
        const getOrderQuery = {
          query: `query GetRiskMetafields($id: ID!) {
            order(id: $id) {
              level: metafield(namespace: "risk_assessment", key: "level") { value }
              score: metafield(namespace: "risk_assessment", key: "score") { value }
              reasons: metafield(namespace: "risk_assessment", key: "reasons") { value }
            }
          }`,
          variables: { id: orderId }
        };

        const response = await fetch("shopify:admin/api/graphql.json", {
          method: "POST",
          body: JSON.stringify(getOrderQuery)
        });

        const json = await response.json();
        const order = json?.data?.order;
        
        if (order?.level?.value) {
          setRiskData({
            level: order.level.value,
            score: order.score.value,
            reasons: order.reasons.value.split(" | ") 
          });
        }
      } catch (error) {
        console.error("Error fetching risk score:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchRiskScore();
  }, [data]);

  if (loading) return <s-admin-block heading="Zippyy Risk Score"><s-text>Loading assessment...</s-text></s-admin-block>;
  if (!riskData) return <s-admin-block heading="Zippyy Risk Score"><s-text>No assessment data found.</s-text></s-admin-block>;

  // Map levels to simple Shopify tones
  const bannerTone = riskData.level === "HIGH" ? "critical" 
                   : riskData.level === "MEDIUM" ? "warning" 
                   : "success";

  return (
    <s-admin-block heading="Zippyy Risk Score">
      <s-stack direction="block" gap="base">
        
        {/* Color-coded Banner representing the bar in your screenshot */}
        <s-banner tone={bannerTone}>
           <s-text type="strong">Current Risk Level: {riskData.level}</s-text>
        </s-banner>

        {/* Labels for Low, Medium, High */}
        <s-stack direction="inline" gap="base">
           <s-text color={riskData.level === "LOW" ? "subdued" : "subdued"}>Low</s-text>
           <s-text color={riskData.level === "MEDIUM" ? "subdued" : "subdued"}>Medium</s-text>
           <s-text color={riskData.level === "HIGH" ? "subdued" : "subdued"}>High</s-text>
        </s-stack>

        <s-divider />

        {/* Reasons list */}
        <s-stack direction="block">
          <s-text type="strong">Analysis Reasons:</s-text>
          {riskData.reasons.map((reason, index) => (
            <s-text key={index}>• {reason}</s-text>
          ))}
        </s-stack>

      </s-stack>
    </s-admin-block>
  );
}