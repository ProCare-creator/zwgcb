# 自我观察本 Worker

页面由 Workers Static Assets 托管，`/api/*` 由 `worker.mjs` 处理；正式域名为 `https://zwgcb.cn`。GitHub Pages 保留原有静态页面。

## 配置和部署

- `wrangler.jsonc` 只包含公开配置：节点、认证方式、模型、输出上限、Origin 和限流。
- `AI_API_KEY`、`ACCESS_TOKEN` 由使用者在 Cloudflare 控制台添加为 **Secret**。不放进 `vars` 或会提交的文件。本机真实测试仅允许使用仓库根目录的 `.dev.vars`（已忽略），不输出密钥。
- **正式发布 = 推送到 `main`**。Worker 已连接 Cloudflare Workers Builds（仓库 `ProCare-creator/zwgcb`，生产分支 `main`，Build command 留空，Deploy command `npx wrangler deploy --keep-vars`，Preview builds 关闭）。推送到 `main` 后 Cloudflare 自动构建并部署到 zwgcb.cn；其他分支不会部署。没验收的改动不要合并到 `main`。
- 需要手动部署时（例如 Workers Builds 出问题），在本机用 Windows 用户环境变量中的 `CLOUDFLARE_API_TOKEN` 执行 `npx wrangler deploy --keep-vars`；不要把 Token 的值写进命令、脚本或仓库。
- 构建脚本 `build.mjs` 由 wrangler 在部署时运行，仅复制页面、Service Worker、manifest 和图标到 `dist/`。
- `.env*`、`.dev.vars*`、`.wrangler/`、`dist/` 已忽略。

## 接口行为

| 接口 | 方法 | 行为 |
| --- | --- | --- |
| `/api/health` | GET | 验证访问口令，返回配置的模型名，不调用模型 |
| `/api/summary` | POST | 当天所选材料的总结，转发 Anthropic SSE |
| `/api/explore` | POST | 当天所选材料、可选总结及多轮对话，转发 Anthropic SSE |

全部接口验证 Bearer 访问口令。POST 必须带 `Origin: https://zwgcb.cn`；GET 若提供 Origin，也必须匹配。三者共用 Cloudflare 限流绑定：`limit: 10`、`period: 60`。该绑定是近似计数，验收按“10 秒内发起 30 次 POST，出现 429”判断。

请求体上限 64 KiB；只接受约定字段，客户端无法覆盖模型或输出上限。提示缓存标记位于系统提示、当天材料和最新一轮用户消息。缓存是否实际命中以中转站返回的 usage 为准。

默认认证为 `x-api-key`。连接超时或 5xx 可在输出开始前切换备用节点；401、429 以及已经开始的输出不自动重发。连接限时 60 秒；流式输出空闲限时 120 秒。总结总时长 300 秒，探索 600 秒（连接、重试和输出共用同一总预算）。取消下游请求会取消上游。

只跟随 307/308，最多两次；目标必须为 HTTPS，且 origin 必须精确匹配配置中的主、备用节点。外部域名不会收到密钥。经口令验证的响应头提供 `x-ai-node`、`x-ai-redirected`、`x-ai-redirect-domain`；只含主/备标记、是否跟随跳转及最后一个跳转域名，不返回路径、查询参数、密钥或请求内容。不记录请求体、模型文本或口令，未启用 Worker 日志。

## 第 A 批：思考与截断

- 总结：`EFFORT_SUMMARY=high`、`MAX_TOKENS_SUMMARY=8000`；探索：`EFFORT_EXPLORE=xhigh`、`MAX_TOKENS_EXPLORE=32000`。输出上限允许 1–64000。
- 力度仅接受 `low / medium / high / xhigh / max`，未设置或无效时不发送 `output_config`；发送 `thinking: {type: 'adaptive', display: 'summarized'}`。
- 输出开始前的 HTTP 400 仅降级重试一次：移除 `thinking` 与 `output_config`，其余请求不变。正常响应头 `x-ai-effort: applied`；降级为 `dropped`，另附 `x-ai-effort-fallback-status: 400`。未配置有效力度时为 `not_requested`。这些标记表示参数是否发送并获接受，不代表能验证中转站内部的实际执行。
- 401、429 不重试；开始流式输出后也不重试。错误正文不会透传或记录。
- 前端总结 / 探索分别限时 330 / 660 秒。思考摘要仅在会话内存中，与正文分开，不入草稿、导出或后续模型请求。
- `max_tokens` 有正文时保存并提示截断；没有正文时提示重试，保留旧总结。保存的正文允许可选 `stopReason`，不改变存储键名或 `COLS`。
- 生成期间尽力申请屏幕 Wake Lock，回到前台时重申请；完成、失败、取消时释放。浏览器拒绝或不支持时不影响请求。

## 本地测试

`node --test worker/worker.test.mjs`

单元测试仅使用模拟凭据和模拟模型响应，不需要 `.dev.vars` 或真实密钥。第 A 批本机真实测试使用 `wrangler dev --local` 和虚构材料，各一次总结与探索；测试前告知请求次数。只报告状态、token 数、是否收到思考、耗时和安全响应头，不记录请求内容或模型输出。

## 当前验收边界（2026-11-12）

已实测：401/200 身份验证、403 Origin、413 大请求、30 次突发中的 429。主域名已绑定；用户确认手机不开代理能打开。

追问、备用节点成功生成和第二轮缓存命中仍待用户手机验收；已停止从本机重试线上接口。第 5 批 AI 页面已通过本机模拟流程，保存在专用分支，等待截图验收，尚未发布。
