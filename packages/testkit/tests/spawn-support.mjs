/**
 * Shared spawn handling for the real-launcher integration cases.
 *
 * Why this exists: `spawnSync` reports "the child never started" and "the child
 * started and exited non-zero" through **different** fields — `error` versus
 * `status`. The integration cases originally read only `status`, so every
 * spawn-level failure (EPERM under a sandbox, ENOENT from a stale `DSH_BIN`, a
 * removed working directory) surfaced as a bare
 *
 *     launcher 应成功退出，实际 null
 *
 * which points at the launcher rather than at the environment. Passing the
 * reason through keeps the failure honest about which of the two happened.
 *
 * @module dsh-plugin-testkit/test-support
 */

import { spawnSync } from 'node:child_process'

/**
 * Spawn errors that mean "this environment cannot run the case at all", as
 * opposed to "the launcher ran and misbehaved".
 *
 * A timeout is deliberately **not** in this set: a hung launcher is exactly the
 * failure these cases exist to catch, so it must remain an assertion failure.
 */
const UNSPAWNABLE = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR'])

/**
 * `spawnSync` with `stdout`/`stderr` folded into one string and `error` kept.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} options
 * @returns {{ status: number | null, error: Error | undefined, output: string }}
 */
export function runLauncher(command, args, options) {
  const result = spawnSync(command, args, options)
  return {
    status: result.status,
    error: result.error,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/**
 * Skip the current test when the child could not be started for an
 * environmental reason. Returns `true` when the caller should stop.
 *
 * The reason is always reported through `t.skip(...)`, so the case shows up as
 * skipped-with-reason rather than as an unexplained pass.
 *
 * @param {import('node:test').TestContext} t
 * @param {Error | undefined} error
 * @returns {boolean}
 */
export function skipIfUnspawnable(t, error) {
  if (error === undefined) return false
  const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? ''
  if (!UNSPAWNABLE.has(code)) return false
  t.skip(`无法启动 launcher（${code}）：${error.message}`)
  return true
}
