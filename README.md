# dsh-plugin-testing

DSH 插件测试基建 monorepo。

- **管理层 / 决策者** → 先看 [`docs/exec-summary.md`](docs/exec-summary.md)：一页纸，覆盖什么、成本、待拍板事项。
- **非技术读者（产品 / 项目经理）** → 先看 [`docs/overview.md`](docs/overview.md)：讲清两个包各防什么、为什么值得投入。
- **开发者 / 测试** → 团队入口文档是 [`docs/testing-guide.md`](docs/testing-guide.md)，先读它。

| 目录 | 内容 |
|---|---|
| `packages/testkit/` | 测试工具包：一次性隔离 home、keyless 回放、with-key 车道、**运行时激活探针**（`dsh-plugin-activate`） |
| `packages/conformance/` | 静态门禁 CLI（`DSH-C0xx` 规则族）+ API 用量核对 + 宿主基线生成 + 移除 API 数据表（`removed-apis.json`） |
| `docs/` | **一页纸汇报（管理层）** + 一页看懂（非技术入门）+ 团队指南 + 契约 v1 + CI 真实宿主接入 + **真实验证报告** + 变更记录 |
| `templates/` | 体检卡 / 兼容性矩阵模板 |
| `baselines/` | **历史**宿主的 API 基线归档（当前宿主活动基线在 `packages/conformance/api-baseline.json`） |
| `fixtures/` | 门禁自检夹具（合成插件 + 合成宿主，完全离线）；另有运行时探针的**受控对照夹具**（`sample-plugin` / `incompatible-plugin`，只差一个 peer 范围） |

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

单测与离线门禁**不需要**任何环境变量；只有"真实启动 / 回放 / API 面核对"这类集成用例需要定位真实宿主与 fixture。三个变量均**可覆盖**默认值（默认值是维护机上的打包安装路径）。共 **10 例**依赖它们（9 例真实启动 + 1 例宿主 API 面）；缺安装时**自动跳过并给出原因**（写明变量名 + 具体路径），CI 保持绿色。**要求、接入步骤与版本影响详见 [`docs/ci-real-host.md`](docs/ci-real-host.md)。**

| 变量 | 用途 | 覆盖目标 |
|---|---|---|
| `DSH_BIN` | 打包启动器 `bin.js` 的路径 | `testkit/tests/home.spec.mjs`、`testkit/tests/replay.spec.mjs`、`testkit/tests/activate.spec.mjs` |
| `DSH_FIXTURES` | 主仓 session-snapshot 的 `record-suite` fixture 目录 | `testkit/tests/replay.spec.mjs` |
| `DSH_HOST_NODE_MODULES` | 真实打包宿主的 `node_modules` 目录 | `conformance/tests/api-surface.spec.mjs` |

## 落地待办

- [x] **npm scope 与许可证已拍板**：两包为 `@deepseek-ai/dsh-plugin-*` + `private: true` + `license: "UNLICENSED"`。scope 只是标识符（`private: true` 让它们**不可能**被发布），`UNLICENSED` 是 npm 文档对"私有、不授予任何权利"的标准写法 —— 留空与"忘了填"无法区分，而 `MIT` 是虚标。**若内网 registry 用别的 scope，改名是两条命令**，见 [`docs/intranet-porting.md`](docs/intranet-porting.md)。
- [ ] **内网 GitLab 迁移**：本仓 CI 是 GitHub Actions，门禁靠 `actions/checkout` 跨仓拉取。内网需要 GitLab CI 版本 + 内网 registry 的宿主来源 —— 步骤、分叉面清单与"单向搬运"的工作方式见 [`docs/intranet-porting.md`](docs/intranet-porting.md)。仓库里已放一份 `.gitlab-ci.yml` 起手模板（**未在真实 GitLab runner 上验证过**）。
- [ ] 确认最终仓库地址（当前 CHANGELOG 记为 `github.com/mofanx/dsh-plugin-testing`；内网迁移后地址会变，见上面那条）。
- [ ] CI 上若要**真正执行**那 10 例（当前全跳过），需在 runner 提供宿主安装与 fixture —— **要求、步骤与版本影响见 [`docs/ci-real-host.md`](docs/ci-real-host.md)**。注意打包 launcher 是 Windows/macOS 产物，**Linux runner 跑不了真实启动用例**（那 9 例需要 Windows/macOS runner）。

## 版本约定

两个包**锁步版本**（同升同降）。API 基线：当前宿主活动基线在 `packages/conformance/api-baseline.json`，历史宿主基线在 `baselines/<宿主版本>.json`（如 `0.2.0-rc.2.json`），不重复维护同一份。

宿主移除 API 的声明在 [`packages/conformance/removed-apis.json`](packages/conformance/removed-apis.json)——**新增同类移除只加一条数据，不改代码**；门禁（`DSH-C044`）读表并按宿主版本分级，测试用 `api-baseline.json` 交叉验证数据表正确性。
