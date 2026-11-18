# 合作来源约定

## 资料边界

本地 /portal 为实际可交互页面，扫码流程通过标注为“物件扫码”的输入和 Enter 触发，查询期间会替换 DOM。/scan-batches 仅提供经过操作员确认的 messageId、boxId、chunks、terminator、intent=add|retry。业务 /api/box 为页面内部使用，自动化不能绕过 UI。每个回读行包含 data-scan-message、物件编号、累计数量；重复 messageId 是重发，不同 messageId 才是新加件。界面支持操作员换箱及手动改数。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义（含 `delay` 模拟查找变慢、`batches` 覆盖 `/scan-batches` 内容），切换只影响后续来源响应，不会改写已有收件。探查入口为 `/scan-batches`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

## 扫码消息关联

操作员交给助手的 confirmed messageId 通过页面已有的 window.confirmedScanMessage 交接，仅携带该条扫码消息身份，不传物件或箱单内容。助手仍须通过真实键盘输入触发查物件及登记，不得调用页面业务接口。现有 scripts/browser-smoke.mjs 展示单条门户调用关系，不包含批次执行策略。

## 批次录入助手

`src/assistant.mjs` 提供 `openPortal` 与 `runBatchEntry`，`scripts/batch-entry.mjs` 是运行入口。助手把 `/scan-batches` 的确认批次逐条回放：按 chunks 分段键盘输入、按声明的 terminator 结束，不用固定间隔猜测输入完成。每条消息录入前核对当前箱号、扫码框焦点与占用情况，录入后等门户自己的登记与回读完成，再按来源身份核对回读行：add 要求数量加一且 messageId 落行，retry 不得改变数量；同一 messageId 被声明成两次新加、回读出现人工改数漂移、操作员换箱、扫码框被占用或门户无响应时，助手停在可核对位置并报告余下消息，退出前清除 window.confirmedScanMessage 交接。
