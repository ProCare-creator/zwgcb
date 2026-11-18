# 自我观察本 Worker

页面由 Workers Static Assets 托管，`/api/*` 由 `worker.mjs` 处理；正式域名为 `https://zwgcb.cn`。GitHub Pages 保留原有静态页面。

## 配置和部署

- `wrangler.jsonc` 只包含公开配置：节点、认证方式、模型、输出上限、Origin 和限流。
- `AI_API_KEY`、`ACCESS_TOKEN` 由使用者在 Cloudflare 控制台添加为 **Secret**。不放进 `vars` 或会提交的文件。本机真实测试仅允许使用仓库根目录的 `.dev.vars`（已忽略），不输出密钥。
- **正式发布 = 推送到 `main`**。Worker 已连接 Cloudflare Workers Builds（仓库 `ProCare-creator/zwgcb`，生产分支 `main`，Build command 留空，Deploy command `npx wrangler deploy --keep-vars`，Preview builds 关闭）。推送到 `main` 后 Cloudflare 自动构建并部署到 zwgcb.cn；其他分支不会部署。没验收的改动不要合并到 `main`。
- **生产版本标签**：每次合并到 `main` 上线，先核对 Cloudflare 生产构建成功且构建记录中的提交就是本次发布的提交，再以该提交的 `APP_VERSION` 创建带说明的 Git 标签。推送标签后，核对远端标签指向同一提交。构建未成功不打标签；同名标签若已指向其他提交，不移动或覆盖。
- 需要手动部署时（例如 Workers Builds 出问题），在本机用 Windows 用户环境变量中的 `CLOUDFLARE_API_TOKEN` 执行 `npx wrangler deploy --keep-vars`；不要把 Token 的值写进命令、脚本或仓库。
- 构建脚本 `build.mjs` 由 wrangler 在部署时运行，仅复制页面、Service Worker、manifest 和图标到 `dist/`。
- `.env*`、`.dev.vars*`、`.wrangler/`、`dist/` 已忽略。

## 接口行为

| 接口 | 方法 | 行为 |
| --- | --- | --- |
| `/api/health` | GET | 验证访问口令，返回配置的模型名，不调用模型 |
| `/api/summary` | POST | 当天所选材料的总结，转发 Anthropic SSE |
| `/api/explore` | POST | 当天所选材料、可选总结及多轮对话，转发 Anthropic SSE |
| `/api/hyps` | POST | 从对话提炼最多 3 条假设，返回经校验的 JSON |
| `/api/chat` | POST | 独立自由聊天，可选假设清单 / 逐条消息的材料快照，转发 Anthropic SSE |

全部接口验证 Bearer 访问口令。POST 必须带 `Origin: https://zwgcb.cn`；GET 若提供 Origin，也必须匹配。所有接口共用 Cloudflare 限流绑定：`limit: 10`、`period: 60`。该绑定是近似计数，验收按“10 秒内发起 30 次 POST，出现 429”判断。

请求体上限 64 KiB，仅 `/api/chat` 为 256 KiB；只接受约定字段，客户端无法覆盖模型或输出上限。独立聊天只在系统提示和最后一条用户正文上加缓存标记。缓存是否实际命中以中转站返回的 usage 为准。

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

`npm run test:worker`（包含 `worker.test.mjs`、`hyps.test.mjs` 和 `chat.test.mjs`）

### 独立聊天接口

`POST /api/chat` 接收 1–200 条 `{role,content,ctx?}` 消息，最后一条必须为 user；可选 `hyps` 最多 300 条，只保留编号和文字；用户消息可带 `ctx:{date,materials}`，材料复用总结接口的字段校验；只有日期的旧消息不补发材料。旧客户端的顶层 `materials` 仍按当轮附件处理。默认不带当天记录。

使用探索模型、力度、输出上限和 adaptive / summarized 思考设置，连接 / 空闲 / 总时长分别为 60 / 120 / 600 秒。CHAT_SYSTEM 是模块内部常量（不能导出字符串，否则 Workers 会把它误当处理器入口）。每份材料放回对应用户消息的正文前，最新假设清单追加在最后一条用户正文后，不加缓存标记。只有系统和最后一条用户正文带缓存标记。资料中的 `<` 转义，并明确不执行资料里的指令。

v6.12.1 缓存诊断：两次相同请求相隔 7.036 秒，第二次读取 9,701 个 token、重新写入 1,920 个。按两处缓存标记判断，系统提示部分命中，消息部分重新写入；经这个中转站，消息部分的缓存看起来不生效。这是基于该次 usage 的推断，中转站没有逐块返回命中明细。

模型输出 hyp / pred / ev / ask 的纯文本标记。Worker 原样转发 SSE，不解析或保存聊天文本；前端负责安全呈现、用户点击后的写入与来源关联。规则及本机真实测试数字见 `docs/chat-acceptance.md`。

### 提炼假设接口

`POST /api/hyps` 与其他接口共用口令、Origin、限流和 64 KiB 请求上限。输入为 `{messages:[{role,content,ctx?}],hyps:[{no,text}]}`，最多 60 条消息、300 条现有假设，只使用角色、正文、编号和文字。使用 `MODEL_SUMMARY`、力度 `medium`、上限 4000，非流式。连接、重试和总预算沿用总结接口；响应开始后不因格式错误重发模型请求。

只从用户消息提出可验证或推翻的猜测，不能把 Claude 的建议当作事实。输出 `{hyps:[{text,why,near}]}`，最多 3 条。截断、无效 JSON、超大响应和缺失字段均报通用错误；不透传错误正文、思考、模型内部字段。不存在的相近编号归为 null。Worker 仅为本次响应临时解析 JSON，不记录或持久化对话、模型输出。

单元测试仅使用模拟凭据和模拟模型响应，不需要 `.dev.vars` 或真实密钥。第 A 批本机真实测试使用 `wrangler dev --local` 和虚构材料，各一次总结与探索；测试前告知请求次数。只报告状态、token 数、是否收到思考、耗时和安全响应头，不记录请求内容或模型输出。

## 当前验收边界（2026-11-12）

已实测：401/200 身份验证、403 Origin、413 大请求、30 次突发中的 429。主域名已绑定；用户确认手机不开代理能打开。

追问、备用节点成功生成和第二轮缓存命中仍待用户手机验收；已停止从本机重试线上接口。第 5 批 AI 页面已通过本机模拟流程，保存在专用分支，等待截图验收，尚未发布。
