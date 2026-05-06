import prisma from "../db.server.js";

export async function addTagToShopifyOrder(shop, orderId, tag) {
  try {
    const session = await prisma.session.findFirst({ 
      where: { shop: shop, isOnline: false },
      orderBy: { expires: 'desc' }
    });
    
    if (!session || !session.accessToken) {
      console.error(`[Shopify Tags] No active offline session found for shop ${shop}`);
      return false;
    }

    const formattedId = String(orderId).includes("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
    
    const query = `
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { message field }
        }
      }
    `;

    const response = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables: { id: formattedId, tags: [tag] } }),
    });

    const data = await response.json();
    
    if (data.errors && data.errors.length > 0) {
      console.error(`[Shopify Tags] GraphQL Error:`, JSON.stringify(data.errors, null, 2));
      return false;
    }
    
    if (data.data?.tagsAdd?.userErrors?.length > 0) {
      console.error(`[Shopify Tags] User Error:`, data.data.tagsAdd.userErrors);
      return false;
    }

    console.log(`[Shopify Tags] Successfully added tag '${tag}' to order ${formattedId}`);
    return true;
  } catch (error) {
    console.error(`[Shopify Tags] Exception adding tag:`, error);
    return false;
  }
}
