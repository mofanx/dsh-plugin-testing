# 插件体检卡 · `<插件名>@<版本>`（模板）

> 使用方式：复制本文件为 `体检卡-<插件名>-<日期>.md`，替换全部 `<尖括号>` 占位符；每格证据直接摘自命令输出，**不要概括、不要省略错误码**。测试负责人填写，交付插件团队。
> 判读：🟢 = 门禁 exit 0 且冒烟全过；🔴 = 存在 error（宿主会真实拒绝/禁用）；🟡 = 仅 warn（发布前须清零）。

| 元信息 | 值 |
|---|---|
| 扫描日期 | `<YYYY-MM-DD HH:mm>` |
| 宿主版本 | `<版本号>`（安装目录：`<resources/app/node_modules>`） |
| 门禁配置 | `<conformance.local.json>`（由 `conformance.config.example.json` 复制） |
| 覆盖范围 | 静态门禁 ☑ / 启动冒烟 ☐ / keyless 回放 ☐ |
| **总评** | **🔴 error `<N>` / warn `<M>` → exit `<0/1>`** |

## 一、一句话结论

> `<例：插件在宿主 X 上可正常激活；3 个 error 全部来自 peer 范围只声明了源码线，已附经验证的修复 diff（附录 B）。>`

## 二、静态门禁发现（逐条对应 run-all 输出）

| 级别 | 错误码 | 目标 | 摘要 | 修复建议 |
|---|---|---|---|---|
| ✗ error | `DSH-C0xx` | `<包名>` | `<原文摘要>` | `<具体改法；若已实测，注明"已验证">` |
| ! warn | `DSH-C0xx` | `<包名>` | `<原文摘要>` | `<具体改法 / 标注"发布前处理">` |

（零发现时本节写：**零发现**。）

## 三、启动冒烟（真实启动器 + 一次性隔离 home）

| 检查 | 结果 | 证据（日志/流摘录） |
|---|---|---|
| 行激活：无 `disabling profile plugin row`、无 `pending` | ✅ / ❌ | `<摘录>` |
| 工具 / 服务进入模型请求（request/header） | ✅ / ❌ / 不适用 | `<摘录>` |
| 隔离生效：首次模型调用处出现 `MISSING_CREDENTIAL` | ✅ | —— |
| 进程退出语义：`--json` 正常退出（非挂起） | ✅ | `exit=<code>，<耗时>` |
| import 失败 / did not activate | 无 | `<有则附摘录>` |

## 四、keyless 回放（模型交互型插件适用）

| 项 | 结果 |
|---|---|
| fixture 已录制（含真实工具回合，v4） | 是 / 否 |
| 回放：脚本按序供给 / 无 `script exhausted` | ✅ / ❌ |
| 回放：工具真实重跑且结果与录制一致 | ✅ / ❌ |
| 回放：turn `completed` | ✅ / ❌ |

## 五、修复建议（按投入产出排序；能附 diff 就附 diff）

1. `<必修：阻断激活/正确性的问题；给出精确改法>`
2. `<发布前：warn 清零项>`
3. `<可选：hygiene 项>`

## 附录 A · 复现命令

```bash
# 静态门禁（error/warn 明细）
node packages/conformance/src/run-all.mjs --config <你的配置>.json

# 插件 × 宿主 API 用量核对（真实缺口；无缺口 exit 0）
node packages/conformance/scripts/check-plugin-imports.mjs <插件仓库> \
  --baseline packages/conformance/api-baseline.json [--own '<自有包正则>']
```

## 附录 B · 已验证修复（如有）

```diff
<逐文件 diff；注明"已临时应用并实测，结果见上表">
```
