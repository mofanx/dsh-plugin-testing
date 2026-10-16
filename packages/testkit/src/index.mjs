/**
 * Package entry point — the union of the testkit's public modules.
 *
 * Exists so the documented one-line import works:
 *
 * ```js
 * import { createTestHome, testHomeArgs, testHomeEnv } from '@deepseek-ai/dsh-plugin-testkit'
 * ```
 *
 * Without a `"."` entry in `exports`, Node answers that import with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, so the guide's example could not run. The
 * per-module subpaths (`…/home`, `…/replay`) remain available and are the more
 * precise form when only one half is needed.
 *
 * @module dsh-plugin-testkit
 */

export * from './home.mjs'
export * from './replay.mjs'
export * from './activate.mjs'
