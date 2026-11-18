import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch, keystrokes, snapshotOf, diffSnapshots, verifyMessage } from '../src/assistant.mjs';

const batch = {
  boxId: 'box-a',
  revision: 1,
  messages: [
    { messageId: 'scan-1', boxId: 'box-a', chunks: ['EX-', '001'], terminator: 'Enter', intent: 'add' },
    { messageId: 'scan-1', boxId: 'box-a', chunks: ['EX-001'], terminator: 'Enter', intent: 'retry' }
  ]
};

test('批次校验拼出物件编号并保留分段与结束键', () => {
  const plan = validateBatch(batch);
  assert.equal(plan.boxId, 'box-a');
  assert.equal(plan.messages[0].code, 'EX-001');
  assert.deepEqual(plan.messages[0].chunks, ['EX-', '001']);
  assert.equal(plan.messages[1].intent, 'retry');
});

test('不可执行的批次在触碰页面之前被拒绝', () => {
  assert.throws(() => validateBatch(null), /应是对象/);
  assert.throws(() => validateBatch({ messages: [] }), /箱号/);
  assert.throws(() => validateBatch({ boxId: 'box-a' }), /messages/);
  const bad = (message, pattern) => assert.throws(() => validateBatch({ boxId: 'box-a', messages: [message] }), pattern);
  bad({}, /messageId/);
  bad({ messageId: 'm1', chunks: ['EX-001'], terminator: 'Enter', intent: 'add' }, /箱号/);
  bad({ messageId: 'm1', boxId: 'box-a', chunks: [], terminator: 'Enter', intent: 'add' }, /chunks/);
  bad({ messageId: 'm1', boxId: 'box-a', chunks: ['EX-\n'], terminator: 'Enter', intent: 'add' }, /换行/);
  bad({ messageId: 'm1', boxId: 'box-a', chunks: ['EX-001'], terminator: 'Tab', intent: 'add' }, /结束键/);
  bad({ messageId: 'm1', boxId: 'box-a', chunks: ['EX-001'], terminator: 'Enter', intent: 'merge' }, /intent/);
});

test('按键计划逐段输入并以声明的结束键收尾', () => {
  const [message] = validateBatch(batch).messages;
  assert.deepEqual(keystrokes(message), [
    { type: 'text', text: 'EX-' },
    { type: 'text', text: '001' },
    { type: 'key', key: 'Enter' }
  ]);
});

test('回读快照比对发现数量、消息身份与行增减变化', () => {
  const before = snapshotOf([{ item: 'EX-001', quantity: 1, scanMessage: 'scan-1' }]);
  assert.deepEqual(diffSnapshots(before, before), []);
  const changed = snapshotOf([{ item: 'EX-001', quantity: 2, scanMessage: 'scan-2' }]);
  assert.deepEqual(diffSnapshots(before, changed), [{ item: 'EX-001', before: { quantity: 1, scanMessage: 'scan-1' }, after: { quantity: 2, scanMessage: 'scan-2' } }]);
  assert.equal(diffSnapshots(before, snapshotOf([]))[0].after, null);
  assert.equal(diffSnapshots(snapshotOf([]), before)[0].before, null);
});

test('新加件要求数量加一且消息身份落行', () => {
  const message = { messageId: 'scan-2', code: 'EX-001', intent: 'add' };
  const before = snapshotOf([{ item: 'EX-001', quantity: 1, scanMessage: 'scan-1' }]);
  const after = snapshotOf([{ item: 'EX-001', quantity: 2, scanMessage: 'scan-2' }]);
  assert.deepEqual(verifyMessage(message, before, after), { ok: true, outcome: 'registered' });
  assert.equal(verifyMessage(message, before, before).code, 'identity-conflict');
  const wrongIdentity = snapshotOf([{ item: 'EX-001', quantity: 2, scanMessage: 'other' }]);
  assert.equal(verifyMessage(message, before, wrongIdentity).code, 'verification-failed');
});

test('重发消息不重复计数，首次落地也按一次登记接受', () => {
  const message = { messageId: 'scan-1', code: 'EX-001', intent: 'retry' };
  const before = snapshotOf([{ item: 'EX-001', quantity: 1, scanMessage: 'scan-1' }]);
  assert.deepEqual(verifyMessage(message, before, before), { ok: true, outcome: 'duplicate-confirmed' });
  const landed = snapshotOf([{ item: 'EX-001', quantity: 2, scanMessage: 'scan-1' }]);
  assert.deepEqual(verifyMessage(message, before, landed), { ok: true, outcome: 'retry-landed' });
  const empty = snapshotOf([]);
  assert.equal(verifyMessage(message, empty, empty).code, 'verification-failed');
});

test('登记期间其他物件行变化属于漂移', () => {
  const message = { messageId: 'scan-2', code: 'EX-001', intent: 'add' };
  const before = snapshotOf([{ item: 'EX-009', quantity: 3, scanMessage: 'scan-0' }]);
  const after = snapshotOf([{ item: 'EX-009', quantity: 4, scanMessage: 'operator' }, { item: 'EX-001', quantity: 1, scanMessage: 'scan-2' }]);
  assert.equal(verifyMessage(message, before, after).code, 'readback-drift');
});
