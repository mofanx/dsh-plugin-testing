# 变更记录（团队可见）

> 本文件只记录**团队可感知**的变化（工具能力、契约、文档、模板）。完整决策史由测试负责人个人维护，需查阅时向其索取。

格式：`日期 | 版本 | 内容`。两个包（testkit / conformance）**锁步版本**，版本号随本记录升位。

## 2026-10-16

| 版本 | 内容 |
|---|---|
| **v0.8** | **新增 `DSH-C067`：把 peer 的"安装期"维度建模进来（规则数 35 → 36）**。暴露方式是把门禁接进真实插件仓库的 CI —— 需要**同时**对"桌面线 `0.2.0-rc.2`"与"源码线 `0.2.1-alpha.4`"两条宿主线判定。两条线都跑绿之后复盘发现：**修复前的单范围 `>=0.2.0-rc.2 <0.3.0` 在源码线上运行时放行、安装期会被 npm/pnpm 拒绝**，而当时门禁对这种形态**无能为力** —— 它只按 `includePrerelease: true` 求值（与运行时一致），于是判定"满足"，**给一个安装期会失败的声明开了绿灯**。新码判据是 `satisfies(v,r) && !satisfiesInstallTime(v,r)`：`includePrerelease` 只会放宽准入，所以这一个方向就是**全部分歧集合**。级别为 **warn**（运行时确实不会拒绝，插件仍能加载），消息直接给出宿主未被覆盖的 `[major,minor,patch]` 元组与并集写法。**刻意不并入 `C060`**：`C060` 是"运行时真的不要这个插件"（error，改法是移动界或走豁免），`C067` 是"运行时放行、安装器拒绝"（warn，改法是写并集）—— 成因、改法、严重度三者皆不同，合并会让修复指引失真。**验证**：正对照（修复前单范围 + 源码线宿主 → `C067` ×1，消息点名未覆盖的元组 `0.2.1`）、负对照（同一包 + 桌面线宿主 → 零发现）、以及真实 EDA 包（修复后的并集）在**两条宿主线上均 0 error / 0 warn**。**同时修掉探针的一处归因缺陷**：`did not activate` 此前只报数量，CI 首次落地时正是被这条**无法归因**的失败卡住（既可能是被测插件，也可能是平台不支持的宿主自身行）；宿主在聚合行后会逐行打印 `<rowId> (<packageName>): <detail>`，现在解析出来并在报告与 `--json` 中列出。用例数 163 → **169**（全部通过）。 |

## 2026-10-15

| 版本 | 内容 |
|---|---|
| **v0.7** | **补回丢失的运行时验证车道（T16 运行时激活探针）**。此前证明"插件在无任何 `compatibility.json` 豁免下被运行时自然放行"的那份探针脚本**随 monorepo 合并丢失**，结论无法从本仓库复现 —— 而静态门禁替代不了它（门禁只读文件、不启动 DSH），"运行时到底有没有禁用这一行"恰恰是最需要活证据的判定。现在 `testkit` 提供 `probeActivation()` 原语与 `dsh-plugin-activate` CLI（退出码与门禁一致：0 通过 / 1 关注行被禁用或启动失败 / 2 用法错误或没匹配到任何包），隔离 home + 链接被测包 + **真实启动**，断言无 `disabling profile plugin` / 无 `did not activate` / 无 pending / 无 `plugin tree failed to load`。**三条实测结论**：① **`--dump-config` 不能替代真实启动** —— 一个 peer 不兼容的行会原样出现在 dump 里，既没有 `disabled: true` 也没有任何诊断（预检只在真实 boot 时跑），用 dump 冒充会对本车道要抓的用例报告成功；② 探针**自证能检出**：仓库内新增 `fixtures/incompatible-plugin`，与既有的 `fixtures/sample-plugin` **只差一个 peer 范围**，构成受控实验，`--expect-disabled` 又反过来证明它并非"永远失败"；③ 对 `mofanx/deepseek-eda-plugins` A/B：修复前 `a2819a3` **2 行被运行时禁用**（`optional-schematic`、`optional-tool-schematic`，原因正是 peer `>=0.2.1-alpha.2` 与打包宿主 `0.2.0-rc.2` 不兼容），修复后 `9547271` **0 行被禁用**且启动越过预检 —— v0.6 的插件修复由此获得运行时活证据，而不只是静态门禁变绿。**不需要凭据与外部服务**：预检在第一次模型调用之前执行，隔离 home 稳定终止于 `MISSING_CREDENTIAL`，走到这一步本身就是"启动已越过预检"的证据；探针据此主动清理凭据环境变量，避免"通过"偷偷依赖真实模型调用。**顺带修正一处判据错误**：行 id 由插入它的补丁作者决定（bundle 可把 `@scope/dsh-plugin-a` 挂成 `optional-a`），按包名匹配的 `expectActive`/`expectDisabled` **必须**同时解析禁用原因里的包名，否则会把自己要盯的那条禁用误判为"非关注行"。用例数 149 → **163**（全部通过）。 |
| **v0.6** | **peer 语义指导修正 + `C030` 给出可直接粘贴的值**。① 契约与 testing-guide 原先称"单个范围 `>=0.2.0-rc.2 <0.3.0` 即可同时覆盖 `0.2.0-rc.x` 与 `0.2.1-alpha.x` 两条线" —— 实测表明这**只对运行时预检成立**：运行时传 `includePrerelease: true`（`dsh-app-boot/lib/index.js:300`，全树唯一一处），而 npm/pnpm **安装期**用裸 semver，预发布只被同 `[major,minor,patch]` 元组的比较器接纳，单范围会**拒绝** `0.2.1-alpha.2`（源码线开发流程会看到 peer 不满足）。**并集严格占优**（两种语义都成立），已改为推荐写法；检查器只建模运行时那一维，这个建模边界也已写明，避免"门禁给绿灯 = 安装期也没问题"的误读。② `DSH-C030`（缺 `engines.dsh`）现在**直接给出该写的字符串** —— 由本包 `@deepseek-ai/dsh-*` peer 范围推导（`C063` 用 `!==` 比较，必须逐字一致），范围不统一时要求先统一，cordis-only 包则明确说明"没有 dsh-* peer、可不声明"，不再让作者靠猜（此前 5 个包因此搁置该 warn）。**回灌证据**：据本轮结论修复 `mofanx/deepseek-eda-plugins`（9 条 peer 改并集 + 补 `engines.dsh` + 版本 `0.1.0-alpha.2` + 删除已无用的 `compatibility.json`），门禁从 8 error / 9 warn 变为 **0 error / 0 warn 且无需任何豁免**；详见 `validation-report.md` 第九节。 |
| **v0.5** | **豁免语义与运行时对齐，新增报告范围收敛**。① `DSH-C060`（peer 不满足宿主）此前**无条件**判 error，于是"命中 `compatibility.json` 豁免"也只能消除 `DSH-C064`、门禁依旧失败 —— 这与运行时不一致：`dsh-app-boot` 的 `preflight()` 在 `issue.exempted` 为真时返回"无冲突"，**该行并不会被禁用**。现在命中覆盖该宿主版本的豁免时 `C060` **降级为 warn**（消息内写明命中的豁免 key 与宿主版本），未命中（包名 / 版本 / 宿主任一不匹配）仍为 error —— 门禁判定与运行时**逐分支一致**。② 新增可选配置 **`focusPackages`**：组合检查是 profile 级，会连带报出宿主自带组件与第三方插件的问题（实测 3 条，其中 `C050` 为 error 级，作者无法修复），`focusPackages`（包名，支持 `*`）把 `C050`/`C056` 的**归属报告范围**收敛到自己的包；profile 自身的 `dependencies` **永远在范围内**，被过滤条目**计数并打印**，不静默丢弃。③ `summarize` 改为按 `code\|severity` 分组 —— 同一代码在同一次运行中出现两种级别是合法状态（正是上面的降级），按 `code` 单键合并会让"降级"在汇总里消失且计数失真。**触发本次改动的实测证据**：真实插件仓库 `mofanx/deepseek-eda-plugins@a2819a3` 上，修复前 **8 error / 16 warn（失败）**，修复后 **0 error / 14 warn（通过）**，且所有事实仍以 warn 可见。 |
| **v0.4** | **门禁不再会"空转通过"**：新增 `DSH-C070`（配置显式声明的路径不存在）/ `DSH-C071`（目标模式未匹配到任何目标），二者均为 error；目标数为 0 时 CLI 以 **exit 2** 退出并逐个打印未匹配的模式，且 `runAll` 的 `ok` 现在**蕴含"至少检查过一个目标"**（此前空集上 `every()` 恒真）。此前路径写错会静默跳过整组检查、甚至以 exit 0"通过"。**误报修复**：`DSH-C042` 不再对不写 `./` 前缀的 `dsh.bundle.patch` 误报；`DSH-C062` 改用 semver 比较器判定，覆盖 `>=1.0.0`、`<=3.0.0`、`>=1 <3`、连字符区间等旧正则漏掉的形态。`DSH-C000` 不再因 manifest 与 peer 两趟各报一次而重复计数。`diagnoseRange` 的方向判定与满足性判定统一 `includePrerelease` 策略。**testkit**：新增包根导出 `.`（此前文档里的裸导入会 `ERR_PACKAGE_PATH_NOT_EXPORTED`）；真实启动用例在进程无法启动时报告具体 errno 并 skip，不再伪装成 launcher 失败；回放测试的 session root 收进一次性 home，不再写入工作目录。**打包**：conformance 的 `files` 补上 `removed-apis.json` / `api-baseline.json` / `scripts`（此前发布产物会缺数据表而 fail）。**组合装载**：`group: true` 是**载体**而非模块（boot 把 `group: true` 解析为内建 `cordis:group` / `@deepseek-ai/cordis-plugin-group`，并刻意豁免它的 disabled 跳过），已从"可导入行"中排除 —— 修掉任何合法 group 声明都触发**阻断级** `DSH-C053`「没有模块名」的误报，并阻止载体污染 T15 的挂载包集合（`packageRoot('cordis:group')` 曾把内建名当成"已挂载的包"）；载体的 `disabled` 仍照常向子行传播。**发布面**：两个包移除 `license: "MIT"` —— 仓库没有 LICENSE 文件、著作权归属未定，不虚标许可。**DX**：所有环境性 skip 现在都写明原因（变量名 + 缺失路径）—— 此前 5 例只显示无解释的 `# SKIP`，CI 上无法排查该配哪个变量。**文档**：新增 `docs/overview.md`（面向产品/非技术读者）、`docs/exec-summary.md`（面向管理层的一页纸汇报）、`docs/ci-real-host.md`（CI 接入真实宿主：三个变量的要求、接入步骤、版本影响）与 `docs/validation-report.md`（在真实插件仓库 `mofanx/deepseek-eda-plugins@a2819a3` 上的效果验证：14 条真实问题、0 误报；并据 A/B 实验修正了豁免语义的表述 —— `compatibility.json` 只消除 `DSH-C064`，**不消除 `DSH-C060`**，豁免三要素完全匹配时门禁仍会失败。该语义随后由同日 **v0.5** 正式改为"命中豁免时 `C060` 降级为 warn"，见上）。 |

## 2026-10-14

| 版本 | 内容 |
|---|---|
| **v0.3** | CI 上线：GitHub Actions，node 22/24 双矩阵跑双套件 + 离线门禁自检；PR 即自动体检 |
| **v0.2** | 仓库落定 `github.com/mofanx/dsh-plugin-testing`；新增门禁自检夹具 `fixtures/`（合成插件+合成宿主，`npm run selfcheck` 完全离线）；`baselines/` 按宿主版本归档 |
| **v0.1** | 初始交付：`packages/testkit`（隔离 home / keyless 回放 / with-key 车道）+ `packages/conformance`（静态门禁 `DSH-C0xx` + API 用量核对）+ 团队指南 + 契约 v1 草案 + 体检卡/矩阵模板 |

## 约定

- 门禁规则、退出码、契约条目（C1–C5）的任何变更都会在此记录并同步进指南。
- API 基线：**当前宿主**的活动基线统一在 `packages/conformance/api-baseline.json`；**历史宿主**基线在 `baselines/<宿主版本>.json`，旧文件不删（供升级对比）。
