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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expandPattern, loadConfig, runAll, summarize } from '../src/run-all.mjs'

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
  assert.equal(byCode.get('DSH-C030')?.count, 1)
  // warn 不使 ok 变 false —— 门禁的 error/warn 分级由此生效
  assert.equal(outcome.ok, true)
})
