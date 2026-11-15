# dsh plugin API facts Parallax relies on (dsh v0.2.1-rc.5, read 2026-11-10)

Paths are relative to `packages/` in `deepseek-harness-dsh-v0.2.1-rc.5`. All facts come from reading source (inferred, nothing executed).

## 1. The `exec` object inside `execute(args, exec)`

- `execute(args: unknown, exec: ToolRunContext): Promise<unknown>` (core/tools/src/index.ts:237).
- `ToolRunContext extends ToolExecution` (index.ts:414). `ToolExecution extends ToolExecutionInput` and adds `rootCallId: ToolCallId` and `token: ToolExecutionToken` (index.ts:394-399).
- `ToolExecutionInput` fields (index.ts:327-357): `callId`, `rootCallId?`, `name`, `schema?` (PTC inner calls only), `arguments`, `agent?: Agent`, `parent?: ToolExecutionToken`, `signal: AbortSignal`.
- Added by `ToolRunContext` (index.ts:426, 438): `deferContext(context: UserMessage): void` and `concludeTurn(): void`. No other fields. The registry builds them at core/tools/src/index.ts:1415-1433.
- `agent` is optional. Guard for `undefined`; `packages/experimental/tool-session-query/src/workspace-access.ts:62-66` throws when it is missing.
- Calling agent's SessionId: `exec.agent.id` (`Agent.id: SessionId`, core/agent/src/types.ts:17). `exec.agent.session.id` is the same value (core/session/src/index.ts:545 `get id()`). The live agent also exposes `.session`, `.inbox`, `.status`, `.ctx`, `.options` (core/agent/src/runtime-types.ts:164-176).
- Subagent test: there is no `agent.parent`. Use the durable header on `exec.agent.session.header` (core/session/src/types.ts:95-137):
  - `origin?: 'subagent'` (line 118)
  - `delegationDepth?: number`, absent for top level (line 125-ish, 1 for a first-level child)
  - `parentSession?: SessionId`, set for forks too, so it does not prove "subagent" alone (line 110)
- Runtime-root test: `ctx.agents.roots(): Agent[]` returns live agents created without an owning agent (core/agent/src/index.ts:598-603). `ctx.agents.isOwnedBy(id, owner)` (index.ts:580), `ctx.agents.get(id)` (568), `ctx.agents.list()` (588).
- `ctx.subagents` is `SubagentRuntime` (subagent/subagent/src/index.ts:133, 194). It has `listChildren(parentSessionId, signal?)` (line 405) and `listDescendants(rootSessionId, signal?)` (line 425). These list a parent's children, not "is this agent a child".
- Inject names needed: `agents`, `subagents` (optional).

## 2. Listing other sessions with title and running state (host side)

- `ctx.sessionController` is typed on Context (api/session-controller/src/index.ts:76-80). `list` is a plain class method with a `@Remote` decorator, so a Host plugin can call it directly: `list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue>` (index.ts:275-279).
- Request: `SessionListRequest { readonly cursor?: string }` (api/session-controller/src/types.ts:267-269). The implementation ignores it (`_request`), so there is no paging or filter.
- Result: `SessionListValue { readonly items: readonly SessionSummary[] }` (types.ts:272). The method also filters rows by `ctx.remoteAccess.allows({kind:'session', id})` (index.ts:278).
- `SessionSummary` fields (types.ts:178-189): `agentAvailable: boolean`, `formatStatus?: 'current'|'migration-required'`, `sessionId`, `updatedAt: number`, `running: boolean`, `blank: boolean`, `parentSessionId?`, `origin?: 'subagent'`, `cwd?`, `projections?: SessionProjectionHints`.
- There is no `title` field on the summary. Title comes from `summary.projections?.values.title` (`title: string | null`, session/session-title/src/types.ts:86-92) or from `ctx.sessionQuery.readTitle(sessionId, signal?)` (session-query/session-query/src/index.ts:220), which returns a `SessionTitleSnapshot | undefined`.
- Exclusions, all done by the caller:
  - Archived: `ctx.workspaceRegistry.archivedSessionIds: readonly SessionId[]` (workspace/workspace/src/index.ts:344). `list()` does not filter it. `SessionCommandController.create` uses the same check (api/session-controller/src/commands.ts:132).
  - Subagents: drop rows where `origin === 'subagent'` (or `parentSessionId !== undefined`).
  - Blank sessions: drop `blank === true`.
  - Same workspace: compare `cwd` to the caller's `agent.session.header.cwd` (the approach of tool-session-query, workspace-access.ts:80-90, 117-135), or use `ctx.workspaceRegistry.get(id)?.sessionIds` (workspace/workspace/src/entity.ts:102) and `ctx.workspaceRegistry.list()` (index.ts:292).
- Running state: `running` on the summary. For a live agent, `ctx.agents.get(id)?.status` is `'idle' | 'running'` (core/agent/src/runtime-types.ts:104, 169). The host emits `'agent/status'` events with `{agent, status}` (runtime-types.ts:~250). Inject `agents` for `ctx.agents`.
- Lower-level alternative: `ctx.sessionQuery.listSessions(signal?): Promise<SessionRecord[]>` (session-query/session-query/src/index.ts:174) and `filterSessions([{kind:'id',values}, {kind:'cwd',values}], signal)` (used at workspace-access.ts:83-86).

## 3. Reading committed events after restart

- Plugin-record pattern (translator): write with `appendPluginRecord(session, type, data)` then `await sessions.flush(session)` (experimental/translator/src/storage.ts:114-116). Read back through persistence, not the live log: `persistence = ctx.get('sessionPersistence')`, `await using handle = await persistence.open(id, 'read', {signal})`, `const {events} = await handle.read(start, count, {signal})`, then `pluginRecordOf(event)` (storage.ts:127-134, 150-166).
- Persistence signatures: `abstract open(id: SessionId, access: SessionAccess, options?): Promise<SessionHandle>` (session/session-persistence/src/index.ts:167), `stat(id, options?)` (196), `list(options?)` (203), `SessionHandle.read(offset?, length?, options?)` (session/session-persistence/src/handle.ts:83).
- Simpler for a plugin: `ctx.sessionQuery.readSession(sessionId): Promise<SessionLogSnapshot>` returns header plus the complete raw log, live-preferred (session-query/session-query/src/index.ts:184). `ctx.sessionQuery.observeSession(sessionId, {signal, projectionMode?})` returns a disposable `SessionObservation` with `header`, `events`, `cursor`, `projections?` (session-query/src/observation.ts:17-41, index.ts:140). Use `using obs = await ...`.
- Live log: `session.snapshotEvents(from?, to?)` and `session.ownEvents()` exist but are marked `@deprecated`, "new calls are prohibited" (core/session/src/index.ts:721-748). `session.eventAt(seq)` has the same deprecation (index.ts:711).
- Plugin record grammar: record type must be `plugin:<name>/...` (translator uses `'plugin:translator/request'`); `pluginRecordOf(event): PluginRecord | undefined` returns `{type, seq, time, data}` only when `event.ignorable === true` (core/session/src/index.ts:508-513). `appendPluginRecord<K>(session, type, data): SessionSeq` (index.ts:492). Types come from `PluginRecordMap` in `@deepseek-ai/dsh-session/types` (storage.ts:96).
- New-event hooks (Cordis events, core/session/src/index.ts:54-82):
  - `'session/created'(session)`, `'session/disposed'(session)`
  - `'session/event'(session: Session, event: SessionEvent)`, emitted per appended event
  - `'session/flush'(session)`, awaited parallel durability checkpoint
  - Use `ctx.on('session/event', (session, event) => ...)`; session-controller does it at api/session-controller/src/index.ts:210.
- `ctx.sessions.flush(session: Session): Promise<boolean>` (core/session/src/index.ts:1319). It resolves `true` if at least one durability listener took part, `false` if none; it rejects with the first listener failure. It throws if the session is not live (`liveEntryFor`). Other store methods: `get(id)` (1352), `list()` (1360), `create(id?, options?)` (1111).
- Projections also rebuild after restart: `ctx.sessionProjections.stateOf(session, key)` and `.snapshot(session, keys?)` (session/session-projection/src/index.ts:320, 339); custom units register via `ctx.sessionProjections.register(def)` (line 230-245; `init/apply/view` at 62-84).

## 4. Tracking a delivered message by MessageId

- `UserMessage.id` is the `MessageId` minted by `createUserMessage` (llm/llm/src/message.ts:246).
- Pending: `agent.inbox.nextTurn` / `agent.inbox.nextStep` are `readonly UserMessage[]` (core/agent/src/runtime-types.ts:48-52). `inbox.remove(id): boolean` and `inbox.replace(id, msg): boolean` return whether it was still pending (runtime-types.ts:75-89).
- Durable log: every inbox mutation is one `'agent/inbox/spliced'` event `{target: 'next-turn'|'next-step', start, removedCount?, inserted: UserMessage[], outcome?: 'canceled'}` (core/agent/src/types.ts:96-103).
  - Insert: the message appears in `inserted`.
  - Claim: pure deletion with no `outcome` (agent-loop README.md:71).
  - Discard: deletion with `outcome: 'canceled'` (README.md:71).
  - Entered the log: a `'user/message'` event whose `data.id` matches.
- `agent-team/src/session-message.ts:1-34`: `pendingInboxMessages(events)` folds `agent/inbox/spliced` events with `splice(start, removedCount ?? 0, ...inserted)` over two arrays; `messageAccepted(events, predicate)` is true when a `user/message` matches or the folded inbox still holds a match. It does not return "discarded", it only says accepted or not.
- Live notifications (core/agent/src/runtime-types.ts, Events block): `'agent/inbox/inserted'({agent, message})`, `'agent/inbox/claimed'({agent, message, turn})`, `'agent/inbox/discarded'({agent, message})`. All are agent-scoped.
- Caveat in the `claimed` doc: if the proposed step is rejected, the claimed message is "neither discarded nor re-emitted as a user/message". So a fourth state exists: claimed with no matching `user/message`. A sender should classify: in inbox = pending; spliced out with no `outcome` and a later `user/message` of the same id = entered the log; spliced out with `outcome: 'canceled'` = discarded; spliced out, no outcome, no `user/message` = claimed then dropped.
- Read the log for these checks through `ctx.sessionQuery.readSession` or a `'session/event'` listener (section 3).

## 5. Bounded read of another session's state

- Goal, todos, title are session projections, keys and types:
  - `goal: GoalProjection | null` (goal/goal/src/types.ts:132-140)
  - `todos: TodoItem[] | null` (todo/tool-todo/src/types.ts:39-46)
  - `title: string | null` (session/session-title/src/types.ts:86-92)
  - also `permissions: {currentValue: string}` (interaction/permission-presets/src/types.ts:53-62), `turnOutline` (session/session-turn-outline/src/types.ts:45-48), `sessionStats`, `inbox`
- Live session, synchronous: `ctx.sessionProjections.snapshot(session, keys?): ProjectionSnapshot` returns `{asOfSeq, values}` for wire (client-visible) keys (session/session-projection/src/index.ts:339-357). `stateOf(session, key)` gives host fold state (line 320).
- Any session, live or stored: `ctx.sessionController.projections({sessionId}, signal): Promise<SessionProjectionsValue>` returns `{kind:'sequenced', asOfSeq, values}`, `{kind:'migration-required', values}`, or `null` (api/session-controller/src/index.ts:547-575; type at types.ts:433-440). It does not wake an agent.
- Same data via `using obs = await ctx.sessionQuery.observeSession(id, {signal})`, then `obs.projections?.values` (session-query/src/observation.ts:35).
- Recent messages: no ready-made projection holds message text except `turnOutline`, "every started turn with bounded previews" (session-turn-outline/src/types.ts:46). For raw text use `obs.events` (filter `type === 'user/message'` / `'assistant/message'`) or `ctx.sessionQuery.readSurface(id)`, which returns the current model-visible surface (session-query/src/index.ts:310-320). `ctx.sessionController.page(request, signal): Promise<SessionPage>` is a paged transcript read (api/session-controller/src/index.ts:524); I did not read the `SessionPageRequest` shape (not found).
- Model-facing precedent: `experimental/tool-session-query/src/index.ts:67-135` registers `session_search`, `session_event_search`, `session_trace`, `session_event_read`; it authorizes by matching `header.cwd` (workspace-access.ts:80-135).

## 6. Delegating to a new top-level conversation

A public route exists, in pieces. There is no single "spawn with permissions" call.

1. Create: `ctx.sessionController.create(request): Promise<SessionCreateValue>` (api/session-controller/src/index.ts:300). `SessionCreateRequest {workspaceId?, cwd?, sessionId?, agentPreset?}` (types.ts:288-297); `workspaceId` and `cwd` are mutually exclusive (commands.ts:112-114). Result `{sessionId, agentPreset?}` (types.ts:300). It may reuse a blank session when `sessionId` names one (types.ts:294).
2. Get the live agent: `ctx.sessionController.resolveAgent(sessionId): Promise<ApiSessionAgentResult>` (index.ts:243), `{agent}|{error}`.
3. Read the caller's permissions: `ctx.permissionPresets.current(session): string` (interaction/permission-presets/src/index.ts:344-346 area, `current` at ~line 339); `ctx.sandboxPolicy.overrideOf(session): SandboxMode | undefined` (sandbox/sandbox-policy/src/index.ts:178); `ctx.approval.overrideOf(session): 'ask'|'never'|undefined` (interaction/user-approval/src/index.ts:253-258). Or fold the projection `permissions` (`{currentValue}`).
4. Set the child's permissions: `ctx.permissionPresets.set(session, name): void` (index.ts:387-389); unknown names throw (`resolve`, line 369-373). Catalog: `ctx.permissionPresets.names` (285) and `resolve(name): PresetSpec {sandbox, approval, ...}` (PresetSpec at ~line 63-70). Narrower knobs: `setSandboxMode(session, mode)` from `@deepseek-ai/dsh-sandbox-policy` (sandbox-policy/src/index.ts:33) and `setApprovalPolicy(session, 'ask'|'never')` from `@deepseek-ai/dsh-user-approval` (user-approval/src/index.ts:100).
5. "No wider than caller": dsh has no comparator. Build one from `SANDBOX_MODES = ['read-only','workspace-write','danger-full-access']` (sandbox-policy/src/session-mode.ts, ordered narrow to wide) and `PresetSpec.sandbox/approval`. `'never'` approval is the stricter value. The harness's own delegation does exactly this for subagents: `captureDelegatedPolicyOverrides(parent)` and `appendDelegatedPolicyOverrides(childSession, overrides)` (subagent/subagent/src/child-agent.ts:240-280), which appends `sandbox/mode` / `approval/policy` events with `source: 'delegation'` and pins approval to `'never'`.
6. Start the first turn: obtain the child `agent` from step 2 and call `agent.followup(createUserMessage({content, source}))` (core/agent/src/runtime-types.ts:~225). Alternative: the Remote `prompt` method builds a `source: {kind:'user', ...}` message (index.ts:461-480), which makes it look human-authored; avoid it.
- Not found: a public "spawn child session with a start task" API for top-level sessions (`SubagentRuntime.startActivation(spec)`, subagent/src/index.ts:255-262, creates a subagent child with `origin: 'subagent'`, not a top-level one). Not found: any enforcement that stops a plugin writing a wider preset than the caller's.
- Note: a new session gets the default preset at `'session/created'` through `pinInitialPermission` (permission-presets/src/index.ts:245-249, 428-453). Set the child's preset before the first `followup`.

## 7. Rendering custom `source.kind` in the client transcript

- Declare with `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'my-kind': MySource } }` (example: subagent/subagent/src/continuation-messages.ts:42-47). `MessageSource` is the union of the map (llm/llm/src/message.ts:110-136); consumers "fall through unknowns".
- Non-`user` kinds are not human bubbles. Chat's generic fallback: `contextProducer(source)` returns `{role: 'inject', label: kind}` for unknown kinds (client/ui-chat/src/client/conversation-nodes/event-projection.ts:60-76, default branch at 71-74). The row shows under the durable `kind` string with opaque content (`OpaqueBody` in client/ui-chat/src/client/chat/ContextBody.tsx; `case null: return opaque` at 583-584). Message nodes with `source.kind !== 'user'` become context nodes (conversation-nodes/message.ts:76).
- `form` is read from the source record; it must be one of `KNOWN_FORMS = instructions, catalog, snapshot, notice, relay, recall` (event-projection.ts:38-48). An unknown form renders opaque.
- `form: 'relay'` renders `RelayBody` (ContextBody.tsx:437-453) only if the source has a non-empty string `senderSessionId` (`relaySender`, 456-459, check at 575-578); otherwise it falls back to opaque. The body shows "from <session>" via i18n key `message.context.relay.from`, then the model-facing content.
- Type contract: `ContextFormed` requires `{form:'relay'}` with no extra fields in the type, but the client reads `senderSessionId` from the record (llm/llm/src/message.ts:98-100; AgentMessageSource adds `senderSessionId`, continuation-messages.ts:14-20). To get the relay look with your own kind, include `form: 'relay'` and `senderSessionId` in your source. `notice` needs `summary: string` (message.ts:92-97, bounded by `boundContextSummary` to 120 chars, message.ts:~118-133). `snapshot` needs `sections`.
- The format layer validates known forms (session/session-format-v0-to-v1/src/payload-validation.ts:611, 643); unknown `kind` is allowed ("merge-extensible"). I did not verify that a third-party `kind` with `form: 'relay'` survives that validation on a v4 write path (not found).

## 8. Slash commands for people

- `ctx.commands` is `CommandRuntime` (interaction/commands/src/index.ts:263). Inject `'commands'` (example plugin: session-query/session-log-export/src/index.ts:41 `export const inject = ['commands', 'connection']`).
- `register(definition: CommandDefinition): () => void`, returns a disposer (index.ts:285). Wrap it in `ctx.effect(() => ctx.commands.register({...}), 'label')` as session-log-export does (src/index.ts:79).
- `CommandDefinition` (index.ts:61-79): `definitionId?: CommandDefinitionId`, `name` (lowercase, no slash), `description`, `input?: CommandInputDescriptor`, `recordInput?: boolean` (default true), `handler(invocation): CommandResult | Promise<CommandResult>`.
- `CommandInvocation` (index.ts:41-58): `commandId`, `agent` (the agent whose UI got the command), `rawInput` (text after the name, including leading whitespace), `attachments`, `signal`.
- `CommandResult` is `{kind:'success', text?, sourceEventSeq?} | {kind:'error', text}` (commands/src/types.ts:34-41).
- Example:
  ```js
  ctx.effect(() => ctx.commands.register({
    name: 'peer',
    description: 'Show peer sessions',
    handler: async ({ agent, rawInput }) => ({ kind: 'success', text: '...' }),
  }), 'peer: command')
  ```
- Handlers run without sending anything to the model (index.ts:77 comment). A command registered through a child of an agent context is scoped to that agent and shadows a global one (index.ts:103 message; scoped registration doc near line 260).
- `brandString<CommandDefinitionId>('pkg-name')` makes a `definitionId` (session-log-export/src/index.ts:80); it is optional.
- Not found: a model-hidden flag. Commands are person-only by construction because they go through the UI composer, not the tool registry.

## Summary of gaps

- No public route: a one-call spawn of a top-level child with starting task and bounded permissions (Q6), a "no wider than caller" comparator (Q6), a ready-made recent-messages projection (Q5), a summary `title` field (Q2), and an `agent.parent` property (Q1).
