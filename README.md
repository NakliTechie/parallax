<h1 align="center">Parallax</h1>

<p align="center">
  <strong>Conversations in DeepSeek Harness (dsh) that message each other and hand off work:<br>
  send, ask and wait for the reply, delegate a task, and read what a peer is doing.</strong>
</p>

<p align="center">
  It is one dsh plugin with six tools. It runs in your own dsh profile, with no account, no server and no telemetry.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-parallax"><img alt="npm" src="https://img.shields.io/npm/v/dsh-parallax?style=flat-square&color=3fb950"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-3fb950?style=flat-square"></a>
  <img alt="six tools" src="https://img.shields.io/badge/tools-6-3fb950?style=flat-square">
  <img alt="no account" src="https://img.shields.io/badge/account-none-3fb950?style=flat-square">
</p>

## Install

| | |
|---|---|
| **dsh** (web profile) | `dsh plugin --profile web add dsh-parallax` |
| **From source** | `npm pack` in this folder, then `dsh plugin --profile web add ./dsh-parallax-0.1.0.tgz` |

Restart the profile. Open two conversations in the same folder and ask the first one to "ask the other conversation
what it is working on". It calls `peer_list`, then `peer_send` with kind `request` and `waitMs`, and the answer comes
back in the same turn. Needs dsh 0.2.1-rc.5 or later and a profile with dsh's session controller: the `web` profile
has it, and the one-shot `headless` profile does not, so Parallax stays inactive there.

No config file is needed. The defaults are automatic: conversations in one folder reach each other and delegate without
a card, and you hold the brakes listed under Commands.

## Why

You run three dsh conversations on one project. One finds a bug that another is about to make worse, and the only way
to tell it is for you to copy text between windows. A long task you want split off means opening a new conversation and
retyping the context.

Parallax gives each conversation six tools to do that itself. Every message carries a receipt, so the sender knows
whether it was queued, taken into a turn or answered. A delegated conversation is a normal top-level conversation you
can open and talk to, and its permissions are never wider than its parent's.

## What the model can do

| Tool | What it does |
|---|---|
| `peer_list` | Lists reachable conversations, open channels, unanswered requests and delegated children with their status. |
| `peer_send` | Sends a notice, request or reply, to one peer or a broadcast of up to 20; can wait for the reply, mark it urgent, skip waking the peer, replace a queued message, or dedupe by key. |
| `peer_inbox` | Reads received messages, or only the requests still owed an answer. |
| `peer_receipt` | Checks a sent message: queued, claimed, discarded, answered or overdue; can wait or cancel. |
| `peer_context` | Reads a bounded summary of a peer: goal, todos and recent messages, or recent tool activity. |
| `peer_delegate` | Starts a child conversation for a task, with an optional model, preset, tags, acceptance list and deadline. |

A delegated child reports with `peer_send` status `working`, `done`, `failed` or `needs_parent`. When the child hits a
permission prompt, the card opens in the parent conversation for you to answer.

## What a peer message cannot do

Every inbound message is marked as coming from a peer and carrying no authority. It cannot approve a permission, change
a setting or run a command, and a slash command inside it stays plain text. A payload that imitates the marker is
refused. Chains stop at 3 hops, a pair is limited to 30 messages a minute, a summary to 500 characters and a body to
16 KiB. The model can never reopen a pair you closed, change its own wake setting or turn consent cards off.

## Commands

```
/peer connect <peer> [once|session]    # open or reopen a channel to a peer
/peer revoke <peer>                    # close a channel; it stays closed until /peer connect
/peer wake <always|replies|never>      # whether peer messages may start a turn here
/peer busy <queue|human-first>         # hold peer messages while your own message waits
/peers                                 # channels, requests and delegated conversations
```

Plugin config, set in the profile's `cordis.patch.yml` with an id-targeted patch on `dsh-parallax`:

```yaml
- id: dsh-parallax
  config: { consent: ask, delegateApproval: ask, defaultWake: replies, maxHops: 3, scope: all, models: ["<provider>/<model>"] }
```

`consent: ask` and `delegateApproval: ask` bring back confirmation cards; `scope: all` lets conversations in other
folders reach each other; `models` limits which models a child may use; `approvalRelay: false` keeps a child's
permission prompts in the child. Every tool and person-only act is listed in [src/manifest.js](src/manifest.js).

## Verify it yourself

```
npm test               # core and dsh adapter against stand-in dsh services
npm pack --dry-run     # the files that ship
```

`npm test` runs 41 tests that cover the core rules and the wiring to dsh. They use stand-in dsh services, so they do not
prove behaviour in a real dsh. Ask and reply, a restart, delegation, the approval relay and `human-first` were run by
hand in dsh 0.2.1-rc.5 web profiles; the 0.1.0 package itself was installed from its tarball into a fresh profile and
passed an ask and reply and a delegation. The [parity table](docs/parity.md) maps each capability to the test
that covers it.

## License

MIT. See [LICENSE](LICENSE). Ideas come from `dsh-peer-sessions`, `dsh-cross-session-agent-pre`,
`dsh-cross-session-approval` and `pi-intercom`, all MIT, reimplemented rather than copied.

Specification: [docs/spec.md](docs/spec.md) · parity: [docs/parity.md](docs/parity.md) · dsh API notes:
[docs/dsh-plugin-api.md](docs/dsh-plugin-api.md) · changes: [CHANGELOG.md](CHANGELOG.md)
