# 魔法披风

邀请制海外环境服务用户中心，前端 React / Vite，支付后端 Node.js 24 / SQLite，真实收款协议 GM Pay v2（USDT / BSC）。

目前已实现商户签名、账户隔离、服务端计价、持久化订单、幂等通知、礼品卡与交付队列；本机USDT-BSC网关、钱包、节点与签名通知已配置，已验证真实待付款收银台；实付待本人验收，支付宝/微信未开通。

- [真实支付配置与部署](web/PAYMENTS.md)
- [项目运行说明](web/README.md)
- [支付验证记录](web/payments-qa.md)
- [服务器购买与 GM Pay 上线手册](deploy/README.md)
- [Windows 本地运行、真实网关与 VPS 数据迁移](LOCAL.md)
- [需要本人完成的 GM Pay 配置](GM-PAY-SETUP.md)
- [真实工单与管理员回复](web/TICKETS.md)

部署材料包含只读配置检查、门户健康接口、关闭收款的安装阶段、持久化数据库备份及带 SHA256 清单的安装包。网站和后台仍在本机；用户仅授权临时公开签名到账通知，未部署公网网站。

域名复用现有 `narraops.xyz`：网站 `cloak.narraops.xyz`，支付 `cloak-pay.narraops.xyz`。当前仅更新本地部署模板，尚未添加 DNS 记录。

新前端已移除模拟支付与虚拟财务数据。节点开通、订阅签发及实际服务交付仍需配置资源或接入节点面板。

- [套餐、年付与权益审阅稿](PLAN-REVIEW.md)

## 开发与验证

需要 Node.js 24+。首次检出后：

```powershell
cd web
npm ci
npm run local
```

浏览器打开 http://127.0.0.1:4173/ 。首次运行创建本地账户，访问码仅在忽略的 `web/data/local-access.json`。默认收款关闭，仓库不含已配置的商户、RPC、钱包监听或临时公网入口；需按部署文档自行配置。正式价格和300/600/1000GB配额来自confirmed catalog。本机5美元测试覆盖不进入仓库。

```powershell
npm run build
npm test
npm audit --audit-level=high
```

GitHub Actions在Windows与Linux分别执行构建、隔离测试及依赖审计，不连接真实商户或链上钱包。

## 当前交付范围

| 功能 | 当前状态 |
| --- | --- |
| 邀请制访问码登录、账户隔离、订单记录 | 已实现 |
| GM Pay v2 / BSC-USDT | 真实接入；主网到账仍待本人转账验收 |
| 礼品卡购买、签发、兑换 | 服务端已实现；真实签发与兑付依赖实际付款及套餐交付 |
| 工单提交、补充、管理员回复、关闭 | 已实际逐步验收；管理员通过本机CLI回复 |
| 知识库、搜索、客户端教程 | 已实现 |
| 节点资源、有效订阅、实际用量 | 尚未接入，付款后待开通 |
| 积分签到、积分抵扣、自助邀请与奖励 | 未开放 |
| 支付宝、微信支付、自动退款 | 未接入 |

详细客户视角检查见 [客户流程审查](CUSTOMER-AUDIT.md)。目前是可运行的真实收款开发项目，尚不是能自动交付节点的完整运营系统。


云端存储现已接入 Supabase，配置、权限、备份及回滚说明见 [SUPABASE.md](SUPABASE.md)。
