# CI 上接入真实 DSH 安装

> 读者：CI / 测试负责人。
> **结论先行：不接也能跑。** 缺真实安装时，11 个相关用例会**自动跳过**（每个都带原因），CI 保持绿色。
> 接上它们，是为了让这 11 个用例**真正执行** —— 而不是为了让 CI 变绿。

本文中标注「已核实」的结论来自读源码 + 本机实测；标注「建议」的步骤**尚未在真实 CI runner 上验证过**，落地时请以实际为准。

> **2026-10-16 更新**：**方案 D（从 npm 装宿主）已在真实 CI runner（`ubuntu-latest`）上跑通**，并被 `mofanx/deepseek-eda-plugins` 的 `dsh-gate.yml` 采用；本文档相应处已从「建议」升级为「已实测」。方案 A（桌面打包宿主）的平台限制随之收窄为"只对打包产物成立"。

---

## 一、为什么要接

仓库共 **219 个用例**（自动检查 174 + 工具箱 45）。其中：

| 类别 | 数量 | 需要什么 |
|---|---|---|
| **完全离线** | **163** | 什么都不需要（合成插件 + 合成宿主，不联网、不启动 DSH） |
| 真实启动（launcher） | 10 | 一个**完整可运行的 DSH 安装** |
| 宿主 API 面核对 | 1 | 真实宿主的 `node_modules` |

那 11 个用例证明的是**离线用例证明不了**的事：插件真的能在这个宿主上 boot 起来、组合真的能装载、**运行时真的没有禁用某一行**、真实宿主的 API 面与基线真的对得上。

> 本仓库的 `ci.yml` **已经有**真实宿主车道（`real-host`，宿主取自 npm），所以这 11 个在 CI 上会真正执行；`test` job 那一份实测是 `pass 163 / fail 0 / skipped 11`。这是刻意的：宁可明确跳过，也不要为了"看起来全绿"而把它们降级成假通过。要接上它们见下方**方案 D**（npm 宿主，已在真实 CI 上验证）。

## 二、三个环境变量分别要什么（已核实）

| 变量 | 必须指向 | 本机默认值（维护机） | 谁消费 | 缺失后果 |
|---|---|---|---|---|
| `DSH_BIN` | 完整安装里的 `@deepseek-ai/dsh/lib/bin.js` | `D:\Program Files\DSH NEXT\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js` | testkit：`home.spec.mjs`（1 例）、`replay.spec.mjs`（4 例）、`activate.spec.mjs`（5 例） | 这 10 例跳过 |
| `DSH_FIXTURES` | **DSH 源码检出**里的 `…/session-snapshot/tests/fixtures/record-suite` | `D:\projects\nodejs\deepseek-harness\packages\test-support\session-snapshot\tests\fixtures\record-suite` | testkit：`replay.spec.mjs` 其中 2 例 | 那 2 例跳过（另外 2 例只要 launcher） |
| `DSH_HOST_NODE_MODULES` | 真实宿主的 `node_modules` | `D:\Program Files\DSH NEXT\resources\app\node_modules` | conformance：`api-surface.spec.mjs`（1 例）；**同时是门禁 CLI `--host` 的环境回退** | 那 1 例跳过 |

三个变量都**只用于集成用例与门禁运行**；单元测试与离线门禁自检（`fixtures/`）**不需要任何环境变量**。

### `DSH_BIN` 的具体要求

- **必须是完整安装，不能只拷这一个文件。** launcher 会从该安装自己的 `node_modules` 解析 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-headless` 等 bundle，缺了就跑不起来。
- 该安装需自带 stock `headless` profile（工具箱的默认 bundles 由它派生，见 `DEFAULT_TEST_BUNDLES`）。
- 实际执行形式：`node <DSH_BIN> --profile <名> [--patch …] --dump-config` —— **`--dump-config` 不需要模型凭据**，所以 CI 上不需要配任何 API key。
- 超时：home 用例 **120s**，replay 用例 **40s**。**超时按失败处理**，不算环境问题 —— 挂死的 launcher 正是这些用例要抓的东西。
- **必须先构建**（运行时激活探针）：插件入口通常是构建产物（`tsc -b` 产出的 `lib/index.js`），不在仓库里。未构建就探测针，每一行都会 `failed to import` 并抛 `ERR_MODULE_NOT_FOUND` —— 那是症状，原因是没有构建。探针会在启动前检查入口文件并单列「未构建的包」，但正确的做法仍是**先构建再探**（例如 `pnpm install --frozen-lockfile && pnpm run build`）。静态门禁不受此影响（它只读声明文件）。
- **平台限制（重要）**：打包启动器是 Windows / macOS 产物，**Linux runner 上基本无法执行**。这 5 个用例实际需要 **Windows 或 macOS runner**。

  > **⚠️ 2026-10-16 实测修正**：上面的平台限制是针对**桌面打包产物**的。若改用 **npm 上发布的 `@deepseek-ai/dsh`**（见下方方案 D），它在 Linux runner 上**可以正常启动** —— 已在 `ubuntu-latest` 上实测跑通两条宿主线（`0.2.0-rc.2` 与 `0.2.1-alpha.4`）。因此"必须 Windows/macOS"不再成立：**用 npm 宿主即可在任何平台跑**，而且一次能覆盖多条宿主线。

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
﹣ 真实启动：兼容夹具的行不被禁用（T16 正例）              # 未找到 DSH launcher（DSH_BIN=…）
﹣ 真实启动：不兼容夹具的行被禁用，且探针能检出（自证）      # 未找到 DSH launcher（DSH_BIN=…）
﹣ 真实启动：expectDisabled 命中的禁用不再判失败             # 未找到 DSH launcher（DSH_BIN=…）
﹣ 真实启动：expectActive 只对关注行判失败，非关注行仅报告   # 未找到 DSH launcher（DSH_BIN=…）
﹣ 真实启动：入口未构建时给出"未构建"归因                    # 未找到 DSH launcher（DSH_BIN=…）
﹣ 真实启动：裸 home 能 boot 并 dump 出组合（T03 的决定性用例） # 未找到 DSH launcher（DSH_BIN=…）
﹣ a linked replay package composes into the profile              # 未找到 DSH launcher（DSH_BIN=…）
﹣ replay failure is the reported fault, not a missing credential  # 未找到 DSH launcher（DSH_BIN=…）
﹣ a fixture without a `version` field is rejected by the codec     # fixture 缺失（DSH_FIXTURES=…，找不到 …\session.jsonl）
﹣ a fixture with no recorded model calls fails loudly instead of silently # fixture 缺失（…）
﹣ the real host yields a populated symbol surface                  # 未找到真实宿主 node_modules（DSH_HOST_NODE_MODULES=…）

pass 163 / skipped 11 / fail 0        → 离线 job 保持绿色
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

### 方案 D：从 **npm** 装一份宿主（✅ 已实测，推荐用于插件仓库的 CI）

**这是目前唯一在真实 CI 上验证过、且不依赖特定平台的接入方式**，`mofanx/deepseek-eda-plugins` 的 `dsh-gate.yml` 用的就是它。

关键事实：**`@deepseek-ai/dsh` 本身就发布在 npm 上**，而且是**完整安装** —— 自带 `dsh-base` / `dsh-headless` / `dsh-app-boot` 与 stock `headless` profile，不是空壳。于是 runner 上**不需要准备任何桌面打包产物**：

```yaml
env:
  HOST_DIR: .dsh-host
steps:
  - name: 安装被测宿主
    run: |
      mkdir -p "$HOST_DIR"
      # 不要用 `npm init -y`：它从目录名推导包名，点开头的目录名是非法 npm 包名
      printf '%s' '{"name":"dsh-host-under-test","private":true,"version":"0.0.0"}' > "$HOST_DIR/package.json"
      npm install --no-audit --no-fund --prefix "$HOST_DIR" "@deepseek-ai/dsh@${{ matrix.host }}"
      # 断言布局：宿主结构若变化，这里给出明确报错，而不是让后续步骤含糊失败
      test -f "$HOST_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
```

然后把两个变量指过去（注意是 **`$HOST_DIR/node_modules`**，不是包目录）：

```
DSH_BIN                = $HOST_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js
DSH_HOST_NODE_MODULES  = $HOST_DIR/node_modules
```

**版本怎么选**（两个 dist-tag 对应两条线，实测）：

| dist-tag | 版本 | 含义 |
|---|---|---|
| `latest` | `0.2.0-rc.2` | 桌面线（用户实际装到的那条） |
| `alpha` | `0.2.1-alpha.4` | 源码线（下一版） |

- **PR 必需检查用固定版本**（写死 `@0.2.0-rc.2`），矩阵同时覆盖两条线 —— 结论可复现，上游发新版不会突然让你的 PR 变红。
- **另设一条金丝雀**（跟 dist-tag 走、`continue-on-error`、只在定时/手动触发）：上游发新版时提前知道插件会不会被禁用，而不阻塞任何人。
- **`DSH_FIXTURES` 仍无法从 npm 取得**：replay 的 fixture 用例在 npm 宿主下依旧会 skip（那是 DSH 源码仓库里的测试数据），需要走方案 C。

**三条必须记住的使用前提**：

1. **先构建再探测**。运行时激活探针验证的是**交付物**，而插件入口通常是构建产物（`lib/index.js`）—— 未构建时每一行都会 `failed to import` 并抛 `ERR_MODULE_NOT_FOUND`（这是症状，原因是没有构建）。探针现在会自行检查并单列「未构建的包」，但正确做法是先 `pnpm install --frozen-lockfile && pnpm run build`。
2. **门禁自身要钉 revision**。被测插件仓库应把测试仓库 checkout 到一个**commit**（而非分支）再跑门禁；门禁跟着 `main` 漂移会让"同一份代码给出不同结论"，也会让一次失败的归因变得不可能。
3. **要跑 replay 车道，就得再装一份与宿主同版本的测试支撑包**。`@deepseek-ai/dsh-llm-replay` 与 `@deepseek-ai/dsh-session-snapshot` 与 DSH **同步发版**，且把自己的 peer 钉成**精确版本** —— 拿一条线的支撑包去跑另一条线，宿主自带的兼容性预检会直接禁用它，replay 车道随之失败。按宿主实际版本补装即可：

   ```bash
   HOST_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOST_DIR+'/node_modules/@deepseek-ai/dsh-app-boot/package.json','utf8')).version)")
   npm install --no-audit --no-fund --no-save --prefix "$HOST_DIR" \
     "@deepseek-ai/dsh-llm-replay@$HOST_VERSION" "@deepseek-ai/dsh-session-snapshot@$HOST_VERSION"
   ```

   `resolveInstalledPackage` **优先取宿主里的那一份**，取不到才回退到 testkit 自己锁定的版本 —— 所以不装也能跑，只是那几例 replay 用例会带着一段明确原因跳过（写明两边版本），而不是含糊失败。

   > ⚠️ **不要按 dist-tag 装这两个包**：它们的 tag 映射与 `@deepseek-ai/dsh` **不一致**（`dsh-llm-replay` 的 `latest` 是 `0.0.1-rc.1`，而 `dsh` 的 `latest` 是 `0.2.0-rc.2`），照 tag 装会装出跨线的组合。一律以宿主实际版本为准。

> **平台**：以上在 `ubuntu-latest` 上实测跑通 —— npm 宿主在 Linux 上能正常启动到兼容性预检之后。所以"真实宿主车道必须 Windows/macOS"只对**桌面打包产物**成立。

### 建议的 job 结构

区分"快而必须绿"与"真实但昂贵"两类，不要让后者阻塞每个人的 PR：

- **主 job（ubuntu，必需）**：离线用例 + 门禁自检。永远要绿。
- **真实宿主 job**：两条子车道，**建议都跑**——**静态门禁**（秒级，便宜）与**运行时探针**（真实启动，几十秒）。用方案 D 的**双线矩阵**（`latest` + `alpha` 两条宿主线），并把它设为 PR 必需检查；固定版本 ⇒ 可复现。
- **金丝雀 job（定时/手动，允许失败）**：跟 dist-tag 走，只跑探针 —— 用来提前发现"上游发新版会不会禁用我的插件"。
- 若坚持用**桌面打包宿主**（方案 A），那部分才需要 windows/macos runner，并且适合放在按需/定时车道而不是 PR 必需检查。

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
| CI 全绿但你不确定那 11 例跑没跑 | skip 与 pass 在汇总里是分开计数的 | 看 `skipped` 计数；为 0 才说明 11 例真的执行了 |
