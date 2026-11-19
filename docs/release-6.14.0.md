# v6.14.0：6b 上线准备

从 ai-chat 准备，以下命令以仓库根目录为当前目录。不部署 Worker、不合并 main 就能完成数据库准备。先用 `npx wrangler whoami` 确认 Cloudflare 账号与生产 Worker 一致。如无 Wrangler 登录，可先执行 `npx wrangler login`。

1. 在密码管理器生成并备份至少 32 字节的随机值（例如 64 个随机十六进制字符）。打开 Cloudflare → Workers & Pages → `zwgcb-journal` → Settings → Variables and Secrets；为生产环境添加类型 **Secret**、名称 **AUTH_PEPPER**，保存到当前 Worker。不要复用或删除 ACCESS_TOKEN，也不要把密钥提交、截图或发到聊天。以后轮换 pepper 需要单独的迁移计划。
2. 打开 Cloudflare → D1 SQL Database，创建名为 **zwgcb-vault** 的库；若已经创建，直接打开同一个库并确认其用途。复制详情中的 **Database ID**（UUID）。不要用 Account ID。
3. 在 Worker 的 **Bindings** 添加 D1 Database：变量名填 **VAULT**，数据库选择 **zwgcb-vault**。在仓库的 `wrangler.jsonc` 顶层也添加下面的配置，用真实 Database ID 替换占位。生产由 Workers Builds 按仓库配置部署，仅在控制台添加不足以保证下次部署仍有绑定。将配置保留在 ai-chat，暂不推 main。也可把非密钥的 Database ID 交给助手填写。

   ```json
   "d1_databases": [{
     "binding": "VAULT",
     "database_name": "zwgcb-vault",
     "database_id": "<真实 Database ID>",
     "migrations_dir": "worker/migrations"
   }],
   ```

4. 在 ai-chat 的仓库根目录先列出待执行迁移，再执行。确认 Wrangler 显示的是正确的远程数据库；不要省略 `--remote`。全新库应依次列出 `0001_accounts.sql`（账号、邀请、会话等）和 `0002_user_kdf_iter.sql`（每账号派生次数）。若数据库已有账号表而 Wrangler 又把 0001 列为待执行，先停下核对迁移历史，不要删表重来。

   ```powershell
   npx wrangler d1 migrations list VAULT --remote
   npx wrangler d1 migrations apply VAULT --remote
   npx wrangler d1 migrations list VAULT --remote
   npx wrangler d1 execute VAULT --remote --command "PRAGMA table_info(users)"
   ```

   成功标志：没有待执行迁移，且 users 表包含 `kdf_iter`（INTEGER、NOT NULL、默认 600000）。

5. 准备完再明确通知合并 main。生产构建并验证成功后，按发布约定打带说明的 v6.14.0 标签。上线后由所有者先用 ACCESS_TOKEN 注册管理员并抄下恢复码；如果曾分享该口令，建议先换成仅自己知道的新值。管理员注册后，同一个口令不能再创建管理员。旧口令的 AI 认证路径继续保留，只有收到“停用旧口令”指令后才移除。6b 不上传记录，不包含 6c 云端同步。

官方说明：[Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[D1 配置](https://developers.cloudflare.com/d1/get-started/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)。
