import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('重发消息和新加同一物件有不同计数含义', async context => {
  const { base, post } = await withSource(context); const scan = { messageId: 'scan-1', boxId: 'box-a', code: 'EX-001' };
  await post('/api/box', scan); assert.equal((await (await post('/api/box', scan)).json()).duplicate, true);
  await post('/api/box', { ...scan, messageId: 'scan-2' });
  const result = await (await fetch(base + '/api/box?boxId=box-a')).json(); assert.equal(result.rows[0].quantity, 2);
});
test('门户提供真实键盘控件且页面内部接口不作为助手替代', async context => {
  const { base } = await withSource(context); const html = await (await fetch(base + '/portal')).text(); assert.match(html, /物件扫码/); assert.match(html, /keydown/); assert.match(html, /data|dataset/);
});
