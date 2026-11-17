# 独立聊天页：meta 兼容检查

2026-11-17，基于 ai-chat 的已验收实现检查。

- `curSeq()` 只读取 `S.meta.counters.hypSeq`，`claimNo()` 只写 `meta/counters`，不会遍历并误读聊天。
- `snapshotLocal`、`mergeSnap`、`applySnap`、旧记录补 `_t`、本机加载、云端监听、数据迁移、导出和导入均按 COLS / 文档 id 通用处理。
- `remove('meta','chat:'+id)` 沿用现有删除标记；不会删除其他集合的假设、预测或证据。
- 没有发现将 meta 的每个文档都视为计数器或设置的代码。保持所有存储键名和 COLS 不变。
- `chat:` 文档只存对话正文、上下文日期、加入状态和引用；不存思考摘要或访问口令。生成草稿使用原有 drafts 中的新键。
