/**
 * T16 prototype, generalized for any plugin repo: scan built output (`.js`)
 * for `@deepseek-ai/*` module usage and cross-check the named imports against
 * the host's real export surface (`api-baseline.json`, produced by
 * `dsh-plugin-api --host <安装目录> --write`).
 *
 * Usage:
 *   node scripts/check-plugin-imports.mjs <root> [moreRoots...]
 *        [--baseline ./api-baseline.json] [--own <regex>]
 *
 * `--own` declares a regex of package names that belong to the scanned repo
 * itself (they share the `@deepseek-ai/` scope but are not host packages, so
 * they must not count as gaps). Without it, every specifier missing from the
 * baseline is a genuine gap — the right default for a team plugin.
 *
 * Exit codes: 0 = no genuine gaps, 1 = gaps found, 2 = usage error.
 *
 * Boundary: this reads static import specifiers. It does NOT prove anything
 * about `ctx.llm.*` / `ctx.tools.*` runtime property access, which is a
 * different surface than module exports and needs a real boot (composition
 * test) to exercise.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { argv, exit } from 'node:process'

/** @param {string} flag */
function valueOf(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const positional = argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--baseline' && all[i - 1] !== '--own')
const baselinePath = valueOf('--baseline') ?? './api-baseline.json'
const ownRe = valueOf('--own') ? new RegExp(valueOf('--own')) : null

if (positional.length === 0 || !existsSync(baselinePath)) {
  console.error('用法: node check-plugin-imports.mjs <root> [moreRoots...] [--baseline ./api-baseline.json] [--own <regex>]')
  exit(2)
}
const BASELINE = JSON.parse(readFileSync(baselinePath, 'utf8'))

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const SPEC_RE = /(?:from|import|require)\s*\(?\s*["'](@deepseek-ai\/[^"']+)["']/g
const NAMED_RE = /import\s*\{([^}]*)\}\s*from\s*["'](@deepseek-ai\/[^"']+)["']/g

/** @type {Map<string, Set<string>>} */
const used = new Map()

for (const root of positional) {
  for (const file of walk(resolve(root))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SPEC_RE)) used.set(match[1], used.get(match[1]) ?? new Set())
    for (const match of text.matchAll(NAMED_RE)) {
      const set = used.get(match[2]) ?? new Set()
      for (const part of match[1].split(',')) {
        const name = (part.includes(' as ') ? part.split(' as ')[0] : part).trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) set.add(name)
      }
      used.set(match[2], set)
    }
  }
}

if (used.size === 0) {
  console.error('未扫描到任何 @deepseek-ai/* 导入 —— 检查 root 路径是否指向构建产物（lib/*.js）')
  exit(2)
}

console.log('=== 被扫仓库对 @deepseek-ai/* 的模块依赖 ===\n')
let genuineGaps = 0

for (const spec of [...used.keys()].sort()) {
  const [scope, name, ...rest] = spec.split('/')
  const pkgName = `${scope}/${name}`
  const subpath = rest.length === 0 ? '.' : `./${rest.join('/')}`
  const names = [...(used.get(spec) ?? [])].sort()

  const entry = BASELINE.packages[pkgName]
  // Classify by fact, not by name shape: a package is "host" iff it is in the
  // host's installed tree. Scoped look-alikes are only "own" when --own says so.
  const isHost = entry !== undefined
  const isOwn = ownRe !== null && ownRe.test(pkgName)
  const tag = isHost ? '[host]' : isOwn ? '[own]' : '[未解析]'

  if (!isHost) {
    console.log(`${tag} ${spec}`)
    if (!isOwn) {
      genuineGaps += 1
      console.log('        <-- 既不在宿主安装树中，也不是 --own 声明的自有包：真实缺口')
    }
    continue
  }

  const subOk = entry.subpaths.includes(subpath)
  const exported = entry.symbols[subpath] ?? []
  // When the subpath itself is missing there are no symbols to compare against,
  // so counting every named import as "not exported" would inflate one gap into
  // 1 + N. Report the subpath gap once and move on.
  const bad = subOk ? names.filter((n) => !exported.includes(n)) : []
  if (!subOk) genuineGaps += 1
  genuineGaps += bad.length

  console.log(`${tag} ${spec}${subOk ? '' : '   <-- 子路径在宿主中不存在'}`)
  if (subOk && names.length > 0) {
    console.log(`        具名导入 ${names.length} 个: ${names.join(', ')}`)
    if (bad.length > 0) console.log(`        x 宿主未导出: ${bad.join(', ')}`)
  } else if (!subOk && names.length > 0) {
    console.log(`        具名导入 ${names.length} 个（子路径缺失，未逐一核对符号）: ${names.join(', ')}`)
  }
}

console.log('')
console.log(`真实缺口（子路径或符号）: ${genuineGaps}`)
console.log(genuineGaps === 0 ? '=> 静态看：被扫仓库用到的宿主模块 API 在宿主上齐备' : '=> 静态看：存在缺口')
console.log('')
console.log('注意：本扫描仅覆盖模块导出。ctx.llm / ctx.tools 等运行时属性访问不在此范围内，')
console.log('      需由真实启动（组合测试）验证补齐。')
exit(genuineGaps === 0 ? 0 : 1)
