/**
 * T11 acceptance tests.
 *
 * Each rule gets a synthetic profile whose only defect is that rule, so a
 * finding can be attributed unambiguously. The last case asserts every
 * declared T11 rule code was exercised.
 *
 * Run: node --test "tests/**\/*.spec.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkComposition, collectMountedPackageNames, composeLayers, parsePatchText } from '../src/composition.mjs'
import { COMPOSITION_RULE_CODES } from '../src/rules.mjs'

const tempDirs = []
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** @param {string[]} segments */
function pkgDir(root, name) {
  return join(root, 'node_modules', ...name.split('/'))
}

/**
 * @param {{
 *   bundles?: string[],
 *   bundlePackages?: { name: string, patchYml: string, order?: object }[],
 *   installed?: object[],
 *   dependencies?: Record<string, string>,
 *   userPatch?: string,
 *   lockfile?: string,
 * }} spec
 */
function makeProfile(spec) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-composition-'))
  tempDirs.push(root)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'test-profile',
        version: '0.0.0',
        dsh: { profile: { bundles: spec.bundles ?? [] } },
        dependencies: spec.dependencies ?? {},
      },
      null,
      2,
    ),
  )
  for (const bundle of spec.bundlePackages ?? []) {
    const directory = pkgDir(root, bundle.name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify(
        {
          name: bundle.name,
          version: '1.0.0',
          dsh: {
            manifestVersion: 1,
            bundle: { patch: './cordis.patch.yml', ...(bundle.order === undefined ? {} : { order: bundle.order }) },
          },
        },
        null,
        2,
      ),
    )
    writeFileSync(join(directory, 'cordis.patch.yml'), bundle.patchYml)
  }
  for (const pkg of spec.installed ?? []) {
    const directory = pkgDir(root, pkg.name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg, null, 2))
  }
  if (spec.userPatch !== undefined) writeFileSync(join(root, 'cordis.patch.yml'), spec.userPatch)
  if (spec.lockfile !== undefined) writeFileSync(join(root, 'pnpm-lock.yaml'), spec.lockfile)
  return root
}

const insert = (id, name) => `- insert:\n    - id: ${id}\n      name: '${name}'\n`

/** A directory that looks like a DSH application root (holds `cordis.patch.yml`). */
function makeAppDir(patchYml) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-'))
  tempDirs.push(root)
  writeFileSync(join(root, 'cordis.patch.yml'), patchYml)
  return root
}

/** A directory that looks like a DSH install's `node_modules`. */
function makeFakeHost(names) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-'))
  tempDirs.push(root)
  for (const name of names) {
    const directory = join(root, ...name.split('/'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '0.2.0-rc.2' }))
  }
  return root
}

const exercised = new Set()
function codesOf(dir, options = {}) {
  const codes = checkComposition(dir, { hostNodeModules: null, homeDir: null, ...options }).map((f) => f.code)
  for (const code of codes) exercised.add(code)
  return codes
}
function expectCode(dir, code, options) {
  const codes = codesOf(dir, options)
  assert.ok(codes.includes(code), `期望 ${code}，实际得到 [${codes.join(', ')}]`)
}

// --- patch parsing -------------------------------------------------------

test('patch 解析：识别 entry list 与 !!js 表达式', () => {
  const parsed = parsePatchText("- insert:\n    - id: a\n      name: 'x'\n      disabled: !!js \"!ctx.get('p')\"\n")
  assert.ok(Array.isArray(parsed), '应为 entry list')
  assert.equal(parsed[0].insert[0].id, 'a')
  assert.equal(parsed[0].insert[0].disabled.__jsExpr, "!ctx.get('p')")
  assert.equal(parsePatchText('not: a list\n'), null)
})

test('组合算法：insert 无 id 为顶层追加，patch 覆盖已存在行', () => {
  const layers = [
    { label: 'l1', kind: 'bundle', patches: parsePatchText(insert('alpha', 'pkg-a')) },
    { label: 'l2', kind: 'user', patches: parsePatchText('- id: alpha\n  disabled: true\n') },
  ]
  const composed = composeLayers(layers)
  assert.equal(composed.rows.length, 1)
  assert.deepEqual(composed.duplicates, [])
  assert.deepEqual(composed.orphans, [])
  assert.equal(composed.overrides.length, 1)
  assert.equal(composed.overrides[0].id, 'alpha')
})

// --- happy path ----------------------------------------------------------

test('健康的单 bundle profile 零发现', () => {
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
  })
  assert.deepEqual(codesOf(dir), [])
})

// --- the six rules -------------------------------------------------------

test('重复 loader entry id → DSH-C052', () => {
  const dir = makeProfile({
    bundles: ['bundle-a', 'bundle-b'],
    bundlePackages: [
      { name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') },
      { name: 'bundle-b', patchYml: insert('alpha', 'pkg-alpha') },
    ],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
  })
  expectCode(dir, 'DSH-C052')
})

test('宿主核心包出现在 dependencies → DSH-C050', () => {
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [
      { name: 'pkg-alpha', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-llm': '0.2.0-rc.2' } },
    ],
  })
  expectCode(dir, 'DSH-C050')
})

test('lockfile 出现多版本核心包 → DSH-C051', () => {
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
    lockfile: [
      "lockfileVersion: '9.0'",
      'packages:',
      "  '@deepseek-ai/dsh-llm@0.2.0-rc.2':",
      '    resolution: {integrity: sha512-aaa}',
      "  '@deepseek-ai/dsh-llm@0.2.1-alpha.2':",
      '    resolution: {integrity: sha512-bbb}',
      '',
    ].join('\n'),
  })
  expectCode(dir, 'DSH-C051')
})

test('user patch 引用未安装的包 → DSH-C053', () => {
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
    userPatch: insert('ghost', 'ghost-pkg'),
  })
  expectCode(dir, 'DSH-C053')
})

test('bundle 顺序违反自身声明的 order → DSH-C054', () => {
  const dir = makeProfile({
    bundles: ['bundle-a', 'bundle-b'],
    bundlePackages: [
      { name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha'), order: { after: ['bundle-b'] } },
      { name: 'bundle-b', patchYml: insert('beta', 'pkg-beta') },
    ],
    installed: [
      { name: 'pkg-alpha', version: '1.0.0' },
      { name: 'pkg-beta', version: '1.0.0' },
    ],
  })
  expectCode(dir, 'DSH-C054')
})

test('patch 指向不存在的 entry id → DSH-C055', () => {
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
    userPatch: '- id: does-not-exist\n  disabled: true\n',
  })
  expectCode(dir, 'DSH-C055')
})

test('合规的 order 声明不报 DSH-C054', () => {
  const dir = makeProfile({
    bundles: ['bundle-a', 'bundle-b'],
    bundlePackages: [
      { name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') },
      { name: 'bundle-b', patchYml: insert('beta', 'pkg-beta'), order: { after: ['bundle-a'] } },
    ],
    installed: [
      { name: 'pkg-alpha', version: '1.0.0' },
      { name: 'pkg-beta', version: '1.0.0' },
    ],
  })
  assert.deepEqual(codesOf(dir), [])
})

test('宿主工具类包出现在 dependencies → DSH-C056（warn，非 C050）', () => {
  const hostNodeModules = makeFakeHost(['@deepseek-ai/dsh-util-values'])
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [
      { name: 'pkg-alpha', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-util-values': '0.2.0-rc.2' } },
    ],
  })
  const findings = checkComposition(dir, { hostNodeModules, homeDir: null })
  const warn = findings.find((f) => f.code === 'DSH-C056')
  exercised.add('DSH-C056')
  assert.ok(warn, `期望 DSH-C056，实际得到 [${findings.map((f) => f.code).join(', ')}]`)
  assert.equal(warn.severity, 'warn')
  assert.ok(!findings.some((f) => f.code === 'DSH-C050'), '叶子工具包不应升级为 C050')
})

// --- focusPackages：把"别人的包"从报告里摘出去 --------------------------

test('focusPackages：非关注包的 profile 级发现被过滤，并计入统计（不静默丢弃）', () => {
  // 主用例是"检查我自己的插件"：profile 级检查会连带报出宿主自带组件与第三方
  // 插件的问题，其中 DSH-C050 是 error 级，足以让作者的门禁失败在别人的包上。
  const hostNodeModules = makeFakeHost(['@deepseek-ai/dsh-home-paths'])
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [
      { name: 'pkg-alpha', version: '1.0.0' },
      { name: 'someone-elses-plugin', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-home-paths': '0.2.0-rc.2' } },
      { name: '@me/dsh-plugin-mine', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-home-paths': '0.2.0-rc.2' } },
    ],
  })
  const stats = { filteredByFocus: 0 }
  const findings = checkComposition(dir, {
    hostNodeModules,
    homeDir: null,
    focus: (name) => name.startsWith('@me/'),
    stats,
  })
  const c050 = findings.filter((f) => f.code === 'DSH-C050')
  assert.equal(c050.length, 1, `只应保留关注包的 C050，实际 [${findings.map((f) => f.message).join(' | ')}]`)
  assert.match(c050[0].message, /@me\/dsh-plugin-mine/, '保留的必须是关注包')
  assert.equal(stats.filteredByFocus, 1, '被过滤的条目必须计数，不能静默丢弃')
})

test('focusPackages：profile 自身的 dependencies 永远在关注范围内', () => {
  // profile 的依赖列表是作者自己要修的，不能因为 focus 不匹配被摘掉。
  const hostNodeModules = makeFakeHost(['@deepseek-ai/dsh-home-paths'])
  const dir = makeProfile({
    bundles: [],
    installed: [],
    dependencies: { '@deepseek-ai/dsh-home-paths': '0.2.0-rc.2' },
  })
  const stats = { filteredByFocus: 0 }
  const findings = checkComposition(dir, { hostNodeModules, homeDir: null, focus: () => false, stats })
  assert.ok(
    findings.some((f) => f.code === 'DSH-C050'),
    `profile 自身的 C050 不应被 focus 过滤，实际 [${findings.map((f) => f.code).join(', ')}]`,
  )
  assert.equal(stats.filteredByFocus, 0)
})

// --- group carriers (regressions pinned from the boot's own semantics) ----

const GROUP_PATCH = [
  '- insert:',
  '    - id: my-group',
  '      group: true',
  '      config:',
  '        - id: child',
  "          name: 'pkg-alpha'",
  '',
].join('\n')

test('user patch 里的 group 容器不报 DSH-C053（carrier 误报回归）', () => {
  // 回归：`group: true` 是**载体**（boot 解析为内建 cordis:group），不是模块，
  // 因此它没有模块名也不该被要求有。此前它被当作可导入行，导致任何合法的
  // group 声明都触发阻断级 DSH-C053「没有模块名」。
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
    userPatch: GROUP_PATCH,
  })
  const findings = checkComposition(dir, { hostNodeModules: null, homeDir: null })
  assert.deepEqual(
    findings.map((f) => f.code),
    [],
    `合法的 group 容器应零发现，实际 [${findings.map((f) => f.code).join(', ')}]`,
  )
})

test('group 的子行仍按可导入行核对（C053 不因载体而被削弱）', () => {
  // 反向保证：容器本身不报，但它引用的包确实没装时仍要报。
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
    userPatch: GROUP_PATCH.replace("name: 'pkg-alpha'", "name: 'pkg-not-installed'"),
  })
  expectCode(dir, 'DSH-C053')
})

test('group 的子行在 group 被禁用时不算挂载', () => {
  // boot：`if (row.disabled === true && !row.group) continue` —— group 被保留是
  // 为了带走子行，但禁用的 group 下子行不应再被视为可导入。
  const layers = [
    {
      label: 'user',
      kind: 'user',
      patches: parsePatchText(GROUP_PATCH.replace('      group: true', '      group: true\n      disabled: true')),
    },
  ]
  assert.deepEqual(composeLayers(layers).resolvableRows, [])
})

test('group 容器不进入挂载包集合（T15 判级不受载体污染）', () => {
  // 载体本身是"可解析行"（boot 会把它解析成内建插件），但它**不是**一个已挂载的
  // npm 包。用内建名声明的那种写法尤其容易污染：packageRoot('cordis:group')
  // 会返回 'cordis:group'，从而混进决定 C060/C066 分级的集合。
  const viaFlag = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
    userPatch: GROUP_PATCH,
  })
  assert.deepEqual([...collectMountedPackageNames(viaFlag, { hostNodeModules: null, homeDir: null })].sort(), ['pkg-alpha'])

  const viaBuiltinName = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
    userPatch: "- insert:\n    - id: g2\n      name: 'cordis:group'\n      config: []\n",
  })
  assert.deepEqual(
    [...collectMountedPackageNames(viaBuiltinName, { hostNodeModules: null, homeDir: null })].sort(),
    ['pkg-alpha'],
  )
})

// --- regressions pinned from the real Desktop profile --------------------

test('app 层插入的 id 被 user patch 引用时不报 DSH-C055（真实误报回归）', () => {
  const appDir = makeAppDir(insert('shell-entry', 'dsh-desktop-next'))
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed: [{ name: 'pkg-alpha', version: '1.0.0' }],
    userPatch: '- id: shell-entry\n  disabled: false\n',
  })
  assert.deepEqual(codesOf(dir, { appDir }), [])
})

test('宿主自带的包不被当作第三方插件报 DSH-C050（真实误报回归）', () => {
  const installed = [
    { name: 'pkg-alpha', version: '1.0.0' },
    { name: '@deepseek-ai/dsh-lsp-stdio', version: '0.2.0-rc.2', dependencies: { '@deepseek-ai/dsh-llm': '0.2.0-rc.2' } },
  ]
  const dir = makeProfile({
    bundles: ['bundle-a'],
    bundlePackages: [{ name: 'bundle-a', patchYml: insert('alpha', 'pkg-alpha') }],
    installed,
  })
  // Without a host, the dependent looks like an ordinary plugin → C050.
  expectCode(dir, 'DSH-C050')
  // With a host that itself ships it, its dependency list is host-internal.
  const hostNodeModules = makeFakeHost(['@deepseek-ai/dsh-lsp-stdio'])
  assert.deepEqual(codesOf(dir, { hostNodeModules }), [])
})

// --- completeness --------------------------------------------------------

test('T11 覆盖了 rules.mjs 中声明的全部 T11 规则码', () => {
  const missing = COMPOSITION_RULE_CODES.filter((code) => !exercised.has(code))
  assert.deepEqual(missing, [], `以下规则码未被任何用例触发：${missing.join(', ')}`)
})
