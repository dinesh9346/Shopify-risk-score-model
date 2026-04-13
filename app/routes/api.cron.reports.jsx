import prisma from "../db.server";
// Adjust the path to wherever your enqueueMerchantReport function lives
import { enqueueMerchantReport } from "../models/queue.server.js"; 

export async function action({ request }) {
  // 1. Security Check: Ensure the request has the correct Secret Key
  const authHeader = request.headers.get("Authorization");
  const CRON_SECRET = process.env.CRON_SECRET_KEY; 

  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Extract payload from cron-job.org
  const body = await request.json();
  const reportType = body.reportType || "weekly"; 

  try {
    console.log(`[CRON TRIGGER] Starting ${reportType} report dispatch...`);

    // 3. Get all active shops from your database
    const activeSessions = await prisma.session.findMany({
      where: { isOnline: false },
      select: { shop: true },
      distinct: ['shop']
    });

    let queuedCount = 0;

    // 4. Queue up a report for each shop
    for (const session of activeSessions) {
      await enqueueMerchantReport(session.shop, reportType);
      queuedCount++;
    }

    console.log(`[CRON TRIGGER] Successfully queued ${queuedCount} reports.`);
    return Response.json({ success: true, queued: queuedCount });

  } catch (error) {
    console.error("[CRON TRIGGER ERROR]", error);
    return Response.json({ error: "Failed to dispatch reports" }, { status: 500 });
  }
}