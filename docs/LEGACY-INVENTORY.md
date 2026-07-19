# 旧 LG 可复用零件盘点

旧仓库：`C:\Users\qdz\Desktop\cli\lg-ng`

本清单只表示值得审阅，不表示直接复制。每个零件必须移除旧业务假设，并通过新接口进入 LG Next。

## 优先审阅

| 能力 | 旧位置 | 处理方式 |
| --- | --- | --- |
| 模型客户端与流式请求 | `packages/novel-guide/src/model/` | 提取传输层，不继承 Prompt 与 workflow |
| Agent 查询循环 | `packages/novel-guide/src/agent/` | 保留事件和工具调用经验，重新定义运行边界 |
| 会话压缩 | `packages/novel-guide/src/agent/engine.ts` | 只压缩任务会话，不产生项目真相 |
| 路径安全 | `packages/novel-guide/src/utils/paths.ts`、`apps/lg/lib/server/safe-paths.ts` | 合并成一个实现 |
| Token 与费用记录 | `apps/lg/lib/server/api-call-ledger.ts`、`billing-store.ts` | 改为本地 usage event，不与账户余额耦合 |
| Markdown/章节解析 | `apps/lg/lib/server/chapter-store.ts`、`book-index.ts` | 只移植纯解析逻辑 |
| 导入 | `apps/lg/lib/server/import-store.ts` | 适配新的作品格式 |
| 对话与编辑器 UI | `apps/lg/components/` | 只挑选视觉和交互零件 |
| 检索评测样本 | `apps/lg/scripts/evaluate-retrieval.ts` | 迁为 Story Index 回归测试 |

## 明确不迁移

- `propose_file_change` 作为续写默认路径；
- `/续写`、`/铺垫`、`/收线` 固定 workflow；
- `读者体验/`、情绪账户、爽点债务；
- 固定六卡或固定上下文比例；
- 用户记忆与审美画像；
- 多套 book-store/file-tool 写入；
- 多套 retrieval/search_canon 检索；
- 角色 reviewer 与固定评审流水线；
- Agent 权限审批 UI。

## 移植原则

1. 先为新接口写测试，再移植旧实现。
2. 只复制纯能力，不复制目录和产品概念。
3. 新实现能独立运行后再接 UI。
4. 旧仓库始终只读参考，不在原处继续重构。

