#!/usr/bin/env node
/**
 * CLI for the T17 host-version matrix pass.
 *
 * Usage: dsh-plugin-host-matrix <packageDir...> --candidates <file> [options]
 *
 * Answers "兼容哪些宿主版本" by deriving the **claim set** from an explicit list
 * of published host versions — no host install, no boot, no network.
 *
 * Exit codes: 0 pass · 1 findings · 2 usage error.
 *
 * @module dsh-plugin-conformance/cli-host-matrix
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { readSurfaceDir } from './api-usage.mjs'
import { deriveHostMatrix, readCandidateList } from './matrix.mjs'
import { titleOf } from './rules.mjs'

const USAGE = `用法: dsh-plugin-host-matrix <packageDir...> --candidates <候选版本清单.json> [选项]

  --candidates <file>  已发布宿主版本的显式清单（JSON，含 versions 数组）— 必填
  --surfaces <dir>     已记录的宿主 API 面目录（dsh-plugin-api --write 的产物），
                       给出后会把"声明覆盖"与"代码真正 import 的 API"交叉核对
  --json               以 JSON 输出
  --strict             把 warn（安装期分歧）也视为失败
  -h, --help           显示本帮助

本命令推导的是**声明覆盖集**，不是"已验证可用集"：它不安装、不启动任何宿主。
把推导结果当作"实测兼容"是本项目最要防的假绿。

给了 --surfaces 之后结论会更紧一档：覆盖集 ∩ API 可用集。但仍然是静态结论 ——
它只能看见**发布入口里写死的 import**，看不见运行期才用到的服务与动态取用；
且只对"已记录 API 面"的那些版本成立，没记录的版本一律算未知，不算通过。

清单必须显式给出且随仓库提交（不得在检查时联网），否则结论会随上游变化而不随提交变化。
生成方式见 docs/testing-guide.md。

本轮实现 T17（宿主版本矩阵，规则码 DSH-C068，并逐候选复算 DSH-C067）
与 T18（按版本的宿主 API 可用性，规则码 DSH-C069）。
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
const candidatesPath = valueOf('--candidates')
const surfacesPath = valueOf('--surfaces')

const consumed = new Set(['--candidates', '--surfaces'])
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

if (dirs.length === 0 || candidatesPath === undefined) {
  console.log(USAGE)
  if (candidatesPath === undefined) console.log('\n✗ 缺少 --candidates')
  if (dirs.length === 0) console.log('\n✗ 缺少 <packageDir>')
  process.exit(2)
}

const absoluteCandidates = resolve(candidatesPath)
if (!existsSync(absoluteCandidates) || !statSync(absoluteCandidates).isFile()) {
  console.log(`✗ --candidates 不是文件：${absoluteCandidates}`)
  process.exit(2)
}

/** @type {{ source: string | null, generatedAt: string | null, versions: string[], knownGaps: Record<string, string> }} */
let list
try {
  list = readCandidateList(absoluteCandidates)
} catch (error) {
  console.log(`✗ ${error?.message ?? error}`)
  process.exit(2)
}

if (!json) {
  console.log(`候选宿主版本清单：${absoluteCandidates}`)
  console.log(`  版本数：${list.versions.length}（${list.versions[0]} … ${list.versions[list.versions.length - 1]}）`)
  console.log(`  来源：${list.source ?? '（清单未声明 source —— 无法追溯它取自何处，结论可信度受限）'}`)
  if (list.generatedAt !== null) console.log(`  生成时间：${list.generatedAt}`)
  const gapVersions = Object.keys(list.knownGaps)
  if (gapVersions.length > 0) {
    console.log(`  已知不支持（有原因，按 warn 处理）：${gapVersions.join('、')}`)
  }
}

let surfaces
if (surfacesPath !== undefined) {
  const absoluteSurfaces = resolve(surfacesPath)
  try {
    surfaces = readSurfaceDir(absoluteSurfaces)
  } catch (error) {
    console.log(`✗ ${error?.message ?? error}`)
    process.exit(2)
  }
  if (!json) {
    console.log(
      `已记录宿主 API 面：${absoluteSurfaces}（${surfaces.length} 个版本：${surfaces.map((s) => s.hostVersion).join('、')}）`,
    )
    console.log('  覆盖集将再与"代码实际引用的 API"交叉核对（T18）；未记录 API 面的版本一律算未知，不算通过')
  }
}

/** @type {ReturnType<typeof deriveHostMatrix>[]} */
const reports = []
let failed = false
// A path typo / non-package directory is a **usage** mistake, not a finding
// about the plugin — it must not be reported as "your plugin has problems"
// (exit 1) when the truth is "your argument was wrong" (exit 2).
let usageError = false

for (const dir of dirs) {
  const absolute = resolve(dir)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    console.log(`\n✗ 不是目录：${absolute}（检查路径/通配符是否写对）`)
    usageError = true
    continue
  }
  /** @type {ReturnType<typeof deriveHostMatrix>} */
  let report
  try {
    report = deriveHostMatrix(absolute, { candidates: list.versions, knownGaps: list.knownGaps, surfaces })
  } catch (error) {
    console.log(`\n✗ ${absolute}`)
    console.log(`    ${error?.message ?? error}`)
    usageError = true
    continue
  }
  reports.push(report)
  if (report.findings.some((f) => f.severity === 'error' || (strict && f.severity === 'warn'))) failed = true
}

// Nothing was actually checked — that is not a pass. Same principle as C071.
if (reports.length === 0 && !usageError) {
  console.log('\n✗ 没有可检查的目标（所有路径都不是包目录）—— "一个都没查"不等于"通过"')
  usageError = true
}

if (json) {
  console.log(
    JSON.stringify(
      {
        ok: !failed && !usageError,
        candidates: { path: absoluteCandidates, source: list.source, generatedAt: list.generatedAt, versions: list.versions, knownGaps: list.knownGaps },
        reports,
      },
      null,
      2,
    ),
  )
  process.exit(usageError ? 2 : failed ? 1 : 0)
}

if (usageError) process.exit(2)

for (const report of reports) {
  console.log(`\n${report.name}@${report.version ?? '<无版本>'}`)
  console.log(`  ${report.packageDir}`)

  if (!report.hasDshPeers) {
    // Absence of a declaration is not a claim of universal support; say so
    // instead of printing an empty (and therefore unreadable) matrix.
    console.log('  ⚠ 未声明任何 dsh 运行时 peer —— 无可推导的宿主范围（未声明 ≠ 声明支持全部）')
    if (report.apiAvailability !== null && report.apiAvailability !== undefined) {
      console.log('     因此也不做 API 可用性核对：核对范围跟着声明走，没有区间就没有可核对的格子。')
      console.log('     这类包仍会被静态门禁的其余检查覆盖；若它确实 import 了宿主包，请补上 dsh 运行时 peer。')
    }
    continue
  }

  console.log('  dsh 运行时 peer：')
  for (const [dependency, range] of Object.entries(report.peers)) console.log(`    ${dependency} ${range}`)

  console.log('')
  console.log('  宿主版本          运行时接纳  安装期接纳  区间内  说明')
  for (const row of report.rows) {
    const runtime = row.runtimeAdmits ? '✓' : '✗'
    const install = row.installAdmits ? '✓' : '✗'
    const inSpan = row.inSpan ? '✓' : ''
    const note = row.hole ? '空洞（DSH-C068）' : row.divergence ? '安装期分歧（DSH-C067）' : ''
    console.log(`    ${row.version.padEnd(16)}  ${runtime.padEnd(10)}  ${install.padEnd(10)}  ${inSpan.padEnd(6)}  ${note}`)
  }

  console.log('')
  if (report.span === null) {
    console.log('  声明覆盖集：空 —— 候选清单里没有任何版本被接纳')
  } else {
    console.log(`  声明覆盖集：${report.admitted.length} / ${report.rows.length} 个候选版本`)
    console.log(`    区间：[${report.span.min}, ${report.span.max}]`)
    console.log(`    覆盖：${report.admitted.join('、')}`)
    if (report.belowSpan.length > 0) console.log(`    区间之下未覆盖：${report.belowSpan.length} 个`)
    if (report.aboveSpan.length > 0) console.log(`    区间之上未覆盖：${report.aboveSpan.length} 个`)
    const installMissed = report.admitted.filter((v) => !report.installAdmitted.includes(v))
    if (installMissed.length > 0) {
      console.log(`    ⚠ 其中安装期不接纳：${installMissed.join('、')}（运行时放行、npm/pnpm 拒绝）`)
    }
  }

  const api = report.apiAvailability
  if (api !== null && api !== undefined) {
    console.log('')
    console.log(`  代码实际引用的宿主 API（扫描 ${api.files.length} 个发布入口文件${api.truncated ? '，已截断' : ''}）：`)
    if (api.used.length === 0) {
      console.log('    未发现对 @deepseek-ai/* 的直接 import —— 本项无可核对内容（≠ 没有问题）')
    }
    for (const entry of api.used) {
      console.log(`    ${entry.package} [${entry.subpath}]  →  ${entry.symbols.join(', ') || '(未取具名符号)'}`)
    }
    for (const entry of api.unverifiable) {
      console.log(`    ⚠ 未能核验 ${entry.package} [${entry.subpath}]（${entry.reason}）—— 只核验了子路径存在，符号无法比对`)
    }
    if (api.outOfScope.length > 0) {
      console.log(`    （不在任何宿主 API 面内，按插件自有/第三方包跳过：${api.outOfScope.join('、')}）`)
    }

    console.log('')
    console.log(`  覆盖区间内各版本的 API 可用性（已记录 API 面：${api.recordedVersions.join('、')}）：`)
    for (const row of api.rows) {
      if (!row.covered) {
        console.log(`    ${row.version.padEnd(16)}  ？ 未知 —— 未记录该版本的 API 面，无法判断（未知 ≠ 通过）`)
        continue
      }
      const verdict = row.missing.length === 0 ? '✓ 全部存在' : `✗ 缺 ${row.missing.length} 处（DSH-C069）`
      console.log(`    ${row.version.padEnd(16)}  ${verdict}  （核验 ${row.checked} 个子路径）`)
    }
    if (api.uncovered.length > 0) {
      console.log(`    ⚠ 未知版本 ${api.uncovered.length} 个：${api.uncovered.join('、')}`)
      console.log('      想让这些格子有结论，就在对应宿主上跑一次 dsh-plugin-api --write 并提交产物')
    }
  }

  console.log('')
  if (report.findings.length === 0) {
    console.log('  结论：未发现空洞，也无安装期分歧')
  } else {
    for (const item of report.findings) {
      const mark = item.severity === 'error' ? '✗' : '!'
      console.log(`  ${mark} ${item.code}  ${titleOf(item.code)}`)
      console.log(`      ${item.message}`)
    }
  }
  console.log('')
  console.log('  注意：以上是**声明覆盖集**，不是"已验证可用"。标记为已验证需要真的在该版本上运行（探针/测试套件）。')
  if (api !== null && api !== undefined) {
    console.log('        API 可用性一项是**静态**结论：只看发布入口里写死的 import，不看运行期动态取用的服务。')
  }
}

process.exit(failed ? 1 : 0)

