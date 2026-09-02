# English Learning Chat — Serverless UX and Provider Reliability Improvements

## 0. Purpose

This document is a focused **post-completion improvement task** for the English Learning Chat project.

The MVP and previous post-completion audit work are already implemented.

IMPORTANT:

- Do NOT restart or re-audit the original MVP.
- Do NOT read the entire `SPEC.md` before starting.
- Read the existing source code and current implementation first.
- Read `SPEC.md` or `ROADMAP.md` only if the implementation requires clarification about an original product requirement.
- Keep the scope limited to the improvements described in this file.
- Do not perform unrelated refactoring.
- Preserve both SERVER and SERVERLESS application modes.
- Add or update regression tests where practical.

The goal is to improve several related **serverless mobile UX and provider reliability issues** without introducing unnecessary architectural changes.

---

# 1. Scope and Priorities

Tasks are grouped by priority:

- **P0 — Critical:** broken functionality or behavior that violates an explicit product requirement.
- **P1 — High:** important UX, reliability, configuration, or architectural problems.
- **P2 — Medium:** maintainability and quality improvements.

Priority does not override dependencies.

The agent should prefer the first incomplete dependency-safe task.

---

# 2. Global Rules

## Rule 1 — Preserve the two application modes

The application has two intentionally isolated modes:

```text
SERVER
    React Native
        ↓
    Django API
        ↓
    PostgreSQL / Redis / Celery
        ↓
    LLM provider

SERVERLESS
    React Native
        ↓
    Local SQLite
        ↓
    LLM provider directly
```

Serverless conversation requests must continue to go directly from the mobile application to the configured provider.

Do not route serverless provider requests through the Django backend as part of these fixes.

---

## Rule 2 — Preserve provider abstraction

Provider-specific behavior must remain behind the existing provider abstraction.

The Gemini fix must not introduce Gemini-specific handling into unrelated screens or conversation UI.

Prefer:

```text
Chat / Conversation
        ↓
Provider abstraction
        ↓
Gemini streaming implementation
```

rather than:

```text
Chat screen
    ↓
if Gemini:
    parse Gemini JSON
```

Use the existing architecture wherever possible.

---

## Rule 3 — Tests accompany implementation

Every bug fix should include a regression test where practical.

Do not mark a task complete merely because the application appears to work manually.

---

## Rule 4 — Do not weaken type safety

Mobile:

- Strict TypeScript.
- Explicit types.
- Avoid `any`.
- Use single quotes.
- No semicolons.

Backend:

- Full type annotations.
- Explicit return types.
- Docstrings for public functions/classes.
- PEP 8.
- Ruff-compatible code.

---

## Rule 5 — Do not expose secrets

Never:

- log provider API keys
- log authentication tokens
- expose provider credentials
- send serverless provider keys to the backend
- commit secrets

---

# 3. P1 — Serverless UX and Provider Reliability

## TASK-IMPROVEMENT-001 — Fix Settings Scrollbar Position

Status: `[x]`

Priority: `P1`

### Problem

The scrollbar in the Settings screen is currently visually positioned incorrectly.

The same problem also applies to the **Agent Provider Settings screen** in serverless mode.

The scrollbar should be anchored to the **right edge of the application/screen**, rather than appearing offset inside the Settings content area.

Both screens must have consistent scrollbar behavior.

### Requirements

Inspect the current scrolling implementation for:

- Settings screen
- Agent Provider Settings screen
- `ScrollView` / `FlatList` / equivalent components
- content container styles
- horizontal padding
- parent containers
- safe-area handling
- scrollbar/indicator behavior

Determine why the scrollbar is being positioned away from the right edge.

Fix the layout at the appropriate container level.

The desired behavior is conceptually:

```text
┌──────────────────────────────┐
│ Settings content             │█
│                              │█ ← scrollbar
│                              │█
│                              │█
└──────────────────────────────┘
```

The content itself may retain its intended horizontal padding:

```text
┌──────────────────────────────┐
│   Settings content        █  │
│   Settings content        █  │
│   Settings content        █  │
└──────────────────────────────┘
```

The scrollbar must not move inward simply because the content has horizontal padding.

### Constraints

Do not solve the problem by:

- adding arbitrary negative margins
- hard-coding a scrollbar position
- changing unrelated screen dimensions
- removing scrolling
- hiding the scrollbar
- duplicating the entire Settings layout

Use the smallest appropriate layout fix.

### Acceptance criteria

- The Settings screen remains vertically scrollable.
- The Settings scrollbar is anchored to the right edge.
- The Agent Provider Settings screen scrollbar is also anchored to the right edge.
- Horizontal content padding does not incorrectly move the scrollbar inward.
- Both screens have consistent scrollbar behavior.
- Safe-area behavior remains correct.
- The fix works on representative Android screen sizes.
- No unrelated Settings layout is changed.
- Relevant tests are updated where practical.

---

## TASK-IMPROVEMENT-002 — Keep Chat Input Visible When Keyboard Opens

Status: `[x]`

Priority: `P1`

### Problem

When the user starts typing a message, the input area can become invisible or positioned incorrectly because the keyboard changes the available application viewport.

The current behavior makes the message input difficult or impossible to see while typing.

The expected behavior is similar to a normal mobile chat application:

```text
┌─────────────────────────┐
│                         │
│     Conversation        │
│                         │
│                         │
│                         │
├─────────────────────────┤
│ Message input      Send │
└─────────────────────────┘
          Keyboard
```

The input must remain visible above the keyboard.

### Requirements

Inspect the existing chat screen implementation, including:

- keyboard handling
- safe-area handling
- root layout
- message list
- input container
- `KeyboardAvoidingView` or equivalent
- Android window/keyboard behavior
- flex layout
- absolute positioning, if currently used
- bottom padding/insets

Identify the actual cause rather than adding a fixed offset.

The solution should work when:

- the keyboard is opened
- the user types a short message
- the user types a long message
- the conversation already contains many messages
- the message list is scrolled
- the keyboard is dismissed
- the device has different screen heights

The message list should continue to behave naturally while the input remains accessible.

### Constraints

Do not:

- hard-code a keyboard height
- add an arbitrary large bottom margin
- permanently move the input upward
- break scrolling when the keyboard is closed
- hide existing messages unnecessarily
- introduce a second chat input

Use the existing React Native architecture and the smallest appropriate keyboard/layout mechanism.

### Acceptance criteria

- The message input remains visible when the keyboard opens.
- The input is positioned immediately above the keyboard when appropriate.
- The user can see what they are typing.
- The send button remains accessible.
- Existing message scrolling continues to work.
- Long conversations do not cause the input to disappear.
- Dismissing the keyboard restores the normal layout.
- The behavior works on representative Android screen sizes.
- No fixed keyboard-height workaround is introduced.
- Relevant regression/UI tests are added or updated where practical.

---

## TASK-IMPROVEMENT-003 — Fix Malformed JSON Chunks from Gemini Streaming

Status: `[x]`

Priority: `P1`

### Problem

When using Gemini in serverless mode, sending a simple message such as:

```text
hello
```

can successfully create the conversation, but the application displays an error similar to:

```text
malformed json chunk from provider
```

The provider response is reaching the application, but the streaming/chunk parser is incorrectly interpreting one or more Gemini response chunks.

### Requirements

Trace the complete Gemini streaming path:

```text
Gemini provider
    ↓
HTTP streaming response
    ↓
chunk reader
    ↓
JSON parser
    ↓
provider response normalization
    ↓
conversation/message state
    ↓
UI
```

Determine the actual format of Gemini's streamed response and compare it with the parser's assumptions.

A network chunk is not necessarily equivalent to a complete JSON object.

For example, JSON data may be fragmented across multiple network chunks:

```text
chunk 1:
{"candidates":[{"content":

chunk 2:
{"parts":[{"text":"hel"}]}

chunk 3:
...}
```

The implementation must not assume that every network chunk is independently valid JSON.

Handle fragmented JSON/framing according to the actual Gemini response protocol used by the application.

### Error handling

The provider implementation should:

- correctly parse valid Gemini streaming responses
- handle response data split across network chunks
- correctly process protocol/framing data where applicable
- normalize provider output into the application's existing streaming representation
- preserve incremental text delivery
- preserve completion behavior
- surface genuine provider errors clearly
- avoid logging API keys or other secrets

Do not:

- blindly concatenate unrelated requests
- catch all JSON errors and silently ignore them
- return an empty response when parsing fails
- add Gemini parsing logic to the chat screen
- change the provider abstraction solely to work around this bug

### Acceptance criteria

- Sending `hello` to Gemini in serverless mode does not produce the malformed JSON error.
- Gemini text is displayed correctly.
- Streaming remains incremental.
- Fragmented network chunks are handled correctly.
- Completion events/state are preserved.
- Genuine Gemini/provider errors are still surfaced.
- Existing OpenRouter behavior remains unchanged.
- Provider-specific parsing remains inside the Gemini/provider layer.
- A regression test reproduces the malformed-chunk scenario.
- Tests do not require a real Gemini API key or live provider request.
- No provider secret is logged.

---

## TASK-IMPROVEMENT-004 — Improve Primary and Fallback Model Configuration UI

Status: `[ ]`

Priority: `P1`

### Problem

The serverless provider settings screen allows users to configure a primary model and fallback models, but the current layout does not make the relationship between them sufficiently clear.

Users should understand:

```text
Primary model
    ↓
Used first for normal requests

Fallback models
    ↓
Alternative models used when the primary model
cannot successfully complete the request
```

### Requirements

Improve the layout of:

- primary model selection
- fallback model selection
- selected fallback models
- fallback ordering, if supported
- explanatory text
- save/configuration controls

The primary model should be visually presented as the main/default model.

Fallback models should be clearly presented as secondary models.

If fallback order matters in the current implementation, make that order understandable to the user.

If fallback order does not matter, do not introduce ordering behavior merely for visual purposes.

### In-screen guide

Add concise explanatory guidance directly to the provider settings screen.

The guide should explain:

```text
Primary model

Choose the model you want to use first.
This is your default model for conversations.

Fallback models

Choose one or more alternative models.
They can be used when the primary model fails
or cannot complete the request.

Tip:
Choose a reliable model as your primary model.
Use other compatible models as fallbacks.
```

Use wording appropriate for the existing application's UI style.

Do not create a separate documentation screen.

Do not make the guide excessively long.

### Model selection behavior

Preserve the existing model discovery and provider configuration architecture.

The UI should:

- clearly show the currently selected primary model
- clearly show selected fallback models
- prevent invalid configurations where appropriate
- avoid confusing duplication between primary and fallback selection
- preserve selections when navigating within the screen
- work with a large model catalog

If the current provider/model abstraction already defines model compatibility rules, reuse them rather than duplicating those rules in the screen.

### Acceptance criteria

- Primary model and fallback models are visually distinct.
- A user can understand the purpose of each without external documentation.
- A concise guide is displayed on the screen.
- Existing model discovery continues to work.
- Existing model selection behavior remains functional.
- Fallback selections are clearly visible.
- Large model names do not break the layout.
- The UI remains usable on smaller Android screens.
- Existing provider configurations continue to load correctly.
- Relevant UI/component tests are updated where practical.

---

## TASK-IMPROVEMENT-005 — Navigate Back and Show Success Toast After Agent Configuration Save

Status: `[ ]`

Priority: `P1`

### Problem

In serverless mode, when the user saves the configuration in the Agent Settings screen, the application currently does not provide the expected completion flow.

After a successful save, the user should be returned to the Settings screen and receive clear success feedback.

Expected behavior:

```text
Agent Settings
    ↓
Save configuration
    ↓
Configuration saved successfully
    ↓
Navigate back to Settings
    ↓
Show success toast
```

### Requirements

When saving the serverless agent configuration succeeds:

1. Persist the configuration using the existing configuration mechanism.
2. Confirm the save operation succeeds.
3. Navigate back to the appropriate Settings screen.
4. Display a success toast.

The toast should communicate that the agent configuration was saved successfully.

Use the application's existing toast/notification mechanism if one exists.

Do not introduce a new toast library unless the project currently has no suitable mechanism and a new dependency is genuinely necessary.

### Error behavior

If saving fails:

- remain on the Agent Settings screen
- do not navigate away
- do not show a success toast
- display appropriate error feedback
- preserve the user's entered configuration where practical

The success navigation must happen only after persistence succeeds.

Do not navigate optimistically before the save operation completes.

### Acceptance criteria

- Successful serverless agent configuration save navigates back to Settings.
- A success toast is displayed after the save succeeds.
- The toast does not appear when saving fails.
- Failed saves do not navigate away from Agent Settings.
- Configuration is persisted before navigation occurs.
- Existing Settings navigation behavior remains correct.
- Android back behavior is not broken.
- No duplicate navigation stack entries are created.
- Regression tests cover successful and failed save behavior where practical.

---

# 4. Recommended Execution Order

The default execution order is:

```text
TASK-IMPROVEMENT-001
Settings scrollbar
        ↓
TASK-IMPROVEMENT-002
Chat keyboard/input visibility
        ↓
TASK-IMPROVEMENT-003
Gemini malformed JSON streaming
        ↓
TASK-IMPROVEMENT-004
Primary/fallback model UI
        ↓
TASK-IMPROVEMENT-005
Agent configuration save flow
```

Dependencies may allow some tasks to be implemented independently.

However, the agent should avoid starting a task if another task is actively changing the same architectural area and doing so would cause unnecessary duplicated work.

---

# 5. Validation

After implementation, run the repository's actual validation commands.

For mobile, where applicable:

```text
pnpm lint
pnpm test
pnpm typecheck
```

If the repository uses different commands, use the existing project commands.

## Manual validation

### Settings scrollbar

Verify both screens:

```text
Settings
    ↓
Scroll
    ↓
Scrollbar remains at the right edge
```

and:

```text
Settings
    ↓
Agent Provider Settings
    ↓
Scroll
    ↓
Scrollbar remains at the right edge
```

### Chat

```text
Open conversation
    ↓
Tap input
    ↓
Keyboard opens
    ↓
Type "hello"
    ↓
Verify input remains visible
    ↓
Send message
    ↓
Verify normal conversation behavior
```

### Gemini

```text
Select Gemini
    ↓
Start conversation
    ↓
Send "hello"
    ↓
Receive streamed response
    ↓
Verify no "malformed json chunk" error
```

Also test a response long enough to produce multiple streaming chunks.

### Provider configuration

```text
Open serverless provider settings
    ↓
Select primary model
    ↓
Select fallback model(s)
    ↓
Read the on-screen guidance
    ↓
Save
    ↓
Return to Settings
    ↓
Verify success toast
```

### Failed save

Where practical:

```text
Save configuration
    ↓
Save fails
    ↓
Remain on Agent Settings
    ↓
No success toast
    ↓
Error feedback is shown
```

---

# 6. Definition of Done

This task is complete only when:

1. The Settings scrollbar is anchored to the right edge.
2. The Agent Provider Settings scrollbar is anchored to the right edge.
3. The chat input remains visible when the keyboard is open.
4. Gemini streaming no longer produces the malformed JSON chunk error for valid responses.
5. Gemini fragmented streaming data is parsed correctly.
6. Existing OpenRouter behavior remains functional.
7. Primary and fallback models have a clearer configuration layout.
8. The provider settings screen contains concise guidance explaining primary vs fallback models.
9. Successful serverless agent configuration saves navigate back to Settings.
10. Successful saves display a success toast.
11. Failed saves remain on the Agent Settings screen and do not display a success toast.
12. Relevant regression tests are added or updated.
13. Existing tests continue to pass.
14. Type checking passes.
15. Linting passes.
16. No provider secrets are exposed.
17. No unrelated feature or large refactor is introduced.
18. SERVER and SERVERLESS behavior remain isolated.
19. The implementation follows the existing application architecture.

Do not mark the task complete merely because the application builds.

---

# 7. Final Principle

This is a focused post-completion improvement task.

Prefer:

```text
understand existing implementation
        +
focused fix
        +
regression test
```

over:

```text
large refactor
        +
new dependency
        +
unrelated architectural changes
```

For the Gemini issue in particular, fix the actual streaming/framing problem rather than hiding the parsing error.

For the UI issues, prefer correct layout and navigation behavior over hard-coded offsets or timing-based workarounds.

Preserve working behavior while fixing the observed problems.