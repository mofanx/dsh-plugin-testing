/**
 * T17 — host-version matrix: derive the compatibility **claim set**.
 *
 * Every other pass in this package answers a question about **one** host: "does
 * this declaration admit the host I happen to have installed?" That answer is a
 * function of the declaration, not of reality, and it yields exactly one data
 * point. It cannot tell you what the plugin claims to support — only whether the
 * single host in front of it is inside the claim.
 *
 * This pass inverts the direction. Given an explicit list of **published** host
 * versions, it computes the **set** the declaration covers, which is the thing a
 * reader actually wants ("兼容哪些宿主版本"), and it surfaces two defect classes
 * that are structurally invisible from a single host:
 *
 *  - a **hole** (`DSH-C068`) — a published version *between* two admitted ones
 *    that the range excludes. A user on that version is disabled even though the
 *    plugin claims its immediate neighbours, so the claim is not what it looks
 *    like.
 *  - **divergence** (`DSH-C067`, here evaluated per candidate instead of against
 *    one host) — a version the runtime preflight admits but npm/pnpm reject at
 *    install time.
 *
 * ## Faithfulness
 *
 * Mirrors the runtime preflight exactly in two respects:
 *
 *  1. Only `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers are graded. Cordis
 *     peers are npm-resolved and never preflighted.
 *  2. Admission is the **intersection** over every dsh runtime peer, because
 *     `evaluatePluginCompatibility` denies the row when *any* peer is
 *     unsatisfied — not when all of them are.
 *
 * ## Honest boundary (read before quoting a result)
 *
 * This pass derives the **claim**, never a **verification**. It installs nothing
 * and boots nothing, so it cannot establish that a version works; it establishes
 * which versions the declaration *asserts*. Presenting the derived set as
 * "verified compatible" would be exactly the false green this project exists to
 * prevent. A claimed version becomes verified only by running the plugin on it
 * (probe / test suite), which is a separate, costlier stage.
 *
 * @module dsh-plugin-conformance/matrix
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { checkUsageAgainstSurface, scanUsedApis, surfaceUniverse } from './api-usage.mjs'
import { isDshRuntimePeer } from './peer.mjs'
import { prereleaseTuple, satisfies, satisfiesInstallTime } from './semver.mjs'
import { severityOf } from './rules.mjs'

/**
 * Read an explicit candidate host-version list.
 *
 * The list is an **input**, never fetched: a checker that reaches the network at
 * check time is neither hermetic nor reproducible, and its verdict would change
 * without any commit. Generate the file deliberately (see
 * `docs/testing-guide.md`) and commit it, exactly like a pinned revision.
 *
 * @param {string} filePath
 * @returns {{ source: string | null, generatedAt: string | null, versions: string[], knownGaps: Record<string, string> }}
 */
export function readCandidateList(filePath) {
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取候选宿主版本清单 ${filePath}：${error?.message ?? error}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`候选宿主版本清单必须是 JSON 对象（含 versions 数组）：${filePath}`)
  }
  if (!Array.isArray(parsed.versions)) {
    throw new Error(`候选宿主版本清单缺少 versions 数组：${filePath}`)
  }

  /** @type {string[]} */
  const versions = []
  for (const entry of parsed.versions) {
    if (typeof entry !== 'string' || semver.valid(entry) === null) {
      throw new Error(`候选宿主版本清单含非法版本：${JSON.stringify(entry)}（${filePath}）`)
    }
    if (!versions.includes(entry)) versions.push(entry)
  }
  if (versions.length === 0) {
    throw new Error(`候选宿主版本清单为空：${filePath} —— 空清单会得出"没有任何版本被覆盖"的假结论`)
  }

  /**
   * Gaps the author has **confirmed** are unsupported, with a reason. Without
   * this, a deliberate exclusion is indistinguishable from an accidental one and
   * the checker would have to guess. Same shape as `compatibility.json`: the
   * deviation stays visible, it just stops being blocking.
   *
   * @type {Record<string, string>}
   */
  const knownGaps = {}
  if (parsed.knownGaps !== undefined) {
    if (parsed.knownGaps === null || typeof parsed.knownGaps !== 'object' || Array.isArray(parsed.knownGaps)) {
      throw new Error(`knownGaps 必须是对象（版本 → 原因）：${filePath}`)
    }
    for (const [version, reason] of Object.entries(parsed.knownGaps)) {
      if (semver.valid(version) === null) throw new Error(`knownGaps 含非法版本：${version}（${filePath}）`)
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new Error(`knownGaps 的 ${version} 缺少原因 —— 无原因的豁免等于隐藏问题（${filePath}）`)
      }
      knownGaps[version] = reason
    }
  }

  // Ascending semver order is the order every downstream span/hole computation
  // assumes; sorting here keeps that invariant in one place.
  versions.sort((a, b) => semver.compare(a, b))
  return {
    source: typeof parsed.source === 'string' ? parsed.source : null,
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
    versions,
    knownGaps,
  }
}

/**
 * Read a package's dsh runtime peers (the only peers the preflight grades).
 *
 * Throws a readable message rather than letting a raw `ENOENT` escape: a path
 * typo or a directory without a manifest is a **usage** mistake, and the caller
 * must be able to tell it apart from a finding about the plugin. (A glob that
 * matches a non-package directory is the easy way to hit this.)
 *
 * @param {string} packageDir
 * @returns {{ name: string, version: string | undefined, peers: Record<string, string> }}
 */
export function readDshPeers(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  /** @type {string} */
  let raw
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(`读取不到 package.json：${manifestPath}（${error?.code ?? error?.message ?? error}）`)
  }
  /** @type {any} */
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw new Error(`package.json 不是合法 JSON：${manifestPath}（${error?.message ?? error}）`)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`package.json 必须是 JSON 对象：${manifestPath}`)
  }
  const declared = manifest.peerDependencies !== null && typeof manifest.peerDependencies === 'object' ? manifest.peerDependencies : {}
  /** @type {Record<string, string>} */
  const peers = {}
  for (const [dependency, range] of Object.entries(declared)) {
    if (!isDshRuntimePeer(dependency)) continue
    if (typeof range === 'string') peers[dependency] = range
  }
  return {
    name: typeof manifest.name === 'string' ? manifest.name : '<unnamed>',
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    peers,
  }
}

/**
 * @typedef {object} CandidateRow
 * @property {string} version
 * @property {boolean} runtimeAdmits all dsh peers admit it under the runtime's
 *   prerelease-inclusive semantics (this is the row's fate at boot)
 * @property {boolean} installAdmits all dsh peers admit it under plain npm/pnpm
 *   semantics (this is the row's fate at install time)
 * @property {boolean} divergence runtime admits, install rejects (`DSH-C067`)
 * @property {boolean} inSpan between the oldest and newest admitted candidate
 * @property {boolean} hole in span but not admitted (`DSH-C068`)
 * @property {{ dependency: string, range: string, runtime: boolean, install: boolean }[]} perPeer
 */

/**
 * Derive the host-version claim set for one package.
 *
 * @param {string} packageDir
 * @param {{
 *   candidates: string[],
 *   knownGaps?: Record<string, string>,
 *   surfaces?: { hostVersion: string, surface: any, file: string }[]
 * }} options
 * @returns {{
 *   packageDir: string, name: string, version: string | undefined,
 *   peers: Record<string, string>, hasDshPeers: boolean,
 *   rows: CandidateRow[],
 *   admitted: string[], installAdmitted: string[], divergence: string[], holes: string[],
 *   acknowledgedGaps: string[],
 *   span: { min: string, max: string } | null,
 *   belowSpan: string[], aboveSpan: string[],
 *   apiAvailability: any,
 *   findings: { code: string, severity: 'error' | 'warn', message: string }[]
 * }}
 */
export function deriveHostMatrix(packageDir, options) {
  const candidates = [...options.candidates].sort((a, b) => semver.compare(a, b))
  const knownGaps = options.knownGaps ?? {}
  const { name, version, peers } = readDshPeers(packageDir)
  const dependencies = Object.keys(peers)
  const hasDshPeers = dependencies.length > 0

  /** @type {CandidateRow[]} */
  const rows = candidates.map((candidate) => {
    const perPeer = dependencies.map((dependency) => {
      const range = peers[dependency]
      return {
        dependency,
        range,
        runtime: satisfies(candidate, range),
        install: satisfiesInstallTime(candidate, range),
      }
    })
    // Intersection, not union: the preflight denies the row if ANY dsh peer is
    // unsatisfied, so one narrow peer bounds the whole package.
    //
    // With no dsh peers at all, `every` would be vacuously true and the matrix
    // would claim universal support. `hasDshPeers` is reported separately so
    // callers must not read an empty peer set as "supports everything".
    const runtimeAdmits = hasDshPeers && perPeer.every((entry) => entry.runtime)
    const installAdmits = hasDshPeers && perPeer.every((entry) => entry.install)
    return {
      version: candidate,
      runtimeAdmits,
      installAdmits,
      divergence: runtimeAdmits && !installAdmits,
      inSpan: false,
      hole: false,
      perPeer,
    }
  })

  const admitted = rows.filter((row) => row.runtimeAdmits).map((row) => row.version)
  const installAdmitted = rows.filter((row) => row.installAdmits).map((row) => row.version)
  const span = admitted.length === 0 ? null : { min: admitted[0], max: admitted[admitted.length - 1] }

  if (span !== null) {
    const first = rows.findIndex((row) => row.version === span.min)
    const last = rows.findIndex((row) => row.version === span.max)
    // The candidate list is sorted, so the admitted endpoints bracket exactly the
    // versions the declaration appears to cover. Anything in between that is not
    // admitted is a hole in the claim.
    for (let index = first; index <= last; index += 1) {
      rows[index].inSpan = true
      rows[index].hole = !rows[index].runtimeAdmits
    }
  }

  const holes = rows.filter((row) => row.hole).map((row) => row.version)
  const acknowledgedGaps = holes.filter((hole) => knownGaps[hole] !== undefined)
  const divergence = rows.filter((row) => row.divergence).map((row) => row.version)
  const belowSpan = span === null ? [] : rows.filter((row) => semver.lt(row.version, span.min)).map((row) => row.version)
  const aboveSpan = span === null ? [] : rows.filter((row) => semver.gt(row.version, span.max)).map((row) => row.version)

  /** @type {{ code: string, severity: 'error' | 'warn', message: string }[]} */
  const findings = []

  for (const hole of holes) {
    // A confirmed gap is a decision, not a defect — but it stays visible, and it
    // still needs a reason on record. Downgrading without one would let a typo
    // become policy.
    const acknowledged = knownGaps[hole]
    findings.push({
      code: 'DSH-C068',
      severity: acknowledged === undefined ? severityOf('DSH-C068') : 'warn',
      message:
        `${name} 声明的宿主范围存在空洞：${hole} 已发布、且落在被覆盖区间 ` +
        `[${span.min}, ${span.max}] 之内，却不在任何 peer 的接纳集合里 —— ` +
        `该版本上的用户会被运行时禁用，尽管相邻版本都被声明覆盖。` +
        (acknowledged === undefined
          ? `若这是有意的，请在候选清单的 knownGaps 里写明 ${hole} 与原因（无原因的排除与遗漏无法区分）；否则把 ${hole} 纳入范围`
          : `已在候选清单的 knownGaps 中确认为有意排除：${acknowledged}`),
    })
  }

  for (const candidate of divergence) {
    const tuple = prereleaseTuple(candidate)
    findings.push({
      code: 'DSH-C067',
      severity: severityOf('DSH-C067'),
      message:
        `${name} 在宿主 ${candidate} 上：运行时预检接纳，但安装期（npm/pnpm）会判为 peer 不满足 —— ` +
        `${candidate} 是预发布版本，而裸 semver 只接纳带同一 [major,minor,patch] 元组预发布的比较器` +
        `${tuple === null ? '' : `，当前范围没有任何比较器覆盖 ${tuple}`}。` +
        `运行时不会因此拒绝该插件，但安装期会失败 —— 改成并集可同时满足两种语义`,
    })
  }

  // ---------------------------------------------------------------------
  // T18 — cross the declaration with what the code actually imports.
  //
  // The matrix above grades the *declaration*: it never looks at the plugin's
  // own source, so it cannot notice that a version it admits has dropped a
  // subpath or symbol the plugin imports. Recorded host surfaces close that gap
  // without installing or booting anything.
  //
  // Coverage is deliberately partial and reported as such: a version in the span
  // with no recorded surface is **未知**, never "fine". Saying "no surface, so no
  // problem" would be the exact false green this pass exists to prevent.
  // ---------------------------------------------------------------------
  /** @type {any} */
  let apiAvailability = null
  if (options.surfaces !== undefined && options.surfaces.length > 0) {
    const recorded = [...options.surfaces].sort((a, b) => semver.compare(a.hostVersion, b.hostVersion))
    const usage = scanUsedApis(packageDir)
    const universe = surfaceUniverse(recorded)
    const byVersion = new Map(recorded.map((item) => [item.hostVersion, item]))
    const inSpanVersions = rows.filter((row) => row.inSpan).map((row) => row.version)

    const surfaceRows = inSpanVersions.map((version) => {
      const surface = byVersion.get(version)
      if (surface === undefined) return { version, covered: false, checked: 0, missing: [], outOfScope: [] }
      const result = checkUsageAgainstSurface(usage, surface, universe)
      return { version, covered: true, ...result }
    })

    const uncovered = surfaceRows.filter((row) => !row.covered).map((row) => row.version)
    const withMissing = surfaceRows.filter((row) => row.covered && row.missing.length > 0)
    const apiSafe = surfaceRows.filter((row) => row.covered && row.missing.length === 0).map((row) => row.version)

    apiAvailability = {
      files: usage.files,
      truncated: usage.truncated,
      used: usage.used,
      unverifiable: usage.unverifiable,
      outOfScope: surfaceRows.find((row) => row.covered)?.outOfScope ?? [],
      recordedVersions: recorded.map((item) => item.hostVersion),
      rows: surfaceRows,
      uncovered,
      apiSafe,
    }

    for (const row of withMissing) {
      for (const miss of row.missing) {
        const what =
          miss.reason === 'noPackage'
            ? `整个包都不在该宿主的 API 面里`
            : miss.reason === 'noSubpath'
              ? `子路径 ${miss.subpath} 不存在`
              : `子路径 ${miss.subpath} 里已没有符号 ${miss.symbols.join(', ')}`
        findings.push({
          code: 'DSH-C069',
          severity: severityOf('DSH-C069'),
          message:
            `${name} 声明覆盖 ${row.version}，但该宿主的 API 面里${what}：` +
            `插件发布入口引用了 ${miss.package}${miss.reason === 'noSubpath' ? '' : ` [${miss.subpath}]`}。` +
            `该版本上插件会在 import 阶段直接失败 —— 收窄 peer 范围把 ${row.version} 排除，或改掉这处引用`,
        })
      }
    }
  }

  return {
    packageDir,
    name,
    version,
    peers,
    hasDshPeers,
    rows,
    admitted,
    installAdmitted,
    divergence,
    holes,
    acknowledgedGaps,
    span,
    belowSpan,
    aboveSpan,
    apiAvailability,
    findings,
  }
}
