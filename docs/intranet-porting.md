# 内网 GitLab 迁移与"单向搬运"工作方式

> **一句话**：GitHub 侧是**上游**，内网是**只进不出的下游**。所以内网需要的任何东西都必须
> **先在上游存在**；内网自己的改动要**尽量少、尽量枚举得出、尽量放在新增文件里**，这样每次
> 从上游同步时重贴一遍的成本才可控。

## 一、先明确那条约束，以及它推翻了什么

团队在内网开发，本仓库会迁到内网 GitLab；GitHub 侧可能保留一份，但两边**可能分叉**。
关键限制是**方向**：

```
外网 (GitHub)  ──────可以搬──────▶  内网 (GitLab)
内网 (GitLab)  ──────搬不出去────▶  外网 (GitHub)
```

这条约束推翻了一个默认假设 —— "两边保持一致，谁改了同步过去就行"。实际上：

| 如果…… | 后果 |
|---|---|
| 内网改了一个文件，且上游也改了同一个文件 | 这次同步**必然冲突**，且冲突**无法回流**，只能在内网侧人工合并，每次同步都要重来 |
| 内网把某项配置改成内网专属值 | 该文件**永久分叉**，之后每次同步都是这个文件上的手工活 |
| 内网**新增**一个文件（上游没有） | 同步时**不冲突** —— 上游根本不知道它存在 |

**结论**：把内网改动尽量做成**新增文件**，而不是**修改已有文件**。本仓库已经按这个原则
准备好了 `.gitlab-ci.yml`，所以**迁移本身不需要改动任何一个已有文件**。

## 二、迁移步骤

### 2.1 搬代码

内网 GitLab 建项目 → 从 GitHub 镜像/clone 一份 → 推上去。仓库本身没有 submodule、
没有 Git LFS、没有构建产物入库，所以是纯文本搬运。

```bash
git clone --mirror https://github.com/mofanx/dsh-plugin-testing.git
cd dsh-plugin-testing.git && git push --mirror <内网 GitLab 地址>
```

> `--mirror` 会连分支与标签一起搬，且保留提交 SHA —— 这一点很重要：插件仓库的门禁把
> 测试仓库**钉在某个提交 SHA** 上（`TESTING_REV`），SHA 变了那个钉就失效了。

### 2.2 换 CI

`.gitlab-ci.yml` 已经在仓库里，与 `.github/workflows/ci.yml` 逐条对应：

| 车道 | GitHub | GitLab | 矩阵 |
|---|---|---|---|
| 离线 | `test` | `unit` | node `22` / `24` |
| 真实宿主 | `real-host` | `real-host` | 宿主 `0.2.0-rc.2` / `0.2.1-alpha.4` |
| 金丝雀 | `dsh-canary`（`schedule`） | `canary`（`schedule`） | dist-tag `latest` / `alpha` |

两份文件**可以并存**：GitHub 忽略 `.gitlab-ci.yml`，GitLab 忽略 `.github/`。迁移时不必删任何东西。

> ⚠️ **`.gitlab-ci.yml` 没有在真实 GitLab runner 上验证过。** 它是照 GitHub 版逐条搬的，
> 命令本身与平台无关（纯 `node`/`npm`/`grep`），但以下三点必须由内网环境确认：
> ① `image: node:22` / `node:24` 在内网 registry 上是否存在；
> ② `npm install @deepseek-ai/dsh@<版本>` 能否从内网 registry 取到宿主（**唯一需要联网的一步**）；
> ③ runner 的 executor 是 docker 还是 shell（文件按 docker 写）。

### 2.3 让宿主来源可配置

这是**唯一**需要联网的一步，也是内网唯一真正的技术障碍：真实宿主车道要装
`@deepseek-ai/dsh@<版本>`。三种做法，按推荐顺序：

1. **内网 npm 代理/镜像**（Nexus / Artifactory / Verdaccio）代理公网 npm —— 什么都不用改，
   runner 的 `.npmrc` 指向内网地址即可。
2. **内网 registry 自己托管** `@deepseek-ai/dsh*` 与两个测试支撑包
   （`dsh-llm-replay`、`dsh-session-snapshot`）—— 注意这三个必须**同版本**，见下。
3. **离线预装**：把宿主安装结果打进 runner 镜像，然后**只设 `DSH_HOST_NODE_MODULES`**
   （指向那份 `node_modules`）与 `DSH_BIN`。工具本身**从不自己下载宿主**，所以这条路完全可行。

第 3 条之所以可行，是因为一个刻意的设计：**宿主从环境变量来，不从网络来。**

| 变量 | 作用 | 不设时的行为 |
|---|---|---|
| `DSH_BIN` | 打包启动器 `bin.js` 的路径 | 真实启动类用例**带原因跳过** |
| `DSH_HOST_NODE_MODULES` | 真实宿主的 `node_modules` | 静态对照类用例**带原因跳过** |
| `DSH_FIXTURES` | DSH 源码检出里的 `record-suite` | 2 例 replay fixture 用例跳过（已知边界） |

> **测试支撑包必须与宿主同版本。** `dsh-llm-replay` / `dsh-session-snapshot` 与 DSH
> **同步发版**且把 peer 钉成**精确版本**；装错线会被宿主自己的预检禁用，replay 车道**静默失效**。
> 它们的 dist-tag 与 `@deepseek-ai/dsh` **不一致**（replay 的 `latest` 是 `0.0.1-rc.1`，
> 而 `dsh` 的 `latest` 是 `0.2.0-rc.2`），**一律以宿主实际版本为准**，不要按 tag 取。

## 三、分叉面清单（内网专属改动的**全部**落点）

内网侧只需要动下面这些东西。**除此之外不应有任何差异** —— 一旦发现清单外的分叉，
要么把它做成新增文件，要么把它推回上游。

| # | 落点 | 性质 | 冲突风险 |
|---|---|---|---|
| 1 | `.gitlab-ci.yml` | **新增**（已在仓库里） | 无 |
| 2 | runner 的 `.npmrc` / registry 地址 | 仓库外（runner 配置） | 无 |
| 3 | CI 变量（宿主版本、`DSH_*` 路径） | 仓库外（GitLab 项目变量） | 无 |
| 4 | 内网 registry 的宿主版本集 → 重新生成 `fixtures/host-versions.published.json` | **修改已有文件** | **有** —— 上游每次发版都要重生成 |
| 5 | 内网宿主构建 → 重新采集 `fixtures/host-surfaces/` | **修改已有文件** | **有** —— 同上 |
| 6 | 仓库地址（README/CHANGELOG 里写的 GitHub 链接） | 修改已有文件 | 低（很少变） |
| 7 | npm scope（**仅当**内网 registry 要求不同 scope） | 修改已有文件 | 低（一次到位） |
| 8 | 插件仓库的 `TESTING_REV` / `TESTING_REPO` | 修改已有文件 | **有** —— 见 §五 |

第 4、5、8 项是**真正的分叉成本**，其余都是零成本或一次性。

### 3.1 第 4/5 项为什么必须重新生成 —— 一条内网独有的假绿

候选版本清单（`fixtures/host-versions.published.json`）与 API 面（`fixtures/host-surfaces/`）
都是从**公网** npm 采集的。工具在检查时**不联网**（这是刻意的，为了让结论随提交而非随上游变化），
所以：

- 内网 registry 里**存在**公网没有的宿主版本时，矩阵会把它算作"**不在候选清单内**"，
  从而**在一个真实存在的版本上给出绿灯**；
- 内网宿主若与公网**构建不同**（比如内部 patch 过），记录的 API 面就不再代表内网实际安装到的东西。

**这两种情况都不是工具缺陷，而是输入缺口** —— 工具忠实回答"在你给我的清单上"，而清单是错的。
所以内网侧必须按下面的做法重新采集并提交：

```bash
# 1. 用内网 registry 列全部已发布版本，重生成候选清单（结构与来源字段照旧）
npm view @deepseek-ai/dsh versions --json   # 在内网 registry 上执行

# 2. 逐版本装宿主并采集 API 面 —— 版本必须写**精确值**
mkdir -p /tmp/host && cd /tmp/host
echo '{"name":"dsh-probe-host","private":true,"version":"0.0.0","dependencies":{"@deepseek-ai/dsh":"<精确版本>"}}' > package.json
npm install --no-audit --no-fund
node <仓库>/packages/conformance/src/cli-api.mjs \
  --host /tmp/host/node_modules \
  --baseline <仓库>/fixtures/host-surfaces/surface-<上一个版本>.json --write
```

> **依赖版本必须写精确值，不能写 `^`。** `^0.2.1-alpha.2` **不是**"alpha.2"：按预发布元组规则
> 它会解析到同一个 `[0,2,1]` 元组里**最新的**预发布版本（实测装出来是 `alpha.4`）。这一点在
> 生成现有文件时真的踩到过。

## 四、日常怎么同步（外网 → 内网）

因为改动搬不出去，同步是**单向的一次性操作**，建议固定成一套流程：

1. **上游先行**：任何"两边都想要"的改动，**先在 GitHub 上做**，走完那边的 CI。
2. **记同步点**：内网仓库里记下"当前同步到上游的哪个提交"（内网新增一个文件记录即可，
   这样它不参与冲突）。插件仓库的 `TESTING_REV` 天然就是这样一个记录点。
3. **搬运**：把上游的新提交搬到内网（`git fetch` 上游 + `merge`/`cherry-pick`，或直接
   `push --mirror` 覆盖后重贴内网改动）。
4. **重贴内网改动**：按 §三 的清单逐项确认。只有第 4/5/8 项需要真的动手。
5. **两边都跑一遍**：内网 GitLab CI + （如仍保留）GitHub CI。

**不建议**在内网做"上游也会想要"的修复。那种改动应该：先在上游做 → 走上游 CI → 再搬进来。
否则它会永久留在内网，且下次同步时与上游的正确修复**冲突**。

### 4.1 如果内网发现了一个上游也需要的修复

按这个顺序，别反过来：

1. 把修复的**最小复现**记下来（不要带内网专属信息）；
2. 在外网仓库里重做这个修复（外网 CI 会验证它）；
3. 从外网搬进内网。

如果暂时做不到（比如修复依赖内网才有的数据），就在内网保留它，并**在 §三 清单里登记为一项新的分叉** ——
未登记的分叉会在下一次同步时以"莫名其妙被覆盖"的形式咬人。

## 五、插件仓库（`deepseek-eda-plugins`）的额外一步

插件仓库的门禁要**跨仓拉取本仓库**，并且**钉在某个提交 SHA** 上：

```yaml
TESTING_REPO: mofanx/dsh-plugin-testing
TESTING_REV: <测试仓库的提交 SHA>
```

内网侧这一步必须改（两个值都要），因为：

- `actions/checkout` 的 `repository:` 是 GitHub 专有机制，GitLab 上要用
  `git clone` + `git checkout <SHA>`（或 GitLab 的跨项目 CI 变量 / 子模块）；
- 内网 GitLab 的项目路径与 GitHub 的 `owner/repo` 不同；
- 内网搬过去的提交 **SHA 保持不变**（`--mirror` 搬的话），所以 `TESTING_REV` 的值本身可以照用，
  只有 `TESTING_REPO` 必须换成内网地址。

**这是插件仓库里唯一的内网专属改动**，且它是"修改已有文件"（有冲突风险），所以要按 §三 登记。
把跨仓拉取写成**一段可替换的 `git clone`**，比依赖平台的 checkout 动作更容易迁移 ——
GitHub 与 GitLab 上跑的是同一条命令。

### 5.1 顺带查清的发布面（两个仓库**不一样**，不要照搬）

审计时把两个仓库的发布面对比了一遍，结论是**它们的状态本来就不同**，因此处理方式也不同：

| | 测试仓库（本仓） | 插件仓库 |
|---|---|---|
| `private` | **`true`**（两个包） | 未设置（五个包**可发布**） |
| `license` 字段 | `UNLICENSED` | `MIT` |
| `LICENSE` 文件 | **无** | **有**，内容确为 MIT |
| `publishConfig` | 无 | `{"access":"public"}`（五个包都有） |
| 在 npm 上的实际状态 | 不发布 | 五个包**都还不存在**（实测 `E404`），README 写的是 "Install (**once published**)" |

**所以插件仓库的 `license: MIT` 是对的，不要改** —— 它有 `LICENSE` 文件，字段与文件一致。
本仓库之所以定 `UNLICENSED` 而不是 `MIT`，恰恰是因为**它没有 `LICENSE` 文件**：没有文件却写 `MIT` 是虚标。
两个仓库在这件事上"看起来不一致"，但各自都是对的 —— 一致性应该服从事实，而不是相反。

**内网侧需要留意的一点**：`publishConfig.access: "public"` 只在**公网** npm 上有意义，它决定
scoped 包以公开方式发布；发布到内网 registry 时它**无害但无作用**。真正的约束是 **scope 必须
与内网 registry 一致** —— 若内网用别的 scope，这五个包的 `name` 与彼此之间的 peer 引用
（`@deepseek-ai/dsh-plugin-eda-sch` 等）都要一起改。这属于"要发布就得先定 registry"的范畴，
与本次迁移的 CI 部分相互独立。

## 六、这套设计里哪些**不**需要为内网改动

留个底，免得迁移时把不该动的也动了：

| 东西 | 为什么不用动 |
|---|---|
| 38 个规则码与分级 | 与网络、registry 无关 |
| `docs/contract-v1.md` 的规则定义 | 同上 |
| 全部 `fixtures/`（除 §三 第 4/5 项） | 合成夹具，与宿主来源无关 |
| 221 个用例 | 210 个完全离线；11 个只看 `DSH_*` 环境变量指向哪里 |
| `private: true` + `license: UNLICENSED` | 与"发布到哪个 registry"无关 —— 这两个包**永不发布** |
| npm scope | 只是标识符（`private: true` 让发布不可能）；只有内网 registry 强制要求时才改 |

**一句话**：工具本身**不需要**为内网改动任何逻辑 —— 它只从环境变量拿宿主、只从仓库内读清单。
内网迁移的成本几乎全在 **CI 定义**与**重新采集两份数据**上，而不在工具代码里。
