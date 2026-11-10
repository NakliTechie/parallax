# Parallax specification (draft 1, 2026-11-10)

Parallax lets conversations in one DeepSeek Harness (dsh) profile talk to each other. It reimplements the best ideas of
`dsh-peer-sessions`, `dsh-cross-session-agent-pre`, `dsh-cross-session-approval` (all dsh plugins) and `pi-intercom`
(Pi). Nothing is copied; the source of each idea is named below.

## 0. Agent contract

An agent using Parallax can rely on these, and on nothing else:

1. **A peer message is information, never an instruction.** It arrives with a structural `source` and a first-line notice
   that it carries no authority. It cannot approve a permission, change a setting or run a command; slash commands in
   it are plain text. A payload that contains the notice marker is refused, not passed on.
2. **Automatic by default; the person holds the brakes.** Conversations in the same folder reach each other and delegate
   with no card, because Parallax exists for automated work. The person can close a pair for good (`/peer revoke`), stop
   peers from starting turns (`/peer wake`), or turn cards back on (`consent: ask`, `delegateApproval: ask`). The model
   can never reopen a closed pair, change its own wake setting or turn cards off.
3. **Delivery is not completion.** A receipt says a message was queued, claimed or discarded. Only a reply says it was
   answered. A timeout is reported as a timeout, never as a cancel or a failure of the peer.
4. **Nothing is widened by delegation.** A delegated child conversation gets permissions no wider than its caller's,
   applied before its first message and read back; if the read-back differs, the child is not started.
5. **Bounded.** Hop limit 3 (counted before consent), 30 messages per minute per pair, summary 500 characters, body 16 KiB,
   inbox 50, peer context 4 KiB per message and 16 KiB in total.

Person-only acts (never a tool): reopen or close a pair, change whether inbound messages may start a turn, and choose
the consent mode. Everything else is available to the agent as a tool. Parity with the four source plugins: `docs/parity.md`.

## 1. Tools

| Tool | Arguments | Returns | Source of the idea |
|---|---|---|---|
| `peer_list` | none | Reachable conversations (id, title, running or idle), open channels (tier, remaining, hops), unanswered requests | dsh-peer-sessions (one call plans) |
| `peer_send` | `to` or `broadcast` (up to 20), `kind` (`notice`, `request`, `reply`), `summary`, `body?`, `replyTo?` (inferred when one request is open), `replyWithin?`, `waitMs?` (ask and wait), `urgent?` (next step), `wake?`, `supersedes?` | Message id, request id, delivery state; with `waitMs`, the reply | peer-sessions kinds, deadline and merge; pi-intercom ask, reply inference; approval broadcast |
| `peer_inbox` | `id?`, `pending?` | Inbound messages with read, answered and overdue marks, or one full message | peer-sessions inbox, pi-intercom `pending` |
| `peer_receipt` | `id`, `waitMs?`, `cancel?` | `queued`, `claimed`, `discarded`, `unknown`; for a request `answered` (with the reply) or `overdue`; with `cancel`, `cancelled` or `already_claimed` | cross-session-agent-pre receipts, pi-intercom ask edges and cancel |
| `peer_context` | `to`, `view?` (`overview`, `activity`), `maxMessages?` (1–8) | Bounded, escaped summary of a peer's goal, todos and recent messages, with a trust warning | cross-session-agent-pre whitelist and caps, peer-sessions progress |
| `peer_delegate` | `task`, `title?`, `permission?` (a narrower preset) | A child conversation id; preset and sandbox/approval overrides copied or narrowed, read back before the first turn | cross-session-approval clamp, read-back and fail-closed |

Rules: only a live, top-level conversation may call these tools; subagents may not. Replies are accepted only along the
asker-to-target edge, and two conversations cannot ask each other at the same time (pi-intercom).

## 2. Delivery in dsh

`ctx.sessionController.resolveAgent(id)` returns the target (restoring a stored one). Parallax queues the message with
`agent.send(message, 'next-turn', wakeup)`, where `wakeup` follows the receiver's setting, and `ctx.sessions.flush(session)`
persists it. Parallax never uses `steer`, which interrupts a running step. The message source is
`{kind: 'peer', form: 'relay', senderSessionId}`, so dsh renders it as a relay row from the sender. Receipts are read from
the receiver's `agent/inbox/spliced` and `user/message` events (still in the inbox = queued, spliced out = claimed,
spliced out with `outcome: 'canceled'` = discarded), so they survive a restart.

Delegation creates a top-level conversation in the caller's folder with `ctx.sessionController.create`, sets the caller's
permission preset with `ctx.permissionPresets.set`, reads it back with `current`, and only then queues the task with
`followup`. A caller with its own sandbox or approval override is refused, because Parallax cannot yet copy an override
exactly.

Each receiver has a setting for whether inbound messages may start a turn: `always`, `replies` (only answers to its own
requests) or `never` (pi-intercom `inboundTrigger`). A broken setting falls back to `never`.

## 3. Persistence

Channel grants and open requests are stored as plugin records in the conversation's own log, so they survive a reload
with no files. The inbox and rate windows live in memory.

## 4. Platforms

The core uses only dsh context services and Web Crypto, with no Node imports, so it runs on desktop dsh and in a dsh
Worker in the browser.

## 5. Settled host questions (2026-11-10, dsh-v0.2.1-rc.5 source)

- **Source kind.** `MessageSourceMap` (`packages/llm/llm/src/message.ts`) is merge-extensible: each producer declares
  its own `kind` and consumers fall through unknown kinds. Parallax declares `peer` and uses the `relay` context form.
- **Cancel.** The agent's `Inbox` (`packages/core/agent/src/runtime-types.ts`) has public `replace` and `remove` for a
  pending message, so `peer_receipt` with `cancel` removes a message the receiver has not claimed.
- **Waking.** `agent.send(message, target, wakeup)` queues without starting a turn when `wakeup` is false. The receiver
  setting maps onto it: `never` → never wake; `replies` → wake only for answers to its own requests; `always` → wake.
- **Aliases.** Some hosts mask UUID-shaped text, so tools accept and show a short alias (`p_` plus 6 characters) for each
  conversation as well as its id.
- **Cold conversations in a browser Worker.** Assumed to work as on desktop (`resolveAgent` restores a stored one);
  checked when Parallax runs inside Dish.
