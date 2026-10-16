/**
 * T18 — host API availability by version (`scanUsedApis` / `readSurfaceDir` /
 * `checkUsageAgainstSurface`, surfaced through `deriveHostMatrix`).
 *
 * These cases are the **detection-power** proof for the pass. The central one is
 * a single fixture checked against two recorded surfaces: it must pass on the
 * one that has the API and trip `DSH-C069` on the one that does not. A check that
 * can only ever pass proves nothing, and a check that can only ever fail is noise.
 *
 * Everything here is pure: no host install, no boot, no network.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  checkUsageAgainstSurface,
  matchSubpath,
  readSurfaceDir,
  scanUsedApis,
  splitHostSpecifier,
  surfaceUniverse,
} from '../src/api-usage.mjs'
import { deriveHostMatrix, readCandidateList } from '../src/matrix.mjs'
import { API_USAGE_RULE_CODES } from '../src/rules.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const fixtures = resolve(here, '..', '..', '..', 'fixtures')
const usageFixtures = join(fixtures, 'api-usage')
const surfaceFixtures = join(usageFixtures, 'surfaces')
const cli = resolve(here, '..', 'src', 'cli-host-matrix.mjs')

const SURFACES = readSurfaceDir(surfaceFixtures)
const UNIVERSE = surfaceUniverse(SURFACES)

const CANDIDATES = readCandidateList(join(usageFixtures, 'candidates.json')).versions

/** Every rule code any case below actually tripped. */
const exercised = new Set()

/** The whole point: same fixture, two surfaces, opposite verdicts. */
function matrixFor(name) {
  const report = deriveHostMatrix(join(usageFixtures, name), { candidates: CANDIDATES, surfaces: SURFACES })
  for (const finding of report.findings) exercised.add(finding.code)
  return report
}

//#region splitHostSpecifier

test('splitHostSpecifier：包名与子路径拆分，非 @deepseek-ai 一律不管', () => {
  assert.deepEqual(splitHostSpecifier('@deepseek-ai/dsh-llm'), { package: '@deepseek-ai/dsh-llm', subpath: '.' })
  assert.deepEqual(splitHostSpecifier('@deepseek-ai/dsh-llm/invariant'), {
    package: '@deepseek-ai/dsh-llm',
    subpath: './invariant',
  })
  assert.deepEqual(splitHostSpecifier('@deepseek-ai/dsh-llm/src/a/b'), {
    package: '@deepseek-ai/dsh-llm',
    subpath: './src/a/b',
  })
  assert.equal(splitHostSpecifier('node:crypto'), undefined)
  assert.equal(splitHostSpecifier('@other/pkg'), undefined)
  assert.equal(splitHostSpecifier('./relative.js'), undefined)
})

//#endregion

//#region matchSubpath

test('matchSubpath：字面量命中，且 * 模式能命中（否则已存在的 API 会被误报缺失）', () => {
  assert.equal(matchSubpath('.', ['.', './package.json']), '.')
  assert.equal(matchSubpath('./invariant', ['.', './package.json']), undefined)
  assert.equal(matchSubpath('./src/util', ['./src/*']), './src/*')
  assert.equal(matchSubpath('./locale/zh.json', ['./locale/*.json']), './locale/*.json')
  // `[^/]*` —— 单段匹配，不能跨斜杠
  assert.equal(matchSubpath('./src/a/b', ['./src/*']), undefined)
  assert.equal(matchSubpath('./srcish', ['./src/*']), undefined)
})

//#endregion

//#region scanUsedApis

test('scanUsedApis：从发布入口收集具名 import，并跟随相对 import', () => {
  const usage = scanUsedApis(join(usageFixtures, 'uses-removed-api'))
  const byKey = new Map(usage.used.map((u) => [`${u.package}${u.subpath}`, u]))
  assert.deepEqual(byKey.get('@deepseek-ai/dsh-llm./invariant')?.symbols, ['checkInvariant'])
  assert.deepEqual(byKey.get('@deepseek-ai/dsh-tools.')?.symbols, ['defineTool'])
  assert.equal(usage.truncated, false)
})

test('scanUsedApis：只扫发布入口可达的文件，dev-only 文件不产生幻影依赖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@probe/reach', version: '1.0.0', type: 'module', main: 'lib/index.js' }),
      'utf8',
    )
    // lib/ 下两个文件：index.js 被 main 指向，orphan.js 谁都不引用
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), "export { a } from './a.js'\n", 'utf8')
    writeFileSync(join(dir, 'lib', 'a.js'), "import { HarnessError } from '@deepseek-ai/dsh-llm'\nexport { HarnessError }\n", 'utf8')
    writeFileSync(join(dir, 'lib', 'orphan.js'), "import { nope } from '@deepseek-ai/dsh-tools'\nexport { nope }\n", 'utf8')

    const usage = scanUsedApis(dir)
    const names = usage.used.map((u) => u.package)
    assert.ok(names.includes('@deepseek-ai/dsh-llm'), '入口可达的依赖必须被收进来')
    assert.ok(!names.includes('@deepseek-ai/dsh-tools'), '入口不可达的文件不得产生依赖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanUsedApis：`b as c` 取原始导出名，namespace/动态 import 归入未能核验', () => {
  const aliased = scanUsedApis(join(usageFixtures, 'unverifiable-api'))
  assert.equal(aliased.used.length, 0)
  const reasons = aliased.unverifiable.map((u) => `${u.package}:${u.reason}`)
  assert.ok(reasons.some((r) => r.startsWith('@deepseek-ai/dsh-llm')), '命名空间导入应被记为未能核验')
  assert.ok(reasons.some((r) => r.startsWith('@deepseek-ai/dsh-tools')), '动态 import 应被记为未能核验')
})

//#endregion

//#region readSurfaceDir

test('readSurfaceDir：按 hostVersion 升序，且要求文件自带 hostVersion', () => {
  assert.deepEqual(
    SURFACES.map((s) => s.hostVersion),
    ['1.0.0', '2.0.0'],
  )
})

test('readSurfaceDir：缺 hostVersion 的旧基线必须报错，而不是按文件名猜', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-surfaces-'))
  try {
    writeFileSync(join(dir, 'surface-1.0.0.json'), JSON.stringify({ packages: {} }), 'utf8')
    assert.throws(() => readSurfaceDir(dir), /hostVersion/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSurfaceDir：非法 JSON 与空目录都给出可读错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-surfaces-'))
  try {
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8')
    assert.throws(() => readSurfaceDir(dir), /不是合法 JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const empty = mkdtempSync(join(tmpdir(), 'dsh-surfaces-'))
  try {
    assert.throws(() => readSurfaceDir(empty), /没有 \.json/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

//#endregion

//#region checkUsageAgainstSurface

test('checkUsageAgainstSurface：同一份代码在 1.0.0 上全通过、在 2.0.0 上报出子路径与符号消失', () => {
  const usage = scanUsedApis(join(usageFixtures, 'uses-removed-api'))
  const [older, newer] = SURFACES

  const onOlder = checkUsageAgainstSurface(usage, older, UNIVERSE)
  assert.deepEqual(onOlder.missing, [], 'API 存在的那一侧不得有任何缺失')
  assert.equal(onOlder.checked, 2)

  const onNewer = checkUsageAgainstSurface(usage, newer, UNIVERSE)
  assert.equal(onNewer.missing.length, 2)
  const subpathMiss = onNewer.missing.find((m) => m.reason === 'noSubpath')
  assert.equal(subpathMiss?.package, '@deepseek-ai/dsh-llm')
  assert.equal(subpathMiss?.subpath, './invariant')
  const symbolMiss = onNewer.missing.find((m) => m.reason === 'noSymbol')
  assert.equal(symbolMiss?.package, '@deepseek-ai/dsh-tools')
  assert.deepEqual(symbolMiss?.symbols, ['defineTool'])
})

test('checkUsageAgainstSurface：整包消失要报 noPackage（这正是 diffApiSurface 的 removedPackage）', () => {
  const usage = { used: [{ package: '@deepseek-ai/dsh-gone', subpath: '.', symbols: ['x'] }], unverifiable: [] }
  const surface = { hostVersion: '1.0.0', surface: { packages: {} } }
  const result = checkUsageAgainstSurface(usage, surface, new Set(['@deepseek-ai/dsh-gone']))
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].reason, 'noPackage')
  // 同一份代码，若该包从未在任何 API 面里出现过，则按插件自有/第三方包跳过
  const outOfScope = checkUsageAgainstSurface(usage, surface, new Set())
  assert.deepEqual(outOfScope.missing, [])
  assert.deepEqual(outOfScope.outOfScope, ['@deepseek-ai/dsh-gone'])
})

test('checkUsageAgainstSurface：子路径无符号记录时算未知，不得报缺失', () => {
  const usage = { used: [{ package: '@deepseek-ai/dsh-llm', subpath: './nonjs', symbols: ['whatever'] }], unverifiable: [] }
  const surface = {
    hostVersion: '1.0.0',
    surface: { packages: { '@deepseek-ai/dsh-llm': { subpaths: ['./nonjs'], symbols: {} } } },
  }
  const result = checkUsageAgainstSurface(usage, surface, new Set(['@deepseek-ai/dsh-llm']))
  assert.deepEqual(result.missing, [], '“没记录符号”是未知，不是“没有这个符号”')
})

//#endregion

//#region deriveHostMatrix × surfaces

test('deriveHostMatrix：C069 只在缺 API 的那一侧触发，另一侧必须干净', () => {
  const clean = matrixFor('clean-api')
  const broken = matrixFor('uses-removed-api')

  assert.deepEqual(
    clean.findings.filter((f) => f.code === 'DSH-C069'),
    [],
    '近邻对照不得触发 C069',
  )
  const codes = broken.findings.filter((f) => f.code === 'DSH-C069')
  assert.equal(codes.length, 2)
  for (const finding of codes) assert.equal(finding.severity, 'error')
  // 两条都要点名 2.0.0，且不得冤枉 1.0.0
  for (const finding of codes) assert.match(finding.message, /2\.0\.0/)
  for (const finding of codes) assert.ok(!/1\.0\.0/.test(finding.message), `不得把 1.0.0 报成问题：${finding.message}`)
})

test('deriveHostMatrix：区间内没有 API 面的版本记入 uncovered，且绝不进 apiSafe', () => {
  const report = matrixFor('clean-api')
  const api = report.apiAvailability
  assert.deepEqual(api.uncovered, ['1.5.0'], '1.5.0 被声明覆盖但没有 API 面 —— 必须是未知')
  assert.deepEqual(api.apiSafe, ['1.0.0', '2.0.0'])
  assert.ok(!api.apiSafe.includes('1.5.0'), '未知不得混进“API 可用”集合')
  const row = api.rows.find((r) => r.version === '1.5.0')
  assert.equal(row.covered, false)
  assert.deepEqual(row.missing, [])
})

test('deriveHostMatrix：只 import 兄弟包时无发现，且兄弟包出现在 outOfScope', () => {
  const report = matrixFor('sibling-only')
  assert.deepEqual(
    report.findings.filter((f) => f.code === 'DSH-C069'),
    [],
    '兄弟包不是宿主 API，不得报缺失',
  )
  assert.deepEqual(report.apiAvailability.outOfScope, ['@deepseek-ai/dsh-plugin-mine'])
  assert.deepEqual(report.apiAvailability.used.length, 1)
})

test('deriveHostMatrix：glob 子路径不得被误报缺失', () => {
  const report = matrixFor('glob-subpath')
  assert.deepEqual(
    report.findings.filter((f) => f.code === 'DSH-C069'),
    [],
  )
  assert.deepEqual(report.apiAvailability.apiSafe, ['1.0.0', '2.0.0'])
})

test('deriveHostMatrix：不给 --surfaces 时 apiAvailability 为 null（不假装查过）', () => {
  const report = deriveHostMatrix(join(usageFixtures, 'clean-api'), { candidates: CANDIDATES })
  assert.equal(report.apiAvailability, null)
  assert.deepEqual(
    report.findings.filter((f) => f.code === 'DSH-C069'),
    [],
  )
})

test('deriveHostMatrix：未能核验的引用被如实列出，且不产生发现', () => {
  const report = matrixFor('unverifiable-api')
  assert.deepEqual(
    report.findings.filter((f) => f.code === 'DSH-C069'),
    [],
  )
  assert.equal(report.apiAvailability.unverifiable.length, 2)
  assert.equal(report.apiAvailability.used.length, 0)
})

//#endregion

//#region completeness

test('T18 覆盖了 rules.mjs 中声明的全部 T18 规则码', () => {
  const missing = API_USAGE_RULE_CODES.filter((code) => !exercised.has(code))
  assert.deepEqual(missing, [], `以下规则码未被任何用例触发：${missing.join(', ')}`)
})

//#endregion

//#region CLI

/** Run the host-matrix CLI; returns `{ code, stdout }`. */
function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: `${result.stdout}${result.stderr}` }
}

test('CLI：--surfaces 下缺 API 的包退出 1，干净的包退出 0', () => {
  const broken = runCli([
    join(usageFixtures, 'uses-removed-api'),
    '--candidates',
    join(usageFixtures, 'candidates.json'),
    '--surfaces',
    surfaceFixtures,
  ])
  assert.equal(broken.code, 1)
  assert.match(broken.stdout, /DSH-C069/)

  const clean = runCli([
    join(usageFixtures, 'clean-api'),
    '--candidates',
    join(usageFixtures, 'candidates.json'),
    '--surfaces',
    surfaceFixtures,
  ])
  assert.equal(clean.code, 0)
  assert.match(clean.stdout, /未知/)
})

test('CLI：--surfaces 指向坏目录是用法错误（退出 2），不是“插件有问题”', () => {
  const result = runCli([
    join(usageFixtures, 'clean-api'),
    '--candidates',
    join(usageFixtures, 'candidates.json'),
    '--surfaces',
    join(fixtures, 'does-not-exist'),
  ])
  assert.equal(result.code, 2)
  assert.match(result.stdout, /API 面目录不存在/)
})

test('CLI：真实已发布清单 + 真实 API 面目录自洽', () => {
  const realSurfaces = join(fixtures, 'host-surfaces')
  const result = runCli([
    join(usageFixtures, 'real-range'),
    '--candidates',
    join(fixtures, 'host-versions.published.json'),
    '--surfaces',
    realSurfaces,
    '--json',
  ])
  const parsed = JSON.parse(result.stdout)
  const api = parsed.reports[0].apiAvailability
  // real-range 的 peer 并集恰好覆盖 0.2.0-rc.2 与 0.2.1-alpha.1…alpha.4，
  // 而真实 API 面正好记录了这 5 个版本 —— 所以不该有未知格子，也不该有缺失。
  assert.deepEqual(api.uncovered, [], '该 fixture 的覆盖区间应被真实 API 面完全覆盖')
  assert.deepEqual(api.apiSafe, ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4'])
  assert.equal(parsed.reports[0].findings.length, 0, `不应有任何发现：${JSON.stringify(parsed.reports[0].findings)}`)
  assert.equal(result.code, 0)
})

test('真实 API 面自洽：每个文件都自带 hostVersion，且覆盖 EDA 声明区间的全部 5 个版本', () => {
  const real = readSurfaceDir(join(fixtures, 'host-surfaces'))
  assert.deepEqual(
    real.map((s) => s.hostVersion),
    ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4'],
  )
  for (const item of real) {
    assert.ok(Object.keys(item.surface.packages).length > 200, `${item.hostVersion} 的 API 面看起来不完整`)
  }
  // ./invariant 的移除是本项目反复引用的真实案例：rc.2 有、0.2.1 线没有。
  const rc2 = real.find((s) => s.hostVersion === '0.2.0-rc.2')
  const alpha1 = real.find((s) => s.hostVersion === '0.2.1-alpha.1')
  const hasInvariant = (item) =>
    Object.values(item.surface.packages).some((pkg) => (pkg.subpaths ?? []).includes('./invariant'))
  assert.equal(hasInvariant(rc2), true, 'rc.2 应当还有 ./invariant 子路径')
  assert.equal(hasInvariant(alpha1), false, '0.2.1-alpha.1 应当已移除 ./invariant —— 这是记录在案的平台移除')
})

//#endregion
