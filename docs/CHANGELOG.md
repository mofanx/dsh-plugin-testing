# 变更记录（团队可见）

> 本文件只记录**团队可感知**的变化（工具能力、契约、文档、模板）。完整决策史由测试负责人个人维护，需查阅时向其索取。

格式：`日期 | 版本 | 内容`。两个包（testkit / conformance）**锁步版本**，版本号随本记录升位。

## 2026-10-15

| 版本 | 内容 |
|---|---|
| **v0.4** | **门禁不再会"空转通过"**：新增 `DSH-C070`（配置显式声明的路径不存在）/ `DSH-C071`（目标模式未匹配到任何目标），二者均为 error；目标数为 0 时 CLI 以 **exit 2** 退出并逐个打印未匹配的模式，且 `runAll` 的 `ok` 现在**蕴含"至少检查过一个目标"**（此前空集上 `every()` 恒真）。此前路径写错会静默跳过整组检查、甚至以 exit 0"通过"。**误报修复**：`DSH-C042` 不再对不写 `./` 前缀的 `dsh.bundle.patch` 误报；`DSH-C062` 改用 semver 比较器判定，覆盖 `>=1.0.0`、`<=3.0.0`、`>=1 <3`、连字符区间等旧正则漏掉的形态。`DSH-C000` 不再因 manifest 与 peer 两趟各报一次而重复计数。`diagnoseRange` 的方向判定与满足性判定统一 `includePrerelease` 策略。**testkit**：新增包根导出 `.`（此前文档里的裸导入会 `ERR_PACKAGE_PATH_NOT_EXPORTED`）；真实启动用例在进程无法启动时报告具体 errno 并 skip，不再伪装成 launcher 失败；回放测试的 session root 收进一次性 home，不再写入工作目录。**打包**：conformance 的 `files` 补上 `removed-apis.json` / `api-baseline.json` / `scripts`（此前发布产物会缺数据表而 fail）。**组合装载**：`group: true` 是**载体**而非模块（boot 把 `group: true` 解析为内建 `cordis:group` / `@deepseek-ai/cordis-plugin-group`，并刻意豁免它的 disabled 跳过），已从"可导入行"中排除 —— 修掉任何合法 group 声明都触发**阻断级** `DSH-C053`「没有模块名」的误报，并阻止载体污染 T15 的挂载包集合（`packageRoot('cordis:group')` 曾把内建名当成"已挂载的包"）；载体的 `disabled` 仍照常向子行传播。**发布面**：两个包移除 `license: "MIT"` —— 仓库没有 LICENSE 文件、著作权归属未定，不虚标许可。**DX**：所有环境性 skip 现在都写明原因（变量名 + 缺失路径）—— 此前 5 例只显示无解释的 `# SKIP`，CI 上无法排查该配哪个变量。**文档**：新增 `docs/overview.md`（面向产品/非技术读者）、`docs/exec-summary.md`（面向管理层的一页纸汇报）与 `docs/ci-real-host.md`（CI 接入真实宿主：三个变量的要求、接入步骤、版本影响）。 |

## 2026-10-14

| 版本 | 内容 |
|---|---|
| **v0.3** | CI 上线：GitHub Actions，node 22/24 双矩阵跑双套件 + 离线门禁自检；PR 即自动体检 |
| **v0.2** | 仓库落定 `github.com/mofanx/dsh-plugin-testing`；新增门禁自检夹具 `fixtures/`（合成插件+合成宿主，`npm run selfcheck` 完全离线）；`baselines/` 按宿主版本归档 |
| **v0.1** | 初始交付：`packages/testkit`（隔离 home / keyless 回放 / with-key 车道）+ `packages/conformance`（静态门禁 `DSH-C0xx` + API 用量核对）+ 团队指南 + 契约 v1 草案 + 体检卡/矩阵模板 |

## 约定

- 门禁规则、退出码、契约条目（C1–C5）的任何变更都会在此记录并同步进指南。
- API 基线：**当前宿主**的活动基线统一在 `packages/conformance/api-baseline.json`；**历史宿主**基线在 `baselines/<宿主版本>.json`，旧文件不删（供升级对比）。
