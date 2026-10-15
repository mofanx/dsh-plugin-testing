# 宿主 API 基线归档

本目录只存**历史宿主**的 API 基线（供宿主升级时的 API 面 diff）。

- **当前宿主的活动基线**统一在 [`packages/conformance/api-baseline.json`](../packages/conformance/api-baseline.json)，门禁的 API 用量核对默认读它。
- 当宿主出新版本时：先用 `cli-api.mjs --write` 把活动基线更新到新宿主，再把**旧宿主**的基线从 `packages/conformance/api-baseline.json` 复制到本目录，命名为 `<宿主版本>.json`（命名示例：`0.2.0-rc.2.json`）。
- 旧文件不删，供升级对比（矩阵模板 `--baseline <旧版本>.json` 与新基线 diff）。
- **本目录当前为空**：活动基线仍指向 `0.2.0-rc.2` 这一条线，尚无被替换下来的历史宿主。上一条的 `<宿主版本>.json` 是命名示例，不是已存在的文件。

> 避免在 `packages/conformance/api-baseline.json` 之外再手工维护一份"当前宿主"副本——那会产生字节级重复、并随宿主升级漂移。
