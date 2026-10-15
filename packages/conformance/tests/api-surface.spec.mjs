/**
 * T64 — platform API baseline and diff.
 *
 * The cases that matter are the removals: that is the failure class that
 * actually shipped (`@deepseek-ai/dsh-invariants` / `ctx.invariants` vanishing
 * in the `0.2.1` line) and that peer ranges cannot express.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { collectApiSurface, diffApiSurface, listHostPackages, readPackageSurface } from '../src/api-surface.mjs'

const REAL_HOST = 'D:\\Program Files\\DSH NEXT\\resources\\app\\node_modules'

/** Build a throwaway `@deepseek-ai` scope with two packages. */
function makeFixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-api-'))
  const scope = join(root, 'node_modules', '@deepseek-ai')
  const write = (relative, text) => {
    const file = join(scope, relative)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  const pkg = (name, version, exportsMap) =>
    JSON.stringify({ name, version, type: 'module', exports: exportsMap })

  write(
    'demo-a/package.json',
    pkg('@deepseek-ai/demo-a', '1.0.0', {
      '.': { default: './lib/index.js' },
      './extra': { default: './lib/extra.js' },
      './cordis.patch.yml': './cordis.patch.yml',
    }),
  )
  write('demo-a/lib/index.js', 'const alpha = 1;\nconst beta = 2;\nexport { alpha, beta };\n')
  write('demo-a/lib/extra.js', 'export { gamma };\n')
  write('demo-b/package.json', pkg('@deepseek-ai/demo-b', '1.0.0', { '.': './lib/index.js' }))
  write('demo-b/lib/index.js', 'export class Widget {}\n')
  return root
}

const fixtureRoot = makeFixtureTree()
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

test('collectApiSurface keys packages by their scoped name', () => {
  const surface = collectApiSurface(join(fixtureRoot, 'node_modules'))
  assert.deepEqual(Object.keys(surface.packages).sort(), ['@deepseek-ai/demo-a', '@deepseek-ai/demo-b'])
})

test('readPackageSurface lists subpaths and the symbols behind them', () => {
  const surface = readPackageSurface(join(fixtureRoot, 'node_modules'), 'demo-a')
  assert.equal(surface.version, '1.0.0')
  assert.deepEqual(surface.subpaths, ['.', './cordis.patch.yml', './extra'])
  assert.deepEqual(surface.symbols['.'], ['alpha', 'beta'])
  assert.deepEqual(surface.symbols['./extra'], ['gamma'])
  // A YAML subpath has no runtime entry point, so it contributes no symbols.
  assert.equal(surface.symbols['./cordis.patch.yml'], undefined)
})

test('listHostPackages ignores a missing scope directory', () => {
  assert.deepEqual(listHostPackages(join(fixtureRoot, 'does-not-exist')), [])
})

// ---------------------------------------------------------------------------
// Diff: removals are breaking
// ---------------------------------------------------------------------------

test('a disappearing subpath is breaking', () => {
  const before = collectApiSurface(join(fixtureRoot, 'node_modules'))
  const after = structuredClone(before)
  delete after.packages['@deepseek-ai/demo-a'].symbols['./extra']
  after.packages['@deepseek-ai/demo-a'].subpaths = ['.', './cordis.patch.yml']

  const diff = diffApiSurface(before, after)
  assert.equal(diff.breaking, true)
  const entry = diff.entries.find((e) => e.name === '@deepseek-ai/demo-a')
  assert.deepEqual(entry.removedSubpaths, ['./extra'])
})

test('a disappearing symbol behind a surviving subpath is breaking', () => {
  // This is the invariants failure mode: the subpath is still there, one
  // exported name is not.
  const before = collectApiSurface(join(fixtureRoot, 'node_modules'))
  const after = structuredClone(before)
  after.packages['@deepseek-ai/demo-a'].symbols['.'] = ['alpha']

  const diff = diffApiSurface(before, after)
  assert.equal(diff.breaking, true)
  const entry = diff.entries.find((e) => e.name === '@deepseek-ai/demo-a')
  assert.deepEqual(entry.removedSymbols, ['.#beta'])
})

test('a removed package is breaking', () => {
  const before = collectApiSurface(join(fixtureRoot, 'node_modules'))
  const after = structuredClone(before)
  delete after.packages['@deepseek-ai/demo-b']

  const diff = diffApiSurface(before, after)
  assert.equal(diff.breaking, true)
  const entry = diff.entries.find((e) => e.name === '@deepseek-ai/demo-b')
  assert.equal(entry.kind, 'removedPackage')
})

// ---------------------------------------------------------------------------
// Diff: additions and version churn are not
// ---------------------------------------------------------------------------

test('additions are reported but never break the build', () => {
  const before = collectApiSurface(join(fixtureRoot, 'node_modules'))
  const after = structuredClone(before)
  after.packages['@deepseek-ai/demo-a'].symbols['.'].push('delta')
  after.packages['@deepseek-ai/demo-a'].subpaths.push('./brand')

  const diff = diffApiSurface(before, after)
  assert.equal(diff.breaking, false)
  const entry = diff.entries.find((e) => e.name === '@deepseek-ai/demo-a')
  assert.deepEqual(entry.addedSymbols, ['.#delta'])
  assert.deepEqual(entry.addedSubpaths, ['./brand'])
})

test('a version bump alone is non-breaking', () => {
  const before = collectApiSurface(join(fixtureRoot, 'node_modules'))
  const after = structuredClone(before)
  after.packages['@deepseek-ai/demo-a'].version = '2.0.0'

  const diff = diffApiSurface(before, after)
  assert.equal(diff.breaking, false)
  assert.equal(diff.entries[0].versionChanged, '1.0.0 -> 2.0.0')
})

test('an unchanged surface produces no entries', () => {
  const surface = collectApiSurface(join(fixtureRoot, 'node_modules'))
  const diff = diffApiSurface(surface, structuredClone(surface))
  assert.equal(diff.breaking, false)
  assert.deepEqual(diff.entries, [])
})

// ---------------------------------------------------------------------------
// Real host
// ---------------------------------------------------------------------------

test('the real host yields a populated symbol surface', { skip: !existsSync(REAL_HOST) }, () => {
  const surface = collectApiSurface(REAL_HOST)
  const names = Object.keys(surface.packages)
  assert.ok(names.length > 100, `expected many packages, saw ${names.length}`)

  const llm = surface.packages['@deepseek-ai/dsh-llm']
  assert.ok(llm, 'dsh-llm must be present')
  assert.ok(llm.subpaths.includes('.'))
  const symbols = Object.values(llm.symbols).reduce((n, list) => n + list.length, 0)
  assert.ok(symbols > 10, `expected a real symbol surface, saw ${symbols}`)
})
