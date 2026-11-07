# 魔法披风用户中心

当前使用真实 GM Pay / USDT-BSC 支付流程。没有网关配置时，支付关闭、报价待配置、订单为空；不会生成假收款地址或付款成功。

## 本地运行

当前推荐在本目录运行 `npm run local`，统一启动 API 与 Vite；也可双击项目根目录 `start-local.cmd`。真实本地 GM Pay 已独立安装，可用 `npm run local:gmpay` 启动。登录凭据、局域网测试和一致性迁移快照见 [本地手册](../LOCAL.md)。以下分开启动方式保留用于排查。

环境为 Node.js 24。

```powershell
npm ci
npm run dev:api
```

另一个终端：

```powershell
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

默认 API 在 127.0.0.1:8788，Vite 同源代理 /api/v1。已有本地预览保持开启。没有 .env 时收款默认关闭。

生产：npm run build 后 npm start，并通过 HTTPS 反向代理。完整配置和公网部署步骤见 [PAYMENTS.md](PAYMENTS.md)。

服务器采购、支付宝渠道、Linux Docker 部署、私下初始化 GM Pay 和主网验收见 [部署手册](../deploy/README.md)。网站和后台仍在本机，仅签名通知按授权使用临时公开HTTPS。

本地可运行 `npm run deploy:package` 生成安装包及校验文件；`npm run deploy:check` 检查实际部署配置，缺少配置时返回失败。`npm run test:deployment` 覆盖上线检查与真实 HTTP 服务启动。运行中的 `/api/v1/health` 仅检查门户及数据库，不代表网关或主网付款已验收。

## 主要实现

- src/RealPortal.jsx：真实账户与订单页面；不读取旧 localStorage 财务数据。
- src/payments.jsx：登录、创建订单、真实收银台、只读状态刷新。
- src/NavigationPages.jsx：套餐、订单、礼品卡和知识库的页面布局。
- server/gmpay.mjs：官方 v2 HMAC-SHA256、资产发现、真实订单协议。
- server/app.mjs：账户归属、Origin、幂等请求、回调校验。
- server/store.mjs：SQLite 原子支付状态、交付任务与礼品卡。
- server/index.mjs：Node API 与生产静态文件服务。
- server/manage.mjs：本机账户发放/禁用与待交付任务查询。
- config/payment-catalog.example.json / .env.example：待填写的配置模板。

## 边界

本机USDT-BSC通道已生成真实待付款收银台，主网实付和回调待本人验收；支付宝/微信未接入。已付款套餐进入待开通队列，尚未对接节点面板或签发真实订阅。积分和自助邀请显示未开放。在线工单已接入真实后端，支持账户隔离、提交、补充、管理员 CLI 回复及关闭，见 [TICKETS.md](TICKETS.md)。

旧 Portal.jsx 已归档至仓库 .backups/before-web3-payment/，保留可回退副本，不在应用中运行。旧原型 QA 与截图是历史记录，以 [payments-qa.md](payments-qa.md) 为准。

## 检查

```powershell
npm run test:payments
npm run test:pricing
npm run build
npm run test:sites
```

测试不会进行真实转账。Sites 适配测试仅验证静态模板，不代表其包含 Node/SQLite 支付后端。
