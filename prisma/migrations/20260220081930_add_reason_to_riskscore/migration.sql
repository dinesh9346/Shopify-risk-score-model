-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RiskScore" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT,
    "orderValue" REAL NOT NULL,
    "paymentType" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "reasons" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_RiskScore" ("createdAt", "customerId", "id", "orderId", "orderValue", "paymentType", "riskLevel", "score", "shop") SELECT "createdAt", "customerId", "id", "orderId", "orderValue", "paymentType", "riskLevel", "score", "shop" FROM "RiskScore";
DROP TABLE "RiskScore";
ALTER TABLE "new_RiskScore" RENAME TO "RiskScore";
CREATE UNIQUE INDEX "RiskScore_orderId_key" ON "RiskScore"("orderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
