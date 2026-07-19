# LG Next

一个以 Agent 对话为主体、本地 Markdown 作品为本体的小说创作桌面应用。

当前仓库是完全重构后的绿地实现，不继承旧 LG 的工作流和数据模型。旧项目只作为经过筛选的零件来源。

## 开发

```bash
pnpm install
pnpm dev
```

## 配置模型

点击顶栏“设置”，填写 Base URL、模型和 API Key，可以测试连接并立即生效。API Key 只保存在本机；操作系统支持时使用系统加密存储。

也可以在启动前使用环境变量：

```powershell
$env:LG_API_KEY="..."
$env:LG_BASE_URL="https://example.com/v1"
$env:LG_MODEL="model-id"
pnpm dev
```

为了方便从旧 LG 迁移，也兼容 `NG_API_KEY`、`NG_BASE_URL`、`NG_MODEL` 和 `DEEPSEEK_API_KEY`。

API Key 只传给本地 Agent utility process，不进入作品目录、任务日志或 Git。应用内设置优先于环境变量。

## 当前阶段

- Electron 桌面壳与对话优先界面；
- 本地作品初始化和多个任务；
- 最近作品列表、启动自动恢复和 Agent 写入后的编辑器同步；
- 可读的版本历史、正文差异和不回退任务记忆的向前恢复；
- 本地任务事件历史与流式 Agent 过程；
- 可停止的 Agent 运行、取消状态与中断前有效修改 checkpoint；
- OpenAI-compatible 模型调用；
- 单一 `search_story`、原文读取、统一写入、项目纠正和 PowerShell 工具；
- 编辑器、Agent 与官网结果共用的 Workspace Mutation Service；
- per-project 写入队列、原子 Markdown 写入、mutation ledger、revision 冲突保护和任务级 Git checkpoint；
- 可视化小说 Markdown 编辑器与源码模式；
- 防抖自动保存、未保存切换保护和 Agent 外部修改冲突提示；
- revision-aware、按文件 shard 增量更新且可 read-repair 的 Story Index；
- Agent 主动决定检索范围和原文读取深度，不固定预取正文；
- 持久任务 Session、旧工具结果 microcompact、单一 compaction memo 和最近原文窗口；
- 以新来源、revision、有效写入和纠正为进展信号的自适应循环预算；
- 保存用户原话、目标 revision 和实际修订关联的项目 Correction Ledger；
- 主 Agent 自选来源、读取深度、约束和预算的官网模型接力包；
- 明确写入区块、来源 revision 检查、外部原文保存和统一结果导入；
- 产品与架构边界。

下一步是在真实长篇作品上建立远距离共同历史、矛盾证据、用户纠正和无进展循环的评测集。
