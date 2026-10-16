// Peer range and imports both taken from the real world: the recommended
// EDA-style union, and three symbols that genuinely exist in the recorded
// surfaces for every version of the covered span. This fixture is what makes
// the "real candidate list × real API surfaces" case assert a real green.
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'

export { HarnessError, deadline, defineTool }
