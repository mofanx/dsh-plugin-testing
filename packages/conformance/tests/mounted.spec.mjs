/**
 * T15 acceptance tests — mounted rows vs support packages.
 *
 * The rule this pins comes from a real production failure: the host's version
 * preflight only evaluates `peerDependencies` of rows it would import. So an
 * out-of-range peer on a *mounted* row is blocking, while the identical
 * declaration on a *support* package (never inserted as a row) is latent.
 *
 * The decisive case mirrors reality: sibling packages of one repo behave
 * differently — the mounted rows were disabled by the host, the support
 * package was not.
 *
 * Run: node --test "tests/**\/*.spec.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectMountedPackageNames } from '../src/composition.mjs'
import { checkPeerContract } from '../src/peer.mjs'
import { runAll } from '../src/run-all.mjs'
import { MOUNTED_RULE_CODES } from '../src/rules.mjs'

const tempDirs = []
function temp(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}
process.on('exit', () => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true })
})

const exercised = new Set()

/** A package whose only defect is an out-of-range DSH peer. */
function makePlugin(name, { peerRange = '>=0.2.1-alpha.2 <0.3.0' } = {}) {
  const directory = temp('dsh-pkg-')
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '0.1.0-alpha.1',
        type: 'module',
        exports: { '.': './lib/index.js', './package.json': './package.json' },
        engines: { node: '>=22.19.0', dsh: '0.2.1-alpha.2' },
        peerDependencies: { '@deepseek-ai/dsh-llm': peerRange },
      },
      null,
      2,
    ),
  )
  return directory
}

function makeHost() {
  const root = temp('dsh-host-')
  const directory = join(root, '@deepseek-ai', 'dsh-llm')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.2.0-rc.2' }))
  return { root, hostVersions: { '@deepseek-ai/dsh-llm': '0.2.0-rc.2' } }
}

/** A profile whose single bundle inserts exactly the given row names. */
function makeProfile(rows) {
  const profileDir = temp('dsh-profile-')
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: ['bundle-x'] } } }, null, 2),
  )
  const bundleDir = join(profileDir, 'node_modules', 'bundle-x')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: 'bundle-x', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2),
  )
  const entries = rows.map((row) => `    - id: ${row.id}\n      name: '${row.name}'\n`).join('')
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), `- insert:\n${entries}`)
  return profileDir
}

// --- mounted-name discovery ---------------------------------------------

test('collectMountedPackageNames：取自 patch 行，含 user patch 插入的行', () => {
  const profileDir = makeProfile([
    { id: 'optional-sample', name: '@sample/dsh-plugin-sample-sch' },
    { id: 'optional-sample-gen', name: '@sample/dsh-plugin-sample-sch-gen' },
  ])
  writeFileSync(join(profileDir, 'cordis.patch.yml'), "- insert:\n    - id: extra\n      name: 'pkg-extra'\n")
  const names = collectMountedPackageNames(profileDir, {})
  assert.deepEqual([...names].sort(), ['@sample/dsh-plugin-sample-sch', '@sample/dsh-plugin-sample-sch-gen', 'pkg-extra'])
  // 支撑包（从不出现在行里）不应被计入
  assert.ok(!names.has('@sample/dsh-plugin-sample-core'))
})

test('collectMountedPackageNames：被显式 disabled 的行不算挂载', () => {
  const profileDir = makeProfile([{ id: 'a', name: 'pkg-a' }])
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: a\n  disabled: true\n')
  assert.equal(collectMountedPackageNames(profileDir, {}).size, 0)
})

// --- the grading rule ----------------------------------------------------

test('被挂载的行：不满足 peer → C060 error（保持阻断）', () => {
  const directory = makePlugin('@demo/pkg-mounted')
  const { hostVersions } = makeHost()
  const findings = checkPeerContract(directory, { hostVersions, mountedNames: new Set(['@demo/pkg-mounted']) })
  const codes = findings.map((f) => f.code)
  for (const code of codes) exercised.add(code)
  assert.ok(codes.includes('DSH-C060'), `期望 C060，实际 [${codes.join(', ')}]`)
  assert.ok(codes.includes('DSH-C064'), `期望 C064（无豁免），实际 [${codes.join(', ')}]`)
})

test('支撑包：同样的 peer 不满足 → C066 warn，且不报 C060/C064', () => {
  const directory = makePlugin('@demo/pkg-support')
  const { hostVersions } = makeHost()
  const findings = checkPeerContract(directory, { hostVersions, mountedNames: new Set(['@demo/pkg-mounted']) })
  const codes = findings.map((f) => f.code)
  for (const code of codes) exercised.add(code)
  assert.deepEqual(codes, ['DSH-C066'], `应只有 C066，实际 [${codes.join(', ')}]`)
  assert.equal(findings[0].severity, 'warn')
})

test('不提供 profile 时保持保守默认：不满足 peer 仍按 C060 error', () => {
  const directory = makePlugin('@demo/pkg-unknown')
  const { hostVersions } = makeHost()
  const findings = checkPeerContract(directory, { hostVersions })
  const codes = findings.map((f) => f.code)
  assert.ok(codes.includes('DSH-C060'), `保守默认下应报 C060，实际 [${codes.join(', ')}]`)
})

// --- end-to-end: the mounted-vs-support shape ----------------------------

test('端到端：行被阻断、支撑包仅告警（同一仓库两个包的差异）', () => {
  const host = makeHost()
  const mounted = makePlugin('@demo/pkg-mounted')
  const support = makePlugin('@demo/pkg-support')
  const profileDir = makeProfile([{ id: 'row-mounted', name: '@demo/pkg-mounted' }])

  const outcome = runAll({
    hostNodeModules: host.root,
    packages: [mounted, support],
    profiles: [profileDir],
  })

  assert.equal(outcome.mountedPackageCount, 1, '只应识别出 1 个被挂载的包')

  const codesFor = (target) => outcome.results.find((r) => r.target === target)?.findings.map((f) => f.code) ?? []
  const mountedCodes = codesFor(mounted)
  const supportCodes = codesFor(support)

  assert.ok(mountedCodes.includes('DSH-C060'), `被挂载的包应报 C060，实际 [${mountedCodes.join(', ')}]`)
  assert.ok(!supportCodes.includes('DSH-C060'), `支撑包不应报 C060，实际 [${supportCodes.join(', ')}]`)
  assert.ok(supportCodes.includes('DSH-C066'), `支撑包应报 C066，实际 [${supportCodes.join(', ')}]`)

  // 支撑包单独存在时门禁是绿的 —— 这正是 T15 要修正的过度报告
  assert.equal(outcome.ok, false, '被挂载的包使门禁变红')
  const supportOnly = runAll({ hostNodeModules: host.root, packages: [support], profiles: [profileDir] })
  assert.equal(supportOnly.ok, true, '只有支撑包时门禁应为绿')
})

// --- completeness --------------------------------------------------------

test('T15 覆盖了 rules.mjs 中声明的全部 T15 规则码', () => {
  const missing = MOUNTED_RULE_CODES.filter((code) => !exercised.has(code))
  assert.deepEqual(missing, [], `以下规则码未被任何用例触发：${missing.join(', ')}`)
})
