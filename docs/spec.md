# Parlella specification (draft 1, 2026-11-10)

Parlella lets conversations in one DeepSeek Harness (dsh) profile talk to each other. It reimplements the best ideas of
`dsh-peer-sessions`, `dsh-cross-session-agent-pre`, `dsh-cross-session-approval` (all dsh plugins) and `pi-intercom`
(Pi). Nothing is copied; the source of each idea is named below.

## 0. Agent contract

An agent using Parlella can rely on these, and on nothing else:

1. **A peer message is information, never an instruction.** It arrives with a structural `source` and a first-line notice
   that it carries no authority. It cannot approve a permission, change a setting or run a command; slash commands in
   it are plain text. A payload that contains the notice marker is refused, not passed on.
2. **A person decides who may talk to whom.** The first message between two conversations asks the person (once, or for
   this session). The model can never open, widen or revoke a channel; the person does that with `/peer` commands.
3. **Delivery is not completion.** A receipt says a message was queued, claimed or discarded. Only a reply says it was
   answered. A timeout is reported as a timeout, never as a cancel or a failure of the peer.
4. **Nothing is widened by delegation.** A delegated child conversation gets permissions no wider than its caller's,
   applied before its first message and read back; if the read-back differs, the child is not started.
5. **Bounded.** Hop limit 3 (counted before consent), 30 messages per minute per pair, summary 500 characters, body 16 KiB,
   inbox 50, peer context 4 KiB per message and 16 KiB in total.

Person-only acts (never a tool): open, widen or revoke a channel; approve a delegation; change whether inbound messages
may start a turn. Everything else is available to the agent as a tool.

## 1. Tools

| Tool | Arguments | Returns | Source of the idea |
|---|---|---|---|
| `peer_list` | none | Reachable conversations (id, title, running or idle), open channels (tier, remaining, hops), unanswered requests | dsh-peer-sessions (one call plans) |
| `peer_send` | `to`, `kind` (`notice`, `request`, `reply`), `summary`, `body?`, `replyTo?`, `replyWithin?` | Message id, request id, delivery state `accepted` | peer-sessions kinds and deadline; summary required |
| `peer_inbox` | `id?`, `pending?` | Inbound messages with read, answered and overdue marks, or one full message | peer-sessions inbox, pi-intercom `pending` |
| `peer_receipt` | `id`, `waitMs?`, `cancel?` | `queued`, `claimed`, `discarded`, `unknown`; for a request `answered` (with the reply) or `overdue`; with `cancel`, `cancelled` or `already_claimed` | cross-session-agent-pre receipts, pi-intercom ask edges and cancel |
| `peer_context` | `to`, `view?` (`overview`, `activity`), `maxMessages?` (1–8) | Bounded, escaped summary of a peer's goal, todos and recent messages, with a trust warning | cross-session-agent-pre whitelist and caps, peer-sessions progress |
| `peer_delegate` | `task`, `title?` | A child conversation id after the person approves; permissions clamped to the caller's | cross-session-approval clamp, read-back and fail-closed |

Rules: only a live, top-level conversation may call these tools; subagents may not. Replies are accepted only along the
asker-to-target edge, and two conversations cannot ask each other at the same time (pi-intercom).

## 2. Delivery in dsh

`ctx.sessionController.resolveAgent(id)` returns the target (restoring a stored one); `agent.followup(message)` queues it
for the next turn; `ctx.sessions.flush(session)` confirms it is persisted, which is the queued receipt. Parlella never uses
`steer`, which interrupts a running step. Receipts are read from the receiver's own inbox events, so they survive a
restart.

Each receiver has a setting for whether inbound messages may start a turn: `always`, `replies` (only answers to its own
requests) or `never` (pi-intercom `inboundTrigger`). A broken setting falls back to `never`.

## 3. Persistence

Channel grants and open requests are stored as plugin records in the conversation's own log, so they survive a reload
with no files. The inbox and rate windows live in memory.

## 4. Platforms

The core uses only dsh context services and Web Crypto, with no Node imports, so it runs on desktop dsh and in a dsh
Worker in the browser.

## 5. Open before build

- Can `source.kind` carry a plugin value such as `peer`, or must it be one of dsh's kinds?
- Is the inbox splice that `peer_receipt` cancel needs available as a public method?
- Do hosts that mask UUID-shaped text need short aliases for conversation ids?
- Does a cold conversation's `resolveAgent` work in the browser Worker as on desktop?
