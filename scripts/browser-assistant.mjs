// 浏览器录入助手入口：从来源取操作员确认的扫码批次，
// 用真实 Chromium 以键盘交互完成合箱登记，全程不直接调用业务接口。
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
import { fetchScanBatches, runConfirmedBatch } from '../assistant/runner.mjs';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
const sourceBase = process.env.SOURCE_URL || '';
const ownProvider = !sourceBase;
const service = ownProvider ? createProvider() : null;
if (service) { service.listen(Number(process.env.SOURCE_PORT) || 0, '127.0.0.1'); await once(service, 'listening'); }
const base = sourceBase || `http://127.0.0.1:${service.address().port}`;

let browser;
try {
  const envelope = await fetchScanBatches(base, project.probe);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const events = [];
  const report = await runConfirmedBatch(page, new URL('/portal', base).href, envelope, event => {
    events.push(event);
    console.log(JSON.stringify(event));
  });
  console.log(JSON.stringify({ 批次结果: report }));
  if (report.status !== 'completed') process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ 助手失败: error.message }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (service) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
}
