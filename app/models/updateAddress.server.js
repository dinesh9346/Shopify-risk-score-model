import shopify from "../shopify.server";

const UPDATE_ADDRESS_MUTATION = `
  mutation orderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        shippingAddress {
          address1
          city
          province
          zip
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function updateShopifyOrderAddress(shop, shopifyOrderId, newAddress) {
  // Use unauthenticated admin since the customer is triggering this outside Shopify Admin
  const { admin } = await shopify.unauthenticated.admin(shop);

  const response = await admin.graphql(UPDATE_ADDRESS_MUTATION, {
    variables: {
      input: {
        id: `gid://shopify/Order/${shopifyOrderId}`,
        shippingAddress: newAddress
      }
    }
  });

  const responseJson = await response.json();
  
  if (responseJson.data.orderUpdate.userErrors.length > 0) {
    console.error("Shopify GraphQL Errors:", responseJson.data.orderUpdate.userErrors);
    throw new Error("Failed to update address in Shopify");
  }

  return responseJson.data.orderUpdate.order;
}