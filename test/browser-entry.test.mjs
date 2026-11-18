import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createProvider } from '../provider/server.mjs';
import { openPortal, runBatchEntry } from '../src/assistant.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
test.after(() => browser.close());

async function withPortal(context) {
  const service = createProvider();
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const browserContext = await browser.newContext();
  context.after(() => browserContext.close());
  const page = await openPortal(browserContext, `${base}/portal`);
  return {
    base,
    page,
    control: value => fetch(`${base}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }),
    batch: async () => (await fetch(`${base}/scan-batches`)).json(),
    state: async () => (await fetch(`${base}/__state`)).json()
  };
}

test('批次回放完成合箱登记，重发不重复计数', async context => {
  const { page, batch, state } = await withPortal(context);
  const report = await runBatchEntry(page, await batch());
  assert.equal(report.completed, true);
  assert.deepEqual(report.processed.map(item => item.outcome), ['registered', 'duplicate-confirmed', 'registered']);
  const row = report.rows.find(item => item.item === 'EX-001');
  assert.equal(row.quantity, 2);
  assert.equal(row.scanMessage, 'scan-2');
  assert.equal((await state()).boxes['box-a']['EX-001'].quantity, 2);
  assert.equal(await page.locator('#note').inputValue(), '');
  assert.equal(await page.evaluate(() => window.confirmedScanMessage), undefined);
});

test('查找变慢时按键不会落入数量或备注框', async context => {
  const { page, batch, control } = await withPortal(context);
  await control({ delay: 400 });
  const report = await runBatchEntry(page, await batch());
  assert.equal(report.completed, true);
  assert.equal(report.rows.find(item => item.item === 'EX-001').quantity, 2);
  assert.equal(await page.locator('#note').inputValue(), '');
  assert.equal(await page.locator('[aria-label="数量"]').inputValue(), '1');
});

test('操作员中途换箱时停止，余下物件不装进新箱', async context => {
  const { page, batch, state } = await withPortal(context);
  let switched = false;
  const report = await runBatchEntry(page, await batch(), {
    onEvent: async event => {
      if (event.type === 'message' && !switched) { switched = true; await page.selectOption('#box', 'box-b'); }
    }
  });
  assert.equal(report.completed, false);
  assert.equal(report.code, 'box-mismatch');
  assert.equal(report.processed.length, 1);
  assert.deepEqual(report.remaining, ['scan-1', 'scan-2']);
  const boxes = (await state()).boxes;
  assert.equal(boxes['box-a']['EX-001'].quantity, 1);
  assert.deepEqual(boxes['box-b'], {});
});

test('中途人工改数时停在可核对位置', async context => {
  const { page, batch, state } = await withPortal(context);
  let edited = false;
  const report = await runBatchEntry(page, await batch(), {
    onEvent: async event => {
      if (event.type === 'message' && !edited) {
        edited = true;
        const editor = page.getByRole('spinbutton', { name: 'EX-001 数量' });
        await editor.fill('5');
        await editor.press('Tab');
        await page.waitForFunction(() => document.querySelector('#rows tr')?.dataset.scanMessage === 'operator');
      }
    }
  });
  assert.equal(report.completed, false);
  assert.equal(report.code, 'readback-drift');
  assert.equal(report.processed.length, 1);
  assert.equal((await state()).boxes['box-a']['EX-001'].quantity, 5);
});

test('分段输入按声明的结束键完成，不按固定间隔猜测', async context => {
  const { page, batch, control } = await withPortal(context);
  await control({ batches: { boxId: 'box-a', revision: 2, messages: [
    { messageId: 'seg-1', boxId: 'box-a', chunks: ['EX-', '0', '02'], terminator: 'Enter', intent: 'add' },
    { messageId: 'seg-2', boxId: 'box-a', chunks: ['EX-003'], terminator: 'Enter', intent: 'add' }
  ] } });
  const report = await runBatchEntry(page, await batch());
  assert.equal(report.completed, true);
  assert.equal(report.rows.find(item => item.item === 'EX-002').quantity, 1);
  assert.equal(report.rows.find(item => item.item === 'EX-003').quantity, 1);
});

test('同一消息身份被声明为两次新加时停止', async context => {
  const { page, batch, control, state } = await withPortal(context);
  await control({ batches: { boxId: 'box-a', revision: 2, messages: [
    { messageId: 'dup-1', boxId: 'box-a', chunks: ['EX-001'], terminator: 'Enter', intent: 'add' },
    { messageId: 'dup-1', boxId: 'box-a', chunks: ['EX-001'], terminator: 'Enter', intent: 'add' }
  ] } });
  const report = await runBatchEntry(page, await batch());
  assert.equal(report.completed, false);
  assert.equal(report.code, 'identity-conflict');
  assert.equal(report.processed.length, 1);
  assert.equal((await state()).boxes['box-a']['EX-001'].quantity, 1);
});

test('不受支持的结束键在触碰页面之前被拒绝', async context => {
  const { page, batch, control, state } = await withPortal(context);
  await control({ batches: { boxId: 'box-a', revision: 2, messages: [
    { messageId: 'bad-1', boxId: 'box-a', chunks: ['EX-001'], terminator: 'Tab', intent: 'add' }
  ] } });
  await assert.rejects(runBatchEntry(page, await batch()), /结束键/);
  assert.deepEqual((await state()).boxes['box-a'], {});
});

test('扫码框被占用时停止而不是覆盖', async context => {
  const { page, batch } = await withPortal(context);
  let occupied = false;
  const report = await runBatchEntry(page, await batch(), {
    onEvent: async event => {
      if (event.type === 'message' && !occupied) { occupied = true; await page.locator('[aria-label="物件扫码"]').fill('EX-9'); }
    }
  });
  assert.equal(report.completed, false);
  assert.equal(report.code, 'field-occupied');
  assert.equal(report.processed.length, 1);
});
