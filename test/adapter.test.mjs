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
        inbox.nextTurn.push(message)
        session.events.push({ type: 'agent/inbox/spliced', data: { target, start: inbox.nextTurn.length - 1, removedCount: 0, inserted: [message] } })
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
  const ctx = {
    asked: [],
    effect: fn => fn(),
    get: name => ({ workspaceRegistry: { archivedSessionIds: ['Z'] }, permissionPresets: ctx.permissionPresets })[name],
    tools: { register: def => { tools.set(def.name, def); return () => tools.delete(def.name) } },
    commands: { register: def => { commands.set(def.name, def); return () => commands.delete(def.name) } },
    agents: { get: id => agents.get(id), roots: () => [...agents.values()].filter(a => a.session.header.origin !== 'subagent') },
    sessions: { flush: async () => true },
    sessionController: {
      list: async () => ({ items: [...sessions].map(([sessionId, s]) => ({ sessionId, running: false, blank: s.blank, origin: s.header.origin, projections: { values: { title: s.title } } })) }),
      resolveAgent: async id => (agents.get(id) ? { agent: agents.get(id) } : { error: { message: 'not found' } }),
      projections: async () => ({ kind: 'sequenced', values: { goal: { goal: { objective: 'Ship', phase: 'active' } }, todos: [{ content: 'test', status: 'pending' }] } }),
      create: async () => { const id = `N${++created}`; makeAgent(id, 'new'); return { sessionId: id } },
    },
    sessionQuery: { readSession: async id => ({ events: agents.get(id)?.session.events ?? [] }), readTitle: async () => undefined },
    userQuestions: { ask: async request => { ctx.asked.push(request); return { answers: [{ id: 'parlella', selected: [typeof answer === 'function' ? answer(request) : answer] }] } } },
    permissionPresets: { current: session => presetOf.get(session), set: (session, name) => presetOf.set(session, name) },
  }
  makeAgent('A', 'Alpha'); makeAgent('B', 'Beta'); makeAgent('S', 'Sub', { origin: 'subagent', delegationDepth: 1 }); makeAgent('Z', 'Archived')
  return { ctx, tools, commands, agents, presetOf }
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
})

test('list hides subagents and archived conversations; subagent callers are refused', async () => {
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
  assert.ok(env.agents.get('A').session.events.some(e => e.type === 'plugin:dsh-parlella/v1' && e.data.type === 'channel'))
})

test('cancel removes a queued message from the dsh inbox and reads back as discarded', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  const sent = await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'never mind' })
  assert.equal((await call(env, 'peer_receipt', 'A', { id: sent.id, cancel: true })).result, 'cancelled')
  assert.equal(env.agents.get('B').inbox.nextTurn.length, 0)
})

test('a restart rehydrates grants from the session log', async () => {
  const env = fakeDsh()
  ;(await load()).apply(env.ctx)
  await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'one' })
  ;(await load()).apply(env.ctx) // a new module instance: memory is empty, the log is not
  await call(env, 'peer_send', 'A', { to: 'Beta', kind: 'notice', summary: 'two' })
  assert.equal(env.ctx.asked.length, 1, 'no second consent card after a restart')
})

test('delegate: approval, preset copied and read back, first turn queued; refused when read-back differs', async () => {
  const env = fakeDsh({ answer: request => (request.questions[0].header === 'Delegate a task' ? 'Start it' : 'Allow for this session') })
  ;(await load()).apply(env.ctx)
  env.presetOf.set(env.agents.get('A').session, 'read-only')
  const out = await call(env, 'peer_delegate', 'A', { task: 'Summarise the README' })
  assert.equal(out.ok, true)
  const child = env.agents.get(out.childId)
  assert.equal(env.presetOf.get(child.session), 'read-only')
  assert.match(child.inbox.nextTurn[0].content[0].text, /delegated task/)
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
