/**
 * T25 — keyless model replay.
 *
 * The patch emitted here is the recipe the harness itself uses
 * (`deepseek-harness/apps/cli/tests/profiles/headless/goal-snapshot.patch.yml`),
 * reduced to the parts a plugin test needs. Three of those parts are not
 * optional and are easy to get wrong:
 *
 * 1. **`llm-deepseek` must be disabled.** Without it the real adapter stays
 *    registered and the run reaches the network — a test that looks keyless but
 *    is not.
 * 2. **`agent-loop` must pin provider *and* model** to the pair the replay
 *    adapter registers; replay serves exactly that route.
 * 3. **`headless-runner` handling depends on the driver.** The harness disables
 *    `headless-startup` / `headless-runner` because its own snapshot driver
 *    consumes the prompt; a plugin test that just runs `dsh --json "<task>"`
 *    must **keep** them, or nothing drives the session and the process hangs
 *    instead of exiting. Hence `disableRunner` defaults to **false** here.
 *
 * `dsh-llm-replay` reads its fixture from `config.file`, falling back to
 * `$DSH_SNAPSHOT_FILE`. Prefer the env var: one patch then serves every
 * scenario, and the fixture path never has to be baked into YAML.
 *
 * ⚠️ `sessionRoot` is passed to the child verbatim and the host resolves it
 * against the **child process's cwd**, not against the isolated home. The
 * `./.sessions` default therefore drops session logs into whatever directory the
 * launcher was started from. Callers that care about isolation should pass an
 * absolute path inside their throwaway home.
 *
 * Recording is **not** replay's job — `@deepseek-ai/dsh-session-snapshot`
 * records. Replay only plays back a fixture that already exists.
 *
 * @module dsh-plugin-testkit/replay
 */

/** Provider route the replay adapter registers by default. */
export const REPLAY_PROVIDER_ID = 'deepseek-official'

/** Model id the agent loop is pinned to by default. */
export const REPLAY_MODEL_ID = 'deepseek-v4-flash'

/** Environment variable `dsh-llm-replay` reads when `config.file` is absent. */
export const SNAPSHOT_FILE_ENV = 'DSH_SNAPSHOT_FILE'

/** Environment variable for the companion `replay.override.json`. */
export const SNAPSHOT_OVERRIDE_ENV = 'DSH_SNAPSHOT_OVERRIDE'

/** Environment variable for recorded subagent child sessions. */
export const SNAPSHOT_CHILD_FILES_ENV = 'DSH_SNAPSHOT_CHILD_FILES'

/**
 * Build the replay patch text for a test profile.
 *
 * @param {{
 *   provider?: string,
 *   model?: string,
 *   fixture?: string,
 *   overrideFile?: string,
 *   childFiles?: string,
 *   sessionRoot?: string,
 *   paceMs?: number,
 *   disableRunner?: boolean,
 * }} [options]
 * @returns {string}
 */
export function replayPatch(options = {}) {
  const provider = options.provider ?? REPLAY_PROVIDER_ID
  const model = options.model ?? REPLAY_MODEL_ID
  const sessionRoot = options.sessionRoot ?? './.sessions'

  const replayConfig = ['        providers:', `          - id: ${provider}`]
  if (options.fixture !== undefined) replayConfig.push(`        file: '${options.fixture}'`)
  if (options.overrideFile !== undefined) replayConfig.push(`        overrideFile: '${options.overrideFile}'`)
  if (options.childFiles !== undefined) replayConfig.push(`        childFiles: '${options.childFiles}'`)
  if (options.paceMs !== undefined) replayConfig.push(`        paceMs: ${options.paceMs}`)

  // Only an externally-driven session (the snapshot harness) disables these.
  const runnerRows = options.disableRunner
    ? ['- id: headless-startup', '  disabled: true', '', '- id: headless-runner', '  disabled: true', '']
    : []

  return (
    [
      '# Replay-backed test patch: no network, deterministic model stream.',
      ...runnerRows,
      '# The real adapter MUST be off, or this run would reach the network.',
      '- id: llm-deepseek',
      '  disabled: true',
      '',
      '- id: agent-loop',
      '  config:',
      '    agents:',
      '      - id: main',
      `        provider: ${provider}`,
      `        model: ${model}`,
      '        cwd: !!js process.cwd()',
      '',
      '- id: session-persistence-jsonl',
      '  config:',
      `    root: '${sessionRoot}'`,
      '    compression: none',
      '',
      '# Replay registers a replay-only adapter serving exactly this provider.',
      '- insert:',
      '    - id: llm-replay',
      "      name: '@deepseek-ai/dsh-llm-replay'",
      '      config:',
      ...replayConfig,
      '',
      '- id: session-log-deepseek',
      '  config:',
      '    enabled: false',
      '',
    ].join('\n')
  )
}

/**
 * Environment overrides that point a replay run at a fixture.
 *
 * @param {string} homeDir
 * @param {{ fixture?: string, overrideFile?: string, childFiles?: string }} [paths]
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function replayEnv(homeDir, paths = {}, base = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...base, DSH_HOME: homeDir }
  if (paths.fixture !== undefined) env[SNAPSHOT_FILE_ENV] = paths.fixture
  if (paths.overrideFile !== undefined) env[SNAPSHOT_OVERRIDE_ENV] = paths.overrideFile
  if (paths.childFiles !== undefined) env[SNAPSHOT_CHILD_FILES_ENV] = paths.childFiles
  return env
}
