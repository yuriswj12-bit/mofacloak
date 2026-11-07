# Prototype Instructions

## Product contract

- 名称「魔法披风」，邀请制海外业务用户中心，深色与紫色强调，按用户提供截图延续设计。
- 导航固定：仪表盘、套餐选购、我的套餐；财务：我的订单、积分中心、礼品卡；帮助与邀请：我的邀请、工单、知识库；用户设置。
- 顶部仅 Logo 和品牌名；侧栏底部无宣传。无钱包、自研客户端或独立账单页。
- 使用订阅链接、二维码与第三方客户端教程。价格、积分规则和其他未确认权益为演示占位值，需明确标注。
- 当前支付采用真实 GM Pay / USDT-BSC 接入；不得再添加模拟支付、虚拟账单、假收款地址或固定 USDT 汇率。生产收款需实际网关、PID、secret_key、公开收款地址及服务器配置；未配置时必须关闭。
- 各导航页需要完整的独立布局和主操作，不能只在首页放入口。保留同一侧栏与页面视觉体系。
- 套餐选购保留 Basic / Standard / Premium、月付/年付和币种切换布局。真实报价必须来自服务端 catalog；没有配置时显示待报价，USDT 数量由 GM Pay 决定，不得沿用旧参考图的固定报价。
- 文案不得承诺所有检测工具满分、永久零风险。后续后端以 BACKEND-HANDOFF.md 为接入参考。
- 支付以 PAYMENTS.md、server/ 和 payments-qa.md 为当前依据；旧导航原型文档和 QA 仅作历史资料。服务端持久化且校验账户归属、幂等、签名与金额；客户端或回跳不能确认付款。
- 收款确认后只生成真实待开通任务。节点面板、订阅签发、用量尚未接入，必须展示未开通状态，不能冒充已交付。
- 当前先在 Windows 本地开发与邀请测试，正式上线再迁移 VPS。`npm run local` 使用独立 `.local-runtime.env`（不得使用会影响 Vite 构建的 `.env.local`）、默认仅绑定回环地址、关闭收款；不得自动开放公网、修改 DNS 或添加模拟交易。现有 `data/portal.sqlite` 持续保留；迁移使用 SQLite 一致性备份，不能只复制运行中的主文件。
- 在线工单已接入 `tickets` / `ticket_messages`、账户归属校验和幂等 API。不得恢复为演示客服记录。管理员通过本机 CLI 从文件实际回复；未实现站外通知或公开管理员 API。
- 用户已确认月价基础版 79.90、标准版 169、尊享版 219 元；年付为月价×12×80%，分别 767.04、1622.40、2102.40 元。用户已确认每月流量：基础300GB、标准600GB、尊享1000GB。设备数暂拟3/5/8台，供最终审阅。年付流量仍按月分配。共享人数、独享与带宽未承诺。正式价格源为 `config/payment-catalog.confirmed.json`，实际计量尚未接入。
- 用户要求 USDT、支付宝、微信三种实际收款。当前只有个人支付宝/微信，不具备可自动核验的商户接口，人民币渠道必须明确未开通。USDT 参考价从动态汇率取得，实付以真实网关为准。开发可显式启用同机 127.0.0.1 的 GM Pay HTTP 连接；生产和局域网模式仍不得放宽 HTTPS 与来源约束。WSS URL 中的密钥与商户密钥不可写入仓库或回显。
- 用户已明确授权临时 Cloudflare HTTPS，仅开放通过验签的到账通知 POST；不得借此开放网站、GM Pay 后台或其他本机服务。入口失联/心跳过期必须阻止创建新付款。官方网关拒绝私网 notify_url（10041），不得绕过该校验，也不能用虚拟成功替代真实回调。

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

- 真实资金测试前检查使用 `npm run payment:check`（只读）。临时通知入口须同时具备新鲜公网验签拒绝探测与进程心跳；不得仅凭进程存活标为可收款。本机配置通过 `GMPAY_RECEIVE_ADDRESS` 绑定用户指定BSC钱包；回调与收银台都需匹配。

- 用户要求真实资金测试使用5美元：仅本机运行catalog给基础版月付增加 `monthlyUsd: "5.00"` 临时覆盖；原人民币月价及年付保留，正式confirmed catalog不改。订单必须持久化实际币种，旧人民币订单不能重标为美元。恢复原价删除本机该覆盖字段后重启网站。

- 客户体验审查要求：访客首页提供登录；跨标签页登出立即清除订单/礼品卡；账户切换关闭旧付款详情；账户刷新失败必须提示。混合美元临时价使用“标价”切换标签，手机周期按钮不得滚动或裁切。审查保留真实未开放状态，不伪造积分、邀请、订阅。

- 用户已授权使用 Supabase 云端存储，并指定暂停原新加坡 yuriswj12-bit's Project，保留数据。当前专用 mofacloak 项目使用 cloak schema、最小权限服务端角色、RLS 和证书验证 TLS；不得向浏览器暴露数据库凭据。原访问码与会话保持兼容。云库故障不得回退 SQLite；云端备份使用 cloud:snapshot，详见根目录 SUPABASE.md。
