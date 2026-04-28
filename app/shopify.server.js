
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
import { startAllQueues } from "./models/queue.server.js";

// Call this once when your server boots up!
startAllQueues();
import { startScheduler } from "./models/scheduler.server.js";
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
      // 1. FETCH MERCHANT EMAIL VIA GRAPHQL
      // We do this first to ensure our Session table is populated for reports
      const response = await admin.graphql(
        `#graphql
        query getShopEmail {
          shop {
            email
            contactEmail
          }
        }`
      );
      
      const shopData = await response.json();
      const merchantEmail = shopData.data?.shop?.email || shopData.data?.shop?.contactEmail;

      if (merchantEmail) {
        await prisma.session.update({
          where: { id: session.id },
          data: { email: merchantEmail },
        });
        console.log(`[AUTH] Successfully saved email for ${shop}: ${merchantEmail}`);
      }

      // 2. REGISTER WEBHOOKS 
      const result = await shopify.registerWebhooks({ session });
      console.log("Webhook registration result:", result);

    } catch (error) {
      console.error(`[AUTH] Error during afterAuth data fetching/webhooks for ${shop}:`, error);
      // We don't throw here so the merchant can still enter the app if a non-critical sync fails
    }

    // 3. BULK SYNC LOGIC IS NOW MOVED TO DASHBOARD MANUAL SYNC
    console.log(`[AUTH] afterAuth hook completed for ${shop}. Bulk sync should be triggered manually from dashboard.`);
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
   CUSTOMERS_UPDATE: {
      deliveryMethod: "http",
      callbackUrl: "/webhooks/customers/update",
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
      callbackUrl: "/webhooks/fulfillments",
    },
    FULFILLMENTS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/fulfillments",
    },
    
 
  FULFILLMENT_EVENTS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/fulfillments",
  },

  RETURNS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/fulfillments",
  },
  RETURNS_CLOSE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/fulfillments",
  },
  REFUNDS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/fulfillments",
  },
},
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});
// Boot up ALL background workers safely
if (process.env.NODE_ENV === "production") {
  startQueueListener().catch(console.error);
  startOutboundQueueListener().catch(console.error);
  startScheduler();
} else {
  // In development, prevent Vite from starting 100 queues on every save
  if (!global.__queueListenerStarted) {
    global.__queueListenerStarted = true;
    startQueueListener().catch(console.error);
    startOutboundQueueListener().catch(console.error);
    startScheduler();
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