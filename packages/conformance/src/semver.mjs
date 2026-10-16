/**
 * SemVer **syntax** and **satisfaction** for the conformance checker.
 *
 * Two distinct jobs live here:
 *  - `isValidSemverRange` — is `engines.dsh` syntactically a range? (DSH-C031)
 *  - `satisfies` / `diagnoseRange` — does a concrete host version meet a peer
 *    range? (DSH-C060 / C061)
 *  - `admittedOnlyByRuntime` — the *other* dimension: does the range pass the
 *    prerelease-inclusive evaluation but fail plain npm/pnpm resolution?
 *    (DSH-C067)
 *
 * Faithfulness note: the DSH runtime (`@deepseek-ai/dsh-app-boot`
 * `evaluatePluginCompatibility`) evaluates peer ranges with the official
 * `semver` package and **`includePrerelease: true`** — i.e. prerelease host
 * versions participate in matching unconditionally. This module therefore
 * delegates satisfaction to the same `semver` package (pinned to the same
 * `^7.8.5` the runtime uses) with the same option, instead of re-implementing
 * the npm prerelease admission rule, which is *stricter* than the runtime and
 * would mis-report a prerelease host (e.g. `0.2.1-alpha.2`) against a range
 * like `>=0.2.0 <0.3.0`. `tests/version.spec.mjs` pins that alignment.
 *
 * @module dsh-plugin-conformance/semver
 */

import semver from 'semver'

/**
 * Parse a concrete version. Build metadata is accepted and ignored.
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] } | null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const parsed = semver.parse(text.trim())
  if (parsed === null) return null
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
  }
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
  if (typeof range !== 'string') return false
  // `semver.validRange('')` returns '*' (the "any version" range), but an
  // empty `engines.dsh` means "forgot to declare", not "matches anything".
  if (range.trim() === '') return false
  return semver.validRange(range) !== null
}

/**
 * Does `version` satisfy `range`? Mirrors the runtime's prerelease policy:
 * `includePrerelease: true`, so a prerelease host version matches ranges that
 * do not explicitly name the same prerelease tuple.
 *
 * @param {unknown} version
 * @param {unknown} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
  if (typeof version !== 'string' || typeof range !== 'string') return false
  return semver.satisfies(version, range, { includePrerelease: true })
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
  if (typeof version !== 'string' || typeof range !== 'string') return { satisfied: false, direction: null }
  if (semver.valid(version) === null) return { satisfied: false, direction: null }
  // The direction probe must use the same prerelease policy as the satisfaction
  // check above, otherwise a prerelease version could be graded as satisfied by
  // one call and "outside" by the other.
  if (semver.satisfies(version, range, { includePrerelease: true })) return { satisfied: true, direction: null }
  if (semver.ltr(version, range, { includePrerelease: true })) return { satisfied: false, direction: 'belowMin' }
  if (semver.gtr(version, range, { includePrerelease: true })) return { satisfied: false, direction: 'aboveMax' }
  return { satisfied: false, direction: null }
}

/**
 * Does `version` satisfy `range` under **plain npm/pnpm install-time**
 * semantics — i.e. without `includePrerelease`?
 *
 * npm's published rule: a prerelease version only satisfies a comparator set if
 * at least one comparator carries a prerelease **with the same
 * `[major, minor, patch]` tuple**. The runtime preflight deliberately does not
 * apply that rule (`includePrerelease: true`), so the two evaluators disagree on
 * exactly the versions this predicate is about. (DSH-C067)
 *
 * @param {unknown} version
 * @param {unknown} range
 * @returns {boolean}
 */
export function satisfiesInstallTime(version, range) {
  if (typeof version !== 'string' || typeof range !== 'string') return false
  if (semver.valid(version) === null) return false
  // An invalid range throws in `satisfies`; C031 already reports that shape.
  if (semver.validRange(range) === null) return false
  return semver.satisfies(version, range)
}

/**
 * The precise defect DSH-C067 describes: `range` is admitted by the
 * prerelease-inclusive evaluation (runtime preflight, and this checker's own
 * `satisfies`) but rejected by plain npm/pnpm resolution.
 *
 * `includePrerelease` only ever relaxes admission, so this is the whole
 * divergence set — no version is admitted by one call and "outside" by the
 * other.
 *
 * @param {unknown} version
 * @param {unknown} range
 * @returns {boolean}
 */
export function admittedOnlyByRuntime(version, range) {
  if (typeof version !== 'string') return false
  if (parseVersion(version)?.prerelease.length === 0) return false
  return satisfies(version, range) && !satisfiesInstallTime(version, range)
}

/**
 * The `[major, minor, patch]` tuple of a concrete version, as a string
 * (`0.2.1-alpha.4` → `0.2.1`). `null` when the version cannot be parsed.
 *
 * Used to name the tuple a range would have to cover: that is exactly the
 * information an author needs to fix a DSH-C067 finding.
 *
 * @param {unknown} version
 * @returns {string | null}
 */
export function prereleaseTuple(version) {
  const parsed = parseVersion(version)
  if (parsed === null) return null
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`
}

/**
 * Does `range` silently claim host majors it never declared? (DSH-C062)
 *
 * Two shapes qualify, because both cover more than one major line:
 *
 *  - a clause bounded on both sides whose majors span two or more
 *    (`>=1.0.0 <3.0.0` covers 1.x *and* 2.x without saying so);
 *  - a clause bounded on only one side (`>=1.0.0`, `<2.0.0`), which claims every
 *    major on the open side — including all future ones.
 *
 * An explicit union of per-major clauses (`>=1.0.0 <2.0.0 || >=2.0.0 <3.0.0`) is
 * an honest per-line declaration and is **not** flagged.
 *
 * This parses the range with `semver` rather than pattern-matching the string,
 * so partial versions (`>=1 <3`), hyphen ranges (`1.0.0 - 3.0.0`) and open-ended
 * bounds are judged the same way as fully spelled-out comparators.
 *
 * Note: an exact pin (`0.2.0-rc.2`) and a single-major shorthand (`^1.0.0`,
 * `~4.0.4`, `1.x`) all expand to a one-sided-looking comparator pair with
 * majors one apart, and are deliberately not flagged.
 *
 * @param {unknown} range
 * @returns {boolean}
 */
export function spansUnverifiedMajors(range) {
  if (typeof range !== 'string') return false
  /** @type {InstanceType<typeof semver.Range>} */
  let parsed
  try {
    parsed = new semver.Range(range)
  } catch {
    return false
  }
  for (const clause of parsed.set) {
    /** @type {Set<number>} */
    const majors = new Set()
    let boundedBelow = false
    let boundedAbove = false
    for (const comparator of clause) {
      // The ANY comparator (`*`) has an empty `value` and no usable `semver`;
      // it carries no concrete bound and is not judged here.
      if (comparator.value === '') continue
      majors.add(comparator.semver.major)
      if (comparator.operator === '>' || comparator.operator === '>=') boundedBelow = true
      else if (comparator.operator === '<' || comparator.operator === '<=') boundedAbove = true
      // An exact pin has an empty operator but bounds both sides.
      else {
        boundedBelow = true
        boundedAbove = true
      }
    }
    if (majors.size === 0) continue
    if (!boundedBelow || !boundedAbove) return true
    if (Math.max(...majors) - Math.min(...majors) >= 2) return true
  }
  return false
}
