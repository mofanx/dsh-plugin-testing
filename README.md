# dsh-plugin-testing

DSH 插件测试基建 monorepo。**团队入口文档是 [`docs/testing-guide.md`](docs/testing-guide.md)** —— 先读它。

| 目录 | 内容 |
|---|---|
| `packages/testkit/` | 测试工具包：一次性隔离 home、keyless 回放、with-key 车道 |
| `packages/conformance/` | 静态门禁 CLI（`DSH-C0xx` 规则族）+ API 用量核对 + 宿主基线生成 |
| `docs/` | 团队指南 + 契约 v1 |
| `templates/` | 体检卡 / 兼容性矩阵模板 |
| `baselines/` | 每宿主版本一份的 API 基线归档 |
| `fixtures/` | 门禁自检夹具（合成插件 + 合成宿主，完全离线） |

## 快速开始

```bash
pnpm install          # 或 npm install（各包独立可用）
pnpm test             # = node --test 两包全部单元用例
pnpm selfcheck        # 门禁对合成夹具自检（预期 exit 0、1 warn）
```

对真实插件体检：复制 `packages/conformance/conformance.config.example.json` 为本地配置（已 gitignore 的 `*.local.json`），把 `packages` 指向插件仓库后运行：

```bash
node packages/conformance/src/run-all.mjs --config conformance.local.json
```

## 版本约定

两个包**锁步版本**（同升同降）；`baselines/` 以宿主版本命名（如 `0.2.0-rc.2.json`）。
