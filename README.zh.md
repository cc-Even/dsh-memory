# @evyn/dsh-memory

> 为 [DeepSeek Harness](https://github.com/deepseek-ai) 提供持久、可审计的跨会话记忆。

[English](README.md) | 简体中文

`@evyn/dsh-memory` 是一个原生 DeepSeek Harness 插件，让智能体能够跨 Session 保留长期记忆。它会提取值得长期保存的用户事实与身份信息，保留原始证据，在不破坏历史的前提下调和重复或变化的信息，并在模型回答前召回相关上下文。

本插件直接构建于 Harness 原生的生命周期、LLM、Session 与存储能力之上。包内同时提供可信的 `ctx.memory` 服务，以及一组权限边界更窄的模型侧记忆工具。

> [!IMPORTANT]
> 本项目目前处于 `0.1.x` 阶段。存储格式与公共 API 已有测试覆盖并可使用，但在稳定版本发布前仍可能调整。

## 特性

- **跨会话记忆**——记忆归属于租户、用户和智能体，而不是单个 Session。
- **原始证据优先持久化**——在可能失败的模型抽取开始前，先提交来源内容。
- **结构化记忆分层**——支持基础画像、原始证据、事实、摘要和稳定身份信息。
- **非破坏式演进**——重复、合并或被取代的事实都会保留来源与版本关系。
- **混合检索**——组合便携的 256 维哈希向量、BM25 与倒数排名融合。
- **自动捕获与召回**——接入 Harness Turn 事件，同时保留原有 Session 日志。
- **显式模型工具**——提供新增、搜索、列出和遗忘操作，作用域由服务端派生。
- **优雅降级**——抽取失败时，原始 L1 记录仍然持久且可召回。
- **数据可迁移**——可信消费者可导入、导出经过校验并带嵌入空间标识的记录。

## 工作原理

```mermaid
flowchart LR
    A[用户 Turn] --> B[持久化 L1 原始证据]
    B --> C[抽取结构化记忆]
    C --> D{调和}
    D -->|ADD / NOOP| E[活动记忆]
    D -->|CONSOLIDATE / SUPERSEDE| F[新的演进链头]
    E --> G[混合检索]
    F --> G
    G --> H[有界召回上下文]
    H --> I[下一次模型 Step]
    C -. 模型失败 .-> J[可召回的 L1 降级结果]
```

每次写入都会先持久化一条 L1 原始记录和一个持久作业。使用抽取模式时，配置的记忆模型会生成经过 Schema 校验的 JSON，并只与同一所有者的记录调和。增强成功后会生成结构化记录，并把原始内容保留为来源证据；增强失败则返回 `degraded` 回执，同时保持原始内容可召回。

搜索会在排序前按所有者、可见性、状态、有效期、记忆层和可选的 Session 范围过滤。画像记忆与普通记忆使用相互独立的结果配额。

## 环境要求

- 已配置可用对话模型的 DeepSeek Harness
- Node.js `^22.19.0` 或 `>=24.0.0`
- Harness 持久存储；Web profile 已默认提供
- 从源码开发时使用 pnpm `11.7.0`

## 快速开始

### 安装插件

将已发布或已打包的版本安装到 Harness Web profile：

```sh
dsh plugin --profile web add @evyn/dsh-memory
dsh --profile web --dump-config
dsh --profile web
```

包内 patch 会同时挂载记忆服务及其工具，并使用 Web profile 当前选择的默认模型进行抽取和调和。

也可以直接从指定 Git 版本安装：

```sh
dsh plugin --profile web add github:<owner>/dsh-memory#<commit-sha>
```

Git 安装会运行包的 `prepare` 脚本。如果 `dsh` 提示 pnpm 构建授权，请按提示完成一次性授权。

### 手动配置

手动挂载服务或需要覆盖 bundle 默认值时，请显式指定模型路由：

```yaml
- name: '@evyn/dsh-memory'
  config:
    provider: deepseek
    model: deepseek-chat
    autoCapture: true
    autoRecall: true

- name: '@evyn/dsh-memory/tool'
```

对于 headless 或自定义 profile，需要先挂载以下依赖：

- `dsh-agent`
- `dsh-llm`
- `dsh-storage`
- 一个存储后端
- `dsh-storage-domain`

启用后只需正常对话：已完成的用户 Turn 可被自动捕获，后续回答前会自动注入相关记忆；智能体也可以调用下文列出的显式工具。

## 配置

### 核心选项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `provider` | `string` | 必填 | 用于抽取和调和的 LLM provider。 |
| `model` | `string` | 必填 | 用于抽取和调和的模型 ID。 |
| `userId` | `string` | Harness 匿名 ID | 用于确定记忆所有权的稳定用户身份。 |
| `tenantId` | `string` | 未设置 | 可选的租户命名空间。 |
| `autoCapture` | `boolean` | `true` | 直接用户 Turn 停止时抽取持久记忆。 |
| `autoRecall` | `boolean` | `true` | 包含直接用户输入的 Step 开始前召回记忆。 |

bundle patch 会从当前默认模型选择中提供 `provider` 与 `model`；直接挂载服务时，这两个字段仍为必填项。

### 限制与检索策略

| 选项 | 默认值 | 说明 |
| --- | ---: | --- |
| `maxModelTokens` | `4096` | 每次抽取或调和调用的最大输出 token 数。 |
| `maxInputChars` | `50000` | 单次写入可接受的最大来源字符数。 |
| `maxRecordChars` | `4000` | 单条派生记录保留的最大字符数。 |
| `recallLimit` | `8` | 普通召回通道的最大结果数。 |
| `profileLimit` | `4` | 单独预留的画像结果数。 |
| `maxContextChars` | `6000` | 单个模型 Step 注入记忆上下文的最大字符数。 |
| `reconcileCandidateLimit` | `12` | 提供给调和模型的现有候选数量。 |
| `minSemanticScore` | `0.08` | 无词法匹配时所需的最低哈希向量余弦分数。 |
| `rrfK` | `60` | 倒数排名融合的平滑常数。 |
| `bm25K1` | `1.5` | BM25 词频饱和参数。 |
| `bm25B` | `0.75` | BM25 文档长度归一化参数。 |
| `profileFields` | name、age、location、timezone、language、occupation | 抽取器可更新的 L0 画像字段。 |

## 记忆分层

| 层级 | 用途 | 当前 provider 是否写入 |
| --- | --- | --- |
| `l0_basic_info` | 结构化基础画像 | 是 |
| `l1_raw` | 原始来源证据 | 是，在增强前写入 |
| `l2_fact` | 事件与变化中的事实 | 是 |
| `l3_summary` | 模型生成的摘要 | 是 |
| `l4_identity` | 稳定偏好、特征与身份 | 是 |
| `l5_knowledge` | 预留的便携层 | 否 |
| `l6_schema` | 预留的便携层 | 否 |
| `l7_intention` | 预留的便携层 | 否 |

L5-L7 保留在公共类型中以兼容数据格式，但当前参考 provider 会拒绝写入或导入这些层。

## 模型侧工具

安装 bundle 后还会挂载 `@evyn/dsh-memory/tool`：

| 工具 | 用途 |
| --- | --- |
| `memory_add` | 保存一条用户明确表达的事实或稳定身份信息。 |
| `memory_search` | 搜索相关的跨会话记忆，可选择返回演进历史。 |
| `memory_list` | 检查最近记忆，可按记忆层或 Session 过滤。 |
| `memory_forget` | 用户明确要求后，按准确 ID 软删除一条记忆。 |

所有作用域 ID 都从当前所属 Agent 派生，模型无法自行选择租户、用户、智能体或 Session ID。批量导入和导出仅通过可信服务 API 提供。

## 服务 API

包根入口会挂载 `ctx.memory` 并实现 `MemoryCapability`：

```ts
const scope = ctx.memory.scopeFor(agent)

const receipt = await ctx.memory.add({
  scope,
  content: '用户偏好使用 TypeScript 开发后端服务。',
  layer: 'l4_identity',
  tags: ['typescript', 'backend'],
  idempotencyKey: 'preference-typescript',
})

const result = await ctx.memory.search({
  scope,
  query: '用户开发后端时偏好什么语言？',
  includeEvolution: true,
})
```

完整能力包括：

- `scopeFor(agent)`
- `add(input, signal?)`
- `search(input, signal?)`
- `get(memoryId, scope)`
- `list(input)`
- `forget(memoryId, scope)`
- `export(scope)` / `import(scope, records)`
- `health()`

公共 TypeScript 类型从 `@evyn/dsh-memory` 和 `@evyn/dsh-memory/types` 导出。

## 身份、隐私与模型行为

记忆以 `{tenantId, userId, agentId}` 作为所有者键。当前 `sessionId` 仅作为来源信息和可选读取过滤条件，因此智能体可以召回较早 Session 的记录，同时不会混淆不同所有者。

启用自动召回后，插件会在当前用户消息前插入一条有长度上限、由 `<memory-recall>` 明确分隔的 user 消息。它会把召回记录标记为可能有误的背景，并要求模型在发生冲突时以当前请求为准。召回消息通过普通 Session surface 写入，因此可以从日志重建模型实际看到的请求。

启用自动捕获后，已完成用户 Turn 中的非工具对话会作为不可信 JSON 数据发送给配置的记忆模型。抽取不会改变已经在生成中的回答。每个 Turn 会增加一次抽取调用；发现事实时，还会再增加一次调和调用。

默认匿名用户 ID 只是本地关联身份，不代表认证或授权。处理敏感或敌意内容的部署应提供经过认证的 `userId`，审查数据保留策略，并按自身威胁模型增加内容策略过滤。

## 当前限制

- 内建哈希嵌入可移植且确定，但弱于经过训练的多语言嵌入模型。
- 标签会参与词法文本检索，但目前没有独立标签索引。
- 每次变更都会原子替换一个所有者的整行 JSON 状态，不适合超大规模语料。
- 按所有者串行化仅限单进程；storage domain 尚不提供跨进程 compare-and-set。
- 抽取与调和要求模型返回严格 JSON；说明文字或错误格式会导致封闭失败。
- 自动捕获会为每个完成的用户 Turn 最多增加两次模型调用。
- 项目尚未内建认证主体映射、数据保留策略和可写的 L5-L7 语义。

架构、行为保证与未采用的替代方案详见[设计文档](docs/design.zh.md)。

## 本地开发

```sh
git clone <repository-url>
cd dsh-memory
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

测试覆盖原始证据优先的幂等写入、跨会话检索、自动召回、抽取降级、记忆调和、证据感知遗忘、四个模型工具，以及 Loader 冷重启后的持久化。

## 参与贡献

欢迎提交 Issue 和 Pull Request。行为变更请同时补充测试；面向用户的文档发生变化时，请同步更新 `README.md` 与 `README.zh.md`。提交 PR 前请运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
