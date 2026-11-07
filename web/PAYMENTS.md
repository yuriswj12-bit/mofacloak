# GM Pay / USDT-BSC 真实支付接入

## 当前状态

代码已接入真实 GMPay 商户协议与持久化订单服务。当前没有网关、商户密钥或收款地址，所以 `PAYMENTS_ENABLED=false`，不接受付款，没有收款二维码、虚拟余额或模拟成功入口。

默认资产为 USDT / BSC（BEP20）。网关新版可能用 `binance` 表示 BSC，旧版资产配置可能返回 `bsc`；适配器先查询公开资产配置，再使用网关实际返回的标识。

官方协议：[支付接口](https://www.epusdt.com/api/payment)、[源代码与发布](https://github.com/GMWalletApp/epusdt)、[版本变更](https://epusdt.com/guide/changelog)。接入目标为 GMPay v2 HMAC-SHA256，不兼容旧 GMPay MD5 或 EPay MD5。

## 实际收款前需要的资源

1. 可部署 Node.js 24 服务的服务器、本站 HTTPS 域名，以及 GM Pay 网关的 HTTPS 地址。当前代码使用 Node 原生 SQLite，不能仅部署为静态网页。
2. 部署官方 GM Pay / epusdt，在网关配置 USDT / BSC 网络、可用 RPC / 查询通道和你自己的 BSC 公开收款地址。本站不需要钱包私钥或助记词。当前接入只面向 USDT / BSC，上线时在该商户收银台保持相同资产范围。
3. 网关后台生成的商户 PID 和 secret_key，写入本站服务端环境配置。不要放入网页、`VITE_*` 变量、Git 或聊天中。
4. 确认真实套餐价格和权益，以及付款后的人工交付流程或节点面板接入。当前回调生成待开通任务，不会伪造节点或订阅。

## 本地开发

在 `web/` 中：

```powershell
npm ci
Copy-Item .env.example .env
npm run dev:api
```

另开终端运行：

```powershell
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

前端只访问相对路径 `/api/v1/*`。Vite 在开发环境将其代理给本机 8788 端口。当前两个服务已启动，未填写凭据时页面显示支付未开通，不会尝试真实下单。

## 配置真实网关

复制 `config/payment-catalog.example.json` 为 `config/payment-catalog.json`，填写确认后的 CNY 月价、年价和权益；这个配置文件与 `.env` 均已从 Git 忽略。示例中的金额是配置模板，不能自动视为正式售价。

`.env` 生产配置格式：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8788
PUBLIC_ORIGIN=https://YOUR_PORTAL_DOMAIN
TRUST_PROXY=true
DATABASE_PATH=data/portal.sqlite
GMPAY_BASE_URL=https://YOUR_GATEWAY_DOMAIN
GMPAY_PID=YOUR_MERCHANT_PID
GMPAY_SECRET_KEY=FILL_LOCALLY
PAYMENT_CATALOG_FILE=config/payment-catalog.json
PAYMENTS_ENABLED=true
```

这里全部是占位格式，不是已存在的域名或凭据。生产模式强制本站与网关使用 HTTPS origin。未配全必需项时，启用收款会导致启动失败，避免误开放。

部署：

```powershell
npm ci
npm run build
npm start
```

`npm start` 提供真实 API 和 `dist/client` 静态文件。生产必须经 HTTPS 反向代理；不要使用 Vite 开发服务器对外收款。仓库保留的 `worker/index.js` 只是旧静态托管适配，不包含 Node/SQLite 支付服务。

反向代理示意（放入你已有的 HTTPS server 块）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 16k;
}
```

`TRUST_PROXY=true` 仅在请求来自回环地址时采信代理覆盖的 `X-Real-IP`，用于分开计算访问限流。不要把客户端自行传入的值直接透传。HTTPS 生产会话使用 Secure / HttpOnly / SameSite=Lax cookie；账户与付款写请求校验本站 Origin。

## 邀请制账户

当前补了最小的真实账户隔离，访问码为随机 32 字节，只在数据库保存其哈希。

```powershell
npm run user:create -- 客户名称
```

命令在本地终端显示一次账户 ID 和访问码。由管理员通过可信渠道私下交给对应客户，不在聊天中批量展示。客户在「用户设置」中登录。不同账户不能访问彼此订单与礼品卡。

禁用某个账户并撤销其会话：

```powershell
npm run user:disable -- ACCOUNT_ID
```

这不是完整邮箱/密码/找回系统；账号访问码需要由管理员和客户妥善保管。没有公开自助注册。

## 付款与开通流程

1. 用户登录后选择套餐。客户端仅提交 `planId / cycle / kind` 和幂等请求标识；任何自定义金额字段都会被拒绝。
2. 服务端按配置确定 CNY 金额，将订单存入 SQLite，再签名调用 GM Pay。USDT 数量由网关报价，不使用网页固定汇率。
3. 网关返回已分配地址、精确数量、有效期和收银台 URL 后，页面提供真实收银台链接。链接必须属于配置的网关 origin 和收银台路径。
4. 用户自行在网关收银台完成付款。本站没有代用户发起转账、签署钱包授权或读取私钥的功能。
5. GM Pay POST JSON 通知本站。本站验证 HMAC-SHA256、PID、订单号、CNY 金额、成功状态、USDT 及有效交易字段，随后原子更新已付款记录。
6. 套餐订单生成 `fulfillment_jobs` 待开通任务；礼品卡订单签发一次随机兑换码。兑换礼品卡原子生成收件人的待开通任务。

回调地址自动固定为：

```text
https://YOUR_PORTAL_DOMAIN/api/v1/payments/gmpay/notify
```

成功回调返回 HTTP 200 和 `success`。重复通知只确认原订单，不重复生成开通任务或礼品卡。网页返回、URL 中的 `paid=true`、用户点击「我已付款」以及未签名的公开支付状态均不能授予权益。

收银台报价过期后不要照旧地址或旧数量付款。网关状态异常或创建请求超时时，订单会保留为「待核对」，不会自动换订单号再次下单。管理员在 GM Pay 后台按商户订单号核对，并使用网关的真实通知重试能力处理；本站没有手动伪造付款成功的接口。

若资产预检查就失败、尚未调用网关创建交易，订单标为「创建失败」，不占待支付名额。关闭新收款时，只要仍保留正确 PID/密钥，已创建订单的有效签名回调仍可入账；有未结订单时不要直接更换商户凭据。

## 服务交付边界

付款确认不等于节点开通。查看待处理任务：

```powershell
npm run fulfillment:list
```

这是一份真实付款/礼品卡兑换产生的交付队列。目前没有调用节点面板，也没有伪造在线订阅、流量和到期时间。正式对外收款前，需要实际资源和人工交付安排，或继续接入现有节点管理面板。

积分和自助邀请尚未接入真实服务，页面显示未开放。在线工单已接入真实 SQLite，支持提交、补充、管理员 CLI 回复及关闭，见 TICKETS.md。旧浏览器缓存没有删除，但新前端不读取其中的财务数据。

## 数据与运维

- 数据库默认 `web/data/portal.sqlite`，使用 WAL 与事务；数据目录与 `.env` 不对外静态托管。
- 备份时停服务复制完整 data 目录，或使用 SQLite 正规在线备份流程；不能只复制运行中的主 `.sqlite` 文件而丢弃 WAL。
- 开通任务、订单、礼品卡和会话都存服务端。生产适配器不会依赖 localStorage。
- `user:create` 与 `fulfillment:list` 是本机管理命令，没有公开管理 API。
- API 监听回环地址；回调必须通过公网 HTTPS 反向代理可达。当前本机地址不是公网回调地址。

## 验证

```powershell
npm run test:payments
npm run test:pricing
npm run test:deployment
npm run build
npm run test:sites
```

支付测试使用隔离的内存/临时数据库和接口测试替身，不会向真实网关发起交易，也不是用户可用的虚拟收款功能。本地网关、钱包、节点和真实收银台已联调，主网实付和到账通知仍待本人验收。真实启用后需要由你在实际收银台完成一笔小额付款，检查签名通知、落库与交付队列；当前没有代替你进行该付款。

## 当前配置补充

价格见config/payment-catalog.confirmed.json，年付优惠20%。参考USDT数来自动态汇率，实付以收银台为准。人民币渠道缺少商户接口，仍未开通。

官方10041拒绝私网通知，现已授权仅公开签名通知转发器。GMPAY_NOTIFY_ORIGIN可与PUBLIC_ORIGIN分离；同机HTTP网关必须显式启用并有公开HTTPS通知源，生产规则仍强制HTTPS。见根目录GM-PAY-SETUP.md和PLAN-REVIEW.md。
