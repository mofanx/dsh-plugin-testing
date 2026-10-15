# dsh-plugin-conformance

DSH 插件的**静态一致性检查器**。运行时只依赖 `js-yaml`，且**钉在与宿主相同的 `4.3.1`**（见下方设计取舍）。

> ⚠️ 这**不是** DSH 插件，而是一个独立 CLI 工具 —— 它不注册任何 Cordis 服务，不参与插件组合。见 `dsh-plugin-test-infrastructure-plan.md` 第二节的架构结论。

规则依据：`dsh-plugin-contract-v1.md` 第六节。每个检查项都有稳定错误码 `DSH-C0xx`，CI 报告与豁免说明均引用它。

## 用法

### 清单与 exports（规则 `DSH-C001…C044`）

```bash
node src/cli.mjs <packageDir...> [--json] [--strict]
```

检查：`name`/`version`、`dsh.bundle.patch`（类型 / 是否存在 / 是否被 `exports` 覆盖）、`dsh.manifestVersion`、`dsh.client`（`platform` 必填、`inject` 类型）、`dsh.profile.bundles`、`engines.dsh`（存在性与 SemVer 语法）、`exports` 的 `.` / `./package.json` / `./client`，以及**已移除的 `./invariant`**。

### 版本与 peer 契约（规则 `DSH-C060…C065`）

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
  "profiles": [".../.dsh/profiles/desktop"]
}
```

| 退出码 | 含义 |
|---|---|
| `0` | 通过 |
| `1` | 有 error（`--strict` 下 warn 也算） |
| `2` | 用法错误 / 没有检查目标 |

`--json` 输出机器可读结果；`--strict` 用于预发门禁。**error 与 warn 的分级是有意的**：`DSH-C030`（缺 `engines.dsh`）这类不阻断运行的问题不该卡住每一次 PR，但发布前必须清零。

**判级取决于"是否被挂载"**：宿主的版本预检只求值它将要 import 的**行**。所以不满足的 peer 在**被挂载为 profile 行的包**上是 `DSH-C060`/`C064`（error，宿主会真的禁用它），在**支撑包**（从不作为行挂载）上只是 `DSH-C066`（warn）。给出的 `profile` 决定了这个判定；不给 profile 时按保守口径全部视为被挂载。

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

- **只依赖 `js-yaml`**，并**钉死 4.3.1**（宿主同版本）。这不是随便选的：`!!js` 自定义标签的构造 API 在 js-yaml 5 里被 `defineScalarTag` 取代，用错大版本会让 patch 解析方言与 DSH boot 不一致 —— 而组合分析的全部结论都建立在这个方言上。
- **自实现 SemVer**：满足性逻辑覆盖 npm 的常用子集（比较器、`^`、`~`、X-range、`||`，以及预发布准入规则）。落入仓库后建议改用官方 `semver` 包，`tests/version.spec.mjs` 即是迁移的安全网。
- **组合算法是移植而非依赖**：`dshmarket/lib/check.js` 不在 `dshmarket` 的 `exports` 中，无法 `import`，因此 `composition.mjs` 复刻其 `composeLayers` 行为，并用测试锁定。
- **不做的事**：不 boot DSH、不联网、不写盘。这是最便宜的一道门禁，也是团队最先撞上的那类错误。
- **层栈必须完整**：`bundle 层 → <app>/cordis.patch.yml → profile patch → $DSH_HOME patch`。少一层就会把合法的 profile patch 误判成孤儿 —— 这个坑已踩过并有回归测试。
