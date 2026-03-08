import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { triggerBulkOrderSync } from "../models/Sync.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  triggerBulkOrderSync(admin, session.shop).catch(console.error);

  return redirect("/");
};