# 合作来源约定

## 资料边界

本地 /portal 为实际可交互页面，扫码流程通过标注为“物件扫码”的输入和 Enter 触发，查询期间会替换 DOM。/scan-batches 仅提供经过操作员确认的 messageId、boxId、chunks、terminator、intent=add|retry。业务 /api/box 为页面内部使用，自动化不能绕过 UI。每个回读行包含 data-scan-message、物件编号、累计数量；重复 messageId 是重发，不同 messageId 才是新加件。界面支持操作员换箱及手动改数。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/scan-batches`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

## 扫码消息关联

操作员交给助手的 confirmed messageId 通过页面已有的 window.confirmedScanMessage 交接，仅携带该条扫码消息身份，不传物件或箱单内容。助手仍须通过真实键盘输入触发查物件及登记，不得调用页面业务接口。现有 scripts/browser-smoke.mjs 展示单条门户调用关系，不包含批次执行策略。

## 批次录入助手

`assistant/runner.mjs` 的 `runConfirmedBatch(page, portalUrl, envelope, onEvent?)` 实现批次执行，`scripts/browser-assistant.mjs` 是其命令行入口（`npm run browser:assistant`）。执行链把四类状态连在一起：来源扫码消息（messageId/chunks/terminator/intent）、页面当前箱号、扫码框焦点、门户回读行（物件编号、累计数量、`data-scan-message`）。

- 分段与结束键：每条消息的 chunks 用 `pressSequentially` 逐段键入，段间核对活动控件仍是“物件扫码”；完成判定只来自结束键（当前门户仅支持 Enter，映射见 `assistant/batch.mjs` 的 TERMINATOR_KEYS）以及页面自身的 `/api/box` 往返和扫码框重新出现，不使用固定间隔猜测输入是否结束。
- 重发与加件：已处理过的 messageId 或来源标注 intent=retry 都视为重发，不重新敲键，只在门户回读中找到同 messageId、同物件编号的行确认；新 messageId 的同物件才走键盘登记并增加数量。回读找不到重发原行、或来源称加件而门户回 duplicate 时停止。
- 换箱与手工修改：每条消息处理前后均核对箱号选择器与表格快照；操作员换箱（箱号不一致）或手工改数（出现助手未产生的行变化，例如 lastMessage 变为 operator）时，助手在该条消息之前停止，报告 stopReason、detail、已处理列表与 remaining，页面留在原处供核对，不会把后续物件装进新箱。
- 焦点守护：分段键入期间若活动元素离开扫码框立即停止，确保字符不会落入数量框或备注框。助手代码不包含任何业务接口调用；测试中对 `/api/box` 的读取仅用于断言门户状态。
