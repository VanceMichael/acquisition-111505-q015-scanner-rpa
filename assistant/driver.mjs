// 浏览器录入助手的键盘驱动：只做真人在页面上能做的事——聚焦、敲键、回读。
// 这里不出现任何 /api/box、/api/manual-change 等业务接口调用。

export const SCAN_BOX_NAME = '物件扫码';
export const BOX_SELECT_NAME = '当前箱号';

export async function openPortal(page, portalUrl) {
  await page.goto(portalUrl);
  const scanBox = page.getByRole('textbox', { name: SCAN_BOX_NAME });
  await scanBox.waitFor({ state: 'visible' });
  // 等首轮回读表格渲染完，再以页面自身状态作为助手基线（空 tbody 不可见，只等挂载）。
  await page.locator('#rows').waitFor({ state: 'attached' });
  return scanBox;
}

export async function readCurrentBox(page) {
  return page.getByRole('combobox', { name: BOX_SELECT_NAME }).inputValue();
}

// 回读是助手唯一信任的登记结果来源：物件编号、累计数量、行上的扫码消息身份。
export async function readRows(page) {
  const locator = page.locator('#rows tr');
  const count = await locator.count();
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const row = locator.nth(index);
    rows.push({
      item: (await row.locator('td').first().innerText()).trim(),
      quantity: Number((await row.getByRole('spinbutton').first().inputValue()).trim()),
      scanMessage: (await row.getAttribute('data-scan-message')) || '',
    });
  }
  return rows;
}

// 按 source-contract.md 的交接约定，只交接本消息身份，不传物件或箱单。
export async function declareConfirmedMessage(page, messageId) {
  await page.evaluate(id => { window.confirmedScanMessage = id; }, messageId);
}

export async function focusScanBox(page) {
  const scanBox = page.getByRole('textbox', { name: SCAN_BOX_NAME });
  await scanBox.waitFor({ state: 'visible' });
  await scanBox.click();
  return scanBox;
}

export async function activeElementAriaLabel(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
}

export async function clearFocusedValue(page) {
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
}

// 逐段键入扫码枪分段：每段之后都核对焦点仍在扫码框，
// 不使用任何固定间隔来猜测扫码是否结束。
export async function typeChunks(page, scanBox, chunks) {
  for (const chunk of chunks) {
    const label = await activeElementAriaLabel(page);
    if (label !== SCAN_BOX_NAME) {
      throw new Error(`扫码框焦点丢失（当前焦点：${label || '无'}），暂停录入`);
    }
    await scanBox.pressSequentially(chunk);
  }
}

// 按结束键并等页面自身的查件/登记往返结束，再确认扫码框重新出现（DOM 已重绘）。
export async function settleWithTerminator(page, key) {
  const responsePromise = page.waitForResponse(
    reply => reply.url().endsWith('/api/box') && reply.request().method() === 'POST',
    { timeout: 15000 },
  );
  await page.keyboard.press(key);
  const response = await responsePromise;
  const body = await response.json().catch(() => ({}));
  await page.getByRole('textbox', { name: SCAN_BOX_NAME }).waitFor({ state: 'visible', timeout: 15000 });
  return { status: response.status(), body };
}
