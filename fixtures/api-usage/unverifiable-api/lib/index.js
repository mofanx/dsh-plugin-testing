// Namespace and dynamic imports name no symbol the surface can be compared
// against. They must be reported as 未能核验, never counted as satisfied.
import * as llm from '@deepseek-ai/dsh-llm'

export async function load() {
  const tools = await import('@deepseek-ai/dsh-tools')
  return { llm, tools }
}
