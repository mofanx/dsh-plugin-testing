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

### 版本与 peer 契约（规则 `DSH-C057`、`DSH-C060…C066`）

```bash
node src/cli-version.mjs <packageDir...> \
  --host "D:\Program Files\DSH NEXT\resources\app\node_modules" \
  --exemptions "$env:DSH_HOME/profiles/desktop/compatibility.json"
```

检查：peer 范围是否满足**宿主实际版本**（区分 `belowMin` / `aboveMax`）、peer 是否跨主版本、`engines.dsh` 与 peer 是否一致、不满足时**是否有 `compatibility.json` 豁免**、以及豁免条目是否**因插件版本变更而失效**。

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
