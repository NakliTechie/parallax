# Feature parity with the four source plugins (2026-11-10)

Sources: `dsh-peer-sessions` 1.3.3 (PS), `dsh-cross-session-agent-pre` 0.2.0-rc.2.7 (AP), `dsh-cross-session-approval`
0.3.12 (CA), `pi-intercom` 0.18.1 (PI). Each row is one capability any of them has. **Have** means Parallax does it and a
test in `test/` covers it; **partial** says what is missing; **out** gives the reason. Parallax favours automated
operation: conversations reach each other and delegate with no card unless the profile sets `consent: ask`.

| # | Capability | From | Parallax | How |
|---|---|---|---|---|
| 1 | List reachable conversations with running state | PS, AP, CA, PI | have | `peer_list`, scoped to the caller's folder (`scope: all` widens it) |
| 2 | Send a one-way message | all | have | `peer_send` kind `notice` |
| 3 | Ask and wait for the answer in one call | PI | have | `peer_send` kind `request` with `waitMs` |
| 4 | Request ids, replies matched to their request | PS, PI | have | `requestId`, `replyTo`, edge check |
| 5 | Reply without naming the request when only one is open | PI | have | `replyTo` inferred |
| 6 | Reply deadline and overdue marking | PS | have | `replyWithin`, `overdue` state |
| 7 | Refuse mutual asks | PI | have | `answer_first` refusal |
| 8 | Delivery receipts from the receiver's log: queued, claimed, discarded | AP, PI | have | `peer_receipt`, read from `agent/inbox/spliced` events |
| 9 | Cancel an unclaimed message | PI | have | `peer_receipt` `cancel` through `inbox.remove` |
| 10 | Replace a queued message (supersede, merge a burst) | PS, PI | have | `peer_send` `supersedes` through `inbox.replace` |
| 11 | Inbox with read, answered and overdue marks | PS, PI | have | `peer_inbox`, `pending` filter |
| 12 | Wake an idle or stored conversation | PS, AP, CA, PI | have | `agent.send(..., wakeup)` after `resolveAgent` |
| 13 | Receiver controls whether peers start turns | PI | have | `/peer wake always|replies|never` |
| 14 | Queue without waking (silent) | PS, AP | have | `wake: false` |
| 15 | Deliver mid-run at the next step | AP, CA, PI | have | `urgent: true` (next step; never aborts a running step) |
| 16 | Interrupt a running step | AP, CA | out | Abandons the peer's work; `urgent` reaches it at the next step instead |
| 17 | Broadcast to several conversations | CA | have | `peer_send` `broadcast` (at most 20) |
| 18 | Bounded, escaped view of a peer's goal, todos, messages, activity | AP, PS | have | `peer_context` |
| 19 | Start a new conversation for a task | CA | have | `peer_delegate` |
| 20 | Child permissions no wider than the caller's, read back, fail closed | CA | have | preset and overrides copied, narrower preset allowed, read back before the first turn |
| 21 | Track delegated conversations: state, report count | CA | have | `peer_list` `delegated`, `delegatedBy` |
| 22 | Child asks its parent to approve a permission raise | CA | have | the child's dsh approval prompt is shown to the person in the parent conversation (`approvalRelay`); a closed card falls back to the child; `needs_parent` status meanwhile |
| 23 | Spawn with another model, agent preset or tags | CA | have | `peer_delegate` `model` (from the profile's `models` list when set; the person's default model is kept), `agentPreset`, `tags` |
| 24 | Rename or archive another conversation | CA | out | Changes a conversation the person owns; person-only |
| 25 | Consent card per pair, once or session | PS, PI | have | `consent: ask`; default is automatic |
| 26 | Person can close a pair for good | PS | have | `/peer revoke` blocks until `/peer connect` |
| 27 | No-authority stamp, structural source, marker forgery refused | PS, AP | have | `source.kind: peer`, first-line stamp, `marker` refusal |
| 28 | Hop limit before any card | PS | have | `maxHops` (default 3); replies never raise it |
| 29 | Rate limit per pair | PS, AP | have | 30 per minute |
| 30 | Subagents may not use peer tools | PS, AP | have | `subagent` refusal |
| 31 | Grants and open requests survive a restart | PS, PI | have | plugin records in the session log (checked in real dsh, 2026-11-10) |
| 32 | Handover: summarise this conversation for another | PI | partial | The model writes the summary and sends it with `peer_send`; no dedicated action |
| 33 | Idempotent resend (`retryOf`, duplicate ids) | PI | have | `peer_send` `key`: a resend with the same key to the same peer returns the first result for 24 h |
| 34 | Claude Code bridge | AP | out | Node sockets; cross-agent messaging is a NakliOS-level A2A service |
| 35 | Cross-machine relay | PI | out | Same reason as 34 |
| 36 | Busy-peer policy "human first" | PI | have | `/peer busy human-first`: peer messages wait while the receiver runs or has a person's message pending, then go in one per idle moment |
| 37 | Person-facing commands | PS, PI | have | `/peer connect`, `/peer revoke`, `/peer wake`, `/peers` |
| 38 | Runs in a browser Worker (Dish) | PS | have | no Node imports; Dish mount in NakliOS |
| 39 | Task result status | Atomic Agent Fusion | have | `peer_send` `status` from a delegated child: working, done, failed, needs_parent; marked as the child's own claim |
| 40 | Acceptance list for a delegated task | Atomic Agent Fusion | have | `peer_delegate` `acceptance`, shown read-only to the child; the parent checks it |
| 41 | Per-delegation time limit and usage | Atomic Agent Fusion | have | `reportWithin` (overdue in `peer_list`), child turns and output tokens in `peer_list`; no spend cap, because enforcing one means interrupting |

Count: 36 have, 1 partial (handover), 0 missing, 4 out, of 41 (rows 39–41 from Atomic Agent's Fusion mode, MIT).
