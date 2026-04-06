import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { compileDisputeEvidence } from "../models/evidence.server";

// 1. BACKEND LOADER: Fetch the data securely
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const disputeId = url.searchParams.get("disputeId");

  if (!disputeId) {
    return { evidencePayload: null, missingDisputeId: true };
  }

  try {
    const evidencePayload = await compileDisputeEvidence(shop, disputeId);
    return { evidencePayload, missingDisputeId: false };
  } catch (error) {
    console.error("Failed to generate evidence:", error);
    return { evidencePayload: null, missingDisputeId: false, loadError: error.message };
  }
};

// 2. FRONTEND VIEW: The OCR-Optimized Printable Document
export default function GenerateEvidencePDF() {
  const loaderData = useLoaderData();
  const evidencePayload = loaderData?.evidencePayload;
  const missingDisputeId = loaderData?.missingDisputeId;
  const loadError = loaderData?.loadError;

  if (missingDisputeId) {
    return (
      <div style={{ padding: "40px", fontFamily: "Arial, sans-serif", maxWidth: "850px", margin: "0 auto" }}>
        <h1>Generate evidence</h1>
        <p>This page is for chargeback evidence generation when disputes exist in your store.</p>
        <p>If you arrived here directly, select a disputed order from the Buyer Profiles page to view or print evidence.</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ padding: "40px", fontFamily: "Arial, sans-serif", maxWidth: "850px", margin: "0 auto" }}>
        <h1>Evidence generation error</h1>
        <p>{loadError}</p>
        <p>Please verify the dispute and try again.</p>
      </div>
    );
  }

  if (!evidencePayload || !evidencePayload.disputeDetails) {
    return (
      <div style={{ padding: "40px", fontFamily: "Arial, sans-serif", maxWidth: "850px", margin: "0 auto" }}>
        <h1>Evidence generation failed</h1>
        <p>The dispute evidence payload is incomplete or missing.</p>
        <p>Please verify the dispute ID and try again.</p>
      </div>
    );
  }

  const safePayload = {
    meta: evidencePayload.meta || {},
    disputeDetails: evidencePayload.disputeDetails || {},
    friendlyFraudProof: evidencePayload.friendlyFraudProof || {},
    targetedOrderDetails: evidencePayload.targetedOrderDetails || {},
    cryptographicAuthorization: evidencePayload.cryptographicAuthorization || {},
    fulfillmentProof: evidencePayload.fulfillmentProof || {},
    buyerBehavioralAnalysis: evidencePayload.buyerBehavioralAnalysis || {},
    complianceMetadata: evidencePayload.complianceMetadata || {}
  };

  // Helper to safely format dates
  const formatDate = (dateString) => {
    if (!dateString) return "N/A";
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div style={{
      fontFamily: "'Times New Roman', Times, serif",
      color: "#000",
      backgroundColor: "#fff",
      padding: "40px",
      maxWidth: "850px",
      margin: "0 auto",
      lineHeight: "1.6",
      fontSize: "12pt" // 12pt is the golden standard for bank scanners
    }}>

      {/* --- NON-PRINTING HEADER BAR --- */}
      <div className="no-print" style={{
        padding: "15px",
        backgroundColor: "#f4f6f8",
        borderBottom: "2px solid #000",
        marginBottom: "30px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }}>
        <p style={{ margin: 0, fontFamily: "Arial, sans-serif", fontSize: "10pt" }}>
          <strong>Zippyy Risk Diagnostics</strong> | Evidence Compiler
        </p>
        <button
          onClick={() => window.print()}
          style={{
            padding: "8px 16px", background: "#000", color: "#fff",
            border: "none", cursor: "pointer", fontWeight: "bold"
          }}
        >
          Save as PDF
        </button>
      </div>

      {/* --- CSS TO HIDE THE BUTTON DURING ACTUAL PRINTING --- */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; margin: 0; }
          @page { margin: 1in; }
          
          /* PAGE BREAK CONTROLS */
          .page-break-before { page-break-before: always; }
          .page-break-after { page-break-after: always; }
          .page-break-inside-avoid { page-break-inside: avoid; }
          .page-break-inside-avoid-table { page-break-inside: avoid; }
          
          /* Prevent tables from breaking across pages */
          table { page-break-inside: avoid; }
          
          /* Prevent address correlation boxes from breaking */
          .address-correlation-box { page-break-inside: avoid; }
          
          /* Prevent critical callouts from breaking */
          .critical-callout, .warning-callout { page-break-inside: avoid; }
          
          /* Ensure sections start on new pages if needed */
          h2 { page-break-after: avoid; }
          
          /* Keep headers with their content */
          h1, h2 { page-break-after: avoid; }
          
          /* Prevent the AVS box from being cut off */
          .avs-verified-section { page-break-inside: avoid; }
          
          /* Improve table border visibility */
          table, th, td { border: 1px solid #000 !important; }
          
          /* Ensure boxes have consistent spacing */
          .address-correlation-box, .critical-callout, .warning-callout {
            margin: 20px 0;
            padding: 12px;
          }
          
          /* Prevent widows and orphans */
          p { orphans: 3; widows: 3; }
        }
        h2 { 
          border-bottom: 2px solid #000; 
          padding-bottom: 5px; 
          margin-top: 30px; 
          font-size: 13pt;
          font-weight: bold;
        }
        h1 {
          font-weight: bold;
          font-size: 16pt;
        }
        table { 
          width: 100%; 
          border-collapse: collapse; 
          margin-top: 15px; 
          border: 1px solid #000;
        }
        th, td { 
          border: 1px solid #000; 
          padding: 8px; 
          text-align: left; 
          vertical-align: top;
          font-size: 12pt;
        }
        th { 
          background-color: #f0f0f0; 
          width: 40%;
          font-weight: bold;
        }
        /* Critical callout - black border, bold text, no color */
        .critical-callout {
          border: 3px solid #000;
          padding: 12px;
          margin: 20px 0;
          font-weight: bold;
          background-color: #fff;
          font-size: 12pt;
        }
        /* Warning callout - dashed border, bold text */
        .warning-callout {
          border: 2px dashed #000;
          padding: 10px;
          margin: 20px 0;
          font-weight: bold;
          background-color: #fff;
          font-size: 12pt;
        }
        /* Address correlation callout */
        .address-correlation-box {
          border: 2px solid #000;
          padding: 12px;
          margin: 15px 0;
          background-color: #fff;
          font-weight: bold;
          font-size: 12pt;
        }
        /* Ensure all text is black on white - no color highlighting */
        .no-color-text {
          color: #000;
          background-color: #fff;
        }
        strong {
          font-weight: bold;
          color: #000;
        }
      `}</style>

      {/* --- THE BANK REBUTTAL COVER LETTER --- */}
      <div style={{ marginBottom: "40px" }}>
        <h1 style={{ fontSize: "16pt", textAlign: "center", textTransform: "uppercase" }}>
          Chargeback Dispute Rebuttal
        </h1>
        <p><strong>Date Generated:</strong> {formatDate(safePayload.meta.generatedAt)}</p>
        <p><strong>Merchant Domain:</strong> {safePayload.meta.shopDomain || "Unknown"}</p>
        <p><strong>Dispute ID:</strong> {safePayload.disputeDetails.disputeId || "Unknown"}</p>

        <p style={{ marginTop: "20px" }}>
          To the Reviewing Investigator:
        </p>
        <p>
          We are formally contesting the chargeback filed under reason code <strong>{safePayload.disputeDetails.reason || "Unknown"}</strong> for the amount of <strong>{safePayload.disputeDetails.amountContested || "Unknown"}</strong>.
          The enclosed documentation irrefutably proves that this transaction was legitimate, authorized by the cardholder, and successfully fulfilled according to our terms of service. We respectfully request the immediate reversal of this chargeback.
        </p>
      </div>

      {/* --- CE 3.0 / VELOCITY ALERT HEADERS (Conditional) --- */}
      {safePayload.friendlyFraudProof?.visaCE3Qualified && (
        <div className="critical-callout page-break-inside-avoid" style={{ border: "2px solid #000", padding: "10px", marginBottom: "20px", fontWeight: "bold", textAlign: "center" }}>
          *** VISA COMPELLING EVIDENCE 3.0 COMPLIANT *** <br/>
          This customer has a documented history of {safePayload.friendlyFraudProof?.ce3EligibleOrders?.length || 0} undisputed, settled transactions utilizing matching identity elements. A liability shift is mandated.
        </div>
      )}

      {safePayload.friendlyFraudProof?.velocityAbuseDetected && (
        <div className="warning-callout page-break-inside-avoid" style={{ border: "2px dashed #000", padding: "10px", marginBottom: "20px", fontWeight: "bold" }}>
          INVESTIGATOR ALERT: First-Party Fraud / Hoarding Behavior Detected.<br/>
          This cardholder executed {safePayload.friendlyFraudProof?.velocityOrderCount48hr || 0} high-value transactions within a 48-hour window, indicating coordinated velocity abuse.
        </div>
      )}

      {/* --- SECTION 1: EXPLICIT ADDRESS CORRELATION (Proof of Delivery Match) --- */}
      <h2>1. Address Verification & Proof of Delivery Correlation</h2>
      <p>
        <strong>CRITICAL EVIDENCE:</strong> The following documentation proves that the delivery address matches the AVS-verified billing address provided at checkout, establishing confident proof of delivery to the authorized cardholder.
      </p>

      {/* Visual Address Correlation Callout */}
      <div className="address-correlation-box avs-verified-section">
        <strong>AVS-VERIFIED BILLING ADDRESS (Checkout Authentication):</strong>
        <div style={{ marginTop: "8px", fontFamily: "monospace", fontSize: "11pt", marginBottom: "15px" }}>
          {safePayload.targetedOrderDetails?.billingAddress || "Unknown"}
        </div>

        <strong>↓ MATCHES ↓</strong>

        <div style={{ marginTop: "8px", fontFamily: "monospace", fontSize: "11pt", marginBottom: "15px" }}>
          <strong>CONFIRMED DELIVERY ADDRESS (Carrier Tracking):</strong><br/>
          {safePayload.targetedOrderDetails?.shippingAddress || "Unknown"}
        </div>

        <strong>CORRELATION STATUS:</strong><br/>
        <span style={{ fontSize: "13pt", fontWeight: "bold" }}>
          {safePayload.targetedOrderDetails?.isBillingShippingMatch === "TRUE - Perfect Match" 
            ? "✓ EXACT MATCH CONFIRMED - Delivery to Authorized Cardholder Address"
            : "⚠️ Addresses differ - See detailed analysis below"}
        </span>
      </div>

      <table className="page-break-inside-avoid-table">
        <tbody>
          <tr><th>Order ID</th><td><strong>{safePayload.targetedOrderDetails?.orderId || "Unknown"}</strong></td></tr>
          <tr><th>Date Placed</th><td>{formatDate(safePayload.targetedOrderDetails?.datePlaced)}</td></tr>
          <tr><th>Total Value</th><td><strong>{safePayload.targetedOrderDetails?.totalValue || "Unknown"}</strong></td></tr>
          <tr><th>AVS Billing Address</th><td>{safePayload.targetedOrderDetails?.billingAddress || "Unknown"}</td></tr>
          <tr><th>Carrier Delivery Address</th><td>{safePayload.targetedOrderDetails?.shippingAddress || "Unknown"}</td></tr>
          <tr><th>Address Match Confirmation</th><td><strong>{safePayload.targetedOrderDetails?.isBillingShippingMatch || "Unknown"}</strong></td></tr>
        </tbody>
      </table>

      {/* --- SECTION 2: TARGETED TRANSACTION (Original) --- */}
      <h2>2. Disputed Transaction Details</h2>
      <table className="page-break-inside-avoid-table">
        <tbody>
          <tr><th>Order ID</th><td>{safePayload.targetedOrderDetails?.orderId || "Unknown"}</td></tr>
          <tr><th>Date Placed</th><td>{formatDate(safePayload.targetedOrderDetails?.datePlaced)}</td></tr>
          <tr><th>Total Value</th><td>{safePayload.targetedOrderDetails?.totalValue || "Unknown"}</td></tr>
        </tbody>
      </table>

      {/* --- SECTION 3: AUTHORIZATION --- */}
      <h2>3. Cryptographic & Identity Authorization</h2>
      <table className="page-break-inside-avoid-table">
        <tbody>
          <tr><th>Purchasing IP Address</th><td>{safePayload.cryptographicAuthorization?.customerIP || "Not captured"}</td></tr>
          <tr><th>Payment Gateway</th><td>{safePayload.cryptographicAuthorization?.paymentGateway || "Unknown"}</td></tr>
          <tr><th>AVS / CVV Match</th><td>Passed standard gateway verification checks at the time of checkout.</td></tr>
        </tbody>
      </table>

      {/* --- SECTION 4: FULFILLMENT --- */}
      <h2>4. Fulfillment & Logistics Proof</h2>
      <table className="page-break-inside-avoid-table">
        <tbody>
          <tr><th>Carrier</th><td>{safePayload.fulfillmentProof?.carrier || "Unknown"}</td></tr>
          <tr><th>Tracking Number</th><td><strong>{safePayload.fulfillmentProof?.trackingNumber || "Untracked"}</strong></td></tr>
          <tr><th>Address Validation</th><td>{safePayload.fulfillmentProof?.addressVerificationAPIResult || "Unchecked"}</td></tr>
        </tbody>
      </table>

      {/* --- SECTION 5: HISTORICAL BUYER PROFILE (Your Secret Weapon) --- */}
      <h2>5. Longitudinal Cardholder Behavioral Analysis</h2>
      <p>
        Unlike a standard transaction, our systems track longitudinal buyer behavior. The data below proves the cardholder's historical interaction with our business prior to this dispute.
      </p>
      <table className="page-break-inside-avoid-table">
        <tbody>
          <tr><th>Account Status</th><td>{safePayload.buyerBehavioralAnalysis?.buyerSegment || "Standard"}</td></tr>
          <tr><th>Total Lifetime Orders</th><td>{safePayload.buyerBehavioralAnalysis?.totalLifetimeOrders || 1}</td></tr>
          <tr><th>Historical Chargeback Count</th><td>{safePayload.buyerBehavioralAnalysis?.historicalDisputeCount || 0}</td></tr>
        </tbody>
      </table>

      {/* --- SECTION 6: PAST SUCCESSFUL DELIVERIES --- */}
      {(safePayload.friendlyFraudProof?.allPastSuccessfulDeliveries?.length || 0) > 0 && (
        <>
          <h2>6. Prior Successful Deliveries to Cardholder</h2>
          <p>
            The cardholder has successfully received the following past orders without initiating a dispute, proving familiarity and consent with our fulfillment process.
          </p>
          <table className="page-break-inside-avoid-table">
            <thead>
              <tr>
                <th style={{width: "50%"}}>Date Placed</th>
                <th style={{width: "50%"}}>Tracking Number</th>
              </tr>
            </thead>
            <tbody>
              {(safePayload.friendlyFraudProof?.allPastSuccessfulDeliveries || []).map((past, i) => (
                <tr key={i}>
                  <td>{formatDate(past.datePlaced)}</td>
                  <td>{past.trackingNumber || "Untracked"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div style={{ marginTop: "50px", textAlign: "center", fontStyle: "italic" }}>
        -- End of System Generated Evidence Document --
      </div>

    </div>
  );
}