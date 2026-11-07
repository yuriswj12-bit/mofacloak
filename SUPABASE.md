# Supabase 云端存储

2026-11-08 已将本机门户接入 Singapore 的 `mofacloak` 项目（`kggyhfwdpmnzawmdznvk`）。管理入口：https://supabase.com/dashboard/project/kggyhfwdpmnzawmdznvk 。原 `yuriswj12-bit's Project` 已按用户指定暂停，未删除；`ruibo-store` 未修改。

## 数据与权限

门户八张业务表位于 `cloak` schema：accounts、sessions、orders、payment_events、fulfillment_jobs、gifts、tickets、ticket_messages。原账户、会话散列、订单和工单已从一致性 SQLite 快照迁移；导入在单个事务中执行，逐表校验完整记录 SHA256，目标已有数据时拒绝覆盖。

服务端通过专用 `cloak_app` 角色连接，启用证书和主机名校验的 TLS。该角色只有业务表读写权限，无建表权限。八表启用 RLS，仅允许服务端角色访问，anon/authenticated 无权限。数据库密码仅在本机忽略配置中；浏览器没有数据库凭据或 service_role 密钥。Supabase 连接失败不会回退到旧 SQLite。

GM Pay 自身账本仍由本机 GM Pay 管理，门户订单及验签后的到账记录存入 Supabase。真实付款尚需用户转账验证；没有生成虚假到账。

## 登录

仍采用邀请制账户访问码，并未改用 Supabase Auth。原访问码保存在本机 `web/data/local-access.json`，属于账户凭据，不需要用户自行设置。Supabase Auth 的用户列表为空不代表业务账户丢失。访问码及其文件不得提交 Git。

## 运行与备份

本机 `web/.local-runtime.env` 使用 `DATABASE_PROVIDER=supabase`、私密 `SUPABASE_DATABASE_URL` 和 `DATABASE_CA_FILE=config/supabase-ca.crt`。公有 CA 文件可随源码分发。新检出仓库默认 SQLite 且关闭付款，不包含生产凭据。

在 `web` 目录执行：

```powershell
npm run local
npm run cloud:snapshot
npm run payment:check
npm run ticket:list
```

`cloud:snapshot` 在只读一致性事务中导出八表及校验和，保存于忽略目录 `web/data/supabase/backups`。其中含敏感业务数据，应另行安全保管。迁移前快照和逐表验证记录位于 `web/data/supabase/migrations`。云端模式禁止用 `local:snapshot` 误备份过期 SQLite。

首次空库迁移使用 `npm run cloud:migrate -- --connection-file <私密连接配置文件>`；SQL 结构位于 `supabase/migrations`。云端产生新写入后，不可直接切回旧 SQLite；必须先停止新订单、导出云端记录并核对迁移后的写入。

本地验证：77 项测试通过、生产构建通过；迁移后的实际云库备份包含 1 个账户、6 个会话、4 个历史订单、1 个工单和 3 条工单消息，到账记录为 0。
