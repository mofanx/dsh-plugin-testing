# 已记录的宿主 API 面（`host-surfaces/`）

这里每个文件都是**一台真实宿主**上采集下来的 `@deepseek-ai/*` 公开 API 面，供
`dsh-plugin-host-matrix --surfaces` 做 T18 交叉核对（规则码 `DSH-C069`）。

| 文件 | 宿主版本 | 包数 |
|---|---|---|
| `surface-0.2.0-rc.2.json` | `0.2.0-rc.2` | 288 |
| `surface-0.2.1-alpha.1.json` | `0.2.1-alpha.1` | 290 |
| `surface-0.2.1-alpha.2.json` | `0.2.1-alpha.2` | 299 |
| `surface-0.2.1-alpha.3.json` | `0.2.1-alpha.3` | 302 |
| `surface-0.2.1-alpha.4.json` | `0.2.1-alpha.4` | 306 |

选这 5 个版本的理由：它们**恰好**是当前 EDA 插件声明覆盖区间的全部（`[0.2.0-rc.2, 0.2.1-alpha.4]`），
所以那个仓库的每一个覆盖格子都能得到结论，而不是"未知"。清单本身有 33 个已发布版本 ——
**没记录面的版本一律算未知，不算通过**，工具会如实打印出来。

## 重新生成

```bash
# 1. 装一台宿主（版本必须写精确值）
mkdir -p /tmp/host && cd /tmp/host
echo '{"name":"dsh-probe-host","private":true,"version":"0.0.0","dependencies":{"@deepseek-ai/dsh":"0.2.1-alpha.4"}}' > package.json
npm install --no-audit --no-fund

# 2. 采集（产物自带 hostVersion，文件名只是给人看的）
node packages/conformance/src/cli-api.mjs \
  --host /tmp/host/node_modules \
  --baseline fixtures/host-surfaces/surface-0.2.1-alpha.4.json --write
```

> **依赖版本必须写精确值，不能写 `^`。** `^0.2.1-alpha.2` **不是**"alpha.2"：
> 按预发布元组规则它会解析到同一个 `[0,2,1]` 元组里**最新的**预发布版本（实测装出来是
> `alpha.4`）。这一点在生成这些文件时真的踩到过。

## 为什么把生成物提交进仓库

与 `fixtures/host-versions.published.json` 同一个理由：**检查时不得联网**。
一个在检查时联网取数据的判定，结论会随上游变化而**不随提交变化**，既不可复现也不可评审。
代价是这份记录会随时间过时 —— 上游发新版本后需要重新生成并提交；在那之前，
矩阵只会**不完整**（新版本算未知），而不会给出错误的绿灯。

## 这个目录**不是**测试夹具

T18 的单元测试用的是 `fixtures/api-usage/surfaces/` 里的**合成**面（`1.0.0` / `2.0.0`），
故意造出"同一份代码在一个版本上通过、在另一个版本上报错"的对照。两者不要混用：
把真实面放进测试目录会让"检测能力"的证明变成"碰巧真实数据里没有这个缺陷"。
