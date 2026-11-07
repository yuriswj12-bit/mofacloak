# 本地开发、真实 GM Pay 与 VPS 迁移

当前选择：先在 Windows 电脑直接运行 Node 24 网站及官方 Windows 版 GM Pay，正式上线再使用 Linux VPS 的 Docker 部署。不修改 DNS，网站和后台不开放公网，不创建模拟付款。用户已明确授权仅开放验签到账通知的临时 HTTPS 入口。

## 当前运行地址

| 服务 | 地址 | 状态 |
| --- | --- | --- |
| 魔法披风开发网站 | http://127.0.0.1:4173 | 前端与同源 API 代理，热更新 |
| 网站 API 健康检查 | http://127.0.0.1:8788/api/v1/health | 本机 API + SQLite |
| 真实 GM Pay | http://127.0.0.1:8000 | 官方 v2.0.0 Windows x64，已校验官方 SHA256 |

网站、API、GM Pay 和通知转发器仅监听回环地址；外部只能经用户已授权的 Cloudflare 临时入口提交签名到账通知，不能访问网站、后台或账户 API。没有改变 NarraOps DNS。

## 日常启动与停止

电脑重启后依次运行 `start-gmpay.cmd`、`start-callback.cmd`，等通知入口输出 Callback ready，再运行 `start-local.cmd`。临时地址会改变，网站必须重新加载地址。存在未结付款时不要关闭入口，先关闭新下单并核对在途付款。各窗口 Ctrl+C 只停止自己管理的进程。

也可以在 `web` 目录使用终端：

```powershell
npm run local
```

另一个终端启动已经安装的本地网关：

```powershell
npm run local:gmpay
```

`npm run local` 会生成并读取 `.local-runtime.env`，不读取或覆盖用于其他用途的 `.env`。该文件不会被 Vite 自动加载，避免开发环境设置影响生产构建。新项目默认 `PAYMENTS_ENABLED=false`；当前配置真实同机网关和公开签名通知后可开启，心跳失效则拒绝新下单。它使用持久化的 `web/data/portal.sqlite`，重启不会清空账户和订单。初次会创建一个真实的「本地开发账户」，重启会复用，不写假账单或假套餐。前端开发服务器禁止浏览器读取 `data/`、环境变量文件与正式套餐目录，并忽略数据目录的文件监视，避免 Windows 正在运行的网关程序触发监视错误。

## 登录信息

- 网站真实访问码：`web/data/local-access.json`。当前浏览器已验证登录。以后可在用户设置或首页登录区域填写其中的 `accessCode`。
- GM Pay 首次管理员凭据：`web/data/gmpay-local/admin-access.json`；原始首次启动记录在同目录 `startup.log`。这些都是本机敏感文件，不要发送到聊天或提交 Git。本次已限制当前 Windows 账户访问。
- GM Pay 登录校验已成功返回欢迎提示，但后台要求先修改初始密码。**需要你亲自在本地页面完成修改密码**；没有替你更改密码或跳过这一要求。改完后本地初始凭据文件不会自动更新。
- 网页不提供管理员接口；网站账户访问码用于普通用户中心登录。

需要在自己的终端显示网站访问码时运行：

```powershell
npm run local:account -- --show
```

新增另一个真实邀请测试账户可用 `npm run user:create -- 测试者名称`，该命令默认使用同一个 `data/portal.sqlite`（不要同时使用改变数据库路径的 `.env`）；访问码只输出一次，应私下交给该用户。不会自动给他创建已付款订单、积分或订阅。

## 邀请同一局域网的测试人员

先停止原来的网站启动器，确认本机真实局域网 IPv4，例如 Windows 设置中的网络属性。再在 `web` 目录执行：

```powershell
npm run local -- --lan 你的局域网IPv4
```

启动器会核验该 IP 确实属于本机，然后仅在该 IP 的 4173 端口提供网站；所有人，包括本机，都使用输出的同一个 IP 地址访问。API 仍在 127.0.0.1:8788，由网站代理，Origin 检查保持启用。不会自动修改 Windows 防火墙。如果需要允许访问，应仅为可信的专用网络和指定测试设备开放 4173，不开放 API、8000 或 GM Pay 后台。测试人员的访问码独立发放，不共用本地账户。

不同网络测试人员仍不能通过通知入口访问网站。现有临时入口只收验签通知，不提供网页；未修改路由器端口映射或DNS。真实收款配置禁止 --lan 模式，需关闭收款后再做纯界面局域网测试，不把Vite作为公网正式服务。

## 本地真实支付的实际边界

GM Pay 已配置真实BSC地址、NodeReal WSS、商户记录和自动汇率。已验证创建¥79.90/12 USDT真实待支付收银台，没有代替用户实付。支付宝/微信缺少商户接口，明确未开通。方案见 [PLAN-REVIEW.md](PLAN-REVIEW.md)。

官方拒绝私网notify_url，已按用户许可启用Cloudflare临时HTTPS入口。独立转发器绑定127.0.0.1:8790，只处理指定到账通知JSON POST，转发前验证PID和HMAC；其他路径404，错误签名401，不提供网站/后台/通用代理。

同机开发仅在明确启用ALLOW_LOOPBACK_GMPAY=true、网站固定127.0.0.1:4173、网关固定127.0.0.1:8000且有公开HTTPS通知源时允许网关HTTP。生产仍强制HTTPS，没有绕过官方私网通知保护。临时入口有匹配且新鲜心跳才允许新付款，本人实付验收仍待完成。

订阅签发、节点用量和积分尚未接入真实服务；当前页面如实显示未开通。工单已经接入真实 SQLite，可提交、查看、补充、关闭，管理员通过本机 CLI 回复，见 [工单说明](web/TICKETS.md)。支付成功也只会进入待开通任务，不能冒充节点已交付。

## 网关重新安装与停止

本机已安装无需重复下载。其他 Windows x64 电脑可在项目根目录执行：

```powershell
powershell -File .\deploy\setup-gmpay-local.ps1
```

脚本固定 v2.0.0，下载官方 release 与 SHA256SUMS，校验后才解压，配置绑定 127.0.0.1:8000。没有采用默认首次安装监听器：该版本源码的初次安装监听器绑定 `:8000`，所以这里直接使用最小 SQLite 配置，由官方 bootstrap 创建真实管理员与默认 API 记录，避免安装阶段监听所有网卡。没有配置钱包、发起链上转账或创建业务订单。脚本保留已有配置，不自动覆盖安装目录。

来源：[GM Pay 官方 v2.0.0 发布](https://github.com/GMWalletApp/epusdt/releases/tag/v2.0.0)。

## 迁移到 VPS：先生成一致性快照

在 `web` 目录运行：

```powershell
npm run local:snapshot
npm run deploy:package
```

第一条在 `web/data/migrations/时间戳/` 生成 `portal.sqlite`、`portal.sqlite.sha256` 和 `snapshot.json`。使用 SQLite 在线备份 API，包含已提交 WAL 数据；校验完整性，不停止服务、不移动原数据，也不包含明文访问码文件、环境变量或 GM Pay 数据。第二条生成不含业务数据或密钥的代码安装包。

快照含真实账户、订单、礼品卡等敏感数据，应单独通过 SSH 传输到 VPS 私有目录。正式切换时应暂停本地新下单和业务写入、处理在途付款，再生成最终快照，防止快照之后的新记录遗漏。当前可能有真实待支付订单，迁移前以实际状态为准。

VPS 上按 [部署手册](deploy/README.md) 解压代码并运行 `prepare.sh`，在**第一次启动 portal 之前**上传上述快照目录，然后执行：

```bash
cd /srv/mofacloak/deploy
bash import-portal.sh /root/实际上传的快照目录
```

导入工具验证 SHA256，仅允许目标数据库和 WAL/SHM 全部不存在的新数据目录，设置 Node 容器需要的 uid 1000 与 600 权限；不会覆盖已有站点数据或移动源快照。已有数据时使用新的部署目录，不删除原数据库重试。

之后配置生产 HTTPS 域名 `cloak.narraops.xyz` 与 `cloak-pay.narraops.xyz`、正式套餐、真实商户信息，按部署手册构建和启动。网站账户及其访问码哈希随数据库保留，生产 cookie 与本地不同，需要重新登录。

**GM Pay 数据单独处理。**当前已经登记钱包并创建真实交易，VPS不能直接新建网关后丢弃原记录：需要停新下单、核对在途交易，停网关后备份完整配置、主库及 WAL/SHM、runtime 数据，保留原 PID/密钥；在对应版本 Docker 中恢复，并将 `app_uri` 改为公网 HTTPS、容器内监听改为 `0.0.0.0:8000`。本轮没有把正在运行的网关数据库冒充已验证的 Linux 恢复包。

切换完成后再添加两个 DNS 记录，逐项验证健康接口、登录、账户隔离、网关资产、真实小额付款通知和交付流程。保留本机数据作为回退副本；迁移不等于同步写入，切换后不要让两端继续各自接单。
