// 批次执行器：把“扫码消息、当前箱号、页面焦点、回读物件身份”串成一条可核对的链。
// 所有登记都经由真实键盘交互完成；任何对不上的状态都停下并返回可核对现场，不继续装件。

import { request, decodeJson } from '../src/transport.mjs';
import {
  normalizeEnvelope, classifyMessage, sameRows, terminatorKey,
} from './batch.mjs';
import {
  openPortal, readCurrentBox, readRows, declareConfirmedMessage,
  focusScanBox, activeElementAriaLabel, clearFocusedValue,
  typeChunks, settleWithTerminator, SCAN_BOX_NAME,
} from './driver.mjs';

export async function fetchScanBatches(sourceBase, probePath) {
  const reply = await request(new URL(probePath, sourceBase).href);
  return decodeJson(reply);
}

async function stopped(reason, detail, report, page) {
  return { ...report, status: 'stopped', stopReason: reason, detail, observedBoxId: await readCurrentBox(page) };
}

// page：已创建的 Playwright Page（尚未打开门户也可）；portalUrl：门户页面地址。
// envelope：操作员确认过的扫码批次。
// onEvent：可选回调，便于操作台记录每一步，也用于测试在步骤间插入操作员动作。
export async function runConfirmedBatch(page, portalUrl, envelope, onEvent = null) {
  const emit = async event => { if (onEvent) await onEvent(event); };
  const messages = normalizeEnvelope(envelope);
  const report = {
    status: 'running',
    stopReason: null,
    detail: null,
    batchBoxId: envelope.boxId,
    observedBoxId: null,
    processed: [],
    retriesConfirmed: [],
    remaining: messages.map(message => message.messageId),
    journal: [],
  };

  await openPortal(page, portalUrl);
  let observedBoxId = await readCurrentBox(page);
  report.observedBoxId = observedBoxId;
  let baseline = await readRows(page);
  const knownMessageIds = new Set();

  for (const message of messages) {
    const journalEntry = {
      messageId: message.messageId, intent: message.intent,
      chunks: [...message.chunks], code: message.code, boxId: message.boxId,
    };

    // 守卫 1：批次箱号必须与页面当前箱号一致，防止把余下物件装进新箱。
    observedBoxId = await readCurrentBox(page);
    if (observedBoxId !== message.boxId) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'box-mismatch';
      report.journal.push(journalEntry);
      return stopped('box-mismatch', { expected: message.boxId, observed: observedBoxId, messageId: message.messageId }, report, page);
    }

    // 守卫 2：页面表格若在助手未操作时发生变化，说明操作员插入了手工修改，停下核对。
    const before = await readRows(page);
    if (!sameRows(before, baseline)) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'manual-drift';
      report.journal.push(journalEntry);
      return stopped('manual-drift', { baseline, observed: before, messageId: message.messageId }, report, page);
    }

    await emit({ phase: 'before-message', messageId: message.messageId, intent: message.intent });

    // 回调后再次核对，操作员可能在这一步换箱或改数。
    observedBoxId = await readCurrentBox(page);
    if (observedBoxId !== message.boxId) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'box-mismatch';
      report.journal.push(journalEntry);
      return stopped('box-mismatch', { expected: message.boxId, observed: observedBoxId, messageId: message.messageId }, report, page);
    }
    const afterEvent = await readRows(page);
    if (!sameRows(afterEvent, baseline)) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'manual-drift';
      report.journal.push(journalEntry);
      return stopped('manual-drift', { baseline, observed: afterEvent, messageId: message.messageId }, report, page);
    }

    const kind = classifyMessage(message, knownMessageIds);

    if (kind === 'retry') {
      // 重发不重新敲键。用门户回读确认同一条扫码消息已登记，且物件行仍在同一箱。
      const rows = await readRows(page);
      const claimed = rows.find(row => row.scanMessage === message.messageId);
      if (!claimed) {
        journalEntry.outcome = 'halted'; journalEntry.reason = 'retry-unverified';
        report.journal.push(journalEntry);
        return stopped('retry-unverified', { messageId: message.messageId, rows }, report, page);
      }
      if (claimed.item !== message.code) {
        journalEntry.outcome = 'halted'; journalEntry.reason = 'retry-identity-mismatch';
        report.journal.push(journalEntry);
        return stopped('retry-identity-mismatch', { messageId: message.messageId, claimed: claimed.item, expected: message.code }, report, page);
      }
      knownMessageIds.add(message.messageId);
      report.retriesConfirmed.push(message.messageId);
      report.remaining.shift();
      baseline = rows;
      journalEntry.outcome = 'retry-confirmed';
      journalEntry.row = { item: claimed.item, quantity: claimed.quantity, scanMessage: claimed.scanMessage };
      report.journal.push(journalEntry);
      await emit({ phase: 'retry-confirmed', messageId: message.messageId, row: journalEntry.row });
      continue;
    }

    // 新扫码：按来源身份交接 → 聚焦 → 逐段键盘输入 → 结束键提交。
    const key = terminatorKey(message.terminator);
    if (!key) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'unsupported-terminator';
      report.journal.push(journalEntry);
      return stopped('unsupported-terminator', { terminator: message.terminator, messageId: message.messageId }, report, page);
    }

    await declareConfirmedMessage(page, message.messageId);
    let scanBox;
    try {
      scanBox = await focusScanBox(page);
      if ((await activeElementAriaLabel(page)) !== SCAN_BOX_NAME) {
        throw new Error('扫码框未能获得焦点');
      }
      await clearFocusedValue(page);
      await typeChunks(page, scanBox, message.chunks);
    } catch (error) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'focus-lost';
      report.journal.push(journalEntry);
      return stopped('focus-lost', { messageId: message.messageId, error: error.message }, report, page);
    }

    // 结束键触发页面自身的查件与登记；助手等待该往返和 DOM 重绘，而不是按时间猜测。
    let settlement;
    try {
      settlement = await settleWithTerminator(page, key);
    } catch (error) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'portal-settlement-failed';
      report.journal.push(journalEntry);
      return stopped('portal-settlement-failed', { messageId: message.messageId, error: error.message }, report, page);
    }
    if (settlement.status < 200 || settlement.status > 299 || settlement.body?.error) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'portal-rejected';
      report.journal.push(journalEntry);
      return stopped('portal-rejected', { messageId: message.messageId, status: settlement.status, body: settlement.body }, report, page);
    }
    if (settlement.body.duplicate === true) {
      // 来源说是新加件，门户却回重复：身份对不上，停下让人核对，不做任何推断。
      journalEntry.outcome = 'halted'; journalEntry.reason = 'duplicate-conflict';
      report.journal.push(journalEntry);
      return stopped('duplicate-conflict', { messageId: message.messageId, body: settlement.body }, report, page);
    }

    // 以页面回读建立物件身份：行的扫码消息必须正是本条消息，编号必须等于分段拼接结果。
    const rows = await readRows(page);
    const row = rows.find(item => item.scanMessage === message.messageId);
    if (!row || row.item !== message.code) {
      journalEntry.outcome = 'halted'; journalEntry.reason = 'readback-identity-mismatch';
      report.journal.push(journalEntry);
      return stopped('readback-identity-mismatch', { messageId: message.messageId, expected: message.code, rows }, report, page);
    }

    knownMessageIds.add(message.messageId);
    report.processed.push({ messageId: message.messageId, item: row.item, quantity: row.quantity });
    report.remaining.shift();
    baseline = rows;
    journalEntry.outcome = 'registered';
    journalEntry.row = { item: row.item, quantity: row.quantity, scanMessage: row.scanMessage };
    report.journal.push(journalEntry);
    await emit({ phase: 'registered', messageId: message.messageId, row: journalEntry.row });
  }

  report.status = 'completed';
  report.observedBoxId = await readCurrentBox(page);
  return report;
}
