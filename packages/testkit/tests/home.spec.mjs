/**
 * T03 acceptance tests.
 *
 * The decisive case is the last one: a home containing nothing but
 * `profiles/test/package.json` must actually boot the real launcher. That is
 * what proves the "no node_modules needed" claim and the isolation guarantee —
 * asserting on a directory listing alone would not.
 *
 * Run: node --test "tests/**\/*.spec.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { DEFAULT_TEST_BUNDLES, createTestHome, testHomeArgs, testHomeEnv, withKeyEnv } from '../src/home.mjs'

/** The packaged launcher; override with `DSH_BIN` on another install. */
const DSH_BIN =
  process.env.DSH_BIN ??
  join('D:\\Program Files\\DSH NEXT\\resources\\app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

test('默认 bundles 派生自 stock headless profile', () => {
  assert.deepEqual([...DEFAULT_TEST_BUNDLES], ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  const home = createTestHome()
  try {
    const manifest = JSON.parse(readFileSync(join(home.profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [...DEFAULT_TEST_BUNDLES])
    assert.deepEqual(manifest.dependencies, {}, 'base bundles 由安装解析，不应写进 dependencies')
  } finally {
    home.cleanup()
  }
})

test('隔离保证：不生成 compatibility.json / home patch / node_modules', () => {
  const home = createTestHome({
    // 即便调用方给了 profile patch，也不应引入 home 级 patch 或豁免
    profilePatch: '- insert:\n    - id: x\n      name: "pkg-x"\n',
  })
  try {
    assert.ok(!existsSync(join(home.profileDir, 'compatibility.json')), '测试 home 绝不能自带豁免')
    assert.ok(!existsSync(join(home.homeDir, 'cordis.patch.yml')), '不应有 home 级 patch')
    assert.ok(!existsSync(join(home.homeDir, 'profiles', 'node_modules')), '不应需要 node_modules')
    assert.deepEqual(readdirSync(home.homeDir), ['profiles'])
  } finally {
    home.cleanup()
  }
})

test('可自定义 bundles、profile 名与额外文件', () => {
  const home = createTestHome({
    bundles: ['@deepseek-ai/dsh-base'],
    profileName: 'probe',
    extraFiles: { 'nested/thing.json': '{"a":1}' },
  })
  try {
    assert.equal(home.profileName, 'probe')
    const manifest = JSON.parse(readFileSync(join(home.profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
    assert.equal(readFileSync(join(home.profileDir, 'nested', 'thing.json'), 'utf8'), '{"a":1}')
  } finally {
    home.cleanup()
  }
})

test('testHomeEnv 不读 process.env，只覆盖 DSH_HOME', () => {
  const env = testHomeEnv('/tmp/home', { PATH: '/usr/bin', DSH_HOME: '/old' })
  assert.equal(env.DSH_HOME, '/tmp/home', '应覆盖旧的 DSH_HOME')
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.DSH_PROFILE, undefined)
})

test('withKeyEnv 显式注入密钥，绝不沿用宿主凭据', () => {
  const env = withKeyEnv('/tmp/home', 'sk-test', { PATH: '/usr/bin' })
  assert.equal(env.DSH_HOME, '/tmp/home')
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-test')
  // 未显式给出时不得凭空产生密钥 —— 隔离 home 不该继承开发者的真实凭据
  assert.equal(testHomeEnv('/tmp/home').DEEPSEEK_API_KEY, undefined)
})

test('testHomeArgs 顺序：--profile → --patch… → --json → 任务', () => {
  const home = { homeDir: '/h', profileDir: '/h/p/test', profileName: 'test', cleanup: () => {} }
  assert.deepEqual(testHomeArgs(home, { task: 'hi' }), ['--profile', 'test', '--json', 'hi'])
  assert.deepEqual(testHomeArgs(home, { patches: ['/a.yml', '/b.yml'], task: 'go' }), [
    '--profile',
    'test',
    '--patch',
    '/a.yml',
    '--patch',
    '/b.yml',
    '--json',
    'go',
  ])
})

test('cleanup 删除整个 home', () => {
  const home = createTestHome()
  assert.ok(existsSync(home.homeDir))
  home.cleanup()
  assert.ok(!existsSync(home.homeDir))
})

test(
  '真实启动：裸 home 能 boot 并 dump 出组合（T03 的决定性用例）',
  { timeout: 120_000, skip: existsSync(DSH_BIN) ? false : `未找到 DSH launcher（DSH_BIN=${DSH_BIN}）` },
  () => {
    const home = createTestHome()
    try {
      const result = spawnSync(process.execPath, [DSH_BIN, '--profile', home.profileName, '--dump-config'], {
        env: testHomeEnv(home.homeDir, process.env),
        encoding: 'utf8',
        timeout: 90_000,
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      assert.equal(result.status, 0, `launcher 应成功退出，实际 ${result.status}\n${output.slice(0, 2000)}`)
      assert.match(output, /@deepseek-ai\/dsh-base/, 'dump 应包含 dsh-base 的条目')
      assert.match(output, /@deepseek-ai\/dsh-headless/, 'dump 应包含 headless 层的 patch 痕迹')
    } finally {
      home.cleanup()
    }
  },
)

// ---------------------------------------------------------------------------
// Linking a package under test
// ---------------------------------------------------------------------------

test('links 按绝对路径把被测插件链进 profile 并写成 link: 依赖', () => {
  // 被测插件不在本包依赖里，只能给绝对路径 —— 这是把任意本地插件挂进
  // 隔离 home 的通道。
  const home = createTestHome({ links: { '@scope/under-test': '.' } })
  try {
    const manifest = JSON.parse(readFileSync(join(home.profileDir, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['@scope/under-test'], 'link:.')
    assert.ok(existsSync(join(home.profileDir, 'node_modules', '@scope', 'under-test')))
  } finally {
    home.cleanup()
  }
})

test('packages 从本包依赖解析，links 从任意目录解析，二者共存', () => {
  const home = createTestHome({
    packages: ['@deepseek-ai/dsh-llm-replay'],
    links: { '@scope/sample-like': '.' },
  })
  try {
    const manifest = JSON.parse(readFileSync(join(home.profileDir, 'package.json'), 'utf8'))
    assert.ok(manifest.dependencies['@deepseek-ai/dsh-llm-replay'].startsWith('link:'))
    assert.equal(manifest.dependencies['@scope/sample-like'], 'link:.')
  } finally {
    home.cleanup()
  }
})

test('extraFiles 相对 profileDir 写入 —— compatibility.json 才能放对位置', () => {
  // 豁免必须落在 profile 目录，落到 home 根会被忽略。
  const home = createTestHome({
    extraFiles: { 'compatibility.json': '{}\n' },
  })
  try {
    assert.ok(existsSync(join(home.profileDir, 'compatibility.json')))
    assert.ok(!existsSync(join(home.homeDir, 'compatibility.json')))
  } finally {
    home.cleanup()
  }
})
