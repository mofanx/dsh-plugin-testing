# DSH 插件测试基建 · 团队接入指南

| 元信息 | 值 |
|---|---|
| 读者 | 基于 DSH 开发插件的各团队 |
| 维护 | 测试负责人 |
| 代码位置 | `packages/testkit/`（测试工具包）+ `packages/conformance/`（静态门禁）（本仓库） |
| 本文档角色 | 团队交付面唯一入口：只含抽象后的通用方法与工具用法 |
| 非技术读者 | 转给产品 / 项目经理看 [`overview.md`](overview.md)（一页看懂，无需技术背景） |
| CI 真实宿主 | 集成用例的环境变量与版本影响见 [`ci-real-host.md`](ci-real-host.md) |

---

## 一、你拿到什么

| 交付物 | 形态 | 一句话 |
|---|---|---|
| `packages/testkit` | 测试工具包（**非插件**） | 隔离测试 home、keyless 模型回放、**运行时激活探针**、组合测试引导 —— 在独立进程里用真实启动器跑你的插件 |
| `packages/conformance` | 静态门禁 CLI | 清单 / 组合装载 / 版本契约三类静态检查（`DSH-C0xx` 错误码），PR 前一条命令 |
| `api-baseline.json` | 数据 | 宿主安装树的真实导出面快照（包 / 子路径 / 符号），供 API 用量核对 |
| 本指南 | 文档 | 方法论 + 契约 + 实测沉淀的陷阱清单 |

**总原则（为什么长这样）**：插件的被测对象很多时候是"模型的行为"，不是纯函数。所以测试分两条车道 —— **keyless**（mock/回放，进 PR 门禁，确定性）与 **with-key**（真模型，夜间 / eval，不阻塞 PR）；非确定性通过"录制一次 → 回放无限次"固化成资产。

**版本锁定约定**：`testkit` 钉住的支持包版本 **= 目标宿主版本**。当前 `@deepseek-ai/dsh-llm-replay` 与 `@deepseek-ai/dsh-session-snapshot` 均为 `0.2.0-rc.2`（与打包桌面宿主一致）。宿主升级时**同步**升这两个支持包，否则回放 patch / 录制 fixture 的 session 世代可能对不上而悄悄失效。这条锁定写死在 `packages/testkit/package.json`，不随主仓源码线（`0.2.1-alpha.x`）自动漂移。

---

## 二、新插件接入：三步

### 第 1 步 · 自有诊断通道（团队契约 C4）

**禁止**依赖 `@deepseek-ai/dsh-invariants`、`ctx.invariants`、`<pkg>/invariant` —— 该 API 在 `0.2.1` 线已移除，引用它的 patch 无法加载。插件自建结构化诊断（日志 / 事件 / 错误标记），诊断默认关闭、不进模型输入；测试期用**探针夹具**（一个只读状态、断言后退出的小组合）承载断言。

### 第 2 步 · 三行组合测试（真实启动）

进程内 `ctx.plugin(...)` 套件**不充分**（DSH doctrine 明文）—— 产品可见插件必须有真实组合测试。用 testkit 起一个一次性 home：

```js
import { createTestHome, testHomeArgs, testHomeEnv } from '@deepseek-ai/dsh-plugin-testkit'
// 只用一半时用子路径：'@deepseek-ai/dsh-plugin-testkit/home' 或 '…/replay'

const home = createTestHome({
  bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '<你的 bundle 包>'],
  packages: ['@deepseek-ai/dsh-llm-replay'],   // 测试支撑包：从本包依赖链入 profile
  links: { '<你的插件包名>': '<绝对路径>' },      // 被测插件按绝对路径链接
})
// spawn(启动器, testHomeArgs(home, { task }), { env: testHomeEnv(home.homeDir, process.env) })
// 断言「世界」而非自我报告：事件流中的真实效果 / 落盘状态 / 退出码
```

实测确立的两项关键事实：**① 隔离 home 不需要 node_modules**（bundle 由安装解析，隔离成本 ≈ 0）；**② 隔离 home 必然没有凭据**（跑到模型调用处报 `MISSING_CREDENTIAL` 是隔离在起作用，不是缺陷）。组合测试若依赖模型，用第四节的回放车道实现 keyless。

### 第 3 步 · CI 门禁（两条车道：静态 + 运行时）

**车道 A —— 静态门禁**（读文件，快，不需要宿主启动）：

```bash
node packages/conformance/src/run-all.mjs --config 你的配置.json            # error 阻断
node packages/conformance/src/run-all.mjs --config 你的配置.json --strict   # warn 也阻断（发布前）
```

配置从 `conformance.config.example.json` 复制，指向你的插件仓库与宿主安装目录。

**车道 B —— 运行时激活探针**（真实启动一次，回答"宿主到底有没有禁用这一行"）：

```bash
dsh-plugin-activate \
  --packages "<你的插件仓库>/packages/*" \
  --bundle <你的 bundle 包名> \
  --expect-active <你的插件包名>
```

两条车道**不可互相替代**，原因是一条实测事实：**`--dump-config` 不跑兼容性预检** —— 一个 peer 不兼容的行会原样出现在 dump 里，既没有 `disabled: true` 也没有任何诊断。也就是说，只看配置组合的检查会**恰好对这条车道要抓的用例报告成功**。

| | 车道 A 静态门禁 | 车道 B 运行时探针 |
|---|---|---|
| 依据 | manifest / lockfile / profile 文件 | 真实 boot 的 stderr 诊断 |
| 能发现 | peer 范围写错、缺 `engines.dsh`、`dependencies` 混入核心包、豁免失效 | **运行时是否真的禁用了这一行**、启动失败、等待服务、loader 抛错 |
| 不能发现 | 运行时是否真的放行 | 范围写法是否会在**安装期**被 npm/pnpm 拒绝（探针不跑安装） |
| 成本 | 毫秒级、无依赖 | 一次启动（秒级），**不需要凭据与外部服务** |

探针**不需要模型凭据**：预检在第一次模型调用之前执行，所以隔离 home 会稳定终止于 `MISSING_CREDENTIAL` —— 走到这一步本身就是"启动已越过预检"的证据。探针据此主动清理凭据环境变量，避免一次"通过"偷偷依赖真实模型调用。

**让探针自证**：`--expect-disabled <行 id 或包名>` 断言某行**必须**被禁用，用来证明探针真的挂上了被测包、而不是在空跑。仓库内 `fixtures/sample-plugin` 与 `fixtures/incompatible-plugin` **只差一个 peer 范围**，构成受控实验。

---

## 三、静态门禁速查

| 规则组 | 覆盖 | 典型 error |
|---|---|---|
| 清单 / exports（C0xx 前段） | `dsh.bundle.patch` 存在性、`exports` 完整性、客户端声明 | 缺 `./package.json` 导出 |
| 组合装载（`DSH-C050…C056`） | 把宿主包放进 `dependencies` 的遮蔽模式 | 宿主**核心包**被遮蔽（error）；工具包重复安装（warn） |
| 版本 / peer（`DSH-C057`、`DSH-C060…C067`） | peer 范围 vs 宿主实际版本、豁免有效性、cordis 系、**安装期 semver 维度** | `C060` belowMin / `C064` 不满足且无豁免 / `C067` 只有运行时接受 |
| 宿主版本矩阵（`DSH-C068`） | 给一份已发布版本清单，推导**声明覆盖集**；区间内的空洞、逐候选的安装期分歧 | 区间内的已发布版本不被接纳（`C068`） |
| 宿主 API 按版本可用性（`DSH-C069`） | 代码真正 import 的包/子路径/具名符号，在覆盖区间内每个版本上还在不在 | 覆盖版本里子路径或符号已消失（`C069`） |
| 门禁自身配置（`DSH-C070`、`DSH-C071`） | 配置声明的路径是否存在、目标模式是否真的匹配到东西 | 宿主路径写错（`C070`）/ 目标模式落空（`C071`） |

- **判级取决于"是否被挂载"**：宿主只对它将要 import 的**行**做版本预检。不满足的 peer 在被挂载为 profile 行的包上是 error（宿主会真的禁用它），在从不挂载的支撑包上只是 warn。
- **退出码**：`0` 通过；`1` 有 error（`--strict` 下 warn 也算）；`2` 用法错误 / 无检查目标。
- **"没查"绝不等于"通过"**：`C070`/`C071` 专门防这一类虚假绿灯 —— 宿主 / `DSH_HOME` / 豁免文件**显式配了却不存在**时报 `C070`（否则依赖它的版本检查会整体静默跳过），目标模式**一个都没匹配到**时报 `C071`。全部目标落空时 CLI 以 **exit 2** 退出并逐个打印未匹配的模式。路径改名 / 盘符变化 / 配置复制粘贴出错都会立刻变红。
- error/warn 分级是有意的：`DSH-C030`（缺 `engines.dsh`）这类不阻断运行的问题不卡 PR，但发布前必须清零。
- **移除 API 数据表**（`packages/conformance/removed-apis.json`）：宿主随版本移除的 API（当前：`./invariant` 子路径）**不硬编码进规则**。`DSH-C044` 读表匹配，并按宿主版本分级——未指定宿主 → error；宿主早于 `removedIn` → warn；达/过 → error。**未来新增同类移除，只在表里追加一条数据，零代码改动**（表正确性由测试用 `api-baseline.json` 交叉验证兜底）。

- **patch 里用 `group: true` 分组是合法写法**：载体（boot 解析为内建 `cordis:group`）**本来就没有模块名**，门禁不会因此报 `C053`（这类误报已修并有用例钉住）。被它包住的**子行**仍按普通行核对 —— 子行引用了没装的包照样报 `C053`；`group` 标了 `disabled: true` 时，其子行不再被视为已挂载。

  **peer 范围怎么写（实测教训，见第六节第 1 条）**：范围必须覆盖你要支持的每一条宿主线，**而且要同时通过两种 semver 语义** —— 运行时预检用 `includePrerelease: true`，npm/pnpm 安装期用裸 semver。**推荐写并集** `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-alpha.1 <0.3.0`。单范围 `>=0.2.0-rc.2 <0.3.0` 虽然运行时放行，但**安装期会拒绝 `0.2.1-alpha.1`**（源码线开发流程会看到 peer 不满足）。

  > **并集的第二个下界必须"刚好"落在该元组已发布的最小预发布版本上。** 这是 2026-10-16 由宿主版本矩阵（`DSH-C068`）在真实插件上抓到的：`>=0.2.0-rc.2 <0.3.0` 看起来覆盖整个 `0.2.x`，但它的比较器带的是 **`0.2.0`** 预发布元组，所以对 **`0.2.1`** 元组的预发布版本，裸 semver **永远**拒绝它 —— 范围再宽也没用。于是第二个子句写成 `>=0.2.1-alpha.2` 就会**静默漏掉 `alpha.1`**：那版用户运行时能加载、却**装不上**（npm 报 peer 不满足）。本仓库文档此前推荐的正是 `alpha.2` 这个写法，现已修正。写完后用宿主矩阵核一遍覆盖集，别靠眼看。

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

1. **peer 预发布准入**：运行时预检用 `semver.satisfies(..., { includePrerelease: true })`（`dsh-app-boot/lib/index.js:300`，预发布宿主版本无条件参与匹配），因此**单范围** `>=0.2.0-rc.2 <0.3.0` 在**运行时**即可同时覆盖 `0.2.0-rc.x` 与 `0.2.1-alpha.x` 两条线。**但推荐仍写并集** `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-alpha.2 <0.3.0` —— 运行时同样接受 `||`，且它在 **npm/pnpm 安装期的裸 semver** 下也成立（单范围在那一维会拒绝 `0.2.1-alpha.2`，源码线开发流程会看到 peer 不满足）。**不要**只写 `>=0.2.1-alpha.2 <0.3.0` —— 它会遗漏 `0.2.0-rc.x` 线，触发 `C060`（belowMin）。检查器只建模运行时那一维，所以它**不会**替你发现安装期问题。
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
- **C3 peer 范围策略**：**禁止跨主版本大范围** —— 含**单侧无界**（`>=1.0.0`、`<2.0.0` 都算，因为开放侧隐含宣称了未来**全部** major）；要覆盖多条宿主线就写**逐 major 显式并集**（`>=1.0.0 <2.0.0 || >=2.0.0 <3.0.0`）。**该规则不对内部实验插件放宽**（§7 已定）：用"放宽规则"解决临时问题会让豁免机制形同虚设。**豁免的真实效力（2026-10-15 定案）**：命中覆盖该宿主版本的 `compatibility.json` 豁免时，`DSH-C064`（"未记录"）消失，`DSH-C060`（"不兼容"）**降级为 warn** —— 与运行时逐分支对齐（`preflight()` 对 `issue.exempted` 返回无冲突，该行不被禁用，所以不再判阻断）；三要素（包名 / 版本 / 宿主）任一不匹配则保持 error。事实始终以提醒形式可见。⚠️ **豁免 key 必须精确到插件当前版本**：写错版本不会报"配置错误"，而是**静默不生效** —— `C065` 会指出"豁免已失效，当前版本是 X"，且**运行时也会因 `exempted` 为 false 而禁用该行**（实测真实案例：key 写成 `@0.1.0` 而实际版本是 `0.1.0-alpha.1`）。DSH 升级时由测试负责人负责复查全部豁免并更新本节。
- **C4 诊断契约**：**禁止**依赖 invariants（已移除）。插件自建诊断通道，由测试期探针夹具承载断言，诊断默认关闭、不加模型输入。
- **C5 静态错误码**：CI 报告与豁免说明统一引用 `DSH-C0xx` 错误码。

---

## 六、边界与分工

- **静态导入扫描 ≠ 运行时属性访问**：`check-plugin-imports.mjs` 只核对模块导出；`ctx.llm.*` / `ctx.tools.*` 的运行时面必须由真实启动（组合测试）覆盖。
- **移除 API 数据表的维护职责**：宿主每次移除 API，由**测试负责人**在 `removed-apis.json` 追加一条。`removedIn` **一律以 `@deepseek-ai/dsh-app-boot` 的 `package.json` `version` 为准**（机制见 contract-v1 §〇，web/桌面两端同源但取值分端：桌面打包版 `0.2.0-rc.2`，主仓源码 `0.2.1-alpha.2`），并同步该端宿主基线归档；`api-baseline.json` 交叉验证测试会把写错的数据表直接变红。**基线采集时机（已定，勿提前采）**：0.2.1-alpha.2 线当前无真实打包/发布宿主——主仓开发工作区的 node_modules 不代表真实宿主，故暂不生成该线基线；待 web 端确认切到 0.2.1 线（有对应打包产物）后，再从真实产物生成归档并交叉验证。
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

> **矩阵的"该测哪几格"不再靠挑**：先用 `dsh-plugin-host-matrix` 算出**声明覆盖集**（不装宿主、
> 不联网、几秒），再只对其中要宣称"已验证"的格子做实测。四层（声明覆盖 / 接口可用 / 实测通过 /
> 未验证）必须分开呈现 —— 把推导出的覆盖集当成实测结果填进矩阵，是本套基建最要防的假绿。
> 详见模板开头的说明。

两者均由测试负责人填写交付；团队侧零操作。开发侧唯一的主动项是把门禁挂进 CI（一条命令，
见 §二第 3 步）；宿主版本矩阵可以再加一条（不需要宿主，见 `packages/conformance/README.md`）。

## 八、维护"已记录的宿主 API 面"

`dsh-plugin-host-matrix --surfaces` 用的宿主 API 面是**随仓库提交的静态产物**，放在
`fixtures/host-surfaces/`。检查时**不联网、不装宿主**，所以它适合每次 PR 都跑。代价是上游
发新版后这份记录会过时 —— 过时只会让新版本落在"未知"（**不会给出错误的绿灯**），但要让格子
有结论就得补。

```bash
# 1. 装一台宿主 —— 版本必须写精确值
mkdir -p /tmp/host && cd /tmp/host
echo '{"name":"dsh-probe-host","private":true,"version":"0.0.0","dependencies":{"@deepseek-ai/dsh":"0.2.1-alpha.4"}}' > package.json
npm install --no-audit --no-fund

# 2. 采集（产物自带 hostVersion，文件名只是给人看的）
node packages/conformance/src/cli-api.mjs \
  --host /tmp/host/node_modules \
  --baseline fixtures/host-surfaces/surface-0.2.1-alpha.4.json --write
```

> **依赖版本必须写精确值，不能写 `^`。** `^0.2.1-alpha.2` **不是**"alpha.2"：按预发布元组
> 规则它会解析到同一个 `[0,2,1]` 元组里**最新的**预发布版本（实测装出来是 `alpha.4`）。
> 这一点在生成现有文件时真的踩到过。

当前记录恰好覆盖 EDA 插件声明区间的全部 5 个版本（`0.2.0-rc.2` 与 `0.2.1-alpha.1…alpha.4`），
所以那个仓库的每个覆盖格子都有结论。候选清单里另有 28 个版本**没有** API 面，它们一律算
**未知** —— 报告会如实打印，**未知 ≠ 通过**。详见 `fixtures/host-surfaces/README.md`。
