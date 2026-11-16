// 扫码批次的纯逻辑：归一化、消息分类、回读快照对比。
// 本文件不依赖浏览器，便于直接单元测试。

// 门户页面仅以 Enter 作为扫码结束键（见 fixtures/portal.html 的 keydown 处理）。
// 映射表是唯一的结束键扩展点：新增扫码枪结束键时在此登记，并由页面侧验证。
const TERMINATOR_KEYS = new Map([
  ['Enter', 'Enter'],
  ['enter', 'Enter'],
]);

export function terminatorKey(terminator) {
  return TERMINATOR_KEYS.get(terminator);
}

export function normalizeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('扫码批次应为对象');
  }
  const { boxId, revision, messages } = envelope;
  if (!boxId || typeof boxId !== 'string') throw new Error('批次缺少箱号 boxId');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('批次没有扫码消息');
  return messages.map((message, index) => {
    const prefix = `第 ${index + 1} 条扫码消息`;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error(`${prefix}不是对象`);
    }
    const { messageId, boxId: messageBox, chunks, terminator, intent } = message;
    if (!messageId || typeof messageId !== 'string') throw new Error(`${prefix}缺少 messageId`);
    if (!messageBox || typeof messageBox !== 'string') throw new Error(`${prefix}缺少 boxId`);
    if (messageBox !== boxId) throw new Error(`${prefix}箱号 ${messageBox} 与批次箱号 ${boxId} 不一致`);
    if (!Array.isArray(chunks) || chunks.length === 0 || chunks.some(chunk => typeof chunk !== 'string' || chunk === '')) {
      throw new Error(`${prefix}缺少扫码分段 chunks`);
    }
    if (!TERMINATOR_KEYS.has(terminator)) {
      throw new Error(`${prefix}结束键 ${String(terminator)} 不受门户支持`);
    }
    if (intent !== 'add' && intent !== 'retry') throw new Error(`${prefix}intent 应为 add 或 retry`);
    return {
      index,
      messageId,
      boxId: messageBox,
      chunks: [...chunks],
      terminator,
      intent,
      // 拼接结果仅用于回读核对，助手不拿它调用任何业务接口。
      code: chunks.join(''),
    };
  });
}

// 来源身份优先：已处理过的 messageId 一律视为重发；否则按来源标注的 intent 分类。
export function classifyMessage(message, knownMessageIds) {
  if (knownMessageIds.has(message.messageId)) return 'retry';
  return message.intent === 'retry' ? 'retry' : 'add';
}

export function sameRows(left, right) {
  if (left.length !== right.length) return false;
  const ordered = rows => [...rows].sort((a, b) => a.item.localeCompare(b.item));
  return ordered(left).every((row, index) => {
    const other = ordered(right)[index];
    return row.item === other.item
      && String(row.quantity) === String(other.quantity)
      && row.scanMessage === other.scanMessage;
  });
}
