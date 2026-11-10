// DeepSeek Harness (dsh) adapter: a Cordis plugin that registers Parlella's six tools and its /peer commands.
// All behaviour lives in core.js; this file only maps dsh's context services onto the core's `host` object.
// API facts and their source lines: plan/research/2026-11-10-dsh-plugin-api.md (dsh v0.2.1-rc.5).

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { Parlella } from './core.js'
import { TOOLS } from './manifest.js'
import { aliasOf, clip } from './stamp.js'

export const name = 'dsh-parlella'
export const inject = ['tools', 'agents', 'sessions', 'sessionController', 'sessionQuery', 'userQuestions', 'commands']

const RECORD = 'plugin:dsh-parlella/v1'
const SOURCE_KIND = 'peer'
const textOf = content => (Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : typeof content === 'string' ? content : '')
const isRootHeader = header => header?.origin !== 'subagent' && !header?.delegationDepth

// One core per plugin instance; a re-apply in the same realm keeps channels (module scope).
let shared

export function apply(ctx, config = {}) {
  const hydrated = new Set()

  async function readEvents(sessionId) {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    return snapshot?.events ?? []
  }

  async function liveAgent(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live) return live
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if (!resolved?.agent) throw new Error(resolved?.error?.message ?? `conversation ${aliasOf(sessionId)} could not be opened`)
    return resolved.agent
  }

  const host = {
    now: () => Date.now(),
    randomId: () => globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12),

    async list() {
      const { items } = await ctx.sessionController.list({}, AbortSignal.timeout(10_000))
      const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
      const rows = items.filter(row => !row.blank && row.origin !== 'subagent' && !row.parentSessionId && !archived.has(row.sessionId))
      return Promise.all(rows.map(async row => {
        let title = row.projections?.values?.title
        if (!title) { try { title = (await ctx.sessionQuery.readTitle(row.sessionId))?.title } catch { /* untitled */ } }
        return { id: row.sessionId, title: title || `conversation ${aliasOf(row.sessionId)}`, running: Boolean(row.running) }
      }))
    },

    async askPerson(sessionId, card, signal) {
      const agent = ctx.agents.get(sessionId)
      const result = await ctx.userQuestions.ask({
        questions: [{ id: 'parlella', header: card.header, question: card.question, detail: card.detail, options: card.options.map(label => ({ label })) }],
        ...(agent ? { agent } : {}),
        signal,
      })
      const answer = result?.answers?.find(a => a.id === 'parlella')
      // Free text never grants anything: only one selected option counts.
      return answer && !answer.custom?.trim() && answer.selected?.length === 1 ? answer.selected[0] : undefined
    },

    async deliver(toId, { text, wakeup, meta }) {
      const agent = await liveAgent(toId)
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: SOURCE_KIND, form: 'relay', senderSessionId: meta.from, parlellaId: meta.parlellaId, peerKind: meta.kind, hop: meta.hop,
          ...(meta.requestId ? { requestId: meta.requestId } : {}), ...(meta.replyTo ? { replyTo: meta.replyTo } : {}) },
      })
      agent.send(message, 'next-turn', wakeup)
      try { await ctx.sessions.flush(agent.session) } catch { /* the inbox splice is still in memory; the receipt reads it */ }
      return { messageId: message.id }
    },

    // queued: still in the inbox. claimed: taken into a turn (or entered the log). discarded: cancelled.
    async deliveryState(toId, messageId) {
      const live = ctx.agents.get(toId)
      if (live && [...live.inbox.nextTurn, ...live.inbox.nextStep].some(m => m.id === messageId)) return 'queued'
      const lists = { 'next-turn': [], 'next-step': [] }
      let state = 'unknown'
      for (const event of await readEvents(toId)) {
        if (event.type === 'user/message' && event.data?.id === messageId) return 'claimed'
        if (event.type !== 'agent/inbox/spliced') continue
        const list = lists[event.data?.target] ?? []
        const removed = list.splice(event.data.start ?? 0, event.data.removedCount ?? 0, ...(event.data.inserted ?? []).map(m => m.id))
        if (event.data.inserted?.some(m => m.id === messageId)) state = 'queued'
        if (removed.includes(messageId)) state = event.data.outcome === 'canceled' ? 'discarded' : 'claimed'
      }
      return state
    },

    async withdraw(toId, messageId) {
      const agent = ctx.agents.get(toId)
      if (!agent) return false
      const removed = agent.inbox.remove(messageId)
      if (removed) { try { await ctx.sessions.flush(agent.session) } catch { /* removal already applied in memory */ } }
      return removed
    },

    async context(toId, { view, maxMessages }) {
      const out = {}
      const projections = await ctx.sessionController.projections({ sessionId: toId }, AbortSignal.timeout(10_000))
      const values = projections?.values ?? {}
      if (values.goal?.goal?.objective) out.goal = `${values.goal.goal.objective} (${values.goal.goal.phase ?? 'active'})`
      if (Array.isArray(values.todos)) out.todos = values.todos.map(t => ({ text: t.content, done: t.status === 'completed' }))
      const events = await readEvents(toId)
      if (view === 'activity') {
        out.activity = events.filter(e => e.type === 'tool/result' || e.type === 'tool/call').slice(-maxMessages)
          .map(e => clip(`${e.type} ${e.data?.name ?? e.data?.call?.name ?? ''}`.trim(), 200))
      } else {
        out.messages = events.filter(e => e.type === 'user/message' || e.type === 'assistant/message').slice(-maxMessages).map(e => (
          e.type === 'user/message'
            ? { role: 'user', text: textOf(e.data?.content) }
            : { role: 'assistant', text: textOf(e.data?.message?.content) }))
      }
      return out
    },

    // A new top-level conversation with the caller's permission preset, read back before its first turn.
    async delegate(callerId, { task, title }) {
      const presets = ctx.get('permissionPresets')
      if (!presets) return { refused: 'This host has no permission presets, so Parlella cannot clamp a new conversation\'s permissions.' }
      const caller = await liveAgent(callerId)
      const sandboxOverride = ctx.get('sandboxPolicy')?.overrideOf?.(caller.session)
      const approvalOverride = ctx.get('approval')?.overrideOf?.(caller.session)
      if (sandboxOverride !== undefined || approvalOverride !== undefined) {
        return { refused: 'This conversation has its own sandbox or approval override, which Parlella cannot copy exactly yet. Delegation is refused rather than widened.' }
      }
      const preset = presets.current(caller.session)
      const created = await ctx.sessionController.create({ cwd: caller.session.header?.cwd })
      const child = await liveAgent(created.sessionId)
      presets.set(child.session, preset)
      if (presets.current(child.session) !== preset) return { refused: 'The new conversation\'s permissions did not read back as this conversation\'s, so it was not started.' }
      const callerTitle = (await host.list()).find(row => row.id === callerId)?.title ?? 'a conversation'
      child.followup(createUserMessage({
        content: [{ type: 'text', text: [
          `[parlella · delegated task · approved by the person in "${callerTitle}" (${aliasOf(callerId)})]`,
          `Title: ${title}`, '', task, '',
          `When you finish or need a decision, report with peer_send to "${aliasOf(callerId)}".`,
        ].join('\n') }],
        source: { kind: SOURCE_KIND, form: 'relay', senderSessionId: callerId, peerKind: 'delegate' },
      }))
      try { await ctx.sessions.flush(child.session) } catch { /* followup already queued */ }
      return { childId: created.sessionId }
    },

    async record(sessionId, data) {
      const agent = ctx.agents.get(sessionId) ?? (await liveAgent(sessionId))
      appendPluginRecord(agent.session, RECORD, data)
      await ctx.sessions.flush(agent.session)
    },
  }

  shared ??= new Parlella(host, { defaultWake: config.defaultWake })
  shared.host = host
  const core = shared

  // Grants live in the log of the conversation whose person approved them, so read every reachable log once.
  async function hydrateAll() {
    for (const row of await host.list()) {
      if (hydrated.has(row.id)) continue
      hydrated.add(row.id)
      try {
        const records = (await readEvents(row.id)).map(pluginRecordOf).filter(r => r?.type === RECORD).map(r => r.data)
        core.hydrate(row.id, records)
      } catch { hydrated.delete(row.id) }
    }
  }

  const callerOf = exec => ({
    sessionId: exec.agent?.id,
    root: Boolean(exec.agent) && isRootHeader(exec.agent.session?.header) && (ctx.agents.roots?.() ?? [exec.agent]).some(a => a.id === exec.agent.id),
    signal: exec.signal,
  })

  for (const tool of TOOLS) {
    const parameters = Object.fromEntries(Object.entries(tool.parameters).map(([key, spec]) => [key, { ...spec, required: Boolean(spec.required) }]))
    ctx.effect(() => ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.json }],
      },
      async execute(args, exec) {
        await hydrateAll()
        const result = await core[tool.name](callerOf(exec), args ?? {})
        return { json: JSON.stringify(result, null, 1) }
      },
    })), `${name}: ${tool.name}`)
  }

  // Person-only acts. Commands come from the composer, never from the model's tool registry.
  ctx.effect(() => ctx.commands.register({
    name: 'peer',
    description: 'Peer conversations: /peer connect <peer> [once|session] · /peer revoke <peer> · /peer wake <always|replies|never>',
    async handler({ agent, rawInput }) {
      await hydrateAll()
      const [verb, ...rest] = String(rawInput ?? '').trim().split(/\s+/)
      let result
      if (verb === 'connect') {
        const tier = rest.at(-1) === 'once' || rest.at(-1) === 'session' ? rest.pop() : 'session'
        result = await core.personConnect(agent.id, rest.join(' '), tier)
      } else if (verb === 'revoke') result = await core.personRevoke(agent.id, rest.join(' '))
      else if (verb === 'wake') result = await core.personSetWake(agent.id, rest[0])
      else return { kind: 'error', text: 'Use /peer connect <peer> [once|session], /peer revoke <peer> or /peer wake <always|replies|never>.' }
      return result.ok ? { kind: 'success', text: JSON.stringify(result) } : { kind: 'error', text: result.message }
    },
  }), `${name}: /peer`)

  ctx.effect(() => ctx.commands.register({
    name: 'peers',
    description: 'List peer conversations, open channels and waiting requests for this conversation.',
    async handler({ agent }) {
      await hydrateAll()
      const result = await core.peer_list({ sessionId: agent.id, root: true })
      return { kind: 'success', text: JSON.stringify(result, null, 1) }
    },
  }), `${name}: /peers`)
}
