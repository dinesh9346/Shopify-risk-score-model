import shopify from "../shopify.server.js";

export async function pushRiskToShopify(shop, orderId, riskLevel, riskFacts) {
  console.log(`[SHOPIFY API] Pushing ${riskLevel} risk assessment to order ${orderId}...`);

  // 1. Generate the background offline admin client
  const { admin } = await shopify.unauthenticated.admin(shop);

  // 2. The Native Fraud Assessment Mutation (EXACTLY from your working reference)
  const riskAssessmentMutation = `
    mutation CreateRiskAssessment($input: OrderRiskAssessmentCreateInput!) {
      orderRiskAssessmentCreate(orderRiskAssessmentInput: $input) {
        userErrors { message }
      }
    }
  `;

  // 3. The Tag Mutation
  const addTagMutation = `
    mutation addTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { message }
      }
    }
  `;

  try {
    // --- STEP A: PUSH NATIVE RISK ASSESSMENT ---
    const assessmentResponse = await admin.graphql(riskAssessmentMutation, {
      variables: { 
        input: { 
          orderId: orderId, 
          riskLevel: riskLevel, 
          facts: riskFacts 
        } 
      }
    });

    const assessmentData = await assessmentResponse.json();
    
    if (assessmentData.data?.orderRiskAssessmentCreate?.userErrors?.length > 0) {
      console.error(" [SHOPIFY API] Native Risk Error:", assessmentData.data.orderRiskAssessmentCreate.userErrors);
    } else {
      console.log(` [SHOPIFY API] Native Risk Block created for ${orderId}`);
    }

    // --- STEP B: ADD ORDER TAG ---
    const riskTag = `Zippyy: ${riskLevel} Risk`;
    const tagResponse = await admin.graphql(addTagMutation, {
      variables: { 
        id: orderId, 
        tags: [riskTag] 
      }
    });

    const tagData = await tagResponse.json();
    if (tagData.data?.tagsAdd?.userErrors?.length > 0) {
      console.error(" [SHOPIFY API] Tagging Error:", tagData.data.tagsAdd.userErrors);
    } else {
      console.log(` [SHOPIFY API] Tag added: ${riskTag}`);
    }

  } catch (error) {
    console.error(` [SHOPIFY API ERROR] Background push failed:`, error);
    // Throwing ensures the SQS message stays in the queue for a retry if the API was down
    throw error; 
  }
}