/**
 * T11 — profile composition and loading static analysis.
 *
 * The composition algorithm here is a faithful port of the DSH market's own
 * `dshmarket/lib/check.js` (`composeLayers` / `buildBundleLayers`), which
 * mirrors `@deepseek-ai/dsh-app-boot`'s `applyEntryPatches`. Those internals
 * are not importable (`check.js` is not in `dshmarket`'s `exports`), so the
 * behaviour is reproduced here and pinned by tests.
 *
 * Implements rules DSH-C050…C055 from `dsh-plugin-contract-v1.md` §6.
 *
 * @module dsh-plugin-conformance/composition
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isBuiltin } from 'node:module'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { severityOf } from './rules.mjs'
import { parseVersion } from './semver.mjs'

// --- patch parsing -------------------------------------------------------

/** js-yaml `!!js` scalar, identical to dsh-app-boot's entryListSchema dialect. */
const jsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: String(data) }),
})
const entrySchema = JSON_SCHEMA.extend(jsExpr)

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse an entry-list patch with the DSH dialect.
 * @param {string} text
 * @returns {unknown[] | null} `null` when the text is not an entry list
 */
export function parsePatchText(text) {
  try {
    const value = load(text, { schema: entrySchema })
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * @param {string} path
 * @returns {unknown[] | null}
 */
export function parsePatchFile(path) {
  try {
    return parsePatchText(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// --- composition ---------------------------------------------------------

/** Literal values use Loader Boolean semantics; `!!js` stays indeterminate. */
function disabledState(value) {
  if (isRecord(value) && typeof value.__jsExpr === 'string') return 'conditional'
  return value ? 'disabled' : 'active'
}

function combineDisabled(parent, own) {
  if (parent === 'disabled' || own === 'disabled') return 'disabled'
  if (parent === 'conditional' || own === 'conditional') return 'conditional'
  return 'active'
}

/** Flatten a tree of entries (group configs included) into row records. */
function flattenEntries(nodes) {
  const rows = []
  const walk = (list, inheritedLayer) => {
    for (const node of list) {
      const layer = typeof node.layer === 'string' ? node.layer : inheritedLayer
      if (layer === undefined) continue
      rows.push({ id: node.id, layer, kind: 'insert', name: node.name })
      if (node.group === true && Array.isArray(node.config)) walk(node.config, layer)
    }
  }
  walk(nodes)
  return rows
}

/** Rows whose specifiers the Loader can attempt to import. */
function resolvableEntries(nodes) {
  const rows = []
  const walk = (list, inheritedLayer, parentDisabled = 'active') => {
    for (const node of list) {
      const layer = typeof node.layer === 'string' ? node.layer : inheritedLayer
      if (layer === undefined) continue
      const descendantsDisabled = combineDisabled(parentDisabled, disabledState(node.disabled))
      const activation = node.group === true ? 'required' : descendantsDisabled
      if (activation !== 'disabled') {
        rows.push({
          id: node.id,
          layer,
          kind: 'insert',
          name: node.name,
          activation: activation === 'conditional' ? 'conditional' : 'required',
        })
      }
      if (node.group === true && Array.isArray(node.config)) walk(node.config, layer, descendantsDisabled)
    }
  }
  walk(nodes)
  return rows
}

/**
 * @typedef {object} Layer
 * @property {string} label
 * @property {'bundle' | 'app' | 'user' | 'home'} kind
 * @property {unknown[]} patches
 */

/**
 * Apply the layer stack over an empty root exactly like the DSH boot include.
 *
 * @param {Layer[]} layers
 * @returns {{
 *   rows: { id: string, layer: string, kind: string, name?: string }[],
 *   resolvableRows: { id: string, layer: string, kind: string, name?: string, activation: string }[],
 *   duplicates: { id: string, layers: string[], count: number }[],
 *   overrides: { id: string, layer: string, overriddenLayers: string[] }[],
 *   orphans: { id: string, layer: string, reason: string }[],
 * }}
 */
export function composeLayers(layers) {
  const tree = []
  const orphans = []
  const overrides = []
  /** Mirrors the boot's entryMap: the LAST row registered for an id wins. */
  const entryMap = new Map()
  const buildMap = (nodes) => {
    for (const node of nodes) {
      if (node.id !== '') entryMap.set(node.id, node)
      if (node.group === true && Array.isArray(node.config)) buildMap(node.config)
    }
  }

  for (const layer of layers) {
    for (const patch of layer.patches) {
      if (!isRecord(patch)) continue
      const { id, insert, name, ...overridesOf } = patch
      const hasId = typeof id === 'string' ? id !== '' : Boolean(id)
      const lookupKey = hasId ? String(id) : ''
      if (insert) {
        if (!Array.isArray(insert)) {
          orphans.push({ id: lookupKey === '' ? '(anonymous)' : lookupKey, layer: layer.label, reason: 'insert 不是数组' })
          continue
        }
        const nodes = insert
          .filter(isRecord)
          .map((entry) =>
            typeof entry.id !== 'string'
              ? null
              : {
                  id: entry.id,
                  name: typeof entry.name === 'string' ? entry.name : undefined,
                  layer: layer.label,
                  group: entry.group === true,
                  config: Array.isArray(entry.config) ? entry.config : undefined,
                  disabled: entry.disabled,
                },
          )
          .filter((node) => node !== null)
        if (hasId) {
          const target = entryMap.get(lookupKey)
          if (target === undefined) {
            orphans.push({ id: lookupKey, layer: layer.label, reason: 'insert 目标不存在' })
            continue
          }
          if (target.group !== true) {
            orphans.push({ id: lookupKey, layer: layer.label, reason: 'insert 目标不是 group' })
            continue
          }
          if (!Array.isArray(target.config)) target.config = []
          target.config = [...target.config, ...nodes]
        } else {
          tree.push(...nodes)
        }
        buildMap(nodes)
        continue
      }
      if (!hasId) {
        orphans.push({ id: '(anonymous)', layer: layer.label, reason: '非 insert 的 patch 必须带 id' })
        continue
      }
      const target = entryMap.get(lookupKey)
      if (target === undefined) {
        orphans.push({ id: lookupKey, layer: layer.label, reason: 'patch 目标不存在' })
        continue
      }
      if (name && name !== target.name) {
        orphans.push({
          id: lookupKey,
          layer: layer.label,
          reason: `name 不匹配（期望 ${String(target.name)}，实际 ${String(name)}）`,
        })
        continue
      }
      const priorLayers = []
      for (const node of flattenEntries(tree)) {
        if (node.id === lookupKey && !priorLayers.includes(node.layer)) priorLayers.push(node.layer)
      }
      if (priorLayers.some((prior) => prior !== layer.label)) {
        overrides.push({
          id: lookupKey,
          layer: layer.label,
          overriddenLayers: priorLayers.filter((prior) => prior !== layer.label),
        })
      }
      for (const [key, value] of Object.entries(overridesOf)) {
        if (key === 'id') continue
        target[key] = value
      }
    }
  }

  const rows = flattenEntries(tree)
  const resolvableRows = resolvableEntries(tree)
  const byId = new Map()
  for (const row of rows) {
    const seen = byId.get(row.id) ?? []
    if (!seen.includes(row.layer)) seen.push(row.layer)
    byId.set(row.id, seen)
  }
  const counts = new Map()
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  const duplicates = []
  for (const [id, count] of counts) {
    if (count < 2) continue
    duplicates.push({ id, layers: byId.get(id) ?? [], count })
  }
  duplicates.sort((a, b) => a.id.localeCompare(b.id))
  return { rows, resolvableRows, duplicates, overrides, orphans }
}

// --- host / profile inspection ------------------------------------------

/**
 * The packages that ARE the running harness — the set the host itself loads
 * and the ones whose duplication actually breaks a profile (tool calls die,
 * minimal preset fails to mount). Everything else under the host's
 * `@deepseek-ai/*` surface is a leaf utility whose duplication is real but
 * usually benign, so it is reported as `DSH-C056` (warn) instead of `C050`.
 *
 * This mirrors `dshmarket/lib/check.js`'s curated seed, which is DSH's own
 * definition of what the host is, and doubles as the fallback inventory when
 * the install directory cannot be located.
 */
const RUNTIME_CORE_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/cordis-plugin-group',
]

/** @type {Set<string>} */
const RUNTIME_CORE_SET = new Set(RUNTIME_CORE_PACKAGES)

/**
 * Host core package names. The install's own `node_modules` is authoritative;
 * the curated seed only covers an unlocatable install.
 *
 * @param {string | null} hostNodeModules
 * @returns {Set<string>}
 */
export function collectCorePackageNames(hostNodeModules) {
  const names = new Set(RUNTIME_CORE_PACKAGES)
  if (hostNodeModules === null) return names
  try {
    for (const entry of readdirSync(join(hostNodeModules, '@deepseek-ai'), { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (/^(?:dsh|cordis)/.test(entry.name)) names.add(`@deepseek-ai/${entry.name}`)
    }
  } catch {
    // Unreadable install — the curated seed stands.
  }
  return names
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Resolve a package directory by walking `node_modules` up from `anchor`. */
function resolvePackageDir(anchorDir, name) {
  let directory = resolve(anchorDir)
  while (true) {
    const candidate = join(directory, 'node_modules', name)
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'package.json'))) return candidate
    } catch {
      // keep walking
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/** Top-level installed package names (incl. scoped), excluding pnpm internals. */
function installedPackageNames(profileDir) {
  const names = []
  const isPkgDir = (entry) => entry.isDirectory() || entry.isSymbolicLink()
  let root
  try {
    root = readdirSync(join(profileDir, 'node_modules'), { withFileTypes: true })
      .filter((entry) => isPkgDir(entry) && !entry.name.startsWith('.') && entry.name !== '.bin')
      .map((entry) => entry.name)
  } catch {
    return names
  }
  for (const name of root) {
    if (!name.startsWith('@')) {
      names.push(name)
      continue
    }
    try {
      for (const scoped of readdirSync(join(profileDir, 'node_modules', name), { withFileTypes: true })) {
        if (isPkgDir(scoped)) names.push(`${name}/${scoped.name}`)
      }
    } catch {
      // empty scope dir
    }
  }
  return names
}

/** Whether `name` resolves from the Loader-visible profile ancestry. */
function profilePackageInstalled(profileDir, name) {
  const manifest = readJson(join(profileDir, 'package.json'))
  if (isRecord(manifest) && manifest.name === name && manifest.exports !== undefined && manifest.exports !== null) {
    return true
  }
  return resolvePackageDir(profileDir, name) !== null
}

/** Whether `name` goes through the Loader's bare-module resolver. */
function isBareLoaderSpecifier(name) {
  return (
    !name.startsWith('.') && !name.startsWith('#') && !isAbsolute(name) && !/^[a-z][a-z\d+.-]*:/i.test(name)
  )
}

/** Npm package root owning one bare Loader specifier. */
function packageRoot(specifier) {
  const parts = specifier.split('/')
  const segments = specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
  if (segments.length !== (specifier.startsWith('@') ? 2 : 1)) return null
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('%') || segment.includes('\\'))) {
    return null
  }
  if (specifier.startsWith('@') && (segments[0]?.length ?? 0) <= 1) return null
  return segments.join('/')
}

/** Distinct versions of `@deepseek-ai/{dsh,cordis}*` packages in the lockfile. */
function lockfileCoreVersions(profileDir) {
  const found = new Map()
  let text
  try {
    text = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
  } catch {
    return new Map()
  }
  for (const match of text.matchAll(/(@deepseek-ai\/(?:dsh|cordis)[^@\s'"]*?)@([0-9][^\s:'"()]*)/g)) {
    const name = match[1] ?? ''
    const version = match[2] ?? ''
    if (parseVersion(version) === null) continue
    const versions = found.get(name) ?? new Set()
    versions.add(version)
    found.set(name, versions)
  }
  const out = new Map()
  for (const [name, versions] of found) out.set(name, [...versions])
  return out
}

/** Whether the host install itself ships `name`. */
function hostProvided(hostNodeModules, name) {
  return hostNodeModules !== null && existsSync(join(hostNodeModules, name, 'package.json'))
}

/** @param {string} code @param {string} message */
function finding(code, message) {
  return { code, severity: severityOf(code), message }
}

/**
 * Build the full layer stack for a profile, in boot order:
 * bundle layers → `<app>/cordis.patch.yml` → profile patch → home patch.
 *
 * Extracted so the peer pass (T15) can ask "which packages are actually
 * mounted as rows?" using the same composition the boot performs, instead of
 * a second, drifting reimplementation.
 *
 * @param {string} profileDir
 * @param {string[]} bundleNames
 * @param {{ hostNodeModules?: string | null, homeDir?: string | null, appDir?: string | null }} options
 * @param {import('./manifest.mjs').Finding[]} findings
 * @returns {{ layers: Layer[], bundleInfo: { name: string, order?: { before?: string[], after?: string[] } }[] }}
 */
function buildLayerStack(profileDir, bundleNames, options, findings) {
  const hostNodeModules = options.hostNodeModules ?? null
  /** @type {Layer[]} */
  const layers = []
  /** @type {{ name: string, order?: { before?: string[], after?: string[] } }[]} */
  const bundleInfo = []
  for (const name of bundleNames) {
    const directory = resolvePackageDir(profileDir, name) ?? (hostNodeModules !== null ? resolvePackageDir(hostNodeModules, name) : null)
    if (directory === null) {
      findings.push(finding('DSH-C053', `bundle ${name} 未安装，无法解析其 patch`))
      bundleInfo.push({ name })
      continue
    }
    const manifest = readJson(join(directory, 'package.json'))
    const declared = manifest?.dsh?.bundle?.patch
    const list = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter((item) => typeof item === 'string') : []
    const patches = []
    for (const relative of list) {
      const parsed = parsePatchFile(join(directory, relative))
      if (parsed !== null) patches.push(...parsed)
    }
    layers.push({ label: name, kind: 'bundle', patches })

    const order = manifest?.dsh?.bundle?.order
    /** @type {{ before?: string[], after?: string[] }} */
    const constraints = {}
    if (isRecord(order)) {
      const listOf = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : undefined)
      const before = listOf(order.before)
      const after = listOf(order.after)
      if (before !== undefined) constraints.before = before
      if (after !== undefined) constraints.after = after
    }
    bundleInfo.push({ name, ...(Object.keys(constraints).length > 0 ? { order: constraints } : {}) })
  }

  // The Desktop shell ships its own patch at the application root
  // (`<app>/cordis.patch.yml`), applied AFTER every bundle and BEFORE the
  // profile patch. Omitting this layer makes every profile patch that targets
  // a shell-inserted id (e.g. `computer-use-cua-driver-native`) look like an
  // orphan, so it is part of the composition model, not an extra.
  const appDir = options.appDir ?? (hostNodeModules !== null ? dirname(hostNodeModules) : null)
  if (appDir !== null) {
    const appPatchPath = join(appDir, 'cordis.patch.yml')
    if (existsSync(appPatchPath)) {
      const patches = parsePatchFile(appPatchPath)
      if (patches === null) findings.push(finding('DSH-C053', `${appPatchPath} 不是合法的 entry list`))
      layers.push({ label: 'app-patch', kind: 'app', patches: patches ?? [] })
    }
  }

  const userPatchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(userPatchPath)) {
    const patches = parsePatchFile(userPatchPath)
    if (patches === null) findings.push(finding('DSH-C053', `${userPatchPath} 不是合法的 entry list`))
    layers.push({ label: 'user-patch', kind: 'user', patches: patches ?? [] })
  }
  if (options.homeDir) {
    const homePatchPath = join(options.homeDir, 'cordis.patch.yml')
    if (existsSync(homePatchPath)) {
      const patches = parsePatchFile(homePatchPath)
      if (patches === null) findings.push(finding('DSH-C053', `${homePatchPath} 不是合法的 entry list`))
      layers.push({ label: 'home-patch', kind: 'home', patches: patches ?? [] })
    }
  }

  return { layers, bundleInfo }
}

/**
 * T15 — the set of package names a profile actually mounts as loader rows.
 *
 * The runtime's version preflight only evaluates `peerDependencies` of rows it
 * would import; a *support* package that is merely a dependency is never
 * mounted, so its out-of-range peer cannot block anything. Callers use this to
 * grade `DSH-C060` correctly (in the real incident that motivated this rule,
 * the support package stayed unloaded while its sibling mounted rows were
 * disabled by the host).
 *
 * @param {string} profileDir
 * @param {{ hostNodeModules?: string | null, homeDir?: string | null, appDir?: string | null }} [options]
 * @returns {Set<string>}
 */
export function collectMountedPackageNames(profileDir, options = {}) {
  /** @type {import('./manifest.mjs').Finding[]} */
  const findings = []
  const profileManifest = readJson(join(profileDir, 'package.json'))
  if (!isRecord(profileManifest)) return new Set()
  const bundleNames = Array.isArray(profileManifest.dsh?.profile?.bundles)
    ? profileManifest.dsh.profile.bundles.filter((name) => typeof name === 'string')
    : []
  const { layers } = buildLayerStack(profileDir, bundleNames, options, findings)
  const names = new Set()
  for (const row of composeLayers(layers).resolvableRows) {
    if (typeof row.name !== 'string' || row.name === '') continue
    names.add(packageRoot(row.name) ?? row.name)
  }
  return names
}

/**
 * Check one DSH profile directory's composition.
 *
 * @param {string} profileDir
 * @param {{ hostNodeModules?: string | null, homeDir?: string | null, appDir?: string | null }} [options]
 * @returns {import('./manifest.mjs').Finding[]}
 */
export function checkComposition(profileDir, options = {}) {
  const hostNodeModules = options.hostNodeModules ?? null
  const coreNames = collectCorePackageNames(hostNodeModules)
  /** @type {import('./manifest.mjs').Finding[]} */
  const findings = []

  const profileManifest = readJson(join(profileDir, 'package.json'))
  if (!isRecord(profileManifest)) {
    return [finding('DSH-C000', `无法读取或解析 ${join(profileDir, 'package.json')}`)]
  }
  const bundleNames = Array.isArray(profileManifest.dsh?.profile?.bundles)
    ? profileManifest.dsh.profile.bundles.filter((name) => typeof name === 'string')
    : []

  // --- C050 / C056: host packages pulled in as ordinary dependencies ------
  /** @param {string} owner @param {string} name */
  const reportOrdinaryDependency = (owner, name) => {
    if (RUNTIME_CORE_SET.has(name)) {
      findings.push(
        finding('DSH-C050', `${owner} 把宿主核心包 ${name} 放进了 dependencies（会 hoist 到 profile 根并遮蔽宿主版本）`),
      )
    } else {
      findings.push(
        finding('DSH-C056', `${owner} 把宿主工具包 ${name} 放进了 dependencies（重复安装，通常无害，但仍应改 peerDependencies）`),
      )
    }
  }
  const dependencies = isRecord(profileManifest.dependencies) ? profileManifest.dependencies : {}
  for (const name of Object.keys(dependencies)) {
    if (coreNames.has(name)) reportOrdinaryDependency('profile', name)
  }
  for (const plugin of installedPackageNames(profileDir)) {
    // A package the host itself ships is composed against the host's own
    // dependency tree; its dependency list is the host's internal business,
    // not a third-party plugin defect. Without this guard the host's own
    // `dsh-lsp-stdio` / `dsh-tool-lsp` (which legitimately depend on
    // `@deepseek-ai/dsh-util-values`) read as plugins shadowing the host.
    if (hostProvided(hostNodeModules, plugin)) continue
    const manifest = readJson(join(profileDir, 'node_modules', plugin, 'package.json'))
    if (!isRecord(manifest) || !isRecord(manifest.dependencies)) continue
    for (const name of Object.keys(manifest.dependencies)) {
      if (coreNames.has(name)) reportOrdinaryDependency(plugin, name)
    }
  }

  const { layers, bundleInfo } = buildLayerStack(profileDir, bundleNames, options, findings)
  const composed = composeLayers(layers)

  // --- C052: duplicate loader entry ids ----------------------------------
  for (const duplicate of composed.duplicates) {
    findings.push(
      finding(
        'DSH-C052',
        `loader entry id ${JSON.stringify(duplicate.id)} 出现 ${duplicate.count} 次（层：${duplicate.layers.join(' / ')}）`,
      ),
    )
  }

  // --- C055: patch rows that target nothing ------------------------------
  for (const orphan of composed.orphans) {
    findings.push(finding('DSH-C055', `层 ${orphan.layer}：entry ${JSON.stringify(orphan.id)} ${orphan.reason}`))
  }

  // --- C054: declared bundle order violated ------------------------------
  const positionOf = new Map(bundleNames.map((name, index) => [name, index]))
  for (const bundle of bundleInfo) {
    const index = positionOf.get(bundle.name)
    if (index === undefined || bundle.order === undefined) continue
    for (const required of bundle.order.after ?? []) {
      const other = positionOf.get(required)
      if (other !== undefined && other > index) {
        findings.push(finding('DSH-C054', `${bundle.name} 声明 order.after ${required}，但后者排在其后（第 ${other + 1} 位 vs 第 ${index + 1} 位）`))
      }
    }
    for (const required of bundle.order.before ?? []) {
      const other = positionOf.get(required)
      if (other !== undefined && other < index) {
        findings.push(finding('DSH-C054', `${bundle.name} 声明 order.before ${required}，但后者排在其前（第 ${other + 1} 位 vs 第 ${index + 1} 位）`))
      }
    }
  }

  // --- C051: multiple core versions in the lockfile ----------------------
  for (const [name, versions] of lockfileCoreVersions(profileDir)) {
    if (versions.length < 2) continue
    findings.push(finding('DSH-C051', `${name} 在 pnpm-lock.yaml 中出现多个版本：${versions.join(', ')}`))
  }

  // --- C053: user/home patch rows naming packages that are not installed --
  const userLayers = new Set(layers.filter((layer) => layer.kind === 'user' || layer.kind === 'home').map((layer) => layer.label))
  const checked = new Set()
  for (const row of composed.resolvableRows) {
    if (!userLayers.has(row.layer)) continue
    if (row.name === undefined || row.name === '') {
      findings.push(finding('DSH-C053', `层 ${row.layer}：entry ${JSON.stringify(row.id)} 没有模块名`))
      continue
    }
    if (!isBareLoaderSpecifier(row.name) || isBuiltin(row.name)) continue
    const name = packageRoot(row.name)
    if (name === null || checked.has(name)) continue
    checked.add(name)
    if (profilePackageInstalled(profileDir, name)) continue
    if (hostNodeModules !== null && coreNames.has(name) && resolvePackageDir(hostNodeModules, name) !== null) continue
    findings.push(finding('DSH-C053', `层 ${row.layer} 引用了未安装的包 ${name}（entry ${JSON.stringify(row.id)}）`))
  }

  return findings
}
