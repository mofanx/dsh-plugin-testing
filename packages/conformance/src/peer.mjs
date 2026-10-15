/**
 * T12 — peer / version contract pass.
 *
 * Answers: "will the host actually satisfy what this plugin demands?" This is
 * the pass that catches the classic `belowMin` situation: peers demanding a
 * source-line prerelease while the running host ships an older rc line.
 *
 * Implements rules DSH-C057 and DSH-C060…C065 from `docs/contract-v1.md` §6.
 *
 * Faithfulness note: the runtime (`dsh-app-boot` `evaluatePluginCompatibility`)
 * only preflights peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`, and
 * it compares each against the **single** runtime version read from
 * `dsh-app-boot`'s own manifest (`getDshRuntimeVersion`), not against each
 * peer's individually installed version. Cordis peers are *not* preflighted at
 * all — they resolve through ordinary npm resolution. This module mirrors that
 * split: dsh runtime peers are graded against one runtime version, and cordis
 * peers are graded against their own installed version as a separate,
 * non-blocking warning (DSH-C057).
 *
 * @module dsh-plugin-conformance/peer
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { severityOf } from './rules.mjs'
import { diagnoseRange, spansUnverifiedMajors } from './semver.mjs'

/** The runtime preflight's exact dsh peer name and its scoped prefix. */
const DSH_RUNTIME_PEER_NAME = '@deepseek-ai/dsh'
const DSH_RUNTIME_PEER_PREFIX = '@deepseek-ai/dsh-'

/** Cordis and its plugin family: npm-resolved, not runtime-preflighted. */
const CORDIS_PEER_NAME = '@deepseek-ai/cordis'
const CORDIS_PEER_PREFIX = '@deepseek-ai/cordis-plugin-'

/**
 * Packages whose version identifies the DSH **runtime** line. `dsh-app-boot`
 * is the authoritative source (`getDshRuntimeVersion()` reads its own
 * `package.json`); the rest are fallbacks for partial host trees. Exemption
 * entries in `compatibility.json` are keyed on this version, not on each
 * peer's installed version.
 */
const DSH_VERSION_SOURCES = [
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm',
]

/**
 * Whether `name` belongs to the host's own package surface (dsh runtime or
 * cordis family). This is the *broad* membership used for composition rules;
 * the peer pass distinguishes the two families internally.
 * @param {string} name
 */
export function isHostCorePackage(name) {
  return (
    name === DSH_RUNTIME_PEER_NAME ||
    name.startsWith(DSH_RUNTIME_PEER_PREFIX) ||
    name === CORDIS_PEER_NAME ||
    name.startsWith(CORDIS_PEER_PREFIX)
  )
}

/** Runtime-preflighted peers only (`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`). */
function isDshRuntimePeer(name) {
  return name === DSH_RUNTIME_PEER_NAME || name.startsWith(DSH_RUNTIME_PEER_PREFIX)
}

/** Npm-resolved cordis peers (`@deepseek-ai/cordis` / `@deepseek-ai/cordis-plugin-*`). */
function isCordisPeer(name) {
  return name === CORDIS_PEER_NAME || name.startsWith(CORDIS_PEER_PREFIX)
}

/**
 * Best-effort DSH runtime version for a host tree, preferring `dsh-app-boot`.
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
 * @param {'error' | 'warn'} [severity] Overrides the rule's declared severity.
 *   Used by DSH-C060/C061 when a covering `compatibility.json` exemption makes
 *   the mismatch an accepted deviation instead of a blocking one.
 * @returns {import('./manifest.mjs').Finding}
 */
function finding(code, message, severity) {
  return { code, severity: severity ?? severityOf(code), message }
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
 * Whether a single clause silently spans majors the author never declared.
 * Thin re-export of the semver-level detector so this module stays about policy
 * (which peers are graded, and how) rather than range arithmetic.
 * @param {unknown} range
 */
function crossesMajor(range) {
  return spansUnverifiedMajors(range)
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
  const runtimeVersion = options.dshVersion ?? resolveDshVersion(hostVersions)

  // T15 — a package that is never mounted as a loader row has its peers
  // evaluated by nobody: the runtime's version preflight only inspects rows it
  // would import (`dsh-app-boot` README: rejected rows are never imported).
  // Real case: the support package stayed unloaded, whereas its sibling
  // mounted rows were actually disabled by the host.
  const mounted =
    options.mountedNames === undefined || options.mountedNames === null ? undefined : options.mountedNames.has(name)

  // --- C060 / C061 — dsh runtime peers vs the single runtime version -----
  // The runtime compares every dsh peer against `getDshRuntimeVersion()`, not
  // against each peer's own installed version, so we do the same here.
  //
  // Severity depends on whether the profile's `compatibility.json` covers this
  // package+version on this runtime version. `dsh-app-boot`'s `preflight()`
  // returns no conflict once `issue.exempted` is true, so an exempted row *is*
  // loaded: the mismatch is a known, accepted deviation rather than a blocking
  // one. It stays visible — as a warning — because the declared peer range still
  // claims a host line that is not the one actually running.
  const exemptionKey = `${name}@${version ?? ''}`
  const exemptedFor = exemptions[exemptionKey]
  const exempted =
    Array.isArray(exemptedFor) && runtimeVersion !== undefined && exemptedFor.includes(runtimeVersion)

  /** @type {string[]} */
  const unsatisfied = []
  for (const [dependency, range] of Object.entries(peers)) {
    if (!isDshRuntimePeer(dependency)) continue
    if (runtimeVersion === undefined) continue
    const diagnosis = diagnoseRange(runtimeVersion, range)
    if (diagnosis.satisfied) continue
    unsatisfied.push(dependency)
    if (mounted === false) continue // collapsed into one C066 below
    const code = diagnosis.direction === 'aboveMax' ? 'DSH-C061' : 'DSH-C060'
    const detail = `${name} 要求 ${dependency} ${range}，宿主运行时为 ${runtimeVersion}（${diagnosis.direction ?? '不匹配'}）`
    findings.push(
      exempted
        ? finding(
            code,
            `${detail} —— 已有 compatibility.json 豁免（${exemptionKey} → ${runtimeVersion}），运行时按放行处理，故降级为提醒`,
            'warn',
          )
        : finding(code, detail),
    )
  }

  // --- C057 — cordis peers vs their own installed version ----------------
  // Cordis peers are resolved by npm, not by the runtime preflight. A mismatch
  // here means the plugin would pull a second cordis family version (hoist
  // shadowing), but the host does not refuse the plugin for it — hence warn.
  for (const [dependency, range] of Object.entries(peers)) {
    if (!isCordisPeer(dependency)) continue
    const hostVersion = hostVersions[dependency]
    if (hostVersion === undefined) continue
    const diagnosis = diagnoseRange(hostVersion, range)
    if (diagnosis.satisfied) continue
    findings.push(
      finding(
        'DSH-C057',
        `${name} 的 cordis 系 peer ${dependency} ${range} 不满足宿主实际版本 ${hostVersion}（运行时预检不检查 cordis，但会引发 hoist 遮蔽风险）`,
      ),
    )
  }

  // --- C066 — support packages never get mounted, so nothing evaluates their
  // dsh peers. The mismatch is real but latent; it becomes blocking the moment
  // the package is inserted as a row.
  if (mounted === false && unsatisfied.length > 0) {
    findings.push(
      finding(
        'DSH-C066',
        `${name} 是支撑包（未被任何 profile 挂载为行），peer 不满足宿主：${unsatisfied.join(', ')} —— 当前不阻断加载，但一旦被挂载为行即会被宿主禁用`,
      ),
    )
  }

  // --- C064 — an unsatisfied dsh peer needs an exemption for the DSH runtime
  // version. `compatibility.json` authorizes a plugin against runtime versions
  // (`pkg@ver` → `["0.2.0-rc.2"]`), not against each peer's own installed
  // version, so the lookup must not compare per-peer versions.
  if (mounted !== false && unsatisfied.length > 0 && !exempted) {
    const where = runtimeVersion === undefined ? '未知 DSH 运行时版本' : `宿主 DSH ${runtimeVersion}`
    findings.push(
      finding('DSH-C064', `${exemptionKey} 在 ${where} 上不满足 ${unsatisfied.join(', ')}，且无对应豁免（compatibility.json）`),
    )
  }

  // --- C062 — peer ranges that span major versions (manifest-shape defect,
  // independent of whether the package is mounted).
  for (const [dependency, range] of Object.entries(peers)) {
    if (!isDshRuntimePeer(dependency)) continue
    if (crossesMajor(range)) {
      findings.push(
        finding(
          'DSH-C062',
          `${dependency} 的 peer 范围跨主版本（跨 2 个以上 major，或单侧无界因而隐含宣称未来全部 major）：${range} —— 请改用逐 major 显式并集，如 \`>=1.0.0 <2.0.0 || >=2.0.0 <3.0.0\``,
        ),
      )
    }
  }

  // --- C063 — engines.dsh must agree with the DSH peer ranges (also a
  // manifest-shape defect, independent of mount status).
  const dshEngine = pkg.engines !== null && typeof pkg.engines === 'object' ? pkg.engines.dsh : undefined
  if (dshEngine !== undefined) {
    for (const [dependency, range] of Object.entries(peers)) {
      if (!isDshRuntimePeer(dependency)) continue
      if (range !== dshEngine) {
        findings.push(finding('DSH-C063', `${dependency} 的 peer 范围 ${range} 与 engines.dsh ${dshEngine} 不一致`))
      }
    }
  }

  // --- C065 — exemption entries that no longer match the current package
  // version (independent of mount status: a support package's stale exemption
  // is still stale).
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
