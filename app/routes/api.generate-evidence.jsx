
import { authenticate } from "../shopify.server";
import { compileDisputeEvidence } from "../models/evidence.server";

// API route for generating dispute evidence
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const disputeId = url.searchParams.get("disputeId");

  if (!disputeId) {
    return Response.json({ error: "Missing disputeId parameter" }, { status: 400 });
  }

  try {
    const evidencePayload = await compileDisputeEvidence(shop, disputeId);
    return Response.json({ evidencePayload });
  } catch (error) {
    console.error("Failed to generate evidence:", error);
    return Response.json({
      error: "Error generating evidence. Ensure the dispute exists in the database.",
      details: error.message
    }, { status: 500 });
  }
};