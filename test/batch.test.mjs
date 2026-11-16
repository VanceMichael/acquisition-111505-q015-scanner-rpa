import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnvelope, classifyMessage, sameRows, terminatorKey } from '../assistant/batch.mjs';

const valid = () => ({
  boxId: 'box-a', revision: 1,
  messages: [
    { messageId: 'scan-1', boxId: 'box-a', chunks: ['EX-', '001'], terminator: 'Enter', intent: 'add' },
  ],
});

test('批次归一化保留分段与拼接身份', () => {
  const messages = normalizeEnvelope(valid());
  assert.deepEqual(messages[0].chunks, ['EX-', '001']);
  assert.equal(messages[0].code, 'EX-001');
  assert.equal(terminatorKey('Enter'), 'Enter');
});

test('批次、箱号、分段或结束键不符时拒绝', () => {
  assert.throws(() => normalizeEnvelope({ boxId: 'box-a', messages: [] }), /没有扫码消息/);
  const wrongBox = valid(); wrongBox.messages[0].boxId = 'box-b';
  assert.throws(() => normalizeEnvelope(wrongBox), /批次箱号/);
  const badChunks = valid(); badChunks.messages[0].chunks = [''];
  assert.throws(() => normalizeEnvelope(badChunks), /chunks/);
  const badKey = valid(); badKey.messages[0].terminator = 'Tab';
  assert.throws(() => normalizeEnvelope(badKey), /结束键/);
  const badIntent = valid(); badIntent.messages[0].intent = 'guess';
  assert.throws(() => normalizeEnvelope(badIntent), /intent/);
});

test('分类以来源 messageId 身份优先，重发与新加件分开', () => {
  const [message] = normalizeEnvelope(valid());
  assert.equal(classifyMessage(message, new Set()), 'add');
  assert.equal(classifyMessage({ ...message, intent: 'retry' }, new Set()), 'retry');
  assert.equal(classifyMessage(message, new Set(['scan-1'])), 'retry');
});

test('回读快照对比识别数量与扫码消息身份变化', () => {
  const rows = [{ item: 'EX-001', quantity: 1, scanMessage: 'scan-1' }];
  assert.equal(sameRows(rows, [{ ...rows[0] }]), true);
  assert.equal(sameRows(rows, [{ ...rows[0], quantity: 2 }]), false);
  assert.equal(sameRows(rows, [{ ...rows[0], scanMessage: 'operator' }]), false);
  assert.equal(sameRows(rows, rows.concat([{ item: 'EX-002', quantity: 1, scanMessage: 'scan-2' }])), false);
});
