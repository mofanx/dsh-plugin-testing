#!/usr/bin/env node
/**
 * T16 CLI — run the runtime activation probe from a shell or CI.
 *
 * ```sh
 * dsh-plugin-activate \
 *   --packages "D:/projects/my-plugins/packages/*" \
 *   --bundle @my-scope/dsh-plugin-my-bundle \
 *   --expect-active @my-scope/dsh-plugin-my-bundle
 * ```
 *
 * Exit codes deliberately mirror `dsh-plugin-conformance`, so one CI job can run
 * both lanes and read the same contract:
 *
 * | code | meaning |
 * |---|---|
 * | `0` | every row under test was allowed to load |
 * | `1` | the runtime denied / failed to start a row under test |
 * | `2` | usage error, or no package matched (a probe that checks nothing must never be green) |
 *
 * @module dsh-plugin-testkit/activate-cli
 */

import { discoverPackages, probeActivation, resolveLauncher } from './activate.mjs'

const USAGE = `用法：dsh-plugin-activate --packages <glob> [选项]

  --packages <glob>          被测包目录，尾随 /* 展开为每个含 package.json 的子目录（可重复）
  --mount <包名>             作为 loader 行挂载（可重复）
  --bundle <包名>            追加到 profile 的 bundles（可重复）
  --expect-active <包名>     只把这些行的禁用判为失败；其余禁用仅报告（可重复）
  --expect-disabled <包名>   断言这些行**必须**被禁用 —— 用于自证探针能检出（可重复）
  --task <文本>              发给 DSH 的极简任务，默认 ping
  --timeout <毫秒>           启动超时，默认 120000
  --launcher <路径>          覆盖 DSH launcher（默认 DSH_BIN 或打包安装）
  --allow-credentials        不清理凭据环境变量（默认清理，探针不调用真实模型）
  --keep-home                保留一次性 home 以便排查
  --json                     输出机器可读结果
  --help                     显示本帮助

退出码：0 通过 / 1 有行被禁用或启动失败 / 2 用法错误或没有匹配到任何包
`

/**
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string[]>, bools: Set<string> } | { error: string }}
 */
function parseArgs(argv) {
  /** @type {Record<string, string[]>} */
  const flags = {}
  const bools = new Set()
  const VALUE_FLAGS = new Set([
    '--packages',
    '--mount',
    '--bundle',
    '--expect-active',
    '--expect-disabled',
    '--task',
    '--timeout',
    '--launcher',
  ])
  const BOOL_FLAGS = new Set(['--allow-credentials', '--keep-home', '--json', '--help'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (BOOL_FLAGS.has(token)) {
      bools.add(token)
      continue
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${token} 需要一个值` }
      ;(flags[token] ??= []).push(value)
      index += 1
      continue
    }
    return { error: `未知参数：${token}` }
  }
  return { flags, bools }
}

/**
 * @param {import('./activate.mjs').ProbeResult} result
 * @param {{ packages: import('./activate.mjs').DiscoveredPackage[], launcher: string }} context
 */
function report(result, context) {
  const lines = []
  lines.push('DSH 插件运行时激活探针')
  lines.push(`  launcher    : ${context.launcher}`)
  lines.push(`  被测包      : ${context.packages.length} 个`)
  for (const pkg of context.packages) {
    lines.push(`      - ${pkg.name}@${pkg.version}${pkg.hasEntry ? '' : '（无可导入入口）'}`)
  }
  lines.push(`  挂载行      : ${result.rowIds.length === 0 ? '（无 —— 仅 profile 自身组合）' : result.rowIds.join(', ')}`)
  lines.push('')

  if (!result.spawned) {
    lines.push(`环境无法运行探针：${result.problems.join('；')}`)
    return lines.join('\n')
  }

  if (result.denied.length > 0) {
    lines.push('运行时禁用的行：')
    for (const entry of result.denied) lines.push(`  ✗ ${entry.label}：${entry.reason}`)
  } else {
    lines.push('运行时禁用的行：无')
  }
  if (result.unrelatedDenials.length > 0) {
    lines.push(`（另有 ${result.unrelatedDenials.length} 条非关注行的禁用，未计入判定）`)
  }
  lines.push(`终止状态    : ${result.terminal ?? '（未观察到）'}`)
  lines.push(
    `启动诊断    : didNotActivate=${result.didNotActivate} pending=${result.pending} loadFailure=${result.loadFailure}`,
  )
  // Attribution, not just the count: on a CI runner "1 plugin did not activate"
  // is unactionable until you know whether it was the plugin under test or a
  // host row that this platform simply cannot build.
  if (result.inactive.length > 0) {
    lines.push('未激活的行  :')
    for (const entry of result.inactive) {
      lines.push(`  ✗ ${entry.packageName}（row ${entry.rowId}）：${entry.detail}`)
    }
  }
  lines.push('')
  if (result.ok) {
    lines.push('结论：通过 —— 关注的行均未被运行时禁用，且启动已越过兼容性预检')
  } else {
    lines.push('结论：失败')
    for (const problem of result.problems) lines.push(`  - ${problem}`)
  }
  return lines.join('\n')
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`)
    return 2
  }
  const { flags, bools } = parsed
  if (bools.has('--help')) {
    process.stdout.write(USAGE)
    return 0
  }

  const patterns = flags['--packages'] ?? []
  if (patterns.length === 0) {
    process.stderr.write(`未声明 --packages\n\n${USAGE}`)
    return 2
  }

  const { packages, unmatched } = discoverPackages(patterns)
  // A probe over an empty set would "pass" while checking nothing — the same
  // silent-green failure the static gate closed with DSH-C070/C071.
  if (packages.length === 0) {
    process.stderr.write(`没有匹配到任何包：${patterns.join(', ')}\n`)
    return 2
  }
  if (unmatched.length > 0) {
    process.stderr.write(`警告：以下模式未匹配到任何包：${unmatched.join(', ')}\n`)
  }

  /** @type {Record<string, string>} */
  const links = {}
  for (const pkg of packages) links[pkg.name] = pkg.dir

  const launcher = flags['--launcher']?.[0] ?? resolveLauncher()
  const timeoutRaw = flags['--timeout']?.[0]
  const timeoutMs = timeoutRaw === undefined ? 120_000 : Number(timeoutRaw)
  if (timeoutRaw !== undefined && !Number.isFinite(timeoutMs)) {
    process.stderr.write(`--timeout 需要是数字：${timeoutRaw}\n`)
    return 2
  }

  const result = probeActivation({
    links,
    rows: flags['--mount'] ?? [],
    extraBundles: flags['--bundle'] ?? [],
    expectActive: flags['--expect-active'] ?? [],
    expectDisabled: flags['--expect-disabled'] ?? [],
    ...(flags['--task']?.[0] === undefined ? {} : { task: flags['--task'][0] }),
    timeoutMs,
    launcher,
    allowCredentials: bools.has('--allow-credentials'),
    keepHome: bools.has('--keep-home'),
  })

  if (bools.has('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          spawned: result.spawned,
          status: result.status,
          terminal: result.terminal,
          denied: result.denied,
          unrelatedDenials: result.unrelatedDenials,
          didNotActivate: result.didNotActivate,
          inactive: result.inactive,
          pending: result.pending,
          loadFailure: result.loadFailure,
          problems: result.problems,
          packages: packages.map((pkg) => ({ name: pkg.name, version: pkg.version, hasEntry: pkg.hasEntry })),
          rowIds: result.rowIds,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(`${report(result, { packages, launcher })}\n`)
  }

  if (!result.spawned) return 2
  return result.ok ? 0 : 1
}

process.exitCode = main()
