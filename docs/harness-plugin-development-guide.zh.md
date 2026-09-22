# DeepSeek Harness 插件开发指南

阅读核对日期：2026-09-21。本文从官方 [Your first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) 出发，沿 Next steps、页尾 Next 与 Cordis 教程阅读路径整理，覆盖入门、框架、能力设计、工具、模型适配、装配与交付。它是开发路线与关键契约的归纳，不替代各包的完整 API reference。

网站部署内容、GitHub `master` 和本机安装版本可能不同。实现时以**目标版本的导出类型、源码和测试**核对签名；本文发现的文档差异见第 13 节。标注“实践建议”的内容是本文的工程归纳；代码是重新组织的教学示例。

## 1. 先明确要扩展什么

Harness 通过 Cordis 插件组合能力。插件从 `ctx` 获取服务、注册工具或事件；Loader 根据配置挂载插件实例，每个实例由 Fiber 管理生命周期。服务名称是运行时依赖，TypeScript 声明合并只负责类型。参见 [Cordis primer](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer)。

| 开发目标 | 首选机制 | 实现重点 |
| --- | --- | --- |
| 为模型增加一个操作 | `ctx.tools.register(defineTool(...))` | 参数、规范返回值、取消、展示 |
| 向其他插件提供可复用能力 | `Service` + `inject` | 稳定接口、实现替换、生命周期 |
| 审计、修改请求、执行策略 | `ctx.on(...)` | 事件签名与派发模式 |
| 接入模型供应商 | `LlmAdapter` + `registerAdapter` | 请求转换、流协议、错误、取消 |
| 安装一组插件及默认配置 | npm bundle + patch | 包入口、配置层、profile |
| 扩展客户端或外部协议 | Client 插件或协议驱动 | 实时流、持久事件、交互与释放 |

服务定义、提供者、消费者只在需要独立演进时拆包；普通工具可以从单个模块开始。上表对应官方 [扩展模式](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/extension-cookbook) 与 [能力分层](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/)。

## 2. 准备环境：区分两条运行路线

### 2.1 在完整 Harness 中开发

官方源码运行路线如下；这些命令在 **DeepSeek Harness 源码仓库**执行，不是在任意外部插件仓库执行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm dsh web` 使用已经构建的仓库产物，不自动重新构建。Web 默认地址为 `http://127.0.0.1:3080`；实际向模型发请求需要对应凭据。参见 [官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md#run-from-source)。

核对时上游 `package.json` 要求 Node.js `^22.19.0 || >=24.0.0`，包管理器为 pnpm `11.7.0`；后续应读取所用 checkout 自己的声明。参见 [上游 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json)。

### 2.2 不调用模型的 Cordis 学习路线

在已安装依赖的上游仓库创建独立练习目录：

```sh
mkdir -p tmp/cordis-tutorial
cd tmp/cordis-tutorial
node --import tsx ../../vendor/cordis/bin.js
```

先创建后文的 `cordis.yml` 和插件，再运行最后一条命令。此 launcher 创建根 Context、挂载 Loader，读取当前目录的 `cordis.yml`；`tsx` 允许加载 TypeScript。七章教程全部可以无 API key 运行。参见 [Cordis 教程总览](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/)。

## 3. 第一个可配置工具插件

在上游仓库根目录创建 `scratch-plugin/src/hello.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'example-welcome'
export const inject = ['tools']

export interface Config {
  prefix: string
}

export const Config: Schema<Config> = Schema.object({
  prefix: Schema.string().default('欢迎'),
})

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'welcome_person',
    description: '按姓名生成一句欢迎语。',
    parameters: {
      person: { type: 'string', required: true, description: '姓名' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const person = args.person.trim()
      if (!person) throw new Error('姓名不能为空')
      return `${config.prefix}，${person}。`
    },
  }))
}
```

这个例子把输入、业务值、模型可见内容分开：DSL 推导并验证 `args`；`execute` 返回字符串；`output.render` 再生成内容块。空白姓名属于额外业务约束，由执行逻辑检查。参见 [Build a tool](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool)。

创建 `scratch-plugin/cordis.yml`，将占位路径替换为真实绝对路径：

```yaml
- insert:
    - id: example-welcome
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/hello.ts'
      config:
        prefix: '你好'
```

从上游仓库根目录运行：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

在界面中要求模型调用 `welcome_person`。这里的 YAML 是 **patch 操作列表**；第 2.2 节独立 launcher 的 YAML 则直接列插件行，例如 `- name: './hello.ts'`。本示例按 [Your first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) 使用绝对路径，避免解析基准的版本差异；阅读当日的 [master CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) 已说明插入行的相对插件路径按 patch 文件所在目录解析。不要将入门页的旧路径说明泛化到所有版本，详见第 13 节。

模块可导出 `apply`，也可采用带 `apply` 的对象或 `Service` 子类。直接 `ctx.plugin(fn)` 时函数本身就是插件。源码里的 `export const name` 是诊断名称，YAML 的 `name` 是模块路径或包名，工具定义的 `name` 是模型调用名称，三者用途不同。参见 [Cordis 第 1 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/01-first-plugin)。

## 4. 配置：类型、校验和加载时求值

导出同名 `Config` interface 和运行时 schema：前者供 TypeScript 使用，后者负责运行时检查和默认值。Cordis 接受 Standard Schema，官方入门使用 Schemastery；普通对象不能充当 schema。部署间需要调整的值应作为配置项，例如超时、端点、容量和开关。参见 [Plugin configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config)。

```yaml
- id: example-welcome
  name: './hello.ts'
  config:
    prefix: !!js process.env.WELCOME_PREFIX ?? '欢迎'
```

此处是独立 Cordis 项目的完整插件行。`!!js` 只在 `config` 和行的 `disabled` 中求值：前者在声明的依赖满足后针对插件 Context 求值，后者在每次挂载决策时针对 Loader Context 求值；不能据此动态生成 `name`、`id` 或 `inject`。参见 [Cordis 第 5 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/05-config) 与 [Loader 配置语义](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer#loader-configuration)。

实践建议：把字段自身约束放进 schema；涉及其他服务或注册资源的引用，在依赖可用后尽早解析并报错。让 README 的默认值与 schema 一致；测试无配置、合法覆盖、非法输入和配置替换。

## 5. 生命周期、资源清理与 HMR

Fiber 的主要状态为：

```text
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
             └──→ FAILED
```

`PENDING` 表示依赖未满足；加载或配置校验失败进入 `FAILED`。插件卸载会移除它拥有的注册并递归卸载子插件。`await fiber.dispose()` 等待异步清理完成。多个 disposer 虽按注册逆序开始调用，异步完成顺序没有串行保证。参见 [Plugins and lifecycle](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/)。

Cordis 管理的监听器、服务、工具和子插件已绑定 effect；原生定时器、连接、watcher 等外部资源需要显式托管：

```ts
ctx.effect(() => {
  const timer = setInterval(() => {
    // 执行轻量周期工作。
  }, 1000)
  return () => clearInterval(timer)
})
```

如果必须先停止受理、再排空工作、最后关闭连接，把这三个动作放进**同一个异步 disposer**，在内部依次 `await`。仅为定时器调用 `unref()` 不等于清理。参见 [Cordis 第 2 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/02-lifecycle-and-effects)。

独立练习项目可用以下完整配置启用 HMR：

```yaml
- id: logger
  name: '@deepseek-ai/cordis-plugin-logger-console'
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root: ['.']
- id: welcome
  name: './hello.ts'
```

该配置仅展示 HMR 组成；若 `hello.ts` 使用工具服务，还需加入第 11 节的服务依赖。HMR 缺少 timer 会停在 `PENDING`；console exporter 让诊断可见。给配置行稳定 `id`，否则重新读取配置可能把未变的行也视为删除后新增。配置和代码热替换都应释放旧注册；没有相应 watcher 的部署需重启。参见 [Cordis 第 6 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/06-composition-and-hmr) 与 [CLI 行为](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

## 6. 服务、依赖与能力分层

### 6.1 提供与消费

示例 `counter.ts` 提供一个进程内计数服务：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    exampleCounter: ExampleCounter
  }
}

export default class ExampleCounter extends Service {
  private count = 0

  constructor(ctx: Context) {
    super(ctx, 'exampleCounter')
  }

  increment(): number {
    return ++this.count
  }
}
```

消费者加载服务的类型声明，并声明运行时依赖：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from './counter.ts'

export const inject = ['exampleCounter']

export function apply(ctx: Context) {
  console.log(ctx.exampleCounter.increment())
}
```

`super(ctx, 'exampleCounter')` 完成运行时注册；声明合并不会注册任何实例。YAML 行启动可并发，交换 provider 和 consumer 的排列不应影响结果；只有 `inject` 保证必需能力可用。依赖消失会使消费者卸载，恢复后重载。可选能力在使用点通过 `ctx.get('...')` 探测，不应缓存为永久可用。参见 [Cordis 第 3 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/03-services)。

### 6.2 隔离与分层

group 可以作为一个插件子树装卸，`isolate` 可令不同组拥有同名服务的独立实例；组内同时配置相应 provider 和 consumer。此隔离是服务解析作用域，不能自动替代业务的用户鉴权。配置形式参见 [Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service#service-isolation)。

可替换能力采用三个角色：

| 角色 | 拥有什么 | 依赖方向 |
| --- | --- | --- |
| Service Definition | 服务接口、Request/Result、事件契约 | 不依赖具体 provider |
| Service Provider | 执行、存储、网络等实现 | 依赖 Definition |
| Consumer | 工具、UI 或其他业务入口 | 依赖 Definition，通过 `inject` 使用能力 |

例如 shell 定义、local bash 实现、bash 工具各司其职。Provider 与 Consumer 不直接依赖彼此；需要独立替换时再拆包。将默认值和请求规范化集中到显式的 `resolve(request)` 流程，可减少执行阶段隐含分支。参见 [Three-role capability design](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/)。

## 7. 事件：模式也是公共契约

事件通过 `declare module '@deepseek-ai/cordis'` 扩展 `Events` 声明签名，用 `ctx.on` 注册。选用派发方法前先查拥有该事件的 subsystem 文档：

| 模式 | 语义 | 常见用途 |
| --- | --- | --- |
| `emit` | 同步调用监听器，忽略返回值，不等待 Promise | 通知与观察 |
| `parallel` | 并发执行并等待全部监听器 | 可并行的异步通知 |
| `serial` | 顺序等待，遇到非 `null/false/undefined` 的返回值就停止 | 顺序决策 |
| `bail` | 同步短路，停止条件同 `serial` | 同步决策 |
| `waterfall` | 围绕 `next()` 包装下游，可返回替代结果 | 拦截与中间件 |

`0` 和空字符串也会触发 bail/serial 短路。Waterfall 的异步性取决于事件签名；观察或装饰行为需要调用并传递 `next()`，只有有意接管决策时才不调用。参见 [Cordis 第 4 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/04-events)。

尤其要区分运行时事件与持久日志：`agent/pre-step`、`tools/result` 是 Cordis 事件；`turn/*`、`step/*`、`tool/call`、`tool/result` 是 Session event 类型。观察后者应监听 `session/event` 再检查 `event.type`，不能直接把日志类型当成 Cordis 事件名。完整签名以生成的 `cordis-surface` 区域为准。参见 [Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events)。

## 8. 工具开发的完整契约

### 8.1 输入、业务值与错误

`defineTool` 支持嵌套 object/array、标量、null、literal 和 exact-one union。显式 object 必须声明 `additionalProperties`，隐式参数根保持开放；非空、正数、跨字段等 DSL 未表达的条件由业务检查。直接注册原始 JSON Schema 工具时，作者负责自身输入校验。参见 [工具编写参考](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool)。

| 边界 | 作者责任 |
| --- | --- |
| 工具定义 | 注册后视为只读；替换时释放旧注册并重新注册 |
| `args` / `exec` | 将参数和执行身份视为只读；权限从受信任执行上下文取得 |
| `execute` | 返回符合 `output.schema` 的无损 JSON 值 |
| `output.render` | 将规范值投影为模型可见内容 |
| 异常 | 基础设施失败抛错；正常业务结果用有类型的数据表示 |
| 取消 | 前台工作必须响应 `exec.signal` |

运行时校验并冻结规范值；执行、schema、render 等失败被收敛为错误结果。一次工具失败通常不终止整个 turn。参数和 schema 都不是授权机制。参见 [dsh-tools 包参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)。

### 8.2 策略与观察放在哪一层

| 扩展点 | 使用场景 |
| --- | --- |
| `tools/pre-execute` | 可组合的 allow / deny / ask 决策 |
| `ctx.tools.guard()` | 后续插件不能推翻的最终拒绝 |
| `tools/execute` | 包装执行，施加超时、重试或度量 |
| `tools/post-execute` | 明确替换 content/value、阻断结果或附加上下文 |
| `tools/result` | 观察最终规范化且不可变的结果 |

仅替换展示 `content` 不会隐藏程序仍能取得的 `value`；保密策略需要处理规范值本身。只读审计应使用最终结果事件。工具筛选优先用 `ctx.tools.restrict()`，使可见 schema、查找和执行保持一致。参见 [dsh-tools 执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md) 与 [扩展模式](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/extension-cookbook)。

### 8.3 PTC、后台任务与展示

PTC（Programmatic Tool Calling，程序化工具调用）下可见工具自动成为 `await tools.<name>(args)`；成功返回策略处理后的规范值，失败抛 `ToolCallError`。不要让程序从展示文案解析 ID；PTC 中间值并不因模型输出限制而自动缩小，生产者仍需限制数据获取规模。参见 [工具参考的 PTC 章节](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool#ptc-mode-reaches-your-tool-for-free)。

长任务交给 `ctx.jobs.start({ kind, label, owner: exec.agent, run })`，返回结构化 job handle。需装配 jobs provider 与控制器，运行时在开始工作前校验；后台能力还应由生产者配置启用。Producer 提供同步 `cancel`、清理完成才结算且不 reject 的 `done`，以及可选有界输出读取。任务 ID 发布后使用任务自己的取消生命周期，由 kill、owner 释放或服务卸载结束；此前的前台调用仍受 `exec.signal` 控制。参见 [后台任务运行时契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md)。

展示分三路：规范 JSON 供程序，`output.render` 供模型，`presentationMeta` 与 presenter 供可回放 UI。Presenter 必须纯粹，不能依赖 I/O、时钟或实时 Session。Host 的 `presentCall/presentResult` 不会自动创建内建 Web 专用卡片；Web 使用 Client 的 `tool.call.toolview` 插槽，读取持久事件及 metadata。参见 [工具参考的 UI 章节](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool#how-your-tool-renders-in-a-ui)。

## 9. LLM 适配器：协议转换和能力解析

适配器继承 `LlmAdapter`，实现 `stream(options): AsyncIterable<StreamChunk>`，声明 `inject = ['llm']`，通过 `ctx.llm.registerAdapter(providerNames, adapter)` 注册。Provider 决定路由，model 是该适配器解释的模型 ID；`listModels()` 可提供候选目录。参见 [LLM adapters](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/llm-adapter)。

实现清单：

1. 以 `GenerateOptions` 导出类型映射消息、system、工具、参数和取消信号；不能兑现的选项明确报 `LlmError`，不要静默丢弃。
2. 每个 block 分配首次出现顺序的 index；`block-start` 与携带完整内容的 `block-end` 配对，中间发送 delta。
3. 工具参数以原始 JSON 字符串传递；增量使用 `argumentsDelta`。
4. 先发送 usage，最后发送 finish；finish 之后不再产出 chunk。
5. HTTP 请求合并 `attributionHeaders()` 并传递 `options.signal`；传输与协议错误使用稳定错误码。
6. `resolveModel(provider, model, signal?)` 返回精确身份及可选 context/reasoning 信息；推理档位由适配器定义，不硬编码成核心枚举。

这些是流与模型能力的基本要求。参见 [适配器教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/llm-adapter)。

进一步要处理供应商尾部 usage、流内 error/aborted，以及后续请求需要的原生回放状态。必要时通过 `finish.replayState` 输出最小无损 JSON 并在恢复时验证；运行时只向拥有相应历史/目标路由的同一 adapter 实例传递状态，具体跨模型恢复是否合法仍由 adapter 决定。参见 [Adding an LLM adapter](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-an-llm-adapter)。

实践建议：把 wire 类型、请求序列化、传输解析、chunk 转换和适配器类分开；覆盖文本、工具调用、分片 JSON、取消、异常结束、usage 顺序、未知模型及不支持的参数。参考上游 `llm-deepseek` 和 `llm-pi-ai` 两种实现，避免把一家的协议细节提升为公共假设。

## 10. 打包、安装与配置组合

### 10.1 Bundle 与 profile

Bundle 是携带配置层的 npm 包，声明 `dsh.bundle`；profile 是某个可运行组合，位于 `$DSH_HOME/profiles/<name>`，声明有序 `dsh.profile.bundles`。两者不能混为一谈。未声明 bundle 的包可以安装成依赖，但不会自动激活配置层。参见 [Package and install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)。

以下是发布清单骨架；依赖和构建脚本需按实现补齐，并在打包前生成 JS 与声明文件：

```json
{
  "name": "dsh-example-welcome",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    }
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

包内 `cordis.patch.yml` 使用可安装的包名：

```yaml
- insert:
    - id: example-welcome
      name: dsh-example-welcome
```

使用已安装 CLI，从包含本地包目录的位置运行：

```sh
dsh plugin --profile demo add ./dsh-example-welcome
dsh --profile demo --dump-config
dsh --profile demo
dsh plugin --profile demo remove dsh-example-welcome
```

`--dump-config` 检查组合，不启动应用。首次通过 plugin 命令创建的是 base-backed profile，不能假设它自带 Web；Web 联调可以安装到 `web` profile，或按 CLI 文档从 Web template 初始化自定义 profile。上游 checkout 中使用 `pnpm dsh ...`。参见 [安装教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) 与 [CLI profile 规则](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

### 10.2 配置层优先级

配置从空根开始，按下列次序应用：

```text
profile.bundles 的有序 bundle patches
  → profile 自己的 cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml
  → 命令行 --patch，按参数顺序
```

后层覆盖前层的目标行；覆盖 `config` 时替换整个值，不深合并。比如只写 `{ timeoutMs: 1000 }` 可能同时丢失原行的 endpoint。注意：配置层顺序决定最终配置，插件行顺序不保证启动先后。参见 [CLI 配置组合](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

应用专属命令行也不是额外 patch 层：普通插件注入 `cmdlineArgs`、用 `parseCmdline` 解析不可变参数并提供启动服务；消费行注入该服务，在 `!!js` 中取启动值与部署 fallback。Launcher flags 必须位于应用参数之前。参见 [安装教程的 surface bundle 部分](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish#give-a-surface-bundle-its-own-command-line)。

### 10.3 发布路径与构建陷阱

Registry 或 tarball 应包含已构建入口、类型及 patch；Git 安装则需自包含的 `prepare` 构建，不能依赖作者机器上的相邻 monorepo。pnpm 的构建授权可能阻止 Git dependency 的 prepare，按实际提示在 profile 的 `pnpm-workspace.yaml` 配置对应 `allowBuilds` 项；允许构建会执行包代码，可固定可信 commit。参见 [Git 安装注意事项](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish#installing-from-github-the-build-script-catch)。

实践建议：从打出的 tarball 在干净 profile 安装一次，验证每个 exports 入口、声明文件及配置层。不要用开发仓库的路径可见性来证明发布包完整。

## 11. 测试与验收：先证明组合可运行

### 11.1 无模型的真实工具管线

独立 Cordis 教程可挂载真实服务，不需要为了注册和调用工具访问模型：

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: welcome
  name: './hello.ts'
```

`tools` 自己依赖 `systemPrompt`，漏掉 provider 会让依赖链一起停在 `PENDING`。调用测试应走 `ctx.tools.execute`，传入 branded `ToolCallId`、工具名、参数和 `AbortSignal`；这才能覆盖校验、策略、渲染与 `tools/result`。直接调用业务函数只能证明业务逻辑。参见 [Cordis 第 7 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/07-into-the-harness)。

### 11.2 实践建议：按边界分配测试

| 层次 | 至少验证什么 |
| --- | --- |
| 纯逻辑 | 请求规范化、边界值、业务结果 |
| 配置 | 默认值、非法值、不存在的资源引用 |
| 工具 | 输入拒绝、规范值、异常、render、取消、策略 |
| 生命周期 | 卸载清理、重复装载、依赖丢失与恢复、排空 |
| 真实 Loader | patch、exports、模块解析、服务装配 |
| 持久化插件 | 写入后关闭，冷启动读取，隔离和迁移 |
| 模型适配 | 协议序列、请求映射、错误与 AbortSignal |
| UI | 实时展示、日志回放、旧数据回退 |
| 交付 | tarball 在干净环境安装后仍可启动 |

本仓库代码变更按 [AGENTS.md](../AGENTS.md) 至少运行 `pnpm typecheck`、`pnpm test`、`pnpm build`，并遵循规定的评审与验收门。其他项目按自己的脚本和测试政策执行；上述三条不是所有 Harness 插件都自动具备的通用命令。

真实外部模型测试只在验证适配器或网络接缝需要时进行；普通工具与生命周期测试可保持离线。本文提供的是文档与示例，没有声称已完成对当前上游完整应用或真实供应商的运行验收。

## 12. 常见故障排查

| 现象 | 优先检查 |
| --- | --- |
| 插件无日志、无报错 | Fiber 是否 PENDING；`inject` 是否有 provider；模块名是否正确 |
| HMR 没反应 | timer、console logger、HMR 插件、root 与 launcher 是否正确 |
| 改一处配置导致大量重载 | 各行是否有稳定 `id` |
| 工具不可见 | 注册插件是否 ACTIVE；`tools/systemPrompt` 依赖及 Agent 工具限制 |
| 参数看似有效但执行失败 | DSL 外业务约束、返回值 schema、render 和取消状态 |
| 改完 config 丢了其他字段 | patch 替换了整行 config |
| 本地可运行，安装后找不到模块 | 产物是否在 tarball；exports/files 是否一致；Git prepare 是否完成 |
| 卸载后仍有工作或重复事件 | 原生资源是否托管 effect；异步清理是否正确等待 |
| 中间件加入后核心行为消失 | waterfall 是否遗漏 `next()` |
| UI 重启后卡片数据缺失 | 是否依赖实时状态；需要的数据是否进入 presentationMeta |

运行时可枚举 `ctx.registry.values()` 中各 runtime 的 `fibers` 检查状态。独立 Cordis launcher 中，缺依赖可能静默等待甚至随事件循环空闲而退出；不能仅凭退出码 0 判断所有插件都已加载。产品 `dsh` 的错误处理则按 CLI 文档核对，不应混用两个 launcher 的诊断行为。参见 [Cordis 第 6 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/06-composition-and-hmr)、[第 1 章](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/01-first-plugin) 与 [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

## 13. 文档差异与进阶入口

### 13.1 阅读时实际发现的差异

| 主题 | 官方页面之间的差异 | 本指南采用方式 |
| --- | --- | --- |
| Web overlay 源码路径 | basic 首节要求绝对路径且描述 profile 解析基准，config 节示例出现相对路径；master CLI reference 已说明插入行相对路径按 patch 文件解析 | 示例统一使用绝对路径；使用相对路径时按目标版本核对，不能把 basic 规则当成跨版本定律 |
| Waterfall 的 `next()` | framework 页措辞强调必须调用，七章教程解释有意短路 | 观察/装饰必须传递；接管决策可有意短路 |
| Runtime Cordis tools | 网站描述内存中挂载/卸载模型编写的插件；所链接仓库 master README 描述只读检查 | 不承诺当前安装版本有临时执行能力；先查该版本工具目录 |

路径与事件差异分别可对照 [basic](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)、[config](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config)、[master CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)、[framework events](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events) 与 [Cordis events](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/04-events)。

网站 [Runtime Cordis tools](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/dynamic-cordis) 所述临时插件会随进程结束消失，而且可能影响同进程其他 Session。阅读当日的 [tool-cordis README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/extensions/tool-cordis/README.md) 则只列 `cordis_inspect_list` 与 `cordis_inspect_query`，用于发现和检查 Host/Client API；需要 `cordisInspect`，Client 查询还需要连接的页面。该版本的持久安装交给 Plugin Manager，检查工具不执行代码或修改配置。这两组能力不应合并成一份“当前 API”。

### 13.2 超出基础工具的扩展

UI 通常消费 `agent/assistant-stream` 展示临时 token，消费 `session/event` 展示可回放结果；输入走 Agent 的 `followup/steer`。`agent.inject` 加入下一次请求可见的持久上下文，并不唤醒 idle Agent。协议驱动还需拥有 Agent 的创建、恢复、退出及传输职责，不能把入队回执等同于本轮最终答案。参见 [扩展模式](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/extension-cookbook) 与 [工具通知约定](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool)。

向上游 monorepo 增包时，还应遵循 package cookbook 的目录、导出、构建和文档规范；README 说明 API、配置、事件以及模型实际看到什么、token 与 KV cache 的影响。外部 bundle 不应机械复制上游 workspace 专属依赖方式。参见 [Adding a workspace package](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-package)。

对本项目而言，`src/index.ts` 提供 memory 能力，`src/tool.ts` 是可选的模型消费者，`cordis.patch.yml` 负责装配，Loader 冷重启测试覆盖交付与恢复。其 owner 隔离、raw-first、证据演进等属于本插件自己的契约，应同时阅读 [设计文档](design.zh.md) 与 [开发约束](../AGENTS.md)，不能由通用教程替代。

## 14. Next steps 阅读覆盖索引

下面保留完整开发主线，便于按原文复查。各主题前面的正文链接提供进一步的 API reference。

| 官方阅读路径 | 本指南对应内容 |
| --- | --- |
| [Your first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) | 环境、插件入口、Web overlay |
| [Build a tool](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool) | 工具最小示例、输入输出 |
| [Plugin configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config) | Config、schema、配置替换 |
| [Package and install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) | Bundle、profile、CLI、Git 安装 |
| [Plugins and lifecycle](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/) | Fiber、effect、卸载 |
| [Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service) | 服务提供、注入与隔离 |
| [Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events) | 派发契约、Session 区别 |
| [Capability layering](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/) | Definition / Provider / Consumer |
| [LLM adapters](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/llm-adapter) | 流协议、模型能力、错误 |
| [Runtime Cordis tools](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/dynamic-cordis) | 临时扩展与只读检查的版本差异 |
| [Cordis overview](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/) | 无 key 练习路径 |
| [01 First plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/01-first-plugin) | 模块形式、名字、加载诊断 |
| [02 Lifecycle and effects](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/02-lifecycle-and-effects) | 子插件、外部资源、异步清理 |
| [03 Services](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/03-services) | 声明合并、依赖驱动 |
| [04 Events](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/04-events) | 五种派发模式、waterfall |
| [05 Configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/05-config) | 校验失败、`!!js` |
| [06 Composition and HMR](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/06-composition-and-hmr) | id、disabled、HMR、PENDING |
| [07 Into the harness](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/07-into-the-harness) | 无模型真实工具管线 |

后续查找某个服务或事件的准确名称与签名，从官方 [Subsystems](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/) 进入所属页面的生成目录，并对照目标版本类型；不要维护一份脱离版本的全部服务静态清单。
