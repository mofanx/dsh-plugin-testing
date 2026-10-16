// Uses one subpath and one symbol that exist on 1.0.0 but not on 2.0.0.
// The same fixture must pass against surface-1.0.0.json and trip DSH-C069
// against surface-2.0.0.json — that pair is the detection-power proof.
import { checkInvariant } from '@deepseek-ai/dsh-llm/invariant'
import { defineTool } from '@deepseek-ai/dsh-tools'

export { checkInvariant, defineTool }
