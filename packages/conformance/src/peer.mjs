/**
 * T12 — peer / version contract pass.
 *
 * Answers: "will the host actually satisfy what this plugin demands?" This is
 * the pass that catches the classic `belowMin` situation: peers demanding a
 * source-line prerelease while the running host ships an older rc line.
 *
 * Implements rules DSH-C060…C065 from `dsh-plugin-contract-v1.md` §6.
 *
 * @module dsh-plugin-conformance/peer
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { severityOf } from './rules.mjs'
import { diagnoseRange } from './semver.mjs'

/** Package-name prefixes that belong to the host, not to the plugin. */
const HOST_PREFIXES = ['@deepseek-ai/dsh-', '@deepseek-ai/cordis']

/**
 * Packages whose version identifies the DSH **runtime** line. Exemption
 * entries in `compatibility.json` are keyed on this version, not on each
 * peer's installed version.
 */
const DSH_VERSION_SOURCES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm',
]

/** @param {string} name */
export function isHostCorePackage(name) {
  return HOST_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Best-effort DSH runtime version for a host tree.
 * @param {Record<string, string>} hostVersions
 * @returns {string | undefined}
 */
export function resolveDshVersion(hostVersions) {
  for (const name of DSH_VERSION_SOURCES) {
    if (typeof hostVersions[name] === 'string') return hostVersions[name]
  }
  return undefined
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {import('./manifest.mjs').Finding}
 */
function finding(code, message) {
  return { code, severity: severityOf(code), message }
}

/**
 * Read installed versions of host packages from a DSH `node_modules` root.
 *
 * @param {string} hostDir directory containing `@deepseek-ai/`
 * @returns {Record<string, string>} package name → installed version
 */
export function readHostVersions(hostDir) {
  /** @type {Record<string, string>} */
  const versions = {}
  const scopeDir = join(hostDir, '@deepseek-ai')
  if (!existsSync(scopeDir)) return versions
  for (const entry of readdirSync(scopeDir)) {
    const manifestPath = join(scopeDir, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        versions[manifest.name] = manifest.version
      }
    } catch {
      // A malformed host manifest is not this plugin's finding; skip it.
    }
  }
  return versions
}

/**
 * Read a profile's `compatibility.json` (exact `name@version` → host versions).
 *
 * @param {string} filePath
 * @returns {Record<string, string[]>}
 */
export function readExemptions(filePath) {
  if (!existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * Does this range carry both a lower and an upper bound in different majors?
 * @param {unknown} range
 */
function crossesMajor(range) {
  if (typeof range !== 'string') return false
  if (!/(<|<=)\s*\d/.test(range) || !/(>|>=)\s*\d/.test(range)) return false
  const versions = [...range.matchAll(/\d+\.\d+\.\d+/g)].map((match) => match[0])
  return new Set(versions.map((version) => version.split('.')[0])).size > 1
}

/**
 * Check one package's peer/version contract against a concrete host.
 *
 * @param {string} packageDir
 * @param {{ hostVersions?: Record<string, string>, exemptions?: Record<string, string[]>, exemptionsPath?: string, dshVersion?: string, mountedNames?: Set<string> | null }} [options]
 * @returns {import('./manifest.mjs').Finding[]}
 */
export function checkPeerContract(packageDir, options = {}) {
  const hostVersions = options.hostVersions ?? {}
  const exemptions = options.exemptions ?? {}
  /** @type {import('./manifest.mjs').Finding[]} */
  const findings = []

  /** @type {any} */
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    return [finding('DSH-C000', `无法读取或解析 ${join(packageDir, 'package.json')}：${error?.message ?? error}`)]
  }

  const name = typeof pkg.name === 'string' ? pkg.name : '<unnamed>'
  const version = typeof pkg.version === 'string' ? pkg.version : undefined
  const peers = pkg.peerDependencies !== null && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {}
  const dshVersion = options.dshVersion ?? resolveDshVersion(hostVersions)

  // T15 — a package that is never mounted as a loader row has its peers
  // evaluated by nobody: the runtime's version preflight only inspects rows it
  // would import (`dsh-app-boot` README: rejected rows are never imported).
  // Real case: the support package stayed unloaded, whereas its sibling
  // mounted rows were actually disabled by the host.
  const mounted =
    options.mountedNames === undefined || options.mountedNames === null ? undefined : options.mountedNames.has(name)

  // C060 / C061 — satisfaction against the concrete host.
  /** @type {string[]} */
  const unsatisfied = []
  for (const [dependency, range] of Object.entries(peers)) {
    if (!isHostCorePackage(dependency)) continue
    const hostVersion = hostVersions[dependency]
    if (hostVersion === undefined) continue
    const diagnosis = diagnoseRange(hostVersion, range)
    if (diagnosis.satisfied) continue
    unsatisfied.push(dependency)
    if (mounted === false) continue // collapsed into one C066 below
    findings.push(
      finding(
        diagnosis.direction === 'aboveMax' ? 'DSH-C061' : 'DSH-C060',
        `${name} 要求 ${dependency} ${range}，宿主实际为 ${hostVersion}（${diagnosis.direction ?? '不匹配'}）`,
      ),
    )
  }

  // C066 — support packages never get mounted, so nothing evaluates their
  // peers. The mismatch is real but latent; it becomes blocking the moment the
  // package is inserted as a row.
  if (mounted === false) {
    if (unsatisfied.length > 0) {
      findings.push(
        finding(
          'DSH-C066',
          `${name} 是支撑包（未被任何 profile 挂载为行），peer 不满足宿主：${unsatisfied.join(', ')} —— 当前不阻断加载，但一旦被挂载为行即会被宿主禁用`,
        ),
      )
    }
    return findings
  }

  // C064 — an unsatisfied peer needs an exemption for the DSH **runtime**
  // version. `compatibility.json` authorizes a plugin against runtime
  // versions (`pkg@ver` → `["0.2.0-rc.2"]`), not against each peer's own
  // installed version, so the lookup must not compare per-peer versions.
  if (unsatisfied.length > 0) {
    const key = `${name}@${version ?? ''}`
    const allowed = exemptions[key]
    const covered = Array.isArray(allowed) && dshVersion !== undefined && allowed.includes(dshVersion)
    if (!covered) {
      const where = dshVersion === undefined ? '未知 DSH 运行时版本' : `宿主 DSH ${dshVersion}`
      findings.push(
        finding('DSH-C064', `${key} 在 ${where} 上不满足 ${unsatisfied.join(', ')}，且无对应豁免（compatibility.json）`),
      )
    }
  }

  // C062 — peer ranges that span major versions.
  for (const [dependency, range] of Object.entries(peers)) {
    if (!isHostCorePackage(dependency)) continue
    if (crossesMajor(range)) {
      findings.push(finding('DSH-C062', `${dependency} 的 peer 范围跨主版本：${range}`))
    }
  }

  // C063 — engines.dsh must agree with the DSH peer ranges.
  const dshEngine = pkg.engines !== null && typeof pkg.engines === 'object' ? pkg.engines.dsh : undefined
  if (dshEngine !== undefined) {
    for (const [dependency, range] of Object.entries(peers)) {
      if (!dependency.startsWith('@deepseek-ai/dsh-')) continue
      if (range !== dshEngine) {
        findings.push(finding('DSH-C063', `${dependency} 的 peer 范围 ${range} 与 engines.dsh ${dshEngine} 不一致`))
      }
    }
  }

  // C065 — exemption entries that no longer match the current package version.
  if (version !== undefined) {
    for (const key of Object.keys(exemptions)) {
      if (!key.startsWith(`${name}@`)) continue
      const exemptVersion = key.slice(name.length + 1)
      if (exemptVersion !== version) {
        findings.push(finding('DSH-C065', `豁免条目 ${key} 已失效：当前版本为 ${version}`))
      }
    }
  }

  return findings
}
