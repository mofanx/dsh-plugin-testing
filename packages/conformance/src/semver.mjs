/**
 * SemVer **syntax** and **satisfaction** for the conformance checker.
 *
 * Two distinct jobs live here:
 *  - `isValidSemverRange` — is `engines.dsh` syntactically a range? (DSH-C031)
 *  - `satisfies` / `diagnoseRange` — does a concrete host version meet a peer
 *    range? (DSH-C060 / C061)
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
  if (semver.satisfies(version, range, { includePrerelease: true })) return { satisfied: true, direction: null }
  if (semver.ltr(version, range)) return { satisfied: false, direction: 'belowMin' }
  if (semver.gtr(version, range)) return { satisfied: false, direction: 'aboveMax' }
  return { satisfied: false, direction: null }
}
