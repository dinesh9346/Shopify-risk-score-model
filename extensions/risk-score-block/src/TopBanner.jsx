import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// Shopify passes the API object directly into this function
export default async (api) => {
  render(<Extension api={api} />, document.body);
}

function Extension({ api }) {
  // Access data and extension target from the passed api
  const { data, extension } = api;
  const [riskData, setRiskData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRiskScore() {
      // The order ID is inside data.selected
      const orderId = data?.selected?.[0]?.id;
      if (!orderId) {
        setLoading(false);
        return;
      }

      try {
        const query = {
          query: `query GetRisk($id: ID!) {
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
          body: JSON.stringify(query)
        });

        const json = await response.json();
        const order = json?.data?.order;
        
        if (order?.level?.value) {
          setRiskData({
            level: order.level.value,
            score: order.score.value,
            reasons: order.reasons.value ? order.reasons.value.split(" | ") : []
          });
        }
      } catch (error) {
        console.error("Fetch error:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchRiskScore();
  }, [data]);

  if (loading || !riskData) return null;

  const isHighRisk = riskData.level === "HIGH";

  // Identify where this specific instance is rendering
  const isTopBannerLocation = extension.target === "admin.order-details.location.render";

  // --- RENDER 1: THE TOP WARNING BANNER ---
  if (isTopBannerLocation) {
    if (!isHighRisk) return null; // Hide if not high risk
    return (
      <s-banner tone="critical">
        <s-text type="strong">High Risk Order: </s-text>
        <s-text>Zippyy detected potential fraud. Review reasons in the risk block below.</s-text>
      </s-banner>
    );
  }

  // --- RENDER 2: THE SIDEBAR BLOCK ---
  return (
    <s-admin-block heading="Zippyy Risk Score dinesh">
      <s-stack direction="block" gap="base">
        
        <s-banner tone={isHighRisk ? "critical" : "success"}>
           <s-text type="strong">Status: {riskData.level}</s-text>
        </s-banner>

        <s-divider />

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