#!/usr/bin/env node
/**
 * CLI for the T12 peer / version contract pass.
 *
 * Usage: dsh-plugin-version-check <packageDir...> --host <node_modules> [options]
 *
 * Exit codes: 0 pass · 1 findings · 2 usage error.
 *
 * @module dsh-plugin-conformance/cli-version
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkPeerContract, readExemptions, readHostVersions } from './peer.mjs'
import { titleOf } from './rules.mjs'

const USAGE = `用法: dsh-plugin-version-check <packageDir...> --host <node_modules 目录> [选项]

  --host <dir>         DSH 宿主的 node_modules 根（其下含 @deepseek-ai/）— 必填
  --exemptions <file>  profile 的 compatibility.json（默认从 $DSH_HOME 推断）
  --json               以 JSON 输出
  --strict             把 warn 也视为失败
  -h, --help           显示本帮助

本轮实现 T12（版本 / peer 契约，规则码 DSH-C060…C065）。
规则依据: docs/contract-v1.md §6`

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
const hostDir = valueOf('--host')
const exemptionsPath =
  valueOf('--exemptions') ??
  (process.env.DSH_HOME !== undefined
    ? resolve(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop', 'compatibility.json')
    : undefined)

const consumed = new Set(['--host', '--exemptions'])
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

if (dirs.length === 0 || hostDir === undefined) {
  console.log(USAGE)
  if (hostDir === undefined) console.log('\n✗ 缺少 --host')
  process.exit(2)
}

const absoluteHost = resolve(hostDir)
if (!existsSync(absoluteHost) || !statSync(absoluteHost).isDirectory()) {
  console.log(`✗ --host 不是目录：${absoluteHost}`)
  process.exit(2)
}

const hostVersions = readHostVersions(absoluteHost)
const exemptions = exemptionsPath !== undefined ? readExemptions(exemptionsPath) : {}

if (!json) {
  const coreCount = Object.keys(hostVersions).length
  console.log(`宿主：${absoluteHost}`)
  console.log(`  @deepseek-ai/* 已安装包：${coreCount} 个`)
  console.log(`  豁免文件：${exemptionsPath ?? '（未指定）'}（${Object.keys(exemptions).length} 条）`)
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
  const findings = checkPeerContract(absolute, { hostVersions, exemptions, exemptionsPath })
  results.push({ packageDir: absolute, findings })
  if (findings.some((f) => f.severity === 'error' || (strict && f.severity === 'warn'))) failed = true
}

if (json) {
  console.log(JSON.stringify({ ok: !failed, host: absoluteHost, exemptionsPath: exemptionsPath ?? null, results }, null, 2))
} else {
  for (const { packageDir, findings } of results) {
    console.log(`\n${packageDir}`)
    if (findings.length === 0) {
      console.log('  ✓ 通过（T12 版本与 peer 契约）')
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
