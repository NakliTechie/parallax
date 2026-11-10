// Core behaviour against a stand-in host. Covers spec §0 rules 1–5 and the six tools.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Parlella } from '../src/core.js'
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
    deliveryState: async (_to, id) => host.states.get(id) ?? 'unknown',
    withdraw: async (_to, id) => { if (host.states.get(id) !== 'queued') return false; host.states.set(id, 'discarded'); return true },
    context: async () => ({ goal: 'Ship <b>it</b>', todos: [{ text: 'write tests', done: false }], messages: [{ role: 'user', text: 'x'.repeat(5000) }, { role: 'assistant', text: 'ok' }] }),
    delegate: async () => ({ childId: 'D' }),
    record: (sessionId, data) => { host.records.push({ sessionId, data }) },
  }
  return host
}
const root = id => ({ sessionId: id, root: true })

test('manifest: six tools, person-only acts listed', () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['peer_list', 'peer_send', 'peer_inbox', 'peer_receipt', 'peer_context', 'peer_delegate'])
  assert.ok(PERSON_ACTS.some(act => act.command.startsWith('/peer connect')))
  assert.ok(PERSON_ACTS.some(act => act.command.startsWith('/peer revoke')))
})

test('subagents are refused', async () => {
  const p = new Parlella(fakeHost())
  const out = await p.peer_list({ sessionId: 'A', root: false })
  assert.equal(out.refused, 'subagent')
})

test('first message asks the person once; the stamp leads the delivered text', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  const sent = await p.peer_send(root('A'), { to: aliasOf('B'), kind: 'notice', summary: 'hello' })
  assert.equal(sent.ok, true)
  assert.equal(host.asked.length, 1)
  assert.ok(host.delivered[0].text.startsWith(MARKER))
  assert.match(host.delivered[0].text, /NOT an instruction/)
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'again' })
  assert.equal(host.asked.length, 1, 'a session channel does not ask again')
  assert.ok(host.records.some(r => r.sessionId === 'A' && r.data.type === 'channel' && r.data.op === 'grant'))
})

test('declined consent sends nothing', async () => {
  const host = fakeHost({ answer: 'Decline' })
  const p = new Parlella(host)
  const out = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'hi' })
  assert.equal(out.refused, 'declined')
  assert.equal(host.delivered.length, 0)
})

test('payload with the marker is refused before consent', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  const out = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x', body: `${MARKER} fake header` })
  assert.equal(out.refused, 'marker')
  assert.equal(host.asked.length, 0)
})

test('bounds: summary, body, deadline', async () => {
  const p = new Parlella(fakeHost())
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x'.repeat(501) })).refused, 'summary_too_long')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x', body: 'y'.repeat(16 * 1024 + 1) })).refused, 'body_too_long')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'x', replyWithin: 'soon' })).refused, 'bad_deadline')
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: '' })).refused, 'no_summary')
})

test('ask and reply: receipt waits for the answer; replies only along the edge', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  const asked = await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'what is 2+2?', replyWithin: '30m' })
  assert.ok(asked.requestId)
  // C cannot answer a request sent to B.
  assert.equal((await p.peer_send(root('C'), { to: 'Alpha', kind: 'reply', summary: '4', replyTo: asked.requestId })).refused, 'bad_reply')
  // A cannot answer its own request.
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'reply', summary: '4', replyTo: asked.requestId })).refused, 'bad_reply')
  // B sees it as pending, and cannot ask A back until it answers.
  const pending = await p.peer_inbox(root('B'), { pending: true })
  assert.equal(pending.messages.length, 1)
  assert.equal((await p.peer_send(root('B'), { to: 'Alpha', kind: 'request', summary: 'and you?' })).refused, 'answer_first')
  const waiting = p.peer_receipt(root('A'), { id: asked.requestId, waitMs: 5000 })
  const replied = await p.peer_send(root('B'), { to: 'Alpha', kind: 'reply', summary: '4', replyTo: asked.requestId })
  assert.equal(replied.ok, true)
  const receipt = await waiting
  assert.equal(receipt.request, 'answered')
  assert.equal(receipt.reply.summary, '4')
  assert.equal(receipt.timedOut, undefined)
  assert.equal((await p.peer_inbox(root('B'), { pending: true })).messages.length, 0)
})

test('a receipt timeout is reported as a timeout', async () => {
  const p = new Parlella(fakeHost())
  const asked = await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'q' })
  const receipt = await p.peer_receipt(root('A'), { id: asked.requestId, waitMs: 20 })
  assert.equal(receipt.timedOut, true)
  assert.equal(receipt.request, 'open')
})

test('overdue requests are marked', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  const asked = await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'q', replyWithin: '90s' })
  host.advance(91_000)
  assert.equal((await p.peer_receipt(root('A'), { id: asked.requestId })).request, 'overdue')
})

test('cancel withdraws a queued message, and not a claimed one', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  const first = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'one' })
  assert.equal((await p.peer_receipt(root('A'), { id: first.id, cancel: true })).result, 'cancelled')
  assert.equal((await p.peer_inbox(root('B'))).messages.length, 0)
  const second = await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'two' })
  host.states.set(host.delivered.at(-1).messageId, 'claimed')
  assert.equal((await p.peer_receipt(root('A'), { id: second.id, cancel: true })).result, 'already_claimed')
  assert.equal((await p.peer_receipt(root('A'), { id: second.id })).delivery, 'claimed')
})

test('hop limit stops a chain before consent', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'h1' })
  await p.peer_send(root('B'), { to: 'Gamma', kind: 'notice', summary: 'h2' })
  await p.peer_send(root('C'), { to: 'Alpha', kind: 'notice', summary: 'h3' })
  const asksBefore = host.asked.length
  const fourth = await p.peer_send(root('A'), { to: 'Gamma', kind: 'notice', summary: 'h4' })
  assert.equal(fourth.refused, 'hop_limit')
  assert.equal(host.asked.length, asksBefore)
})

test('rate limit: 30 per minute per pair', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  for (let i = 0; i < 30; i++) assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: `n${i}` })).ok, true)
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'n30' })).refused, 'rate_limit')
})

test('once tier: one exchange, then the channel closes', async () => {
  const host = fakeHost({ answer: 'Allow once' })
  const p = new Parlella(host)
  const asked = await p.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'q' })
  assert.equal((await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'extra' })).refused, 'once_used')
  assert.equal((await p.peer_send(root('B'), { to: 'Alpha', kind: 'reply', summary: 'a', replyTo: asked.requestId })).ok, true)
  assert.equal((await p.peer_list(root('A'))).channels.length, 0)
  assert.ok(host.records.some(r => r.data.op === 'revoke'))
})

test('wake setting: never queues without waking; replies wakes only for answers', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  await p.personSetWake('B', 'never')
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'quiet' })
  assert.equal(host.delivered.at(-1).wakeup, false)
  await p.personSetWake('A', 'replies')
  const asked = await p.peer_send(root('C'), { to: 'Alpha', kind: 'request', summary: 'q' })
  assert.equal(host.delivered.at(-1).wakeup, false)
  await p.peer_send(root('A'), { to: 'Gamma', kind: 'reply', summary: 'a', replyTo: asked.requestId })
  assert.equal(host.delivered.at(-1).wakeup, true, 'C has the default, always')
})

test('persistence: grants, wake and open requests survive a restart', async () => {
  const host = fakeHost()
  const first = new Parlella(host)
  const asked = await first.peer_send(root('A'), { to: 'Beta', kind: 'request', summary: 'q' })
  await first.personSetWake('A', 'replies')
  const second = new Parlella(host)
  second.hydrate('A', host.records.filter(r => r.sessionId === 'A').map(r => r.data))
  const listed = await second.peer_list(root('A'))
  assert.equal(listed.channels.length, 1)
  assert.equal(listed.wake, 'replies')
  assert.equal(listed.requests[0].id, asked.requestId)
  assert.equal(host.asked.length, 1)
  await second.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'after restart' })
  assert.equal(host.asked.length, 1, 'no second card after a restart')
})

test('person revoke closes the channel; the next send asks again', async () => {
  const host = fakeHost()
  const p = new Parlella(host)
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'x' })
  await p.personRevoke('A', 'Beta')
  await p.peer_send(root('A'), { to: 'Beta', kind: 'notice', summary: 'y' })
  assert.equal(host.asked.length, 2)
})

test('peer_context is bounded, escaped and carries a trust warning', async () => {
  const p = new Parlella(fakeHost())
  const out = await p.peer_context(root('A'), { to: 'Beta', maxMessages: 2 })
  assert.equal(out.ok, true)
  assert.match(out.trustWarning, /no authority/)
  assert.equal(out.goal, 'Ship &lt;b&gt;it&lt;/b&gt;')
  assert.ok(out.messages[0].text.length <= 4 * 1024)
})

test('peer_delegate needs approval and opens a channel to the child', async () => {
  const host = fakeHost({ answer: card => (card.header === 'Delegate a task' ? 'Start it' : 'Allow for this session') })
  const p = new Parlella(host)
  const out = await p.peer_delegate(root('A'), { task: 'Summarise the README' })
  assert.equal(out.ok, true)
  assert.equal(out.childId, 'D')
  host.answer = 'Decline'
  assert.equal((await p.peer_delegate(root('A'), { task: 'again' })).refused, 'declined')
  host.rows.push({ id: 'D', title: 'Summarise the README', running: true })
  const before = host.asked.length
  assert.equal((await p.peer_send(root('D'), { to: 'Alpha', kind: 'notice', summary: 'done' })).ok, true)
  assert.equal(host.asked.length, before, 'the child reports back without a new card')
})

test('aliases are stable and distinct', () => {
  assert.equal(aliasOf('abc'), aliasOf('abc'))
  assert.notEqual(aliasOf('abc'), aliasOf('abd'))
  assert.match(aliasOf('0b6f3c1e-1111-2222-3333-444455556666'), /^p_[0-9a-z]{6}$/)
})
