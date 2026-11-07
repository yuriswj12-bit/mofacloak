# 魔法披风：真实 GM Pay / BSC 上线手册

准备日期：2026-11-07。网站与官方 GM Pay 已在本机运行，尚未购买、连接或部署公网服务器，没有发生真实付款。默认关闭收款，没有模拟订单或模拟地址。

域名方案已按用户决定调整：复用现有 `narraops.xyz`，魔法披风使用 `cloak.narraops.xyz`，支付使用 `cloak-pay.narraops.xyz`。已从 NarraOps 项目部署记录确认主域名，并实时检查 DNS；本次没有解析到这两个子域名的 A 记录，也没有写入任何 DNS。NarraOps 根域名与 www 的现有用途保持不变。模板仍需填写真实证书联系邮箱与服务器信息，收款保持关闭。

当前优先本地开发，Windows 直接运行方式及真实数据迁移见 [本地手册](../LOCAL.md)。如需保留本地账户和订单，先导出一致性快照，VPS 执行 prepare.sh 后、第一次启动 portal 前运行 `bash import-portal.sh /root/快照目录`。导入器验证哈希并拒绝覆盖已有数据库。

## 1. 购买清单

| 项目 | 选择 | 预算及说明 |
| --- | --- | --- |
| 网站 + 支付服务器 | Vultr → Cloud Compute → Regular Performance → Singapore → Ubuntu 24.04 LTS x64 → 1 vCPU / 2GB / 55GB SSD，带公网 IPv4 | 官方公开 API 核实 `vc2-1c-2gb` 月价 $10，包含 sgp 地区。结算税费、附加服务另计；按月起步 |
| 域名 | 复用 `narraops.xyz` 下两个独立子域名 | 不再购买新域名；原主域名照常续费 |
| BSC 节点服务 | Alchemy 创建 BNB Smart Chain Mainnet 应用，取得 WSS endpoint | 先检查账户是否提供该链 WebSocket/订阅权限和足够额度。未实测前不承诺免费额度够用；暂不购买付费 RPC 套餐 |
| 收款钱包 | 自己控制的 BSC 主网钱包公开地址 | 自己离线保存助记词。服务器仅登记收款公钥地址；首次收付款验收需少量 USDT，转出/退款需 BNB 支付 gas |

网站与支付预计约 ¥80–100/月起（预算估算，非实时报价），不含 RPC 超额费、备份付费服务、代理入口及住宅出口费用。2GB 适合当前低访问量起步，后续按内存和访问量升级；不承诺抗高并发攻击。网站支付机不承载用户代理流量。

购买步骤：

1. Vultr 使用自己的邮箱注册，开启二步验证；Billing → Make a Payment → Alipay。先小额充值，按控制台实际最低金额支付。部署上述套餐，核对月总价及 IPv4；不选 IPv6-only。优先添加本机 SSH 公钥；仅上传 `.pub`，私钥留在本机。
2. 进入 `narraops.xyz` 当前使用的 DNS 管理面板，无需再注册域名。不需要额外购买 SSL、邮箱、建站套餐。
3. 在 `narraops.xyz` 下新增两个 A 记录：主机 `cloak` → 支付网站服务器 IPv4；主机 `cloak-pay` → 同一个 IPv4。保留根域名 `@`、`www`、其他 NarraOps 子域名和 NS 记录。没有配置 IPv6 时不要添加 AAAA。初次直接使用 DNS 解析，不添加 CDN，避免误改来源地址信任边界。原有域名或 Vercel 托管不等于已有可运行 GM Pay 常驻进程的服务器，服务器仍需单独准备。
4. Vultr 防火墙开放 TCP 80/443；TCP 22 仅允许自己的公网 IP。不要开放 8000/8788。若自己 IP 变化，通过控制台更新 SSH 规则。

只需要提供：服务器公网 IP、实际购买域名、BSC 公开收款地址。不要在聊天中发送服务器密码、SSH 私钥、助记词、商户密钥或带密钥的 WSS URL。服务器连接使用本机 SSH；其余密钥直接填写服务器保护配置。

## 2. 文件布局与本机上传

部署采用 Linux Docker Compose：门户运行 Node 24 + SQLite，GM Pay 使用官方镜像，Caddy 自动申请和续期 HTTPS。镜像固定为本次核实的 digest，后续升级先备份、核对新版并重新固定，不自动追踪 latest。

- `web/Dockerfile`：构建当前真实门户，不包含本地数据库和密钥。
- `deploy/compose.yaml`：网站与 Caddy 使用 Linux host 网络；网站仅监听本机 8788，GM Pay 仅发布本机 8000。
- `deploy/config/portal.env`：网站生产环境与商户凭据（初始化时生成，不入 Git）。
- `deploy/data/gmpay`：GM Pay 配置、数据库和运行数据（不入 Git）。
- `web/data`：网站账户、会话、订单、礼品卡与待开通任务（不入 Git）。

本目录随附 `mofacloak-deploy.tar.gz`，仅包含源代码和模板，不包含 node_modules、数据库、`.env` 或任何密钥。它是上传用安装材料，不是在线服务。

后续代码更新后，在本机 `web` 目录运行 `npm run deploy:package` 重新生成包。工具按白名单收集文件，拒绝符号链接及数据库/私钥文件；包内包含逐文件 SHA256 清单 `deploy/bundle-manifest.json`，包外生成 `.sha256` 文件校验传输完整性。清单不替代对安装包来源的信任。

取得 IP 后，在 Windows PowerShell 中执行（将 `SERVER_IP` 换成实际 IP；SSH 若要求密码，只在本机终端输入）：

```powershell
scp .\deploy\mofacloak-deploy.tar.gz .\deploy\mofacloak-deploy.tar.gz.sha256 root@SERVER_IP:/root/
ssh root@SERVER_IP
```

以下命令均在新 Ubuntu 服务器执行。目标目录必须是新建空目录；已有同名目录时先检查，不覆盖原站点。

```bash
cd /root
sha256sum -c mofacloak-deploy.tar.gz.sha256
mkdir -m 700 /srv/mofacloak
tar -xzf /root/mofacloak-deploy.tar.gz -C /srv/mofacloak
cd /srv/mofacloak/deploy
bash install-docker.sh
bash prepare.sh
nano .env
nano config/portal.env
```

`.env` 已预填两个 NarraOps 子域名，补充真实 ACME 联系邮箱；如实际改用其他子域名，需要同步 `config/portal.env`，保持 `PAYMENTS_ENABLED=false`。DNS 尚未指向服务器前不能视为已上线。价格模板也不代表正式售价。

```bash
docker compose config --quiet
docker compose build portal
docker compose run --rm --no-deps -v "$PWD:/deployment:ro" portal node scripts/deployment-check.mjs --dir /deployment
docker compose up -d
docker compose ps
docker compose logs --tail=60 portal caddy epusdt
```

此时根域名应能访问网站，收款域名返回 503；这是安装阶段的预期行为。Caddy 自动申请证书，DNS 和 TCP 80/443 必须已正确配置。

网站健康端点为 `/api/v1/health`，只检查进程与数据库可读性，不返回账户、密钥或订单。Compose 会定期检查门户健康状态；`unhealthy` 仅是状态标记，不会自动重启仍在运行的进程，需查看日志排查。支付关闭时网站仍应健康。

## 3. 私下初始化真实 GM Pay

在 Windows 另开一个 PowerShell 窗口，建立 SSH 隧道并保持窗口开启：

```powershell
ssh -N -L 18000:127.0.0.1:8000 root@SERVER_IP
```

本机浏览器打开 `http://127.0.0.1:18000` 完成官方安装向导：

- 名称：魔法披风支付。
- `app_uri`：`https://cloak-pay.narraops.xyz`。
- 容器内绑定地址：**0.0.0.0**；端口 **8000**。不要填 127.0.0.1，容器端口映射会失效。
- 数据库和 runtime 使用 `/data` 下默认位置，避免配置到容器临时目录。
- 创建独立强管理员密码，妥善保管。不要将安装向导先暴露到公网。

安装完成并自动重启后，登录管理后台：

1. 开启 BSC / Binance 主网，chain ID 56；关闭不用的链。
2. 配置能实际连接的 **wss://** RPC 地址，支持链上事件订阅；检查日志持续同步区块，不能只以“保存成功”判断可用。
3. 开启该链正确的 USDT 资产，核对主网代币合约与后台默认资产一致；不要只凭同名代币添加资产。
4. 添加自己控制的 BSC 公开收款地址，启用。网关不需要这个钱包的私钥。
5. 创建商户 API 记录，取得配对的 `pid` 与 `secret_key`。仅填入服务器的 `config/portal.env`，不要提交 Git。
6. 汇率使用网关真实报价配置；不要人为写固定 CNY/USDT 汇率。

初始化与管理员登录均验证正常后，在服务器切换公网网关：

```bash
cd /srv/mofacloak/deploy
cp -p config/Caddyfile config/Caddyfile.before-live
cp Caddyfile.live config/Caddyfile
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

HTTPS 验收并检查 `https://cloak-pay.narraops.xyz/payments/gmpay/v1/config` 中有可用 USDT / binance（或 bsc）组合。管理后台是敏感入口，请使用上述独立密码；本模板未额外实现管理员 IP 白名单。

在服务器执行只读公网检查（将 `SERVER_IP` 换成真实 IPv4）：

```bash
docker compose run --rm --no-deps -v "$PWD:/deployment:ro" portal node scripts/deployment-check.mjs --dir /deployment --online --expected-ip SERVER_IP
```

它核对 DNS、HTTPS、网站健康、开关、已开启收款时的公开套餐价格及网关资产，不发送商户密钥、不创建订单、不发起转账。FAIL 会返回非零退出码；WARN 提示尚待完成的项目。检查通过只说明配置和只读接口符合要求，不能代替 WSS 监听与主网付款验收。本机也可从 `web` 目录运行 `npm run deploy:check -- --dir ../deploy`；未购买资源、未初始化配置时应明确失败，不会偷偷套用模板冒充可用。

## 4. 网站接通与主网验收

网站回调地址为 `https://cloak.narraops.xyz/api/v1/payments/gmpay/notify`，由后端根据 PUBLIC_ORIGIN 自动传给 GM Pay，不要填写浏览器回跳作为到账依据。

先确认 `config/payment-catalog.json` 中真实售价和权益。目前节点面板、订阅自动签发与用量系统尚未接入，付款后只生成待开通任务；必须有真实可交付资源和人工开通流程，才能向客户开放购买。

准备自己进行真实小额验收时，再编辑 `config/portal.env`，填写 PID、密钥，并设置 `PAYMENTS_ENABLED=true`：

```bash
docker compose up -d --force-recreate portal
docker compose exec portal node --env-file=/app/config/portal.env server/manage.mjs user:create 管理员验收
```

命令只显示一次该账户访问码，自己保存并登录网站。验收付款使用真实主网资金，不生成假付款记录；首次验收前核实实际订单金额符合 GM Pay 最低金额及精度要求。当前没有面向客户的独立测试套餐，不应偷偷修改正式套餐售价让客户下单；在仅自己持有访问码的阶段确认并配置验收价，验收后恢复确认售价。

验收必须走全链路：创建真实订单 → 网关真实报价 → 客户端从另一钱包支付准确的 BSC-USDT 数量 → 链上达到网关确认条件 → 验签回调 → 网站显示已付款 → 生成待开通任务。再检查重复回调不会重复发放。付款操作和金额由你在钱包确认；部署脚本不会转账。

```bash
docker compose exec portal node --env-file=/app/config/portal.env server/manage.mjs fulfillment:list
```

未完成主网验收、监听稳定性和人工交付验证前不发客户访问码。如果暂时停止新收款，将开关改回 false 并重新创建 portal，保留原 PID/密钥处理在途回调；不要通过删数据库重置订单。

## 5. 备份、回退和当前验证范围

在维护窗口运行 `bash backup.sh`：短暂停止门户及 GM Pay，打包两套 SQLite、配置与部署清单，然后恢复之前运行的服务。备份位于 `/var/backups/mofacloak`，包含密钥，权限为 600；复制到受保护的离线存储，不能放网站静态目录。不自动删除旧备份。Caddy 证书存于 Docker 卷，未包含于该业务备份，丢失后需要重新签发。

失败的打包保留为 `.partial`，校验成功才生成正式 `.tar.gz` 和 `.sha256`。读取运行服务清单失败会立即退出，不继续停服务。备份完整性检查可运行 `sha256sum -c 完整备份路径.sha256`。

Caddy 切换失败可将 `config/Caddyfile.before-live` 恢复为 `config/Caddyfile`，先 validate 再 reload。镜像升级保留旧 digest；数据库迁移后不能只退镜像，必须在维护窗口恢复与该版本匹配的完整备份。恢复前先解压到全新目录检查，保留现有目录，不覆盖唯一数据副本。不要执行 `docker compose down -v`。

本地已做 Bash 语法、Compose YAML 结构和门户既有自动检查。本机没有 Docker，尚未完成容器构建、Linux 网络、HTTPS 证书、实际 WSS 订阅和主网到账验证。这些将在购买服务器后逐项执行，不能据此宣称已上线。

## 官方依据

- [Vultr 付款方式](https://docs.vultr.com/support/platform/billing/what-payment-methods-do-you-accept)，[官方套餐 API](https://api.vultr.com/v2/plans?type=vc2&per_page=500)
- [Dynadot 人民币与支付宝](https://www.dynadot.com/zh/help/question/pay-in-chinese-rmb)
- [GM Pay 官方 Docker 部署](https://www.epusdt.com/guide/installation/docker)，[FAQ / WSS 监听要求](https://www.epusdt.com/guide/faq)
- [Alchemy BSC eth_subscribe](https://www.alchemy.com/docs/chains/bnb-smart-chain/bnb-smart-chain-api-endpoints/eth-subscribe)
- [Docker Ubuntu 官方安装](https://docs.docker.com/engine/install/ubuntu/)
