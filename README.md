# dsh-plugin-testing

DSH 插件测试基建 monorepo。**团队入口文档是 [`docs/testing-guide.md`](docs/testing-guide.md)** —— 先读它。

| 目录 | 内容 |
|---|---|
| `packages/testkit/` | 测试工具包：一次性隔离 home、keyless 回放、with-key 车道 |
| `packages/conformance/` | 静态门禁 CLI（`DSH-C0xx` 规则族）+ API 用量核对 + 宿主基线生成 + 移除 API 数据表（`removed-apis.json`） |
| `docs/` | 团队指南 + 契约 v1 |
| `templates/` | 体检卡 / 兼容性矩阵模板 |
| `baselines/` | **历史**宿主的 API 基线归档（当前宿主活动基线在 `packages/conformance/api-baseline.json`） |
| `fixtures/` | 门禁自检夹具（合成插件 + 合成宿主，完全离线） |

## 快速开始

```bash
# 两包各自独立安装（各自提交 package-lock.json，无根级 workspace）
npm install           # 在 packages/conformance 与 packages/testkit 各执行一次
npm test              # 根目录：node --test 两包全部单元用例
npm run selfcheck     # 门禁对合成夹具自检（预期 exit 0、1 warn）
```

对真实插件体检：复制 `packages/conformance/conformance.config.example.json` 为本地配置（已 gitignore 的 `*.local.json`），把 `packages` 指向插件仓库后运行：

```bash
node packages/conformance/src/run-all.mjs --config conformance.local.json
```

## 环境变量（集成测试定位真实宿主）

单测与离线门禁**不需要**任何环境变量；只有"真实启动 / 回放 / API 面核对"这类集成用例需要定位真实宿主与 fixture。三个变量均**可覆盖**默认值（默认值是维护机上的打包安装路径，路径不存在时相关用例自动 skip）：

| 变量 | 用途 | 覆盖目标 |
|---|---|---|
| `DSH_BIN` | 打包启动器 `bin.js` 的路径 | `testkit/tests/home.spec.mjs`、`testkit/tests/replay.spec.mjs` |
| `DSH_FIXTURES` | 主仓 session-snapshot 的 `record-suite` fixture 目录 | `testkit/tests/replay.spec.mjs` |
| `DSH_HOST_NODE_MODULES` | 真实打包宿主的 `node_modules` 目录 | `conformance/tests/api-surface.spec.mjs` |

## 落地待办（合入团队仓间开发仓库前）

- [ ] 确定真实 npm scope，替换两包 `package.json` 的 `@your-scope/` 占位名（同步更新 `packages/testkit/README.md` 与 `docs/contract-v1.md` 中的示例 import 名）。
- [ ] 确认最终仓库地址（当前 CHANGELOG 记为 `github.com/mofanx/dsh-plugin-testing`）。
- [ ] 本机集成测试依赖 `DSH_BIN` / `DSH_FIXTURES` / `DSH_HOST_NODE_MODULES` 三个环境变量（或保持默认路径）；CI 上若需跑真实启动/回放集成用例，需在 runner 提供宿主安装与 fixture。

## 版本约定

两个包**锁步版本**（同升同降）。API 基线：当前宿主活动基线在 `packages/conformance/api-baseline.json`，历史宿主基线在 `baselines/<宿主版本>.json`（如 `0.2.0-rc.2.json`），不重复维护同一份。

宿主移除 API 的声明在 [`packages/conformance/removed-apis.json`](packages/conformance/removed-apis.json)——**新增同类移除只加一条数据，不改代码**；门禁（`DSH-C044`）读表并按宿主版本分级，测试用 `api-baseline.json` 交叉验证数据表正确性。
