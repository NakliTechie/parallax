// The dsh adapter against a stand-in dsh context built from the signatures in plan/research/2026-11-10-dsh-plugin-api.md.
// This checks the wiring, not dsh itself; a run in real dsh is a separate check.
import { test } from 'node:test'
import assert from 'node:assert/strict'

function fakeDsh({ answer = 'Allow for this session' } = {}) {
  const sessions = new Map()
  const agents = new Map()
  const presetOf = new Map()
  const tools = new Map()
  const commands = new Map()
  function makeAgent(id, title, header = {}) {
    const session = { id, header: { cwd: '/work', ...header }, events: [] }
    const inbox = {
      nextTurn: [], nextStep: [],
      replace(messageId, message) {
        const i = this.nextTurn.findIndex(m => m.id === messageId)
        if (i < 0) return false
        this.nextTurn[i] = message
        session.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: i, removedCount: 1, inserted: [message], outcome: 'canceled' } })
        return true
      },
      remove(messageId) {
        const i = this.nextTurn.findIndex(m => m.id === messageId)
        if (i < 0) return false
        this.nextTurn.splice(i, 1)
        session.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: i, removedCount: 1, inserted: [], outcome: 'canceled' } })
        return true
      },
    }
    const agent = {
      id, session, inbox, woke: [],
      send(message, target, wakeup) {
        const list = target === 'next-step' ? inbox.nextStep : inbox.nextTurn
        list.push(message)
        session.events.push({ type: 'agent/inbox/spliced', data: { target, start: list.length - 1, removedCount: 0, inserted: [message] } })
        agent.woke.push(wakeup)
      },
      followup(message) { agent.send(message, 'next-turn', true) },
      claimAll() {
        const claimed = inbox.nextTurn.splice(0)
        session.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: claimed.length, inserted: [] } })
        for (const m of claimed) session.events.push({ type: 'user/message', data: m })
      },
    }
    sessions.set(id, { title, blank: false, header })
    agents.set(id, agent)
    presetOf.set(session, 'default')
    return agent
  }
  let created = 0
  const overrides = (type, field) => ({ overrideOf: session => session.events.filter(e => e.type === type).at(-1)?.data[field] })
  const handlers = new Map()
  let defaultModel = { provider: 'deepseek', model: 'flash' }
  const ctx = {
    asked: [], handlers,
    on: (name, fn, options) => { handlers.set(name, fn); handlers.set(`${name}#options`, options); return () => handlers.delete(name) },
    effect: fn => fn(),
    get: name => ({ agentDefaultModel: { currentSelection: () => defaultModel, saveSelection: async sel => { defaultModel = sel } }, workspaceRegistry: { archivedSessionIds: ['Z'] }, permissionPresets: ctx.permissionPresets, sandboxPolicy: overrides('sandbox/mode', 'mode'), approval: overrides('approval/policy', 'policy') })[name],
    tools: { register: def => { tools.set(def.name, def); return () => tools.delete(def.name) } },
    commands: { register: def => { commands.set(def.name, def); return () => commands.delete(def.name) } },
    agents: { get: id => agents.get(id), roots: () => [...agents.values()].filter(a => a.session.header.origin !== 'subagent') },
    sessions: { flush: async () => true },
    sessionController: {
      list: async () => ({ items: [...sessions].map(([sessionId, s]) => ({ sessionId, running: false, blank: s.blank, origin: s.header.origin, cwd: s.header.cwd ?? '/work', projections: { values: { title: s.title } } })) }),
      resolveAgent: async id => (agents.get(id) ? { agent: agents.get(id) } : { error: { message: 'not found' } }),
      projections: async () => ({ kind: 'sequenced', values: { goal: { goal: { objective: 'Ship', phase: 'active' } }, todos: [{ content: 'test', status: 'pending' }] } }),
      create: async () => { const id = `N${++created}`; makeAgent(id, 'new'); return { sessionId: id } },
      selectModel: async ({ sessionId, provider, model }) => { if (model === 'missing') throw new Error('unknown model'); defaultModel = { provider, model }; env.models.set(sessionId, `${provider}/${model}`); return { selected: { provider, model } } },
    },
    sessionQuery: { readSession: async id => ({ events: agents.get(id)?.session.events ?? [] }), readTitle: async () => undefined },
    userQuestions: { ask: async request => { ctx.asked.push(request); return { answers: [{ id: 'parallax', selected: [typeof answer === 'function' ? answer(request) : answer] }] } } },
    permissionPresets: { current: session => presetOf.get(session), set: (session, name) => presetOf.set(session, name) },
  }
  makeAgent('A', 'Alpha'); makeAgent('B', 'Beta'); makeAgent('O', 'Other folder', { cwd: '/elsewhere' }); makeAgent('S', 'Sub', { origin: 'subagent', delegationDepth: 1 }); makeAgent('Z', 'Archived')
  const env = { ctx, tools, commands, agents, presetOf, models: new Map(), defaultModel: () => defaultModel }
  return env
}

const call = async (env, tool, agentId, args) => JSON.parse((await env.tools.get(tool).execute(args, { agent: env.agents.get(agentId), signal: new AbortController().signal })).json)

async function load() {
  // A fresh module instance per test, because the core lives at module scope.
  return import(`../src/dsh.js?t=${Math.random()}`)
}

test('registers six tools and two person commands', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  assert.deepEqual([...env.tools.keys()], ['peer_list', 'peer_send', 'peer_inbox', 'peer_receipt', 'peer_context', 'peer_delegate'])
  assert.deepEqual([...env.commands.keys()], ['peer', 'peers'])
  assert.match(env.commands.get('peer').input.hint, /busy/, 'without a hint dsh runs /peer with no arguments')
})

test('list hides subagents, archived conversations and other folders; subagent callers are refused', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  const listed = await call(env, 'peer_list', 'A', {})
  assert.deepEqual(listed.conversations.map(c => c.title), ['Beta'])
  assert.equal((await call(env, 'peer_list', 'S', {})).refused, 'subagent')
})

test('send → relay message in the peer inbox → claimed → receipt; reply travels back', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  const sent = await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'request', summary: 'status?' })
  assert.equal(sent.ok, true)
  const queued = env.agents.get('B').inbox.nextTurn[0]
  assert.equal(queued.source.kind, 'peer')
  assert.equal(queued.source.form, 'relay')
  assert.equal(queued.source.senderSessionId, 'A')
  assert.equal(env.agents.get('B').woke[0], true)
  assert.equal((await call(env, 'peer_receipt', 'A', { id: sent.id })).delivery, 'queued')
  env.agents.get('B').claimAll()
  assert.equal((await call(env, 'peer_receipt', 'A', { id: sent.id })).delivery, 'claimed')
  await call(env, 'peer_send', 'B', { to: 'Alpha', kind: 'reply', summary: 'green', replyTo: sent.requestId })
  const receipt = await call(env, 'peer_receipt', 'A', { id: sent.requestId })
  assert.equal(receipt.request, 'answered')
  assert.equal(receipt.reply.summary, 'green')
  assert.ok(env.agents.get('A').session.events.some(e => e.type === 'plugin:dsh-parallax/v1' && e.data.type === 'channel'))
})

test('peer_context shows only what people, peers and the model said', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  env.agents.get('B').session.events.push(
    { type: 'user/message', data: { id: 'u1', content: [{ type: 'text', text: 'person text' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { id: 'u2', content: [{ type: 'text', text: 'runtime note' }], source: { kind: 'runtime-context' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'model text' }] } } })
  const out = await call(env, 'peer_context', 'A', { to: 'Beta' })
  assert.deepEqual(out.messages.map(m => m.text), ['person text', 'model text'])
})

test('cancel removes a queued message from the dsh inbox and reads back as discarded', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  const sent = await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'never mind' })
  assert.equal((await call(env, 'peer_receipt', 'A', { id: sent.id, cancel: true })).result, 'cancelled')
  assert.equal(env.agents.get('B').inbox.nextTurn.length, 0)
})

test('urgent lands in next-step; supersedes swaps the queued dsh message', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'now', urgent: true })
  assert.equal(env.agents.get('B').inbox.nextStep.length, 1)
  const first = await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'v1' })
  const second = await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'v2', supersedes: first.id })
  assert.equal(second.superseded, first.id)
  assert.equal(env.agents.get('B').inbox.nextTurn.length, 1)
  assert.match(env.agents.get('B').inbox.nextTurn[0].content[0].text, /summary: v2/)
})

test('consent ask mode shows one card', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx, { consent: 'ask' })
  await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'hi' })
  await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'hi again' })
  assert.equal(env.ctx.asked.length, 1)
})

test('a restart rehydrates grants from the session log', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'one' })
  ;(await load()).apply(env.ctx, { consent: 'ask' }) // a new module instance: memory is empty, the log is not
  await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'two' })
  assert.equal(env.ctx.asked.length, 0, 'the grant from the log is reused, so no card even in ask mode')
})

test('delegate: preset copied and read back, narrower preset accepted, wider refused, refused when read-back differs', async () => {
  const env = fakeDsh()
  env.ctx.permissionPresets.names = ['read-only', 'workspace', 'full']
  env.ctx.permissionPresets.resolve = name => ({ 'read-only': { sandbox: 'read-only', approval: 'ask' }, workspace: { sandbox: 'workspace-write', approval: 'ask' }, full: { sandbox: 'danger-full-access', approval: 'ask' } })[name]
  ;(await load()).apply(env.ctx)
  env.presetOf.set(env.agents.get('A').session, 'read-only')
  const out = await call(env, 'peer_delegate', 'A', { task: 'Summarise the README' })
  assert.equal(out.ok, true)
  const child = env.agents.get(out.childId)
  assert.equal(env.presetOf.get(child.session), 'read-only')
  assert.match(child.inbox.nextTurn[0].content[0].text, /delegated task/)
  env.presetOf.set(env.agents.get('A').session, 'workspace')
  const narrower = await call(env, 'peer_delegate', 'A', { task: 'Read only please', permission: 'read-only' })
  assert.equal(env.presetOf.get(env.agents.get(narrower.childId).session), 'read-only')
  assert.equal((await call(env, 'peer_delegate', 'A', { task: 'Wider', permission: 'full' })).refused, 'not_started')
  // dsh's access-mode picker leaves a sandbox and approval override on the caller; the child gets the same, narrowed by a preset.
  const caller = env.agents.get('A').session
  caller.events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }, { type: 'approval/policy', data: { policy: 'never' } })
  const copied = await call(env, 'peer_delegate', 'A', { task: 'Copy my overrides' })
  const copiedChild = env.agents.get(copied.childId).session
  assert.equal(env.ctx.get('sandboxPolicy').overrideOf(copiedChild), 'danger-full-access')
  assert.equal(env.ctx.get('approval').overrideOf(copiedChild), 'never')
  const narrowed = await call(env, 'peer_delegate', 'A', { task: 'Narrow me', permission: 'read-only' })
  assert.equal(env.ctx.get('sandboxPolicy').overrideOf(env.agents.get(narrowed.childId).session), 'read-only')
  env.ctx.permissionPresets.set = () => {} // a host that ignores the write
  const refused = await call(env, 'peer_delegate', 'A', { task: 'Again' })
  assert.equal(refused.refused, 'not_started')
})

test('/peer commands: connect skips the card; wake never stops waking', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  const connect = await env.commands.get('peer').handler({ agent: env.agents.get('A'), rawInput: ' connect Beta session' })
  assert.equal(connect.kind, 'success')
  await env.commands.get('peer').handler({ agent: env.agents.get('B'), rawInput: ' wake never' })
  await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'quiet' })
  assert.equal(env.ctx.asked.length, 0)
  assert.equal(env.agents.get('B').woke.at(-1), false)
  assert.equal((await env.commands.get('peer').handler({ agent: env.agents.get('A'), rawInput: 'bogus' })).kind, 'error')
})

test('approval relay: a child\'s prompt is answered by the parent\'s person; a closed card falls back to the child', async () => {
  const env = fakeDsh({ answer: request => (request.questions[0].header === 'Delegated conversation needs approval' ? 'Allow once' : 'Allow for this session') })
  ;(await load()).apply(env.ctx)
  const out = await call(env, 'peer_delegate', 'A', { task: 'Needs a shell' })
  const relay = env.ctx.handlers.get('approval/request')
  assert.equal(env.ctx.handlers.get('approval/request#options')?.global, true, 'a scoped listener never sees another conversation\'s request')
  assert.equal(env.ctx.handlers.get('agent/status#options')?.global, true)
  const child = env.agents.get(out.childId)
  assert.equal(await relay({ agent: child, toolName: 'bash', reason: 'clean build/' }, async () => 'unavailable'), 'allowed-once')
  const card = env.ctx.asked.at(-1)
  assert.equal(card.agent, env.agents.get('A'), 'the card shows in the parent')
  assert.match(card.questions[0].question, /run bash/)
  env.ctx.userQuestions.ask = async () => ({ answers: [] })
  assert.equal(await relay({ agent: child, toolName: 'bash' }, async () => 'rejected'), 'rejected', 'no answer in the parent: the child decides')
  assert.equal(await relay({ agent: env.agents.get('B'), toolName: 'bash' }, async () => 'from-child'), 'from-child', 'not a delegated child: untouched')
})

test('human first in dsh: busy while running or with a person message pending; idle releases one', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  await env.commands.get('peer').handler({ agent: env.agents.get('B'), rawInput: ' busy human-first' })
  env.agents.get('B').status = 'running'
  const held = await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'later' })
  assert.match(held.state, /held/)
  assert.equal(env.agents.get('B').inbox.nextTurn.length, 0)
  env.agents.get('B').status = 'idle'
  env.ctx.handlers.get('agent/status')({ agent: env.agents.get('B'), status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(env.agents.get('B').inbox.nextTurn.length, 1)
})

test('delegate with a model: selected for the child, the person\'s default restored, unknown or disallowed refused', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx, { models: ['deepseek/pro', 'deepseek/missing'] })
  const out = await call(env, 'peer_delegate', 'A', { task: 'Think hard', model: 'deepseek/pro', acceptance: ['answer is a number'] })
  assert.equal(out.model, 'deepseek/pro')
  assert.equal(env.models.get(out.childId), 'deepseek/pro')
  assert.deepEqual(env.defaultModel(), { provider: 'deepseek', model: 'flash' })
  assert.match(env.agents.get(out.childId).inbox.nextTurn[0].content[0].text, /Done means[\s\S]*answer is a number/)
  assert.equal((await call(env, 'peer_delegate', 'A', { task: 'x', model: 'openai/gpt' })).refused, 'not_started')
  assert.equal((await call(env, 'peer_delegate', 'A', { task: 'x', model: 'deepseek/missing' })).refused, 'not_started')
  assert.deepEqual(env.defaultModel(), { provider: 'deepseek', model: 'flash' })
})
