/**
 * Stable rule codes for the DSH plugin conformance checker.
 *
 * These codes are the contract between the checker, CI reports, and any
 * exemption write-up. They mirror `dsh-plugin-contract-v1.md` §6 and must not
 * be renumbered once shipped — add new codes instead.
 *
 * @module dsh-plugin-conformance/rules
 */

/**
 * @typedef {'error' | 'warn'} Severity
 * @typedef {{ severity: Severity, title: string, task: string }} Rule
 */

/** @type {Record<string, Rule>} */
export const RULES = {
  // --- manifest identity -------------------------------------------------
  'DSH-C000': { severity: 'error', title: 'package.json 缺失、无法读取或 JSON 非法', task: 'T10' },
  'DSH-C001': { severity: 'error', title: 'name 缺失或非字符串', task: 'T10' },
  'DSH-C002': { severity: 'error', title: 'version 缺失或非字符串', task: 'T10' },

  // --- dsh.bundle --------------------------------------------------------
  'DSH-C010': { severity: 'error', title: '声明了 dsh.bundle 但 patch 缺失', task: 'T10' },
  'DSH-C011': { severity: 'error', title: 'dsh.bundle.patch 非 string | string[]', task: 'T10' },
  'DSH-C012': { severity: 'error', title: 'dsh.bundle.patch 指向的文件不存在', task: 'T10' },
  'DSH-C013': { severity: 'error', title: 'dsh.bundle.patch 数组为空', task: 'T10' },

  // --- dsh role fields ---------------------------------------------------
  'DSH-C020': { severity: 'error', title: 'dsh.manifestVersion 存在且不为 1', task: 'T10' },
  'DSH-C021': { severity: 'error', title: '声明了 dsh.client 但 platform 缺失或非字符串', task: 'T10' },
  'DSH-C022': { severity: 'error', title: 'dsh.client.inject 存在但非 string[]', task: 'T10' },
  'DSH-C023': { severity: 'error', title: 'dsh.profile.bundles 存在但非 string[]', task: 'T10' },

  // --- engines -----------------------------------------------------------
  'DSH-C030': { severity: 'warn', title: 'engines.dsh 缺失', task: 'T10' },
  'DSH-C031': { severity: 'error', title: 'engines.dsh SemVer 范围语法非法', task: 'T10' },

  // --- exports -----------------------------------------------------------
  'DSH-C040': { severity: 'error', title: "exports 缺 '.'", task: 'T10' },
  'DSH-C041': { severity: 'error', title: "exports 缺 './package.json'", task: 'T10' },
  'DSH-C042': { severity: 'error', title: 'dsh.bundle.patch 的文件未被 exports 覆盖', task: 'T10' },
  'DSH-C043': { severity: 'error', title: "有客户端半边但 exports 缺 './client'", task: 'T10' },
  'DSH-C044': { severity: 'error', title: "exports 含 './invariant'（该 API 在 0.2.1 线已移除）", task: 'T10' },

  // --- composition (T11, declared here so reports can reference them) ----
  'DSH-C050': { severity: 'error', title: '宿主核心包出现在 dependencies', task: 'T11' },
  'DSH-C051': { severity: 'error', title: '同一宿主核心包在 lockfile 出现多版本', task: 'T11' },
  'DSH-C052': { severity: 'error', title: '组合内出现重复 loader entry id', task: 'T11' },
  'DSH-C053': { severity: 'error', title: 'patch 条目引用了未安装的包', task: 'T11' },
  'DSH-C054': { severity: 'error', title: 'dsh.profile.bundles 顺序非法', task: 'T11' },
  'DSH-C055': { severity: 'error', title: 'patch 指向已移除的 id 或模块', task: 'T11' },
  'DSH-C056': { severity: 'warn', title: '宿主工具类包出现在 dependencies（重复安装但通常无害）', task: 'T11' },

  // --- version contract (T12) -------------------------------------------
  'DSH-C060': { severity: 'error', title: 'peer 范围不满足宿主实际版本（belowMin）', task: 'T12' },
  'DSH-C061': { severity: 'warn', title: 'peer 范围不满足宿主实际版本（aboveMax）', task: 'T12' },
  'DSH-C062': { severity: 'error', title: 'peer 使用了禁止的跨主版本大范围', task: 'T12' },
  'DSH-C063': { severity: 'error', title: 'engines.dsh 与 peer 中的 DSH 版本不一致', task: 'T12' },
  'DSH-C064': { severity: 'error', title: '存在不满足的 peer 但无 compatibility.json 豁免', task: 'T12' },
  'DSH-C065': { severity: 'warn', title: '存在豁免条目但对应插件版本已变更（豁免失效）', task: 'T12' },
  'DSH-C066': { severity: 'warn', title: '支撑包（非 profile 行）的 peer 不满足宿主（尚未阻断）', task: 'T15' },
}

/** Rules implemented by the T10 manifest/exports pass. */
export const MANIFEST_RULE_CODES = Object.freeze(
  Object.entries(RULES)
    .filter(([, rule]) => rule.task === 'T10')
    .map(([code]) => code),
)

/** Rules implemented by the T12 peer/version pass. */
export const VERSION_RULE_CODES = Object.freeze(
  Object.entries(RULES)
    .filter(([, rule]) => rule.task === 'T12')
    .map(([code]) => code),
)

/** Rules implemented by the T11 profile-composition pass. */
export const COMPOSITION_RULE_CODES = Object.freeze(
  Object.entries(RULES)
    .filter(([, rule]) => rule.task === 'T11')
    .map(([code]) => code),
)

/** Rules implemented by the T15 mounted-row discrimination. */
export const MOUNTED_RULE_CODES = Object.freeze(
  Object.entries(RULES)
    .filter(([, rule]) => rule.task === 'T15')
    .map(([code]) => code),
)

/**
 * Severity for a code.
 * @param {string} code
 * @returns {Severity}
 */
export function severityOf(code) {
  return RULES[code]?.severity ?? 'error'
}

/**
 * Human-readable title for a code.
 * @param {string} code
 * @returns {string}
 */
export function titleOf(code) {
  return RULES[code]?.title ?? 'unknown rule'
}
