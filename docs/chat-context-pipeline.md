# Single-chat context assembly

`modules/chat/chatContextPipeline.js` owns `assembleRequestMessages(options)`.
Normal sends delegate through `singleChatRequestOrchestrator`; regeneration,
keyboard continuation and Flowlock call the same assembler directly.

## Ownership

- Callers select history and the request owner (`context.agentId/topicId`).
- Callers retain intent-specific behavior: regeneration truncation, Canvas/attachment
  refresh, context regexes, heartbeat normalization, compaction and stream lifecycle.
- The pipeline resolves one conversation snapshot and uses its rules and workspace
  binding throughout the request. An explicit `conversationSnapshot` is reused.
- Snapshot resolution failure aborts. Legacy APIs without snapshot resolution may
  fall back to `tavernGetRules`; workspace expansion failure preserves the prompt.
- The pipeline does not persist temporary prompts or modify source history.

## Assembly contract

1. Select effective history from the latest compaction checkpoint.
2. Build message content, optional text transforms, current-user suffix, then optional
   content postprocessing. Checkpoints bypass all these processors.
3. Build system text: conversation metadata prefix, AgentName-substituted persona,
   optional append (automatic portrait emotion instructions by default).
4. Apply Tavern system suffix.
5. Expand workspace placeholders once in this assembled system text, using the
   same snapshot. No placeholder means no expansion IPC.
6. Apply Tavern depth injection; existing system messages do not count toward depth.

`temporaryPrompt` appends an outbound-only user message and marks it as the suffix
target. Otherwise callers specify `currentUserMessageId` or `currentUserMessage`.
No target means historical user messages do not receive new suffixes.

`buildMessageContent`, `transformMessageText` and `postProcessMessageContent`
retain existing content processing extension points. `systemPromptPrefix` and
`systemPromptAppend` explicitly override the respective automatic additions.
Do not add entry-specific system/Tavern/workspace assembly around this function.

## Cache scope

Identical resolved inputs produce identical assembled system text across entry
points. Real changes to persona, rules, workspace listing or portrait capabilities
may legitimately change it. This is not a guarantee of provider cache hits:
provider routing, model, cache policy and backend processing also matter.
No extra trimming or whitespace normalization is applied to historical user content.

## Verification

`node --test tests/chat-context-pipeline.test.mjs tests/single-chat-request-orchestrator.test.js tests/flowlock-timestamp-bindings.test.js`

The suite covers shared output equality, one workspace expansion, rules-only
prompts, snapshot reuse/failure, immutable input history, multimodal parts,
temporary-user suffix targeting and compaction checkpoint fidelity.