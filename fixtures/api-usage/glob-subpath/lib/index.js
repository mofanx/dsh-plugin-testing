// The recorded surface legitimately contains patterns such as `./src/*`.
// Comparing a literal import path against those with `===` would report a
// present API as missing.
import { util } from '@deepseek-ai/dsh-llm/src/util'

export { util }
