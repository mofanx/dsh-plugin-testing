/**
 * SemVer **syntax** and **satisfaction** for the conformance checker.
 *
 * Two distinct jobs live here:
 *  - `isValidSemverRange` — is `engines.dsh` syntactically a range? (DSH-C031)
 *  - `satisfies` / `diagnoseRange` — does a concrete host version meet a peer
 *    range? (DSH-C060 / C061)
 *
 * Faithfulness note: this implements npm's documented subset — comparators,
 * `^`, `~`, X-ranges, `||`, and the prerelease admission rule (a prerelease
 * version may only match when some comparator in the clause carries a
 * prerelease on the same `major.minor.patch`). When this tool lands inside a
 * repo, prefer the official `semver` package for satisfaction and keep the
 * suite in `tests/version.spec.mjs` as the migration safety net.
 *
 * @module dsh-plugin-conformance/semver
 */

const NUM = '(?:0|[1-9]\\d*)'
const VERSION_RE = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-([0-9A-Za-z-.]+))?(?:\\+[0-9A-Za-z-.]+)?$`)
const PARTIAL_RE = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/

/**
 * @typedef {object} Version
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {string[]} prerelease
 */

/**
 * Parse a concrete version. Build metadata is accepted and ignored.
 * @param {unknown} text
 * @returns {Version | null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = VERSION_RE.exec(text.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** @param {Version} version */
function plain(version) {
  return { major: version.major, minor: version.minor, patch: version.patch, prerelease: [] }
}

/** @param {readonly string[]} a @param {readonly string[]} b */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // a release outranks any prerelease
  if (b.length === 0) return -1
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index += 1) {
    const left = a[index]
    const right = b[index]
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right)
      if (delta !== 0) return delta < 0 ? -1 : 1
    } else if (leftNumeric) {
      return -1
    } else if (rightNumeric) {
      return 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * @param {Version} a
 * @param {Version} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  const order = comparePrerelease(a.prerelease, b.prerelease)
  return order === 0 ? 0 : order < 0 ? -1 : 1
}

/** @param {Version} version */
function caretUpper(version) {
  if (version.major !== 0) return { major: version.major + 1, minor: 0, patch: 0, prerelease: [] }
  if (version.minor !== 0) return { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] }
  return { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] }
}

/** @param {Version} version */
function tildeUpper(version) {
  return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] }
}

/**
 * @typedef {object} Comparator
 * @property {string} op one of `> >= < <= =`
 * @property {Version} version
 */

/**
 * Expand one whitespace-delimited token into primitive comparators.
 * Returns `[]` for "any", `null` for a syntax error.
 * @param {string} token
 * @returns {Comparator[] | null}
 */
function expandComparator(token) {
  let op = '='
  let body = token
  for (const candidate of ['>=', '<=', '>', '<', '=', '^', '~']) {
    if (body.startsWith(candidate)) {
      op = candidate
      body = body.slice(candidate.length)
      break
    }
  }
  if (body === '') return null
  if (body === '*' || body.toLowerCase() === 'x') return []

  const exact = parseVersion(body)
  if (exact !== null) {
    if (op === '^') return [{ op: '>=', version: exact }, { op: '<', version: caretUpper(exact) }]
    if (op === '~') return [{ op: '>=', version: exact }, { op: '<', version: tildeUpper(exact) }]
    return [{ op, version: exact }]
  }

  const partial = PARTIAL_RE.exec(body)
  if (partial === null) return null
  const isWildcard = (part) => part === undefined || part === '' || /^[xX*]$/.test(part)
  const [, rawMajor, rawMinor, rawPatch] = partial
  if (isWildcard(rawMajor)) return []
  const major = Number(rawMajor)
  const minor = isWildcard(rawMinor) ? null : Number(rawMinor)
  const patch = isWildcard(rawPatch) ? null : Number(rawPatch)

  const lower = { major, minor: minor ?? 0, patch: patch ?? 0, prerelease: [] }
  if (['>', '>=', '<', '<='].includes(op)) return [{ op, version: lower }]

  /** @type {Version | null} */
  let upper
  if (op === '~') {
    upper = minor === null ? { major: major + 1, minor: 0, patch: 0, prerelease: [] } : { major, minor: minor + 1, patch: 0, prerelease: [] }
  } else if (op === '^') {
    if (major === 0 && minor === null) upper = { major: 1, minor: 0, patch: 0, prerelease: [] }
    else if (major === 0 && minor === 0) upper = { major: 0, minor: 1, patch: 0, prerelease: [] }
    else if (major === 0) upper = { major: 0, minor: (minor ?? 0) + 1, patch: 0, prerelease: [] }
    else upper = { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  } else if (minor === null) {
    upper = { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  } else if (patch === null) {
    upper = { major, minor: minor + 1, patch: 0, prerelease: [] }
  } else {
    upper = null
  }

  if (upper === null) return [{ op: '=', version: lower }]
  return [{ op: '>=', version: lower }, { op: '<', version: upper }]
}

/**
 * Parse a range into clauses of primitive comparators.
 * @param {unknown} range
 * @returns {Comparator[][] | null} `null` on syntax error
 */
function parseRange(range) {
  if (typeof range !== 'string') return null
  const trimmed = range.trim()
  if (trimmed === '' || trimmed !== range) return null
  /** @type {Comparator[][]} */
  const clauses = []
  for (const clauseText of trimmed.split('||')) {
    const tokens = clauseText.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return null
    /** @type {Comparator[]} */
    const comparators = []
    for (const token of tokens) {
      const expanded = expandComparator(token)
      if (expanded === null) return null
      comparators.push(...expanded)
    }
    clauses.push(comparators)
  }
  return clauses
}

/**
 * Is `range` a syntactically valid SemVer range?
 *
 * Partial versions are valid X-ranges under npm semantics (`0.2` means
 * `>=0.2.0 <0.3.0`), so this is deliberately not stricter than npm.
 *
 * @param {unknown} range
 * @returns {boolean}
 */
export function isValidSemverRange(range) {
  return parseRange(range) !== null
}

/** @param {Version} version @param {readonly Comparator[]} comparators */
function clauseSatisfied(version, comparators) {
  if (comparators.length === 0) return true
  if (version.prerelease.length > 0) {
    const admitted = comparators.some(
      (comparator) =>
        comparator.version.prerelease.length > 0 &&
        comparator.version.major === version.major &&
        comparator.version.minor === version.minor &&
        comparator.version.patch === version.patch,
    )
    if (!admitted) return false
  }
  return comparators.every((comparator) => {
    const order = compareVersions(version, comparator.version)
    switch (comparator.op) {
      case '>':
        return order > 0
      case '>=':
        return order >= 0
      case '<':
        return order < 0
      case '<=':
        return order <= 0
      case '=':
        return order === 0
      default:
        return false
    }
  })
}

/**
 * Does `version` satisfy `range`?
 * @param {unknown} version
 * @param {unknown} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  if (parsed === null || parsed === undefined) return false
  const clauses = parseRange(range)
  if (clauses === null) return false
  return clauses.some((comparators) => clauseSatisfied(parsed, comparators))
}

/**
 * Explain a failed match so callers can distinguish "host too old" from
 * "host too new" (DSH-C060 vs DSH-C061).
 *
 * @param {unknown} version
 * @param {unknown} range
 * @returns {{ satisfied: boolean, direction: 'belowMin' | 'aboveMax' | null }}
 */
export function diagnoseRange(version, range) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  const clauses = parseRange(range)
  if (parsed === null || parsed === undefined || clauses === null) return { satisfied: false, direction: null }
  if (clauses.some((comparators) => clauseSatisfied(parsed, comparators))) return { satisfied: true, direction: null }
  const comparators = clauses[0]
  const belowMin = comparators.some(
    (comparator) => (comparator.op === '>=' || comparator.op === '>') && compareVersions(parsed, comparator.version) < 0,
  )
  const aboveMax = comparators.some(
    (comparator) => (comparator.op === '<' || comparator.op === '<=') && compareVersions(parsed, comparator.version) >= 0,
  )
  return { satisfied: false, direction: belowMin ? 'belowMin' : aboveMax ? 'aboveMax' : null }
}
