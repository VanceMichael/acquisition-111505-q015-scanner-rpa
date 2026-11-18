import { createRequire } from 'node:module';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createProvider } from '../provider/server.mjs';
import { request, decodeJson } from '../src/transport.mjs';
import { openPortal, runBatchEntry } from '../src/assistant.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));

// 默认本地启动来源；SOURCE_URL 可指向已在运行的来源。
let service = null;
let source = process.env.SOURCE_URL || null;
if (!source) {
  service = createProvider();
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  source = `http://127.0.0.1:${service.address().port}`;
}

let browser;
try {
  const batch = decodeJson(await request(new URL(project.probe, source).href));
  console.log(JSON.stringify({ 批次来源: source, 箱号: batch.boxId, 消息数: batch.messages.length }));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await openPortal(context, new URL('/portal', source).href);
  const report = await runBatchEntry(page, batch, { onEvent: event => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify({ 结果: report }));
  if (!report.completed) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (service) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
}
