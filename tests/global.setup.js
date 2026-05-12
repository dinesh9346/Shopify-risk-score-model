import { test as setup } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

setup('seed test data', async () => {
  console.log('Seeding database for Playwright tests...');

  // We are creating a mock order that we can predictably test against
  await prisma.shopify_store_order.upsert({
    where: {
      shop_shopifyOrderId: {
        shop: 'test-store.myshopify.com',
        shopifyOrderId: 'gid://shopify/Order/999999999999',
      }
    },
    update: {
      addressEditToken: 'PLAYWRIGHT_TEST_TOKEN',
      shippingAddress1: '123 Old Address',
      shippingCity: 'Old City',
      shippingProvince: 'Old Province',
      shippingZip: '000000',
      shippingCountry: 'IN',
    },
    create: {
      shop: 'test-store.myshopify.com',
      shopifyOrderId: 'gid://shopify/Order/999999999999',
      firstName: 'Playwright',
      lastName: 'Tester',
      customerEmail: 'test@playwright.dev',
      customerPhone: '9999999999',
      orderValue: 100.00,
      paymentGateway: 'COD',
      financialStatus: 'pending',
      fulfillmentStatus: 'unfulfilled',
      shippingAddress1: '123 Old Address',
      shippingCity: 'Old City',
      shippingProvince: 'Old Province',
      shippingZip: '000000',
      shippingCountry: 'IN',
      addressEditToken: 'PLAYWRIGHT_TEST_TOKEN',
    }
  });

  console.log('Test order successfully seeded.');
  await prisma.$disconnect();
});
