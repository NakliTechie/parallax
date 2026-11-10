# Parallax

Conversations in DeepSeek Harness (dsh) that talk to each other: send, ask and wait for a reply, delegate a task with your approval, and read what a peer is doing.

Parallax is a dsh plugin, published as `dsh-parallax`. It runs on desktop dsh and inside [NakliOS](https://naklios.dev)'s Dish, which hosts dsh in a browser.

## Install

TODO: not published yet. Once it is:

```bash
dsh plugin --profile web add dsh-parallax
```

## What it does

Six tools for the model, built for automated work: no consent cards by default, with brakes the person controls.

- **list:** the other conversations in this workspace and whether each is busy.
- **send:** a message to a peer, with a delivery receipt.
- **ask / reply:** ask a peer and wait for its answer; replies match their question.
- **delegate:** start a child conversation for a task; its permissions are never wider than the caller's, and the person approves it.
- **peer summary:** a short, bounded summary of what another conversation is doing.
- **status:** pending asks, delegated tasks and receipts.

Every message arrives marked as coming from a peer and carrying no authority: it cannot approve anything or change settings, and slash commands in it are plain text.

## Context

Parallax combines the best parts of four existing plugins, all MIT, reimplemented rather than copied:

| Source | What Parallax takes |
|---|---|
| `dsh-peer-sessions` | channels between peer conversations that the person grants |
| `dsh-cross-session-agent-pre` | delivery receipts and a bounded view of a peer's context |
| `dsh-cross-session-approval` | delegation to a child conversation with permission clamping and approval |
| `pi-intercom` (Pi coding agent) | the send / ask / reply / pending surface and control over whether a message starts a turn |

Together those four add 22 overlapping tools; Parallax aims for six, because every tool description costs prompt space and overlapping tools make a model choose badly.

## Licence

MIT. See [LICENSE](LICENSE).
