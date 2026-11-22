# v6.16.0 上线与手机核对

当前为功能分支审查阶段。生产迁移步骤待历史配额和最终上限验收完成后确认。

## 手机验收顺序

生产构建成功后，先由管理员在手机上登录，核对认领框显示的数量，确认归入自己的账号。等待同步完成，在另一台设备登录同一账号，检查最大的聊天、近期记录及加密备份。若显示有记录只保存在本机，展开查看，再决定是否接受该容量。管理员完成这轮核对后再发邀请码。

## 查看 CPU 时间与错误

在 Cloudflare 控制台打开 **Workers & Pages → zwgcb-journal → Metrics**，时间范围选本次手机认领与恢复所在的时段。记录请求数、CPU time 的高分位值（p99），以及 Requests / Invocation statuses 中的错误数和 Exceeded CPU Time 次数。刚开始测试时先记下基线，便于区分该时段内新出现的错误。[Worker 指标](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)

通过条件为手机操作均成功、该时段新增 CPU 超限与系统错误均为 0、CPU p99 低于免费版 10 ms 请求预算。查看单次错误时，1102 与 Exceeded CPU Time 同时出现表示 CPU 超限。4 ms 是本机基准目标。控制台统计聚合整个 Worker 的请求，样本很少时也要看错误次数。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) · [Worker 错误](https://developers.cloudflare.com/workers/observability/errors/)

如果出现 1102，暂停发邀请码，先把 `worker/sync-limits.mjs` 的 `batchBytes` 调到 `docBytes`，使单次批量传输预算等于一条记录的上限。重新构建页面并在管理员手机上复测。若单条请求本身仍超限，保留本机记录，停止推广，重新核查单条路径。该步骤仅在获准发布修订后执行。
