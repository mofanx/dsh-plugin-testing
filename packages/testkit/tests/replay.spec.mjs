/**
 * T25 — keyless model replay.
 *
 * The unit cases pin the patch/env contract. The integration cases are the ones
 * that matter: they boot a **real DSH** against an isolated home and assert on
 * what the runtime actually reports. They are slow (~3s each) and are skipped
 * when the packaged launcher or the harness fixtures are absent, so the suite
 * still runs on a machine that only has this repo.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTestHome, testHomeArgs } from '../src/home.mjs'
import {
  REPLAY_MODEL_ID,
  REPLAY_PROVIDER_ID,
  SNAPSHOT_FILE_ENV,
  replayEnv,
  replayPatch,
} from '../src/replay.mjs'
import { runLauncher, skipIfUnspawnable } from './spawn-support.mjs'

/** Packaged launcher; override with `DSH_BIN` on another install. */
const DSH_BIN =
  process.env.DSH_BIN ??
  'D:\\Program Files\\DSH NEXT\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

const hasLauncher = existsSync(DSH_BIN)

/**
 * Session-snapshot fixtures from the harness source checkout. Override with
 * `DSH_FIXTURES` (path to `record-suite`) on another machine; the integration
 * cases skip themselves when either the launcher or the fixtures are absent.
 */
const HARNESS_FIXTURES =
  process.env.DSH_FIXTURES ??
  'D:\\projects\\nodejs\\deepseek-harness\\packages\\test-support\\session-snapshot\\tests\\fixtures\\record-suite'
const v3Fixture = `${HARNESS_FIXTURES}\\rec-pin\\session.v3.jsonl`
/** The v0 projection deliberately omits `version`. */
const v0Fixture = `${HARNESS_FIXTURES}\\rec-pin\\session.jsonl`

/**
 * `skip` value for an environment-dependent case: `false` when it can run, else
 * a human-readable reason.
 *
 * A bare `skip: true` renders as an unexplained `# SKIP` in CI — the one output
 * nobody can act on, because it does not say *which* variable to set or *which*
 * path was missing. Every environmental skip therefore names both.
 *
 * @param {string} [fixture] fixture file this case additionally needs
 * @returns {false | string}
 */
function missingEnv(fixture) {
  if (!hasLauncher) return `未找到 DSH launcher（DSH_BIN=${DSH_BIN}）`
  if (fixture !== undefined && !existsSync(fixture)) {
    return `fixture 缺失（DSH_FIXTURES=${HARNESS_FIXTURES}，找不到 ${fixture}）`
  }
  return false
}

/**
 * Boot the isolated home and return combined output plus the exit status.
 *
 * `error` is returned alongside `status` so callers can tell "the launcher
 * never started" (environmental) apart from "it started and exited non-zero"
 * (a statement about the launcher). Collapsing the two made every sandbox
 * EPERM look like a launcher bug.
 *
 * @param {ReturnType<typeof createTestHome>} home
 * @param {Record<string, string | undefined>} env
 * @param {string[]} [args]
 * @param {number} [timeout]
 */
function runDsh(home, env, args, timeout = 40_000) {
  return runLauncher(process.execPath, [DSH_BIN, ...args], { env, encoding: 'utf8', timeout })
}

/**
 * Shared guard for the real-boot cases: skip when the child could not be
 * started at all, otherwise assert it actually ran.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ status: number | null, error: Error | undefined, output: string }} result
 */
function assertLaunched(t, result) {
  if (skipIfUnspawnable(t, result.error)) return false
  assert.equal(
    result.error,
    undefined,
    `launcher 未能启动：${/** @type {NodeJS.ErrnoException} */ (result.error)?.code} ${result.error?.message}`,
  )
  return true
}

/**
 * Create a home that can host the replay plugin.
 *
 * The session root is pinned **inside** the throwaway home: `replayPatch`'s
 * default (`./.sessions`) is resolved against the child process's cwd, so a real
 * boot started from the repo root would deposit its session log into the working
 * tree — an isolation leak in a module whose whole purpose is isolation.
 */
function replayHome(patchOptions = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'dsh-replay-home-'))
  return createTestHome({
    root: homeDir,
    packages: ['@deepseek-ai/dsh-llm-replay'],
    profilePatch: replayPatch({ sessionRoot: join(homeDir, 'sessions'), ...patchOptions }),
  })
}

// ---------------------------------------------------------------------------
// Patch contract
// ---------------------------------------------------------------------------

test('replayPatch pins the provider and model the adapter registers', () => {
  const text = replayPatch()
  assert.match(text, new RegExp(`provider: ${REPLAY_PROVIDER_ID}`))
  assert.match(text, new RegExp(`model: ${REPLAY_MODEL_ID}`))
  assert.match(text, /name: '@deepseek-ai\/dsh-llm-replay'/)
  assert.match(text, /providers:\n\s+- id: deepseek-official/)
})

test('replayPatch disables the real adapter — the one mandatory row', () => {
  // Without this row the run reaches the network while still looking keyless.
  assert.match(replayPatch(), /- id: llm-deepseek\n  disabled: true/)
})

test('replayPatch keeps the headless runner by default', () => {
  // Disabling it leaves nothing to drive `--json`; the process then hangs
  // instead of exiting. Only an externally driven session wants that.
  const text = replayPatch()
  assert.doesNotMatch(text, /id: headless-runner/)
  assert.doesNotMatch(text, /id: headless-startup/)
})

test('replayPatch can disable the runner for an externally driven session', () => {
  const text = replayPatch({ disableRunner: true })
  assert.match(text, /- id: headless-startup\n  disabled: true/)
  assert.match(text, /- id: headless-runner\n  disabled: true/)
})

test('replayPatch omits the fixture path unless asked', () => {
  // Absent `file` makes replay fall back to $DSH_SNAPSHOT_FILE, so a single
  // patch serves every scenario.
  assert.doesNotMatch(replayPatch(), /file:/)
  assert.match(replayPatch({ fixture: '/tmp/a.jsonl' }), /file: '\/tmp\/a.jsonl'/)
})

test('replayPatch forwards the override and child fixtures', () => {
  const text = replayPatch({ overrideFile: '/tmp/o.json', childFiles: '/tmp/c.json', paceMs: 5 })
  assert.match(text, /overrideFile: '\/tmp\/o.json'/)
  assert.match(text, /childFiles: '\/tmp\/c.json'/)
  assert.match(text, /paceMs: 5/)
})

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

test('replayEnv always scopes DSH_HOME and only sets the paths it is given', () => {
  const bare = replayEnv('C:/home')
  assert.equal(bare.DSH_HOME, 'C:/home')
  assert.equal(bare[SNAPSHOT_FILE_ENV], undefined)

  const pointed = replayEnv('C:/home', { fixture: 'f.jsonl' })
  assert.equal(pointed[SNAPSHOT_FILE_ENV], 'f.jsonl')
})

test('replayEnv does not mutate the base environment', () => {
  const base = { DSH_HOME: 'C:/original' }
  replayEnv('C:/new', { fixture: 'f.jsonl' }, base)
  assert.equal(base.DSH_HOME, 'C:/original')
})

test('replayHome 把 session root 钉在一次性 home 内，不写进工作目录（隔离回归）', () => {
  // 回归：`replayPatch` 的默认 `./.sessions` 由**子进程 cwd** 解析，因此从仓库根
  // 启动的真实回合会把会话日志落进工作树 —— 对一个以隔离为卖点的模块来说这是
  // 泄漏。用例的 home 必须显式钉一个 home 内的绝对路径。
  const home = replayHome()
  try {
    const patch = readFileSync(join(home.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /- id: session-persistence-jsonl\n {2}config:\n {4}root: '/, 'patch 应设置会话根')
    const root = /root: '([^']+)'/.exec(patch)?.[1] ?? ''
    assert.ok(root !== './.sessions', 'session root 不得沿用相对默认值')
    assert.ok(
      root.startsWith(home.homeDir),
      `session root 应位于一次性 home 内：${root} 不在 ${home.homeDir} 下`,
    )
  } finally {
    home.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Real boot: composition
// ---------------------------------------------------------------------------

test('a linked replay package composes into the profile', { skip: missingEnv() }, (t) => {
  const home = replayHome()
  try {
    // `--dump-config` is composition only: it succeeds even when the plugin
    // would fail to activate, so it proves the link and the patch resolve.
    const result = runDsh(home, replayEnv(home.homeDir, {}, process.env), [
      '--profile',
      home.profileName,
      '--dump-config',
    ])
    if (!assertLaunched(t, result)) return
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /- id: llm-replay/)
    assert.match(result.output, /name: '@deepseek-ai\/dsh-llm-replay'/)
  } finally {
    home.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Real boot: the keyless lane
// ---------------------------------------------------------------------------

test('replay failure is the reported fault, not a missing credential', { skip: missingEnv() }, (t) => {
  const home = replayHome()
  try {
    // No fixture anywhere. Booting must fail *because replay could not install*
    // — never with MISSING_CREDENTIAL. That contrast is the proof the keyless
    // lane is real: `llm-deepseek` is genuinely off, so no key is ever sought.
    const result = runDsh(home, replayEnv(home.homeDir, {}, process.env), testHomeArgs(home, { task: 'say hi' }))
    if (!assertLaunched(t, result)) return
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /llm-replay: a fixture path is required/)
    assert.match(result.output, /no adapter registered for provider/)
    assert.doesNotMatch(result.output, /MISSING_CREDENTIAL/)
  } finally {
    home.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Real boot: the fixture contract
// ---------------------------------------------------------------------------

test(
  'a fixture without a `version` field is rejected by the codec',
  { skip: missingEnv(v0Fixture) },
  (t) => {
    const home = replayHome()
    try {
      const result = runDsh(
        home,
        replayEnv(home.homeDir, { fixture: v0Fixture }, process.env),
        testHomeArgs(home, { task: 'say hi' }),
      )
      if (!assertLaunched(t, result)) return
      // v0 projections omit `version`; the codec needs an explicit integer.
      assert.match(result.output, /Session format version must be a non-negative safe integer/)
    } finally {
      home.cleanup()
    }
  },
)

test(
  'a fixture with no recorded model calls fails loudly instead of silently',
  { skip: missingEnv(v3Fixture) },
  (t) => {
    const home = replayHome()
    try {
      const result = runDsh(
        home,
        replayEnv(home.homeDir, { fixture: v3Fixture }, process.env),
        testHomeArgs(home, { task: 'say hi' }),
      )
      if (!assertLaunched(t, result)) return
      // The committed record-suite files are session-snapshot fixtures, not
      // llm-replay scripts: they load, then report zero usable calls. Turning
      // that shortfall into an explicit error is the whole point — a silently
      // truncated replay would be a false green.
      assert.match(result.output, /llm-replay: script exhausted/)
      assert.match(result.output, /re-record the scenario/)
    } finally {
      home.cleanup()
    }
  },
)
