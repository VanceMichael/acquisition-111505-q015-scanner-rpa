import { createRequire } from 'node:module';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createProvider } from '../provider/server.mjs';
const require = createRequire(import.meta.url); const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(); const base = `http://127.0.0.1:${service.address().port}`;
  await page.goto(base + '/portal'); await page.evaluate(() => { window.confirmedScanMessage = 'browser-1'; });
  const input = page.getByRole('textbox', { name: '物件扫码' }); await input.fill('EX-001');
  const response = page.waitForResponse(reply => reply.url().endsWith('/api/box') && reply.request().method() === 'POST'); await input.press('Enter'); await response;
  await page.getByRole('cell', { name: 'EX-001', exact: true }).waitFor(); assert.equal(await page.getByRole('spinbutton', { name: 'EX-001 数量' }).inputValue(), '1');
  console.log('真实浏览器扫码与回读完成');
} finally { if (browser) await browser.close(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
