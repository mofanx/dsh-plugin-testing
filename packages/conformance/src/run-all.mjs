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
import { checkPeerContract, readExemptions, readHostVersions } from './peer.mjs'
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

/** @param {string | undefined} value */
function existingDir(value) {
  if (value === undefined) return null
  const absolute = resolve(value)
  return existsSync(absolute) ? absolute : null
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
 * Run every static pass over the declared targets.
 *
 * @param {ConformanceConfig} config
 * @returns {{
 *   ok: boolean,
 *   hostNodeModules: string | null,
 *   exemptionsPath: string | null,
 *   packageDirs: string[],
 *   profileDirs: string[],
 *   mountedPackageCount: number | null,
 *   results: { target: string, kind: 'package' | 'profile', findings: import('./manifest.mjs').Finding[] }[],
 * }}
 */
export function runAll(config) {
  const hostNodeModules = existingDir(config.hostNodeModules)
  const dshHome = existingDir(config.dshHome)
  const packageDirs = asStringList(config.packages).flatMap(expandPattern).filter((dir) => existsSync(dir))
  const profileDirs = asStringList(config.profiles).flatMap(expandPattern).filter((dir) => existsSync(dir))

  // Exemptions belong to a profile; the first declared profile is the one the
  // plugins are judged against unless the config names a file explicitly.
  const exemptionsPath =
    existingDir(config.exemptionsPath) ??
    (profileDirs[0] !== undefined && existsSync(join(profileDirs[0], 'compatibility.json'))
      ? join(profileDirs[0], 'compatibility.json')
      : config.exemptionsPath !== undefined
        ? resolve(config.exemptionsPath)
        : null)

  const hostVersions = hostNodeModules !== null ? readHostVersions(hostNodeModules) : {}
  const exemptions = exemptionsPath !== null ? readExemptions(exemptionsPath) : {}
  const appDir = existingDir(config.appDir) ?? (hostNodeModules !== null ? dirname(hostNodeModules) : null)

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

  /** @type {{ target: string, kind: 'package' | 'profile', findings: import('./manifest.mjs').Finding[] }[]} */
  const results = []
  for (const directory of packageDirs) {
    results.push({
      target: directory,
      kind: 'package',
      findings: [
        ...checkManifest(directory),
        ...checkPeerContract(directory, { hostVersions, exemptions, exemptionsPath, mountedNames }),
      ],
    })
  }
  for (const directory of profileDirs) {
    results.push({
      target: directory,
      kind: 'profile',
      findings: checkComposition(directory, { hostNodeModules, homeDir: dshHome, appDir }),
    })
  }

  const ok = results.every((result) => result.findings.every((finding) => finding.severity !== 'error'))
  return {
    ok,
    hostNodeModules,
    exemptionsPath,
    packageDirs,
    profileDirs,
    mountedPackageCount: mountedNames === null ? null : mountedNames.size,
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
      const entry = byCode.get(finding.code) ?? { code: finding.code, severity: finding.severity, count: 0 }
      entry.count += 1
      byCode.set(finding.code, entry)
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

这是 T13 的单一门禁命令，依次运行 T10（清单/exports）、T11（组合装载）、T12（版本/peer）。
规则依据: dsh-plugin-contract-v1.md §6`

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
  const { byCode, errors, warns } = summarize(outcome.results)
  const failed = errors > 0 || (args.strict && warns > 0)

  if (args.json) {
    console.log(
      JSON.stringify(
        { ok: !failed, strict: args.strict, errors, warns, hostNodeModules: outcome.hostNodeModules, exemptionsPath: outcome.exemptionsPath, results: outcome.results },
        null,
        2,
      ),
    )
  } else {
    console.log('DSH 插件一致性门禁')
    console.log(`  配置        : ${existsSync(configPath) ? configPath : '（未找到，使用命令行/环境变量）'}`)
    console.log(`  宿主        : ${outcome.hostNodeModules ?? '（未指定）'}`)
    console.log(`  豁免        : ${outcome.exemptionsPath ?? '（未指定）'}`)
    console.log(`  插件包      : ${outcome.packageDirs.length} 个`)
    console.log(`  profile     : ${outcome.profileDirs.length} 个`)
    console.log(
      `  挂载行      : ${
        outcome.mountedPackageCount === null
          ? '（未提供 profile —— peer 按保守口径全部按"被挂载"判定）'
          : `${outcome.mountedPackageCount} 个包被挂载为行`
      }`,
    )

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

    console.log(`\n汇总：${errors} error / ${warns} warn → ${failed ? '失败' : '通过'}`)
  }

  process.exit(failed ? 1 : 0)
}
