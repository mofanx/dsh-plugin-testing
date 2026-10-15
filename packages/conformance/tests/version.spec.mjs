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

test('预发布准入规则：无同元组预发布比较器时不匹配', () => {
  // npm 文档行为：1.2.3-beta 不满足 >=1.0.0，因为没有 1.2.3 上的预发布比较器。
  assert.equal(satisfies('1.2.3-beta', '>=1.0.0'), false)
  assert.equal(satisfies('1.2.3-beta', '>=1.2.3-alpha'), true)
})

test('diagnoseRange 区分 belowMin 与 aboveMax', () => {
  assert.equal(diagnoseRange('0.2.0-rc.2', '>=0.2.1-alpha.2 <0.3.0').direction, 'belowMin')
  assert.equal(diagnoseRange('2.0.1', '<2.0.0').direction, 'aboveMax')
  assert.equal(diagnoseRange('4.0.4', '~4.0.4').direction, null)
  assert.equal(diagnoseRange('4.0.4', '~4.0.4').satisfied, true)
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
