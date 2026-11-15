# Changelog

## 0.1.0 (2026-11-15)

First public release.

- Six tools for the model: `peer_list`, `peer_send`, `peer_inbox`, `peer_receipt`, `peer_context`, `peer_delegate`.
- Person-only commands: `/peer connect`, `/peer revoke`, `/peer wake`, `/peer busy`, `/peers`.
- Messages: notice, request and reply; ask-and-wait (`waitMs`); broadcast to up to 20 peers; urgent delivery; `wake: false`;
  supersede a queued message; idempotency `key`; reply deadlines with overdue marking.
- Receipts read from the receiver's log: queued, claimed, discarded, answered, overdue; cancel an unclaimed message.
- Delegation: a new top-level conversation with permissions no wider than the caller's, optional model, agent preset,
  tags, acceptance list and `reportWithin` deadline; the child reports `working`, `done`, `failed` or `needs_parent`.
- Approval relay: a delegated conversation's permission prompt opens as a card in its parent.
- Every inbound message carries a no-authority stamp; limits on hops, rate, sizes and inbox length.
- Display metadata for dsh's plugin pages and market indexes (`locale/en.json`).

Ideas reimplemented, not copied, from `dsh-peer-sessions`, `dsh-cross-session-agent-pre`, `dsh-cross-session-approval`,
`pi-intercom` and Atomic Agent's Fusion mode; `docs/parity.md` maps each capability to its source.
