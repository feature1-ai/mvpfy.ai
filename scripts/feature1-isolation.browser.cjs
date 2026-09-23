// Start Vite on 5198, then run with PLAYWRIGHT_MODULE pointing to Playwright.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:5198/scripts/feature1-isolation.harness.html');
    await page.getByPlaceholder('acme.feature1.ai').fill('watiq');
    await page.getByRole('button', { name: 'Open browser sign-in' }).click();
    await page.getByRole('status').waitFor();
    assert.equal(await page.getByTestId('tenant').innerText(), 'disconnected');
    await page.getByLabel('Personal Feature1 token').fill('satorixr-token');
    await page.getByRole('button', { name: 'Verify and connect' }).click();
    await page.getByText(/token belongs to a different workspace/).waitFor();
    assert.equal(await page.getByTestId('tenant').innerText(), 'disconnected');
    await page.getByLabel('Personal Feature1 token').fill('watiq-token');
    await page.getByRole('button', { name: 'Verify and connect' }).click();
    await page
      .getByTestId('tenant')
      .filter({ hasText: /^watiq$/ })
      .waitFor();
    assert.equal(await page.getByLabel('Personal Feature1 token').inputValue(), '');
    await page.getByRole('button', { name: 'Sync features' }).click();
    await page.getByText('watiq feature', { exact: true }).waitFor();
    await page.evaluate(() => {
      window.controls.delay = true;
    });
    await page.getByRole('button', { name: 'Sync features' }).click();
    await page.waitForFunction(() => Boolean(window.controls.release));
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    assert.equal(await page.getByText('watiq feature', { exact: true }).count(), 0);
    await page.evaluate(() => window.controls.release());
    await page.getByRole('button', { name: 'Sync features' }).click();
    await page.getByText('satorixr feature', { exact: true }).waitFor();
    assert.equal(await page.getByText('watiq feature', { exact: true }).count(), 0);
    await page.evaluate(() => {
      window.controls.deny = true;
    });
    await page.getByRole('button', { name: 'Sync features' }).click();
    await page
      .getByTestId('tenant')
      .filter({ hasText: /^disconnected$/ })
      .waitFor();
    assert.equal(await page.locator('li').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'PASS personal-token login, wrong-tenant rejection, stale-response isolation, and auth-failure cache clearing'
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
