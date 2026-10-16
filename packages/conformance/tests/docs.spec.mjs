/**
 * 文档里写死的路径必须真的存在。
 *
 * 为什么单独一个文件：这类缺陷**没有任何测试会变红**。2026-10-16 把
 * `fixtures/api-surfaces/` 改名成 `fixtures/api-usage/surfaces/`（合成面）并把真实面挪到
 * `fixtures/host-surfaces/` 之后，`packages/conformance/README.md` 里仍有两条
 * `fixtures/api-surfaces` 的引用 —— 照着 README 敲命令的人会得到一个不存在的路径，
 * 而**当时全部用例依然全绿**。这与 `DSH-C070`/`C071` 防的是同一类失败：
 * **"检查没真的查"和"文档指了一个不存在的路径"都会给出虚假的绿灯。**
 *
 * 检查范围刻意收窄到**具体的、承重的**路径，避免把示例占位符（`<宿主版本>`、`fixtures/nope`
 * 这类故意写错的演示）误判成缺陷：宁可少查，也不要一个会误报的检查。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

/** 仓库里所有 .md，跳过 node_modules 与 .git。 */
function markdownFiles(dir = repoRoot, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) markdownFiles(full, out)
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

/** 文档里必须真的存在的路径（承重的那些）。 */
const REQUIRED_PATHS = [
  // 候选清单：`--candidates` 的默认指向，检查时不得联网，所以必须提交
  'fixtures/host-versions.published.json',
  // 真实记录的宿主 API 面（T18 的 `--surfaces` 输入）
  'fixtures/host-surfaces',
  // T18 单元测试用的合成面 —— 与真实面**必须**分开，否则"检测能力"的证明会退化
  'fixtures/api-usage/surfaces',
  // T17 的缺陷夹具
  'fixtures/host-matrix',
  // 契约（多个 CLI 的 `规则依据:` 指向它）
  'docs/contract-v1.md',
  'docs/testing-guide.md',
]

//#region 文档路径存在性

test('文档里承重的路径都真的存在', () => {
  const missing = REQUIRED_PATHS.filter((p) => !existsSync(resolve(repoRoot, p)))
  assert.deepEqual(missing, [], `这些路径在文档里被当成事实引用，但仓库里不存在：${missing.join('、')}`)
})

test('CLI 帮助文本里点名的规则依据文件都存在', () => {
  const srcDir = resolve(here, '..', 'src')
  const referenced = new Set()
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith('.mjs')) continue
    const text = readFileSync(join(srcDir, entry), 'utf8')
    // 只认 `docs/xxx.md` 这种具体文件名，不认带占位符的写法
    for (const match of text.matchAll(/\bdocs\/[A-Za-z0-9._-]+\.md\b/g)) referenced.add(match[0])
  }
  assert.ok(referenced.size > 0, '应当至少有一处 CLI 引用了 docs/ 下的文件 —— 否则这条检查是空转')
  const missing = [...referenced].filter((p) => !existsSync(resolve(repoRoot, p)))
  assert.deepEqual(missing, [], `CLI 引用了不存在的文档：${missing.join('、')}`)
})

test('回归：已改名的 fixtures/api-surfaces 不得再出现在任何**可执行示例**里', () => {
  // 该目录被拆成 fixtures/api-usage/surfaces（合成）与 fixtures/host-surfaces（真实）。
  // 留着旧路径的**命令示例**会让人照着敲一条必然失败的命令，而所有测试依然全绿。
  //
  // 只扫**围栏代码块**内的行：代码块里的路径是"照着敲的命令"，散文里的路径是叙述。
  // 这个区分是必要的 —— CHANGELOG 与 validation-report 里**应该**能写"我们把
  // fixtures/api-surfaces 挪走了"，要求历史记录不得提及旧名字是荒谬的。
  const offenders = []
  for (const file of markdownFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')
    let inFence = false
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return
      }
      if (inFence && line.includes('fixtures/api-surfaces')) {
        offenders.push(`${file.slice(repoRoot.length + 1)}:${i + 1}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `可执行示例里仍引用已改名目录 fixtures/api-surfaces：${offenders.join('、')}`)
})

test('合成 API 面与真实 API 面不混放（否则检测能力的证明会退化）', () => {
  const synthetic = resolve(repoRoot, 'fixtures/api-usage/surfaces')
  const real = resolve(repoRoot, 'fixtures/host-surfaces')
  assert.ok(existsSync(synthetic), '合成面目录应当存在')
  assert.ok(existsSync(real), '真实面目录应当存在')

  // 合成面是给用例造的对照（1.0.0 / 2.0.0），真实面是实际采集的（0.2.x）
  const syntheticNames = readdirSync(synthetic).filter((f) => f.endsWith('.json'))
  assert.ok(syntheticNames.length > 0, '合成面目录不应为空')
  for (const name of syntheticNames) {
    assert.match(name, /^surface-\d+\.\d+\.\d+\.json$/, `${name} 看起来不是合成面 —— 真实面不要放进测试夹具目录`)
  }

  // 真实面必须自带 hostVersion（产物的含义不该取决于别人怎么命名文件）
  const realNames = readdirSync(real).filter((f) => f.endsWith('.json'))
  assert.ok(realNames.length > 0, '真实面目录不应为空')
  for (const name of realNames) {
    const parsed = JSON.parse(readFileSync(join(real, name), 'utf8'))
    assert.equal(typeof parsed.hostVersion, 'string', `${name} 缺少 hostVersion`)
  }
})

test('两个包必须成对地声明 private + UNLICENSED（少了任何一半都会说谎）', () => {
  // npm 文档对"私有、不打算授予任何权利"给出的写法是**两个字段一起**：
  //   `private: true`   —— 从机制上阻止误发布（npm publish 直接失败）
  //   `license: UNLICENSED` —— 把"没授权"写明确
  // 少了 private，"不发布"只是口头承诺；少了 UNLICENSED，留空与"忘了填"无法区分，
  // 而填 MIT 是虚标。两个包都不发布，所以这条是**长期约束**，不是"发布前再改"。
  for (const pkg of ['conformance', 'testkit']) {
    const dir = resolve(repoRoot, 'packages', pkg)
    const pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkgJson.private, true, `packages/${pkg} 必须 private: true —— 否则内部工具可能被误发布`)
    assert.equal(
      pkgJson.license,
      'UNLICENSED',
      `packages/${pkg} 的 license 必须是 UNLICENSED —— 空着无法与"忘了填"区分，MIT 是虚标`,
    )

    // lock 的根条目必须与 package.json 一致：它们曾经漂移过（license/bin 都对不上）
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
    const rootEntry = lock.packages['']
    assert.equal(rootEntry.name, pkgJson.name, `packages/${pkg} 的 lock 根条目 name 与 package.json 不一致`)
    assert.equal(rootEntry.version, pkgJson.version, `packages/${pkg} 的 lock 根条目 version 与 package.json 不一致`)
    assert.equal(
      rootEntry.license,
      pkgJson.license,
      `packages/${pkg} 的 lock 根条目 license 与 package.json 不一致 —— 跑 npm install --package-lock-only 重算`,
    )
  }
})

test('两个包锁步版本（同升同降）', () => {
  const a = JSON.parse(readFileSync(resolve(repoRoot, 'packages/conformance/package.json'), 'utf8'))
  const b = JSON.parse(readFileSync(resolve(repoRoot, 'packages/testkit/package.json'), 'utf8'))
  assert.equal(a.version, b.version, '两个包必须锁步版本 —— 分开升位会让"同一版本"失去意义')
})

//#endregion
