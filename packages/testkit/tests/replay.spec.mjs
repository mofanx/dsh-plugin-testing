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
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { createTestHome, testHomeArgs } from '../src/home.mjs'
import {
  REPLAY_MODEL_ID,
  REPLAY_PROVIDER_ID,
  SNAPSHOT_FILE_ENV,
  replayEnv,
  replayPatch,
} from '../src/replay.mjs'

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
 * Boot the isolated home and return combined output plus the exit status.
 *
 * @param {ReturnType<typeof createTestHome>} home
 * @param {Record<string, string | undefined>} env
 * @param {string[]} [args]
 * @param {number} [timeout]
 */
function runDsh(home, env, args, timeout = 40_000) {
  const result = spawnSync(process.execPath, [DSH_BIN, ...args], {
    env,
    encoding: 'utf8',
    timeout,
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** Create a home that can host the replay plugin. */
function replayHome(patchOptions = {}) {
  return createTestHome({
    packages: ['@deepseek-ai/dsh-llm-replay'],
    profilePatch: replayPatch(patchOptions),
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

// ---------------------------------------------------------------------------
// Real boot: composition
// ---------------------------------------------------------------------------

test('a linked replay package composes into the profile', { skip: !hasLauncher }, () => {
  const home = replayHome()
  try {
    // `--dump-config` is composition only: it succeeds even when the plugin
    // would fail to activate, so it proves the link and the patch resolve.
    const { status, output } = runDsh(home, replayEnv(home.homeDir, {}, process.env), [
      '--profile',
      home.profileName,
      '--dump-config',
    ])
    assert.equal(status, 0)
    assert.match(output, /- id: llm-replay/)
    assert.match(output, /name: '@deepseek-ai\/dsh-llm-replay'/)
  } finally {
    home.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Real boot: the keyless lane
// ---------------------------------------------------------------------------

test('replay failure is the reported fault, not a missing credential', { skip: !hasLauncher }, () => {
  const home = replayHome()
  try {
    // No fixture anywhere. Booting must fail *because replay could not install*
    // — never with MISSING_CREDENTIAL. That contrast is the proof the keyless
    // lane is real: `llm-deepseek` is genuinely off, so no key is ever sought.
    const { status, output } = runDsh(
      home,
      replayEnv(home.homeDir, {}, process.env),
      testHomeArgs(home, { task: 'say hi' }),
    )
    assert.equal(status, 1, output)
    assert.match(output, /llm-replay: a fixture path is required/)
    assert.match(output, /no adapter registered for provider/)
    assert.doesNotMatch(output, /MISSING_CREDENTIAL/)
  } finally {
    home.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Real boot: the fixture contract
// ---------------------------------------------------------------------------

test(
  'a fixture without a `version` field is rejected by the codec',
  { skip: !hasLauncher || !existsSync(v0Fixture) },
  () => {
    const home = replayHome()
    try {
      const { output } = runDsh(
        home,
        replayEnv(home.homeDir, { fixture: v0Fixture }, process.env),
        testHomeArgs(home, { task: 'say hi' }),
      )
      // v0 projections omit `version`; the codec needs an explicit integer.
      assert.match(output, /Session format version must be a non-negative safe integer/)
    } finally {
      home.cleanup()
    }
  },
)

test(
  'a fixture with no recorded model calls fails loudly instead of silently',
  { skip: !hasLauncher || !existsSync(v3Fixture) },
  () => {
    const home = replayHome()
    try {
      const { output } = runDsh(
        home,
        replayEnv(home.homeDir, { fixture: v3Fixture }, process.env),
        testHomeArgs(home, { task: 'say hi' }),
      )
      // The committed record-suite files are session-snapshot fixtures, not
      // llm-replay scripts: they load, then report zero usable calls. Turning
      // that shortfall into an explicit error is the whole point — a silently
      // truncated replay would be a false green.
      assert.match(output, /llm-replay: script exhausted/)
      assert.match(output, /re-record the scenario/)
    } finally {
      home.cleanup()
    }
  },
)
