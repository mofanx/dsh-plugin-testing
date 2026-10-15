# dsh-plugin-testkit

DSH 插件团队的测试基建。**不是 DSH 插件** —— 它不注册任何 `ctx` 服务，只提供测试用的宿主环境与驱动。

> ⚠️ **发布状态**：包名为占位 scope `@your-scope/dsh-plugin-testkit`，且 `package.json` 仍为 `private: true` —— 仅供本仓 `link:`/`file:` 引用，尚未发布到任何 registry。正式对外发布前需替换 scope、去掉 `private`，并**确定许可证**：本仓当前没有 `LICENSE` 文件，著作权归属未定，因此两个包的 `package.json` 已**移除** `license` 字段（不虚标 `MIT`）。注意 `private: true` 只能阻止误发布，**不构成任何授权**。

## 为什么需要它

团队既有的 host-integration 约定（`dsh --profile headless --patch <repo>/cordis.patch.yml`）机制是对的，但缺**隔离**：

| 问题 | 后果 |
|---|---|
| 跑在开发者真实的 `$DSH_HOME` 上 | stock `headless` profile 与任何 home 级 `cordis.patch.yml` 都会渗进每一次运行 |
| 运行会**写入**该 home | 已实测：一个裸 `--dump-config` 就产生了 2 个文件 —— 测试不是只读的 |
| 真实 `compatibility.json` 会**静默授权** | 恰恰掩盖了测试本该抓到的插件拒绝 |

`createTestHome()` 为每个测试materialize 一个一次性 home。

## 用法

```js
import { createTestHome, testHomeArgs, testHomeEnv } from '@your-scope/dsh-plugin-testkit'

const home = createTestHome({ profilePatch: '- insert:\n    - id: probe\n      name: "pkg-probe"\n' })
try {
  // 真实组合测试：让宿主自己把插件装起来
  const result = spawnSync('dsh', testHomeArgs(home, { patches: ['<repo>/cordis.patch.yml'], task: 'do it' }), {
    env: testHomeEnv(home.homeDir, process.env),
  })
  // 断言"世界"，而不是插件的自述：退出码、JSON 流、磁盘产物
} finally {
  home.cleanup()
}
```

包根导出是 `home` 与 `replay` 两半的并集。只用到其中一半时，用更精确的子路径导入：`…/home`、`…/replay`。

## 两条通道：keyless 与 with-key

隔离 home **没有** `~/.dsh/.credentials.yaml`，这是设计而非缺陷 —— 测试绝不能悄悄继承开发者的真实凭据。

实测：不带凭据跑 `--json` 时，session 建好、JSON 事件流已经开始输出，**只在第一次模型调用处**失败：

```
{"type":"turn_end","reason":{"kind":"error","error":{
  "message":"llm-deepseek: no API key for provider route \"deepseek-official\"…",
  "code":"MISSING_CREDENTIAL"}}}
```

| 通道 | 做法 | 用途 |
|---|---|---|
| **keyless**（默认） | 用 mock provider 或回放车道（固定模型输出） | PR 门禁、确定性回放 |
| **with-key**（夜间） | `withKeyEnv(home.homeDir, apiKey, process.env)` | 真实模型、evals |

## 三条刻意的"不生成"

`createTestHome()` **不会**创建这三样，每一件都是确定性或诚实性的保证：

1. **`compatibility.json`** —— 测试 home 绝不能替宿主静默授权一个本该被拒的插件。没有它，peer 拒绝才会真实发生（这是门禁预测、并被运行时日志证实的故障模式）。
2. **home 级 `cordis.patch.yml`** —— 用户的 tweak 不该进入测试。
3. **`node_modules`** —— 见下。

## 为什么不需要 `node_modules`

启动器会从**安装的依赖图与有序 bundle 依赖图**算出一份不可变的 runtime resolution，并装进 Node 的 ESM/CJS 解析器（`dsh-app-boot` README：「挂载 profile 条目前…」）。所以 bundle 从 **DSH 安装**解析，而不是从 profile。

已实测：一个只有 `profiles/test/package.json` 的 home 能成功 boot 并输出完整 `--dump-config`。这让隔离的代价降到接近零 —— **不需要 `npm install`**。

## 自测

```bash
npm test        # node --test "tests/**/*.spec.mjs"
```

其中 5 条是**真实启动用例**（本包 `home.spec.mjs` 1 条 + `replay.spec.mjs` 4 条）：真的启动打包的 launcher（`--dump-config`，不需模型凭据），断言裸 home 能 boot 出组合。找不到 launcher 时自动跳过；可用 `DSH_BIN` 指定其他安装。

若进程**根本起不来**（沙箱 `EPERM`、`DSH_BIN` 指向已删除的路径等），用例会以 `skip` + 具体 errno 报告，而不是伪装成"launcher 退出码异常"的失败 —— 二者指向完全不同的排查方向。超时**不算**环境问题，仍按失败处理（挂死的 launcher 正是这些用例要抓的）。
