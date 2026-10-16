# DSH 插件契约 v1（草案 · 待评审）

| 元信息 | 值 |
|---|---|
| 对应任务 | 维护者个人台账 |
| 状态 | **草案**（未评审） |
| 创建日期 | 2026-10-14 |
| 依据 | 权威类型 `@deepseek-ai/dsh-package-manifest/src/types.ts`、DSH 自家 bundle 实测、`dsh-invariants` 实现、`docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants` |
| 下游消费者 | 本仓库 `packages/conformance` 的三类静态检查器（直接按第六节错误码实现） |

> 注：文中可能出现的 T 编号对应维护者个人台账中的任务编号，团队阅读无需关心。

---

## 〇、适用版本（**必须先读**）

| 版本 | 状态 | invariants 子系统 |
|---|---|---|
| `0.2.0-rc.2` | 当前 Desktop 打包版 | ✅ 存在（`sdk-minimal` patch 有 10 处声明） |
| `0.2.1-alpha.2` | 源码检出 HEAD（`release-0.2.1-alpha.2`） | ❌ **已移除**（`sdk-minimal` patch 0 处） |
| 团队插件 peer 声明 | `>=0.2.1-alpha.2` | → **落在已移除的那条线上** |

**版本口径（必须一致，本条是其余一切判断的基准）**：

1. **唯一版本来源**：宿主版本号一律以 `@deepseek-ai/dsh-app-boot` 包**自己目录下** `package.json` 的 `version` 字段为准。运行时 `getDshRuntimeVersion()` 实现为 `fileURLToPath(new URL("../package.json", import.meta.url))`，检查器 `resolveDshVersion()` 优先读同一字段——**已实测桌面端 `0.2.0-rc.2` 与主仓 `0.2.1-alpha.2` 两处实现字节级同源**。
2. **该值是分端分部署的**：web 端与桌面端各自加载**自己的** `dsh-app-boot` 包，版本可能不同——桌面端（`resources/app` 打包）= `0.2.0-rc.2`；主仓源码（`packages/boot/app-boot`）= `0.2.1-alpha.2`；web GUI 由 `dsh web` 启动，宿主版本取决于它加载哪一份 `dsh-app-boot`（当前 web GUI 实现 checkout 在 `resources/app`，与桌面端同源为 `0.2.0-rc.2`；改从主仓跑 `dsh web` 则为 `0.2.1-alpha.2`）。
3. **明确排除**（不以下列为版本来源）：git 分支/tag 名（`release-0.2.1-alpha.2` 是源码线名，非版本号）、各宿主子包各自安装的 npm 版本（可能不同步）、插件 `engines.dsh` 范围。
4. **对判定的含义**：`removedIn` 阈值判定 `semver.lt(宿主版本, removedIn)` 要求两侧同一坐标系；检查器 `runtimeVersion` 来自它配置的 `hostNodeModules` 指向的那一端，所以**判定哪一端，`hostNodeModules` 就指向那一端**（多端多版本 = 多份 `hostNodeModules` 分别跑）。
5. **移除事实的确认来源**：以主仓 `docs/upgrade-guide/...` 升级指南与对应 release 源码检出为准；测试负责人据此填写 `removedIn`，并同步该端宿主基线归档供交叉验证。

官方升级指南原文：

> 下一版本不再发布 `@deepseek-ai/dsh-invariants`、`InvariantRegistry`、`InvariantInstaller`、`InvariantFailure`、`InvariantError`，也不再发布任何 `<package>/invariant` 子路径。

**结论**：契约中**不得**要求任何插件发布 `./invariant`，**不得**依赖 `ctx.invariants`。原草案的 C4/C5 作废（见第五节替代规则）。

---

## 一、清单契约

### 1.1 必填字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 发布的 npm 包名 |
| `version` | `string` | 发布的 npm 版本 |

> 依据 `DshPackageManifest`：仅 `name` 与 `version` 必填。profile 目录读 `Partial<DshPackageManifest>`（无需发布版本）。

### 1.2 `dsh` 角色声明

`dsh` 下**仅以下四个公共作者字段**（`DshManifest`）：

| 字段 | 类型 | 必填性 | 说明 |
|---|---|---|---|
| `dsh.manifestVersion` | `1`（字面量） | 建议 | 元数据格式标识，独立于 npm 版本与 Session 格式版本 |
| `dsh.bundle` | `{ patch: string \| string[] }` | bundle 角色必填 | patch 文件路径或**有序列表**，均**相对于包根**；launcher 按序作为同一层应用 |
| `dsh.profile` | `{ bundles?: string[] }` | 仅 profile 目录 | 有序组合包层列表，用**已安装的包名** |
| `dsh.client` | 见 1.3 | 有客户端半边必填 | 客户端模块装载与构建元数据 |

### 1.3 `dsh.client` 字段（**易错点**）

| 字段 | 类型 | 必填性 | 说明 |
|---|---|---|---|
| `platform` | `string` | **必填** | 平台标识；Web 消费方选 `web` |
| `inject` | `string[]` | 可选 | ⚠️ **信息性的包名依赖，不是 Cordis 服务注入** |
| `immediately` | `boolean` | 可选 | 启动第一阶段注册屏障；缺省为共享应用批次 |
| `external` | `string[]` | 可选 | 精确的模块表请求（含 `<pkg>/client` 这样的子路径）；缺省为基线 externals |

### 1.4 `engines`

| 字段 | 说明 |
|---|---|
| `engines.dsh` | 声明兼容的 DSH 版本，SemVer 范围（可填精确预发布版） |
| `engines.node` | 兼容的 Node.js 版本 |

> ⚠️ **官方不校验**：手册原文——"当前安装器和加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`；声明范围不会拒绝不兼容的宿主，也不会校验 SemVer 语法。"
> → 这正是 **版本契约检查必须自建** 的原因。

### 1.5 最小合法示例

**A. 纯宿主插件（无客户端半边）**

```json
{
  "name": "@your-scope/dsh-plugin-example",
  "version": "1.0.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.4" },
  "engines": { "node": ">=22.19.0", "dsh": "0.2.0-rc.2" }
}
```

**B. 带客户端半边**

```json
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": "./client/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "manifestVersion": 1,
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
  }
}
```

**C. 组合包（bundle）**

```json
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": ["./cordis.patch.yml", "./presets/standard.patch.yml"] }
  }
}
```

> 对照实测：`@deepseek-ai/dsh-web-app` 的 `bundle.patch` 就是 5 项有序数组；`dsh-base` / `dsh-headless` 是单个字符串。

---

## 二、`exports` 契约

| 场景 | 必须导出 |
|---|---|
| 所有包 | `.`、`./package.json` |
| 声明了 `dsh.bundle` | `./cordis.patch.yml`（或 patch 清单中的每个文件） |
| 有客户端半边 | `./client` |
| 源码消费（可选） | `./src/*` |
| **禁止** | ❌ `./invariant`（0.2.1 线已移除） |

---

## 三、依赖契约

### 3.1 禁止把宿主核心包放入 `dependencies`

**规则**：`@deepseek-ai/dsh-*`、`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-*` **不得**出现在 `dependencies`。

**理由**（`dshmarket/lib/check.js` 点名的 `dsh-excel-chat` 故障模式）：插件的副本会被 hoist 到 profile 根，**遮蔽宿主的版本** → 工具调用直接死亡、minimal preset 挂载失败。

**正确做法**：放 `peerDependencies`。

### 3.2 peer 范围写法

实测 DSH 自家 bundle 的写法：

| 包 | peer 写法 |
|---|---|
| `dsh-base` | `"@deepseek-ai/cordis": "~4.0.4"` |
| `dsh-web-app` | `"@deepseek-ai/dsh-system-prompt": "0.2.0-rc.2"`（精确钉住） |
| `dsh-headless` | `"@deepseek-ai/dsh-agent": "0.2.0-rc.2"`（精确钉住） |
| **反例（某插件）** | `">=0.2.1-alpha.2 <0.3.0"` ← **下界过新，遗漏 0.2.0-rc.x 线，触发 C060 belowMin** |

**契约要求**：

1. 优先**精确钉住**目标宿主版本（如 `0.2.0-rc.2`）。
2. Cordis 系可用 `~`（如 `~4.0.4`）。
3. **禁止**跨主版本的大范围（如 `>=1.0.0 <3.0.0`）—— 它隐含支持中间一整个 major 却未验证。**单侧无界的范围同样禁止**（`>=1.0.0`、`<2.0.0`）：开放侧意味着宣称该侧每一个 major（含未来全部）都可用；要覆盖多条宿主线时写**逐 major 的显式并集**（`>=1.0.0 <2.0.0 || >=2.0.0 <3.0.0`），检查器不报。注意 `>=0.2.1-alpha.2 <0.3.0` **不是**跨主版本（major 恒为 0），它的问题是**下界过新、遗漏 0.2.0-rc.x 线**，由 `C060`（belowMin）捕获。运行时用 `includePrerelease: true`（`dsh-app-boot/lib/index.js:300`），单个范围 `>=0.2.0-rc.2 <0.3.0` 即可同时覆盖 `0.2.0-rc.x` 与 `0.2.1-alpha.x` 两条线。

  **⚠️ 但这只是"运行时预检"一个维度（2026-10-15 实测修正）**：npm/pnpm 的**安装期** peer 解析用**裸 semver**，预发布只被同 `[major,minor,patch]` 元组的比较器接纳，所以单范围会**拒绝** `0.2.1-alpha.2`。实测（semver 7.8.5，与 `dsh-app-boot` 同版本）：

  | 范围 | 运行时 `includePrerelease:true` | 裸 semver（安装期） |
  |---|---|---|
  | `>=0.2.0-rc.2 <0.3.0` | `0.2.0-rc.2` ✓ / `0.2.1-alpha.2` ✓ | `0.2.0-rc.2` ✓ / `0.2.1-alpha.2` **✗** |
  | `>=0.2.0-rc.2 <0.3.0 \|\| >=0.2.1-alpha.2 <0.3.0` | 两个都 ✓ | **两个都 ✓** |

  **因此推荐写法是并集**（两种语义下都成立），不是单范围：

  ```json
  "@deepseek-ai/dsh-llm": ">=0.2.0-rc.2 <0.3.0 || >=0.2.1-alpha.2 <0.3.0",
  "@deepseek-ai/cordis":  ">=4.0.4 <4.1.0 || >=4.0.5-alpha.1 <4.1.0"
  ```

  **检查器的建模边界**：它只建模运行时预检维度，所以对单范围会给绿灯 —— 这是已知边界，不等于"安装期也没问题"。
4. `engines.dsh` 与 `peerDependencies` 中的 DSH 版本**必须一致**。

---

## 四、版本契约与豁免

### 4.1 现状（真实成本证据）

profile 的 `compatibility.json` 把**精确的 `包名@版本`** 映射到**精确的 DSH 运行时版本列表**：

```json
{
  "@your-scope/dsh-plugin-a@0.1.0-alpha.1": ["0.2.0-rc.2"],
  "@your-scope/dsh-plugin-b@0.2.0":         ["0.2.0-rc.2", "0.2.1"]
}
```

### 4.2 官方规则

- 授权要求 `acceptRisk: true`，且需向用户警告"可能导致崩溃或数据丢失"。
- **插件升级和 DSH 升级都不继承授权。**

### 4.3 契约要求

- 每次 DSH 升级，必须重跑 peer 校验并复查全部豁免条目。
- 新增豁免必须在 PR 中说明理由与风险。
- **豁免的实际效力（实测口径，2026-10-15 定案）**：命中豁免**消除** `DSH-C064`（"未记录"）并把 `DSH-C060` **降级为 warn**（"运行时确实放行"），但**不改变**"peer 范围仍宣称了一条没在跑的宿主线"这个事实 —— 事实永远以提醒形式可见，不会被配置刷成不存在。

---

## 五、诊断契约（**替代已作废的 C4/C5**）

### 5.1 禁止依赖已移除的 API

| ❌ 禁止 | 说明 |
|---|---|
| `@deepseek-ai/dsh-invariants` 依赖 | 0.2.1 线不再发布 |
| `ctx.invariants` 服务 | 服务已移除 |
| `<package>/invariant` 子路径导出 | 已移除 |
| `InvariantError` / `InvariantRegistry` / `InvariantInstaller` / `InvariantFailure` | 符号已移除 |

**后果**（官方指南原文）：引用已移除模块的 `cordis.yml`、patch 或 overlay **无法加载该模块**；指向对应 id 的 patch 会记录 `patch: entry <id> not found`；导入这些符号的 TypeScript 代码**无法编译**。

### 5.2 替代做法

官方指南给出的迁移要求：

> 依赖上述四个发出方重新抛出 `INVARIANT` 失败的插件，必须**通过自己的通道报告该失败**。

**契约要求**：

1. 插件自建诊断通道（结构化日志 / 事件 / 返回值中的错误标记）。
2. 诊断断言由**测试期探针夹具**承载（`--patch` 注入，不发布），见 P2/P4 任务。
3. 诊断默认关闭，不增加正常路径开销与模型输入。

---

## 六、错误码表（**静态检查器直接按此实现**）

每条规则一个稳定错误码，CI 报告与豁免说明均引用它。

### 清单

| 错误码 | 规则 | 级别 |
|---|---|---|
| `DSH-C001` | `name` 缺失或非字符串 | error |
| `DSH-C002` | `version` 缺失或非字符串 | error |
| `DSH-C010` | 声明了 `dsh.bundle` 但 `patch` 缺失 | error |
| `DSH-C011` | `bundle.patch` 非 `string \| string[]` | error |
| `DSH-C012` | `bundle.patch` 指向的文件不存在 | error |
| `DSH-C013` | `bundle.patch` 数组为空 | error |
| `DSH-C020` | `dsh.manifestVersion` 存在且 ≠ `1` | error |
| `DSH-C021` | 声明了 `dsh.client` 但缺 `platform` | error |
| `DSH-C022` | `dsh.client.inject` 存在但非 `string[]` | error |
| `DSH-C023` | `dsh.profile.bundles` 存在但非 `string[]` | error |
| `DSH-C030` | `engines.dsh` 缺失 | warn |
| `DSH-C031` | `engines.dsh` SemVer 语法非法 | error |

### exports

| 错误码 | 规则 | 级别 |
|---|---|---|
| `DSH-C040` | `exports` 缺 `.` | error |
| `DSH-C041` | `exports` 缺 `./package.json` | error |
| `DSH-C042` | 声明了 `dsh.bundle` 但 `exports` 缺 `./cordis.patch.yml` | error |

> **`C042` 的比对口径**：`bundle.patch` 的值"相对于包根"（§1.2），加载器按普通路径解析，因此 `cordis.patch.yml` 与 `./cordis.patch.yml` 指向同一文件；而 `exports` 的键必须以 `./` 开头。比对前先把前者归一化成后者（并统一 `/` 分隔符），否则完全合法的写法会被误报。归一化只影响比对，不放松真正的缺口。
| `DSH-C043` | 有客户端半边但 `exports` 缺 `./client` | error |
| `DSH-C044` | `exports` 含**已移除的子路径**（清单见 `packages/conformance/removed-apis.json`，数据驱动） | **按宿主版本分级**：未指定宿主 → error；宿主早于 `removedIn` → warn；宿主达/过 `removedIn` → error |

> **移除 API 数据表（`removed-apis.json`）**：宿主随版本演进会移除 API（0.2.1 线已移除 `./invariant`）。这些移除**不再硬编码进规则**，而是写入一张声明式数据表，每条记录 `{ kind, match, pattern, removedIn, rule, note }`。检查器读表匹配、按 `removedIn` 与宿主版本阈值分级。
> - **新增同类移除**（新的 `subpath` 被移除）＝在表里追加一条数据，**零代码改动**；
> - **数据表正确性**由测试用 `api-baseline.json` 交叉验证兜底（"声明在 X 移除，但 X 之前的快照已缺失"或"X 之后的快照仍存在"都会让测试变红）；
> - 当前仅实现 `subpath` 这一种 `kind`；未来 `symbol`/`package`/`service` 移除需先实现对应检查器再启用对应 `kind`。

### 组合装载

| 错误码 | 规则 | 级别 |
|---|---|---|
| `DSH-C050` | 宿主核心包出现在 `dependencies` | error |
| `DSH-C051` | 同一宿主核心包在 lockfile 出现多版本 | error |
| `DSH-C052` | 组合内出现重复 loader entry id | error |
| `DSH-C053` | patch 条目引用了未安装的包 | error |
| `DSH-C054` | `dsh.profile.bundles` 顺序非法（依赖排在依赖者之后） | error |
| `DSH-C055` | patch 指向已移除的 id 或模块（如 invariants 五行） | error |
| `DSH-C056` | 宿主**工具类**包出现在 `dependencies`（重复安装但通常无害；区别于 C050 的运行时核心包） | warn |

> **真实的层栈顺序**（实测确认，组合装载检查必须按此建模，否则会产生误报）：
> `bundle 层`（按 `dsh.profile.bundles`）→ **`<app>/cordis.patch.yml`（应用/shell 层）** → `profile 的 cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`。

> **`group: true` 是载体（carrier），不是模块**（实测自 `dsh-app-boot`）：boot 把 `group: true` 的行解析为**内建** `cordis:group` / `@deepseek-ai/cordis-plugin-group`（`carrier()` 对 `Group` 内建返回 `"group"`），并且**刻意豁免**它的 disabled 跳过（`if (row.disabled === true && !row.group) continue`），因为该节点本身携带子行列表。据此，检查器的口径是：
> - 载体**没有模块名也不该被要求有** —— 早先把可导入行判定写成"`group` 恒为 `required`"，导致任何合法 group 声明都触发**阻断级** `DSH-C053`「没有模块名」；现已在 `resolvableEntries` 中把载体整体排除出可导入行。
> - 载体的 `disabled` **照常向子行传播** —— 禁用的 group 下，子行不再被视为可导入。
> - 载体**不进入挂载包集合**（T15 分级依据）—— 否则用内建名声明时 `packageRoot('cordis:group')` 会把 `cordis:group` 当成一个"已挂载的包"混进去。
> - `id` 空间不变：载体仍参与重复 id / 覆盖 / `insert` 目标判定（`flattenEntries` 保留它们），只有"可导入行"这一视角排除。
> 漏掉应用层会让每一条指向 shell 插入 id 的 profile patch 都被误判为孤儿（实测案例：`computer-use-cua-driver-native` 由 `resources/app/cordis.patch.yml` 插入）。
>
> **C050 与 C056 的边界**：运行时核心包取 DSH 自身的 curated 清单（即 `dshmarket/lib/check.js` 的种子 —— `dsh-base`/`dsh-tools`/`cordis`/`dsh-agent` 等），遮蔽它们会真正打断宿主；其余 `@deepseek-ai/dsh-*` 叶子工具包（如 `dsh-util-values`、`dsh-atomic-write`）的重复只记为 warn。

### 版本契约

| 错误码 | 规则 | 级别 |
|---|---|---|
| `DSH-C057` | cordis 系 peer 范围不满足宿主实际版本（运行时预检不检查 cordis，但会引发 hoist 遮蔽风险） | warn |
| `DSH-C060` | peer 范围不满足宿主实际版本（`belowMin`）。**命中覆盖该宿主版本的 `compatibility.json` 豁免时降级为 warn** —— 运行时 `preflight()` 对 `issue.exempted` 返回"无冲突"，该行不会被禁用 | error（有覆盖豁免时 warn） |
| `DSH-C061` | peer 范围不满足宿主实际版本（`aboveMax`，仅显式上界/精确钉住时） | warn |
| `DSH-C062` | peer 使用了禁止的跨主版本大范围（同一 `\|\|` 子句内跨 ≥2 个 major，**或单侧无界**因而隐含宣称开放侧的每一个 major，含未来全部） | error |
| `DSH-C063` | `engines.dsh` 与 peer 中的 DSH 版本不一致 | error |
| `DSH-C064` | 存在不满足的 peer，但 `compatibility.json` 无对应豁免 | error |
| `DSH-C065` | 存在豁免条目，但对应插件版本已变更（豁免失效） | warn |
| `DSH-C066` | **支撑包**（未被任何 profile 挂载为行）的 peer 不满足宿主 —— 尚未阻断，但一旦被挂载为行即会被禁用 | warn |
| `DSH-C067` | peer 范围**只被运行时预检接受**：宿主是预发布版本，`includePrerelease` 放行它，但安装期（npm/pnpm）的裸 semver 只接纳带同一 `[major,minor,patch]` 元组预发布的比较器，因而判为 peer 不满足。运行时**不会**因此拒绝该插件，改法是把范围写成并集 | warn |

> **`DSH-C060` 与 `DSH-C067` 是两个不同的维度，不要合并**：`C060` 是"运行时**真的不要**这个插件"（预检会禁用该行，作者必须改范围或走豁免）；`C067` 是"运行时放行，但**安装期**会拒绝"（插件仍能加载，但 `npm install` / `pnpm install` 会看到 peer 不满足，源码线开发流程尤其容易踩）。两者的**成因不同**（元组未覆盖 vs 界外）、**改法不同**（写并集 vs 抬高/降低界）、**严重度也不同**（warn vs error），合并会让修复指引失真。
>
> 判据是**可执行的**：`satisfies(v, r)`（`includePrerelease: true`，对齐运行时）为真而 `satisfiesInstallTime(v, r)`（裸 semver，对齐安装器）为假。因为 `includePrerelease` 只会放宽准入，这一个方向就是全部分歧集合 —— 不存在反向情形。
>
> **当前建模边界**：检查器对 cordis 系 peer（`C057`）的比较锚定在**宿主机里实际装到的那个版本**上，安装器已经成功解析过它，因此那条线不会出现同样的"运行时放行／安装期拒绝"分裂；`C067` 只对 DSH 运行时系 peer 求值。

### 宿主版本矩阵（T17）

| 规则码 | 级别 | 含义 |
|---|---|---|
| `DSH-C068` | error | 声明的宿主范围存在空洞：区间内已发布的版本不被接纳 |

**判据**：给一份**显式**的已发布宿主版本清单，取所有 `dsh` 运行时 peer 接纳集合的**交集**（对齐预检"任一不满足即禁用整行"），再取该集合的 `[min, max]` 区间；**区间内**的候选版本若不被接纳，即为空洞。区间**之外**的版本不算空洞（"不覆盖"是正常的）。

**为什么是 error**：一个连续的 peer 范围向读者传达的是"这一段都支持"。空洞意味着区间内某版用户会被运行时禁用，而声明看起来连续 —— 这正是本仓库反复强调的"声明的要与实际的一致"。若排除是**有意**的，请在候选清单的 `knownGaps` 里写明原因，该条降级为 warn（与 `compatibility.json` 豁免同构：偏差保持可见，但不再阻断）。

**边界**：本 pass 只推导**声明覆盖集**，不安装、不启动任何宿主，因此**不能**得出"该版本已验证可用"。实测验证是另一层（运行时激活探针 / 插件自身测试套件）。

### 门禁自身配置

这一组不检查插件，只检查**门禁有没有真的在检查东西**。二者都是 error：它们各代表一类"静默失效"，而一个悄悄少查的门禁比没有门禁更危险（会给出虚假的绿灯）。

| 错误码 | 含义 | 级别 |
|---|---|---|
| `DSH-C070` | 配置**显式声明**的路径不存在（`hostNodeModules` / `dshHome` / `appDir` / `exemptionsPath`）。区分"未配置"与"配置了但不存在"：后者会静默关掉依赖它的检查（宿主机版本缺失 → `C060`/`C061`/`C064`/`C066`/`C067` 全部跳过） | error |
| `DSH-C071` | 配置的 `packages` / `profiles` 模式未匹配到任何目标。展开为空集时 `every()` 恒真，门禁会以 exit 0"通过"却一个包都没查 | error |

> **零目标另有退出码**：当 `packages` + `profiles` 展开后目标数为 **0** 时，CLI 按"用法错误 / 无检查目标"以 **exit 2** 退出并逐个打印未匹配的模式（与 `DSH-C071` 的 error 分级互补：部分落空 → exit 1 且列出缺口；全部落空 → exit 2）。

> **C060 与 C066 的边界（重要，来自实测）**：宿主的版本预检**只求值它将要 import 的行**的 `peerDependencies`（`dsh-app-boot` README：被拒绝的行从不 import 其模块）。因此：
> - 包**被挂载为 profile 行** → 不满足 peer = **阻断** → `C060`（error）；若**无**覆盖该宿主版本的豁免，则**追加** `C064`（error）。有豁免时只剩 `C060` —— **豁免不消除不兼容本身**（见下方 §7 的实测修正）
> - 包**只是支撑包**（普通依赖，从不作为行挂载）→ 同样的声明**无人求值** → 仅 `C066`（warn）
>
> 实测对照：同一仓库中，被挂载的行**被宿主禁用**，支撑包**未被禁用**；修正前它们被一视同仁地报 error，属**过度报告**。

---

## 七、待评审确认项

- [ ] 第六节错误码命名与分级是否采纳
- [x] **3.2 中"禁止跨主版本大范围"是否对内部实验插件放宽 —— 已定：不放宽，一视同仁。** 理由：① 门禁要防的是"**静默**宣称未验证的宿主线"，而单侧无界（`>=1.0.0`、`<2.0.0`）恰恰宣称了开放侧的每一个 major（含未来全部），比双侧跨 major 更危险，放宽它等于放掉最需要拦的那一类；② 写清逐 major 并集只多一行，成本极低，且能把"我验证过哪几条线"变成可审阅的事实；③ 确有临时需要的插件走**既有**的 `compatibility.json` 豁免通道（`DSH-C064`/`C065` 已实现审批与失效检测），无需为它降低规则本身的门槛 —— 用"放宽规则"解决临时问题会让豁免机制形同虚设。**⚠️ 2026-10-15 实测修正**：该通道**只消除 `C064`（未记录），不消除 `C060`（不兼容）** —— 豁免三要素（包名/版本/宿主）完全匹配时，门禁**仍会因 `C060` 失败**（A/B 实验见 `validation-report.md` 第七节）。因此理由③**目前不构成真正的出口**；本决策的**结论**由理由①②独立支撑。是否让"有覆盖的豁免"把 `C060` 降级为提醒（以与"运行时确实放行"对齐）**已于 2026-10-15 定案：采纳降级，逐分支与运行时对齐** —— 未豁免时 `C060` 保持 error（运行时确实 `deny(row)` 禁用该行），命中豁免时降级为 warn（运行时确实放行）。实现见 `peer.mjs`，回归用例见 `version.spec.mjs`。
- [x] **新增 `focusPackages`（可选配置）—— 已定并落地**：组合检查是 profile 级，会报出作者无法控制的包（宿主自带组件、第三方插件，其中 `C050` 为 error 级），对"检查我自己的插件"这一主用例引入噪声。`focusPackages` 只收敛**报告范围**（`C050`/`C056` 的归属过滤），不改变检查本身；profile 自身的 `dependencies` **永远在范围内**；被过滤条目**计数并打印**，不静默丢弃。
- [x] **运行时探针不可复现（2026-10-15 暴露）—— 已重建并自证**：证明"插件在无任何 `compatibility.json` 豁免下被运行时自然放行"的那份探针脚本（`eda-probe-no-exemption.mjs`）**随 monorepo 合并丢失**，既有文档给出的复跑路径已不存在 —— 该结论曾**无法从本仓库复现**。静态门禁替代不了它（门禁只读文件、不启动 DSH），而"运行时到底有没有禁用这一行"恰恰是最需要活证据的判定。
  **落地**：`packages/testkit/src/activate.mjs`（原语）+ `activate-cli.mjs`（`dsh-plugin-activate`，供 CI 调用），隔离 home + 链接被测包 + 真实启动，断言无 `disabling profile plugin` / 无 `did not activate` / 无 pending / 无 `plugin tree failed to load`，并以终止于 `MISSING_CREDENTIAL` 作为"启动已越过预检"的证据（无需模型凭据与外部服务）。
  **三条实测结论**：① **`--dump-config` 不能替代真实启动** —— 实测一个不兼容行会原样出现在 dump 里且**没有任何 `disabled` 标记与诊断**，预检只在真实 boot 时执行；② 探针**自证能检出**（`fixtures/incompatible-plugin` 刻意不可满足的 peer → 检出并失败；`--expect-disabled` 反过来证明它并非"永远失败"）；③ 对 EDA 插件 A/B：修复前 `a2819a3` **2 行被禁用**（`optional-schematic`、`optional-tool-schematic`，原因即 peer `>=0.2.1-alpha.2` 与宿主 `0.2.0-rc.2` 不兼容），修复后 `9547271` **0 行被禁用**且启动越过预检 —— 插件修复在运行时真实生效，而不只是静态门禁变绿。**2026-10-16 复跑补正**：两侧都用**已构建**的检出复跑后可见真实爆炸半径是 **3 行**而非 2 行 —— 除上述两条禁用外，`optional-schematic-easyeda` 出现在「未激活的行」里、detail 为 `pending (waiting for service: schematic)`：`optional-schematic` 正是 `schematic` 服务的提供者，它被禁用后依赖方永远等不到服务。即**一个写错的 peer 范围会连带拖垮依赖它的插件**。该行由 v0.8.1 才做的「`did not activate` 可归因」抓到，**不是**由 `pending` 判据抓到（本次 `pending=false`：宿主没打印 `Plugins waiting for services (N):` 聚合行，而 `pending` 判据盯的是那条行 —— 两者是独立信号）。
  **顺带修正的一处判据错误**：行 id 由插入它的补丁作者决定（bundle 可把 `@scope/dsh-plugin-a` 挂成 `optional-a`），因此按包名匹配的 `expectActive` **必须**同时解析禁用原因里的包名，否则会把自己要盯的那条禁用误判为"非关注行"。
  **运行前提（CI 落地时补充）**：探针验证的是**交付物**，而插件入口通常是构建产物（`tsc -b` 产出的 `lib/index.js`）—— **必须在构建之后运行**。未构建时每一行都会 `failed to import` 并抛 `ERR_MODULE_NOT_FOUND`（那句描述的是症状）：本项首次接入 CI 即踩到此坑（CI 从不构建，本机恰好是已构建的检出）。探针现已自行检查每个链接包**声明**的入口文件是否存在并单列「未构建的包」，把"没构建"与"坏了"分开。
- [x] **安装期 semver 维度是否建模（2026-10-16 暴露）—— 已定：新建独立规则码 `DSH-C067`（warn），不并入 `C060`。**
  暴露方式：把门禁接进真实插件仓库的 CI 时，需要**同时**对"桌面线 `0.2.0-rc.2`"与"源码线 `0.2.1-alpha.4`"两条宿主线判定。两条线跑下来门禁全绿，但复盘发现：**修复前的单范围 `>=0.2.0-rc.2 <0.3.0` 在源码线上运行时放行、安装期会被拒绝**，而当时门禁对这种形态**无能为力**（它只按 `includePrerelease: true` 求值，与运行时一致，于是判定"满足"）。
  **为何不合并进 `C060`**：`C060` 的语义是"运行时**真的不要**这个插件"（预检禁用该行），改法是抬高/降低界或走豁免；`C067` 的语义是"运行时放行、**安装器**拒绝"，改法是写成并集。成因、改法、严重度（error vs warn）三者皆不同，合并会让修复指引失真 —— 与"错误码要能让作者直接照着改"的原则冲突。
  **落地**：`semver.mjs` 导出 `satisfiesInstallTime`（裸 semver，对齐安装器）/ `admittedOnlyByRuntime` / `prereleaseTuple`；`peer.mjs` 在运行时诊断**通过**的分支上求值；消息里给出宿主未覆盖的具体元组与并集写法。回归用例见 `version.spec.mjs`（含正对照、负对照、并集不误报三类）。
- [x] **测试支撑包与宿主线的耦合（2026-10-16 暴露）—— 已定：`resolveInstalledPackage` 优先取宿主里的那一份，并在拿不到时带原因跳过。**
  暴露方式：测试仓库自己接上真实宿主双线矩阵后，`0.2.1-alpha.4` 线在 replay 上红了一条。根因**不是被测代码**：testkit 把 `@deepseek-ai/dsh-llm-replay` / `@deepseek-ai/dsh-session-snapshot` 精确锁定为 `0.2.0-rc.2`，而这两个包与 DSH 同步发版、且把自己的 peer 钉成**精确版本**（比"单范围"更窄的极端形态），于是跑另一条宿主线时**宿主自己的预检**把 replay 行禁用了。一个教别人"范围要能跨线"的项目，自己的测试支撑只覆盖一条线。
  **落地**：① 解析顺序改为**宿主优先**（`$DSH_HOST_NODE_MODULES` → 本包锁定版本），于是"把匹配版本装进宿主"即可在**任意**宿主线跑通 replay 车道；② 拿不到匹配版本时**不再含糊失败**，而是带着两边版本号明确跳过，且判定收窄 —— 只有"宿主自己说它不兼容"**且**"版本确实不同"才跳过，同版本下被禁用仍然失败（避免把真问题跳过掉）。
  **附带事实**：这两个测试支撑包的 **dist-tag 映射与 `@deepseek-ai/dsh` 不一致**（`dsh-llm-replay` 的 `latest` 是 `0.0.1-rc.1`，而 `dsh` 的 `latest` 是 `0.2.0-rc.2`），按 tag 取会装出跨线组合；CI 与文档一律以**宿主实际版本**为准。
- [x] **测试仓库自己是否要接真实宿主 —— 已定：要。** 此前本仓库 `ci.yml` 只跑离线车道，**11 个依赖真实 DSH 的用例在自己 CI 上一直跳过**，运行时激活探针的集成行为从未被本仓库验证过。现分三条车道：`test`（离线）/ `real-host`（npm 宿主，双线矩阵，让那 11 例真正执行）/ `dsh-canary`（跟 dist-tag 走、允许失败）。`real-host` 带两条反假绿断言：跳过原因里不得出现"缺宿主"，以及 **`C067` 的双向断言**（单范围夹具在桌面线必须不报、源码线必须报 —— 需真实预发布宿主，离线用例替代不了）。
- [ ] 豁免新增的审批流程由谁负责
- [x] 双线维护：**已通过 `removed-apis.json` 数据表 + 阈值分级落地**——单线声明（`removedIn`）+ 阈值自适应双线（宿主早于 → warn，达/过 → error），不维护两套契约
- [x] `DSH-C044` 参数化：**已落地为数据驱动**（`removed-apis.json`），不再按目标线无条件 error
- [ ] 已确认事实：运行时 peer 预检用**统一 runtime 版本**（`getDshRuntimeVersion()` 读 `dsh-app-boot` 自身版本）去满足所有 `dsh`/`dsh-*` peer，**不**用各 peer 包各自安装版本；cordis 系 peer 不被预检。checker 已按此对齐（`resolveDshVersion` 优先 `dsh-app-boot`，cordis 独立为 `C057`）

---

### 7.x 宿主版本矩阵的输入与严重度（2026-10-16 暴露）—— **已定**

- **候选版本清单必须是显式输入且随仓库提交，检查时不得联网。** 理由与钉 `TESTING_REV` 一致：一个在检查时联网的判定，其结论会随上游变化而**不随提交变化**，无法复现、无法评审。清单需声明 `source` 与 `generatedAt`；上游发新版后重新生成并提交。
- **空洞定为 error，但允许用 `knownGaps`（版本 → 原因）声明为有意排除并降级为 warn。** "有意排除"与"遗漏"从声明本身无法区分，所以判定必须给作者一个**表达意图的位置**；但该位置强制要求原因 —— 无原因的豁免等于隐藏问题。
- **接纳集合取交集而非并集。** 预检在**任一** `dsh` peer 不满足时即禁用整行，所以一个窄 peer 就能压住整个包。
- **不并入 `DSH-C060`。** `C060` 是"给定宿主下不满足"（单宿主视角），`C068` 是"区间内存在不被覆盖的已发布版本"（集合视角）—— 前者需要宿主安装，后者完全不需要，成因与可复现条件都不同。

## 八、变更记录

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-10-16 | v1.5-draft | **T17 宿主版本矩阵落地**：新增 `deriveHostMatrix()` 与 `dsh-plugin-host-matrix` CLI，规则码新增 `DSH-C068`（空洞，error；`knownGaps` 可降级为 warn）。把工具从"给一个宿主出报告"升级为"推导兼容哪些宿主版本"：输入是一份显式的已发布版本清单（不联网），输出是声明**覆盖集合**加两类缺陷 —— 区间内的空洞（C068）与逐候选复算的安装期分歧（C067）。**落地即抓到真实缺陷**：EDA 三个包的并集在 `0.2.1-alpha.1` 上运行时接纳、安装期被拒（第一个子句的比较器只带 `0.2.0` 元组）；修复后新装该宿主实测通过（修复前 2 行禁用 / exit 1 → 修复后 0 / exit 0）。用例数 174 → 188。 | 测试负责人 |
| 2026-10-16 | v1.5-draft | **版本号与本文档的锁步承诺对齐（0.1.0 → 0.8.1）**。CHANGELOG 开头写着"两个包锁步版本，版本号随本记录升位"，但三个 `package.json` 与两个 lock 一直停在 `0.1.0` —— 明写的策略没落到产物上，读者无法据此确认手里是哪一版能力。现全部对齐；改 lock 只动 lock 自身与 `packages[""]` 的 version（testkit 里有一个真的 `0.1.0` 依赖 `which-command`，不能连带改）。同时修掉 replay 宿主守卫在**默认路径**上的两处自身缺陷（`??` 惰性求值把"少一级目录"与"忘了 import `dirname`"一起盖住 —— 显式设了 `DSH_HOST_NODE_MODULES` 时右侧从不求值），并把守卫从 1 条用例扩到 3 条 | 测试负责人 |
| 2026-10-16 | v1.5-draft | **测试仓库接上自己的真实宿主车道，并修掉测试支撑包与宿主线的耦合**。① 本仓库 `ci.yml` 此前只跑离线车道，11 个依赖真实 DSH 的用例**在自己 CI 上一直跳过** —— 探针的集成行为从未被本仓库验证过；现补 `real-host`（npm 宿主双线矩阵）与 `dsh-canary`，并加两条反假绿断言（跳过原因不得是"缺宿主"；`C067` 在桌面线必须不报、源码线必须报）。② `0.2.1-alpha.4` 线随即红了一条 replay 用例，根因是 **testkit 自身**：它精确锁定 `dsh-llm-replay@0.2.0-rc.2`，而该包与 DSH 同步发版、peer 也是**精确版本**，跑另一条线时被宿主预检禁用。`resolveInstalledPackage` 改为**宿主优先**解析，取不到时带两边版本号明确跳过（判定收窄：同版本被禁用仍失败）。③ 顺带记录这两个包的 dist-tag 与 `@deepseek-ai/dsh` **不一致**，不得按 tag 取。用例数 171 → **173** | 测试负责人 |
| 2026-10-16 | v1.5-draft | **新增 `DSH-C067`：把 peer 的"安装期维度"正式建模进来（warn）**。此前门禁只建模运行时预检那一维（`includePrerelease: true`），会**给一条安装期被 npm/pnpm 拒绝的范围开绿灯** —— 而这正是本仓库在真实插件上踩过的缺陷（单范围 `>=0.2.0-rc.2 <0.3.0` 在桌面线正确，在源码线 `0.2.1-alpha.4` 上运行时放行、安装期拒绝）。新码判据为 `satisfies(v,r) && !satisfiesInstallTime(v,r)`；`includePrerelease` 只放宽准入，故该方向即全部分歧集合。**刻意不并入 `C060`**：成因（元组未覆盖 vs 界外）、改法（写并集 vs 移动界）、严重度（warn vs error）三者皆不同。同时把探针的 `did not activate` 由"只报数量"改为**可归因到具体行**（宿主在聚合行后逐行打印 `<rowId> (<packageName>): <detail>`）—— CI 首次落地时正是被这条无归因的失败卡住 | 测试负责人 |
| 2026-10-15 | v1.4-draft | **运行时激活探针落地（T16）**：`testkit` 新增 `probeActivation()` 与 `dsh-plugin-activate` CLI，补回丢失的"无豁免即被运行时放行"验证能力。关键实测：`--dump-config` **不跑**兼容性预检（不兼容行原样出现在 dump 且无 `disabled`），故探针必须真实 boot；以 `MISSING_CREDENTIAL` 作为启动越过预检的证据，无需凭据。自证机制：`fixtures/incompatible-plugin` 与 `fixtures/sample-plugin` **只差一个 peer 范围**，构成受控实验；`--expect-disabled` 证明探针不是"永远失败"。EDA 插件 A/B：修复前 2 行被禁用、修复后 0 行。**§7 该项已闭环** | 测试负责人 |
| 2026-10-15 | v1.3-draft | **`group: true` 载体语义定案**：载体不是模块（boot 解析为内建 `cordis:group`），已从"可导入行"中排除 —— 修掉任何合法 group 声明都触发**阻断级** `DSH-C053` 的误报，并阻止载体污染 T15 的挂载包集合；载体的 `disabled` 仍向子行传播。**§7 决策**：「禁止跨主版本大范围」**不对内部实验插件放宽**（单侧无界同样算跨主版本；临时需要走 `compatibility.json` 豁免通道）。**发布面**：两个包移除 `license: MIT`（无 LICENSE 文件，著作权归属未定，不虚标许可） | 测试负责人 |
| 2026-10-15 | v1.2-draft | **新增 §6.4 门禁自身配置错误码**：`DSH-C070`（配置显式声明的路径不存在）/ `DSH-C071`（目标模式未匹配到任何目标），均 error；目标数为 0 时 CLI 以 exit 2 退出。**`C062` 判定口径收紧**：改用 semver 比较器解析，单侧无界的范围也算跨主版本（旧正则只认 `>=x.y.z` 三段形态，`>=1.0.0`、`>=1 <3`、连字符区间都会漏判）。**`C042` 误报修复**：`dsh.bundle.patch` 不写 `./` 前缀属合法写法，不再误报 | 测试负责人 |
| 2026-10-15 | v1.1-draft | **移除 API 数据表落地**：`DSH-C044` 从硬编码改为 `removed-apis.json` 数据驱动并按宿主版本阈值分级（早于 `removedIn` → warn，达/过 → error）；新增数据表与 `api-baseline.json` 的交叉验证兜底。未来新增 `subpath` 移除只需加一条数据 | 测试负责人 |
| 2026-10-14 | v1.0-draft | 初稿。**相对最初提案的关键修正**：① `dsh.client.inject` 改为可选且为信息性字段（原误列为必填的 Cordis 注入）；② 删除"每包必须有 `./invariant`"（该 API 在 0.2.1 线已移除）；③ 新增第六节错误码表供静态检查器实现 | 测试负责人 |
