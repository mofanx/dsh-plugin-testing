# 真实验证报告：拿一个真实插件仓库跑门禁

> 目的：检验本项目**在真实插件仓库上到底有没有用**，而不是只在自造的夹具上通过。
> 结论：**发现 14 条真实问题、0 条误报**；其中一条是你本机配置里此前不可见的缺陷。

## 一、被验证对象

| 项 | 值 |
|---|---|
| 插件仓库 | [`mofanx/deepseek-eda-plugins`](https://github.com/mofanx/deepseek-eda-plugins) |
| 提交 | `a2819a3` |
| 形态 | pnpm monorepo，**5 个插件包**（bundle / sch / easyeda / sch-gen / core） |
| 宿主 | DSH 桌面打包版 `0.2.0-rc.2` |
| 结果 | **8 error / 16 warn → exit 1** |

复现命令（配置放在被测仓库之外）：

```bash
node packages/conformance/src/run-all.mjs --config eda.conformance.json
```

配置内容：

```json
{
  "hostNodeModules": "<DSH 安装>/resources/app/node_modules",
  "dshHome": "<用户 home>/.dsh",
  "packages": ["<插件仓库>/packages/*"],
  "profiles": ["<用户 home>/.dsh/profiles/desktop"]
}
```

## 二、关键结论：静态层根本不需要连嘉立创 EDA

原先的担心是"这个插件要连嘉立创 EDA，CI 里跑不起来"。**这个担心只对真实启动那一层成立。** 本轮跑的是自动检查（静态层）—— 它只读文件、不启动 DSH、不联网，所以：

- **不需要** EDA 客户端、**不需要**模型凭据、**不需要**构建产物（`lib/` 都没构建也能查）；
- 几秒内就给出了结论。

这正好印证了两个包的分工：**静态层管"看起来装不装得上去"，真实启动层才管"跑起来对不对"**。前者在 CI 里永远能跑，后者需要宿主环境。

## 三、命中的 8 条规则（全部为真）

| 规则 | 次数 | 实际含义 |
|---|---|---|
| `DSH-C060` | 5 | 插件 peer 要求 `@deepseek-ai/dsh-* >=0.2.1-alpha.2`，**宿主实际是 `0.2.0-rc.2`** → 低于下界 |
| `DSH-C057` | 4 | cordis 要求 `>=4.0.5-alpha.1`，宿主实际 `4.0.4`（运行时**不预检** cordis，故为提醒） |
| `DSH-C030` | 5 | 5 个包都没声明 `engines.dsh`，宿主兼容性无法表达 |
| `DSH-C064` | 3→2 | 存在不满足的 peer，但**没有生效的豁免** |
| `DSH-C065` | 3 | **豁免条目已失效**（详见下节） |
| `DSH-C056` | 3 | profile 里的包把宿主工具包放进 `dependencies`（提醒级） |
| `DSH-C066` | 1 | `eda-core` 是**支撑包**（非挂载行），peer 不满足 → **降级为提醒**而非阻断 |
| `DSH-C050` | 1 | `dsh-agent-plugins-market` 把宿主**核心包** `dsh-home-paths` 放进 `dependencies` |

### 最有价值的一条：`DSH-C060`

**这 5 个插件在当前桌面版 DSH 上是装不上去的** —— 它们的 peer 要求 `>=0.2.1-alpha.2`，而打包桌面版是 `0.2.0-rc.2`。宿主会在挂载时拒绝这些行。

这正是契约 §〇 早就记录过的口径（团队插件 peer 落在 0.2.1 线上），但**此前只是一个文档说明，现在变成了门禁可自动检测的结论**。

### 同样有价值的：`DSH-C065` + `DSH-C064` 互相印证

你 `~/.dsh/profiles/desktop/compatibility.json` 里写的是：

```json
"@deepseek-ai/dsh-plugin-eda-sch@0.1.0": ["0.2.0-rc.2"]
```

但插件的**实际版本是 `0.1.0-alpha.1`**。豁免是按"包名@版本"精确匹配的，所以：

- `DSH-C064`：判定"没有对应豁免"（因为 key 对不上）；
- `DSH-C065`：判定"你那条豁免已失效，当前版本是 0.1.0-alpha.1"。

**你也以为已经豁免了，实际一条都没生效。** 这类"写了但没生效"的静默失效，此前没有任何机制能发现 —— 这是本轮验证最有实操价值的产出。

## 四、正确地"保持沉默"同样重要

门禁的可信度取决于**不误报**。本轮以下几条在真实数据上验证了"该静默就静默"：

| 规则 | 为什么容易误报 | 实际结果 |
|---|---|---|
| `DSH-C062` | 跨主版本范围判定 | **未报** —— `>=0.2.1-alpha.2 <0.3.0`、`>=4.0.5-alpha.1 <4.1.0` 都是有界单主版本，正确放行 |
| `DSH-C042` | patch 是否被 exports 覆盖 | **未报** —— `schematic-bundle` 的 `./cordis.patch.yml` 确实被 exports 覆盖 |
| `DSH-C050` | 依赖名以 `@deepseek-ai/dsh-` 开头 | **未误判** `dsh-plugin-eda-sch` 等 —— 宿主核心包按"精选白名单"定级别，`readdir` 只扩大检出、不抬高级别，所以"插件依赖插件"不会被报成阻断错误 |
| `DSH-C051`~`C055` | 组合装载 | **未报** —— 该 profile 的组合是干净的（无重复 id、无悬空 patch） |
| `DSH-C040`/`C041`/`C043` | exports 完整性 | **未报** —— 5 个包的 exports 都完整 |

## 五、关于 `DSH-C056` 那三条：是真事实，但不是你的锅

`dsh-lsp-stdio`、`dsh-tool-lsp` 被报了 C056。核实结果：

- 它们**不在宿主树里**（`resources/app/node_modules` 下不存在），而在 **profile 的 `node_modules`** 里；
- 代码里的 `hostProvided()` 守卫是"宿主树里有没有"，所以正确地**没有跳过**它们；
- 它们依赖的 `dsh-util-values` 确实在宿主树里。

所以这不是误报，而是**归属问题**：这两条是 **DSH 自带的组件**、以及 `dsh-agent-plugins-market`（第三方插件），都不是你写的，你也没法改。

**这是本轮暴露出的唯一一个设计改进点**：组合检查是 **profile 级**的，会报告 profile 里**所有**包的问题，包括作者无法控制的包。对"检查自己的插件"这个主用例来说，这会引入噪声；而其中 `DSH-C050` 那条是 **error 级**，足以让一次门禁失败在别人的包上。

建议（未实施，待你定）：给配置加一个"只关注我自己的包"的过滤项（如 `focusPackages`），把 profile 级发现的**报告**范围收敛到作者的包，同时保留完整分析。

## 六、诚实说明：本轮**没有**覆盖的部分

- **真实启动（testkit 那一层）未验证**：需要 DSH 能 boot 且插件能装载，前置条件正是 `DSH-C060` 指出的"当前桌面版装不上"。也就是说，**静态层先拦住了，真实启动层根本走不到** —— 顺序是对的。**（已于第十一节补齐：探针重建后实测确认"修复前 2 行被禁用 / 修复后 0 行"，这条缺口现已闭环。）**
- **`DSH-C070`/`DSH-C071`（门禁自身配置）本轮未触发**：它们只在配置写错时报警，本轮配置是正确的。这两条已在单元用例与"路径写错"探针中单独验证过。
- **未在 CI runner 上跑**：本轮是在本机跑的。CI 化的要求见 [`ci-real-host.md`](ci-real-host.md)。

## 七、追加发现（A/B 实验证明）：豁免**只消除 `C064`，不消除 `C060`**

在真实仓库上顺带发现一个此前没人验证过的语义：**`compatibility.json` 豁免并不能让一个 peer 不满足的插件通过门禁。**

A/B 实验（人造探针插件，peer 要求 `@deepseek-ai/dsh-llm >=9.0.0`，宿主 `0.2.0-rc.2`）：

| 场景 | 报出的规则 | 结果 |
|---|---|---|
| **无豁免** | `C060` + `C064` + `C062` | 3 error |
| **豁免完全匹配**（包名、版本、宿主三者都对） | `C060` + `C062` | **2 error —— `C064` 消失，`C060` 仍在** |

即：`C060`（"peer 不满足"这个**事实**）不受豁免影响；豁免只消除 `C064`（"**未记录**"这个流程项）。

**实际影响**：对 `deepseek-eda-plugins` 这种"我知道不满足、但我就是要它跑在 `0.2.0-rc.2` 上"的情况 —— **把豁免 key 修对也不会让门禁变绿**。团队只有两条路：改 peer 范围，或长期接受一个红色门禁。

**这暴露了本项目文档里一处不成立的论述**：契约 §7 决策的理由③ 说"确有临时需要的插件走既有的 `compatibility.json` 豁免通道"，并据此论证"不必放宽 `C062`"。但实测表明该通道**并不能**让插件通过门禁，所以它**不是一条真正的出口**。（§7 的**结论**仍然成立 —— 理由①与②独立支撑；但理由③需要修正，或需要下面这个改动才能成立。）

**决策与落地（同日完成，见第八节）：采纳降级** —— 原待决策项为"是否让"**有覆盖的豁免**"把 `C060` 从 error 降级为提醒？

- **支持改动**：运行时**确实**会依据 `compatibility.json` 放行该插件（`peer.mjs` 注释与运行时行为都如此），所以"门禁判 error、运行时放行"本身是**不一致**的；降级后豁免才成为真正的"已知偏差"通道，与运行时行为对齐，同时把事实保留为可见的提醒。
- **反对改动**：保持 `C060` 无条件，好处是**谁也不能靠写一个配置文件把红灯刷成绿灯**，不兼容事实永远显形。

已采纳：契约的 `DSH-C060` 行、§四 4.3、§7 决策与回归用例均已同步（见第八节）。

### 运行时侧的确证（读 `dsh-app-boot` 源码）

`resources/app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` 的 `preflight()`：

```js
const issue = evaluatePluginCompatibility(manifest, exemptions);
return issue === void 0 || issue.exempted ? void 0 : pluginCompatibilityWarning(issue);
// 返回非 undefined → conflict → deny(row, conflict) → row.disabled = true
```

即：

- **没有生效的豁免** → 运行时把该行 `row.disabled = true`，**插件在启动时被静默禁用**；
- **有生效的豁免**（`issue.exempted`）→ 返回 `void 0`，**不判冲突，插件正常加载**。

由此得到一个清晰的结论：

1. **未豁免时 `C060` 判 error 完全正确** —— 运行时确实会禁用该行；
2. **已豁免时 `C060` 判 error 与运行时不一致** —— 运行时会放行，插件的实际后果是"能加载"，不是"被禁用"。

### 对你这套 EDA 插件的直接后果（重要）

你三条豁免的 key 写成 `@0.1.0`，而插件实际版本是 `0.1.0-alpha.1` → `issue.exempted` 为 **false** → **运行时正在启动时静默禁用这几个插件行**（stderr 会打印 `disabling profile plugin ...`）。

**所以这不只是"门禁报告不好看"，而是你本机上这些插件实际跑不起来的原因。** 把 key 改成 `@0.1.0-alpha.1` 即可让运行时按其原意放行。

## 八、修复与复验（同日落地）

本节记录**第七节那个待决策项**的落地结果，以及两项改动在同一真实仓库上的复验。

### 1. `DSH-C060`：命中豁免时降级为 warn

依据运行时的逐分支行为 —— 运行时放行 → 门禁不该判阻断；运行时禁用 → 门禁必须判阻断：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 无豁免 / 豁免未覆盖 | `C060` error + `C064` error + `C062` error | **不变**（`C060` error + `C064` error + `C062` error） |
| 豁免三要素完全匹配 | `C060` error + `C062` error | `C060` **warn**（消息内注明豁免 key 与宿主版本）+ `C062` error |

即：**事实一条没少，只是分级与运行时对齐了**。豁免未覆盖（包名 / 版本 / 宿主任一不匹配）时仍为 error，所以"写个配置文件就把红灯刷绿"依然做不到。

### 2. 新增 `focusPackages`（报告范围收敛）

第七节指出的归属噪声已可消除：`focusPackages`（包名，支持 `*`）把 `C050`/`C056` 的**归属报告范围**收敛到作者自己的包。边界是刻意划的：

- 只影响**报告范围**，不改变检查本身；
- profile 自身的 `dependencies` **永远在范围内**（那是作者要修的）；
- 被过滤的条目**计数并打印**，不静默丢弃。

### 3. 复验结果（同一个真实仓库、同一条命令）

| 阶段 | 结果 |
|---|---|
| 修复前 | 8 error / 16 warn → **失败**（exit 1） |
| 修复后 | **0 error / 14 warn → 通过**（exit 0） |

修复后的规则明细：`C030` ×5、`C060` ×4（全部降级为 warn 并注明豁免依据）、`C057` ×4、`C066` ×1，另打印 `已按关注范围过滤：4 条非关注包的 profile 级依赖发现（未计入上述汇总）`。

### 4. 你本机 `compatibility.json` 的 key 已修正

三条 `@0.1.0` → `@0.1.0-alpha.1`，运行时据此放行这些插件行；`C064` / `C065` 随之消失。

### 5. 回归用例（新增 5 条，全量 146 pass / 0 fail）

C060 降级正例、C060 未覆盖保持 error 的反例（三种不匹配形态）、`summarize` 同码不同级必须分列、`focusPackages` 过滤并计数、profile 自身依赖不被过滤。

## 九、插件侧修复（双向改进闭环）

本轮把验证发现的问题**回灌到被验证的插件仓库**（`mofanx/deepseek-eda-plugins`），完成双向改进的闭环。

### 1. 插件侧改了什么

`9547271`（`master`，5 个 `package.json`，**纯 manifest 变更、无需重新构建 `lib/`**）：

| 项 | 改动 |
|---|---|
| 9 条 peer 范围 | 改为**并集**，同时覆盖打包宿主 `0.2.0-rc.2` 与源码线 `0.2.1-alpha.2` |
| 5 个包 | 补 `engines.dsh`（与各包 `dsh-*` peer 逐字一致，避免 `C063`） |
| 版本 | `0.1.0-alpha.1` → `0.1.0-alpha.2` |
| 本机 profile | 删除 `compatibility.json`（备份为 `.bak-20261015`）—— **不再需要任何豁免** |

### 2. 效果

| 阶段 | 门禁结果 |
|---|---|
| 修复前（带豁免） | 0 error / 14 warn |
| 修复前（无豁免 —— 运行时的真实处境） | 8 error / 9 warn |
| **修复后（无任何豁免）** | **0 error / 0 warn** |

逐条消除：`C030` ×5、`C060` ×4、`C057` ×4、`C066` ×1 全部消失，`C064` 从未出现。中间态还顺带验证了 `C065` ×3 —— 版本 bump 后门禁立刻指出"豁免已失效"，这正是豁免失效检测该做的事。

### 3. 为什么 peer 必须是并集（本轮最重要的技术结论）

契约原先写"单个范围 `>=0.2.0-rc.2 <0.3.0` 即可同时覆盖两条线"，这个说法**只对运行时预检成立**：

| 范围 | 运行时 `includePrerelease:true` | 裸 semver（npm/pnpm 安装期） |
|---|---|---|
| `>=0.2.0-rc.2 <0.3.0` | 两条线都 ✓ | `0.2.1-alpha.2` **✗** |
| 并集 `A \|\| B` | 都 ✓ | **都 ✓** |

依据：运行时预检传 `includePrerelease: true`（`dsh-app-boot/lib/index.js:300`，**全树唯一一处**）；而 npm/pnpm 安装期用裸 semver，预发布只被同 `[major,minor,patch]` 元组的比较器接纳。**并集严格占优**，契约与 testing-guide 已按此修正。

### 4. 同时暴露的测试项目缺口

变更清单里"无豁免运行时探针 5/5 全过"的复现脚本 `eda-probe-no-exemption.mjs` **随 monorepo 合并丢失**，其复跑路径已不存在 —— 该结论一度**无法从本仓库复现**。静态门禁替代不了它（门禁只读文件、不启动 DSH）。**已列为下一步首要事项，并已在第十节重建完成。**

## 十、运行时探针重建（T16，同日闭环）

第九节证明了插件修复让**静态门禁**变绿；但"宿主到底有没有禁用这一行"只有真实启动能回答。本节把那条丢失的车道补回来，并用它给 v0.6 的插件修复补上**运行时活证据**。

### 1. 落地形态

| 交付物 | 作用 |
|---|---|
| `packages/testkit/src/activate.mjs` | `probeActivation()` 原语：隔离 home + 链接被测包 + 真实启动 + 解析启动诊断 |
| `packages/testkit/src/activate-cli.mjs` | `dsh-plugin-activate` CLI，供 CI 调用；退出码与门禁一致（0/1/2） |
| `fixtures/incompatible-plugin/` | 新增反面夹具，与 `fixtures/sample-plugin` **只差一个 peer 范围** |
| `packages/testkit/tests/activate.spec.mjs` | 18 条用例（12 条纯逻辑 + 6 条真实启动），含探针自证与"未构建"归因 |

### 2. 三条实测结论

**① `--dump-config` 不能替代真实启动** —— 这是设计这条车道时最关键的一条事实。实测：把 `@probe/plugin`（peer `>=9.0.0`）挂进一次性 home，`--dump-config` **exit 0、stderr 为空**，该行**原样出现在 dump 里，既没有 `disabled: true` 也没有任何诊断**。原因是兼容性预检只在真实 boot 的 entry 准备阶段执行，dump 只是静态组合渲染。**用 dump 冒充这条车道，会恰好对本车道要抓的用例报告成功。**

**② 探针自证能检出（不是"永远失败"）** —— 受控实验：两个夹具的 `lib/index.js` 逐字相同，唯一变量是 peer 范围。

| 夹具 | peer 范围 | 探针判定 |
|---|---|---|
| `fixtures/sample-plugin` | `>=0.2.0-rc.2 <0.3.0` | `ok = true`，0 条禁用 |
| `fixtures/incompatible-plugin` | `>=9.0.0` | `ok = false`，1 条禁用，包名解析正确 |

`--expect-disabled` 再把反面翻回来：断言"这个行**必须**被禁用"时探针**通过** —— 证明它既能检出、又不是无条件失败。

**③ EDA 插件 A/B：v0.6 的修复在运行时真实生效**

两侧都用**已构建**的检出复跑同一条命令（同宿主 `0.2.0-rc.2`、同平台），所以差异只可能来自插件代码：

| | 修复前 `a2819a3` | 修复后 `9547271`（及当前 `c73b92f`） |
|---|---|---|
| 探针判定 | **失败**（exit 1） | **通过**（exit 0） |
| 被运行时禁用的行 | **2 条**：`optional-schematic`、`optional-tool-schematic` | **0 条** |
| 禁用原因 | peer `>=0.2.1-alpha.2` 与宿主 `0.2.0-rc.2` 不兼容；诊断里明写 `Exact-version exemption: not active.` | — |
| **受影响的挂载行** | **3 条**（见下） | **0 条** |
| `did not activate` | true | false |
| 终止状态 | `MISSING_CREDENTIAL`（已越过预检） | `MISSING_CREDENTIAL`（已越过预检） |

**一个此前被低估的细节：真实爆炸半径是 3 行，不是 2 行。** 在同一份输出里还有第三条：

```
未激活的行  :
  ✗ @deepseek-ai/dsh-plugin-eda-easyeda（row optional-schematic-easyeda）：pending (waiting for service: schematic)
```

它不是"又被禁用了"，而是**级联**：`optional-schematic` 正是 `schematic` 服务的提供者，它被禁用后，依赖该服务的 `optional-schematic-easyeda` 就永远等不到服务。也就是说**一个写错的 peer 范围连带拖垮了一个依赖它的插件**。

这条也纠正了一个容易想当然的因果：**它是被「未激活的行」的可归因列表抓到的，不是被 `pending` 判据抓到的**。本次输出里 `启动诊断: didNotActivate=true pending=false` —— `pending` 为 false，因为宿主**没有**打印 `Plugins waiting for services (N):` 那条聚合行，而探针的 `pending` 判据盯的正是那条聚合行，是**另一条**独立信号。真正指出第三行的是 v0.8.1 才做的「`did not activate` 列表可归因」（`<rowId> (<packageName>): <detail>`）—— 在那之前这里只会有一句"1 plugin did not activate"，读者无从知道是谁。

（顺带说明判据为何这样分工：`did not activate` 在**已有**禁用行时不再单独计为失败原因，否则每个禁用都会被重复计一次、`expectDisabled` 将永远无法通过；但没有禁用行时它就是"启动失败且兼容性预检解释不了"的信号。）

复跑命令（不需要 EDA 客户端、不需要模型凭据）：

```bash
dsh-plugin-activate \
  --packages "D:/projects/nodejs/deepseek-eda-plugins/packages/*" \
  --bundle @deepseek-ai/dsh-plugin-eda-bundle \
  --expect-active @deepseek-ai/dsh-plugin-eda-sch
```

### 3. 不需要凭据与外部服务，且不允许偷偷依赖

预检在第一次模型调用**之前**执行，所以隔离 home（无 `compatibility.json`、无凭据）稳定终止于 `MISSING_CREDENTIAL` —— **走到这一步本身就是"启动已越过预检"的证据**。探针据此**主动清理**凭据环境变量（`--allow-credentials` 可关闭），以免一次"通过"悄悄依赖了真实模型调用。

### 4. 本轮又抓到的一个自身缺陷（双向改进再次生效）

首次实现里 `expectActive` 只比对**行 id**。实测立刻暴露问题：EDA bundle 把 `@deepseek-ai/dsh-plugin-eda-sch` 挂成了行 id `optional-schematic`，于是"我盯的包被禁用了"被误判成**非关注行**，探针反而放行。修正为**同时解析禁用原因里的包名**（`Plugin <包名>@<版本> is incompatible`）后判定恢复正确。同类问题还让 `expectDisabled` 无法匹配（运行时标签是行 id，调用方给的是包名），由新增用例抓出并一并修正。

**这印证了本项目的价值主张**：门禁/探针自身也会出错，而"能自证能检出"的受控实验是用例，不是声明。

### 5. 用例数

149 → **163**，全部通过、0 skip（本机有打包宿主）。其中 testkit 39 条（`home` 12 + `replay` 13 + `activate` 14），含 9 条真实启动用例。

## 十一、接进真实插件仓库的 CI：暴露的安装期维度（`DSH-C067`）与四个落地障碍

第十节让探针在本机可用；本节把它和静态门禁一起接进 `mofanx/deepseek-eda-plugins` 的 CI，并记录落地过程中暴露的两个测试项目自身问题 —— 其中一个是**门禁的盲区**，比前几轮的问题更值得记。

### 1. CI 形态（宿主从 npm 取，双线矩阵）

关键发现：**`@deepseek-ai/dsh` 本身发布在 npm 上**，且是**完整安装**（自带 `dsh-base` / `dsh-headless` / `dsh-app-boot` 与 stock `headless` profile）。因此 runner 上**不需要准备桌面打包产物**，两条车道都能在普通 runner 上跑：

| 宿主线 | 版本 | 含义 |
|---|---|---|
| 桌面线 | `0.2.0-rc.2`（npm `latest`） | 用户实际装到的那条 |
| 源码线 | `0.2.1-alpha.4`（npm `alpha`） | 下一版 DSH |

矩阵用**固定版本**（保证确定性）；另有一条**金丝雀**车道跟 `latest`/`alpha` 两个 dist-tag 走，`continue-on-error`、只在定时/手动触发 —— 上游发新版时提前知道插件会不会被禁用，而不阻塞任何 PR。门禁自身钉死在测试仓库的一个 commit（`TESTING_REV`）：门禁跟着 `main` 漂移会让"同一份代码给出不同结论"。

### 2. 第一次运行暴露的两个问题（安装期维度与探针归因）

**① `npm init -y` 在点开头目录下直接失败**（11 秒即红）：

```
npm error Invalid name: ".dsh-host"
```

`npm init -y` 从**目录名**推导包名，而点开头的名字是非法 npm 包名。**本机干跑没暴露它** —— 因为我当初是用显式 `package.json` 建的宿主目录，而不是 `npm init`。改为写死合法 `package.json` + `npm install --prefix`，并显式断言 `lib/bin.js` 存在（宿主布局若变化会给出明确报错，而不是让探针在后续步骤报一个含糊的失败）。workflow 末尾"本地复跑"注释里的同一条错误配方也一并修正 —— 否则下一个人照抄会踩同一个坑。

**② 探针的 `did not activate` **无法归因**（真正的工具缺陷）**：宿主的聚合行只说*有几个*插件没起来，而 CI 上"是我的插件没起来"与"是宿主自身某行在这个平台起不来"是完全不同的结论。修好安装后两条车道里，静态门禁在两条宿主线上都通过，探针却报：

```
运行时禁用的行：无
终止状态    : MISSING_CREDENTIAL
启动诊断    : didNotActivate=true pending=false loadFailure=false
结论：失败
  - 有插件 did not activate（启动失败），且没有任何行因兼容性被禁用 —— 需查启动日志
```

注意到 `终止状态 = MISSING_CREDENTIAL` 说明**启动已经越过兼容性预检**，所以失败与 peer 无关；但报告里没有任何线索指向具体是哪一行。查源码后确认宿主**本来就逐行打印**（`inactiveDiagnostic`：`<rowId> (<packageName>): <detail>`，紧跟在聚合行之后），只是探针把它丢掉了。现已解析并在报告与 `--json` 中列出，失败信息形如 `—— @scope/pkg（row some-id）`。**这条正是"CI 落地才发现"的问题**：本机跑时宿主所有行都能起来，聚合计数恒为 0，缺陷不可见。

### 3. 新规则 `DSH-C067`：门禁此前**给一条安装期会失败的声明开了绿灯**

双线矩阵跑绿之后复盘，发现了一个**门禁的盲区**（不是插件的问题）：v0.6 之前的单范围写法

```
"@deepseek-ai/dsh-llm": ">=0.2.0-rc.2 <0.3.0"
```

在**桌面线**上完全正确；但在**源码线** `0.2.1-alpha.4` 上，运行时预检放行它（`includePrerelease: true`），而 npm/pnpm 的裸 semver **拒绝**它（预发布只被带**同一 `[major,minor,patch]` 元组预发布**的比较器接纳，而该范围只覆盖 `0.2.0` 元组）。**当时的门禁对这种形态无能为力** —— 它只按运行时那一维求值，于是判"满足"。也就是说：门禁会给一条装不上的声明报绿。

新码判据 `satisfies(v,r) && !satisfiesInstallTime(v,r)`（`includePrerelease` 只会放宽准入，故这一个方向即**全部分歧集合**），级别 **warn**。**刻意不并入 `C060`**：`C060` 是"运行时真的不要这个插件"（error，改法是移动界或走豁免），`C067` 是"运行时放行、安装器拒绝"（warn，改法是写并集）—— 成因、改法、严重度三者皆不同。

**受控验证**（同一份带 `engines.dsh`/`exports`/入口的合成包，只改宿主与范围）：

| 场景 | 宿主 | 范围 | 结果 |
|---|---|---|---|
| 正对照 | `0.2.1-alpha.4` | `>=0.2.0-rc.2 <0.3.0`（修复前单范围） | **`DSH-C067` ×1**，消息点名未覆盖的元组 `0.2.1` 并给出并集写法；`0 error / 1 warn` |
| 负对照 | `0.2.0-rc.2` | 同上 | 零发现（两种语义都成立） |
| 真实包（修复后并集） | 两条线都跑 | `>=0.2.0-rc.2 <0.3.0 \|\| >=0.2.1-alpha.2 <0.3.0` | **0 error / 0 warn**（不误报） |

### 4. 第三个问题：未构建的检出（CI 再次暴露）

换用带归因的探针重跑 CI，答案立刻明确：

```
未激活的行  :
  ✗ @deepseek-ai/dsh-plugin-eda-sch（row optional-schematic）：failed to import
    Error [ERR_MODULE_NOT_FOUND]: Cannot find module
    '/tmp/dsh-test-home-…/node_modules/@deepseek-ai/dsh-plugin-eda-sch/lib/index.js'
```

**既不是插件的问题，也不是 Linux 的问题** —— `lib/index.js` 是 `tsc -b` 的**构建产物**，不在仓库里；CI 从不构建，而本机验证时用的恰好是**已构建**的开发检出。也就是说：**探针验证的是交付物，所以它必须在构建之后运行**，这一点此前的 CI 配方与文档都没写。

两处改进（都已落地）：
1. **CI 侧**：在跑车道 B 之前 `pnpm install --frozen-lockfile && pnpm run build`。
2. **探针侧**：在启动前检查每个链接包**声明**的入口文件是否存在（`inspectEntry`），并输出独立的「未构建的包」一节 —— 让"没构建"与"坏了"分开，而不是让调用方去读一句 `ERR_MODULE_NOT_FOUND`。

本地已按 CI 条件复刻验证（把 5 个包的 `package.json` 复制到临时目录、不带 `lib/`）：未构建 → 5 个包全部被列出、退出码 1；已构建的开发检出 → `MISSING_CREDENTIAL`、退出码 0。

### 5. 第四个问题：测试支撑包把 replay 车道钉死在一条宿主线上

把上面几步都修好后，`0.2.0-rc.2` 那条线全绿，**`0.2.1-alpha.4` 却在 replay 上红了一条**：

```
✖ replay failure is the reported fault, not a missing credential
  ✖ AssertionError: The input did not match /llm-replay: a fixture path is required/
    '…"reason":{"kind":"error","error":{"message":"no adapter registered for provider
      \"deepseek-official\"","code":"NO_ADAPTER"}}}'
  dsh: disabling profile plugin row "llm-replay": Plugin @deepseek-ai/dsh-llm-replay@0.2.0-rc.2
       is incompatible with dsh 0.2.1-alpha.4: requirements {"@deepseek-ai/dsh-llm":"0.2.0-rc.2",…}
```

**根因是测试项目自身的一处设计缺陷，而且它正是本项目一直在教别人别犯的那个错**：testkit 把 `@deepseek-ai/dsh-llm-replay` 与 `@deepseek-ai/dsh-session-snapshot` 声明为自己的依赖并**精确锁定** `0.2.0-rc.2`，而这两个包把自己的 peer 也钉成了**精确版本**（`"@deepseek-ai/dsh-llm": "0.2.0-rc.2"` —— 比"单范围"更窄的极端形态）。于是拿它去跑另一条宿主线时，**宿主自己的预检**把 replay 行禁用了。一个教别人"范围要能跨线"的项目，自己的测试支撑却只覆盖一条线。

**两侧修复**：

1. `resolveInstalledPackage` 改为**优先取宿主里的那一份**（`$DSH_HOST_NODE_MODULES`），取不到才回退到 testkit 锁定的版本。于是"把匹配版本装进宿主"就能让 replay 车道在**任意**宿主线上跑通 —— 实测 alpha 线上 `pass 170 / fail 0 / skipped 2`。
2. 拿不到匹配版本时**不再含糊失败**，而是带着两边版本号明确跳过：

   ```
   ﹣ replay failure is the reported fault, … # 宿主 0.2.1-alpha.4 禁用了 dsh-llm-replay@0.2.0-rc.2：
     该测试支撑包的 peer 是**精确版本**，只与它自己那条线兼容。把匹配的 0.2.1-alpha.4 版装进宿主
     node_modules 即可启用本车道（resolveInstalledPackage 优先取宿主里的那一份）
   ```

   这个跳过是**收窄判定**的：只有在"宿主自己说它不兼容"**且**"版本确实不同"时才跳过；同版本下被禁用仍会失败。

**顺带发现的一个坑**：这两个测试支撑包的 **dist-tag 映射与 `@deepseek-ai/dsh` 不一致**（`dsh-llm-replay` 的 `latest` 是 `0.0.1-rc.1`，而 `dsh` 的 `latest` 是 `0.2.0-rc.2`）。照 tag 装会装出跨线的组合，必须一律以宿主实际版本为准。

> 这一条**只有真实 CI 的多宿主线矩阵才可能发现**：本机固定在打包宿主上跑，两条线永远"恰好匹配"。

### 6. 用例数（最终）

163 → **174**，全部通过、0 skip（本机有打包宿主）。其中 conformance 129、testkit 45。新增 11 条：`C067` 三类 + 语义钉死 + 作用域边界（5）、探针归因与区间守卫（2）、`inspectEntry` 入口解析（1）、"入口未构建"真实启动（1）、`resolveInstalledPackage` 的宿主优先解析（1）、级联受害者（pending detail）的可归因（1）。规则码 35 → **36**；离线/需真实宿主的分界：**163 / 11**。

### 7. 最终结果：两条车道 × 两条宿主线全绿

修复后重跑（`668c29c`，门禁钉 `f0b4eac`），**两条宿主线 × 两条车道全部通过**（run [38838324105](https://github.com/mofanx/deepseek-eda-plugins/actions/runs/38838324105)）。车道 B 在 `ubuntu-latest` 上的实测输出：

```
DSH 插件运行时激活探针
  launcher    : …/.dsh-host/node_modules/@deepseek-ai/dsh/lib/bin.js
  被测包      : 5 个（eda-bundle / eda-core / eda-easyeda / eda-sch / eda-sch-gen @0.1.0-alpha.2）
运行时禁用的行：无
终止状态    : MISSING_CREDENTIAL
启动诊断    : didNotActivate=false pending=false loadFailure=false
结论：通过 —— 关注的行均未被运行时禁用，且启动已越过兼容性预检
```

两点值得记下：

- **这条车道确实有检出能力，而且证据就是它自己此前的那次失败** —— 同一条命令曾在同一平台上报出 3 行 `failed to import`。一条从不失败的检查无法证明任何事；这条的灵敏度是被一次真实失败证明的。
- **`didNotActivate=false` 是对 EDA 插件行的直接断言**，不只是"宿主起来了"：它意味着树里**没有任何一行**启动失败，而 EDA 的三行（`optional-schematic` / `optional-schematic-easyeda` / `optional-tool-schematic`）正是在这个 bundle 补丁里挂载的。

至此"插件修复 → 静态门禁 → 运行时探针 → 真实 CI"四层证据齐备，且最后一层可被任何人用一条命令复跑。

### 8. 本仓库自己的 CI 闭环（同日）

上面的证据来自**插件仓库**的 CI。本仓库此前只有离线车道，于是那 11 个依赖真实 DSH 的用例**在自己 CI 上一直跳过** —— 探针的集成行为从未被本仓库验证过。补齐后（run [38839862722](https://github.com/mofanx/dsh-plugin-testing/actions/runs/38839862722)）四个 job 全绿，且两条真实宿主线上的断言按设计分别成立：

| job | 结果 | 关键断言（实测输出） |
|---|---|---|
| 离线 node 22 | ✓ | 离线用例全绿；11 例跳过且各带原因 |
| 离线 node 24 | ✓ | 同上 |
| 真实宿主 `0.2.0-rc.2` | ✓ 1m20s | `skipped = 2`；`ok: 桌面线上无 DSH-C067 —— 符合预期` |
| 真实宿主 `0.2.1-alpha.4` | ✓ 1m22s | `skipped = 2`；`ok: 源码线上 DSH-C067 已命中 —— 符合预期` |
| 金丝雀（定时/手动） | 跳过 | 非定时触发时不运行，符合预期 |

三点值得记下：

- **`skipped = 2` 就是"测试支撑包耦合已修好"的证据**：修复前 alpha 线是 `skipped 3 / fail 1`（replay 被宿主预检禁用），现在是 `skipped 2`（只剩那两例需要 DSH **源码** fixture 的用例）。跳过数在这里是一个**正向信号**，而不是被容忍的噪声 —— 所以 CI 里把它断言成 `≤2`。
- **`C067` 的双向断言只有真实预发布宿主能证**：桌面线上两种 semver 语义都成立 → 必须不报；源码线上运行时放行、安装期拒绝 → 必须报。两个方向都在 CI 里钉死了，任何离线用例都替代不了这一条。
- **这条车道是被自己的失败证明有价值的**：它第一次跑就抓到第四个问题（测试支撑包耦合），而那个问题在本机永远看不见 —— 本机固定在打包宿主上，两条线"恰好匹配"。

## 十二、一句话总结

这个项目在真实插件仓库上**找出了 14 条此前不可见的问题、没有一条误报**，其中一条（豁免失效）是需要立刻处理的；而它做到这一点**不需要 EDA 客户端、不需要模型、不需要构建、几秒完成**。
