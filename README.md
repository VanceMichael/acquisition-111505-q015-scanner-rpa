# 装箱门户扫码输入的焦点归属与合箱录入自动化

这是面向资料接收人员的 Node.js 服务。当前提供人工收件、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。自动来源接入目前不提供，`POST /api/collect` 返回 501，不会把人工导入宣称为自动采集。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。浏览器自动化使用锁定的 Playwright 1.56.1；来源不依赖公网数据。容器已包含配套 Chromium。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口展示现有来源与人工收件，结束即清理，通常只需数秒，当前不演示尚未提供的自动采集。

## 容器

`docker build -t scanner-rpa:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 scanner-rpa:local` 启动。环境准备后，`docker run --rm --network none scanner-rpa:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部人工收件版本，`GET /health` 检查进程。人工记录身份字段为 box, message。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

`src/` 为收件与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构。

## 浏览器

`npm run browser:smoke` 通过真实 Chromium 访问门户并完成一次键盘扫码和回读。镜像构建时准备依赖，运行不下载浏览器；浏览器驱动和业务接收仍使用 Node.js 22.22.1。

`npm run batch:entry` 运行批次录入助手：从来源 `/scan-batches` 读取操作员确认过的扫码批次，在真实 Chromium 里按分段输入和声明的结束键逐条键盘录入，不靠固定间隔猜测输入是否结束，也不调用页面业务接口。每条消息经 `window.confirmedScanMessage` 交接消息身份；录入前确认当前箱号与消息一致、焦点在物件扫码框且框内无残留；录入后按门户回读行（data-scan-message、物件编号、累计数量）核对：add 必须数量加一且消息身份落行，retry 不得重复计数，声明与回读冲突即停止。操作员中途换箱、人工改数或扫码框被占用时，助手停在可核对位置并报告余下消息，不会把余下物件装进新箱；退出前清除消息身份交接。`SOURCE_URL` 可指向外部来源，默认本地启动来源。批次全部完成退出码为 0，中途停止为 1。
