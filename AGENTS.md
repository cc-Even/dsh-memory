# dsh-memory Agent 开发指南

本文供后续开发 Agent 快速建立项目上下文。修改代码前，先阅读本文件以及与变更相关的设计文档；若实现与文档冲突，以代码和测试中的当前行为为准，并在变更中同步修正文档。

## 项目定位

`@evyn/dsh-memory` 是 DeepSeek Harness 的持久记忆插件。它以 `{tenantId, userId, agentId}` 为所有者边界，跨 Session 保存用户事实与身份信息，保留原始证据，并在模型回答前召回相关上下文。

核心设计原则：

- raw-first：任何模型抽取前先持久化 L1 原始证据和作业回执；
- 非破坏式演进：事实通过 `NOOP`、`CONSOLIDATE`、`SUPERSEDE` 建立证据或版本关系，不覆盖历史；
- 先隔离再检索：先按所有者、状态、可见性、有效期和可选 Session 过滤，再排名；
- 模型权限最小化：模型工具不能自行指定 tenant、user、agent 或 session；
- 可审计：召回消息进入正常 Session surface，模型失败时原始证据仍可召回。

详细设计见 `docs/design.zh.md`（中文）和 `docs/design.md`（英文）；安装、配置与公共 API 见 `README.zh.md` 和 `README.md`；外部 Embedding/LLM 接口的安全测试方式见 `docs/testing-guide.zh.md`。

## 技术栈与常用命令

- Node.js：`^22.19.0` 或 `>=24.0.0`
- 包管理器：pnpm `11.7.0`
- 语言：TypeScript，ESM，严格模式
- 运行时校验：Zod、Schemastery
- 测试：Vitest
- 构建：TypeScript declaration emit + tsdown

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

提交前至少运行后三项。只执行单个测试文件可使用：

```sh
pnpm exec vitest run tests/memory.spec.ts
pnpm exec vitest run tests/tool-memory.spec.ts
pnpm exec vitest run tests/loader-composition.spec.ts
```

## 代码地图

| 路径 | 职责 | 常见修改场景 |
| --- | --- | --- |
| `src/index.ts` | `MemoryService` 主入口；配置、作用域、写入、调和落库、检索、遗忘、导入导出、生命周期 hook、状态不变量 | 改服务行为、配置项、自动捕获/召回、持久化流程 |
| `src/types.ts` | 公共类型与 `MemoryCapability` 接口 | 改公共 API、记录格式、搜索/写入结果 |
| `src/schema.ts` | storage-domain 的 Zod schema；scope 文档和 durable job 格式 | 改持久化结构或 schema 版本 |
| `src/model.ts` | LLM 抽取与调和 prompt、严格 JSON schema、流式结果组装 | 改抽取字段、调和动作、模型调用方式 |
| `src/retrieval.ts` | 中英文分词、256 维哈希向量、BM25、意图分类、RRF、演进历史 | 改召回质量和排序算法 |
| `src/tool.ts` | `memory_add/search/list/forget` 四个模型侧工具 | 改工具参数、输出或权限边界 |
| `src/invariant.ts` | 可选 invariant companion，监听 storage-domain 提交并检查演进关系 | 改运行时一致性检查 |
| `src/error.ts` | 稳定的 `MemoryErrorCode` 和 `MemoryError` | 增加可供调用方分支处理的错误 |
| `cordis.patch.yml` | bundle 安装时挂载服务和工具，并注入默认模型路由 | 改默认插件组合 |
| `tests/memory.spec.ts` | 服务集成测试，使用真实 Cordis/LLM/storage 组件 | 服务、hook、抽取、调和、遗忘回归 |
| `tests/tool-memory.spec.ts` | 工具注册、参数映射和输出契约 | 模型工具回归 |
| `tests/loader-composition.spec.ts` | 真实 Loader + JSON 后端冷重启持久化测试 | 包装配、配置、重启恢复回归 |
| `docs/testing-guide.zh.md` | 外部 Embedding/LLM 接口连通性、安全与嵌入空间边界 | 仅在任务需要真实模型接缝时参考；普通单测不应访问外网 |
| `tsconfig.json` / `tsdown.config.ts` | 类型产物和三个 ESM 入口的构建 | 构建或导出调整 |

## 核心调用链

### 写入

`MemoryService.add()` → `resolveAdd()` → 按 owner key 进入 `enqueue()` 串行队列 → 写入可召回 L1 raw 和 `accepted` job →：

- `direct`：创建 L2/L4 派生记录，将 raw 改为 `source_only`，通过 `commitSuccess()` 原子提交；
- `extract`：`extractMemories()` → `sanitizeExtraction()` → `reconcileCandidates()` → `reconcileMemories()` → `applyExtraction()` → `commitSuccess()`；
- 模型、解析或调和失败：job 标记为 `degraded`，L1 raw 保持可召回；存储失败则抛错。

幂等键在同一 owner scope 内查找。服务启动时 `recoverAcceptedJobs()` 会把进程中断遗留的 `accepted` job 标记为 `degraded`。

### 检索与召回

`MemoryService.search()` 先过滤记录，再把 L0/L4 放入 profile 通道，其余层放入 normal 通道。`rank()` 在 `src/retrieval.ts` 中组合哈希向量余弦、BM25 和 RRF；两个通道有独立配额。

启用 `autoRecall` 后，`agent/pre-step` 从直接用户消息构造 query，将 `recallContext()` 生成的有界 `<memory-recall>` 消息插到当前用户消息前。

### 自动捕获

启用 `autoCapture` 后，`agent/turn-stopping` 使用 `messagesForTurn()` 收集本轮非工具、非本插件召回消息，序列化为 JSON，并以 `${sessionId}:turn:${turn}` 为幂等键调用 extract 模式写入。

### 演进与遗忘

- `ADD`：建立新记录；
- `NOOP`：不建新记录，把新 raw 证据、标签、置信度和 turn index 合并到已有记录；
- `CONSOLIDATE`：建立合并后的新链头，旧记录变为 `superseded/source_only`；
- `SUPERSEDE`：建立替代旧事实的新修订，保留双向链接；
- `forget()`：软删除目标；若派生记录移除该证据后没有其他 `sourceMemoryIds`，也将其软删除。

## 必须保持的不变量

修改持久化或调和代码时，不要破坏以下约束：

- owner key 不含 `sessionId`；Session 只作为来源及可选读取过滤条件；
- 任何可能失败的模型调用都发生在 raw 首次提交之后；
- 已删除记录不得保持 `recallable`；
- 一个 `chainId` 最多有一个 `active + recallable` 链头；
- `supersedes` / `consolidates` 必须与旧记录的 `supersededBy` 保持双向一致；
- L2/L3/L4 的非 explicit 记录必须有 raw 来源；
- 当前 provider 只允许持久化 L0-L4，L5-L7 是公共类型中的预留层；
- embedding 的 `spaceId`、维度和向量长度必须一致；改变哈希算法或维度时必须更换 space ID，并设计重嵌入/迁移；
- 工具侧 scope 必须继续由 `ctx.memory.scopeFor(exec.agent)` 派生；不要接受模型提供的 owner ID；
- 自动捕获必须排除工具消息和本插件的召回消息，避免记忆自我回灌；
- `README.md` 与 `README.zh.md`、`docs/design.md` 与 `docs/design.zh.md` 的对外行为描述应同步。

## 修改入口速查

- 新增配置项：同时修改 `Config` interface、Schemastery `Config`、`ResolvedConfig`、`resolveConfig()`、README 配置表及测试。
- 修改记录字段：同时修改 `MemoryRecord`、`memoryRecordSchema`、创建/导入逻辑、导出兼容策略、invariant 和测试；若不向后兼容，升级 domain/schema 版本并提供迁移。
- 修改抽取输出：同时修改 `src/model.ts` 的 Zod schema、prompt、类型，以及 `sanitizeExtraction()` / `applyExtraction()`。
- 修改调和操作：同时修改 operation schema、prompt、`validatePlan()`、`applyExtraction()` 和演进关系测试。
- 修改检索：优先在 `src/retrieval.ts` 保持算法为纯函数，并补充独立排序测试；再调整 `MemoryService.rank()` 的过滤和权重。
- 修改工具：同步工具输入/输出 schema、执行映射、render 文案和 `tests/tool-memory.spec.ts`；受信任服务 API 不应自动暴露给模型。
- 新增包入口：同步 `package.json#exports`、`files` 和 `tsdown.config.ts#entry`。
- 修改 bundle 装配：同步 `cordis.patch.yml`，并运行 Loader 冷启动测试。

## 编码与测试约定

- 使用 `.ts` 扩展名的相对导入，保持纯 ESM。
- 遵守 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、无未使用变量等编译约束。
- 公共导出和重要内部流程保持简短 JSDoc。
- 输入在边界校验；持久化提交前调用状态校验；错误需要被调用方识别时使用稳定 `MemoryErrorCode`。
- 保持 owner 级写操作串行化；若调整并发模型，必须覆盖同 owner 竞争、不同 owner 并行、关闭排空和跨进程冲突。
- 测试优先使用真实 Cordis 服务组合；仅在 LLM 返回和模型工具能力边界使用轻量 fake/mock。
- 行为变更至少覆盖成功、幂等/重复、失败降级、重启恢复或权限隔离中相关的路径。

## 当前架构边界

- 一个 owner 的全部 records 和 jobs 存在同一 JSON scope 文档中，每次写入整体替换；
- owner 写队列只在单进程内生效，跨进程一致性取决于 storage-domain 的原子 update；
- 内建 embedding 是确定性哈希特征，不是训练型语义模型；
- 标签参与 BM25 文本，但没有独立倒排索引；
- 抽取与调和依赖模型返回严格 JSON；
- 自动捕获每轮最多增加一次抽取和一次调和模型调用；
- 默认匿名 userId 是关联标识，不是认证/授权主体。

不要在未设计迁移、并发和隐私策略的情况下绕过这些边界。
