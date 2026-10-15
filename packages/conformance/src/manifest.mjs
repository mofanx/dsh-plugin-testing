/**
 * T10 — manifest and `exports` conformance pass.
 *
 * Implements rules DSH-C001…C044 from `docs/contract-v1.md` §6. Pure
 * filesystem + JSON reading: no DSH boot, no network, no writes. This is the
 * cheapest gate in the suite (sub-second) and the one that catches the
 * failures teams hit first.
 *
 * @module dsh-plugin-conformance/manifest
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { severityOf } from './rules.mjs'
import { isValidSemverRange } from './semver.mjs'
import { loadRemovedApis, matchRemovedSubpath, removedSeverity } from './removed-apis.mjs'

/**
 * @typedef {object} Finding
 * @property {string} code stable `DSH-C0xx` rule code
 * @property {'error' | 'warn'} severity
 * @property {string} message what is wrong, in the offending package's terms
 * @property {string} [hint] optional remediation
 */

/** @param {unknown} value */
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * @param {string} code
 * @param {string} message
 * @param {'error' | 'warn'} [severity] override the rule table's static severity
 * @returns {Finding}
 */
function finding(code, message, severity = severityOf(code)) {
  return { code, severity, message }
}

/** @param {string} text */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Subpath keys of an `exports` field, or `null` when the package exports
 * nothing usable. A condition object with no subpath keys describes `.`
 * implicitly, which is how Node treats it.
 *
 * @param {unknown} exportsField
 * @returns {string[] | null}
 */
function subpathKeys(exportsField) {
  if (exportsField === undefined || exportsField === null) return null
  if (typeof exportsField === 'string') return ['.']
  if (Array.isArray(exportsField)) return ['.']
  if (typeof exportsField !== 'object') return null
  const keys = Object.keys(exportsField)
  if (keys.length === 0) return null
  const subpaths = keys.filter((key) => key.startsWith('.'))
  return subpaths.length > 0 ? subpaths : ['.']
}

/**
 * Normalize a package-relative file path into the shape `exports` keys use.
 *
 * `dsh.bundle.patch` values are "relative to the package root" (contract §1.2)
 * and the loader resolves them with ordinary path resolution, so both
 * `cordis.patch.yml` and `./cordis.patch.yml` name the same file. Node's
 * `exports` keys, however, must start with `./`. Comparing the two forms
 * verbatim produced a **false** DSH-C042 for a manifest that is perfectly valid
 * (`"patch": "cordis.patch.yml"` beside `"./cordis.patch.yml": …`).
 *
 * @param {string} relPath
 * @returns {string}
 */
function toExportSubpath(relPath) {
  const slashed = relPath.replace(/\\/g, '/')
  return slashed.startsWith('./') ? slashed : `./${slashed}`
}

/**
 * Whether `relPath` is reachable through the declared export subpaths, either
 * exactly or through a `*` pattern such as `./presets/*.patch.yml`.
 *
 * @param {readonly string[]} keys
 * @param {string} relPath
 */
function exportCovers(keys, relPath) {
  const target = toExportSubpath(relPath)
  if (keys.includes(target)) return true
  for (const key of keys) {
    if (!key.includes('*')) continue
    const pattern = `^${key.split('*').map(escapeRe).join('.*')}$`
    if (new RegExp(pattern).test(target)) return true
  }
  return false
}

/**
 * Check one package directory against the T10 manifest and exports rules.
 *
 * @param {string} packageDir directory containing the plugin's `package.json`
 * @param {{ dshRuntimeVersion?: string, removedApis?: import('./removed-apis.mjs').RemovedApi[] | null }} [options]
 *   `dshRuntimeVersion` grades removed-API findings against the host version the
 *   plugin is judged against (before removal → warn, at/after → error).
 * @returns {Finding[]} findings in rule order; empty means the package passes
 */
export function checkManifest(packageDir, options = {}) {
  /** @type {Finding[]} */
  const findings = []
  const dshRuntimeVersion = options.dshRuntimeVersion
  // Tests inject a custom table; production loads the committed default.
  const removedApis =
    options.removedApis !== undefined ? { removed: options.removedApis ?? [] } : loadRemovedApis()
  const manifestPath = join(packageDir, 'package.json')

  /** @type {any} */
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return [finding('DSH-C000', `无法读取或解析 ${manifestPath}：${error?.message ?? error}`)]
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return [finding('DSH-C000', `${manifestPath} 的顶层不是对象`)]
  }

  // --- identity ----------------------------------------------------------
  if (typeof pkg.name !== 'string' || pkg.name === '') {
    findings.push(finding('DSH-C001', 'name 缺失或非字符串'))
  }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    findings.push(finding('DSH-C002', 'version 缺失或非字符串'))
  }

  // --- dsh root ----------------------------------------------------------
  const dshField = pkg.dsh
  if (dshField !== undefined && (dshField === null || typeof dshField !== 'object' || Array.isArray(dshField))) {
    findings.push(finding('DSH-C020', 'dsh 存在但不是对象'))
  }
  const dsh = dshField !== null && typeof dshField === 'object' && !Array.isArray(dshField) ? dshField : {}

  // --- dsh.bundle --------------------------------------------------------
  const bundle = dsh.bundle
  const declaresBundle = bundle !== undefined && bundle !== null
  /** @type {string[]} */
  let patchPaths = []
  if (declaresBundle) {
    if (typeof bundle !== 'object' || Array.isArray(bundle)) {
      findings.push(finding('DSH-C010', 'dsh.bundle 存在但不是对象'))
    } else if (bundle.patch === undefined) {
      findings.push(finding('DSH-C010', 'dsh.bundle 已声明但缺少 patch'))
    } else if (typeof bundle.patch !== 'string' && !Array.isArray(bundle.patch)) {
      findings.push(finding('DSH-C011', `dsh.bundle.patch 类型为 ${typeof bundle.patch}，应为 string 或 string[]`))
    } else if (Array.isArray(bundle.patch) && !isStringArray(bundle.patch)) {
      findings.push(finding('DSH-C011', 'dsh.bundle.patch 数组含非字符串元素'))
    } else if (Array.isArray(bundle.patch) && bundle.patch.length === 0) {
      findings.push(finding('DSH-C013', 'dsh.bundle.patch 为空数组'))
    } else {
      patchPaths = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
      for (const rel of patchPaths) {
        if (!existsSync(resolve(packageDir, rel))) {
          findings.push(finding('DSH-C012', `dsh.bundle.patch 指向的文件不存在：${rel}`))
        }
      }
    }
  }

  // --- dsh.manifestVersion ----------------------------------------------
  if (dsh.manifestVersion !== undefined && dsh.manifestVersion !== 1) {
    findings.push(finding('DSH-C020', `dsh.manifestVersion 为 ${JSON.stringify(dsh.manifestVersion)}，唯一合法值是 1`))
  }

  // --- dsh.client --------------------------------------------------------
  const client = dsh.client
  const declaresClient = client !== undefined && client !== null
  if (declaresClient) {
    if (typeof client !== 'object' || Array.isArray(client)) {
      findings.push(finding('DSH-C021', 'dsh.client 存在但不是对象'))
    } else {
      if (typeof client.platform !== 'string' || client.platform === '') {
        findings.push(finding('DSH-C021', 'dsh.client 已声明但缺少 platform（必填）'))
      }
      if (client.inject !== undefined && !isStringArray(client.inject)) {
        findings.push(finding('DSH-C022', 'dsh.client.inject 存在但不是 string[]（它是信息性包名依赖，不是 Cordis 服务注入）'))
      }
    }
  }

  // --- dsh.profile -------------------------------------------------------
  const profile = dsh.profile
  if (profile !== undefined && profile !== null) {
    if (typeof profile !== 'object' || Array.isArray(profile)) {
      findings.push(finding('DSH-C023', 'dsh.profile 存在但不是对象'))
    } else if (profile.bundles !== undefined && !isStringArray(profile.bundles)) {
      findings.push(finding('DSH-C023', 'dsh.profile.bundles 存在但不是 string[]'))
    }
  }

  // --- engines -----------------------------------------------------------
  const engines = pkg.engines
  const dshEngine = engines !== null && typeof engines === 'object' ? engines.dsh : undefined
  if (dshEngine === undefined) {
    findings.push(finding('DSH-C030', 'engines.dsh 未声明，宿主兼容性无法表达'))
  } else if (typeof dshEngine !== 'string' || !isValidSemverRange(dshEngine)) {
    findings.push(finding('DSH-C031', `engines.dsh 不是合法的 SemVer 范围：${JSON.stringify(dshEngine)}`))
  }

  // --- exports -----------------------------------------------------------
  const declaredKeys = subpathKeys(pkg.exports)
  const keys = declaredKeys ?? []
  if (declaredKeys === null) {
    findings.push(finding('DSH-C040', "exports 未声明，缺 '.'"))
    findings.push(finding('DSH-C041', "exports 未声明，缺 './package.json'"))
  } else {
    if (!keys.includes('.')) findings.push(finding('DSH-C040', "exports 缺 '.'"))
    if (!keys.includes('./package.json')) findings.push(finding('DSH-C041', "exports 缺 './package.json'"))
  }
  if (declaresBundle) {
    for (const rel of patchPaths) {
      if (!exportCovers(keys, rel)) {
        findings.push(finding('DSH-C042', `dsh.bundle.patch 的文件未被 exports 覆盖：${rel}`))
      }
    }
  }
  if (declaresClient && !exportCovers(keys, './client')) {
    findings.push(finding('DSH-C043', "声明了客户端半边但 exports 缺 './client'"))
  }
  for (const key of keys) {
    const removal = matchRemovedSubpath(key, removedApis)
    if (removal === null) continue
    const severity = removedSeverity(removal, dshRuntimeVersion)
    const versionContext =
      dshRuntimeVersion === undefined
        ? `在 ${removal.removedIn} 起移除`
        : severity === 'warn'
          ? `在 ${removal.removedIn} 起移除；当前宿主 ${dshRuntimeVersion} 早于此版本，暂可用但迁移后将无法加载`
          : `在 ${removal.removedIn} 起移除；当前宿主 ${dshRuntimeVersion} 已不含此子路径`
    findings.push(
      finding(
        removal.rule,
        `exports 暴露了已移除的子路径：${key}（${versionContext}）${removal.note ? `；${removal.note}` : ''}`,
        severity,
      ),
    )
  }

  return findings
}
