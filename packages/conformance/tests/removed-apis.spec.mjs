/**
 * Versioned API-removal table: load / validate / match / threshold /
 * cross-validation.
 *
 * These cases pin the "add a data row, not a code change" contract: the table
 * is declarative, validation fails loudly on a malformed table, and the
 * cross-check keeps the table honest against a real baseline snapshot.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  crossValidate,
  inferBaselineVersion,
  loadRemovedApis,
  matchRemovedSubpath,
  removedSeverity,
  validateRemovedApis,
} from '../src/removed-apis.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const COMMITTED_BASELINE = join(here, '..', 'api-baseline.json')

const tempDirs = []
function tempTable(removed) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-removed-'))
  tempDirs.push(dir)
  const file = join(dir, 'removed-apis.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, removed }))
  return file
}
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A `subpath` removal entry; overrides merge over sensible defaults. */
function subpathRemoval(overrides = {}) {
  return {
    id: 'test-removal',
    kind: 'subpath',
    match: 'suffix',
    pattern: '/invariant',
    removedIn: '0.2.1-alpha.2',
    rule: 'DSH-C044',
    note: '测试移除',
    ...overrides,
  }
}

// --- load & validate ------------------------------------------------------

test('loadRemovedApis 加载提交的默认表（含 invariant-subpath）', () => {
  const table = loadRemovedApis()
  assert.equal(table.schemaVersion, 1)
  const item = table.removed.find((r) => r.id === 'invariant-subpath')
  assert.ok(item, '默认表应含 invariant-subpath')
  assert.equal(item.kind, 'subpath')
  assert.equal(item.removedIn, '0.2.1-alpha.2')
  assert.equal(item.rule, 'DSH-C044')
})

test('validateRemovedApis 拒绝未知 schemaVersion', () => {
  assert.throws(() => validateRemovedApis({ schemaVersion: 2, removed: [] }), /schemaVersion/)
})

test('validateRemovedApis 拒绝非法 removedIn', () => {
  assert.throws(
    () => validateRemovedApis({ schemaVersion: 1, removed: [subpathRemoval({ removedIn: 'not-a-version' })] }),
    /removedIn/,
  )
})

test('validateRemovedApis 拒绝未实现的 kind', () => {
  assert.throws(
    () => validateRemovedApis({ schemaVersion: 1, removed: [subpathRemoval({ kind: 'symbol' })] }),
    /kind/,
  )
})

test('validateRemovedApis 拒绝未知 match 模式', () => {
  assert.throws(
    () => validateRemovedApis({ schemaVersion: 1, removed: [subpathRemoval({ match: 'glob' })] }),
    /match/,
  )
})

test('loadRemovedApis 对损坏文件 fail loud（而非静默降级）', () => {
  assert.throws(() => loadRemovedApis(join(tmpdir(), 'no-such-removed-apis.json')), /无法读取/)
})

// --- match ----------------------------------------------------------------

test('matchRemovedSubpath 按 suffix 匹配 ./invariant 与深层 /invariant', () => {
  const table = { removed: [subpathRemoval()] }
  assert.equal(matchRemovedSubpath('./invariant', table)?.id, 'test-removal')
  assert.equal(matchRemovedSubpath('./sub/invariant', table)?.id, 'test-removal')
})

test('matchRemovedSubpath 不误报 ./invariant2 与无关子路径', () => {
  const table = { removed: [subpathRemoval()] }
  assert.equal(matchRemovedSubpath('./invariant2', table), null)
  assert.equal(matchRemovedSubpath('./legacy', table), null)
  assert.equal(matchRemovedSubpath('invariant', table), null) // 无前导斜杠，suffix 不应命中裸词
})

// --- threshold ------------------------------------------------------------

test('removedSeverity：未知 runtime 保守按 error', () => {
  assert.equal(removedSeverity(subpathRemoval(), undefined), 'error')
  assert.equal(removedSeverity(subpathRemoval(), 'not-a-version'), 'error')
})

test('removedSeverity：runtime 早于 removedIn → warn', () => {
  assert.equal(removedSeverity(subpathRemoval(), '0.2.0-rc.2'), 'warn')
  assert.equal(removedSeverity(subpathRemoval(), '0.2.1-alpha.0'), 'warn')
})

test('removedSeverity：runtime 达/过 removedIn → error', () => {
  assert.equal(removedSeverity(subpathRemoval(), '0.2.1-alpha.2'), 'error')
  assert.equal(removedSeverity(subpathRemoval(), '0.2.1'), 'error')
  assert.equal(removedSeverity(subpathRemoval(), '0.3.0'), 'error')
})

// --- cross-validation -----------------------------------------------------

/** Baseline snapshot factory; `withInvariant` toggles a host package exporting `./invariant`. */
function baseline(version, withInvariant) {
  return {
    packages: {
      '@deepseek-ai/dsh-app-boot': { version, subpaths: ['.', './package.json'] },
      '@deepseek-ai/dsh-base': {
        version,
        subpaths: withInvariant ? ['.', './invariant'] : ['.'],
      },
    },
  }
}

test('inferBaselineVersion 从 dsh-app-boot 推断宿主版本', () => {
  assert.equal(inferBaselineVersion(baseline('0.2.0-rc.2', true)), '0.2.0-rc.2')
  assert.equal(inferBaselineVersion({ packages: {} }), undefined)
})

test('crossValidate：移除前基线仍导出 → 一致（无缺陷）', () => {
  const table = { removed: [subpathRemoval()] }
  assert.deepEqual(crossValidate(table, baseline('0.2.0-rc.2', true), '0.2.0-rc.2'), [])
})

test('crossValidate：移除后基线已不含 → 一致（无缺陷）', () => {
  const table = { removed: [subpathRemoval()] }
  assert.deepEqual(crossValidate(table, baseline('0.2.1', false), '0.2.1'), [])
})

test('crossValidate：移除后基线仍导出 → 报 still-present（表缺陷）', () => {
  const table = { removed: [subpathRemoval()] }
  const defects = crossValidate(table, baseline('0.2.1', true), '0.2.1')
  assert.equal(defects.length, 1)
  assert.equal(defects[0].id, 'test-removal')
  assert.equal(defects[0].problem, 'still-present')
  assert.deepEqual(defects[0].matchingPackages, ['@deepseek-ai/dsh-base'])
})

test('crossValidate：移除前基线已不含 → 报 missing-before-removal（表缺陷）', () => {
  const table = { removed: [subpathRemoval()] }
  const defects = crossValidate(table, baseline('0.2.0-rc.2', false), '0.2.0-rc.2')
  assert.equal(defects.length, 1)
  assert.equal(defects[0].problem, 'missing-before-removal')
})

test('crossValidate：无基线版本时跳过（不误报）', () => {
  const table = { removed: [subpathRemoval()] }
  assert.deepEqual(crossValidate(table, { packages: {} }), [])
})

// --- committed table vs committed baseline --------------------------------

test('提交的数据表与提交的 api-baseline.json 交叉一致（表正确性回归）', () => {
  const table = loadRemovedApis()
  const baseline = JSON.parse(readFileSync(COMMITTED_BASELINE, 'utf8'))
  const defects = crossValidate(table, baseline)
  assert.deepEqual(defects, [], `数据表与 baseline 不一致：${JSON.stringify(defects, null, 2)}`)
})
