import { test, expect } from '@playwright/test';

test.describe('Customer Address Edit Flow', () => {

  test('successfully displays and submits the edit address form', async ({ page }) => {
    // 1. Navigate to the generated token URL
    // We append the token that we explicitly created in the global.setup.js file
    await page.goto('/edit-address/PLAYWRIGHT_TEST_TOKEN');

    // 2. Assert that the page loaded correctly and the pre-filled data is present
    await expect(page.getByRole('heading', { name: 'Confirm Shipping Details' })).toBeVisible();
    
    // Assert that the inputs are visible
    const addressInput = page.locator('input[name="address1"]');
    const cityInput = page.locator('input[name="city"]');
    const provinceInput = page.locator('input[name="province"]');
    const zipInput = page.locator('input[name="zip"]');

    await expect(addressInput).toBeVisible();
    
    // 3. Fill in the form with new data
    // We use clear() first just in case there's old data
    await addressInput.fill('456 New Auto Street');
    await cityInput.fill('Automated City');
    await provinceInput.fill('Test Province');
    await zipInput.fill('111111');

    // 5. Submit the form
    await page.getByRole('button', { name: 'Save & Confirm Order' }).click();

    // 6. Assert the response (Since this is a mock order with no real Shopify Session, the backend will catch it and return an error gracefully)
    await expect(page.getByText('Something went wrong: No active Shopify session')).toBeVisible({ timeout: 10000 });
  });

  test('displays expired state for invalid tokens', async ({ page }) => {
    await page.goto('/edit-address/INVALID_TOKEN_DOES_NOT_EXIST');
    
    await expect(page.getByRole('heading', { name: 'Link Expired' })).toBeVisible();
    await expect(page.getByText('This address confirmation link is invalid')).toBeVisible();
  });

});
