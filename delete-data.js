import dotenv from "dotenv";
import readline from "readline";

dotenv.config();

const { default: prisma } = await import("./app/db.server.js");

const args = process.argv.slice(2);
const confirmDelete = args.includes("--confirm-delete");
const dryRun = args.includes("--dry-run");
const yesFlag = args.includes("--yes");
const shopArgIndex = args.findIndex((arg) => arg === "--shop");
const shop = shopArgIndex >= 0 ? args[shopArgIndex + 1] : undefined;

const models = [
  { displayName: "Session", clientName: "session", field: "shop" },
  { displayName: "shopify_store_order", clientName: "shopify_store_order", field: "shop" },
  { displayName: "zippyy_risk_score", clientName: "zippyy_risk_score", field: "shop" },
  { displayName: "zippyy_buyer_profile", clientName: "zippyy_buyer_profile", field: "shop" },
];

function printUsage() {
  console.log("Usage: node delete-data.js --confirm-delete [--yes] [--shop <shop>] [--dry-run]");
  console.log("");
  console.log("Options:");
  console.log("  --confirm-delete    Required to allow destructive deletion.");
  console.log("  --yes               Skip interactive confirmation prompt after preview.");
  console.log("  --shop <shop>       Delete data only for the specified shop.");
  console.log("  --dry-run           Show what would be deleted without modifying the database.");
  console.log("");
  console.log("This script only deletes data from Session, shopify_store_order, zippyy_risk_score, and zippyy_buyer_profile.");
  console.log("It will not modify any other database tables.");
}

async function getCounts() {
  const counts = {};
  for (const model of models) {
    const where = shop ? { [model.field]: shop } : undefined;
    counts[model.displayName] = await prisma[model.clientName].count({ where });
  }
  return counts;
}

async function deleteData() {
  const where = shop ? { shop } : undefined;

  const deleteOrderRisk = prisma.zippyy_risk_score.deleteMany({ where });
  const deleteBuyerProfiles = prisma.zippyy_buyer_profile.deleteMany({ where });
  const deleteOrders = prisma.shopify_store_order.deleteMany({ where });
  const deleteSessions = prisma.session.deleteMany({ where });

  return Promise.all([deleteOrderRisk, deleteBuyerProfiles, deleteOrders, deleteSessions]);
}

function askForConfirmation() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Type DELETE to confirm deletion: ", (answer) => {
      rl.close();
      resolve(answer.trim() === "DELETE");
    });
  });
}

async function run() {
  if (!confirmDelete) {
    console.error("ERROR: Missing required --confirm-delete flag. No data will be removed.");
    printUsage();
    process.exit(1);
  }

  const counts = await getCounts();
  console.log("\nDelete-data preview:");
  console.log(`  Target shop: ${shop ?? "ALL SHOPS"}`);
  for (const model of models) {
    console.log(`  ${model.name}: ${counts[model.name]} record(s)`);
  }

  if (dryRun) {
    console.log("\nDry run complete. No changes were made.");
    await prisma.$disconnect();
    process.exit(0);
  }

  if (!yesFlag) {
    const confirmed = await askForConfirmation();
    if (!confirmed) {
      console.log("Aborted. No changes were made.");
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  const results = await deleteData();
  console.log("\nDeletion complete.");
  console.log(`  Session: ${results[3].count}`);
  console.log(`  shopify_store_order: ${results[2].count}`);
  console.log(`  zippyy_risk_score: ${results[0].count}`);
  console.log(`  zippyy_buyer_profile: ${results[1].count}`);
  await prisma.$disconnect();
}

run().catch(async (error) => {
  console.error("Fatal error:", error);
  await prisma.$disconnect();
  process.exit(1);
});
