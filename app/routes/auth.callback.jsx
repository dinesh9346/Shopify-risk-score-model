import { syncHistoricalOrders } from "../models/Sync.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  // Fire and forget: sync runs in background while user enters app
  syncHistoricalOrders(admin, session.shop).catch(console.error);

  return redirect("/");
};