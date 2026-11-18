// 批次录入助手：把操作员确认过的扫码批次通过真实键盘交互登记到装箱门户。
// 助手只驱动页面控件（聚焦、按键、读取回读表格），不调用页面业务接口。

const INTENTS = new Set(['add', 'retry']);
export const TERMINATORS = new Map([['Enter', 'Enter']]);

// 把来源批次整理成可执行计划；任何一条消息不可执行都在触碰页面之前拒绝。
export function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) throw new Error('扫码批次应是对象');
  if (typeof batch.boxId !== 'string' || !batch.boxId) throw new Error('扫码批次缺少箱号 boxId');
  if (!Array.isArray(batch.messages)) throw new Error('扫码批次缺少消息列表 messages');
  const messages = batch.messages.map((message, index) => {
    const where = `第 ${index + 1} 条扫码消息`;
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(`${where}应是对象`);
    if (typeof message.messageId !== 'string' || !message.messageId) throw new Error(`${where}缺少消息身份 messageId`);
    if (typeof message.boxId !== 'string' || !message.boxId) throw new Error(`${where}缺少箱号 boxId`);
    if (!Array.isArray(message.chunks) || !message.chunks.length) throw new Error(`${where}缺少分段输入 chunks`);
    for (const chunk of message.chunks) {
      if (typeof chunk !== 'string' || !chunk) throw new Error(`${where}的分段输入不能为空`);
      if (/[\r\n]/.test(chunk)) throw new Error(`${where}的分段输入不能包含换行，结束键应使用 terminator 声明`);
    }
    if (!TERMINATORS.has(message.terminator)) throw new Error(`${where}的结束键 ${String(message.terminator)} 不受支持`);
    if (!INTENTS.has(message.intent)) throw new Error(`${where}的意图 intent 应是 add 或 retry`);
    return { index, messageId: message.messageId, boxId: message.boxId, code: message.chunks.join(''), chunks: [...message.chunks], terminator: message.terminator, intent: message.intent };
  });
  return { boxId: batch.boxId, revision: batch.revision ?? null, messages };
}

// 分段输入按来源声明回放：逐段键盘输入，最后按下声明的结束键，不靠固定间隔猜测输入是否结束。
export function keystrokes(message) {
  return [...message.chunks.map(text => ({ type: 'text', text })), { type: 'key', key: TERMINATORS.get(message.terminator) }];
}

export function snapshotOf(rows) {
  return new Map(rows.map(row => [row.item, { quantity: row.quantity, scanMessage: row.scanMessage }]));
}

export function rowsOf(snapshot) {
  return Array.from(snapshot, ([item, row]) => ({ item, quantity: row.quantity, scanMessage: row.scanMessage }));
}

export function diffSnapshots(before, after) {
  const changes = [];
  for (const [item, prior] of before) {
    const current = after.get(item);
    if (!current) changes.push({ item, before: prior, after: null });
    else if (current.quantity !== prior.quantity || current.scanMessage !== prior.scanMessage) changes.push({ item, before: prior, after: current });
  }
  for (const [item, current] of after) if (!before.has(item)) changes.push({ item, before: null, after: current });
  return changes;
}

// 按来源身份（intent/messageId）与门户回读核对单条消息的确切效果。
export function verifyMessage(message, before, after) {
  const unrelated = diffSnapshots(before, after).filter(change => change.item !== message.code);
  if (unrelated.length) return { ok: false, code: 'readback-drift', reason: '登记期间其他物件行发生变化，停在可核对位置', detail: { unrelated } };
  const prior = before.get(message.code) ?? null;
  const current = after.get(message.code) ?? null;
  const unchanged = (prior === null && current === null)
    || (prior !== null && current !== null && prior.quantity === current.quantity && prior.scanMessage === current.scanMessage);
  if (message.intent === 'add') {
    const expectedQuantity = (prior?.quantity ?? 0) + 1;
    if (current && current.quantity === expectedQuantity && current.scanMessage === message.messageId) return { ok: true, outcome: 'registered' };
    if (unchanged) return { ok: false, code: 'identity-conflict', reason: `消息 ${message.messageId} 声明为新加件，但门户回读没有新登记（消息身份可能已被消费，或物件被门户拒绝），停在可核对位置`, detail: { prior, current } };
    return { ok: false, code: 'verification-failed', reason: `消息 ${message.messageId} 的门户回读与预期登记结果不一致`, detail: { prior, current, expectedQuantity } };
  }
  if (unchanged && prior) return { ok: true, outcome: 'duplicate-confirmed' };
  const expectedQuantity = (prior?.quantity ?? 0) + 1;
  if (current && current.quantity === expectedQuantity && current.scanMessage === message.messageId) return { ok: true, outcome: 'retry-landed' };
  return { ok: false, code: 'verification-failed', reason: `重发消息 ${message.messageId} 的门户回读与预期不一致`, detail: { prior, current, expectedQuantity } };
}

const isBoxGet = response => response.url().includes('/api/box') && response.request().method() === 'GET';
const isBoxPost = response => response.url().includes('/api/box') && response.request().method() === 'POST';

async function readRows(page) {
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#rows tr'), row => ({
    item: row.cells[0]?.textContent ?? '',
    quantity: Number(row.querySelector('input')?.value),
    scanMessage: row.dataset.scanMessage ?? ''
  })));
  return rows.map(row => ({ ...row, quantity: Number.isFinite(row.quantity) ? row.quantity : null }));
}

async function renderFrame(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
}

// 回读表格稳定后再采样，避免拿到刷新半途的行。
async function stableRows(page) {
  let previous = await readRows(page);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await renderFrame(page);
    const current = await readRows(page);
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}

async function statusText(page) {
  return page.evaluate(() => document.querySelector('#status')?.textContent ?? null).catch(() => null);
}

async function diagnostics(page) {
  return page.evaluate(() => ({
    activeElement: document.activeElement ? document.activeElement.getAttribute('aria-label') || document.activeElement.id || document.activeElement.tagName : null,
    status: document.querySelector('#status')?.textContent ?? null,
    scanInputPresent: Boolean(document.querySelector('[aria-label="物件扫码"]')),
    pageBox: document.querySelector('#box')?.value ?? null
  })).catch(() => null);
}

// 焦点必须落在物件扫码框才允许按键；框内已有内容时停下，避免覆盖操作员未完成的输入。
async function acquireScanFocus(page, timeout) {
  const input = page.locator('[aria-label="物件扫码"]');
  try { await input.waitFor({ state: 'visible', timeout }); }
  catch { return { ok: false, code: 'focus-unavailable', reason: '物件扫码输入框未出现，停在可核对位置' }; }
  if ((await input.inputValue()) !== '') return { ok: false, code: 'field-occupied', reason: '物件扫码输入框已有内容，停在可核对位置以免覆盖' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await input.focus({ timeout }).catch(() => {});
    if (await page.evaluate(() => document.activeElement === document.querySelector('[aria-label="物件扫码"]'))) return { ok: true };
  }
  return { ok: false, code: 'focus-unavailable', reason: '无法把焦点放到物件扫码输入框，停在可核对位置' };
}

// 打开门户并等待首次回读完成，返回可录入的页面。
export async function openPortal(context, url, { timeout = 15000 } = {}) {
  const page = await context.newPage();
  const ready = page.waitForResponse(isBoxGet, { timeout });
  await page.goto(url);
  await ready;
  await stableRows(page);
  return page;
}

// 逐条回放确认过的扫码批次。每条消息：核对箱号与回读无漂移 → 交接消息身份 →
// 分段键盘输入并按声明的结束键提交 → 等门户自己的登记与回读完成 → 按来源身份核对回读。
// 任何一步对不上都停在可核对位置，余下消息原样报告，不悄悄装进新箱。
export async function runBatchEntry(page, batch, { timeout = 15000, onEvent } = {}) {
  const plan = validateBatch(batch);
  const emit = async event => { if (onEvent) await onEvent(event); };
  const report = { boxId: plan.boxId, revision: plan.revision, completed: false, processed: [], remaining: [], stoppedAt: null, code: null, reason: null, detail: null, rows: [] };
  const stop = async (message, failure) => {
    report.stoppedAt = message ? { index: message.index, messageId: message.messageId } : null;
    report.code = failure.code;
    report.reason = failure.reason;
    report.detail = failure.detail ?? null;
    report.remaining = plan.messages.filter(item => !report.processed.some(done => done.index === item.index)).map(item => item.messageId);
    await emit({ type: 'stop', index: message?.index ?? null, messageId: message?.messageId ?? null, code: failure.code, reason: failure.reason });
    return report;
  };
  try {
    const pageBox = await page.locator('#box').inputValue({ timeout });
    if (pageBox !== plan.boxId) {
      const refreshed = page.waitForResponse(isBoxGet, { timeout });
      await page.selectOption('#box', plan.boxId);
      await refreshed;
      await emit({ type: 'box-aligned', boxId: plan.boxId });
    }
    let verified = snapshotOf(await stableRows(page));
    report.rows = rowsOf(verified);
    for (const message of plan.messages) {
      const currentBox = await page.locator('#box').inputValue({ timeout });
      if (currentBox !== message.boxId) {
        return await stop(message, { code: 'box-mismatch', reason: `页面当前箱号 ${currentBox} 与消息 ${message.messageId} 的箱号 ${message.boxId} 不一致，停止以免把余下物件装进新箱`, detail: { pageBox: currentBox, messageBox: message.boxId } });
      }
      const drift = diffSnapshots(verified, snapshotOf(await readRows(page)));
      if (drift.length) {
        return await stop(message, { code: 'readback-drift', reason: '门户回读与已核对状态不一致，可能有人工修改，停在可核对位置', detail: { drift } });
      }
      const focus = await acquireScanFocus(page, timeout);
      if (!focus.ok) return await stop(message, focus);
      const responded = page.waitForResponse(isBoxPost, { timeout });
      const refreshed = page.waitForResponse(isBoxGet, { timeout });
      await page.evaluate(messageId => { window.confirmedScanMessage = messageId; }, message.messageId);
      for (const stroke of keystrokes(message)) {
        if (stroke.type === 'text') await page.keyboard.type(stroke.text);
        else await page.keyboard.press(stroke.key);
      }
      try {
        await Promise.all([responded, refreshed]);
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        return await stop(message, { code: 'portal-unresponsive', reason: '门户在限定时间内没有完成登记回读', detail: await diagnostics(page) });
      }
      const boxAfter = await page.locator('#box').inputValue({ timeout });
      if (boxAfter !== message.boxId) {
        return await stop(message, { code: 'box-changed', reason: `登记 ${message.messageId} 期间操作员更换了箱号，该消息已提交但回读无法核对，停在可核对位置`, detail: { pageBox: boxAfter, messageBox: message.boxId, submittedMessageId: message.messageId } });
      }
      const after = snapshotOf(await stableRows(page));
      const verdict = verifyMessage(message, verified, after);
      if (!verdict.ok) return await stop(message, { ...verdict, detail: { ...verdict.detail, status: await statusText(page) } });
      verified = after;
      report.rows = rowsOf(verified);
      report.processed.push({ index: message.index, messageId: message.messageId, code: message.code, intent: message.intent, outcome: verdict.outcome });
      await emit({ type: 'message', index: message.index, messageId: message.messageId, code: message.code, outcome: verdict.outcome });
    }
    report.completed = true;
    await emit({ type: 'complete', processed: report.processed.length });
    return report;
  } finally {
    // 退出前清除消息身份交接，避免操作员后续手工扫码沿用助手的消息身份。
    await page.evaluate(() => { delete window.confirmedScanMessage; }).catch(() => {});
  }
}
