-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "risk_score_model";

-- CreateEnum
CREATE TYPE "risk_score_model"."RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "risk_score_model"."NotificationChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "risk_score_model"."NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "risk_score_model"."Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
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
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."shopify_store_order" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "customerId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "lineItemsData" TEXT,
    "orderValue" DECIMAL(10,2) NOT NULL,
    "paymentGateway" TEXT,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "previousFinancialStatus" TEXT,
    "previousFulfillmentStatus" TEXT,
    "lastFinancialStatusChange" TIMESTAMP(3),
    "lastFulfillmentStatusChange" TIMESTAMP(3),
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "shipmentStatus" TEXT,
    "ipAddress" TEXT,
    "shippingAddress1" TEXT,
    "shippingAddress2" TEXT,
    "shippingCity" TEXT,
    "shippingProvince" TEXT,
    "shippingZip" TEXT,
    "shippingCountry" TEXT,
    "billingAddress1" TEXT,
    "billingAddress2" TEXT,
    "billingCity" TEXT,
    "billingProvince" TEXT,
    "billingZip" TEXT,
    "billingCountry" TEXT,
    "addressVerified" BOOLEAN NOT NULL DEFAULT false,
    "addressFingerprint" TEXT,
    "hasDispute" BOOLEAN NOT NULL DEFAULT false,
    "isRTO" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "buyerProfileId" TEXT,

    CONSTRAINT "shopify_store_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."zippyy_risk_score" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "riskLevel" "risk_score_model"."RiskLevel" NOT NULL,
    "reasons" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zippyy_risk_score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."zippyy_buyer_profile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "buyerIdentifier" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "customerEmail" TEXT,
    "customerId" TEXT,
    "customerPhone" TEXT,
    "shippingAddress1" TEXT,
    "shippingCountry" TEXT,
    "billingCountry" TEXT,
    "totalorders" INTEGER NOT NULL DEFAULT 0,
    "validOrderCount" INTEGER NOT NULL DEFAULT 0,
    "totalSpend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fulfilledCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledCount" INTEGER NOT NULL DEFAULT 0,
    "rtoCount" INTEGER NOT NULL DEFAULT 0,
    "codCount" INTEGER NOT NULL DEFAULT 0,
    "unpaidCount" INTEGER NOT NULL DEFAULT 0,
    "disputeCount" INTEGER NOT NULL DEFAULT 0,
    "refundCount" INTEGER NOT NULL DEFAULT 0,
    "fraudDisputeCount" INTEGER NOT NULL DEFAULT 0,
    "lostDisputeCount" INTEGER NOT NULL DEFAULT 0,
    "wonDisputeCount" INTEGER NOT NULL DEFAULT 0,
    "buyerSegment" TEXT NOT NULL DEFAULT 'New',
    "riskReasons" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zippyy_buyer_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."merchant_feedback" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNREAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."zippyy_risk_settings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "guestCodPenalty" INTEGER NOT NULL DEFAULT 15,
    "shortNamePenalty" INTEGER NOT NULL DEFAULT 30,
    "missingAddressPenalty" INTEGER NOT NULL DEFAULT 30,
    "missingHouseNoPenalty" INTEGER NOT NULL DEFAULT 25,
    "cancelWeight" INTEGER NOT NULL DEFAULT 35,
    "disputeWeight" INTEGER NOT NULL DEFAULT 50,
    "rtoWeight" INTEGER NOT NULL DEFAULT 35,
    "abandonWeight" INTEGER NOT NULL DEFAULT 25,
    "zeroValuePenalty" INTEGER NOT NULL DEFAULT 25,
    "refundWeight" INTEGER NOT NULL DEFAULT 25,
    "pendingPaymentPenalty" INTEGER NOT NULL DEFAULT 20,
    "codAbuseWeight" INTEGER NOT NULL DEFAULT 20,
    "valueAnomalyPenalty" INTEGER NOT NULL DEFAULT 15,
    "loyaltyBonus" INTEGER NOT NULL DEFAULT 5,
    "addressFraudPenalty" INTEGER NOT NULL DEFAULT 35,
    "phoneFraudPenalty" INTEGER NOT NULL DEFAULT 30,
    "hoardingHighPenalty" INTEGER NOT NULL DEFAULT 30,
    "hoardingMedPenalty" INTEGER NOT NULL DEFAULT 15,
    "openDisputePenalty" INTEGER NOT NULL DEFAULT 40,
    "fraudHistoryPenalty" INTEGER NOT NULL DEFAULT 100,
    "invalidEmailFormatPenalty" INTEGER NOT NULL DEFAULT 30,
    "invalidEmailDomainPenalty" INTEGER NOT NULL DEFAULT 40,
    "missingEmailPenalty" INTEGER NOT NULL DEFAULT 15,
    "suspiciousTimingPenalty" INTEGER NOT NULL DEFAULT 40,
    "invalidPinFormatPenalty" INTEGER NOT NULL DEFAULT 80,
    "nonExistentPinPenalty" INTEGER NOT NULL DEFAULT 80,
    "incompletePostalCodePenalty" INTEGER NOT NULL DEFAULT 80,
    "fakePostalCodePenalty" INTEGER NOT NULL DEFAULT 80,
    "fakeAddressPenalty" INTEGER NOT NULL DEFAULT 80,
    "wonDisputePenalty" INTEGER NOT NULL DEFAULT 15,
    "highCancelBonusPenalty" INTEGER NOT NULL DEFAULT 20,
    "medCancelBonusPenalty" INTEGER NOT NULL DEFAULT 10,
    "highRtoBonusPenalty" INTEGER NOT NULL DEFAULT 15,
    "extremeAbandonPenalty" INTEGER NOT NULL DEFAULT 35,
    "highAbandonPenalty" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zippyy_risk_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."India_valid_pincodes" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'IN',
    "postalCode" TEXT NOT NULL,
    "placeName" TEXT,
    "state" TEXT,
    "district" TEXT,

    CONSTRAINT "India_valid_pincodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."shopify_dispute" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyDisputeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "evidenceDueBy" TIMESTAMP(3),
    "hasSubmittedEvidence" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."Notification" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "channel" "risk_score_model"."NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "templateId" TEXT,
    "status" "risk_score_model"."NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "providerResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_score_model"."NotificationEvent" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerStatus" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shopify_store_order_shop_customerEmail_idx" ON "risk_score_model"."shopify_store_order"("shop", "customerEmail");

-- CreateIndex
CREATE INDEX "shopify_store_order_shop_customerId_idx" ON "risk_score_model"."shopify_store_order"("shop", "customerId");

-- CreateIndex
CREATE INDEX "shopify_store_order_shop_customerPhone_idx" ON "risk_score_model"."shopify_store_order"("shop", "customerPhone");

-- CreateIndex
CREATE INDEX "shopify_store_order_shop_createdAt_idx" ON "risk_score_model"."shopify_store_order"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "shopify_store_order_shop_buyerProfileId_idx" ON "risk_score_model"."shopify_store_order"("shop", "buyerProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_store_order_shop_shopifyOrderId_key" ON "risk_score_model"."shopify_store_order"("shop", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "zippyy_risk_score_orderId_key" ON "risk_score_model"."zippyy_risk_score"("orderId");

-- CreateIndex
CREATE INDEX "zippyy_risk_score_shop_orderId_idx" ON "risk_score_model"."zippyy_risk_score"("shop", "orderId");

-- CreateIndex
CREATE INDEX "zippyy_buyer_profile_shop_idx" ON "risk_score_model"."zippyy_buyer_profile"("shop");

-- CreateIndex
CREATE INDEX "zippyy_buyer_profile_shop_buyerSegment_idx" ON "risk_score_model"."zippyy_buyer_profile"("shop", "buyerSegment");

-- CreateIndex
CREATE INDEX "zippyy_buyer_profile_shop_totalorders_idx" ON "risk_score_model"."zippyy_buyer_profile"("shop", "totalorders" DESC);

-- CreateIndex
CREATE INDEX "zippyy_buyer_profile_shop_customerEmail_idx" ON "risk_score_model"."zippyy_buyer_profile"("shop", "customerEmail");

-- CreateIndex
CREATE INDEX "zippyy_buyer_profile_shop_customerPhone_idx" ON "risk_score_model"."zippyy_buyer_profile"("shop", "customerPhone");

-- CreateIndex
CREATE UNIQUE INDEX "zippyy_buyer_profile_shop_buyerIdentifier_key" ON "risk_score_model"."zippyy_buyer_profile"("shop", "buyerIdentifier");

-- CreateIndex
CREATE INDEX "merchant_feedback_shop_idx" ON "risk_score_model"."merchant_feedback"("shop");

-- CreateIndex
CREATE INDEX "merchant_feedback_createdAt_idx" ON "risk_score_model"."merchant_feedback"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "zippyy_risk_settings_shop_key" ON "risk_score_model"."zippyy_risk_settings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "India_valid_pincodes_postalCode_key" ON "risk_score_model"."India_valid_pincodes"("postalCode");

-- CreateIndex
CREATE INDEX "India_valid_pincodes_postalCode_idx" ON "risk_score_model"."India_valid_pincodes"("postalCode");

-- CreateIndex
CREATE INDEX "shopify_dispute_shop_orderId_idx" ON "risk_score_model"."shopify_dispute"("shop", "orderId");

-- CreateIndex
CREATE INDEX "shopify_dispute_shop_status_idx" ON "risk_score_model"."shopify_dispute"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_dispute_shop_shopifyDisputeId_key" ON "risk_score_model"."shopify_dispute"("shop", "shopifyDisputeId");

-- CreateIndex
CREATE INDEX "Notification_shop_status_idx" ON "risk_score_model"."Notification"("shop", "status");

-- CreateIndex
CREATE INDEX "Notification_providerMessageId_idx" ON "risk_score_model"."Notification"("providerMessageId");

-- CreateIndex
CREATE INDEX "NotificationEvent_notificationId_idx" ON "risk_score_model"."NotificationEvent"("notificationId");

-- AddForeignKey
ALTER TABLE "risk_score_model"."shopify_store_order" ADD CONSTRAINT "shopify_store_order_buyerProfileId_fkey" FOREIGN KEY ("buyerProfileId") REFERENCES "risk_score_model"."zippyy_buyer_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_score_model"."zippyy_risk_score" ADD CONSTRAINT "zippyy_risk_score_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "risk_score_model"."shopify_store_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_score_model"."shopify_dispute" ADD CONSTRAINT "shopify_dispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "risk_score_model"."shopify_store_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_score_model"."NotificationEvent" ADD CONSTRAINT "NotificationEvent_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "risk_score_model"."Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

