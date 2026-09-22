# 持久记忆设计

[English](design.md) | 中文

## 问题

Harness Session 保存精确的对话日志，但不提供跨 Session 存续的用户/智能体记忆。记忆服务必须复用 Harness 已有的 LLM 路由、生命周期、存储和 Turn 事件，同时采用正确的身份与保留边界。它必须在易失败的增强之前保存原始证据，让变化事实可审计，在检索前隔离所有者，并使所有模型可见召回都能从 Session 日志重建。

Session 压缩与跨会话记忆服务于不同的保留需求。压缩保留精确的会话内历史，记忆则跨 Session 保留经过选择的持久化用户事实与身份信息。

## 决策

`@evyn/dsh-memory` 包含能力服务和可选工具消费者：

- 包根入口挂载 `ctx.memory`，负责持久化作用域状态、模型抽取与调和、混合检索、软删除、导入/导出及可选 Turn hook；
- `/tool` 导出注册显式新增、搜索、列举与遗忘工具，并从实时所属 Agent 派生每个作用域。

服务只依赖 Harness 的 `agents`、`llm` 与 `storageDomain` 接缝。由于契约刚建立且只有一个实现，能力定义与参考提供者暂时合一；工具入口保持独立，因为模型权限是可选的，而且明显窄于受信任服务 API。

### 作用域与持久化状态

存储键为 `{tenantId,userId,agentId}`。`sessionId` 是记录来源及可选读取过滤器，而不是存储分区，因此新 Session 可以召回旧记录。`userId` 默认采用稳定的 Harness-home 匿名身份，`agentId` 来自 Agent preset 或 `default`；两者都不是认证边界。

一条 storage-domain 记录包含所有者修订号、记忆记录及持久化写入回执。每次变更都原子替换整条记录。按所有者队列序列化单个服务实例；释放时先关闭受理，排空已受理写入，再关闭领域。

### Raw-first 增强与演进

每次新增先提交可召回的 L1 原始记录及 `accepted` 作业。直接模式随后创建一条 L2 事实或 L4 身份信息。抽取模式把不可信对话 JSON 发送给配置模型，只接受完全符合 schema 的严格 JSON 对象。抽取和调和提示词都包含由相同 Zod 校验器生成的 JSON Schema；未知可选字段必须省略，错误类型仍会导致写入降级，不进行强制类型转换。每个 sanitized source 独立排序 owner row 中 active、recallable、当前有效且同层的记录；Session 不是调和边界。空 shortlist 确定性生成 `ADD`，模型只看到非空来源并必须恰好覆盖每个可见来源一次。在训练型远端 embedding 空间中，首次 raw 提交携带同空间、同维度的零向量占位，保证易失败的网络调用不会先于持久证据。成功提交会用经过校验及 L2 归一化的向量替换占位；embedding 失败会降级作业、不创建派生记录，并保留可通过词法通道召回的 L1。

模型路由只在原始证据提交后解析。显式提供非空 `provider`/`model` 对时保持固定；同时省略时，每次写入读取一次 Harness `agentDefaultModel` 的当前选择。即使设置在写入中途改变，本次抽取和调和也共用同一路由快照。默认模型服务缺失时，抽取降级并保留原始证据，直接写入与读取仍然可用。bundle 依赖 `agentDefaultModel`，但不再把其启动时的值复制到插件配置中。

`ADD` 创建新链头；`NOOP` 把新的原始记录附加为现有记录的额外证据；`CONSOLIDATE` 创建合并链头并取代目标；`SUPERSEDE` 创建新修订并保留反向链接。成功处理后原始证据变为 `source_only`；模型或解析失败会把作业标为 `degraded` 并保持原始 L1 可召回。重启会把中断的 `accepted` 作业改为 `degraded`，不会猜测增强已经完成。

参考提供者写入 L0 基础画像、L1 原始、L2 事实、L3 摘要与 L4 身份记录。L5-L7 保留在公共类型词汇中，写入或导入时会封闭失败。

### 检索与模型可见性

读取在任何 provider 调用或排名前按所有者、状态、可见性、有效期、请求层与可选 Session 预过滤。画像与普通通道有独立配额。`EmbeddingProvider` 提供不含秘密的不可变 descriptor 及批量嵌入操作；核心负责按上限顺序分批、校验数量/维度/有限非零数值、保持顺序及最终 L2 归一化。默认 `HashEmbeddingProvider` 逐字节保持带版本的 256 维 token/字符哈希向量。训练型参考适配器调用 OpenAI 兼容端点，具有有界的单次超时、重试和退避；Loader 配置中的凭据来自命名环境变量，不会进入 descriptor 或公开配置。

语义向量、BM25 与倒数排名融合仍是独立通道。训练型 provider 搜索故障只关闭语义通道，以 `semantic:provider-unavailable` 诊断返回词法结果，且绝不会把调用方取消转换为降级成功。调和来源 query 按 provider descriptor 上限保持顺序分批；非取消故障、非法输出或零向量只关闭该批来源的语义排序，不阻止后续批次，tokenizer 故障则按来源隔离。每个来源可通过任一剩余通道继续；若任一非空候选池同时失去两条通道，整个 accepted job 降级且不提交部分派生记录。最终派生记录的 embedding 失败仍按 raw-first 语义降级整个增强。便携哈希搜索继续报告 `semantic:portable-hash`。

BM25 使用公共 `LexicalTokenizer` 接缝。默认 `CjkBigramTokenizer` 保留 ASCII 字母数字 run，并为连续 Basic Han 生成重叠 bigram；`legacy` 恢复之前的整段中文策略，作为不改存储的回滚开关。便携哈希空间由独立的私有 legacy token 路径隔离，因此词法策略变化不会修改其版本化向量。画像/普通排序、训练型 provider 的词法 fallback、降级零占位 raw 召回及调和候选共用同一个已解析 tokenizer。Query 长度，以及所有者、状态、可见性、有效期、层和 Session 过滤都先于 tokenizer/provider；候选为空时两者都会短路。

受信任的程序化 tokenizer 只能看到 query，以及预过滤候选的内容和规范化标签。空输入 preflight、实际数组校验、100,000 token 与 256 UTF-16 code unit 上限、立即复制和固定 `TOKENIZATION_FAILED` 错误会限制普通故障，且不保留上游 cause。搜索只关闭词法排序并发出 `lexical:tokenizer-unavailable`；若语义也失败，则返回空通道及两项诊断。调和可只使用词法通道；只使用语义回退时，还要求 query 向量与至少一条候选向量均为非零。缺少该信号会降级 accepted job 并保留可召回 L1。调和 prompt 按抽取顺序列出来源及各自排序后的 candidate ID，并附上按首次出现稳定去重的候选目录。`NOOP` 与 `SUPERSEDE` 只能使用本来源 shortlist；`CONSOLIDATE` 只能使用参与调和且同层的来源 shortlist 并集。自动 `ADD` 来源及所有 owner、Session、向量、meta、visibility、无效状态和跨层内容对模型不可见。调用方取消保持为取消。由于该扩展同步执行，永不返回的可信实现无法在此调用边界被抢占。

只有所有记录都匹配活动 descriptor 的 `spaceId` 与维度时，owner 状态才有效。导入、冷启动和混合批次会原子拒绝不匹配。Provider、模型、维度、归一化或算法变化都必须使用部署者固定的新空间 ID。MEM-101 明确不改写 canonical 记录；重嵌入与迁移属于 MEM-104。

自动召回在普通 `agent/pre-step` 决策之后运行，仅当决策含直接人类输入且检索有结果时，才前置一条插件生成的 user 消息。消息有长度限制和明确边界，把记录标为可能有误，并在模型请求之前进入普通 Session surface。自动捕获在 `agent/turn-stopping` 运行，排除工具及插件自身的召回消息，并以 `{sessionId}:turn:{turn}` 作为幂等键。

工具消费者不接受模型提供的作用域 id。它只开放直接写入，将批量导入/导出保留为受信任 API，并要求以精确记录 id 执行遗忘。

## 验证

包测试使用真实 LLM runtime、storage hub、storage-domain 形式及 JSON 后端，覆盖直接 raw-first 幂等、跨 Session 与仅当前 Session 检索、降级抽取、严格成功抽取及重复证据、证据感知遗忘、provider 分批/归一化/重试/取消/脱敏、训练型 provider 降级与空间隔离，以及四个工具契约。真实 Loader 组合先通过 JSON 后端写入，完整释放后冷启动新组合，并召回上一 Session 的记录。

离线 Embedding 评测使用构建后的包、临时 JSON 存储和公共 `import()`/`search()` API，在冻结的低词面重叠双语语料上运行，不访问网络，并固化哈希 baseline。Live 评测必须同时提供模型参数和显式网络授权，从环境变量读取端点/密钥，并且只输出不含秘密的 provider 信息、聚合/逐例指标和隔离 hard checks。

离线词法评测在全新 Context 中通过同一公共 API 物化冻结的 258 条中文语料，并在相同哈希空间下比较显式 `legacy` 与默认 `cjk-bigram`。Canonical 报告包含 24 条计分用例、6 条隔离负例、分桶 Recall@5/10 与 MRR@10、模式 delta、tokenizer provenance 和零容忍 hard checks。Embedding 评测显式选择 `legacy`，避免 MEM-101 质量被词法策略变化污染。

本包把服务、工具、invariant、管理宿主与浏览器消费者构建为独立导出。invariant 检查记忆领域变更中的已删除可见性、唯一活动链头及双向演进关系。

## 考虑过的替代方案

**把记忆存入 Session 日志或 Session projection。** 这会天然隔离每个 Session；若没有第二套索引与身份策略，就无法提供所需的跨会话所有者语料库。因此 Session id 只保留为来源。

**让记忆工具拥有存储。** 自动捕获、Host 消费者、迁移和UI 消费者都需要稳定的非模型能力。工具只作为窄化的可选消费者。

**要求单一具体嵌入服务。** Harness 当前没有共享嵌入能力，把本包绑定到单一厂商会破坏 provider 接缝。因此本包拥有一个窄 provider 端口，以便携哈希实现作为离线默认值，并提供一个 OpenAI 兼容的生产参考适配器。

**受理写入后隐藏原始记录。** 受理与增强之间的模型或进程故障会导致记忆不可召回。只有成功完成直接或抽取提交后，原始证据才不再召回。

## 后果

Harness 获得可审计的跨会话记忆，无需第二套生命周期、模型适配器或后端抽象。部署可以装载自动召回/捕获、显式工具、两者兼有，或只使用受信任服务 API。模型失败会保留证据并返回可见的降级回执；变化事实通过演进链接保持可检查，而不是破坏性覆盖。

参考存储优先保证正确性与便携性，而非规模：所有者状态是一整条 JSON 记录，并发序列化仅限进程内。训练型 provider 可以改善低词面重叠语义召回，但会把记忆文本发送给外部数据处理方，并引入延迟与可用性风险；raw-first 与词法降级限制了这些故障的影响。分页事务存储、embedding 空间迁移、原生结构化输出、认证主体映射、保留策略与 L5-L7 语义仍属于未来独立决策。

## 管理与诊断边界

`/management` 是依赖 Connection/WebServer 的可选宿主消费者；原生浏览器 `/client` 工厂把页面注册到 `settings.section`。所有 HTTP 请求走 Connection 的统一认证与请求信任校验。管理预设列表由配置中的 tenant/user 和已有记录派生，RPC 严格拒绝未知字段及浏览器所有者 ID。记录 DTO 使用字段白名单；正文和直接证据可见，向量、任意 meta、原始 warning 和异常正文不可见。该权限代表本机部署管理者，不等价于多租户认证主体。

确认/更正使用 owner 队列和整个 scope 的 expectedRevision，在新增原始证据之前验证目标和内容。幂等重试优先于修订号检查。accepted 原始证据持久化后再做嵌入，成功后原子提交新 explicit 链头、旧版本双向链接和 completed 作业；失败保留旧链头及可召回 raw。确认保留正文，更正替换正文，两者均建立新版本而不覆盖历史。软删除复用已有来源级联规则，管理调用启用可选 expectedRevision。

作业诊断时间、逻辑调用数及稳定错误码是可选附加字段，storage domain 版本仍为 0，旧作业可读取且不会虚构历史耗时。重启遗留 accepted 作业记为 degraded/INTERRUPTED。diagnostics 不调用模型；召回事件记录上下文装箱后实际注入的 IDs，不保存 query，采用全局最多 200 条进程内环形缓存，按 owner 过滤后返回最近 20 条。持久作业返回最近 30 条，但计数覆盖当前 owner 全部记录/作业。当前 JSON 全量扫描与整行替换限制仍然存在。

处理中作业不显示未完成的调用计数；中断恢复作业保留开始时间和恢复时间，但耗时与调用次数显示为未知，避免把停机时间误算为处理耗时。
