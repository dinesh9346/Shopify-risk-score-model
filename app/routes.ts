export default [
  {
    path: "/",
    file: "routes/_index/route.jsx",
  },
  {
    path: "/app",
    file: "routes/app.jsx",
    children: [
      {
        path: "/app/",
        file: "routes/app._index.jsx",
      },
      {
        path: "/app/analytics",
        file: "routes/app.analytics.jsx",
      },
      {
        path: "/app/assessments",
        file: "routes/app.assessments.jsx",
      },
      {
        path: "/app/buyer-profile",
        file: "routes/app.buyer-profile.jsx",
      },
      {
        path: "/app/generate-evidence",
        file: "routes/app.generate-evidence.jsx",
      },
      {
        path: "/app/pricing",
        file: "routes/app.pricing.jsx",
      },
      {
        path: "/app/risk-engine",
        file: "routes/app.risk-engine.jsx",
      },
    ],
  },
  {
    path: "/api/buyer-profile",
    file: "routes/api.buyer-profile.jsx",
  },
  {
    path: "/api/generate-evidence",
    file: "routes/api.generate-evidence.jsx",
  },
  {
    path: "/auth",
    file: "routes/auth.$.jsx",
    children: [
      {
        path: "/auth/callback",
        file: "routes/auth.callback.jsx",
      },
      {
        path: "/auth/login",
        file: "routes/auth.login/route.jsx",
      },
    ],
  },
  {
    path: "/webhooks/app/scopes_update",
    file: "routes/webhooks.app.scopes_update.jsx",
  },
  {
    path: "/webhooks/app/uninstalled",
    file: "routes/webhooks.app.uninstalled.jsx",
  },
  {
    path: "/webhooks/bulk/finish",
    file: "routes/webhooks.bulk.finish.js",
  },
  {
    path: "/webhooks/customers/update",
    file: "routes/webhooks.customers.update.jsx",
  },
  {
    path: "/webhooks/disputes/create",
    file: "routes/webhooks.disputes.create.jsx",
  },
  {
    path: "/webhooks/disputes/updated",
    file: "routes/webhooks.disputes.updated.jsx",
  },
  {
    path: "/webhooks/fulfillments",
    file: "routes/webhooks.fulfillments.jsx",
  },
  {
    path: "/webhooks/orders/create",
    file: "routes/webhooks.orders.create.jsx",
  },
  {
    path: "/webhooks/orders/updated",
    file: "routes/webhooks.orders.updated.jsx",
  },
];
