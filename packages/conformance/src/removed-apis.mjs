/**
 * Versioned API-removal table and its match / threshold / cross-validation
 * engine.
 *
 * The host removes APIs over time (the `0.2.1` line already dropped the
 * `./invariant` subpath). Instead of hard-coding each removal in a rule, this
 * module reads a **declarative table** (`removed-apis.json`) and drives the
 * corresponding rules from it. Adding a future removal of the same kind is a
 * one-row data change, not a code change.
 *
 * Table schema (v1):
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "removed": [
 *     {
 *       "id": "invariant-subpath",
 *       "kind": "subpath",
 *       "match": "suffix",
 *       "pattern": "/invariant",
 *       "removedIn": "0.2.1-alpha.2",
 *       "rule": "DSH-C044",
 *       "note": "…"
 *     }
 *   ]
 * }
 * ```
 *
 * - `kind`        removal type; only `subpath` is implemented so far
 *                 (future: `symbol`, `package`, `service`).
 * - `match`       how `pattern` applies: `exact` | `suffix` | `prefix` | `regex`.
 * - `removedIn`   first host version that ships without the API (semver).
 *                 Caliber: always the `@deepseek-ai/dsh-app-boot` package's own
 *                 `package.json` `version` — the same source as getDshRuntimeVersion()
 *                 and resolveDshVersion(). The mechanism is identical across the desktop
 *                 bundle and the web host, but the value is per-deployment: desktop bundle
 *                 = 0.2.0-rc.2, repo source = 0.2.1-alpha.2 (see contract-v1 §〇).
 * - `rule`        the gate rule code that reports this removal.
 *
 * Severity is **threshold-graded** against the host runtime version a plugin
 * is judged against: before `removedIn` → `warn` (still works but migrating),
 * at/after `removedIn` → `error`; unknown runtime → `error` (conservative).
 *
 * `crossValidate` checks the table against an `api-baseline.json` snapshot so
 * a wrong declaration (e.g. "removed in X" but an earlier snapshot already
 * lacks it) fails loudly instead of silently mis-grading.
 *
 * @module dsh-plugin-conformance/removed-apis
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

/**
 * @typedef {object} RemovedApi
 * @property {string} id stable identifier
 * @property {'subpath'} kind removal type (only `subpath` implemented today)
 * @property {'exact' | 'suffix' | 'prefix' | 'regex'} match pattern mode
 * @property {string} pattern the matched value
 * @property {string} removedIn first host version without the API (semver)
 * @property {string} rule gate rule code that reports this removal
 * @property {string} note migration guidance
 */

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'removed-apis.json')

/** @type {{ schemaVersion: number, removed: RemovedApi[] } | null} */
let defaultTable = null

const KNOWN_KINDS = ['subpath']
const KNOWN_MATCHES = ['exact', 'suffix', 'prefix', 'regex']

/** @param {unknown} value @param {string} path @returns {asserts value is Record<string, unknown>} */
function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`removed-apis.json 非法：${path} 应为对象`)
  }
}

/** @param {unknown} value @param {string} path @returns {asserts value is string} */
function assertString(value, path) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`removed-apis.json 非法：${path} 应为非空字符串`)
  }
}

/**
 * Validate the parsed table and return a normalized copy.
 *
 * @param {unknown} parsed
 * @returns {{ schemaVersion: number, removed: RemovedApi[] }}
 */
export function validateRemovedApis(parsed) {
  assertRecord(parsed, '<root>')
  if (parsed.schemaVersion !== 1) {
    throw new Error(`removed-apis.json 非法：schemaVersion 应为 1，实际 ${JSON.stringify(parsed.schemaVersion)}`)
  }
  if (!Array.isArray(parsed.removed)) {
    throw new Error('removed-apis.json 非法：removed 应为数组')
  }
  const removed = parsed.removed.map((entry, index) => {
    const path = `removed[${index}]`
    assertRecord(entry, path)
    assertString(entry.id, `${path}.id`)
    assertString(entry.kind, `${path}.kind`)
    if (!KNOWN_KINDS.includes(entry.kind)) {
      throw new Error(
        `removed-apis.json 非法：${path}.kind 为 ${JSON.stringify(entry.kind)}，仅支持 ${KNOWN_KINDS.join(' / ')}（新增 kind 需先实现对应检查器）`,
      )
    }
    assertString(entry.match, `${path}.match`)
    if (!KNOWN_MATCHES.includes(entry.match)) {
      throw new Error(`removed-apis.json 非法：${path}.match 为 ${JSON.stringify(entry.match)}，仅支持 ${KNOWN_MATCHES.join(' / ')}`)
    }
    assertString(entry.pattern, `${path}.pattern`)
    assertString(entry.removedIn, `${path}.removedIn`)
    if (semver.valid(entry.removedIn) === null) {
      throw new Error(`removed-apis.json 非法：${path}.removedIn ${JSON.stringify(entry.removedIn)} 不是合法 SemVer`)
    }
    assertString(entry.rule, `${path}.rule`)
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      throw new Error(`removed-apis.json 非法：${path}.note 应为字符串`)
    }
    return {
      id: entry.id,
      kind: entry.kind,
      match: entry.match,
      pattern: entry.pattern,
      removedIn: entry.removedIn,
      rule: entry.rule,
      note: typeof entry.note === 'string' ? entry.note : '',
    }
  })
  return { schemaVersion: parsed.schemaVersion, removed }
}

/**
 * Load and validate the removal table. Fails loudly on a malformed table —
 * the table is source, and a broken one must not silently disable the gate.
 *
 * @param {string} [filePath] override (tests use a temp file)
 * @returns {{ schemaVersion: number, removed: RemovedApi[] }}
 */
export function loadRemovedApis(filePath = DEFAULT_PATH) {
  if (filePath === DEFAULT_PATH && defaultTable !== null) return defaultTable
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`无法读取 removed-apis.json（${filePath}）：${error?.message ?? error}`)
  }
  const table = validateRemovedApis(JSON.parse(text))
  if (filePath === DEFAULT_PATH) defaultTable = table
  return table
}

/**
 * Does `value` match an entry's pattern under its match mode?
 *
 * @param {string} value
 * @param {RemovedApi} item
 */
function matchesPattern(value, item) {
  switch (item.match) {
    case 'exact':
      return value === item.pattern
    case 'suffix':
      return value.endsWith(item.pattern)
    case 'prefix':
      return value.startsWith(item.pattern)
    case 'regex':
      return new RegExp(item.pattern).test(value)
    default:
      return false
  }
}

/**
 * Find the `subpath`-kind removal entry that matches an `exports` subpath key,
 * or `null`.
 *
 * @param {string} subpathKey e.g. `./invariant` or `./presets/x.invariant`
 * @param {{ removed: RemovedApi[] }} removedApis
 * @returns {RemovedApi | null}
 */
export function matchRemovedSubpath(subpathKey, removedApis) {
  for (const item of removedApis.removed) {
    if (item.kind !== 'subpath') continue
    if (matchesPattern(subpathKey, item)) return item
  }
  return null
}

/**
 * Severity for a removal given the host runtime version a plugin is judged
 * against. Before `removedIn` the API still exists → `warn`; at/after → `error`;
 * unknown runtime → `error` (conservative, target line).
 *
 * @param {RemovedApi} item
 * @param {string | undefined} runtimeVersion
 * @returns {'error' | 'warn'}
 */
export function removedSeverity(item, runtimeVersion) {
  if (runtimeVersion === undefined || semver.valid(runtimeVersion) === null) return 'error'
  return semver.lt(runtimeVersion, item.removedIn) ? 'warn' : 'error'
}

/**
 * Host package names in a baseline snapshot whose `subpaths` match a removal
 * entry.
 *
 * @param {{ packages: Record<string, { subpaths: string[] }> }} baseline
 * @param {RemovedApi} item
 * @returns {string[]}
 */
function matchingHostPackages(baseline, item) {
  const names = []
  for (const [name, pkg] of Object.entries(baseline.packages ?? {})) {
    const subpaths = Array.isArray(pkg?.subpaths) ? pkg.subpaths : []
    if (subpaths.some((subpath) => matchesPattern(subpath, item))) names.push(name)
  }
  return names
}

/**
 * Infer the host version a baseline snapshot was taken from, preferring the
 * runtime version source (`@deepseek-ai/dsh-app-boot`) for parity with
 * `resolveDshVersion`.
 *
 * @param {{ packages: Record<string, { version?: string | null }> }} baseline
 * @returns {string | undefined}
 */
export function inferBaselineVersion(baseline) {
  const boot = baseline?.packages?.['@deepseek-ai/dsh-app-boot']
  return typeof boot?.version === 'string' ? boot.version : undefined
}

/**
 * Cross-validate removal declarations against a baseline snapshot.
 *
 * For each `subpath` removal, the snapshot must be consistent with the
 * declared `removedIn`:
 *   - snapshot < removedIn  → at least one host package should still export it;
 *   - snapshot ≥ removedIn  → no host package should export it.
 *
 * A mismatch means the **table** is wrong (not the plugin), so the returned
 * entries describe the table defect, ready to fail a self-check.
 *
 * @param {{ removed: RemovedApi[] }} removedApis
 * @param {{ packages: Record<string, { subpaths: string[], version?: string | null }> }} baseline
 * @param {string | undefined} [baselineVersion] explicit version; falls back to `inferBaselineVersion`
 * @returns {{ id: string, problem: 'still-present' | 'missing-before-removal', removedIn: string, baselineVersion: string | undefined, matchingPackages: string[] }[]}
 */
export function crossValidate(removedApis, baseline, baselineVersion) {
  const version = baselineVersion ?? inferBaselineVersion(baseline)
  /** @type {ReturnType<typeof crossValidate>} */
  const defects = []
  for (const item of removedApis.removed) {
    if (item.kind !== 'subpath') continue
    const matching = matchingHostPackages(baseline, item)
    if (version === undefined || semver.valid(version) === null) continue
    const afterRemoval = semver.gte(version, item.removedIn)
    if (afterRemoval && matching.length > 0) {
      defects.push({
        id: item.id,
        problem: 'still-present',
        removedIn: item.removedIn,
        baselineVersion: version,
        matchingPackages: matching,
      })
    } else if (!afterRemoval && matching.length === 0) {
      defects.push({
        id: item.id,
        problem: 'missing-before-removal',
        removedIn: item.removedIn,
        baselineVersion: version,
        matchingPackages: [],
      })
    }
  }
  return defects
}
