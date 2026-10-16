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

包根导出是 `home`、`replay`、`activate` 三半的并集。只用到其中一半时，用更精确的子路径导入：`…/home`、`…/replay`、`…/activate`。

## 运行时激活探针（T16）：回答"宿主到底有没有禁用这一行"

静态门禁（`dsh-plugin-conformance`）只读文件、从不启动 DSH —— 这正是它快且不需要凭据的原因，也正是它**答不了**那个决定插件能否工作的问题：**运行时有没有把这个行禁用掉？**

这个判定发生在 `dsh-app-boot` 的兼容性预检里，而且**只在真实启动时执行**：

```
dsh: disabling profile plugin row "optional-schematic": Plugin @scope/dsh-plugin-a@0.1.0-alpha.1
is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-llm":">=0.2.1-alpha.2 <0.3.0"}.
```

> ⚠️ **`--dump-config` 不能替代真实启动**（实测）：一个不兼容的行会**原样出现在 dump 里，既没有 `disabled: true` 也没有任何诊断**。用 dump 冒充这条车道，恰好会对本车道要抓的用例报告成功。

```js
import { probeActivation } from '@your-scope/dsh-plugin-testkit'

const result = probeActivation({
  links: { '@scope/dsh-plugin-a': 'D:/projects/my-plugins/packages/a' },
  rows: ['@scope/dsh-plugin-a'],          // 作为 loader 行挂载
  // extraBundles: ['@scope/dsh-plugin-my-bundle'],  // 或让 bundle 自己的 patch 去挂
  expectActive: ['@scope/dsh-plugin-a'],  // 只把关注行的禁用判为失败
})
// result.ok / result.denied / result.terminal …
```

CLI（CI 用）：

```sh
dsh-plugin-activate \
  --packages "D:/projects/my-plugins/packages/*" \
  --bundle @scope/dsh-plugin-my-bundle \
  --expect-active @scope/dsh-plugin-a
```

退出码与门禁一致：`0` 通过 / `1` 关注行被禁用或启动失败 / `2` 用法错误或**没有匹配到任何包**（空集合绝不能是绿的）。

**为什么不需要凭据、也不需要外部服务**：预检在第一次模型调用**之前**执行，所以隔离 home（没有 `compatibility.json`、没有凭据）会稳定地终止于 `MISSING_CREDENTIAL` —— 而**走到这一步本身就是证据**：行被组合了、没被禁用、进程一直走到了需要模型的地方。探针据此**主动清理**凭据环境变量（`--allow-credentials` 可关闭），以免一次"通过"悄悄依赖了真实模型调用。

**探针如何自证**：仓库内两个夹具 `fixtures/sample-plugin` 与 `fixtures/incompatible-plugin` **只差一个 peer 范围**，构成受控实验 —— 判定差异只可能来自兼容性预检。`--expect-disabled` 进一步证明它并非"永远失败"。三类非兼容性启动故障（`did not activate`、等待服务的 pending、`plugin tree failed to load`）同样被捕获。

**失败要能归因**：宿主的聚合行只说*有几个*插件没起来。在 CI 上，"是我的插件没起来"与"是宿主自身某行在这个平台起不来"是完全不同的结论，所以探针会解析宿主紧接着打印的逐行诊断（`<rowId> (<packageName>): <detail>`）并在报告中列出：

```
未激活的行  :
  ✗ @scope/dsh-plugin-a（row optional-a）：failed to import: Error [ERR_MODULE_NOT_FOUND] …
```

**入口未构建会被单独指出**（接进真实 CI 时踩到的坑）：插件的入口通常是**构建产物**（`tsc -b` 产出的 `lib/index.js`），不在仓库里。直接在未构建的检出上跑探针，每一行都会 `failed to import` 并抛 `ERR_MODULE_NOT_FOUND` —— 那句话描述的是症状，原因是"没人跑构建"。探针在启动前就会检查每个链接包**声明**的入口文件是否存在，并明确报告：

```
未构建的包  :
  ! @scope/dsh-plugin-a（./lib/index.js）
结论：失败
  - 以下包声明的入口文件不存在：… —— 探针验证的是**交付物**，入口通常是构建产物，请先构建（如 pnpm run build）
```

**已知边界**：行 id 由插入它的补丁作者决定（bundle 可把 `@scope/dsh-plugin-a` 挂成 `optional-a`），所以 `expectActive` 既比对行 id、也比对禁用原因里的包名 —— 只比对其中之一会把自己要盯的禁用误判为"非关注行"。

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

本包共 45 条用例（`home` 13 + `replay` 13 + `activate` 19）。其中 **10 条依赖真实 DSH 安装**（`home.spec.mjs` 1 条 + `replay.spec.mjs` 4 条 + `activate.spec.mjs` 5 条）：真的启动 launcher，断言"世界"而不是插件的自述。找不到 launcher 时**逐条给出原因并跳过**（不是裸 `# SKIP`）；可用 `DSH_BIN` 指定其他安装。

### 测试支撑包必须与宿主同版本（一个真实的坑）

`@deepseek-ai/dsh-llm-replay` 与 `@deepseek-ai/dsh-session-snapshot` 与 DSH **同步发版**，并且把自己的 peer 钉成**精确版本**（`"@deepseek-ai/dsh-llm": "0.2.0-rc.2"`）。所以拿一条宿主线的支撑包去跑**另一条**宿主线时，宿主自带的兼容性预检会直接禁用它 —— replay 车道随之无法运行。

`resolveInstalledPackage` 因此**优先取宿主里的那一份**（`$DSH_HOST_NODE_MODULES`），取不到才回退到本包锁定的版本。两种情形都是明确的：

- **宿主里有匹配版本**（把匹配版装进宿主 `node_modules`）→ replay 车道正常跑。
- **没有** → 相关用例带着**两边版本号**跳过，而不是抛一句难懂的 `NO_ADAPTER`：

  ```
  ﹣ replay failure is the reported fault, … # 宿主 0.2.1-alpha.4 禁用了 dsh-llm-replay@0.2.0-rc.2：
    该测试支撑包的 peer 是**精确版本**，只与它自己那条线兼容。把匹配的 0.2.1-alpha.4 版装进宿主
    node_modules 即可启用本车道（resolveInstalledPackage 优先取宿主里的那一份）
  ```

  这个跳过是**收窄判定**的：只有"宿主自己说它不兼容"**且**"版本确实不同"才跳过；同版本下被禁用仍然会失败。

> ⚠️ 别按 dist-tag 装这两个包：它们的 tag 映射与 `@deepseek-ai/dsh` **不一致**（`dsh-llm-replay` 的 `latest` 是 `0.0.1-rc.1`，`dsh` 的 `latest` 是 `0.2.0-rc.2`）。一律以宿主实际版本为准。

若进程**根本起不来**（沙箱 `EPERM`、`DSH_BIN` 指向已删除的路径等），用例会以 `skip` + 具体 errno 报告，而不是伪装成"launcher 退出码异常"的失败 —— 二者指向完全不同的排查方向。超时**不算**环境问题，仍按失败处理（挂死的 launcher 正是这些用例要抓的）。
