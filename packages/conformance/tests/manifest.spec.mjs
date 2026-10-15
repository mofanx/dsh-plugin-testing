/**
 * T10 acceptance tests.
 *
 * Covers the five deliberate breakages named in the task list plus the rest of
 * the T10 rule surface, and — in the last case — asserts that every rule code
 * declared as T10 in `rules.mjs` was actually exercised by this file. That
 * last check is what keeps the suite honest as rules are added.
 *
 * Run: node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { checkManifest } from '../src/manifest.mjs'
import { isValidSemverRange } from '../src/semver.mjs'
import { MANIFEST_RULE_CODES } from '../src/rules.mjs'

// --- fixtures ------------------------------------------------------------

const tempDirs = []
function makePackage(manifest, files = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-conformance-'))
  tempDirs.push(dir)
  writeFileSync(
    join(dir, 'package.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
  )
  for (const rel of files) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '')
  }
  return dir
}
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Rule codes exercised so far, for the final completeness assertion. */
const exercised = new Set()

function codesOf(dir) {
  const codes = checkManifest(dir).map((finding) => finding.code)
  for (const code of codes) exercised.add(code)
  return codes
}

/** Assert the package yields `code`, and record it as exercised. */
function expectCode(dir, code) {
  const codes = codesOf(dir)
  assert.ok(codes.includes(code), `期望 ${code}，实际得到 [${codes.join(', ')}]`)
}

// Base fixtures -----------------------------------------------------------

const HOST_ONLY = {
  name: '@scope/dsh-plugin-a',
  version: '1.0.0',
  exports: { '.': './lib/index.js', './package.json': './package.json' },
  engines: { node: '>=22.19.0', dsh: '0.2.0-rc.2' },
}

const BUNDLE_OK = {
  ...HOST_ONLY,
  exports: {
    '.': './lib/index.js',
    './cordis.patch.yml': './cordis.patch.yml',
    './presets/*.patch.yml': './presets/*.patch.yml',
    './package.json': './package.json',
  },
  dsh: {
    manifestVersion: 1,
    bundle: { patch: ['./cordis.patch.yml', './presets/standard.patch.yml'] },
  },
}
const BUNDLE_FILES = ['cordis.patch.yml', 'presets/standard.patch.yml']

const CLIENT_OK = {
  ...HOST_ONLY,
  exports: {
    '.': './lib/index.js',
    './client': './client/client.js',
    './package.json': './package.json',
  },
  dsh: { manifestVersion: 1, client: { platform: 'web' } },
}

// --- happy paths ---------------------------------------------------------

test('合法的纯宿主插件零发现', () => {
  assert.deepEqual(codesOf(makePackage(HOST_ONLY)), [])
})

test('合法的组合包（patch 列表 + 通配 exports）零发现', () => {
  assert.deepEqual(codesOf(makePackage(BUNDLE_OK, BUNDLE_FILES)), [])
})

test('合法的客户端半边零发现', () => {
  assert.deepEqual(codesOf(makePackage(CLIENT_OK, ['client/client.js'])), [])
})

// --- the five deliberate breakages named in T10 -------------------------

test('破坏 1：缺 bundle.patch → DSH-C010', () => {
  const dir = makePackage({ ...BUNDLE_OK, dsh: { manifestVersion: 1, bundle: {} } }, BUNDLE_FILES)
  expectCode(dir, 'DSH-C010')
})

test('破坏 2：patch 文件缺失 → DSH-C012', () => {
  const dir = makePackage(BUNDLE_OK, ['cordis.patch.yml']) // presets/standard.patch.yml 缺失
  expectCode(dir, 'DSH-C012')
})

test("破坏 3：exports 缺 '.' → DSH-C040", () => {
  const dir = makePackage({
    ...HOST_ONLY,
    exports: { './package.json': './package.json' },
  })
  expectCode(dir, 'DSH-C040')
})

test('破坏 4：client 半边缺 platform → DSH-C021', () => {
  const dir = makePackage({
    ...CLIENT_OK,
    dsh: { manifestVersion: 1, client: { inject: ['@deepseek-ai/dsh-client-ui-slots'] } },
  }, ['client/client.js'])
  expectCode(dir, 'DSH-C021')
})

test('破坏 5：manifestVersion 非 1 → DSH-C020', () => {
  const dir = makePackage({ ...HOST_ONLY, dsh: { manifestVersion: 2 } })
  expectCode(dir, 'DSH-C020')
})

// --- remaining T10 surface ----------------------------------------------

test('identity：缺 name / version → DSH-C001 / DSH-C002', () => {
  const dir = makePackage({
    exports: { '.': './lib/index.js', './package.json': './package.json' },
    engines: { dsh: '0.2.0-rc.2' },
  })
  expectCode(dir, 'DSH-C001')
  expectCode(dir, 'DSH-C002')
})

test('package.json 非法 JSON → DSH-C000', () => {
  expectCode(makePackage('{ not json'), 'DSH-C000')
})

test('bundle.patch 类型错误 → DSH-C011', () => {
  const dir = makePackage({ ...BUNDLE_OK, dsh: { manifestVersion: 1, bundle: { patch: 42 } } }, BUNDLE_FILES)
  expectCode(dir, 'DSH-C011')
})

test('bundle.patch 空数组 → DSH-C013', () => {
  const dir = makePackage({ ...BUNDLE_OK, dsh: { manifestVersion: 1, bundle: { patch: [] } } }, BUNDLE_FILES)
  expectCode(dir, 'DSH-C013')
})

test('client.inject 类型错误 → DSH-C022', () => {
  const dir = makePackage({
    ...CLIENT_OK,
    dsh: { manifestVersion: 1, client: { platform: 'web', inject: 'not-an-array' } },
  }, ['client/client.js'])
  expectCode(dir, 'DSH-C022')
})

test('profile.bundles 类型错误 → DSH-C023', () => {
  const dir = makePackage({
    ...HOST_ONLY,
    dsh: { manifestVersion: 1, profile: { bundles: [1, 2] } },
  })
  expectCode(dir, 'DSH-C023')
})

test('缺 engines.dsh → DSH-C030（warn）', () => {
  const dir = makePackage({
    name: '@scope/dsh-plugin-a',
    version: '1.0.0',
    exports: { '.': './lib/index.js', './package.json': './package.json' },
  })
  const warn = checkManifest(dir).find((f) => f.code === 'DSH-C030')
  exercised.add('DSH-C030')
  assert.ok(warn, '期望 DSH-C030')
  assert.equal(warn.severity, 'warn')
})

test('engines.dsh 语法非法 → DSH-C031', () => {
  const dir = makePackage({ ...HOST_ONLY, engines: { dsh: 'abc' } })
  expectCode(dir, 'DSH-C031')
})

test('exports 全局缺失 → DSH-C040 与 DSH-C041', () => {
  const dir = makePackage({
    name: '@scope/dsh-plugin-a',
    version: '1.0.0',
    engines: { dsh: '0.2.0-rc.2' },
  })
  expectCode(dir, 'DSH-C040')
  expectCode(dir, 'DSH-C041')
})

test("exports 缺 './package.json' → DSH-C041", () => {
  const dir = makePackage({ ...HOST_ONLY, exports: { '.': './lib/index.js' } })
  expectCode(dir, 'DSH-C041')
})

test('bundle.patch 未被 exports 覆盖 → DSH-C042', () => {
  const dir = makePackage({
    ...BUNDLE_OK,
    exports: { '.': './lib/index.js', './package.json': './package.json' },
  }, BUNDLE_FILES)
  expectCode(dir, 'DSH-C042')
})

test("bundle.patch 不写 './' 前缀时不得误报 DSH-C042", () => {
  // 回归：patch 路径"相对于包根"（契约 §1.2），加载器按普通路径解析，
  // `cordis.patch.yml` 与 `./cordis.patch.yml` 指向同一文件；而 exports 的键
  // 必须以 './' 开头。逐字比对曾把这种完全合法的写法判成 C042。
  const dir = makePackage(
    {
      ...BUNDLE_OK,
      exports: {
        '.': './lib/index.js',
        './cordis.patch.yml': './cordis.patch.yml',
        './presets/*.patch.yml': './presets/*.patch.yml',
        './package.json': './package.json',
      },
      dsh: { manifestVersion: 1, bundle: { patch: ['cordis.patch.yml', 'presets/standard.patch.yml'] } },
    },
    BUNDLE_FILES,
  )
  const codes = codesOf(dir)
  assert.ok(!codes.includes('DSH-C042'), `合法写法不应报 C042，实际 [${codes.join(', ')}]`)
  assert.deepEqual(codes, [], '该包应当是零发现')
})

test('bundle.patch 使用反斜杠分隔符时同样按 exports 子路径比对', () => {
  const dir = makePackage(
    {
      ...BUNDLE_OK,
      exports: {
        '.': './lib/index.js',
        './presets/standard.patch.yml': './presets/standard.patch.yml',
        './package.json': './package.json',
      },
      dsh: { manifestVersion: 1, bundle: { patch: 'presets\\standard.patch.yml' } },
    },
    ['presets/standard.patch.yml'],
  )
  const codes = codesOf(dir)
  assert.ok(!codes.includes('DSH-C042'), `反斜杠写法不应报 C042，实际 [${codes.join(', ')}]`)
})

test('归一化不放过真实缺口：patch 确实未被 exports 覆盖时仍报 DSH-C042', () => {
  // 防止上一条修复把 C042 整体削弱成永不触发。
  const dir = makePackage(
    {
      ...BUNDLE_OK,
      exports: { '.': './lib/index.js', './package.json': './package.json' },
      dsh: { manifestVersion: 1, bundle: { patch: 'cordis.patch.yml' } },
    },
    ['cordis.patch.yml'],
  )
  expectCode(dir, 'DSH-C042')
})

test("客户端半边缺 exports['./client'] → DSH-C043", () => {
  const dir = makePackage({
    ...CLIENT_OK,
    exports: { '.': './lib/index.js', './package.json': './package.json' },
  }, ['client/client.js'])
  expectCode(dir, 'DSH-C043')
})

test("exports 暴露已移除的 './invariant' → DSH-C044", () => {
  const dir = makePackage({
    ...HOST_ONLY,
    exports: {
      '.': './lib/index.js',
      './invariant': './lib/invariant.js',
      './package.json': './package.json',
    },
  })
  expectCode(dir, 'DSH-C044')
})

/** 一个导出 `./invariant` 的插件，用于分级断言。 */
function invariantPackage() {
  return makePackage({
    ...HOST_ONLY,
    exports: {
      '.': './lib/index.js',
      './invariant': './lib/invariant.js',
      './package.json': './package.json',
    },
  })
}

test('C044 阈值分级：未提供宿主版本 → 保守按 error', () => {
  const finding = checkManifest(invariantPackage()).find((f) => f.code === 'DSH-C044')
  assert.ok(finding, '期望 DSH-C044')
  assert.equal(finding.severity, 'error')
})

test('C044 阈值分级：宿主早于移除版本 → warn（尚可用但迁移后失效）', () => {
  const finding = checkManifest(invariantPackage(), { dshRuntimeVersion: '0.2.0-rc.2' }).find(
    (f) => f.code === 'DSH-C044',
  )
  assert.ok(finding, '期望 DSH-C044')
  assert.equal(finding.severity, 'warn')
  assert.match(finding.message, /0\.2\.0-rc\.2 早于此版本/)
})

test('C044 阈值分级：宿主达移除版本 → error', () => {
  const finding = checkManifest(invariantPackage(), { dshRuntimeVersion: '0.2.1-alpha.2' }).find(
    (f) => f.code === 'DSH-C044',
  )
  assert.ok(finding, '期望 DSH-C044')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /0\.2\.1-alpha\.2 已不含此子路径/)
})

test('C044 数据驱动：空表不再报（证明移除清单非硬编码）', () => {
  const codes = checkManifest(invariantPackage(), { removedApis: [] }).map((f) => f.code)
  assert.ok(!codes.includes('DSH-C044'), `空表不应触发 C044，实际 [${codes.join(', ')}]`)
})

test('C044 数据驱动：新增一条移除项即可扩展，无需改代码', () => {
  const dir = makePackage({
    ...HOST_ONLY,
    exports: {
      '.': './lib/index.js',
      './legacy-api': './lib/legacy.js',
      './package.json': './package.json',
    },
  })
  const injected = [
    {
      id: 'legacy-api',
      kind: 'subpath',
      match: 'exact',
      pattern: './legacy-api',
      removedIn: '0.3.0',
      rule: 'DSH-C044',
      note: '假设未来 0.3.0 移除 legacy-api',
    },
  ]
  const finding = checkManifest(dir, { removedApis: injected }).find((f) => f.code === 'DSH-C044')
  assert.ok(finding, '注入的移除项应触发 DSH-C044')
  assert.equal(finding.severity, 'error')
})

// --- semver syntax -------------------------------------------------------

test('SemVer 范围语法判定', () => {
  // 部分版本（X-range）按 npm 语义合法，不得比 npm 更严而误报。
  // 带首尾空格的 range 由官方 semver 自动 trim 后接受，与运行时行为一致。
  for (const valid of ['0.2.0-rc.2', '>=0.2.1-alpha.2 <0.3.0', '~4.0.4', '^1.2.3', '1.x', '1.2', '0.2', '*', '1.2.3 || >=2.0.0', ' 1.2.3', '>=0.2.0 ']) {
    assert.equal(isValidSemverRange(valid), true, `应接受 ${JSON.stringify(valid)}`)
  }
  // 空字符串在 semver.validRange 里会退化为 '*'，但 engines.dsh 空值应视为"漏填"而非"匹配一切"。
  for (const invalid of ['abc', '>=', '1.2.3.4', '']) {
    assert.equal(isValidSemverRange(invalid), false, `应拒绝 ${JSON.stringify(invalid)}`)
  }
})

// --- completeness --------------------------------------------------------

test('T10 覆盖了 rules.mjs 中声明的全部 T10 规则码', () => {
  const missing = MANIFEST_RULE_CODES.filter((code) => !exercised.has(code))
  assert.deepEqual(missing, [], `以下规则码未被任何用例触发：${missing.join(', ')}`)
})
