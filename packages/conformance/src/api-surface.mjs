/**
 * T64 — platform API baseline snapshot and diff.
 *
 * Motivation is a failure that already happened: `@deepseek-ai/dsh-invariants`
 * and `ctx.invariants` were removed in the `0.2.1` line. Nothing in the gate
 * caught it. Peer ranges cannot: a plugin can satisfy every peer and still
 * import a symbol that no longer exists.
 *
 * So snapshot the **public surface** of every host `@deepseek-ai/*` package —
 * its export subpaths and its declared type symbols — and diff on upgrade.
 * Two removals are treated as breaking:
 *
 * - a **subpath** disappears (`./invariant` no longer exported), and
 * - a **symbol** disappears from a subpath that still exists.
 *
 * Additions are reported but never fail: they are how the platform evolves.
 *
 * @module dsh-plugin-conformance/api-surface
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DECL_RE =
  /export\s+declare\s+(?:abstract\s+)?(?:function|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g
const LIST_RE = /export\s*\{([^}]*)\}/g

/** @param {string} nodeModules */
export function listHostPackages(nodeModules) {
  const scope = join(nodeModules, '@deepseek-ai')
  if (!existsSync(scope)) return []
  return readdirSync(scope)
    .filter((name) => existsSync(join(scope, name, 'package.json')))
    .sort()
}

/**
 * Collect exported identifiers from a shipped ESM file.
 *
 * The packaged host ships **no `.d.ts` at all** (verified: 0 files under
 * `resources/app/node_modules/@deepseek-ai`), so the type surface is not
 * observable there. What is observable is the runtime surface: the build emits
 * one trailing `export { … }` per entry point, which is what consumers actually
 * import. Reading that is both sufficient and closer to the real contract.
 *
 * @param {string} file
 * @returns {string[]}
 */
function readExports(file) {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  /** @type {Set<string>} */
  const names = new Set()
  for (const match of text.matchAll(DECL_RE)) names.add(match[1])
  for (const match of text.matchAll(LIST_RE)) {
    for (const part of match[1].split(',')) {
      // Handle `a as b` by keeping the exported alias.
      const name = part.includes(' as ') ? part.split(' as ').pop() : part
      const trimmed = (name ?? '').trim().replace(/^type\s+/, '')
      if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) names.add(trimmed)
    }
  }
  return [...names].sort()
}

/**
 * Resolve the runtime entry point for one export subpath.
 *
 * A non-JS subpath (a YAML patch, a glob, `./package.json`) resolves to
 * `undefined` and contributes no symbols.
 *
 * @param {any} entry
 * @returns {string | undefined}
 */
function scriptTarget(entry) {
  if (typeof entry === 'string') return entry.endsWith('.js') ? entry : undefined
  if (entry === null || typeof entry !== 'object') return undefined
  for (const key of ['default', 'import', 'require']) {
    const nested = entry[key]
    if (typeof nested === 'string') {
      if (nested.endsWith('.js')) return nested
      continue
    }
    const found = scriptTarget(nested)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Read one package's public surface.
 *
 * @param {string} nodeModules
 * @param {string} dirName directory name inside the `@deepseek-ai` scope
 */
export function readPackageSurface(nodeModules, dirName) {
  const dir = join(nodeModules, '@deepseek-ai', dirName)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const exportsMap = pkg.exports ?? { '.': pkg.main }
  const subpaths = Object.keys(exportsMap).sort()
  /** @type {Record<string, string[]>} */
  const symbols = {}
  for (const subpath of subpaths) {
    const target = scriptTarget(exportsMap[subpath])
    if (target === undefined) continue
    const found = readExports(join(dir, target))
    if (found.length > 0) symbols[subpath] = found
  }
  return { version: pkg.version ?? null, subpaths, symbols }
}

/**
 * Snapshot the whole host surface.
 *
 * Keyed by **scoped package name** (`@deepseek-ai/dsh-llm`), which is what a
 * plugin author writes in an import — a bare directory name would not be
 * greppable against real source.
 *
 * @param {string} nodeModules
 * @returns {{ packages: Record<string, ReturnType<typeof readPackageSurface>> }}
 */
export function collectApiSurface(nodeModules) {
  /** @type {Record<string, any>} */
  const packages = {}
  for (const dirName of listHostPackages(nodeModules)) {
    packages[`@deepseek-ai/${dirName}`] = readPackageSurface(nodeModules, dirName)
  }
  return { packages }
}

/**
 * Diff a snapshot against a baseline. Removals are breaking.
 *
 * @param {{ packages: Record<string, any> }} baseline
 * @param {{ packages: Record<string, any> }} current
 */
export function diffApiSurface(baseline, current) {
  const entries = []
  const names = [...new Set([...Object.keys(baseline.packages), ...Object.keys(current.packages)])].sort()
  for (const name of names) {
    const before = baseline.packages[name]
    const after = current.packages[name]
    if (before === undefined) {
      entries.push({ name, kind: 'addedPackage', removedSubpaths: [], removedSymbols: [], addedSymbols: [] })
      continue
    }
    if (after === undefined) {
      entries.push({
        name,
        kind: 'removedPackage',
        versionChanged: `${before.version} -> (absent)`,
        removedSubpaths: before.subpaths,
        removedSymbols: Object.keys(before.symbols ?? {}),
        addedSymbols: [],
      })
      continue
    }
    const removedSubpaths = before.subpaths.filter((s) => !after.subpaths.includes(s))
    const addedSubpaths = after.subpaths.filter((s) => !before.subpaths.includes(s))
    /** @type {string[]} */
    const removedSymbols = []
    /** @type {string[]} */
    const addedSymbols = []
    for (const subpath of Object.keys(after.symbols ?? {})) {
      const was = before.symbols?.[subpath]
      if (was === undefined) continue
      const now = after.symbols[subpath] ?? []
      for (const symbol of was) if (!now.includes(symbol)) removedSymbols.push(`${subpath}#${symbol}`)
      for (const symbol of now) if (!was.includes(symbol)) addedSymbols.push(`${subpath}#${symbol}`)
    }
    if (
      removedSubpaths.length === 0 &&
      removedSymbols.length === 0 &&
      addedSubpaths.length === 0 &&
      addedSymbols.length === 0 &&
      before.version === after.version
    ) {
      continue
    }
    entries.push({
      name,
      kind: 'changed',
      versionChanged: before.version === after.version ? null : `${before.version} -> ${after.version}`,
      removedSubpaths,
      removedSymbols,
      addedSubpaths,
      addedSymbols,
    })
  }
  const breaking = entries.some(
    (e) => e.kind === 'removedPackage' || e.removedSubpaths.length > 0 || e.removedSymbols.length > 0,
  )
  return { breaking, entries }
}
