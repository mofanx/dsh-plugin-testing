# CI 上接入真实 DSH 安装

> 读者：CI / 测试负责人。
> **结论先行：不接也能跑。** 缺真实安装时，6 个相关用例会**自动跳过**，CI 保持绿色。
> 接上它们，是为了让这 6 个用例**真正执行** —— 而不是为了让 CI 变绿。

本文中标注「已核实」的结论来自读源码 + 本机实测；标注「建议」的步骤**尚未在真实 CI runner 上验证过**，落地时请以实际为准。

---

## 一、为什么要接

仓库共 **163 个用例**（自动检查 124 + 工具箱 39）。其中：

| 类别 | 数量 | 需要什么 |
|---|---|---|
| **完全离线** | **153** | 什么都不需要（合成插件 + 合成宿主，不联网、不启动 DSH） |
| 真实启动（launcher） | 9 | 一个**完整可运行的 DSH 安装** |
| 宿主 API 面核对 | 1 | 真实宿主的 `node_modules` |

那 10 个用例证明的是**离线用例证明不了**的事：插件真的能在这个宿主上 boot 起来、组合真的能装载、**运行时真的没有禁用某一行**、真实宿主的 API 面与基线真的对得上。

> 当前 `ci.yml` **没有**提供真实安装（`ubuntu-latest` + 无宿主），所以这 6 个在 CI 上全部跳过。这是刻意的：宁可明确跳过，也不要为了"看起来全绿"而把它们降级成假通过。

## 二、三个环境变量分别要什么（已核实）

| 变量 | 必须指向 | 本机默认值（维护机） | 谁消费 | 缺失后果 |
|---|---|---|---|---|
| `DSH_BIN` | 完整安装里的 `@deepseek-ai/dsh/lib/bin.js` | `D:\Program Files\DSH NEXT\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js` | testkit：`home.spec.mjs`（1 例）、`replay.spec.mjs`（4 例） | 这 5 例跳过 |
| `DSH_FIXTURES` | **DSH 源码检出**里的 `…/session-snapshot/tests/fixtures/record-suite` | `D:\projects\nodejs\deepseek-harness\packages\test-support\session-snapshot\tests\fixtures\record-suite` | testkit：`replay.spec.mjs` 其中 2 例 | 那 2 例跳过（另外 2 例只要 launcher） |
| `DSH_HOST_NODE_MODULES` | 真实宿主的 `node_modules` | `D:\Program Files\DSH NEXT\resources\app\node_modules` | conformance：`api-surface.spec.mjs`（1 例）；**同时是门禁 CLI `--host` 的环境回退** | 那 1 例跳过 |

三个变量都**只用于集成用例与门禁运行**；单元测试与离线门禁自检（`fixtures/`）**不需要任何环境变量**。

### `DSH_BIN` 的具体要求

- **必须是完整安装，不能只拷这一个文件。** launcher 会从该安装自己的 `node_modules` 解析 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-headless` 等 bundle，缺了就跑不起来。
- 该安装需自带 stock `headless` profile（工具箱的默认 bundles 由它派生，见 `DEFAULT_TEST_BUNDLES`）。
- 实际执行形式：`node <DSH_BIN> --profile <名> [--patch …] --dump-config` —— **`--dump-config` 不需要模型凭据**，所以 CI 上不需要配任何 API key。
- 超时：home 用例 **120s**，replay 用例 **40s**。**超时按失败处理**，不算环境问题 —— 挂死的 launcher 正是这些用例要抓的东西。
- **平台限制（重要）**：打包启动器是 Windows / macOS 产物，**Linux runner 上基本无法执行**。这 5 个用例实际需要 **Windows 或 macOS runner**。

### `DSH_FIXTURES` 的具体要求

- 它**不在打包安装里**，来自**宿主源码检出**：`packages/test-support/session-snapshot/tests/fixtures/record-suite`。这是 CI 上最难凑的一项 —— 需要一个 DSH 源码 checkout。
- 需要两个具体文件，缺任一则对应用例跳过：
  - `rec-pin/session.v3.jsonl`
  - `rec-pin/session.jsonl`（v0 投影，**故意不带 `version` 字段**，用例正是断言它被编解码器拒绝）

### `DSH_HOST_NODE_MODULES` 的具体要求

- 指向真实宿主的 `node_modules`，其中需有 `@deepseek-ai/*` 包，且每个包有可读的 `package.json`（带 `exports`）。
- 用例会断言"包数 > 100 且 `@deepseek-ai/dsh-llm` 的符号面 > 10"，以证明读到的是**真实**宿主而不是空目录。
- 它**不只是测试用**：门禁 CLI 把 `DSH_HOST_NODE_MODULES` 当作 `--host` 的环境回退（`DSH_HOME` 同理对应 `--home`）。CI 里设一次，门禁与用例都受益。

## 三、不接会怎样（已实测）

把三个变量都指向不存在的路径（等价于没有真实安装的 runner），实测输出：

```
﹣ 真实启动：裸 home 能 boot 并 dump 出组合（T03 的决定性用例） # 未找到 DSH launcher（DSH_BIN=…）
﹣ a linked replay package composes into the profile              # 未找到 DSH launcher（DSH_BIN=…）
﹣ replay failure is the reported fault, not a missing credential  # 未找到 DSH launcher（DSH_BIN=…）
﹣ a fixture without a `version` field is rejected by the codec     # fixture 缺失（DSH_FIXTURES=…，找不到 …\session.jsonl）
﹣ a fixture with no recorded model calls fails loudly instead of silently # fixture 缺失（…）
﹣ the real host yields a populated symbol surface                  # 未找到真实宿主 node_modules（DSH_HOST_NODE_MODULES=…）

skipped 6 / fail 0        → CI 保持绿色
```

**每个 skip 都自带原因**（变量名 + 具体路径），所以"CI 上有跳到黄色"时不需要翻源码就知道该配哪个变量。

## 四、接入步骤（建议，未在真实 CI 上验证）

### 方案 A：用打包宿主（判断"桌面端"这条线）

适合：想验证插件在**用户实际装到的那份 DSH** 上能否工作。

1. 在 runner 上准备一份完整 DSH 打包安装（Windows / macOS）。
2. 设两个变量：
   ```yaml
   env:
     DSH_BIN: '<安装根>\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
     DSH_HOST_NODE_MODULES: '<安装根>\resources\app\node_modules'
   ```
3. 用例会立刻生效（5 个 launcher 用例 + 1 个宿主 API 面用例）。
4. 若要跑 replay 的 fixture 两例，再补方案 C。

### 方案 B：用源码线的 `node_modules`（判断"源码 HEAD"这条线）

适合：想提前发现"下一版 DSH 会不会让插件碎掉"。

1. checkout DSH 源码到**约定的 revision**，`npm ci`。
2. 把 `DSH_HOST_NODE_MODULES` 指向解析后的 `node_modules`。

> ⚠️ **重要限制**：按契约 §六，开发工作区的 `node_modules` **不代表真实宿主**，因此**只能用于跑门禁，绝不能用来生成/更新宿主基线归档**（`api-baseline.json` / `baselines/*.json`）。基线必须取自真实打包产物。

### 方案 C：补 `DSH_FIXTURES`

从 DSH 源码检出取 `packages/test-support/session-snapshot/tests/fixtures/record-suite`，把 `DSH_FIXTURES` 指向它。

### 建议的 job 结构

不要把那 6 个用例塞进主 job：主 job 应保持"快 + 到处都能跑 + 必须绿"，真实安装单独成 job（耗时、且需要特定平台）：

- **主 job（ubuntu，必需）**：离线 135 例 + 门禁自检。永远要绿。
- **真实宿主 job（windows-latest，按需/定时）**：提供打包宿主，跑那 10 例。可以设为允许失败或仅定时跑，避免阻塞每个人的 PR。

## 五、版本有什么影响（重点，已核实）

这是最容易踩坑的部分：**同一份插件，指向不同的 `hostNodeModules`，门禁会给出不同结论 —— 这是设计如此，不是 bug。**

### 1. 版本只有一个来源

宿主版本**一律**取 `@deepseek-ai/dsh-app-boot` 包目录下 `package.json` 的 `version` 字段（依据见 [`contract-v1.md`](contract-v1.md) §〇）。运行时与检查器实现同源。

**不**作为版本来源：git 分支/tag 名、各子包各自安装的 npm 版本、插件自己的 `engines.dsh`。

### 2. 这个值是"分端分部署"的

| 端 | `dsh-app-boot` 版本 |
|---|---|
| 桌面打包版（`resources/app`） | `0.2.0-rc.2` |
| 主仓源码线（`packages/boot/app-boot`） | `0.2.1-alpha.2` |

所以：**你判定哪一端，`DSH_HOST_NODE_MODULES` 就指向那一端。** 要同时管两端，就跑两次门禁、各指一端（多端多版本 = 多份配置分别跑）。

### 3. 版本如何改变判定结果

| 规则 | 受版本影响的方式 |
|---|---|
| `DSH-C060` / `C061` / `C064` / `C066` | 按宿主实际版本判 peer 是否满足，并区分 `belowMin`（宿主太旧）/ `aboveMax`（宿主太新） |
| `DSH-C067` | 宿主是**预发布**版本时才可能命中：范围只被运行时的 `includePrerelease` 接受，会被安装期裸 semver 拒绝。因此**同一条 peer 范围在两条宿主线上的判定可能不同** —— 这正是需要多线矩阵的原因 |
| `DSH-C044`（已移除 API） | 按 `removed-apis.json` 的 `removedIn` 阈值**分级**：宿主版本未知 → 按 **error**（保守）；宿主 **早于** `removedIn` → **warn**（现在还能用，迁移后失效）；宿主 **达到/超过** → **error** |
| `DSH-C063` | 比对插件 `engines.dsh` 与 peer 范围是否自相矛盾（与宿主版本无关，但同属版本族） |
| 预发布准入 | 所有版本比较统一用 `includePrerelease: true`（与运行时一致），因此 `0.2.0-rc.2`、`0.2.1-alpha.x` 都按预发布正确处理 |

**具体到当前数据**：`removed-apis.json` 里 `invariant-subpath` 的 `removedIn` 是 `0.2.1-alpha.2`。于是同一个暴露了 `./invariant` 的插件：

- 对**桌面端**（`0.2.0-rc.2`）→ **warn**（invariants 子系统还在，但下一版会没）
- 对**源码线**（`0.2.1-alpha.2`）→ **error**（已经移除）

这正是"分级"的意义：**同一个缺陷，在旧宿主上是提醒，在新宿主上是故障。**

### 4. 基线（`api-baseline.json` / `baselines/`）与版本的关系

- 当前活动基线是 `packages/conformance/api-baseline.json`；`baselines/<版本>.json` 存**历史**宿主归档（该目录目前为空）。
- 基线的版本**不存在文件里的某个字段**，而是从快照里的 `@deepseek-ai/dsh-app-boot` 版本**推断**出来（`inferBaselineVersion`）。
- 基线用于**交叉验证 `removed-apis.json` 这张表本身对不对**：快照版本 < `removedIn` 时，宿主应当**仍**导出该 API；≥ `removedIn` 时应当**已不**导出。不符即说明**表写错了**（不是插件错），测试会直接变红。
- **当前只能验证一半**：契约 §六明确，`0.2.1-alpha.2` 线**尚无真实打包宿主**（开发工作区的 `node_modules` 不算），因此那条线的基线**刻意不生成**。已提交的基线是 `0.2.0-rc.2` 线 —— 即"移除前"的一侧。等到有真实的 0.2.1 打包产物，才谈得上采该线基线、把 `invariant-subpath` 的移除后一侧也交叉验证上。

## 六、排查表

| 现象 | 含义 | 怎么办 |
|---|---|---|
| `# 未找到 DSH launcher（DSH_BIN=…）` | 该路径不存在 | 检查 `DSH_BIN` 是否指向**完整安装**的 `bin.js` |
| `# 无法启动 launcher（EPERM）：…` | 路径存在但进程起不来（沙箱、权限、被删） | 这是**环境**问题，不是 launcher bug；换 runner 或放开权限 |
| `# fixture 缺失（DSH_FIXTURES=…，找不到 …）` | 变量指对了目录但缺具体文件 | 确认目录下存在 `rec-pin/session.jsonl` 与 `rec-pin/session.v3.jsonl` |
| `# 未找到真实宿主 node_modules（DSH_HOST_NODE_MODULES=…）` | 路径不存在 | 指向安装根下的 `node_modules` |
| 用例**失败**而非跳过：`expected … to be …` | 安装存在且真的跑了，断言没过 | 这是真结论 —— 插件/门禁确实有问题，别当环境问题忽略 |
| CI 全绿但你不确定那 10 例跑没跑 | skip 与 pass 在汇总里是分开计数的 | 看 `skipped` 计数；为 0 才说明 10 例真的执行了 |
