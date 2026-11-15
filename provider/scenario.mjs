export const initialState = () => ({ name: '扫码装箱门户', revision: 1 });

import { readFile } from 'node:fs/promises';
export async function handle({ incoming, url, body, state, json, bytes }) {
  state.boxes ||= { 'box-a': {}, 'box-b': {} }; state.messages ||= {}; state.mutations ||= 0;
  if (url.pathname === '/portal') { bytes(200, await readFile(new URL('../fixtures/portal.html', import.meta.url)), 'text/html; charset=utf-8'); return true; }
  if (url.pathname === '/scan-batches') { json(200, { boxId: 'box-a', revision: state.revision, messages: [
    { messageId: 'scan-1', boxId: 'box-a', chunks: ['EX-', '001'], terminator: 'Enter', intent: 'add' },
    { messageId: 'scan-1', boxId: 'box-a', chunks: ['EX-001'], terminator: 'Enter', intent: 'retry' },
    { messageId: 'scan-2', boxId: 'box-a', chunks: ['EX-001'], terminator: 'Enter', intent: 'add' }
  ] }); return true; }
  if (url.pathname === '/api/box' && incoming.method === 'GET') { const boxId = url.searchParams.get('boxId') || 'box-a'; json(200, { boxId, revision: state.mutations, rows: Object.values(state.boxes[boxId] || {}) }); return true; }
  if (url.pathname === '/api/box' && incoming.method === 'POST') {
    if (!body?.messageId || !body.boxId || !/^EX-\d{3}$/.test(body.code || '')) { json(422, { error: '扫码消息或物件无效' }); return true; }
    if (state.delay) await new Promise(resolve => setTimeout(resolve, Math.min(state.delay, 1000)));
    if (state.messages[body.messageId]) { json(200, { ...state.messages[body.messageId], duplicate: true }); return true; }
    const box = state.boxes[body.boxId] ||= {}; const previous = box[body.code];
    const row = { item: body.code, quantity: (previous?.quantity || 0) + 1, lastMessage: body.messageId };
    box[body.code] = row; state.messages[body.messageId] = { boxId: body.boxId, ...row }; state.mutations += 1; json(200, state.messages[body.messageId]); return true;
  }
  if (url.pathname === '/api/manual-change') { const row = state.boxes[body?.boxId]?.[body?.item]; if (!row) json(404, { error: '物件尚未登记' }); else { row.quantity = body.quantity; row.lastMessage = 'operator'; state.mutations += 1; json(200, row); } return true; }
  return false;
}
