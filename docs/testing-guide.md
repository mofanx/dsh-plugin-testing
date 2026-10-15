# DSH 插件测试基建 · 团队接入指南

| 元信息 | 值 |
|---|---|
| 读者 | 基于 DSH 开发插件的各团队 |
| 维护 | 测试负责人 |
| 代码位置 | `packages/testkit/`（测试工具包）+ `packages/conformance/`（静态门禁）（本仓库） |
| 本文档角色 | 团队交付面唯一入口：只含抽象后的通用方法与工具用法 |

---

## 一、你拿到什么

| 交付物 | 形态 | 一句话 |
|---|---|---|
| `packages/testkit` | 测试工具包（**非插件**） | 隔离测试 home、keyless 模型回放、组合测试引导 —— 在独立进程里用真实启动器跑你的插件 |
| `packages/conformance` | 静态门禁 CLI | 清单 / 组合装载 / 版本契约三类静态检查（`DSH-C0xx` 错误码），PR 前一条命令 |
| `api-baseline.json` | 数据 | 宿主安装树的真实导出面快照（包 / 子路径 / 符号），供 API 用量核对 |
| 本指南 | 文档 | 方法论 + 契约 + 实测沉淀的陷阱清单 |

**总原则（为什么长这样）**：插件的被测对象很多时候是"模型的行为"，不是纯函数。所以测试分两条车道 —— **keyless**（mock/回放，进 PR 门禁，确定性）与 **with-key**（真模型，夜间 / eval，不阻塞 PR）；非确定性通过"录制一次 → 回放无限次"固化成资产。

---

## 二、新插件接入：三步

### 第 1 步 · 自有诊断通道（团队契约 C4）

**禁止**依赖 `@deepseek-ai/dsh-invariants`、`ctx.invariants`、`<pkg>/invariant` —— 该 API 在 `0.2.1` 线已移除，引用它的 patch 无法加载。插件自建结构化诊断（日志 / 事件 / 错误标记），诊断默认关闭、不进模型输入；测试期用**探针夹具**（一个只读状态、断言后退出的小组合）承载断言。

### 第 2 步 · 三行组合测试（真实启动）

进程内 `ctx.plugin(...)` 套件**不充分**（DSH doctrine 明文）—— 产品可见插件必须有真实组合测试。用 testkit 起一个一次性 home：

```js
import { createTestHome, testHomeArgs, testHomeEnv } from 'packages/testkit'

const home = createTestHome({
  bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '<你的 bundle 包>'],
  packages: ['@deepseek-ai/dsh-llm-replay'],   // 测试支撑包：从本包依赖链入 profile
  links: { '<你的插件包名>': '<绝对路径>' },      // 被测插件按绝对路径链接
})
// spawn(启动器, testHomeArgs(home, { task }), { env: testHomeEnv(home.homeDir, process.env) })
// 断言「世界」而非自我报告：事件流中的真实效果 / 落盘状态 / 退出码
```

实测确立的两项关键事实：**① 隔离 home 不需要 node_modules**（bundle 由安装解析，隔离成本 ≈ 0）；**② 隔离 home 必然没有凭据**（跑到模型调用处报 `MISSING_CREDENTIAL` 是隔离在起作用，不是缺陷）。组合测试若依赖模型，用第四节的回放车道实现 keyless。

### 第 3 步 · CI 门禁（一条命令）

```bash
node packages/conformance/src/run-all.mjs --config 你的配置.json            # error 阻断
node packages/conformance/src/run-all.mjs --config 你的配置.json --strict   # warn 也阻断（发布前）
```

配置从 `conformance.config.example.json` 复制，指向你的插件仓库与宿主安装目录。

---

## 三、静态门禁速查

| 规则组 | 覆盖 | 典型 error |
|---|---|---|
| 清单 / exports（C0xx 前段） | `dsh.bundle.patch` 存在性、`exports` 完整性、客户端声明 | 缺 `./package.json` 导出 |
| 组合装载（`DSH-C050…C056`） | 把宿主包放进 `dependencies` 的遮蔽模式 | 宿主**核心包**被遮蔽（error）；工具包重复安装（warn） |
| 版本 / peer（`DSH-C060…C066`） | peer 范围 vs 宿主实际版本、豁免有效性 | `C060` belowMin / `C064` 不满足且无豁免 |

- **判级取决于"是否被挂载"**：宿主只对它将要 import 的**行**做版本预检。不满足的 peer 在被挂载为 profile 行的包上是 error（宿主会真的禁用它），在从不挂载的支撑包上只是 warn。
- **退出码**：`0` 通过；`1` 有 error（`--strict` 下 warn 也算）；`2` 用法错误 / 无检查目标。
- error/warn 分级是有意的：`DSH-C030`（缺 `engines.dsh`）这类不阻断运行的问题不卡 PR，但发布前必须清零。

**peer 范围怎么写（实测教训，见第六节第 1 条）**：范围必须覆盖你要支持的每一条宿主线；跨预发布线时单一范围做不到，用并集。

---

## 四、keyless 回放车道（模型交互回归的确定性复现）

**录制一次（with-key），回放无限次（keyless）。** 模型侧回放固定脚本，工具侧**真实重跑** —— 回放的断言因此仍然验证世界。

```
录制（夜间/手动，花一次真实回合）
  一次性 profile（隔离 home + 被测插件链接 + 真实模型路由）
  + 会话持久化: { root: './.sessions', compression: none }   ← 收割原始会话日志
        │
        ▼
  <root>/.sessions/<会话目录>/session.v4.jsonl                 ← 回放 fixture
        │
回放（keyless，秒级，进 PR）
  testkit replayPatch: 禁 llm-deepseek、挂 dsh-llm-replay、按序供给录制流
  + 禁 session-title-llm（否则标题器抢消费脚本条目）
        │
        ▼
  断言：工具调用重放 + 工具重跑结果与录制一致 + turn completed
```

**操作要点（每条都实测踩过）**：

1. **peer 预发布元组规则**：SemVer 预发布只被同元组比较器接纳。宿主 `0.2.0-rc.x` 与源码线 `0.2.1-alpha.x` 分属两个元组，单一范围无法同时覆盖 —— 跨线支持用并集 `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-alpha.2 <0.3.0`（运行时预检已实测接受 `||`）。
2. **`compatibility.json` 豁免键必须是全精确版本**（`@0.1.0-alpha.1`，不是 `@0.1.0`），否则静默失效。
3. **patch 行相对路径以 patch 文件所在目录为基准**（宿主仓库 `cordis.patch.yml` 注释原文），不是仓库根 / cwd。
4. **裸 `--json` 必须保留 `headless-runner`**：禁用它的 home 会让 `--json` **挂起而非退出**。
5. **会话世代 v4**：当前线写 `session.v4.jsonl`；llm-replay 按 fixture 中 **`request/header` 行数**建脚本，按首调顺序供给。
6. **回放 home 必须禁 `session-title-llm`**，否则标题器抢消费唯一的脚本条目，回合反而无脚本可用。
7. **`@deepseek-ai/dsh-llm-replay` 不在宿主安装树**：必须用 testkit 的 `packages` 从测试包自身依赖链入 profile，否则行挂上了但 `failed to import`。
8. **回合模型路由由 `agent-default-model` 决定**，只覆盖 `agent-loop` 不生效；回放侧用默认路由即可（回放按调用顺序供给录制流，录制时用的 provider 与回放无关）。
9. **凭证规则**：永不读取 / 复制 / 记录密钥。with-key 车辆在真实 `$DSH_HOME` 下用**一次性专用 profile**运行，让凭证服务自行解析引用；keyless 断言 `MISSING_CREDENTIAL` 存在（证明隔离生效）。

---

## 五、团队契约 v1（C1–C5）

> 变更走测试负责人的台账 §三 修订并通知全体。

- **C1 清单契约**：`dsh.bundle.patch` 必填且指向文件存在；`exports` 必含 `.` / `./package.json`（声明 bundle 时另需 `./cordis.patch.yml`）；有客户端半边时 `dsh.client.platform` **必填**，`inject` **可选且为信息性字段**（非 Cordis 服务注入）。
- **C2 依赖形态**：**禁止**把 `@deepseek-ai/dsh-*` / `@deepseek-ai/cordis` 放入普通 `dependencies`（版本遮蔽故障模式，工具调用直接死）；必须 `peerDependencies`。
- **C3 peer 范围策略**：明确写法约定 + DSH 升级时由谁负责放宽。
- **C4 诊断契约**：**禁止**依赖 invariants（已移除）。插件自建诊断通道，由测试期探针夹具承载断言，诊断默认关闭、不加模型输入。
- **C5 静态错误码**：CI 报告与豁免说明统一引用 `DSH-C0xx` 错误码。

---

## 六、边界与分工

- **静态导入扫描 ≠ 运行时属性访问**：`check-plugin-imports.mjs` 只核对模块导出；`ctx.llm.*` / `ctx.tools.*` 的运行时面必须由真实启动（组合测试）覆盖。
- **工具的外部依赖路径**（外部引擎 / 客户端桥）属于活体验证范畴，回放车道只覆盖确定性路径。
- **evals（模型行为评测维度）**：统计指标，**不阻塞 PR**；夜间车道跑。
- **UI**：交给 Playwright，不用插件测 UI。
- 工具的历史变更见 [`docs/CHANGELOG.md`](CHANGELOG.md)（团队可见）；完整决策史由测试负责人个人维护，需查阅时向其索取。

---

## 七、配套模板

| 模板 | 用途 | 节奏 |
|---|---|---|
| `templates/plugin-health-card-template.md` | **插件体检卡**：单插件单次扫描的一页报告（总评红绿 / 逐条错误码 / 冒烟证据 / 已验证修复 diff） | 插件接入时、每次扫描 |
| `templates/plugin-host-matrix-template.md` | **插件 × 宿主兼容性矩阵**：回答"这次宿主升级谁会碎、要先合什么" | 随宿主版本节奏定期 |

两者均由测试负责人填写交付；团队侧零操作。开发侧唯一的主动项是把门禁挂进 CI（一条命令，见 §二第 3 步）。
