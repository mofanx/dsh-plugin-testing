/**
 * T16 — runtime activation probe: "does the host actually let these rows load?"
 *
 * ## Why this exists
 *
 * The static gate (`dsh-plugin-conformance`) reads manifests and never starts
 * DSH. That is what makes it fast and credential-free — and it is also why it
 * cannot answer the one question that decides whether a plugin works on a given
 * host: **did the runtime disable the row?**
 *
 * That decision is made by `dsh-app-boot`'s compatibility preflight while
 * entries are prepared, and it is announced on stderr:
 *
 * ```
 * dsh: disabling profile plugin row "probe": Plugin @probe/plugin@1.0.0 is
 * incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-llm":">=9.0.0"}.
 * ```
 *
 * The only way to observe it is to boot. A `--dump-config` run does **not** reach
 * the preflight (verified: an incompatible row appears in the dump with no
 * `disabled` flag and no diagnostic at all), so a config dump cannot stand in
 * for this — it would report success for exactly the case this probe exists to
 * catch.
 *
 * ## Why it needs no credentials and no external service
 *
 * The preflight runs before the first model call, so a hermetic home — which by
 * construction has no `compatibility.json` and no credentials — predictably ends
 * at:
 *
 * ```
 * MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
 * ```
 *
 * Reaching that state **is the proof that startup completed**: the rows were
 * composed and not denied, and the process got as far as needing a model.
 * Needing a real key to go further would make the probe unusable in CI, so the
 * probe deliberately scrubs credential variables from the child environment and
 * treats that terminal state as the pass condition.
 *
 * ## What counts as a failure
 *
 * Every message below is a startup-level defect, not a runtime one:
 *
 * - `disabling profile plugin` — the compatibility preflight denied a row;
 * - `did not activate` / `startup failed` — a required plugin never came up;
 * - `Plugins waiting for services` — a row is stuck pending an unmet service;
 * - `plugin tree failed to load` — the loader itself threw.
 *
 * @module dsh-plugin-testkit/activate
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_TEST_BUNDLES, createTestHome, testHomeArgs, testHomeEnv } from './home.mjs'

/** The packaged launcher; override with `DSH_BIN` on another install. */
export const DEFAULT_LAUNCHER = join(
  'D:\\Program Files\\DSH NEXT\\resources\\app',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
)

/**
 * Resolve the launcher to run. `DSH_BIN` wins so another install (or a source
 * checkout) can be probed without editing code.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveLauncher(env = process.env) {
  return env.DSH_BIN ?? DEFAULT_LAUNCHER
}

/**
 * Environment variables that would let the probe reach a real model.
 *
 * Removed from the child environment on purpose: the probe's verdict is about
 * *startup*, and a run that proceeded to a real model call would (a) cost money,
 * (b) make the terminal state depend on the machine, and (c) let a passing probe
 * depend on network health. Set `allowCredentials: true` to opt out.
 */
const CREDENTIAL_ENV = Object.freeze(['DEEPSEEK_API_KEY'])

/**
 * Expand one package pattern. A trailing `/*` means "every subdirectory that
 * holds a `package.json`"; anything else is a literal directory.
 *
 * Mirrors the conformance gate's own target syntax so one repository can declare
 * both lanes the same way.
 *
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandPackagePattern(pattern) {
  const normalized = pattern.replace(/\\/g, '/')
  if (!normalized.endsWith('/*')) return [pattern]
  const parent = normalized.slice(0, -2)
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(parent, entry.name))
      .filter((directory) => existsSync(join(directory, 'package.json')))
  } catch {
    return []
  }
}

/**
 * @typedef {object} DiscoveredPackage
 * @property {string} name the package's own `name` field
 * @property {string} dir absolute directory holding its `package.json`
 * @property {string} version its `version` field, when declared
 * @property {boolean} hasEntry whether the package exposes an importable entry
 *   (`exports["."]` or `main`). Deliberately **not** "is a plugin": the only
 *   thing that decides whether a package is mounted as a loader row is the
 *   profile's own composition, and `dsh.manifestVersion` is optional metadata
 *   the host does not validate — treating it as a plugin marker would publish a
 *   predicate that is simply false for real plugins (all five EDA packages lack
 *   it and all five are real rows).
 */

/**
 * Discover packages behind a list of patterns, reading each one's real name.
 *
 * Names come from the manifests rather than from directory names because a
 * directory name is not a package name (`packages/schematic` holds
 * `@deepseek-ai/dsh-plugin-eda-sch`), and linking by the wrong key would produce
 * a probe that silently tests nothing.
 *
 * @param {string[]} patterns
 * @returns {{ packages: DiscoveredPackage[], unmatched: string[] }}
 */
export function discoverPackages(patterns) {
  /** @type {DiscoveredPackage[]} */
  const packages = []
  /** @type {string[]} */
  const unmatched = []
  const seen = new Set()
  for (const pattern of patterns) {
    const dirs = expandPackagePattern(pattern).filter((entry) => existsSync(entry))
    if (dirs.length === 0) unmatched.push(pattern)
    for (const dir of dirs) {
      let manifest
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      if (typeof manifest?.name !== 'string' || manifest.name === '') continue
      const absolute = resolve(dir)
      if (seen.has(manifest.name)) continue
      seen.add(manifest.name)
      packages.push({
        name: manifest.name,
        dir: absolute,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        hasEntry:
          (manifest.exports !== null &&
            typeof manifest.exports === 'object' &&
            manifest.exports['.'] !== undefined) ||
          typeof manifest.main === 'string',
      })
    }
  }
  packages.sort((left, right) => left.name.localeCompare(right.name))
  return { packages, unmatched }
}

/**
 * A loader-row id derived from a package name (`@scope/dsh-plugin-a` →
 * `scope-dsh-plugin-a`). Only used for diagnostics, but a stable derivation
 * keeps probe output diffable.
 *
 * @param {string} name
 * @returns {string}
 */
export function rowId(name) {
  return name.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-')
}

/**
 * @typedef {object} DeniedRow
 * @property {string} label the id (or name) the runtime named
 * @property {string} reason the runtime's own explanation
 * @property {string | undefined} packageName the offending package, parsed out of
 *   `reason`. Needed because a row id is chosen by whoever wrote the patch that
 *   inserted it — a bundle may mount `@scope/dsh-plugin-a` as `optional-a` — so
 *   matching a caller's `expectActive` on the label alone would silently miss the
 *   very denial they asked to watch.
 */

/**
 * @typedef {object} InactiveRow
 * @property {string} rowId the loader row id the runtime named
 * @property {string} packageName the package behind that row
 * @property {string} detail the runtime's own first line of explanation
 */

/**
 * Parse the runtime's startup diagnostics out of combined output.
 *
 * Attribution matters as much as detection here: the aggregate line only says
 * *how many* plugins stayed inactive, and on a CI runner the difference between
 * "my plugin failed to load" and "a host-only plugin is platform-bound" is the
 * difference between a real bug and an environment fact. The runtime does print
 * the per-row detail (`<rowId> (<packageName>): <detail>` right after the
 * aggregate line), so it is parsed rather than thrown away.
 *
 * @param {string} output
 * @returns {{ denied: DeniedRow[], inactive: InactiveRow[], didNotActivate: boolean, pending: boolean, loadFailure: boolean }}
 */
export function parseStartupDiagnostics(output) {
  /** @type {DeniedRow[]} */
  const denied = []
  for (const match of output.matchAll(/disabling profile plugin (?:row )?("[^"]+"|\S+): (.*)/g)) {
    const reason = match[2].trim()
    denied.push({
      label: match[1].replace(/^"|"$/g, ''),
      reason,
      packageName: reason.match(/Plugin (\S+?)@\S+ is incompatible/)?.[1],
    })
  }

  // `<rowId> (<packageName>): <detail>` — only trusted *after* the aggregate
  // "did not activate" header, so an unrelated line of the same shape elsewhere
  // in the output cannot be mistaken for a startup failure.
  /** @type {InactiveRow[]} */
  const inactive = []
  const headerIndex = output.search(/did not activate|startup failed/)
  if (headerIndex !== -1) {
    const tail = output.slice(headerIndex)
    for (const match of tail.matchAll(/^\s*(\S+) \(([^()\s]+)\): (.*)$/gm)) {
      inactive.push({ rowId: match[1], packageName: match[2], detail: match[3].trim() })
    }
  }

  return {
    denied,
    inactive,
    didNotActivate: /did not activate/.test(output),
    pending: /Plugins waiting for services/.test(output),
    loadFailure: /plugin tree failed to load/.test(output),
  }
}

/**
 * @typedef {object} ProbeResult
 * @property {boolean} ok verdict
 * @property {boolean} spawned the child process actually started
 * @property {Error | undefined} spawnError set when it did not
 * @property {number | null} status exit code
 * @property {DeniedRow[]} denied rows the compatibility preflight disabled
 * @property {DeniedRow[]} unrelatedDenials denials outside `expectActive` (reported, not fatal)
 * @property {boolean} didNotActivate a plugin failed to come up
 * @property {InactiveRow[]} inactive which rows stayed inactive, with reasons
 *   (empty when the runtime did not print them, or when nothing stayed inactive)
 * @property {boolean} pending a row is waiting for an unmet service
 * @property {boolean} loadFailure the loader threw
 * @property {string | undefined} terminal the terminal error code, when one was reported
 * @property {string} output combined stdout + stderr
 * @property {string} homeDir the throwaway home (kept only when `keepHome`)
 * @property {string[]} packageNames packages that were linked in
 * @property {string[]} rowIds rows that were mounted
 * @property {string[]} problems human-readable reasons the verdict is false
 */

/**
 * Boot DSH against a throwaway home and report whether the mounted rows were
 * allowed to load.
 *
 * @param {{
 *   links?: Record<string, string>,
 *   rows?: string[],
 *   extraBundles?: string[],
 *   task?: string,
 *   timeoutMs?: number,
 *   launcher?: string,
 *   env?: Record<string, string | undefined>,
 *   allowCredentials?: boolean,
 *   keepHome?: boolean,
 *   expectActive?: string[],
 *   expectDisabled?: string[],
 * }} [options]
 * @returns {ProbeResult}
 */
export function probeActivation(options = {}) {
  const rows = options.rows ?? []
  const links = { ...(options.links ?? {}) }

  const patch =
    rows.length === 0
      ? undefined
      : `- insert:\n${rows.map((name) => `    - id: ${rowId(name)}\n      name: '${name}'\n`).join('')}`

  const home = createTestHome({
    links,
    // Additive: a probe adds the bundle under test to the base surface rather
    // than replacing it, because the base surface is what makes the home boot at
    // all (see `DEFAULT_TEST_BUNDLES`).
    bundles: [...DEFAULT_TEST_BUNDLES, ...(options.extraBundles ?? [])],
    ...(patch === undefined ? {} : { profilePatch: patch }),
  })

  const base = { ...(options.env ?? process.env) }
  if (options.allowCredentials !== true) {
    for (const key of CREDENTIAL_ENV) delete base[key]
  }

  const launcher = options.launcher ?? resolveLauncher(options.env ?? process.env)
  const timeout = options.timeoutMs ?? 120_000
  const args = testHomeArgs(home, { task: options.task ?? 'ping' })

  let status = null
  /** @type {Error | undefined} */
  let spawnError
  let output = ''
  let spawned = false
  try {
    const result = spawnSync(process.execPath, [launcher, ...args], {
      env: testHomeEnv(home.homeDir, base),
      encoding: 'utf8',
      timeout,
    })
    status = result.status
    spawnError = result.error ?? undefined
    spawned = result.error === undefined
    output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  } finally {
    if (options.keepHome !== true) home.cleanup()
  }

  const diagnostics = parseStartupDiagnostics(output)
  const terminalMatch = output.match(/"code":"([A-Z_]+)"/)
  const terminal = terminalMatch?.[1]

  /** @type {string[]} */
  const problems = []
  /** @type {DeniedRow[]} */
  const unrelatedDenials = []
  if (!spawned) {
    problems.push(`launcher 未能启动（${spawnError?.code ?? 'unknown'}）：${spawnError?.message ?? ''}`)
  } else {
    const expectDisabled = new Set()
    for (const name of options.expectDisabled ?? []) {
      // Accept both spellings for the same reason `expectActive` does: the runtime
      // labels a row by the id its patch chose, so a caller who names the package
      // must still be understood.
      expectDisabled.add(name)
      expectDisabled.add(rowId(name))
    }
    const deniedIds = new Set(diagnostics.denied.map((entry) => entry.label))
    // `expectActive` scopes the verdict to the caller's own rows, the same way
    // `focusPackages` scopes the static gate: a probe run in a shared home must
    // not fail because some *other* package is incompatible.
    const underTest = new Set()
    for (const name of options.expectActive ?? []) {
      underTest.add(name)
      underTest.add(rowId(name))
    }
    for (const entry of diagnostics.denied) {
      // An expected denial is the probe demonstrating it can detect one.
      const expected =
        expectDisabled.has(entry.label) ||
        (entry.packageName !== undefined && expectDisabled.has(entry.packageName))
      if (expected) continue
      const matched =
        underTest.has(entry.label) ||
        (entry.packageName !== undefined && underTest.has(entry.packageName))
      if (underTest.size > 0 && !matched) {
        unrelatedDenials.push(entry)
        continue
      }
      problems.push(`运行时禁用了行 "${entry.label}"${entry.packageName === undefined ? '' : `（${entry.packageName}）`}：${entry.reason}`)
    }
    for (const name of expectDisabled) {
      if (!deniedIds.has(name) && !deniedIds.has(rowId(name))) {
        problems.push(`预期行 "${name}" 会被禁用，但运行时没有禁用 —— 探针可能没有真正挂载它`)
      }
    }
    // `did not activate` is a *corroborating* signal, not an independent one: a
    // denied row is also a row that did not activate. Reporting it unconditionally
    // double-counts every denial and makes `expectDisabled` unusable (the probe
    // could never agree that an expected denial is fine). It is therefore only
    // news when nothing was denied — i.e. a plugin failed to start for some
    // reason the compatibility preflight does not explain.
    if (diagnostics.didNotActivate && diagnostics.denied.length === 0) {
      // Name them. "1 plugin did not activate" is not actionable on a runner:
      // the reader cannot tell the plugin under test from a host-only row that
      // is simply not built for this platform.
      const who =
        diagnostics.inactive.length === 0
          ? ''
          : ` —— ${diagnostics.inactive.map((entry) => `${entry.packageName}（row ${entry.rowId}）`).join('、')}`
      problems.push(`有插件 did not activate（启动失败），且没有任何行因兼容性被禁用${who}`)
    }
    if (diagnostics.pending) problems.push('有插件在等待未满足的服务（pending）')
    if (diagnostics.loadFailure) problems.push('plugin tree failed to load')
    if (terminal === undefined && problems.length === 0) {
      problems.push('未观察到终止错误码 —— 无法证明启动已经越过预检（预期 MISSING_CREDENTIAL）')
    }
  }

  return {
    ok: problems.length === 0,
    spawned,
    spawnError,
    status,
    denied: diagnostics.denied,
    unrelatedDenials,
    didNotActivate: diagnostics.didNotActivate,
    inactive: diagnostics.inactive,
    pending: diagnostics.pending,
    loadFailure: diagnostics.loadFailure,
    terminal,
    output,
    homeDir: home.homeDir,
    packageNames: Object.keys(links),
    rowIds: rows.map(rowId),
    problems,
  }
}
