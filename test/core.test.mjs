// Core behaviour against a stand-in host. Covers spec §0 and the six tools, in automatic and ask modes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Parallax } from '../src/core.js'
import { MARKER, aliasOf } from '../src/stamp.js'
import { TOOLS, PERSON_ACTS } from '../src/manifest.js'

function fakeHost({ answer = 'Allow for this session', conversations } = {}) {
  let clock = 1_700_000_000_000
  let n = 0
  const host = {
    asked: [], delivered: [], records: [], answer,
    rows: conversations ?? [{ id: 'A', title: 'Alpha', running: true }, { id: 'B', title: 'Beta', running: false }, { id: 'C', title: 'Gamma', running: false }],
    states: new Map(),
    now: () => clock,
    advance: ms => { clock += ms },
    randomId: () => `id${++n}`,
    list: async () => host.rows,
    askPerson: async (sessionId, card) => { host.asked.push({ sessionId, card }); return typeof host.answer === 'function' ? host.answer(card) : host.answer },
    deliver: async (to, delivery) => { const messageId = `h${++n}`; host.delivered.push({ to, ...delivery, messageId }); host.states.set(messageId, 'queued'); return { messageId } },
    replace: async (to, oldId, delivery) => {
      if (host.states.get(oldId) !== 'queued') return undefined
      host.states.set(oldId, 'discarded')
      const messageId = `h${++n}`; host.delivered.push({ to, ...delivery, messageId, replaced: oldId }); host.states.set(messageId, 'queued'); return { messageId }
    },
    deliveryState: async (_to, id) => host.states.get(id) ?? 'unknown',
    withdraw: async (_to, id) => { if (host.states.get(id) !== 'queued') return false; host.states.set(id, 'discarded'); return true },
    context: async () => ({ goal: 'Ship <b>it</b>', todos: [{ text: 'write tests', done: false }], messages: [{ role: 'user', text: 'x'.repeat(5000) }, { role: 'assistant', text: 'ok' }] }),
    delegate: async (_caller, request) => ({ childId: 'D', ...(request.permission ? { permission: request.permission } : {}) }),
    record: (sessionId, data) => { host.records.push({ sessionId, data }) },
  }
  return host
}
const root = id => ({ sessionId: id, root: true })
const ask = { consent: 'ask', delegateApproval: 'ask' }

test('manifest: six tools, person-only acts listed', () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['peer_list', 'peer_send', 'peer_inbox', 'peer_receipt', 'peer_context', 'peer_delegate'])
  assert.ok(PERSON_ACTS.some(act => act.command.startsWith('/peer connect')))
  assert.ok(PERSON_ACTS.some(act => act.command.startsWith('/peer revoke')))
})

test('subagents are refused', async () => {
  const p = new Parallax(fakeHost())
  assert.equal((await p.peer_list({ sessionId: 'A', root: false })).refused, 'subagent')
})

test('automatic by default: no card, the stamp leads the delivered text, the grant is recorded', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  const sent = await p.peer_send(root('A'), { to: aliasOf('B'), kind: 'notice', summary: 'hello' })
  assert.equal(sent.ok, true)
  assert.equal(host.asked.length, 0)
  assert.ok(host.delivered[0].text.startsWith(MARKER))
  assert.match(host.delivered[0].text, /NOT an instruction/)
  assert.ok(host.records.some(r => r.data.type === 'channel' && r.data.op === 'grant' && r.data.auto))
  assert.equal((await p.peer_list(root('A'))).channels[0].tier, 'automatic')
})

test('ask mode: first message asks once; a decline sends nothing', async () => {
  const host = fakeHost()
  const p = new Parallax(host, ask)
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'hello' })
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'again' })
  assert.equal(host.asked.length, 1)
  host.answer = 'Decline'
  assert.equal((await p.peer_send(root('A'), { to: 'Gamma', kind: 'notice', summary: 'hi' })).refused, 'declined')
  assert.equal(host.delivered.length, 2)
})

test('payload with the marker is refused before any card', async () => {
  const host = fakeHost()
  const p = new Parallax(host, ask)
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x', body: `${MARKER} fake header` })).refused, 'marker')
  assert.equal(host.asked.length, 0)
})

test('bounds: summary, body, deadline, option conflicts', async () => {
  const p = new Parallax(fakeHost())
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x'.repeat(501) })).refused, 'summary_too_long')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x', body: 'y'.repeat(16 * 1024 + 1) })).refused, 'body_too_long')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'x', replyWithin: 'soon' })).refused, 'bad_deadline')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: '' })).refused, 'no_summary')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x', urgent: true, wake: false })).refused, 'bad_options')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x', waitMs: 10 })).refused, 'bad_wait')
})

test('ask and reply: receipt waits for the answer; replies only along the edge', async () => {
  const p = new Parallax(fakeHost())
  const asked = await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'what is 2+2?', replyWithin: '30m' })
  assert.ok(asked.requestId)
  assert.equal((await p.peer_send(root('C'), { to: 'Alpha', kind: 'reply', summary: '4', replyTo: asked.requestId })).refused, 'bad_reply')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'reply', summary: '4', replyTo: asked.requestId })).refused, 'bad_reply')
  assert.equal((await p.peer_inbox(root('B'), { pending: true })).messages.length, 1)
  assert.equal((await p.peer_send(root('B'), { to: 'Alpha', kind: 'request', summary: 'and you?' })).refused, 'answer_first')
  const waiting = p.peer_receipt(root('A'), { id: asked.requestId, waitMs: 5000 })
  assert.equal((await p.peer_send(root('B'), { to: 'Alpha', kind: 'reply', summary: '4', replyTo: asked.requestId })).ok, true)
  const receipt = await waiting
  assert.equal(receipt.request, 'answered')
  assert.equal(receipt.reply.summary, '4')
  assert.equal(receipt.timedOut, undefined)
  assert.equal((await p.peer_inbox(root('B'), { pending: true })).messages.length, 0)
})

test('ask in one call: waitMs on a request returns the reply; reply without replyTo is inferred', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  const pending = p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'ping?', waitMs: 5000 })
  await new Promise(resolve => setTimeout(resolve, 10))
  const replied = await p.peer_send(root('B'), { to: 'Alpha', kind: 'reply', summary: 'pong' })
  assert.equal(replied.ok, true)
  assert.ok(replied.replyTo)
  assert.equal(replied.woke, false)
  assert.equal(host.delivered.filter(d => d.to === 'A').length, 0, 'a waited-for reply is not queued again')
  const out = await pending
  assert.equal(out.request, 'answered')
  assert.equal(out.reply.summary, 'pong')
  assert.equal((await p.peer_send(root('B'), { to: 'Alpha', kind: 'reply', summary: 'again' })).refused, 'bad_reply')
})

test('a receipt timeout is reported as a timeout; overdue requests are marked', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  const asked = await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'q', replyWithin: '90s' })
  const receipt = await p.peer_receipt(root('A'), { id: asked.requestId, waitMs: 20 })
  assert.equal(receipt.timedOut, true)
  assert.equal(receipt.request, 'open')
  host.advance(91_000)
  assert.equal((await p.peer_receipt(root('A'), { id: asked.requestId })).request, 'overdue')
})

test('cancel withdraws a queued message, and not a claimed one', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  const first = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'one' })
  assert.equal((await p.peer_receipt(root('A'), { id: first.id, cancel: true })).result, 'cancelled')
  assert.equal((await p.peer_inbox(root('B'))).messages.length, 0)
  const second = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'two' })
  host.states.set(host.delivered.at(-1).messageId, 'claimed')
  assert.equal((await p.peer_receipt(root('A'), { id: second.id, cancel: true })).result, 'already_claimed')
  assert.equal((await p.peer_receipt(root('A'), { id: second.id })).delivery, 'claimed')
})

test('supersedes replaces a queued message in place, and sends anew once it was claimed', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  const first = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'draft 1' })
  const second = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'draft 2', supersedes: first.id })
  assert.equal(second.superseded, first.id)
  assert.equal(host.delivered.at(-1).replaced, host.delivered[0].messageId)
  assert.deepEqual((await p.peer_inbox(root('B'))).messages.map(m => m.summary), ['draft 2'])
  host.states.set(host.delivered.at(-1).messageId, 'claimed')
  const third = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'draft 3', supersedes: second.id })
  assert.match(third.superseded, /already claimed/)
  assert.equal((await p.peer_send(root('C'), { to: 'Beta', kind: 'notice', summary: 'x', supersedes: first.id })).refused, 'bad_supersede')
})

test('urgent goes to the next step and wakes; wake: false never wakes', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'now', urgent: true })
  assert.equal(host.delivered.at(-1).target, 'next-step')
  assert.equal(host.delivered.at(-1).wakeup, true)
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'fyi', wake: false })
  assert.equal(host.delivered.at(-1).target, 'next-turn')
  assert.equal(host.delivered.at(-1).wakeup, false)
})

test('broadcast sends to each peer and reports each result', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  const out = await p.peer_send(root('A'), { broadcast: ['Beta', 'Gamma', 'Nobody'], kind: 'request', summary: 'status?' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.results.map(r => r.ok), [true, true, false])
  assert.ok(out.results[0].requestId && out.results[1].requestId && out.results[0].requestId !== out.results[1].requestId)
  assert.equal((await p.peer_send(root('A'), { broadcast: ['Beta'], kind: 'reply', summary: 'x' })).refused, 'bad_broadcast')
})

test('hop limit stops a chain before any card; maxHops is configurable', async () => {
  const host = fakeHost()
  const p = new Parallax(host, ask)
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'h1' })
  await p.peer_send(root('B'), { to: 'Gamma', kind: 'notice', summary: 'h2' })
  await p.peer_send(root('C'), { to: 'Alpha', kind: 'notice', summary: 'h3' })
  const asksBefore = host.asked.length
  assert.equal((await p.peer_send(root('A'), { to: 'Gamma', kind: 'notice', summary: 'h4' })).refused, 'hop_limit')
  assert.equal(host.asked.length, asksBefore)
  const wide = new Parallax(fakeHost(), { maxHops: 5 })
  await wide.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'h1' })
  await wide.peer_send(root('B'), { to: 'Gamma', kind: 'notice', summary: 'h2' })
  await wide.peer_send(root('C'), { to: 'Alpha', kind: 'notice', summary: 'h3' })
  assert.equal((await wide.peer_send(root('A'), { to: 'Gamma', kind: 'notice', summary: 'h4' })).ok, true)
})

test('rate limit: 30 per minute per pair', async () => {
  const p = new Parallax(fakeHost())
  for (let i = 0; i < 30; i++) assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: `n${i}` })).ok, true)
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'n30' })).refused, 'rate_limit')
})

test('once tier: one exchange, then the channel closes', async () => {
  const host = fakeHost({ answer: 'Allow once' })
  const p = new Parallax(host, ask)
  const asked = await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'q' })
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'extra' })).refused, 'once_used')
  assert.equal((await p.peer_send(root('B'), { to: 'Alpha', kind: 'reply', summary: 'a', replyTo: asked.requestId })).ok, true)
  assert.equal((await p.peer_list(root('A'))).channels.length, 0)
  assert.ok(host.records.some(r => r.data.op === 'revoke'))
})

test('wake setting: never queues without waking; replies wakes only for answers', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  await p.personSetWake('B', 'never')
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'quiet' })
  assert.equal(host.delivered.at(-1).wakeup, false)
  await p.personSetWake('A', 'replies')
  const asked = await p.peer_send(root('C'), { to: 'Alpha', kind: 'request', summary: 'q' })
  assert.equal(host.delivered.at(-1).wakeup, false)
  await p.peer_send(root('A'), { to: 'Gamma', kind: 'reply', summary: 'a', replyTo: asked.requestId })
  assert.equal(host.delivered.at(-1).wakeup, true, 'C has the default, always')
})

test('persistence: grants, blocks, wake, open requests and children survive a restart', async () => {
  const host = fakeHost()
  const first = new Parallax(host, ask)
  const asked = await first.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'q' })
  await first.personSetWake('A', 'replies')
  await first.personRevoke('A', 'Gamma')
  host.answer = 'Start it'
  await first.peer_delegate(root('A'), { task: 'Write the summary' })
  const second = new Parallax(host, ask)
  second.hydrate('A', host.records.filter(r => r.sessionId === 'A').map(r => r.data))
  const listed = await second.peer_list(root('A'))
  assert.equal(listed.channels.length, 2, 'Beta and the delegated child')
  assert.equal(listed.wake, 'replies')
  assert.equal(listed.requests[0].id, asked.requestId)
  assert.deepEqual(listed.blocked, [aliasOf('C')])
  assert.equal(listed.delegated.length, 1)
  const asksBefore = host.asked.length
  await second.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'after restart' })
  assert.equal(host.asked.length, asksBefore, 'no second card after a restart')
})

test('person revoke blocks the pair, even in automatic mode, until /peer connect', async () => {
  const p = new Parallax(fakeHost())
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x' })
  await p.personRevoke('A', 'Beta')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'y' })).refused, 'blocked')
  assert.equal((await p.peer_send(root('B'), { to: 'Alpha', kind: 'notice', summary: 'y' })).refused, 'blocked')
  await p.personConnect('B', 'Alpha')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'z' })).ok, true)
})

test('peer_context is bounded, escaped and carries a trust warning', async () => {
  const p = new Parallax(fakeHost())
  const out = await p.peer_context(root('A'), { to: 'Beta', maxMessages: 2 })
  assert.equal(out.ok, true)
  assert.match(out.trustWarning, /no authority/)
  assert.equal(out.goal, 'Ship &lt;b&gt;it&lt;/b&gt;')
  assert.ok(out.messages[0].text.length <= 4 * 1024)
})

test('delegation: automatic by default, tracked in peer_list, child reports back without a card', async () => {
  const host = fakeHost()
  const p = new Parallax(host)
  const out = await p.peer_delegate(root('A'), { task: 'Summarise the README', permission: 'read-only' })
  assert.equal(out.ok, true)
  assert.equal(out.childId, 'D')
  assert.equal(out.permission, 'read-only')
  assert.equal(host.asked.length, 0)
  host.rows.push({ id: 'D', title: 'Summarise the README', running: true })
  assert.equal((await p.peer_send(root('D'), { to: 'Alpha', kind: 'notice', summary: 'done' })).ok, true)
  const listed = await p.peer_list(root('A'))
  assert.equal(listed.delegated[0].reports, 1)
  assert.equal((await p.peer_list(root('D'))).delegatedBy, aliasOf('A'))
})

test('delegation in ask mode needs approval', async () => {
  const host = fakeHost({ answer: 'Decline' })
  const p = new Parallax(host, ask)
  assert.equal((await p.peer_delegate(root('A'), { task: 'again' })).refused, 'declined')
  host.answer = 'Start it'
  assert.equal((await p.peer_delegate(root('A'), { task: 'again' })).ok, true)
})

test('aliases are stable and distinct', () => {
  assert.equal(aliasOf('abc'), aliasOf('abc'))
  assert.notEqual(aliasOf('abc'), aliasOf('abd'))
  assert.match(aliasOf('0b6f3c1e-1111-2222-3333-444455556666'), /^p_[0-9a-z]{6}$/)
})
