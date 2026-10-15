#!/usr/bin/env node
/**
 * CLI for the T11 profile composition pass.
 *
 * Usage: dsh-plugin-composition-check <profileDir> --host <node_modules> [options]
 *
 * Exit codes: 0 pass · 1 findings · 2 usage error.
 *
 * @module dsh-plugin-conformance/cli-composition
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkComposition } from './composition.mjs'
import { titleOf } from './rules.mjs'

const USAGE = `用法: dsh-plugin-composition-check <profileDir> [选项]

  --host <dir>   DSH 宿主的 node_modules 根（其下含 @deepseek-ai/）
  --home <dir>   DSH_HOME（用于读取 $DSH_HOME/cordis.patch.yml 这一层）
  --json         以 JSON 输出
  --strict       把 warn 也视为失败
  -h, --help     显示本帮助

本轮实现 T11（组合装载静态分析，规则码 DSH-C050…C055）。
规则依据: dsh-plugin-contract-v1.md §6`

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}

/** @param {string} flag */
function valueOf(flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

const json = argv.includes('--json')
const strict = argv.includes('--strict')
const hostNodeModules = valueOf('--host') ?? process.env.DSH_HOST_NODE_MODULES
const homeDir = valueOf('--home') ?? process.env.DSH_HOME

const consumed = new Set(['--host', '--home'])
const dirs = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (consumed.has(arg)) {
    index += 1
    continue
  }
  if (arg.startsWith('-')) continue
  dirs.push(arg)
}

if (dirs.length === 0) {
  console.log(USAGE)
  process.exit(2)
}

const resolvedHost = hostNodeModules !== undefined && existsSync(resolve(hostNodeModules)) ? resolve(hostNodeModules) : null
const resolvedHome = homeDir !== undefined && existsSync(resolve(homeDir)) ? resolve(homeDir) : null

if (!json) {
  console.log(`宿主 node_modules：${resolvedHost ?? '（未指定 —— 核心包名回退到内置种子清单）'}`)
  console.log(`DSH_HOME：${resolvedHome ?? '（未指定 —— 跳过 home patch 层）'}`)
}

/** @type {{ profileDir: string, findings: import('./manifest.mjs').Finding[] }[]} */
const results = []
let failed = false

for (const dir of dirs) {
  const absolute = resolve(dir)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    results.push({ profileDir: absolute, findings: [{ code: 'DSH-C000', severity: 'error', message: `不是目录：${absolute}` }] })
    failed = true
    continue
  }
  const findings = checkComposition(absolute, { hostNodeModules: resolvedHost, homeDir: resolvedHome })
  results.push({ profileDir: absolute, findings })
  if (findings.some((f) => f.severity === 'error' || (strict && f.severity === 'warn'))) failed = true
}

if (json) {
  console.log(JSON.stringify({ ok: !failed, hostNodeModules: resolvedHost, homeDir: resolvedHome, results }, null, 2))
} else {
  for (const { profileDir, findings } of results) {
    console.log(`\n${profileDir}`)
    if (findings.length === 0) {
      console.log('  ✓ 通过（T11 组合装载规则）')
      continue
    }
    for (const item of findings) {
      const mark = item.severity === 'error' ? '✗' : '!'
      console.log(`  ${mark} ${item.code}  ${titleOf(item.code)}`)
      console.log(`      ${item.message}`)
    }
    const errors = findings.filter((f) => f.severity === 'error').length
    console.log(`  → ${errors} error / ${findings.length - errors} warn`)
  }
}

process.exit(failed ? 1 : 0)
