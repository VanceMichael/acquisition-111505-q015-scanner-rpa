import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createProvider } from '../provider/server.mjs';
import { runConfirmedBatch } from '../assistant/runner.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
test.after(async () => browser.close());

// 记录真人键盘轨迹：每个字符落在哪个控件，用于证明慢查询时下一个码不会串进数量/备注框。
const RECORDER_INIT = `window.__keys=[];
const observe=target=>{target.addEventListener('keydown',event=>{window.__keys.push({type:'key',key:event.key,label:event.target.getAttribute('aria-label')||event.target.id||''});},true);
target.addEventListener('input',event=>{window.__keys.push({type:'text',value:event.target.value,label:event.target.getAttribute('aria-label')||event.target.id||''});},true);};
document.addEventListener('focusin',event=>{if(!event.target.__observed){event.target.__observed=1;observe(event.target);}},true);`;

async function withPortal(context, statePatch = null) {
  const service = createProvider();
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const base = `http://127.0.0.1:${service.address().port}`;
  if (statePatch) {
    await fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(statePatch) });
  }
  const page = await context.newPage();
  await page.addInitScript(RECORDER_INIT);
  const cleanup = async () => { await page.close(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); };
  return { base, page, cleanup };
}

const envelope = (messages, boxId = 'box-a') => ({ boxId, revision: 1, messages });
const scan = (messageId, chunks, intent = 'add', terminator = 'Enter', boxId = 'box-a') =>
  ({ messageId, boxId, chunks, terminator, intent });

test('分段扫码以逐段键盘录入并按结束键完成，回读建立物件身份', async () => {
  const context = await browser.newContext();
  const { base, page, cleanup } = await withPortal(context);
  try {
    const report = await runConfirmedBatch(page, base + '/portal', envelope([
      scan('scan-1', ['EX-', '00', '1']),
    ]));
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.processed, [{ messageId: 'scan-1', item: 'EX-001', quantity: 1 }]);
    const keys = await page.evaluate(() => window.__keys);
    // 所有字符键都落在扫码框，结束键也是在扫码框按下。
    assert.ok(keys.length > 0);
    assert.ok(keys.every(event => event.label === '物件扫码'));
    const enters = keys.filter(event => event.type === 'key' && event.key === 'Enter');
    assert.equal(enters.length, 1);
    // 逐段输入过程中框内曾出现中间值，证明是分段键入而非一次性赋值。
    const values = keys.filter(event => event.type === 'text').map(event => event.value);
    assert.ok(values.includes('EX-'));
    assert.equal(values.at(-1), 'EX-001');
    const rows = await (await fetch(base + '/api/box?boxId=box-a')).json();
    assert.equal(rows.rows[0].lastMessage, 'scan-1');
  } finally { await cleanup(); await context.close(); }
});

test('重发同一条扫码消息不重复计数，新 messageId 的同物件才加件', async () => {
  const context = await browser.newContext();
  const { base, page, cleanup } = await withPortal(context);
  try {
    const report = await runConfirmedBatch(page, base + '/portal', envelope([
      scan('scan-1', ['EX-', '001'], 'add'),
      scan('scan-1', ['EX-001'], 'retry'),
      scan('scan-2', ['EX-001'], 'add'),
    ]));
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.retriesConfirmed, ['scan-1']);
    assert.deepEqual(report.processed.map(item => item.messageId), ['scan-1', 'scan-2']);
    const rows = await (await fetch(base + '/api/box?boxId=box-a')).json();
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].quantity, 2);
    assert.equal(rows.rows[0].lastMessage, 'scan-2');
    // 重发没有产生额外的键盘提交。
    const keys = await page.evaluate(() => window.__keys);
    assert.equal(keys.filter(event => event.type === 'key' && event.key === 'Enter').length, 2);
  } finally { await cleanup(); await context.close(); }
});

test('查件缓慢时后续扫码不会串入数量框或备注框', async () => {
  const context = await browser.newContext();
  const { base, page, cleanup } = await withPortal(context, { delay: 600 });
  try {
    const report = await runConfirmedBatch(page, base + '/portal', envelope([
      scan('scan-1', ['EX-001']),
      scan('scan-2', ['EX-002']),
      scan('scan-3', ['EX-003']),
    ]));
    assert.equal(report.status, 'completed');
    assert.equal(report.processed.length, 3);
    const keys = await page.evaluate(() => window.__keys);
    const stray = keys.filter(event => event.label !== '物件扫码');
    assert.equal(stray.length, 0, `发现串键：${JSON.stringify(stray)}`);
    assert.equal(await page.getByRole('textbox', { name: '操作员备注' }).inputValue(), '');
    const rows = await (await fetch(base + '/api/box?boxId=box-a')).json();
    assert.deepEqual(rows.rows.map(row => row.item).sort(), ['EX-001', 'EX-002', 'EX-003']);
  } finally { await cleanup(); await context.close(); }
});

test('操作员换箱后助手停在可核对位置，不把余下物件装进新箱', async () => {
  const context = await browser.newContext();
  const { base, page, cleanup } = await withPortal(context);
  try {
    const report = await runConfirmedBatch(page, base + '/portal', envelope([
      scan('scan-1', ['EX-001']),
      scan('scan-2', ['EX-002']),
      scan('scan-3', ['EX-003']),
    ]), async event => {
      if (event.phase === 'registered' && event.messageId === 'scan-1') {
        await page.getByRole('combobox', { name: '当前箱号' }).selectOption('box-b');
        // 等门户自身的换箱处理完成，再把控制权交回助手。
        await page.getByRole('status').filter({ hasText: '操作员已换箱' }).waitFor();
      }
    });
    assert.equal(report.status, 'stopped');
    assert.equal(report.stopReason, 'box-mismatch');
    assert.equal(report.observedBoxId, 'box-b');
    assert.deepEqual(report.remaining, ['scan-2', 'scan-3']);
    assert.equal(await page.getByRole('combobox', { name: '当前箱号' }).inputValue(), 'box-b');
    const boxB = await (await fetch(base + '/api/box?boxId=box-b')).json();
    assert.equal(boxB.rows.length, 0);
    const boxA = await (await fetch(base + '/api/box?boxId=box-a')).json();
    assert.deepEqual(boxA.rows.map(row => row.item), ['EX-001']);
  } finally { await cleanup(); await context.close(); }
});

test('操作员手工改数后助手停止并保留现场', async () => {
  const context = await browser.newContext();
  const { base, page, cleanup } = await withPortal(context);
  try {
    const report = await runConfirmedBatch(page, base + '/portal', envelope([
      scan('scan-1', ['EX-001']),
      scan('scan-2', ['EX-002']),
    ]), async event => {
      if (event.phase === 'registered' && event.messageId === 'scan-1') {
        const editor = page.getByRole('spinbutton', { name: 'EX-001 数量' });
        await editor.fill('5');
        await editor.press('Tab');
        await page.waitForFunction(() => document.querySelector('#rows tr')?.dataset.scanMessage === 'operator');
      }
    });
    assert.equal(report.status, 'stopped');
    assert.equal(report.stopReason, 'manual-drift');
    assert.deepEqual(report.remaining, ['scan-2']);
    const value = await page.getByRole('spinbutton', { name: 'EX-001 数量' }).inputValue();
    assert.equal(value, '5');
    const boxA = await (await fetch(base + '/api/box?boxId=box-a')).json();
    assert.deepEqual(boxA.rows.map(row => row.item), ['EX-001']);
    assert.equal(boxA.rows[0].quantity, 5);
  } finally { await cleanup(); await context.close(); }
});

test('扫码框焦点在分段输入间丢失时立即停止，不向其他控件键入', async () => {
  const context = await browser.newContext();
  const { base, page, cleanup } = await withPortal(context);
  try {
    // 模拟扫码枪慢速分段时焦点被操作员/页面抢走。
    await page.addInitScript(() => {
      document.addEventListener('input', event => {
        if (event.target.getAttribute('aria-label') === '物件扫码' && event.target.value === 'EX-') {
          document.querySelector('#note').focus();
        }
      }, true);
    });
    const report = await runConfirmedBatch(page, base + '/portal', envelope([
      scan('scan-1', ['EX-', '001']),
      scan('scan-2', ['EX-002']),
    ]));
    assert.equal(report.status, 'stopped');
    assert.equal(report.stopReason, 'focus-lost');
    assert.deepEqual(report.processed, []);
    assert.deepEqual(report.remaining, ['scan-1', 'scan-2']);
    assert.equal(await page.getByRole('textbox', { name: '操作员备注' }).inputValue(), '');
  } finally { await cleanup(); await context.close(); }
});

test('重发消息无法在门户回读中证实时停止，不重新敲键', async () => {
  const context = await browser.newContext();
  const { base, page, cleanup } = await withPortal(context);
  try {
    const report = await runConfirmedBatch(page, base + '/portal', envelope([
      scan('scan-9', ['EX-001'], 'retry'),
    ]));
    assert.equal(report.status, 'stopped');
    assert.equal(report.stopReason, 'retry-unverified');
    const keys = await page.evaluate(() => window.__keys);
    assert.equal(keys.filter(event => event.type === 'key').length, 0);
    const boxA = await (await fetch(base + '/api/box?boxId=box-a')).json();
    assert.equal(boxA.rows.length, 0);
  } finally { await cleanup(); await context.close(); }
});
