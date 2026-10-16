# dsh-plugin-conformance

DSH 插件的**静态一致性检查器**。运行时只依赖 `js-yaml`，且**钉在与宿主相同的 `4.3.1`**（见下方设计取舍）。

> ⚠️ 这**不是** DSH 插件，而是一个独立 CLI 工具 —— 它不注册任何 Cordis 服务，不参与插件组合。
>
> ⚠️ **发布状态**：包名为占位 scope `@your-scope/dsh-plugin-conformance`（`private: true`），仅供本仓引用，尚未发布到任何 registry。正式发布前需替换 scope、去掉 `private`，并**确定许可证** —— 本仓无 `LICENSE` 文件，故 `package.json` 已移除 `license` 字段，不虚标 `MIT`。

规则依据：`docs/contract-v1.md` 第六节。每个检查项都有稳定错误码 `DSH-C0xx`，CI 报告与豁免说明均引用它。

## 用法

### 清单与 exports（规则 `DSH-C001…C044`）

```bash
node src/cli.mjs <packageDir...> [--json] [--strict]
```

检查：`name`/`version`、`dsh.bundle.patch`（类型 / 是否存在 / 是否被 `exports` 覆盖）、`dsh.manifestVersion`、`dsh.client`（`platform` 必填、`inject` 类型）、`dsh.profile.bundles`、`engines.dsh`（存在性与 SemVer 语法）、`exports` 的 `.` / `./package.json` / `./client`，以及**已移除的 `./invariant`**。

### 版本与 peer 契约（规则 `DSH-C057`、`DSH-C060…C067`）

```bash
node src/cli-version.mjs <packageDir...> \
  --host "D:\Program Files\DSH NEXT\resources\app\node_modules" \
  --exemptions "$env:DSH_HOME/profiles/desktop/compatibility.json"
```

检查：peer 范围是否满足**宿主实际版本**（区分 `belowMin` / `aboveMax`）、peer 是否跨主版本、`engines.dsh` 与 peer 是否一致、不满足时**是否有 `compatibility.json` 豁免**、豁免条目是否**因插件版本变更而失效**、以及范围是否**只被运行时接受而会被安装期拒绝**（`DSH-C067`）。

> **`DSH-C060` 与 `DSH-C067` 是两个维度**：`C060` = 运行时**真的不要**这个插件（预检会 `deny(row)`，error）；`C067` = 运行时放行、但**安装期**（npm/pnpm 的裸 semver）判 peer 不满足（warn）。宿主是预发布版本时最容易踩：运行时用 `includePrerelease: true`（见 [`../../docs/contract-v1.md`](../../docs/contract-v1.md) §6），而安装器只接纳带**同一 `[major,minor,patch]` 元组预发布**的比较器。改法是把范围写成并集，例如 `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-alpha.2 <0.3.0`。

> **注意上面那个并集的第二个下界。** `>=0.2.0-rc.2 <0.3.0` 看起来覆盖整个 `0.2.x`，但它的比较器带的是 **`0.2.0`** 预发布元组，所以对 `0.2.1-alpha.1` 这类 **`0.2.1`** 元组的预发布版本，裸 semver **永远**拒绝它 —— 范围再宽也没用。第二个子句的下界必须**恰好是该元组已发布的最小预发布版本**，否则就会漏掉它前面那几个（这正是 `0.2.1-alpha.2` 写法漏掉 `alpha.1` 的原因，见下节）。

### 宿主版本矩阵 —— 推导"兼容哪些宿主版本"（规则 `DSH-C068`，并逐候选复算 `DSH-C067`）

上面那条命令回答的是**单个**宿主："我手上这个宿主，声明接纳吗？"下面这条把方向倒过来：给一份**已发布版本清单**，算出声明**覆盖的集合**。

```bash
node src/cli-host-matrix.mjs <packageDir...> \
  --candidates fixtures/host-versions.published.json
```

它不安装、不启动任何宿主，因此**不需要宿主目录也不需要凭据**，可以在任何机器上跑。输出三类信息：

- **声明覆盖集** —— 清单里哪些版本被接纳，以及区间 `[min, max]`；
- **空洞（`DSH-C068`，error）** —— 落在区间**之内**却不被接纳的已发布版本。"相邻版本都声明支持、中间那版用户却被禁用"就是它；
- **安装期分歧（`DSH-C067`）** —— 运行时接纳但 npm/pnpm 拒绝的版本。

清单是**输入**，不是事实来源，而且**必须随仓库提交、检查时不得联网**：一个在检查时联网的判定，结论会随上游变化而**不随提交变化**，无法复现也无法评审。生成方式：

```bash
npm view @deepseek-ai/dsh versions --json   # 把结果填进清单的 versions，并更新 source/generatedAt
```

**"有意排除"与"遗漏"从声明本身无法区分**，所以清单支持 `knownGaps`（版本 → 原因）。写明原因的降级为 warn（与 `compatibility.json` 豁免同构），没写原因的仍是 error：

```json
{
  "versions": ["0.2.0-rc.2", "0.2.1-alpha.1"],
  "knownGaps": { "0.2.0-rc.1": "该版本缺 dsh-tools 的 symbol，已确认不支持" }
}
```

> **这是"声明覆盖集"，不是"已验证可用集"。** 本命令不安装、不启动任何宿主，它告诉你声明**断言**了哪些版本，不告诉你哪些版本**真的能用**。把推导结果当成实测兼容，正是本项目最要防的假绿 —— 要让某个版本从"声明覆盖"变成"已验证"，得真的在它上面跑（运行时激活探针 / 插件自身测试套件）。

### 代码真正引用的 API 在那些版本上还在不在（规则 `DSH-C069`）

上一节只看**声明**，从不看插件自己的代码。所以它能接纳一个"peer 范围写得没错、但代码 import 了该版本已经删掉的东西"的版本 —— 插件在那个宿主上会在 `import` 阶段直接失败。peer 契约在原理上看不见这件事：一个插件可以满足**全部** peer 范围，同时 import 一个已不存在的符号（`0.2.1` 线删掉 `./invariant` 就是现成的例子）。

补上这一层，只需把已记录的**宿主 API 面**目录一起给它：

```bash
# 先在一台装好的宿主上采集（每个版本一次，约 1 分钟；产物 ~120 KB，建议提交）
node src/cli-api.mjs --host <宿主 node_modules> \
  --baseline fixtures/api-surfaces/surface-<宿主版本>.json --write

# 再把"声明覆盖集"与"代码实际引用的 API"求交
node src/cli-host-matrix.mjs <packageDir...> \
  --candidates fixtures/host-versions.published.json \
  --surfaces fixtures/api-surfaces
```

采集产物自带 `hostVersion`，所以**目录里放哪些版本是自解释的**，不靠文件名猜。检查时**零成本、不联网、不启动宿主**，因此适合每次 PR 都跑（实测探针不适合）。

判据是三种缺失之一：整个包不在该宿主里（`noPackage`）、子路径不存在（`noSubpath`）、子路径在但具名符号没了（`noSymbol`）。三者都是 error —— 它们不是"功能降级"，而是**加载即失败**。

**三条边界，缺一条这个检查就会变成假绿的生产者：**

1. **只核验具名 import。** 命名空间导入、默认导入、动态 `import()`、CJS `require()` 点不出可比的符号名，一律列为「未能核验」，**绝不**因为核验不了就算通过。报告里会逐条打印出来。
2. **没有 API 面的版本算未知，不算通过。** 报告里打印 `？未知`，单独列出 `uncovered`，并且**不进** `apiSafe`。想让格子有结论，就得在那个宿主上补一次 `--write`。
3. **从发布入口出发扫，不扫整棵目录树。** 否则 dev-only 文件会造出幻影依赖。只沿**相对** import 递归（`@scope/other` 是依赖边界，不跨）。

> 单看一份 API 面无法区分"这个包被整个删掉了"（要报）和"这个包本来就不是宿主包"（兄弟包、第三方库，不该报），所以工具用**所有已记录 API 面的并集**当宿主包名全集。少了这一步，monorepo 里每个包都会因为 import 兄弟包而被误报。

> **这是静态结论。** 它只看发布入口里写死的 import，看不见运行期才动态取用的服务（cordis DI 注入的 `ctx.*`）。"静态能过"仍不等于"跑得起来"；它只是把"能不能 import 得到"这一层从"未知"变成"已核"。

### 单一门禁命令 —— CI 入口

```bash
npm run test:conformance          # 跑全部静态检查（清单 + 组合装载 + 版本契约）
npm run test:conformance:strict   # warn 也视为失败（预发 / 发布前）
```

目标由配置声明：复制 `conformance.config.example.json` 为你自己的配置，把路径换成实际值，然后 `node src/run-all.mjs --config 你的配置.json`（也可用 `--host` / `--home` / 环境变量覆盖）:

```json
{
  "hostNodeModules": ".../DSH NEXT/resources/app/node_modules",
  "dshHome": ".../.dsh",
  "packages": ["D:/projects/my-plugins/packages/*"],
  "profiles": [".../.dsh/profiles/desktop"],
  "focusPackages": ["@your-scope/dsh-plugin-*"]
}
```

| 退出码 | 含义 |
|---|---|
| `0` | 通过 |
| `1` | 有 error（`--strict` 下 warn 也算） |
| `2` | 用法错误 / 没有检查目标（含目标模式全部落空） |

`--json` 输出机器可读结果；`--strict` 用于预发门禁。**error 与 warn 的分级是有意的**：`DSH-C030`（缺 `engines.dsh`）这类不阻断运行的问题不该卡住每一次 PR，但发布前必须清零。

### 门禁自身配置（规则 `DSH-C070`、`DSH-C071`）

这一组不检查插件，只检查**门禁有没有真的在检查东西**。两类都是 error —— 一个悄悄少查的门禁会给出虚假的绿灯，比漏报单条规则更危险：

- **`DSH-C070`**：配置**显式声明**的路径不存在（`hostNodeModules` / `dshHome` / `appDir` / `exemptionsPath`）。刻意区分"未配置"（合法，例如不需要宿主版本时）与"配了但不存在"（笔误）—— 后者此前会把宿主版本静默变成 `undefined`，让 `C060`/`C061`/`C064`/`C066` 全部跳过。
- **`DSH-C071`**：`packages` / `profiles` 的某个模式未匹配到任何目标。展开为空集时 `every()` 恒真，门禁会以 exit 0"通过"却一个包都没查。
- 当 `packages` + `profiles` 展开后目标数为 **0** 时，CLI 直接以 **exit 2** 退出并逐个打印未匹配的模式（部分落空 → exit 1 且列出缺口；全部落空 → exit 2）。

**判级取决于"是否被挂载"**：宿主的版本预检只求值它将要 import 的**行**。所以不满足的 peer 在**被挂载为 profile 行的包**上是 `DSH-C060`/`C064`（error，宿主会真的禁用它），在**支撑包**（从不作为行挂载）上只是 `DSH-C066`（warn）。给出的 `profile` 决定了这个判定；不给 profile 时按保守口径全部视为被挂载。

**命中豁免时 `DSH-C060` 降级为 warn**：`dsh-app-boot` 的 `preflight()` 在 `issue.exempted` 为真时返回"无冲突"，该行**不会被禁用** —— 此时"阻断"的含义不成立，所以 `C060` 降级为提醒（消息里写明命中的豁免 key 与宿主版本），`C064` 同时消失。三要素（包名 / 版本 / 宿主版本）任一不匹配就不算命中，`C060` 保持 error。

### 只报告自己的包（`focusPackages`，可选）

组合检查是 **profile 级**的：它读整个 profile，因此会连带报出宿主自带组件与第三方插件的问题（实测中 `dsh-lsp-stdio`、`dsh-tool-lsp`、`dsh-agent-plugins-market`，其中 `C050` 是 error 级）。插件作者跑自己的仓库时，这些包他改不了。

`focusPackages`（包名，支持 `*`）把**报告范围**收敛到自己的包：

```json
{ "focusPackages": ["@your-scope/dsh-plugin-*"] }
```

边界：只影响 `C050`/`C056` 的**归属过滤**，不改变检查本身；profile 自身的 `dependencies` **永远在范围内**（那是作者要修的）；被过滤的条目会**计数并打印**（`已按关注范围过滤：N 条…`），不静默丢弃。

### 组合装载静态分析（规则 `DSH-C050…C056`）

```bash
node src/cli-composition.mjs "$env:DSH_HOME/profiles/desktop" \
  --host "D:\Program Files\DSH NEXT\resources\app\node_modules" \
  --home "$env:DSH_HOME"
```

检查：宿主包被当普通 `dependencies` 引入（核心包 = error `C050`，叶子工具包 = warn `C056`）、lockfile 多版本、**重复 loader entry id**、user/home patch 引用未安装的包、bundle 顺序违反其自身 `order` 声明、patch 指向不存在的 id。

## 测试

```bash
npm test        # node --test "tests/**/*.spec.mjs"
```

测试套件在最后各有一个**完整性断言**：`rules.mjs` 中声明的每个错误码都必须被至少一个用例触发，否则套件失败。这让规则表和测试不会悄悄脱节。

## 设计取舍

- **只依赖 `js-yaml` 与 `semver`**，并**钉死 js-yaml 4.3.1**（宿主同版本）。这不是随便选的：`!!js` 自定义标签的构造 API 在 js-yaml 5 里被 `defineScalarTag` 取代，用错大版本会让 patch 解析方言与 DSH boot 不一致 —— 而组合分析的全部结论都建立在这个方言上。
- **SemVer 用官方 `semver@^7.8.5`（与 `dsh-app-boot` 同版本）**，且满足性判定显式对齐运行时的 `includePrerelease: true`。早期版本曾自实现 npm 子集（默认预发布准入规则），会在预发布宿主（`0.2.1-alpha.x`）上**误报**——运行时放行、检查器拒绝。`tests/version.spec.mjs` 里的预发布回归用例即为此钉住。
- **已知建模边界：只建模"运行时预检"这一维**。npm/pnpm 的安装期 peer 解析用**裸 semver**，预发布只被同 `[major,minor,patch]` 元组的比较器接纳，所以 `>=0.2.0-rc.2 <0.3.0` 这类单范围**运行时放行、安装期被拒**（实测 semver 7.8.5）。检查器对这种情况不会报错 —— 推荐插件统一写**并集**（两种语义都成立）：`>=0.2.0-rc.2 <0.3.0 || >=0.2.1-alpha.2 <0.3.0`。
- **组合算法是移植而非依赖**：`dshmarket/lib/check.js` 不在 `dshmarket` 的 `exports` 中，无法 `import`，因此 `composition.mjs` 复刻其 `composeLayers` 行为，并用测试锁定。
- **不做的事**：不 boot DSH、不联网、不写盘。这是最便宜的一道门禁，也是团队最先撞上的那类错误。
- **层栈必须完整**：`bundle 层 → <app>/cordis.patch.yml → profile patch → $DSH_HOME patch`。少一层就会把合法的 profile patch 误判成孤儿 —— 这个坑已踩过并有回归测试。
- **`group: true` 是载体，不是模块**：boot 把它解析为**内建** `cordis:group` / `@deepseek-ai/cordis-plugin-group`，并刻意豁免它的 disabled 跳过（`if (row.disabled === true && !row.group) continue`）—— 因为该节点本身携带子行列表。所以载体**没有模块名也不该被要求有**：早先把它当作可导入行，会让任何合法的 group 声明都触发**阻断级** `DSH-C053`「没有模块名」。现在载体整体排除出"可导入行"，但它的 `disabled` 仍照常向子行传播，且它不进入 T15 的挂载包集合（否则 `packageRoot('cordis:group')` 会把内建名当成"已挂载的包"）。有回归测试。
