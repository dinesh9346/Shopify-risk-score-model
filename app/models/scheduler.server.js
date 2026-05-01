import cron from 'node-cron';
import prisma from '../db.server.js';
import { enqueueMerchantReport } from './queue.server.js';
import { generateAndSendMLPerformanceReport } from '../utils/mlPerformanceReport.server.js';

export function startScheduler() {
  // Prevent duplicate cron jobs during hot-reloading in development
  if (process.env.NODE_ENV !== 'production' && global.__schedulerStarted) {
    console.log('[SCHEDULER] Already running, skipping duplicate start.');
    return;
  }
  global.__schedulerStarted = true;

  console.log('[SCHEDULER] Internal job scheduler started.');

  // Weekly Schedule: Every Sunday at 10:00 AM
  cron.schedule('0 10 * * 0', async () => {
    console.log('[SCHEDULER] Running weekly merchant report cron job...');
    try {
      // 1. Fetch all active shops
      const activeSessions = await prisma.session.findMany({
        where: { isOnline: false },
        select: { shop: true },
        distinct: ['shop']
      });

      let queuedCount = 0;

      // 2. Queue a weekly report for each shop
      for (const session of activeSessions) {
        // Enqueue to the background worker to avoid blocking the scheduler thread
        await enqueueMerchantReport(session.shop, 'weekly');
        queuedCount++;
      }

      console.log(`[SCHEDULER] Successfully queued ${queuedCount} weekly reports.`);
    } catch (error) {
      console.error('[SCHEDULER ERROR] Failed to dispatch weekly reports:', error);
    }
  });

  // Monthly Schedule: 1st day of every month at 10:00 AM
  cron.schedule('0 10 1 * *', async () => {
    console.log('[SCHEDULER] Running monthly merchant report cron job...');
    try {
      const activeSessions = await prisma.session.findMany({
        where: { isOnline: false },
        select: { shop: true },
        distinct: ['shop']
      });

      let queuedCount = 0;
      for (const session of activeSessions) {
        await enqueueMerchantReport(session.shop, 'monthly');
        queuedCount++;
      }
      console.log(`[SCHEDULER] Successfully queued ${queuedCount} monthly reports.`);
    } catch (error) {
      console.error('[SCHEDULER ERROR] Failed to dispatch monthly reports:', error);
    }
  });

  // ML Performance Report Schedule: 1st day of every month at 09:00 AM
  cron.schedule('0 9 1 * *', async () => {
    console.log('[SCHEDULER] Running monthly ML Performance report cron job...');
    try {
      const mlReportRecipients = [
        "member1@example.com", // 1. Enter first email here
        "member2@example.com", // 2. Enter second email here
        "member3@example.com", // 3. Enter third email here
        "member4@example.com", // 4. Enter fourth email here
        "member5@example.com"  // 5. Enter fifth email here
      ];

      await generateAndSendMLPerformanceReport(mlReportRecipients);
      console.log(`[SCHEDULER] Successfully sent ML Performance reports.`);
    } catch (error) {
      console.error('[SCHEDULER ERROR] Failed to send ML Performance reports:', error);
    }
  });
}
  // TESTING Schedule: Every 5 minutes (Runs both weekly and monthly for testing)
  // cron.schedule('*/5 * * * *', async () => {
  //   console.log('[SCHEDULER - TEST] Running 5-minute testing cron job...');
  //   try {
  //     const activeSessions = await prisma.session.findMany({
  //       where: { isOnline: false },
  //       select: { shop: true },
  //       distinct: ['shop']
  //     });

  //     let queuedCount = 0;
  //     for (const session of activeSessions) {
  //       // Since queue.server.js deduplicates based on date, we should append a timestamp to the deduplication ID 
  //       // to ensure it actually queues during our 5-minute tests, but we'll let it use the existing enqueue function first.
  //       await enqueueMerchantReport(session.shop, 'weekly');
  //       await enqueueMerchantReport(session.shop, 'monthly');
  //       queuedCount++;
  //     }
  //     console.log(`[SCHEDULER - TEST] Successfully queued ${queuedCount} testing reports.`);
  //   } catch (error) {
  //     console.error('[SCHEDULER - TEST ERROR] Failed to dispatch testing reports:', error);
  //   }
  // });


//   // ML Performance Report TESTING Schedule: Every 5 minutes
//   cron.schedule('*/5 * * * *', async () => {
//     console.log('[SCHEDULER - TEST] Running 5-minute ML Performance testing cron job...');
//     try {
//       const testMlReportRecipients = [
//         "dinesh@godash.ai" // Enter your test email here
//       ];

//       await generateAndSendMLPerformanceReport(testMlReportRecipients);
//       console.log(`[SCHEDULER - TEST] Successfully sent ML Performance testing report.`);
//     } catch (error) {
//       console.error('[SCHEDULER - TEST ERROR] Failed to send ML Performance testing report:', error);
//     }
//   });
// 
