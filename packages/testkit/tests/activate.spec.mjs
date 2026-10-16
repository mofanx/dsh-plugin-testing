/**
 * T16 tests — the runtime activation probe.
 *
 * Two layers, deliberately separated:
 *
 * - **pure** cases exercise the parsing and discovery logic with no child
 *   process, so they always run and fail fast on a logic regression;
 * - **integration** cases boot the real launcher, and are skipped with a reason
 *   when this environment has no DSH installation.
 *
 * The integration pair is a controlled experiment: `fixtures/sample-plugin` and
 * `fixtures/incompatible-plugin` differ **only** in one peer range, so a verdict
 * difference between them can only come from the compatibility preflight. That
 * is what makes "the probe detects a denial" a claim rather than an assumption.
 *
 * @module dsh-plugin-testkit/tests/activate
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_LAUNCHER,
  discoverPackages,
  expandPackagePattern,
  inspectEntry,
  parseStartupDiagnostics,
  probeActivation,
  resolveLauncher,
  rowId,
} from '../src/activate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'fixtures')
const SAMPLE = join(fixtures, 'sample-plugin')
const INCOMPATIBLE = join(fixtures, 'incompatible-plugin')

/** The packaged launcher; override with `DSH_BIN` on another install. */
const DSH_BIN = resolveLauncher()
const noLauncher = existsSync(DSH_BIN) ? false : `未找到 DSH launcher（DSH_BIN=${DSH_BIN}）`

//#region pure

test('expandPackagePattern：尾随 /* 展开为含 package.json 的子目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pattern-'))
  try {
    mkdirSync(join(root, 'has-manifest'))
    writeFileSync(join(root, 'has-manifest', 'package.json'), '{"name":"a"}')
    mkdirSync(join(root, 'no-manifest'))
    writeFileSync(join(root, 'a-file.txt'), 'x')

    const expanded = expandPackagePattern(join(root, '*')).map((entry) => entry.replace(/\\/g, '/'))
    assert.deepEqual(expanded, [join(root, 'has-manifest').replace(/\\/g, '/')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('expandPackagePattern：非 /* 结尾按字面路径处理；父目录不存在返回空', () => {
  assert.deepEqual(expandPackagePattern('D:/somewhere/plugin'), ['D:/somewhere/plugin'])
  assert.deepEqual(expandPackagePattern('D:/definitely/not/here/*'), [])
})

test('discoverPackages：包名取自 manifest、去重、排序，并报告未匹配的模式', () => {
  const { packages, unmatched } = discoverPackages([join(fixtures, '*'), 'D:/nope/*'])
  const names = packages.map((entry) => entry.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), '应按包名排序')
  assert.ok(names.includes('@sample/dsh-plugin-minimal'), '应发现正例夹具')
  assert.ok(names.includes('@sample/dsh-plugin-incompatible'), '应发现反面夹具')
  assert.equal(new Set(names).size, names.length, '不应重复')
  // 目录名与包名不同，这是"必须读 manifest 而不是目录名"的回归点
  assert.ok(!names.includes('sample-plugin'), '不应把目录名当成包名')
  assert.deepEqual(unmatched, ['D:/nope/*'])
})

test('discoverPackages：hasEntry 反映可导入入口，与 dsh.manifestVersion 无关', () => {
  const { packages } = discoverPackages([SAMPLE])
  assert.equal(packages.length, 1)
  assert.equal(packages[0].name, '@sample/dsh-plugin-minimal')
  // 夹具没有 dsh.manifestVersion，却是可挂载的真实插件 —— 所以入口判据不能依赖它
  assert.equal(packages[0].hasEntry, true)
  assert.equal(packages[0].entryExists, true, '夹具的入口文件确实存在')
})

test('inspectEntry：解析 exports["."] 的各种形态，并区分"声明了但没构建"', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-entry-'))
  const make = (manifest, files = []) => {
    const dir = mkdtempSync(join(root, 'pkg-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    for (const file of files) {
      mkdirSync(join(dir, dirname(file)), { recursive: true })
      writeFileSync(join(dir, file), 'export function apply() {}')
    }
    return dir
  }
  try {
    // 字符串 exports
    const stringExports = make({ name: 'a', exports: { '.': './lib/index.js' } }, ['lib/index.js'])
    assert.deepEqual(inspectEntry(stringExports), {
      declared: './lib/index.js',
      path: join(stringExports, 'lib', 'index.js'),
      exists: true,
    })

    // 条件 exports：取 import
    const conditional = make({ name: 'b', exports: { '.': { import: './dist/main.mjs', require: './cjs/main.cjs' } } }, [
      'dist/main.mjs',
    ])
    assert.equal(inspectEntry(conditional)?.declared, './dist/main.mjs')
    assert.equal(inspectEntry(conditional)?.exists, true)

    // main 回退
    const mainOnly = make({ name: 'c', main: 'lib/entry.js' }, ['lib/entry.js'])
    assert.equal(inspectEntry(mainOnly)?.declared, 'lib/entry.js')

    // 声明了但文件不在 —— 这正是"没构建"，探针要把它和"坏了"分开
    const unbuilt = make({ name: 'd', exports: { '.': './lib/index.js' } })
    assert.equal(inspectEntry(unbuilt)?.exists, false)

    // 完全没声明入口是合法形态（如纯 bundle 包），不是缺陷
    assert.equal(inspectEntry(make({ name: 'e' })), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rowId：由包名稳定派生出行 id', () => {
  assert.equal(rowId('@sample/dsh-plugin-minimal'), 'sample-dsh-plugin-minimal')
  assert.equal(rowId('plain'), 'plain')
})

test('parseStartupDiagnostics：解析真实禁用原因，并抽出包名', () => {
  const real =
    'dsh: disabling profile plugin row "optional-schematic": Plugin @deepseek-ai/dsh-plugin-eda-sch@0.1.0-alpha.1 ' +
    'is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-llm":">=0.2.1-alpha.2 <0.3.0"}. ' +
    'Running it may cause crashes or data loss.\n' +
    'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key\n'
  const parsed = parseStartupDiagnostics(real)
  assert.equal(parsed.denied.length, 1)
  assert.equal(parsed.denied[0].label, 'optional-schematic')
  // 行 id 是补丁作者起的，包名才是调用方认得的 —— 这是 expectActive 能对上的关键
  assert.equal(parsed.denied[0].packageName, '@deepseek-ai/dsh-plugin-eda-sch')
  assert.match(parsed.denied[0].reason, /incompatible with dsh 0\.2\.0-rc\.2/)
  assert.equal(parsed.didNotActivate, false)
})

test('parseStartupDiagnostics：无引号的行标签也能解析（回退分支）', () => {
  const parsed = parseStartupDiagnostics('dsh: disabling profile plugin probe: Plugin @probe/plugin@1.0.0 is incompatible with dsh 0.2.0-rc.2: x')
  assert.equal(parsed.denied[0].label, 'probe')
  assert.equal(parsed.denied[0].packageName, '@probe/plugin')
})

test('parseStartupDiagnostics：干净输出不产生误报', () => {
  const parsed = parseStartupDiagnostics('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key\n')
  assert.deepEqual(parsed.denied, [])
  assert.equal(parsed.didNotActivate, false)
  assert.equal(parsed.pending, false)
  assert.equal(parsed.loadFailure, false)
})

test('parseStartupDiagnostics：识别三类非兼容性启动故障', () => {
  assert.equal(parseStartupDiagnostics('dsh: warning: 2 plugins did not activate\n').didNotActivate, true)
  assert.equal(parseStartupDiagnostics('Plugins waiting for services (1):\n').pending, true)
  assert.equal(parseStartupDiagnostics('dsh: plugin tree failed to load\n').loadFailure, true)
})

test('parseStartupDiagnostics：did not activate 要能归因到具体哪一行（而只报数量）', () => {
  // 宿主的真实格式（inactiveDiagnostic）：`<rowId> (<packageName>): <detail>`
  const real =
    'dsh: warning: 2 plugins did not activate\n' +
    "pwsh-local (@deepseek-ai/dsh-pwsh-local): Cannot find module './build/x.node'\n" +
    'optional-schematic (@deepseek-ai/dsh-plugin-eda-sch): boom\n'
  const parsed = parseStartupDiagnostics(real)
  assert.equal(parsed.didNotActivate, true)
  assert.deepEqual(
    parsed.inactive.map((entry) => entry.packageName),
    ['@deepseek-ai/dsh-pwsh-local', '@deepseek-ai/dsh-plugin-eda-sch'],
  )
  assert.equal(parsed.inactive[0].rowId, 'pwsh-local')
  assert.match(parsed.inactive[0].detail, /Cannot find module/)
})

test('parseStartupDiagnostics：级联受害者以 pending detail 出现在未激活列表里，同样可归因', () => {
  // 实测形态（EDA 修复前的真实输出）：一个被禁用的行同时是某项服务的提供者，
  // 依赖它的行就永远等不到服务 —— 宿主把**受害者**也放进 did not activate 列表，
  // 但 detail 是 `pending (waiting for service: <svc>)` 而不是 import 失败。
  //
  // 这条抓的是"爆炸半径"：只看 `disabling` 会以为只有两个包有问题，而真正被拖垮的
  // 是三个。注意它与 `pending` 判据**不是**同一件事 —— `pending` 盯的是宿主单独打印的
  // `Plugins waiting for services (N):` 聚合行，那条行在实测中并未出现（pending=false）。
  const real =
    'dsh: warning: 1 plugin did not activate\n' +
    'optional-schematic-easyeda (@deepseek-ai/dsh-plugin-eda-easyeda): pending (waiting for service: schematic)\n'
  const parsed = parseStartupDiagnostics(real)
  assert.equal(parsed.didNotActivate, true)
  assert.equal(parsed.pending, false, '本形态下宿主没有打印聚合行，pending 应为 false')
  assert.equal(parsed.inactive.length, 1)
  assert.equal(parsed.inactive[0].rowId, 'optional-schematic-easyeda')
  assert.equal(parsed.inactive[0].packageName, '@deepseek-ai/dsh-plugin-eda-easyeda')
  assert.match(parsed.inactive[0].detail, /waiting for service: schematic/)
  assert.deepEqual(parsed.denied, [], '级联受害者不是"被禁用"，不能混进 denied')
})

test('parseStartupDiagnostics：聚合行之前的同形状文本不算未激活（区间守卫）', () => {
  const parsed = parseStartupDiagnostics('noise (@scope/pkg): 不是启动故障\ndsh: MISSING_CREDENTIAL\n')
  assert.deepEqual(parsed.inactive, [])
  assert.equal(parsed.didNotActivate, false)
})

test('resolveLauncher：DSH_BIN 优先，否则用打包默认路径', () => {
  assert.equal(resolveLauncher({ DSH_BIN: 'D:/custom/bin.js' }), 'D:/custom/bin.js')
  assert.equal(resolveLauncher({}), DEFAULT_LAUNCHER)
})

//#endregion

//#region integration

test(
  '真实启动：入口未构建时给出"未构建"归因，而不是只报 failed to import',
  { timeout: 180_000, skip: noLauncher },
  () => {
    // 这正是把探针接进真实插件仓库 CI 时踩到的坑：`lib/` 是构建产物、不在仓库里，
    // 于是每一行都 failed to import 并抛 ERR_MODULE_NOT_FOUND —— 那句话描述的是
    // 症状（找不到文件），而原因是"没人跑构建"。探针应当自己说出来。
    const dir = mkdtempSync(join(tmpdir(), 'dsh-unbuilt-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: '@probe/unbuilt',
          version: '1.0.0',
          type: 'module',
          main: 'lib/index.js',
          exports: { '.': './lib/index.js' },
        }),
      )
      const result = probeActivation({ links: { '@probe/unbuilt': dir }, rows: ['@probe/unbuilt'] })
      assert.deepEqual(result.unbuilt, ['@probe/unbuilt（./lib/index.js）'])
      assert.equal(result.ok, false)
      assert.match(result.problems.join('；'), /入口文件不存在/)
      // 与 peer 兼容性无关：没有任何行因兼容性被禁用
      assert.deepEqual(result.denied, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  '真实启动：兼容夹具的行不被禁用（T16 正例）',
  { timeout: 180_000, skip: noLauncher },
  () => {
    const result = probeActivation({ links: { '@sample/dsh-plugin-minimal': SAMPLE }, rows: ['@sample/dsh-plugin-minimal'] })
    assert.equal(result.spawned, true, `launcher 未能启动：${result.spawnError?.code} ${result.spawnError?.message}`)
    assert.deepEqual(result.denied, [], '兼容夹具不应被禁用')
    assert.equal(result.ok, true, `应通过，实际问题：${result.problems.join('；')}`)
    // 走到模型调用失败，正是"启动已越过预检"的证据
    assert.equal(result.terminal, 'MISSING_CREDENTIAL')
  },
)

test(
  '真实启动：不兼容夹具的行被禁用，且探针能检出（自证）',
  { timeout: 180_000, skip: noLauncher },
  () => {
    const result = probeActivation({
      links: { '@sample/dsh-plugin-incompatible': INCOMPATIBLE },
      rows: ['@sample/dsh-plugin-incompatible'],
    })
    assert.equal(result.spawned, true, `launcher 未能启动：${result.spawnError?.code}`)
    assert.equal(result.ok, false, '不兼容的行必须让探针失败')
    assert.equal(result.denied.length, 1, '应恰好检出 1 条禁用')
    assert.equal(result.denied[0].packageName, '@sample/dsh-plugin-incompatible')
    assert.equal(result.denied[0].label, rowId('@sample/dsh-plugin-incompatible'))
    assert.match(result.problems.join('\n'), /运行时禁用了行/)
  },
)

test(
  '真实启动：expectDisabled 命中的禁用不再判失败（证明探针不是"永远失败"）',
  { timeout: 180_000, skip: noLauncher },
  () => {
    const result = probeActivation({
      links: { '@sample/dsh-plugin-incompatible': INCOMPATIBLE },
      rows: ['@sample/dsh-plugin-incompatible'],
      expectDisabled: ['@sample/dsh-plugin-incompatible'],
    })
    assert.equal(result.ok, true, `预期内的禁用应放过，实际问题：${result.problems.join('；')}`)
    assert.equal(result.denied.length, 1, '禁用仍要如实报告，只是不判失败')
  },
)

test(
  '真实启动：expectActive 只对关注行判失败，非关注行的禁用仅报告',
  { timeout: 180_000, skip: noLauncher },
  () => {
    const result = probeActivation({
      links: {
        '@sample/dsh-plugin-minimal': SAMPLE,
        '@sample/dsh-plugin-incompatible': INCOMPATIBLE,
      },
      rows: ['@sample/dsh-plugin-minimal', '@sample/dsh-plugin-incompatible'],
      expectActive: ['@sample/dsh-plugin-minimal'],
    })
    assert.equal(result.ok, true, `非关注行的禁用不应判失败：${result.problems.join('；')}`)
    assert.equal(result.unrelatedDenials.length, 1, '非关注行的禁用必须被计数而不是丢弃')
    assert.equal(result.unrelatedDenials[0].packageName, '@sample/dsh-plugin-incompatible')
  },
)

//#endregion
