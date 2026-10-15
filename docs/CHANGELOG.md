# 变更记录（团队可见）

> 本文件只记录**团队可感知**的变化（工具能力、契约、文档、模板）。完整决策史由测试负责人个人维护，需查阅时向其索取。

格式：`日期 | 版本 | 内容`。两个包（testkit / conformance）**锁步版本**，版本号随本记录升位。

## 2026-10-14

| 版本 | 内容 |
|---|---|
| **v0.3** | CI 上线：GitHub Actions，node 22/24 双矩阵跑双套件 + 离线门禁自检；PR 即自动体检 |
| **v0.2** | 仓库落定 `github.com/mofanx/dsh-plugin-testing`；新增门禁自检夹具 `fixtures/`（合成插件+合成宿主，`npm run selfcheck` 完全离线）；`baselines/` 按宿主版本归档 |
| **v0.1** | 初始交付：`packages/testkit`（隔离 home / keyless 回放 / with-key 车道）+ `packages/conformance`（静态门禁 `DSH-C0xx` + API 用量核对）+ 团队指南 + 契约 v1 草案 + 体检卡/矩阵模板 |

## 约定

- 门禁规则、退出码、契约条目（C1–C5）的任何变更都会在此记录并同步进指南。
- API 基线：**当前宿主**的活动基线统一在 `packages/conformance/api-baseline.json`；**历史宿主**基线在 `baselines/<宿主版本>.json`，旧文件不删（供升级对比）。
