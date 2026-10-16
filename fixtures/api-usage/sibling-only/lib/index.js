// Imports only a sibling plugin package, which is not a host API. It appears in
// no surface, so it must be reported as out-of-scope rather than missing — the
// false-positive case that would otherwise fire on every monorepo.
import { helper } from '@deepseek-ai/dsh-plugin-mine'

export { helper }
