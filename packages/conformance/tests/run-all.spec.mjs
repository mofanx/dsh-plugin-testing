/**
 * T13 acceptance tests — the single gate command.
 *
 * The point of T13 is that CI turns red when a regression lands, so the
 * decisive case is "same command, one defective target added → `ok` flips to
 * false". Process exit codes are verified separately by the shell demo in the
 * task list; here the runner is exercised in-process.
 *
 * Run: node --test "tests/**\/*.spec.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expandPattern, expandTargets, loadConfig, runAll, summarize } from '../src/run-all.mjs'
import { CONFIG_RULE_CODES } from '../src/rules.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const toolRoot = dirname(here)
const healthyDir = join(toolRoot, 'examples', 'healthy')

const tempDirs = []
function makePackage(manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
  tempDirs.push(directory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest, null, 2))
  return directory
}
process.on('exit', () => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true })
})

/** Rule codes exercised so far, for the final T13 completeness assertion. */
const exercised = new Set()
function codesOf(outcome) {
  const codes = outcome.results.flatMap((result) => result.findings.map((finding) => finding.code))
  for (const code of codes) exercised.add(code)
  return codes
}

/** A minimal but valid profile directory (a `dsh.profile.bundles` manifest). */
function makeProfile() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-gate-profile-'))
  tempDirs.push(directory)
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify(
      { name: 'test-profile', version: '0.0.0', dsh: { profile: { bundles: [] } }, dependencies: {} },
      null,
      2,
    ),
  )
  return directory
}

/** A fake host tree whose `dsh-app-boot` carries the given runtime version. */
function makeHost(version) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-'))
  tempDirs.push(root)
  const pkgDir = join(root, '@deepseek-ai', 'dsh-app-boot')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version }))
  return root
}

/** A plugin whose dsh peer is genuinely unsatisfiable on the 0.2.0-rc.2 line. */
function makeBelowMinPlugin() {
  return makePackage({
    name: '@scope/dsh-plugin-belowmin',
    version: '1.0.0',
    exports: { '.': './lib/index.js', './package.json': './package.json' },
    engines: { dsh: '>=0.2.1-alpha.2 <0.3.0' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.2.1-alpha.2 <0.3.0' },
  })
}

test('expandPattern：尾部 /* 展开为含 package.json 的子目录', () => {
  const expanded = expandPattern(join(toolRoot, 'examples', '*'))
  assert.ok(expanded.includes(healthyDir), `应包含 ${healthyDir}，实际 [${expanded.join(', ')}]`)
  // 字面路径原样返回
  assert.deepEqual(expandPattern(healthyDir), [healthyDir])
  // 不存在的父目录返回空数组而不是抛错
  assert.deepEqual(expandPattern(join(toolRoot, 'no-such-dir', '*')), [])
})

test('loadConfig：缺失或非法配置回退为空对象', () => {
  assert.deepEqual(loadConfig(join(toolRoot, 'no-such-config.json')), {})
  // 用临时目录而非 toolRoot：避免把 bad.json 泄漏进源码目录（exit 时统一清理）。
  const bad = join(makePackage({ name: 'x', version: '1.0.0' }), 'bad.json')
  writeFileSync(bad, '{ not json')
  assert.deepEqual(loadConfig(bad), {})
})

test('runAll：健康示例零发现且 ok', () => {
  const outcome = runAll({ packages: [healthyDir] })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.packageDirs.length, 1)
  assert.deepEqual(outcome.results[0].findings, [])
})

test('runAll：注入回归后门禁变红（T13 的决定性用例）', () => {
  const broken = makePackage({
    name: '@demo/dsh-plugin-broken',
    version: '1.0.0',
    dsh: { manifestVersion: 2 },
    exports: { '.': './lib/index.js', './package.json': './package.json' },
    engines: { dsh: '0.2.0-rc.2' },
  })

  // 同一份配置，只是多了缺陷目标
  const green = runAll({ packages: [healthyDir] })
  const red = runAll({ packages: [healthyDir, broken] })
  assert.equal(green.ok, true)
  assert.equal(red.ok, false)

  const codes = red.results.flatMap((result) => result.findings.map((finding) => finding.code))
  assert.ok(codes.includes('DSH-C020'), `应报出 DSH-C020，实际 [${codes.join(', ')}]`)
})

test('summarize：按规则码聚合 error / warn', () => {
  const broken = makePackage({
    name: '@demo/dsh-plugin-warn-only',
    version: '1.0.0',
    exports: { '.': './lib/index.js', './package.json': './package.json' },
    // 缺 engines.dsh → DSH-C030 warn
  })
  const outcome = runAll({ packages: [broken] })
  const { byCode, errors, warns } = summarize(outcome.results)
  assert.equal(errors, 0)
  assert.equal(warns, 1)
  assert.equal(byCode.get('DSH-C030|warn')?.count, 1)
  // warn 不使 ok 变 false —— 门禁的 error/warn 分级由此生效
  assert.equal(outcome.ok, true)
})

test('summarize：同一规则码的两种级别必须分列，不能合并', () => {
  // DSH-C060 会因命中 compatibility.json 豁免而降级为 warn，所以同一个运行里
  // 同一代码出现两种级别是合法状态。若按 code 单键合并，先出现的那一级会覆盖
  // 另一级 —— count 和级别都会报错，且"降级"这件事在汇总里会消失。
  const results = [
    { findings: [{ code: 'DSH-C060', severity: 'error', message: '未豁免' }] },
    { findings: [{ code: 'DSH-C060', severity: 'warn', message: '已豁免' }] },
  ]
  const { byCode, errors, warns } = summarize(results)
  assert.equal(errors, 1)
  assert.equal(warns, 1)
  assert.equal(byCode.get('DSH-C060|error')?.count, 1)
  assert.equal(byCode.get('DSH-C060|warn')?.count, 1)
  assert.equal(byCode.size, 2)
})

// ---------------------------------------------------------------------------
// T13 — the gate's own configuration must fail loudly, never vacuously pass
// ---------------------------------------------------------------------------

test('expandTargets：报告匹配不到任何目标的模式', () => {
  const { dirs, unmatched } = expandTargets([healthyDir, join(toolRoot, 'no-such-dir', '*')])
  assert.deepEqual(dirs, [healthyDir])
  assert.deepEqual(unmatched, [join(toolRoot, 'no-such-dir', '*')])
})

test('DSH-C071：目标模式全部落空不得静默通过（T13 的决定性回归）', () => {
  // 旧行为：展开为空 → results 为空 → every() 恒真 → ok=true / exit 0。
  // 路径笔误、目录改名、盘符变化都会让门禁永远绿灯，比漏报单条规则更危险。
  const outcome = runAll({ packages: [join(toolRoot, 'no-such-dir', '*')], profiles: [] })
  assert.equal(outcome.targetCount, 0)
  assert.equal(outcome.ok, false, '零目标不得判为 ok')
  assert.deepEqual(outcome.unmatchedPatterns, [join(toolRoot, 'no-such-dir', '*')])
  const codes = codesOf(outcome)
  assert.ok(codes.includes('DSH-C071'), `应报出 DSH-C071，实际 [${codes.join(', ')}]`)
})

test('DSH-C071：部分目标落空时同样报错（不是只有全空才算）', () => {
  const outcome = runAll({ packages: [healthyDir, join(toolRoot, 'no-such-dir', '*')], profiles: [] })
  assert.equal(outcome.targetCount, 1)
  assert.equal(outcome.ok, false)
  assert.ok(codesOf(outcome).includes('DSH-C071'))
})

test('ok === true 蕴含"至少检查过一个目标"（库调用方的空集安全）', () => {
  // 回归：空 results 上 every() 恒真，所以 runAll({}) 曾返回 ok:true / targetCount:0。
  // 把 targetCount 纳入 ok 的定义后，"通过"必然意味着真的查过东西。
  const empty = runAll({ packages: [], profiles: [] })
  assert.equal(empty.targetCount, 0)
  assert.equal(empty.ok, false, '零目标不得判为通过')

  // 只声明 profile 也算检查过 —— 不应被误伤。
  const profilesOnly = runAll({ packages: [], profiles: [makeProfile()] })
  assert.equal(profilesOnly.targetCount, 1)
  assert.equal(profilesOnly.ok, true, '仅 profile 的健康目标应判为通过')
})

test('DSH-C070：宿主路径配了但不存在时不得退化成"未配置"', () => {
  // 回归：旧实现把不存在的路径静默变成 null，于是 dshRuntimeVersion 为
  // undefined，peer 预检直接 continue —— 一个字符的路径笔误就让版本门禁整体消失。
  const plugin = makeBelowMinPlugin()
  const realHost = makeHost('0.2.0-rc.2')

  // 宿主存在：坏 peer 必须被真实判出。
  const graded = runAll({ packages: [plugin], profiles: [], hostNodeModules: realHost })
  const gradedCodes = codesOf(graded)
  assert.equal(graded.ok, false)
  assert.ok(gradedCodes.includes('DSH-C060'), `宿主存在时应报 C060，实际 [${gradedCodes.join(', ')}]`)
  assert.ok(gradedCodes.includes('DSH-C064'))

  // 宿主路径写错：必须报 C070，而不是"没配宿主"的干净结果。
  const typo = runAll({ packages: [plugin], profiles: [], hostNodeModules: join(toolRoot, 'no-such-host') })
  const typoCodes = codesOf(typo)
  assert.equal(typo.ok, false, '宿主路径写错不得判为通过')
  assert.equal(typo.hostNodeModules, null)
  assert.ok(typoCodes.includes('DSH-C070'), `应报出 DSH-C070，实际 [${typoCodes.join(', ')}]`)
})

test('DSH-C070：显式配置但不存在的豁免文件不得被当作"已加载"', () => {
  const outcome = runAll({
    packages: [healthyDir],
    profiles: [],
    exemptionsPath: join(toolRoot, 'no-such-exemptions', 'compatibility.json'),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.exemptionsPath, null)
  assert.ok(codesOf(outcome).includes('DSH-C070'))
})

test('未配置宿主时不报 C070/D070：缺省仍是合法用法', () => {
  // 只有"显式声明却不存在"才升级为 error；完全不配宿主是文档支持的用法。
  const outcome = runAll({ packages: [healthyDir], profiles: [] })
  const codes = codesOf(outcome)
  assert.ok(!codes.includes('DSH-C070'), `未配置不应报 C070，实际 [${codes.join(', ')}]`)
  assert.deepEqual(codes, [])
})

test('DSH-C000 只报一次：package.json 不可读时不重复计入', () => {
  // manifest 与 peer 两趟都会在读不到 package.json 时报 C000，拼接后一个故障
  // 会被计成 2 个 error，体检卡与汇总计数随之失真。
  const empty = mkdtempSync(join(tmpdir(), 'dsh-gate-empty-'))
  tempDirs.push(empty)
  const outcome = runAll({ packages: [empty] })
  const codes = codesOf(outcome)
  assert.deepEqual(codes, ['DSH-C000'], `一个故障只应产生一条 C000，实际 [${codes.join(', ')}]`)
  assert.equal(outcome.results[0].findings.length, 1)
})

// --- completeness --------------------------------------------------------

test('T13 覆盖了 rules.mjs 中声明的全部配置规则码', () => {
  const missing = CONFIG_RULE_CODES.filter((code) => !exercised.has(code))
  assert.deepEqual(missing, [], `以下规则码未被任何用例触发：${missing.join(', ')}`)
})
