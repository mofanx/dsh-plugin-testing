/**
 * T12 acceptance tests.
 *
 * The satisfaction cases are pinned to npm-documented behaviour and to the two
 * real-world range shapes (a source-line prerelease floor and a stable floor).
 * The final case asserts every declared T12 rule code was actually exercised.
 *
 * Run: node --test "tests/**\/*.spec.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkPeerContract } from '../src/peer.mjs'
import { diagnoseRange, satisfies } from '../src/semver.mjs'
import { VERSION_RULE_CODES } from '../src/rules.mjs'

const tempDirs = []
function makePackage(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-version-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const exercised = new Set()
function codesOf(dir, options) {
  const codes = checkPeerContract(dir, options).map((finding) => finding.code)
  for (const code of codes) exercised.add(code)
  return codes
}
function expectCode(dir, options, code) {
  const codes = codesOf(dir, options)
  assert.ok(codes.includes(code), `期望 ${code}，实际得到 [${codes.join(', ')}]`)
}

/** The host as actually installed on this machine. */
const HOST = { '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/dsh-llm': '0.2.0-rc.2' }

// --- satisfaction semantics ---------------------------------------------

test('SemVer 满足性：与 npm 语义一致', () => {
  const cases = /** @type {[string, string, boolean][]} */ ([
    ['4.0.4', '~4.0.4', true],
    ['4.0.4', '~4.0.5-alpha.1', false],
    ['0.2.0-rc.2', '0.2.0-rc.2', true],
    ['0.2.0-rc.2', '>=0.2.1-alpha.2 <0.3.0', false],
    ['0.2.5', '>=0.2.1-alpha.2 <0.3.0', true],
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.2.3-beta', '>=1.2.3-alpha', true],
  ])
  for (const [version, range, expected] of cases) {
    assert.equal(satisfies(version, range), expected, `satisfies(${version}, ${JSON.stringify(range)}) 应为 ${expected}`)
  }
})

test('预发布准入规则：与运行时一致（includePrerelease: true）', () => {
  // 运行时 evaluatePluginCompatibility 用 semver.satisfies(..., { includePrerelease: true })，
  // 预发布宿主版本无条件参与匹配，不要求范围内有同元组预发布比较器。
  // 自实现的 npm 默认规则（require 同元组预发布比较器）会在这里误报。
  assert.equal(satisfies('1.2.3-beta', '>=1.0.0'), true)
  assert.equal(satisfies('1.2.3-beta', '>=1.2.3-alpha'), true)
  // P1-1 回归：预发布宿主 0.2.1-alpha.2 满足无预发布元组的范围 >=0.2.0 <0.3.0。
  // 这是团队目标线（源码线 0.2.1-alpha.x）上最易误报的形态。
  assert.equal(satisfies('0.2.1-alpha.2', '>=0.2.0 <0.3.0'), true)
})

test('diagnoseRange 区分 belowMin 与 aboveMax', () => {
  assert.equal(diagnoseRange('0.2.0-rc.2', '>=0.2.1-alpha.2 <0.3.0').direction, 'belowMin')
  assert.equal(diagnoseRange('2.0.1', '<2.0.0').direction, 'aboveMax')
  assert.equal(diagnoseRange('4.0.4', '~4.0.4').direction, null)
  assert.equal(diagnoseRange('4.0.4', '~4.0.4').satisfied, true)
})

test('diagnoseRange 的方向判定与满足性判定共用同一预发布策略', () => {
  // 满足性用 includePrerelease: true 对齐运行时；方向判定若用 npm 默认策略，
  // 同一个版本就可能被一个调用判为满足、被另一个判为"界外"。
  // 预发布宿主满足范围时不得给出方向。
  const satisfied = diagnoseRange('0.2.1-alpha.2', '>=0.2.0 <0.3.0')
  assert.equal(satisfied.satisfied, true)
  assert.equal(satisfied.direction, null)
  // 预发布版本位于下界之下 / 上界之上时仍要分得清方向。
  assert.equal(diagnoseRange('0.1.0-beta.1', '>=0.2.0-rc.2 <0.3.0').direction, 'belowMin')
  assert.equal(diagnoseRange('3.0.0-alpha.1', '<2.0.0').direction, 'aboveMax')
})

// --- peer contract -------------------------------------------------------

const SAMPLE = {
  name: '@sample/dsh-plugin-sample',
  version: '0.1.0',
  peerDependencies: {
    '@deepseek-ai/cordis': '>=4.0.5-alpha.1 <4.1.0',
    '@deepseek-ai/dsh-llm': '>=0.2.1-alpha.2 <0.3.0',
  },
}

test('peer 不满足宿主 → DSH-C060，且无豁免 → DSH-C064', () => {
  const dir = makePackage(SAMPLE)
  expectCode(dir, { hostVersions: HOST }, 'DSH-C060')
  expectCode(dir, { hostVersions: HOST }, 'DSH-C064')
})

test('有匹配豁免时不报 DSH-C064', () => {
  const dir = makePackage(SAMPLE)
  const exemptions = {
    '@sample/dsh-plugin-sample@0.1.0': ['0.2.0-rc.2'],
  }
  const codes = codesOf(dir, { hostVersions: HOST, exemptions })
  assert.ok(codes.includes('DSH-C060'), '仍应报 peer 不满足')
  assert.ok(!codes.includes('DSH-C064'), '豁免命中时不应报 DSH-C064')
})

test('cordis 系 peer 不满足宿主 → DSH-C057（warn，且不报 C060/C064）', () => {
  // 运行时预检只检查 @deepseek-ai/dsh 与 dsh-* peer；cordis 走 npm 解析。
  // 所以 cordis 不满足应报独立的 warn（C057），而非阻断性的 C060/C064。
  const dir = makePackage({
    name: '@scope/dsh-plugin-cordis-mismatch',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/cordis': '>=4.0.5-alpha.1 <4.1.0' },
  })
  const codes = codesOf(dir, { hostVersions: { '@deepseek-ai/cordis': '4.0.4' } })
  assert.ok(codes.includes('DSH-C057'), `期望 C057，实际 [${codes.join(', ')}]`)
  assert.ok(!codes.includes('DSH-C060'), 'cordis 不满足不应报 C060')
  assert.ok(!codes.includes('DSH-C064'), 'cordis 不满足不应报 C064')
  const finding = checkPeerContract(dir, { hostVersions: { '@deepseek-ai/cordis': '4.0.4' } }).find(
    (item) => item.code === 'DSH-C057',
  )
  assert.equal(finding?.severity, 'warn')
})

test('宿主版本过新 → DSH-C061（warn）', () => {
  const dir = makePackage({
    name: '@scope/dsh-plugin-old',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': '<2.0.0' },
  })
  const hostVersions = { '@deepseek-ai/dsh-llm': '3.0.0' }
  const finding = checkPeerContract(dir, { hostVersions, exemptions: { '@scope/dsh-plugin-old@1.0.0': ['3.0.0'] } }).find(
    (item) => item.code === 'DSH-C061',
  )
  exercised.add('DSH-C061')
  assert.ok(finding, '期望 DSH-C061')
  assert.equal(finding.severity, 'warn')
})

test('peer 范围跨主版本 → DSH-C062', () => {
  const dir = makePackage({
    name: '@scope/dsh-plugin-wide',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': '>=1.0.0 <3.0.0' },
  })
  expectCode(dir, { hostVersions: { '@deepseek-ai/dsh-llm': '2.0.0' } }, 'DSH-C062')
})

test('C062 不误报：单 major 范围与 0.x 线范围都不算跨主版本', () => {
  // >=1.0.0 <2.0.0 是 ^1.0.0 的展开，合法单 major 范围。
  const single = makePackage({
    name: '@scope/dsh-plugin-single-major',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': '>=1.0.0 <2.0.0' },
  })
  const singleCodes = codesOf(single, { hostVersions: { '@deepseek-ai/dsh-llm': '1.5.0' } })
  assert.ok(!singleCodes.includes('DSH-C062'), `单 major 范围不应报 C062，实际 [${singleCodes.join(', ')}]`)

  // 契约 §3.2 曾把 >=0.2.1-alpha.2 <0.3.0 列为"跨主版本"，但它 major 恒为 0，
  // 属于 0.x 线内范围，真正的问题（遗漏 0.2.0-rc.x）由 C060 belowMin 捕获。
  const zerox = makePackage({
    name: '@scope/dsh-plugin-zerox',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.2.1-alpha.2 <0.3.0' },
  })
  const zeroxCodes = codesOf(zerox, { hostVersions: { '@deepseek-ai/dsh-llm': '0.2.1-alpha.2' } })
  assert.ok(!zeroxCodes.includes('DSH-C062'), `0.x 线范围不应报 C062，实际 [${zeroxCodes.join(', ')}]`)

  // 显式并集跨两个 major 是诚实的分线声明，也不应报 C062。
  const union = makePackage({
    name: '@scope/dsh-plugin-union',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': '>=1.0.0 <2.0.0 || >=2.0.0 <3.0.0' },
  })
  const unionCodes = codesOf(union, { hostVersions: { '@deepseek-ai/dsh-llm': '1.5.0' } })
  assert.ok(!unionCodes.includes('DSH-C062'), `显式并集不应报 C062，实际 [${unionCodes.join(', ')}]`)
})

test('C062 覆盖单侧无界的范围：开放侧隐含宣称的 major 从未被验证', () => {
  // 回归：旧实现用正则匹配 ">=x.y.z" 三段版本，`>=1.0.0`（无上界）与
  // `<2.0.0`（无下界）都逃过判定 —— 而它们宣称的宿主线比双侧范围更多。
  for (const range of ['>=1.0.0', '>1.0.0', '<=3.0.0', '<2.0.0']) {
    const dir = makePackage({
      name: '@scope/dsh-plugin-open-ended',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh-llm': range },
    })
    expectCode(dir, { hostVersions: { '@deepseek-ai/dsh-llm': '1.5.0' } }, 'DSH-C062')
  }
})

test('C062 覆盖部分版本与连字符区间（不再依赖三段版本号的字面匹配）', () => {
  for (const range of ['>=1 <3', '1.0.0 - 4.0.0']) {
    const dir = makePackage({
      name: '@scope/dsh-plugin-partial',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh-llm': range },
    })
    expectCode(dir, { hostVersions: { '@deepseek-ai/dsh-llm': '1.5.0' } }, 'DSH-C062')
  }
})

test('C062 不误报：精确钉住 / caret / tilde / x-range / 单 major 双侧 / 通配', () => {
  // 这些形态要么只覆盖一条宿主线，要么是契约 §3.2 推荐的精确钉住写法，
  // 归一化为 semver 比较器后必须仍然干净。
  for (const range of ['0.2.0-rc.2', '^1.0.0', '~1.2.3', '1.x', '>=1.0.0 <2.0.0', '*']) {
    const dir = makePackage({
      name: '@scope/dsh-plugin-bounded',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh-llm': range },
    })
    const codes = codesOf(dir, { hostVersions: { '@deepseek-ai/dsh-llm': '1.5.0' } })
    assert.ok(!codes.includes('DSH-C062'), `${range} 不应报 C062，实际 [${codes.join(', ')}]`)
  }
})

test('engines.dsh 与 peer 范围不一致 → DSH-C063', () => {
  const dir = makePackage({
    name: '@scope/dsh-plugin-mismatch',
    version: '1.0.0',
    engines: { dsh: '0.2.0-rc.2' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-alpha.2' },
  })
  expectCode(dir, { hostVersions: { '@deepseek-ai/dsh-llm': '0.2.1-alpha.2' } }, 'DSH-C063')
})

test('豁免条目版本已过期 → DSH-C065（warn）', () => {
  const dir = makePackage({
    name: '@scope/dsh-plugin-bump',
    version: '2.0.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.0-rc.2' },
  })
  const exemptions = { '@scope/dsh-plugin-bump@1.0.0': ['0.2.0-rc.2'] }
  const finding = checkPeerContract(dir, { hostVersions: HOST, exemptions }).find((item) => item.code === 'DSH-C065')
  exercised.add('DSH-C065')
  assert.ok(finding, '期望 DSH-C065')
  assert.equal(finding.severity, 'warn')
})

test('peer 完全满足时零发现', () => {
  const dir = makePackage({
    name: '@scope/dsh-plugin-ok',
    version: '1.0.0',
    engines: { dsh: '0.2.0-rc.2' },
    peerDependencies: { '@deepseek-ai/cordis': '~4.0.4', '@deepseek-ai/dsh-llm': '0.2.0-rc.2' },
  })
  assert.deepEqual(codesOf(dir, { hostVersions: HOST }), [])
})

// --- completeness --------------------------------------------------------

test('T12 覆盖了 rules.mjs 中声明的全部 T12 规则码', () => {
  const missing = VERSION_RULE_CODES.filter((code) => !exercised.has(code))
  assert.deepEqual(missing, [], `以下规则码未被任何用例触发：${missing.join(', ')}`)
})
