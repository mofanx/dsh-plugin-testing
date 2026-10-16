/**
 * T17 — host-version matrix (`deriveHostMatrix` / `readCandidateList`).
 *
 * These cases are the **detection-power** proof for the pass: each defect class
 * has a fixture that must trip it, and each has a near-miss fixture that must
 * NOT, so a "passing" run cannot be the result of a check that never fires.
 *
 * Everything here is pure: no host install, no boot, no network.
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { deriveHostMatrix, readCandidateList } from '../src/matrix.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const fixtures = resolve(here, '..', '..', '..', 'fixtures', 'host-matrix')
const publishedList = resolve(here, '..', '..', '..', 'fixtures', 'host-versions.published.json')

/** The real published dsh list, so cases exercise the same set the CLI uses. */
const PUBLISHED = readCandidateList(publishedList).versions

//#region readCandidateList

test('readCandidateList：读取真实已发布清单，按 semver 升序且带来源', () => {
  const list = readCandidateList(publishedList)
  assert.ok(list.versions.length >= 30, `真实清单应有足够多版本，实际 ${list.versions.length}`)
  assert.equal(list.versions[0], '0.0.1-rc.1')
  assert.equal(list.versions[list.versions.length - 1], '0.2.1-alpha.4')
  assert.match(list.source ?? '', /npm/)
  assert.equal(list.generatedAt, '2026-10-16')
  // 升序是下游 span/hole 计算的前提
  const sorted = [...list.versions].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
  assert.deepEqual(list.versions, sorted)
})

test('readCandidateList：去重、拒绝非法版本、拒绝空清单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-'))
  try {
    const write = (name, body) => {
      const file = join(dir, name)
      writeFileSync(file, JSON.stringify(body), 'utf8')
      return file
    }
    // 去重后仍升序
    const dedup = readCandidateList(write('dedup.json', { versions: ['0.2.1-alpha.2', '0.2.0-rc.2', '0.2.1-alpha.2'] }))
    assert.deepEqual(dedup.versions, ['0.2.0-rc.2', '0.2.1-alpha.2'])

    assert.throws(() => readCandidateList(write('bad.json', { versions: ['0.2.0-rc.2', 'not-a-version'] })), /非法版本/)
    // 空清单会得出"没有任何版本被覆盖"的假结论 —— 必须拒绝而不是当成通过
    assert.throws(() => readCandidateList(write('empty.json', { versions: [] })), /为空/)
    assert.throws(() => readCandidateList(write('shape.json', ['0.2.0-rc.2'])), /JSON 对象/)
    assert.throws(() => readCandidateList(write('nokeys.json', {})), /缺少 versions/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readCandidateList：knownGaps 必须有原因（无原因的排除等于隐藏问题）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-'))
  try {
    const write = (body) => {
      const file = join(dir, 'list.json')
      writeFileSync(file, JSON.stringify(body), 'utf8')
      return file
    }
    const ok = readCandidateList(
      write({ versions: ['0.2.0-rc.2'], knownGaps: { '0.2.0-rc.1': '该版本 API 不兼容' } }),
    )
    assert.deepEqual(ok.knownGaps, { '0.2.0-rc.1': '该版本 API 不兼容' })

    assert.throws(() => readCandidateList(write({ versions: ['0.2.0-rc.2'], knownGaps: { '0.2.0-rc.1': '' } })), /缺少原因/)
    assert.throws(() => readCandidateList(write({ versions: ['0.2.0-rc.2'], knownGaps: { 'nope': 'x' } })), /非法版本/)
    assert.throws(() => readCandidateList(write({ versions: ['0.2.0-rc.2'], knownGaps: [] })), /必须是对象/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

//#endregion

//#region deriveHostMatrix — 声明覆盖集

test('deriveHostMatrix：真实 EDA 形状的并集在 0.2.1-alpha.1 上出现安装期分歧（DSH-C067）', () => {
  // 这是 EDA 五个包修复前/后的真实范围形状：第二个子句从 alpha.2 起，
  // 于是 alpha.1 运行时被接纳、安装期被裸 semver 拒绝。
  const report = deriveHostMatrix(join(fixtures, 'divergence'), { candidates: PUBLISHED })
  assert.deepEqual(report.divergence, ['0.2.1-alpha.1'])
  assert.ok(report.admitted.includes('0.2.1-alpha.1'), '运行时应当接纳它 —— 否则就不是"分歧"而是"不覆盖"')
  assert.ok(!report.installAdmitted.includes('0.2.1-alpha.1'), '安装期必须拒绝它')
  assert.deepEqual(report.holes, [], '它被运行时接纳，所以不是空洞')
  const codes = report.findings.map((f) => f.code)
  assert.deepEqual(codes, ['DSH-C067'])
  assert.equal(report.findings[0].severity, 'warn')
})

test('deriveHostMatrix：把第二个子句下探到 alpha.1 后分歧消失（修复被验证）', () => {
  const report = deriveHostMatrix(join(fixtures, 'clean'), { candidates: PUBLISHED })
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.divergence, [])
  assert.deepEqual(report.holes, [])
  assert.deepEqual(report.admitted, report.installAdmitted)
  assert.deepEqual(report.admitted, ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4'])
})

test('deriveHostMatrix：区间内的已发布版本不被接纳即为空洞（DSH-C068，error）', () => {
  const report = deriveHostMatrix(join(fixtures, 'hole'), { candidates: PUBLISHED })
  // 范围覆盖 rc.2 与 alpha.3+，于是 alpha.1 / alpha.2 落在区间内却无人接纳。
  assert.deepEqual(report.holes, ['0.2.1-alpha.1', '0.2.1-alpha.2'])
  assert.equal(report.span.min, '0.2.0-rc.2')
  assert.equal(report.span.max, '0.2.1-alpha.4')
  const c068 = report.findings.filter((f) => f.code === 'DSH-C068')
  assert.equal(c068.length, 2)
  assert.ok(c068.every((f) => f.severity === 'error'), '未确认的空洞必须是 error')
  assert.ok(c068[0].message.includes('knownGaps'), '报文要告诉读者如何把"有意排除"表达出来')
})

test('deriveHostMatrix：knownGaps 把已确认的空洞降级为 warn，并保留原因', () => {
  const report = deriveHostMatrix(join(fixtures, 'hole'), {
    candidates: PUBLISHED,
    knownGaps: { '0.2.1-alpha.1': '该版本 dsh-tools 缺 symbol，已确认不支持' },
  })
  const findings = report.findings.filter((f) => f.code === 'DSH-C068')
  assert.equal(findings.length, 2)
  const acknowledged = findings.find((f) => f.message.includes('knownGaps 中确认为有意排除'))
  assert.ok(acknowledged, '被确认的那条要说明它是已确认的')
  assert.equal(acknowledged.severity, 'warn', '确认过就不再阻断')
  assert.match(acknowledged.message, /缺 symbol/)
  const unacknowledged = findings.find((f) => f.message.includes('请在候选清单的 knownGaps'))
  assert.ok(unacknowledged, '未确认的那条仍是 error')
  assert.equal(unacknowledged.severity, 'error')
  assert.deepEqual(report.acknowledgedGaps, ['0.2.1-alpha.1'])
})

test('deriveHostMatrix：区间端点由被接纳的候选决定，区间外的版本不算空洞', () => {
  const report = deriveHostMatrix(join(fixtures, 'clean'), { candidates: PUBLISHED })
  // 28 个更早的版本都在区间之下，它们"不被覆盖"是正常的，不是空洞。
  assert.equal(report.belowSpan.length, 28)
  assert.deepEqual(report.aboveSpan, [])
  assert.equal(report.rows.filter((r) => r.hole).length, 0)
  assert.ok(report.belowSpan.every((v) => !report.admitted.includes(v)))
})

test('deriveHostMatrix：没有任何候选被接纳时，区间为空而不是"覆盖全部"', () => {
  const report = deriveHostMatrix(join(fixtures, 'hole'), { candidates: ['0.1.0-rc.2', '0.1.5-rc.1'] })
  assert.equal(report.span, null)
  assert.deepEqual(report.admitted, [])
  assert.deepEqual(report.holes, [], '区间不存在时不能凭空报空洞')
  assert.deepEqual(report.belowSpan, [])
})

test('deriveHostMatrix：未声明 dsh peer 时不得当成"支持全部版本"', () => {
  const report = deriveHostMatrix(join(fixtures, 'no-dsh-peers'), { candidates: PUBLISHED })
  assert.equal(report.hasDshPeers, false)
  assert.deepEqual(report.peers, {}, 'cordis peer 不是运行时预检对象，不应进入矩阵')
  assert.deepEqual(report.admitted, [], '未声明 ≠ 声明支持全部')
  assert.equal(report.span, null)
  assert.deepEqual(report.findings, [], '本 pass 不负责报"缺声明"，那是其他规则的职责')
})

//#endregion

//#region 交集语义

test('deriveHostMatrix：多个 dsh peer 取交集（任一不满足即整行不被接纳）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@probe/intersection',
        version: '1.0.0',
        peerDependencies: {
          // 两个子句都带 0.2.1 元组，所以安装期也能覆盖 alpha.4
          '@deepseek-ai/dsh': '>=0.2.1-alpha.1 <0.3.0',
          // 更窄：只有 alpha.4 满足 —— 交集应当被它压到这一个版本
          '@deepseek-ai/dsh-llm': '>=0.2.1-alpha.4 <0.3.0',
          // cordis 系必须被忽略
          '@deepseek-ai/cordis': '>=99.0.0 <100.0.0',
        },
      }),
      'utf8',
    )
    const report = deriveHostMatrix(dir, { candidates: PUBLISHED })
    assert.deepEqual(Object.keys(report.peers), ['@deepseek-ai/dsh', '@deepseek-ai/dsh-llm'])
    assert.deepEqual(report.admitted, ['0.2.1-alpha.4'])
    assert.deepEqual(report.installAdmitted, ['0.2.1-alpha.4'])
    assert.deepEqual(report.holes, [])
    assert.deepEqual(report.findings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deriveHostMatrix：一个宽子句救不了安装期 —— 元组不匹配时宽度无关紧要', () => {
  // 这是 EDA 并集为什么必须存在第二个子句的根本原因，也是一个真实的坑：
  // `>=0.2.0-rc.2 <0.3.0` 看起来覆盖了整个 0.2.x，但它的比较器携带的是 **0.2.0**
  // 预发布元组，因此对 `0.2.1-alpha.4` 这样的 **0.2.1** 预发布版本，裸 semver
  // 永远拒绝它 —— 范围再宽也没用。只要有一个 peer 这样，安装期整行就不满足。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@probe/tuple-poison',
        version: '1.0.0',
        peerDependencies: {
          '@deepseek-ai/dsh': '>=0.2.0-rc.2 <0.3.0',
          // 这个 peer 本身完全能覆盖 alpha.4（0.2.1 元组），但救不了上面那个
          '@deepseek-ai/dsh-llm': '>=0.2.1-alpha.4 <0.3.0',
        },
      }),
      'utf8',
    )
    const report = deriveHostMatrix(dir, { candidates: PUBLISHED })
    assert.deepEqual(report.admitted, ['0.2.1-alpha.4'], '运行时按交集接纳')
    assert.deepEqual(report.installAdmitted, [], '安装期被那个宽子句拖垮')
    assert.deepEqual(report.divergence, ['0.2.1-alpha.4'])
    assert.deepEqual(report.findings.map((f) => f.code), ['DSH-C067'])
    const row = report.rows.find((r) => r.version === '0.2.1-alpha.4')
    assert.equal(row.perPeer.find((p) => p.dependency === '@deepseek-ai/dsh').install, false)
    assert.equal(row.perPeer.find((p) => p.dependency === '@deepseek-ai/dsh-llm').install, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deriveHostMatrix：row 逐 peer 保留判定，便于解释"为什么这行不被接纳"', () => {
  const report = deriveHostMatrix(join(fixtures, 'divergence'), { candidates: PUBLISHED })
  const row = report.rows.find((r) => r.version === '0.2.1-alpha.1')
  assert.equal(row.runtimeAdmits, true)
  assert.equal(row.installAdmits, false)
  assert.equal(row.perPeer.length, 1)
  assert.equal(row.perPeer[0].dependency, '@deepseek-ai/dsh')
  assert.equal(row.perPeer[0].runtime, true)
  assert.equal(row.perPeer[0].install, false)
})

//#endregion

//#region 真实清单自洽

test('真实清单与 dist-tags 记录一致（清单不得与生成时的事实脱节）', () => {
  const raw = JSON.parse(readFileSync(publishedList, 'utf8'))
  assert.equal(raw.distTagsAtGeneration.latest, '0.2.0-rc.2')
  assert.equal(raw.distTagsAtGeneration.alpha, '0.2.1-alpha.4')
  assert.ok(raw.versions.includes(raw.distTagsAtGeneration.latest))
  assert.ok(raw.versions.includes(raw.distTagsAtGeneration.alpha))
  assert.ok(raw.note.includes('不得联网'), '清单必须写明它不得在检查时联网获取')
})
