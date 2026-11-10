// Resolve dsh's packages to small stand-ins, so the adapter loads in plain node without dsh installed.
const map = {
  '@deepseek-ai/dsh-tools': new URL('./dsh-tools.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-llm': new URL('./dsh-llm.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-session': new URL('./dsh-session.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-sandbox-policy': new URL('./dsh-sandbox-policy.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-user-approval': new URL('./dsh-user-approval.mjs', import.meta.url).href,
}
export async function resolve(specifier, context, next) {
  return map[specifier] ? { url: map[specifier], shortCircuit: true } : next(specifier, context)
}
