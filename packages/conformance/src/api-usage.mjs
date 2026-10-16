/**
 * T18 — what host APIs does a plugin actually use, and does a given host have them?
 *
 * Motivation is the gap the peer contract cannot see. A plugin can satisfy every
 * peer range and still import a subpath or symbol that no longer exists — the
 * `./invariant` removal in the `0.2.1` line is the standing example. Peer ranges
 * describe the **declaration**; only the plugin's own imports describe the
 * **need**.
 *
 * This pass walks the plugin's **shipped entry points** (not its whole tree, so
 * dev-only files cannot produce phantom requirements) and collects every import
 * of an `@deepseek-ai/*` package. It then checks those against recorded host
 * surfaces.
 *
 * Deliberate honesty boundary: only **named** imports can be verified against the
 * recorded surface. A namespace import, a default import, a dynamic
 * `await import()`, and a CJS `require()` all reference the package without
 * naming a symbol in a way the surface can be compared against. Those are
 * reported as **未能核验**, never silently counted as satisfied — a check that
 * cannot see something must say so rather than pass it.
 *
 * @module dsh-plugin-conformance/api-usage
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import semver from 'semver'

/** Cap on files walked from the entry points; a runaway graph must not hang the check. */
const MAX_FILES = 4000

/** How deep relative imports are followed. */
const MAX_DEPTH = 16

/**
 * Extract the JS files a package actually ships, starting from its declared
 * entry points and following **relative** imports only.
 *
 * Following only relative specifiers is what keeps this to shipped code: a
 * `import './internal/x.js'` is part of the package, while `@scope/other` is a
 * dependency boundary (and one this pass deliberately does not cross).
 *
 * @param {string} packageDir
 * @returns {{ files: string[], truncated: boolean }}
 */
export function collectShippedFiles(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`读取不到 package.json：${manifestPath}`)
  /** @type {any} */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  /** @type {string[]} */
  const roots = []
  if (typeof manifest.main === 'string') roots.push(manifest.main)
  if (typeof manifest.module === 'string') roots.push(manifest.module)
  const collectExports = (value) => {
    if (typeof value === 'string') {
      if (/\.[cm]?js$/.test(value)) roots.push(value)
      return
    }
    if (value !== null && typeof value === 'object') for (const v of Object.values(value)) collectExports(v)
  }
  collectExports(manifest.exports)

  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {string[]} */
  const files = []
  let truncated = false

  const visit = (file, depth) => {
    if (files.length >= MAX_FILES) {
      truncated = true
      return
    }
    if (depth > MAX_DEPTH || seen.has(file) || !existsSync(file)) return
    const stats = statSync(file)
    if (!stats.isFile()) return
    seen.add(file)
    files.push(file)
    const source = readFileSync(file, 'utf8')
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier)
      if (target !== undefined) visit(target, depth + 1)
    }
  }

  for (const root of roots) visit(resolve(packageDir, root), 0)
  return { files, truncated }
}

/**
 * Relative import specifiers in a source file, extension-resolution deferred.
 *
 * @param {string} source
 * @returns {string[]}
 */
function relativeSpecifiers(source) {
  /** @type {string[]} */
  const found = []
  const pattern = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]*)['"]/g
  for (const match of source.matchAll(pattern)) found.push(match[1])
  return found
}

/**
 * Resolve a relative specifier to a real file, trying the extensions Node would.
 *
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js'), join(base, 'index.mjs')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/**
 * Split an `@deepseek-ai/*` specifier into its package name and export subpath.
 *
 * `@deepseek-ai/dsh-llm` -> `{ package: '@deepseek-ai/dsh-llm', subpath: '.' }`
 * `@deepseek-ai/dsh-llm/sub/x` -> `{ package: '@deepseek-ai/dsh-llm', subpath: './sub/x' }`
 *
 * @param {string} specifier
 * @returns {{ package: string, subpath: string } | undefined}
 */
export function splitHostSpecifier(specifier) {
  if (!specifier.startsWith('@deepseek-ai/')) return undefined
  const parts = specifier.split('/')
  if (parts.length < 2) return undefined
  const name = `${parts[0]}/${parts[1]}`
  if (parts.length === 2) return { package: name, subpath: '.' }
  return { package: name, subpath: `./${parts.slice(2).join('/')}` }
}

/**
 * Collect host APIs used by a plugin, from its shipped files.
 *
 * @param {string} packageDir
 * @returns {{
 *   files: string[], truncated: boolean,
 *   used: { package: string, subpath: string, symbols: string[] }[],
 *   unverifiable: { package: string, subpath: string, reason: string }[]
 * }}
 */
export function scanUsedApis(packageDir) {
  const { files, truncated } = collectShippedFiles(packageDir)
  /** @type {Map<string, { package: string, subpath: string, symbols: Set<string> }>} */
  const named = new Map()
  /** @type {Map<string, { package: string, subpath: string, reason: string }>} */
  const unverifiable = new Map()

  const key = (pkg, subpath) => `${pkg}\u0000${subpath}`

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // Named imports/re-exports: `import { a, b as c } from 'x'`,
    // `export { a } from 'x'`.
    const namedPattern = /(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
    for (const match of source.matchAll(namedPattern)) {
      const target = splitHostSpecifier(match[2])
      if (target === undefined) continue
      const symbols = match[1]
        .split(',')
        .map((piece) => piece.trim())
        .filter((piece) => piece !== '' && !piece.startsWith('type '))
        .map((piece) => {
          // `b as c` imports the exported name `b`; the local alias is irrelevant.
          const [original] = piece.split(/\s+as\s+/)
          return original.trim().replace(/^type\s+/, '')
        })
        .filter((symbol) => symbol !== '')
      const entry = named.get(key(target.package, target.subpath)) ?? {
        package: target.package,
        subpath: target.subpath,
        symbols: new Set(),
      }
      for (const symbol of symbols) entry.symbols.add(symbol)
      named.set(key(target.package, target.subpath), entry)
    }

    // Everything else references the package without a comparable symbol.
    const opaque = [
      { pattern: /import\s+\*\s+as\s+\w+\s+from\s*['"]([^'"]+)['"]/g, reason: '命名空间导入（import * as）' },
      { pattern: /import\s+[\w$]+\s*,\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g, reason: '默认导入与具名混用' },
      { pattern: /import\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g, reason: '默认导入' },
      { pattern: /import\s*['"]([^'"]+)['"]/g, reason: '仅副作用导入' },
      { pattern: /(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, reason: '动态 import()' },
      { pattern: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, reason: 'CJS require()' },
    ]
    for (const { pattern, reason } of opaque) {
      for (const match of source.matchAll(pattern)) {
        const target = splitHostSpecifier(match[1])
        if (target === undefined) continue
        const k = key(target.package, target.subpath)
        // A named import already covers this subpath; a named check is strictly
        // stronger, so do not downgrade it.
        if (named.has(k) || unverifiable.has(k)) continue
        unverifiable.set(k, { package: target.package, subpath: target.subpath, reason })
      }
    }
  }

  return {
    files,
    truncated,
    used: [...named.values()].map((e) => ({ ...e, symbols: [...e.symbols].sort() })),
    unverifiable: [...unverifiable.values()],
  }
}

/**
 * Read a directory of host-surface baselines written by `dsh-plugin-api --write`.
 *
 * Each file must carry its own `hostVersion`. Inferring the version from the
 * file name would make the artifact's meaning depend on how someone named it.
 *
 * @param {string} dir
 * @returns {{ hostVersion: string, surface: any, file: string }[]}
 */
export function readSurfaceDir(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`API 面目录不存在：${dir}`)
  /** @type {{ hostVersion: string, surface: any, file: string }[]} */
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`API 面文件不是合法 JSON：${file}（${error?.message ?? error}）`)
    }
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.packages !== 'object') {
      throw new Error(`API 面文件缺少 packages：${file}`)
    }
    if (typeof parsed.hostVersion !== 'string' || semver.valid(parsed.hostVersion) === null) {
      throw new Error(
        `API 面文件缺少可用的 hostVersion（${file}）—— 请用当前版本的 dsh-plugin-api --write 重新生成：` +
          '没有 hostVersion 就无法确定这份面属于哪个宿主版本',
      )
    }
    out.push({ hostVersion: parsed.hostVersion, surface: parsed, file })
  }
  if (out.length === 0) throw new Error(`API 面目录里没有 .json 文件：${dir}`)
  out.sort((a, b) => semver.compare(a.hostVersion, b.hostVersion))
  return out
}

/**
 * Does a subpath match, honouring `*` patterns in the recorded surface?
 *
 * The surface legitimately contains patterns such as `./src/*` and
 * `./locale/*.json`. Comparing a literal import path against those with `===`
 * would report a present API as missing.
 *
 * @param {string} subpath
 * @param {string[]} patterns
 * @returns {string | undefined} the pattern that matched, if any
 */
export function matchSubpath(subpath, patterns) {
  if (patterns.includes(subpath)) return subpath
  for (const pattern of patterns) {
    if (!pattern.includes('*')) continue
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    if (new RegExp(`^${escaped}$`).test(subpath)) return pattern
  }
  return undefined
}

/**
 * Check one plugin's used APIs against one host surface.
 *
 * `universe` is the union of package names across **all** recorded surfaces. It
 * exists to separate two cases that look identical from one surface alone:
 *
 * - a package in the universe but absent from *this* surface — a real removal,
 *   and exactly the failure `diffApiSurface` calls `removedPackage`; it must be
 *   reported, not skipped;
 * - a package in *no* surface — the plugin's own sibling packages (e.g. a
 *   monorepo's `@deepseek-ai/dsh-plugin-eda-sch`) and ordinary third-party
 *   libraries. Those are not host APIs and must not be reported as missing.
 *
 * @param {{ used: any[], unverifiable: any[] }} usage
 * @param {{ hostVersion: string, surface: any }} recorded
 * @param {Set<string>} universe
 * @returns {{
 *   hostVersion: string,
 *   missing: { package: string, subpath: string, symbols: string[], reason: 'noPackage' | 'noSubpath' | 'noSymbol' }[],
 *   checked: number,
 *   outOfScope: string[]
 * }}
 */
export function checkUsageAgainstSurface(usage, recorded, universe) {
  const packages = recorded.surface.packages ?? {}
  /** @type {any[]} */
  const missing = []
  /** @type {Set<string>} */
  const outOfScope = new Set()
  let checked = 0
  for (const entry of usage.used) {
    const pkg = packages[entry.package]
    if (pkg === undefined) {
      if (!universe.has(entry.package)) {
        outOfScope.add(entry.package)
        continue
      }
      missing.push({ package: entry.package, subpath: entry.subpath, symbols: [], reason: 'noPackage' })
      continue
    }
    const matched = matchSubpath(entry.subpath, pkg.subpaths ?? [])
    if (matched === undefined) {
      missing.push({ package: entry.package, subpath: entry.subpath, symbols: [], reason: 'noSubpath' })
      continue
    }
    checked += 1
    const available = pkg.symbols?.[matched]
    // `undefined` means the surface recorded no symbols for this subpath (a
    // non-JS entry, or one the collector could not read) — that is "unknown",
    // not "empty", so no symbol may be reported missing from it.
    if (available === undefined) continue
    const gone = entry.symbols.filter((symbol) => !available.includes(symbol))
    if (gone.length > 0) {
      missing.push({ package: entry.package, subpath: entry.subpath, symbols: gone, reason: 'noSymbol' })
    }
  }
  return { hostVersion: recorded.hostVersion, missing, checked, outOfScope: [...outOfScope].sort() }
}

/**
 * Union of every package name appearing in any recorded surface.
 *
 * @param {{ surface: any }[]} recorded
 * @returns {Set<string>}
 */
export function surfaceUniverse(recorded) {
  /** @type {Set<string>} */
  const universe = new Set()
  for (const item of recorded) for (const name of Object.keys(item.surface.packages ?? {})) universe.add(name)
  return universe
}
