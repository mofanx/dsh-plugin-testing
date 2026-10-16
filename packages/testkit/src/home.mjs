/**
 * T03 — hermetic DSH homes for real-composition testing.
 *
 * ## Why a throwaway home instead of a new checked-in profile
 *
 * A common host-integration convention already runs
 * `dsh --profile headless --patch <repo>/cordis.patch.yml ...`. That mechanism
 * is right and is kept. What it lacks is **isolation**:
 *
 * - it runs against the developer's real `$DSH_HOME`, so the stock `headless`
 *   profile and any home-level `cordis.patch.yml` leak into every run;
 * - the run **writes** into that home (verified: a bare `--dump-config` created
 *   2 files), so tests are not read-only;
 * - a real `compatibility.json` would silently *authorize* an incompatible
 *   plugin, hiding a rejection the test exists to catch.
 *
 * This module materialises a throwaway home per test instead.
 *
 * ## Why it needs no `node_modules`
 *
 * The launcher computes an immutable **runtime resolution** from the
 * installation's dependency graph and installs it into Node's ESM/CJS
 * resolvers (`@deepseek-ai/dsh-app-boot` README, "挂载 profile 条目前…").
 * Bundles therefore resolve from the DSH installation, not from the profile.
 * Verified empirically: a home containing nothing but
 * `profiles/test/package.json` booted and produced a full `--dump-config`.
 *
 * @module dsh-plugin-testkit/home
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Resolve a test-support package to its directory.
 *
 * Test-support packages (`dsh-llm-replay`, `dsh-session-snapshot`) are not part
 * of the DSH installation, so unlike the base bundles they must be present in
 * the profile. The testkit declares them as its own dependencies and links its
 * installed copies into each test home — pinned once, no per-test install.
 *
 * **But a pinned copy only works against one host line.** Both packages are
 * published in lockstep with DSH and narrow their peers to **exact** versions
 * (`"@deepseek-ai/dsh-llm": "0.2.0-rc.2"`), so running the pinned copy against a
 * different host makes the host's own preflight disable it — the replay lane
 * then fails for a reason that has nothing to do with the code under test.
 *
 * Resolution therefore prefers a copy that ships **with the host under test**
 * (`$DSH_HOST_NODE_MODULES`), and falls back to this package's own pinned copy.
 * A caller who installs the host-matched version alongside the host gets the
 * replay lane on any line; a caller who does not gets the pinned line, and the
 * affected cases report the mismatch explicitly instead of failing obscurely
 * (see `replay.spec.mjs`).
 *
 * @param {string} name
 * @returns {string}
 */
export function resolveInstalledPackage(name) {
  const host = process.env.DSH_HOST_NODE_MODULES
  if (host !== undefined && host !== '') {
    const candidate = join(host, name, 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
  }
  return dirname(require.resolve(`${name}/package.json`))
}

/**
 * Bundles of the `test` profile, derived from the stock `headless` profile
 * (`$DSH_HOME/profiles/headless/package.json`). Deliberately minimal: base plus
 * a headless surface, nothing product-visible.
 */
export const DEFAULT_TEST_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])

/**
 * @typedef {object} TestHome
 * @property {string} homeDir      pass as `DSH_HOME`
 * @property {string} profileDir   the profile directory itself
 * @property {string} profileName  pass as `--profile`
 * @property {() => void} cleanup  removes the whole home
 */

/**
 * Create a throwaway DSH home holding one test profile.
 *
 * Intentionally **not** created, so tests stay deterministic and honest:
 * - `compatibility.json` — a test home must never silently authorize a plugin
 *   the host would otherwise reject;
 * - a home-level `cordis.patch.yml` — the user's tweaks must not reach a test;
 * - `node_modules` — bundles resolve from the installation (see module docs).
 *
 * @param {{
 *   bundles?: string[],
 *   profileName?: string,
 *   profilePatch?: string,
 *   root?: string,
 *   extraFiles?: Record<string, string>,
 *   packages?: string[],
 *   links?: Record<string, string>,
 * }} [options]
 * @returns {TestHome}
 */
export function createTestHome(options = {}) {
  const bundles = options.bundles ?? [...DEFAULT_TEST_BUNDLES]
  const profileName = options.profileName ?? 'test'
  const homeDir = options.root ?? mkdtempSync(join(tmpdir(), 'dsh-test-home-'))
  const profileDir = join(homeDir, 'profiles', profileName)
  mkdirSync(profileDir, { recursive: true })

  // Link packages into the profile, and declare them with `link:` so the
  // launcher treats them as profile-installed plugins — the same convention the
  // real desktop profile uses for its `link:` packages.
  //
  // `packages` resolves from this package's own dependencies (pinned once, no
  // per-test install); `links` maps a package name to an arbitrary directory,
  // for the plugin under test.
  /** @type {Record<string, string>} */
  const links = { ...(options.links ?? {}) }
  for (const name of options.packages ?? []) links[name] = resolveInstalledPackage(name)

  /** @type {Record<string, string>} */
  const dependencies = {}
  for (const [name, source] of Object.entries(links)) {
    const target = join(profileDir, 'node_modules', ...name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, 'junction')
    dependencies[name] = `link:${source}`
  }

  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profileName}`,
        private: true,
        dependencies,
        dsh: { profile: { bundles } },
      },
      null,
      2,
    )}\n`,
  )

  if (options.profilePatch !== undefined) {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), options.profilePatch)
  }

  for (const [relative, contents] of Object.entries(options.extraFiles ?? {})) {
    const target = join(profileDir, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }

  return {
    homeDir,
    profileDir,
    profileName,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  }
}

/**
 * Environment overrides that pin a child DSH process to `homeDir`.
 *
 * Pure — it does not read `process.env` — so a caller decides what to inherit:
 * `testHomeEnv(home.homeDir, process.env)`.
 *
 * @param {string} homeDir
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function testHomeEnv(homeDir, base = {}) {
  return { ...base, DSH_HOME: homeDir }
}

/**
 * With-key lane: an isolated home has no `~/.dsh/.credentials.yaml`, so the key
 * must be injected through the environment.
 *
 * Verified failure mode without it — the run gets all the way through session
 * setup and starts streaming `--json` events, then fails at the first model
 * call:
 * ```
 * {"type":"turn_end","reason":{"kind":"error","error":{
 *   "message":"llm-deepseek: no API key for provider route \"deepseek-official\"…
 *   "code":"MISSING_CREDENTIAL"}}}
 * ```
 * That is the *correct* behaviour for isolation: a test home must never inherit
 * the developer's real credentials by accident. The keyless lane should instead
 * wire a mock provider or the keyless replay lane (see the testing guide);
 * this helper is for the nightly with-key lane only.
 *
 * @param {string} homeDir
 * @param {string} apiKey
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function withKeyEnv(homeDir, apiKey, base = {}) {
  return { ...base, DSH_HOME: homeDir, DEEPSEEK_API_KEY: apiKey }
}

/**
 * The argument vector for a headless run against a test home. `patches` are
 * passed in order and mount the plugins under test from source, matching the
 * team's established host-integration convention.
 *
 * @param {TestHome} home
 * @param {{ patches?: string[], task?: string, extraArgs?: string[] }} [options]
 * @returns {string[]}
 */
export function testHomeArgs(home, options = {}) {
  const args = ['--profile', home.profileName]
  for (const patch of options.patches ?? []) args.push('--patch', patch)
  args.push('--json')
  args.push(...(options.extraArgs ?? []))
  args.push(options.task ?? '')
  return args
}
