# 真实工单

用户在导航「工单」中登录后，可提交、查看、补充和关闭自己的工单。数据保存在同一 SQLite 的 `tickets` 与 `ticket_messages` 表，随一致性数据库备份迁移。页面没有预置工单、假回复或浏览器本地存储的客服记录。

创建和补充均使用幂等请求标识；不同账户读写同一工单会返回 404。用户不能通过请求参数冒充管理员。工单默认待回复，管理员实际回复后为已回复，用户补充后回到待回复，关闭后禁止新回复。每个账户每小时最多创建 5 张、同时最多 10 张未关闭工单；单条消息最多 4000 字符，每张工单最多 200 条消息。页面显示最近 100 条工单，详情会定期刷新。

当前管理员通过本机 CLI 处理，没有开放管理员公网 API、邮件/消息推送或附件上传。在 `web` 目录操作：

```powershell
npm run ticket:list
npm run ticket:show -- TK实际工单号
```

将实际回复保存为本机 UTF-8 文本文件，再执行（文件路径有空格请加引号）：

```powershell
npm run ticket:reply -- TK实际工单号 "C:\你的目录\reply.txt"
npm run ticket:close -- TK实际工单号
```

回复内容只从文件读取，保留换行和原文，避免 shell 解释特殊字符。执行一次就会写入一条真实回复；终端命令不是模拟发送，不要重复执行来检查状态。用户下次打开详情或自动刷新时可见，不会发到站外渠道。

本地默认数据库为 `data/portal.sqlite`。如果修改了开发配置的数据库路径，管理命令需显式使用同一个数据库。Docker 生产环境可使用：

```bash
docker compose exec portal node --env-file=/app/config/portal.env server/manage.mjs ticket:list
docker compose exec portal node --env-file=/app/config/portal.env server/manage.mjs ticket:show TK实际工单号
```

Docker 管理员回复文件需在容器内可读，建议将 UTF-8 文件放入受保护的 `deploy/config/` 挂载目录，再引用 `/app/config/reply.txt`。不要将客户内容、访问码、私钥或商户密钥放到网站静态目录。

测试：`npm run test:tickets` 使用隔离临时数据库验证创建、归属、幂等、状态、限额及真实 CLI 文件回复，不向现有用户发送消息。
