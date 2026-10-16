#!/usr/bin/env node
/**
 * T64 CLI — snapshot or check the host platform API surface.
 *
 *   dsh-plugin-api --write                 # write/refresh the baseline
 *   dsh-plugin-api                         # check against the baseline
 *   dsh-plugin-api --json                  # machine-readable report
 *
 * Exit codes: 0 = no breaking change, 1 = breaking change, 2 = usage error.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectApiSurface, diffApiSurface } from './api-surface.mjs'
import { resolveDshVersion } from './peer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG = join(HERE, '..', 'conformance.config.json')
const DEFAULT_BASELINE = join(HERE, '..', 'api-baseline.json')

function usage(code) {
  const out = code === 0 ? console.log : console.error
  out(`用法: dsh-plugin-api [--host <node_modules>] [--baseline <file>] [--write] [--json]

  --host <dir>       宿主 node_modules（默认取 conformance.config.json 的 hostNodeModules）
  --baseline <file>  基线文件（默认 api-baseline.json）
  --write            采集当前 API 面并写入基线
  --json             以 JSON 输出报告
  -h, --help         显示帮助

退出码: 0 无破坏性变更 / 1 检出破坏性变更 / 2 用法错误`)
  process.exit(code)
}

const argv = process.argv.slice(2)
/** @type {{host?: string, baseline?: string, write: boolean, json: boolean}} */
const opts = { write: false, json: false }
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '-h' || arg === '--help') usage(0)
  else if (arg === '--host') opts.host = argv[++i]
  else if (arg === '--baseline') opts.baseline = argv[++i]
  else if (arg === '--write') opts.write = true
  else if (arg === '--json') opts.json = true
  else usage(2)
}

if (opts.host === undefined && existsSync(DEFAULT_CONFIG)) {
  try {
    opts.host = JSON.parse(readFileSync(DEFAULT_CONFIG, 'utf8')).hostNodeModules
  } catch {
    /* fall through to the usage error below */
  }
}
if (opts.host === undefined) {
  console.error('错误: 未指定 --host，且无法从 conformance.config.json 读取 hostNodeModules')
  usage(2)
}
if (!existsSync(opts.host)) {
  console.error(`错误: 宿主 node_modules 目录不存在: ${opts.host}`)
  usage(2)
}

const baselinePath = resolve(opts.baseline ?? DEFAULT_BASELINE)
const host = resolve(opts.host)
const current = collectApiSurface(host)
const count = Object.keys(current.packages).length

if (opts.write) {
  // Record which DSH version this surface belongs to. Without it the artifact is
  // not self-describing and a consumer has to infer the version from the file
  // name — the same "provenance must travel with the data" rule as the
  // candidate-version list.
  const hostVersion = resolveDshVersion(
    Object.fromEntries(Object.entries(current.packages).map(([name, pkg]) => [name, pkg.version])),
  )
  writeFileSync(baselinePath, `${JSON.stringify({ hostVersion, ...current }, null, 2)}\n`)
  console.log(`已写入 API 基线: ${baselinePath}`)
  console.log(`  宿主: ${host}`)
  console.log(`  宿主版本: ${hostVersion ?? '（无法确定）'}`)
  console.log(`  包数: ${count}`)
  process.exit(0)
}

if (!existsSync(baselinePath)) {
  console.error(`错误: 基线不存在: ${baselinePath}`)
  console.error('先运行 dsh-plugin-api --write 生成基线。')
  process.exit(2)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const diff = diffApiSurface(baseline, current)

if (opts.json) {
  console.log(JSON.stringify({ host, baseline: baselinePath, packageCount: count, ...diff }, null, 2))
  process.exit(diff.breaking ? 1 : 0)
}

console.log(`宿主: ${host}`)
console.log(`基线: ${baselinePath}`)
console.log(`包数: ${count}`)
console.log('')

if (diff.entries.length === 0) {
  console.log('✅ 平台 API 面无变更')
  process.exit(0)
}

for (const entry of diff.entries) {
  const marks = []
  if (entry.kind === 'removedPackage') marks.push('包被移除')
  if (entry.versionChanged) marks.push(entry.versionChanged)
  console.log(`● ${entry.name}${marks.length > 0 ? `  (${marks.join('; ')})` : ''}`)
  for (const s of entry.removedSubpaths ?? []) console.log(`    ✖ 子路径消失  ${s}`)
  for (const s of entry.removedSymbols ?? []) console.log(`    ✖ 符号消失    ${s}`)
  for (const s of entry.addedSubpaths ?? []) console.log(`    ＋ 新增子路径  ${s}`)
  for (const s of entry.addedSymbols ?? []) console.log(`    ＋ 新增符号    ${s}`)
}

console.log('')
if (diff.breaking) {
  // Count what actually broke, not how many packages have *any* entry. Reporting
  // `entries.length` here overstated the alarm badly in practice: a real
  // rc.2 -> alpha.1 run gave 289 "受影响" packages of which only 40 had a
  // removed subpath or symbol — the other 245 were version bumps with an
  // identical surface. An alarm number that is 7x too big trains people to
  // ignore it, which is the failure mode this whole repository exists to stop.
  const breakingEntries = diff.entries.filter(
    (e) => e.kind === 'removedPackage' || (e.removedSubpaths?.length ?? 0) > 0 || (e.removedSymbols?.length ?? 0) > 0,
  )
  const removedPackages = breakingEntries.filter((e) => e.kind === 'removedPackage').length
  const removedSubpaths = breakingEntries.reduce((n, e) => n + (e.removedSubpaths?.length ?? 0), 0)
  const removedSymbols = breakingEntries.reduce((n, e) => n + (e.removedSymbols?.length ?? 0), 0)
  const benign = diff.entries.length - breakingEntries.length
  console.error(
    `❌ 检出破坏性变更：${breakingEntries.length} 个包有移除` +
      `（子路径 ${removedSubpaths} 个、符号 ${removedSymbols} 个` +
      `${removedPackages > 0 ? `、整包移除 ${removedPackages} 个` : ''}）` +
      `；另有 ${benign} 个包仅版本变化或只有新增。`,
  )
  console.error('   插件可能引用了已消失的子路径或符号。')
  process.exit(1)
}
console.log(`✅ 无破坏性变更（${diff.entries.length} 个包有非破坏性变化）`)
process.exit(0)
