// Start Vite on 5198, then run with PLAYWRIGHT_MODULE pointing to Playwright.
// Uses a real Electron window with synthetic story streams; no agent calls.
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-plan-activity-'));
  const entry = path.join(dir, 'main.cjs');
  fs.writeFileSync(
    entry,
    `const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(dir, 'profile'))});
app.whenReady().then(()=>{const window=new BrowserWindow({width:1024,height:768,webPreferences:{contextIsolation:true,nodeIntegration:false}});window.loadURL('http://127.0.0.1:5198/scripts/plan-activity.harness.html');});`
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [entry], env });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.getByRole('heading', { name: 'Story board' }).waitFor();
    const panel = page.getByRole('region', { name: 'Implementation activity' });
    assert.equal(await panel.count(), 0);
    await page.getByRole('button', { name: 'Start story', exact: true }).click();
    const toggle = panel.getByRole('button', { name: /Implementation logs/ });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.locator('pre').count(), 0);
    await toggle.click();
    await panel.getByText('Implementing S-1', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stream output' }).click();
    await panel.locator('pre').filter({ hasText: 'New streamed output' }).waitFor();
    await panel.getByLabel('Story run').selectOption('S-1');
    await page.getByRole('button', { name: 'Start another story' }).click();
    assert.match(await panel.locator('pre').innerText(), /Implementing S-1/);
    await panel.getByLabel('Story run').selectOption('');
    assert.match(await panel.locator('pre').innerText(), /Implementing S-2/);
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.equal(await page.getByTestId('stopped').innerText(), 'S-2');
    await panel.getByRole('button', { name: 'Raw', exact: true }).click();
    await panel.getByRole('button', { name: 'Pretty', exact: true }).waitFor();
    await toggle.click();
    await page.getByRole('button', { name: 'Stream output' }).click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.match(await panel.locator('pre').innerText(), /New streamed output/);
    await page.getByRole('button', { name: 'Finish stories' }).click();
    await panel.getByText('Recent story runs').waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    await page.locator('main').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const bounds = await panel.boundingBox();
    assert.ok(
      bounds &&
        bounds.y + bounds.height <=
          (await page.locator('body').evaluate((el) => el.ownerDocument.defaultView.innerHeight))
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS Electron: collapsed default, live output, pinned selection, follow latest, stop routing, raw view, reopen, completed history, and fixed dock'
    );
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
