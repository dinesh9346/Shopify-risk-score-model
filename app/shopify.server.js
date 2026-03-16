
import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  DeliveryMethod,
  BillingInterval,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { triggerBulkOrderSync } from "./models/Sync.server";
import { startQueueListener, startOutboundQueueListener } from "./models/queue.server.js";
export const MONTHLY_PLAN = 'Zippyy Pro Monthly';
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,

// BILLING: Simple monthly subscription for your app
  billing: {
    [MONTHLY_PLAN]: {
      lineItems: [
        {
          amount: 29.99,
          currencyCode: 'USD',
          interval: BillingInterval.Every30Days,
        }
      ]
    },
  },


hooks: {
  afterAuth: async ({ admin, session }) => {

    const shop = session.shop;

    console.log(`\n[AUTH] afterAuth hook triggered for: ${shop}`);

    try {
      // Register webhooks
      const result = await shopify.registerWebhooks({ session });
      console.log("Webhook registration result:", result);

    } catch (error) {
      console.error(`[AUTH] Error during afterAuth for ${shop}:`, error);
      // Don't throw - let auth complete even if webhooks/sync fail
    }

    const orderCount = await prisma.shopify_store_order.count({
      where: { shop },
    });

    if (orderCount === 0) {
      console.log(` First install detected for ${shop}. Starting bulk sync...`);
      await triggerBulkOrderSync(admin, shop);
    } else {
      console.log(` Orders already synced for ${shop}. Skipping bulk sync.`);
    }
  },
},
  // 🔹 2. WEBHOOKS: Keeps your local data warehouse updated in real-time
webhooks: {
  ORDERS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/orders/create",
  },

  ORDERS_UPDATED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/orders/updated",
  },

  BULK_OPERATIONS_FINISH: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/bulk/finish",
  },
  DISPUTES_CREATE: { 
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/disputes/create" 
    },
    DISPUTES_UPDATE: { 
      deliveryMethod: DeliveryMethod.Http, 
      callbackUrl: "/webhooks/disputes/updated" 
    },
    FULFILLMENTS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/fulfillments/create",
    },
    FULFILLMENTS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/fulfillments/updated",
    },
},
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});
// Boot up BOTH background workers safely
if (process.env.NODE_ENV === "production") {
  startQueueListener().catch(console.error);
  startOutboundQueueListener().catch(console.error);
} else {
  // In development, prevent Vite from starting 100 queues on every save
  if (!global.__queueListenerStarted) {
    global.__queueListenerStarted = true;
    startQueueListener().catch(console.error);
    startOutboundQueueListener().catch(console.error);
  }
}

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;