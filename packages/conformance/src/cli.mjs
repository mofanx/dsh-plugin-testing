#!/usr/bin/env node
/**
 * CLI for the DSH plugin conformance checker.
 *
 * Usage: dsh-plugin-conformance <packageDir...> [--json] [--strict]
 *
 * Exit codes: 0 pass · 1 findings · 2 usage error.
 *
 * @module dsh-plugin-conformance/cli
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkManifest } from './manifest.mjs'
import { titleOf } from './rules.mjs'

const USAGE = `用法: dsh-plugin-conformance <packageDir...> [--json] [--strict]

  --json      以 JSON 输出（供 CI 消费）
  --strict    把 warn 也视为失败
  -h, --help  显示本帮助

本轮实现 T10（清单 + exports，规则码 DSH-C001…C044）。
规则依据: docs/contract-v1.md §6`

const argv = process.argv.slice(2)

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}

const json = argv.includes('--json')
const strict = argv.includes('--strict')
const dirs = argv.filter((arg) => !arg.startsWith('-'))

if (dirs.length === 0) {
  console.log(USAGE)
  process.exit(2)
}

/** @type {{ packageDir: string, findings: import('./manifest.mjs').Finding[] }[]} */
const results = []
let failed = false

for (const dir of dirs) {
  const absolute = resolve(dir)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    results.push({
      packageDir: absolute,
      findings: [{ code: 'DSH-C000', severity: 'error', message: `不是目录：${absolute}` }],
    })
    failed = true
    continue
  }
  const findings = checkManifest(absolute)
  results.push({ packageDir: absolute, findings })
  if (findings.some((f) => f.severity === 'error' || (strict && f.severity === 'warn'))) failed = true
}

if (json) {
  console.log(JSON.stringify({ ok: !failed, results }, null, 2))
} else {
  for (const { packageDir, findings } of results) {
    console.log(`\n${packageDir}`)
    if (findings.length === 0) {
      console.log('  ✓ 通过（T10 清单与 exports 规则）')
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
