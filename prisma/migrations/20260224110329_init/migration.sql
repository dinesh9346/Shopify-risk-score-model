-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" DATETIME
);

-- CreateTable
CREATE TABLE "RiskScore" (
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

-- CreateTable
CREATE TABLE "StoreOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "orderValue" REAL NOT NULL,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "cancelledAt" DATETIME,
    "hasDispute" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "RiskScore_orderId_key" ON "RiskScore"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrder_shopifyOrderId_key" ON "StoreOrder"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "StoreOrder_shop_customerId_idx" ON "StoreOrder"("shop", "customerId");

-- CreateIndex
CREATE INDEX "StoreOrder_shop_customerEmail_idx" ON "StoreOrder"("shop", "customerEmail");
