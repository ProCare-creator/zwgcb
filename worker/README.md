# 自我观察本 Worker

页面由 Workers Static Assets 托管，`/api/*` 由 `worker.mjs` 处理；正式域名为 `https://zwgcb.cn`。GitHub Pages 保留原有静态页面。

## 配置和部署

- `wrangler.jsonc` 只包含公开配置：节点、认证方式、模型、输出上限、Origin 和限流。
- `AI_API_KEY`、`ACCESS_TOKEN` 由使用者在 Cloudflare 控制台添加为 **Secret**。不放进 `vars` 或任何本地文件。
- 部署使用 Windows 用户环境变量中的 `CLOUDFLARE_API_TOKEN`；不要把值写进命令、脚本或仓库。
- 执行 `npx wrangler deploy --keep-vars`。构建脚本仅复制页面、Service Worker、manifest 和图标。
- `.env*`、`.dev.vars*`、`.wrangler/`、`dist/` 已忽略。

## 接口行为

| 接口 | 方法 | 行为 |
| --- | --- | --- |
| `/api/health` | GET | 验证访问口令，返回配置的模型名，不调用模型 |
| `/api/summary` | POST | 当天所选材料的总结，转发 Anthropic SSE |
| `/api/explore` | POST | 当天所选材料、可选总结及多轮对话，转发 Anthropic SSE |

全部接口验证 Bearer 访问口令。POST 必须带 `Origin: https://zwgcb.cn`；GET 若提供 Origin，也必须匹配。三者共用 Cloudflare 限流绑定：`limit: 10`、`period: 60`。该绑定是近似计数，验收按“10 秒内发起 30 次 POST，出现 429”判断。

请求体上限 64 KiB；只接受约定字段，客户端无法覆盖模型或输出上限。提示缓存标记位于系统提示、当天材料和最新一轮用户消息。缓存是否实际命中以中转站返回的 usage 为准。

默认认证为 `x-api-key`。连接超时或 5xx 可在输出开始前切换备用节点；401、429 以及已经开始的输出不自动重发。连接限时 60 秒；流式输出空闲限时 60 秒、总时长最多 180 秒。取消下游请求会取消上游。

只跟随 307/308，最多两次；目标必须为 HTTPS，且 origin 必须精确匹配配置中的主、备用节点。外部域名不会收到密钥。经口令验证的响应附带节点及跳转诊断头；URL 查询参数被省略，已知凭据被遮盖。不记录请求体、模型文本或口令，未启用 Worker 日志。

## 本地测试

`node --test worker/worker.test.mjs`

测试仅使用模拟凭据和模拟模型响应，不需要 `.dev.vars` 或真实密钥。线上验收使用虚构材料，与用户的本地记录无关。

## 当前验收边界（2026-11-12）

已实测：401/200 身份验证、403 Origin、413 大请求、30 次突发中的 429。主域名已绑定；用户确认手机不开代理能打开。

追问、备用节点成功生成和第二轮缓存命中仍待用户手机验收；已停止从本机重试线上接口。第 5 批 AI 页面正在开发，暂存于专用分支，尚未发布。
