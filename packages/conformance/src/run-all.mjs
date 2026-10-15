/**
 * T13 — the single gate command.
 *
 * Runs every static pass over a declared target set and returns one verdict.
 * This is what CI invokes; the three passes stay individually runnable so a
 * developer can iterate on one of them without the others.
 *
 * Config file (`conformance.config.json`):
 * ```json
 * {
 *   "hostNodeModules": "D:/Program Files/DSH NEXT/resources/app/node_modules",
 *   "dshHome": "C:/Users/<user>/.dsh",
 *   "packages": ["D:/projects/my-plugins/packages/*"],
 *   "profiles": ["C:/Users/<user>/.dsh/profiles/desktop"]
 * }
 * ```
 * A trailing `/*` expands to every subdirectory that holds a `package.json`.
 *
 * @module dsh-plugin-conformance/run-all
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkManifest } from './manifest.mjs'
import { checkPeerContract, readExemptions, readHostVersions, resolveDshVersion } from './peer.mjs'
import { checkComposition, collectMountedPackageNames } from './composition.mjs'
import { severityOf, titleOf } from './rules.mjs'

/**
 * @typedef {object} ConformanceConfig
 * @property {string} [hostNodeModules]
 * @property {string} [dshHome]
 * @property {string} [appDir]
 * @property {string} [exemptionsPath]
 * @property {string[]} [packages]
 * @property {string[]} [profiles]
 */

/**
 * @typedef {object} ResolvedPath
 * @property {string | null} path resolved absolute path, or `null` if unusable
 * @property {boolean} configured the config/env actually named this path
 * @property {boolean} missing it was named but does not exist on disk
 * @property {string | undefined} raw the value as declared, for diagnostics
 */

/**
 * Resolve an optional configured path.
 *
 * Deliberately distinguishes "not configured" from "configured but absent".
 * Collapsing the two was a silent-green bug: a typo in `hostNodeModules` turned
 * the host version into `undefined`, which made the peer pass skip every
 * runtime-graded rule (DSH-C060/C061/C064/C066) and report a clean gate.
 *
 * @param {string | undefined} value
 * @returns {ResolvedPath}
 */
function resolveConfiguredPath(value) {
  if (value === undefined) return { path: null, configured: false, missing: false, raw: undefined }
  const absolute = resolve(value)
  const present = existsSync(absolute)
  return { path: present ? absolute : null, configured: true, missing: !present, raw: value }
}

/**
 * @param {string} filePath
 * @returns {ConformanceConfig}
 */
export function loadConfig(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Expand one target pattern. A trailing `/*` means "every subdirectory that
 * holds a package.json"; anything else is a literal path.
 *
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandPattern(pattern) {
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
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/**
 * Expand a whole declared target list, reporting which patterns matched nothing.
 *
 * The `unmatched` half exists because an empty expansion used to be
 * indistinguishable from success: `results.every(...)` is vacuously true over an
 * empty list, so a config whose paths had drifted reported `ok` and exit 0
 * while checking zero packages.
 *
 * @param {string[]} patterns
 * @returns {{ dirs: string[], unmatched: string[] }}
 */
export function expandTargets(patterns) {
  /** @type {string[]} */
  const dirs = []
  /** @type {string[]} */
  const unmatched = []
  for (const pattern of asStringList(patterns)) {
    const expanded = expandPattern(pattern).filter((entry) => existsSync(entry))
    if (expanded.length === 0) unmatched.push(pattern)
    dirs.push(...expanded)
  }
  return { dirs, unmatched }
}

/**
 * Resolve which `compatibility.json` the run should judge against.
 *
 * An explicitly configured file wins and is graded as-is (including "named but
 * absent" → DSH-C070). Otherwise the first declared profile's own copy is used
 * when it exists.
 *
 * @param {ConformanceConfig} config
 * @param {string[]} profileDirs
 * @returns {ResolvedPath}
 */
function resolveExemptionsPath(config, profileDirs) {
  if (config.exemptionsPath !== undefined) return resolveConfiguredPath(config.exemptionsPath)
  const fromProfile = profileDirs[0] !== undefined ? join(profileDirs[0], 'compatibility.json') : undefined
  if (fromProfile === undefined || !existsSync(fromProfile)) {
    return { path: null, configured: false, missing: false, raw: undefined }
  }
  return { path: fromProfile, configured: true, missing: false, raw: fromProfile }
}

/**
 * Build a package-name matcher from `focusPackages`.
 *
 * `*` matches any run of characters, which is the shape a scope-wide pattern
 * takes (`@deepseek-ai/dsh-plugin-eda-*`). An absent or junk value coerces to
 * "no focus", matching how `packages` / `profiles` treat junk input.
 *
 * @param {string[]} patterns
 * @returns {((name: string) => boolean) | null}
 */
function resolveFocus(patterns) {
  if (patterns.length === 0) return null
  const regexes = patterns.map((pattern) => {
    const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return new RegExp(`^${escaped.join('.*')}$`)
  })
  return (name) => regexes.some((regex) => regex.test(name))
}

/**
 * Run every static pass over the declared targets.
 *
 * @param {ConformanceConfig} config
 * @returns {{
 *   ok: boolean,
 *   hostNodeModules: string | null,
 *   exemptionsPath: string | null,
 *   packageDirs: string[],
 *   profileDirs: string[],
 *   unmatchedPatterns: string[],
 *   targetCount: number,
 *   mountedPackageCount: number | null,
 *   focusPatterns: string[],
 *   filteredByFocus: number,
 *   results: { target: string, kind: 'package' | 'profile' | 'config', findings: import('./manifest.mjs').Finding[] }[],
 * }}
 */
export function runAll(config) {
  const host = resolveConfiguredPath(config.hostNodeModules)
  const home = resolveConfiguredPath(config.dshHome)
  const app = resolveConfiguredPath(config.appDir)
  const hostNodeModules = host.path
  const dshHome = home.path

  const packageTargets = expandTargets(asStringList(config.packages))
  const profileTargets = expandTargets(asStringList(config.profiles))
  const packageDirs = packageTargets.dirs
  const profileDirs = profileTargets.dirs
  const exemptions = resolveExemptionsPath(config, profileDirs)
  const exemptionsPath = exemptions.path

  // --- T13: the gate's own configuration is itself checked ----------------
  // Everything here is an error, never a warn: each one silently removes
  // coverage, and a gate that quietly checks less is worse than no gate.
  /** @type {import('./manifest.mjs').Finding[]} */
  const configFindings = []
  for (const [label, resolved] of /** @type {[string, ResolvedPath][]} */ ([
    ['hostNodeModules', host],
    ['dshHome', home],
    ['appDir', app],
    ['exemptionsPath', exemptions],
  ])) {
    if (!resolved.missing) continue
    configFindings.push({
      code: 'DSH-C070',
      severity: severityOf('DSH-C070'),
      message: `配置声明的 ${label} 不存在：${resolve(String(resolved.raw))} —— 依赖它的检查无法求值，不能当作"未配置"静默跳过`,
    })
  }
  for (const [label, unmatched] of [
    ['packages', packageTargets.unmatched],
    ['profiles', profileTargets.unmatched],
  ]) {
    for (const pattern of unmatched) {
      configFindings.push({
        code: 'DSH-C071',
        severity: severityOf('DSH-C071'),
        message: `配置的 ${label} 模式未匹配到任何目标：${pattern}（路径写错会使该门禁静默空转）`,
      })
    }
  }

  const hostVersions = hostNodeModules !== null ? readHostVersions(hostNodeModules) : {}
  const dshRuntimeVersion = resolveDshVersion(hostVersions)
  const exemptionEntries = exemptionsPath !== null ? readExemptions(exemptionsPath) : {}
  const appDir = app.path ?? (hostNodeModules !== null ? dirname(hostNodeModules) : null)

  // `focusPackages` narrows profile-level *reporting* to the author's own
  // packages. Filtered findings are counted so the run can state how many it
  // withheld: a gate that quietly checks less is worse than no gate, and the
  // same holds for a gate that quietly reports less.
  const focusPatterns = asStringList(config.focusPackages)
  const focus = resolveFocus(focusPatterns)
  /** @type {{ filteredByFocus: number }} */
  const focusStats = { filteredByFocus: 0 }

  // T15 — grade peers by whether the package is actually mounted as a loader
  // row. The union across every declared profile is used: being mounted in any
  // one of them is what makes an out-of-range peer blocking. `null` means "no
  // profile info", and the peer pass then keeps its conservative default.
  /** @type {Set<string> | null} */
  const mountedNames =
    profileDirs.length === 0
      ? null
      : new Set(
          profileDirs.flatMap((directory) => [
            ...collectMountedPackageNames(directory, { hostNodeModules, homeDir: dshHome, appDir }),
          ]),
        )

  /** @type {{ target: string, kind: 'package' | 'profile' | 'config', findings: import('./manifest.mjs').Finding[] }[]} */
  const results = []
  if (configFindings.length > 0) {
    results.push({ target: '(门禁配置)', kind: 'config', findings: configFindings })
  }
  for (const directory of packageDirs) {
    // T10 runs first; when the manifest itself cannot be read, its single
    // DSH-C000 is the whole story. Running the peer pass anyway would emit a
    // second, identical DSH-C000 for the same one-line cause and double-count
    // it in the summary.
    const manifestFindings = checkManifest(directory, { dshRuntimeVersion })
    const unreadable = manifestFindings.some((finding) => finding.code === 'DSH-C000')
    results.push({
      target: directory,
      kind: 'package',
      findings: unreadable
        ? manifestFindings
        : [
            ...manifestFindings,
            ...checkPeerContract(directory, {
              hostVersions,
              exemptions: exemptionEntries,
              exemptionsPath,
              mountedNames,
            }),
          ],
    })
  }
  for (const directory of profileDirs) {
    results.push({
      target: directory,
      kind: 'profile',
      findings: checkComposition(directory, {
        hostNodeModules,
        homeDir: dshHome,
        appDir,
        focus,
        stats: focusStats,
      }),
    })
  }

  // `targetCount > 0` is part of the invariant, not a separate concern: over an
  // empty result list `every()` is vacuously true, so without it `ok === true`
  // would mean "nothing failed" rather than "everything passed". With it,
  // `ok === true` guarantees at least one target was actually checked. A run
  // whose only results are config findings is therefore never `ok`.
  const ok =
    packageDirs.length + profileDirs.length > 0 &&
    results.every((result) => result.findings.every((finding) => finding.severity !== 'error'))
  return {
    ok,
    hostNodeModules,
    exemptionsPath,
    packageDirs,
    profileDirs,
    unmatchedPatterns: [...packageTargets.unmatched, ...profileTargets.unmatched],
    targetCount: packageDirs.length + profileDirs.length,
    mountedPackageCount: mountedNames === null ? null : mountedNames.size,
    focusPatterns,
    filteredByFocus: focusStats.filteredByFocus,
    results,
  }
}

/**
 * Aggregate findings for the summary view.
 * @param {{ findings: import('./manifest.mjs').Finding[] }[]} results
 */
export function summarize(results) {
  /** @type {Map<string, { code: string, severity: string, count: number }>} */
  const byCode = new Map()
  for (const result of results) {
    for (const finding of result.findings) {
      // Keyed by code *and* severity: the same code can legitimately appear at
      // two severities in one run (DSH-C060 is an error for an unexempted plugin
      // and a warning for an exempted one), and collapsing them under whichever
      // severity was seen first would misreport both the count and the level.
      const mapKey = `${finding.code}|${finding.severity}`
      const entry = byCode.get(mapKey) ?? { code: finding.code, severity: finding.severity, count: 0 }
      entry.count += 1
      byCode.set(mapKey, entry)
    }
  }
  const errors = [...byCode.values()].filter((entry) => entry.severity === 'error').reduce((sum, entry) => sum + entry.count, 0)
  const warns = [...byCode.values()].filter((entry) => entry.severity === 'warn').reduce((sum, entry) => sum + entry.count, 0)
  return { byCode, errors, warns }
}

/** @param {string[]} argv */
function parseArgv(argv) {
  /** @param {string} flag */
  const valueOf = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const consumed = new Set()
  for (const flag of ['--config', '--host', '--home', '--exemptions']) {
    const index = argv.indexOf(flag)
    if (index !== -1) consumed.add(index).add(index + 1)
  }
  const files = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (consumed.has(index)) continue
    if (arg.startsWith('-')) continue
    files.push(arg)
  }
  return {
    configPath: valueOf('--config'),
    host: valueOf('--host'),
    home: valueOf('--home'),
    exemptions: valueOf('--exemptions'),
    files,
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    help: argv.includes('-h') || argv.includes('--help'),
  }
}

const USAGE = `用法: dsh-plugin-conformance-all [选项] [额外的插件包目录...]

  --config <file>      配置文件（默认 ./conformance.config.json）
  --host <dir>         宿主 node_modules（覆盖配置）
  --home <dir>         DSH_HOME（覆盖配置）
  --exemptions <file>  compatibility.json（覆盖配置）
  --json               以 JSON 输出
  --strict             把 warn 也视为失败
  -h, --help           显示本帮助

环境变量回退：DSH_HOST_NODE_MODULES、DSH_HOME。

这是 T13 的单一门禁命令，依次运行 T10（清单/exports）、T11（组合装载）、T12（版本/peer），
并检查门禁自身配置（T13）：配置显式声明的路径不存在 → DSH-C070；目标模式未匹配到任何目标
→ DSH-C071。

退出码：0 通过；1 有 error（--strict 下 warn 也算）；2 用法错误 / 没有检查目标
（含 packages+profiles 全部落空 —— 门禁没查任何东西时不会报"通过"）。

规则依据: docs/contract-v1.md §6`

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const args = parseArgv(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    process.exit(0)
  }

  const configPath = resolve(args.configPath ?? 'conformance.config.json')
  const fileConfig = existsSync(configPath) ? loadConfig(configPath) : {}
  /** @type {ConformanceConfig} */
  const config = {
    ...fileConfig,
    hostNodeModules: args.host ?? fileConfig.hostNodeModules ?? process.env.DSH_HOST_NODE_MODULES,
    dshHome: args.home ?? fileConfig.dshHome ?? process.env.DSH_HOME,
    ...(args.exemptions === undefined ? {} : { exemptionsPath: args.exemptions }),
    packages: [...asStringList(fileConfig.packages), ...args.files],
  }

  if (config.packages.length === 0 && asStringList(fileConfig.profiles).length === 0) {
    console.log(USAGE)
    console.log(`\n✗ 没有要检查的目标（配置：${existsSync(configPath) ? configPath : '未找到'}）`)
    process.exit(2)
  }

  const outcome = runAll(config)

  // A declared pattern set that expands to zero targets is a usage error, not a
  // pass. Exit 2 keeps the documented contract ("用法错误 / 无检查目标") and makes
  // a drifted path impossible to mistake for a clean gate.
  if (outcome.targetCount === 0) {
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            noTargets: true,
            unmatchedPatterns: outcome.unmatchedPatterns,
            configPath: existsSync(configPath) ? configPath : null,
            results: outcome.results,
          },
          null,
          2,
        ),
      )
    } else {
      console.log(USAGE)
      console.log(`\n✗ 没有要检查的目标：配置的模式一个都没匹配到（配置：${existsSync(configPath) ? configPath : '未找到'}）`)
      for (const pattern of outcome.unmatchedPatterns) console.log(`    · 未匹配：${pattern}`)
      console.log('  门禁未检查任何东西，因此不作为"通过"。')
    }
    process.exit(2)
  }

  const { byCode, errors, warns } = summarize(outcome.results)
  const failed = errors > 0 || (args.strict && warns > 0)

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: !failed,
          strict: args.strict,
          errors,
          warns,
          hostNodeModules: outcome.hostNodeModules,
          exemptionsPath: outcome.exemptionsPath,
          targetCount: outcome.targetCount,
          unmatchedPatterns: outcome.unmatchedPatterns,
          focusPatterns: outcome.focusPatterns,
          filteredByFocus: outcome.filteredByFocus,
          results: outcome.results,
        },
        null,
        2,
      ),
    )
  } else {
    console.log('DSH 插件一致性门禁')
    /** @param {string | null} resolved @param {string | undefined} declared @param {string} fallback */
    const pathLine = (resolved, declared, fallback) =>
      resolved ?? (declared !== undefined ? `✗ ${declared}（不存在，见 DSH-C070）` : fallback)
    console.log(`  配置        : ${existsSync(configPath) ? configPath : '（未找到，使用命令行/环境变量）'}`)
    console.log(`  宿主        : ${pathLine(outcome.hostNodeModules, config.hostNodeModules, '（未指定）')}`)
    console.log(`  豁免        : ${pathLine(outcome.exemptionsPath, config.exemptionsPath, '（未指定）')}`)
    console.log(`  插件包      : ${outcome.packageDirs.length} 个`)
    console.log(`  profile     : ${outcome.profileDirs.length} 个`)
    console.log(
      `  挂载行      : ${
        outcome.mountedPackageCount === null
          ? '（未提供 profile —— peer 按保守口径全部按"被挂载"判定）'
          : `${outcome.mountedPackageCount} 个包被挂载为行`
      }`,
    )
    if (outcome.focusPatterns.length > 0) {
      console.log(`  关注范围    : ${outcome.focusPatterns.join(', ')}（仅影响 profile 级发现的报告范围）`)
    }
    if (outcome.unmatchedPatterns.length > 0) {
      console.log(`  未匹配模式  : ${outcome.unmatchedPatterns.length} 个（详见下方 DSH-C071）`)
      for (const pattern of outcome.unmatchedPatterns) console.log(`      · ${pattern}`)
    }

    if (byCode.size > 0) {
      console.log('\n按规则汇总：')
      for (const entry of [...byCode.values()].sort((a, b) => b.count - a.count)) {
        const mark = entry.severity === 'error' ? '✗' : '!'
        console.log(`  ${mark} ${entry.code}  ${titleOf(entry.code)}  ×${entry.count}`)
      }
      console.log('\n明细：')
      for (const result of outcome.results) {
        if (result.findings.length === 0) continue
        console.log(`  ${result.target}`)
        for (const finding of result.findings) {
          const mark = finding.severity === 'error' ? '✗' : '!'
          console.log(`    ${mark} ${finding.code}  ${finding.message}`)
        }
      }
    }

    if (outcome.filteredByFocus > 0) {
      console.log(`\n已按关注范围过滤：${outcome.filteredByFocus} 条非关注包的 profile 级依赖发现（未计入上述汇总）`)
      console.log(`汇总：${errors} error / ${warns} warn → ${failed ? '失败' : '通过'}`)
    } else {
      console.log(`\n汇总：${errors} error / ${warns} warn → ${failed ? '失败' : '通过'}`)
    }
  }

  process.exit(failed ? 1 : 0)
}
