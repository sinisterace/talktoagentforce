# Gotchas

Every one of these cost real time during the build.

## MIAW / channel

**`appName` rejects hyphens.** The `context.appName` in the access-token request
allows alphanumerics, `_` and `.` only, max 40 chars, case sensitive. `heroku-demo`
returns `INVALID_INPUT`; `heroku_demo` works.

**Open the SSE stream before creating the conversation.** The greeting is pushed
the moment routing completes. A stream opened after `POST /conversation` misses
it and the UI looks dead for a turn.

**The client mints the conversation id.** Salesforce does not return one. Send a
`crypto.randomUUID()` in `POST /conversation` and reuse it for every message.

**`authMode` is nested.** In the scrt2 config response it is
`embeddedServiceConfig.embeddedServiceMessagingChannel.authMode`, not top-level.
Reading the top level gives `undefined`, which is easy to mistake for "not
UnAuth".

**A plain queue silently kills routing.** If `MessagingChannel.sessionHandlerQueue`
points at a Salesforce queue with no `QueueRoutingConfig`, the visitor gets
"agents are not available" and the error email goes to the *flow owner*.
`scripts/provision-industry.mjs` refuses to run in that case. Check with:

```bash
sf data query -o talktoAgentforceSDO -q "SELECT QueueRoutingConfigId FROM Group WHERE Type='Queue' AND DeveloperName='SDO_Service_Messaging'"
```

**`MessagingChannel.IsActive` is read-only via the Metadata API.** It has to be
flipped with Apex. The provisioning script does this.

**First greeting takes 25–30 seconds on a cold planner.** Not Omni routing —
routing finishes at 3.9s and the agent joins at 6.8s; the rest is the planner's
first inference. Warm runs are 4–6s and the warm window is over 11 minutes.
Covered by pre-rendered greeting audio, not by waiting. See
[01-architecture.md](01-architecture.md).

**The typing indicator cannot cover the cold gap.** On a cold run
`TypingStoppedIndicator` arrives *before* the message, with no `TypingStarted`
before it. The UI has to supply its own thinking state.

**The SSE stream ends normally, repeatedly.** It is not a failure signal. A retry
counter that only increments will exhaust itself mid-conversation and leave the
agent mute with no error — count only *consecutive* failures and reset on any
delivered byte. `npm test` guards this.

## Metadata API

**Field files need the `__c` suffix in the filename.** `Agent_Template.field-meta.xml`
deploys the object but fails every field with *"named in package.xml, but was not
found in zipped directory"*. It must be `Agent_Template__c.field-meta.xml`.

**Metadata filenames are type-inferred and case-sensitive.**
`X.embeddedServiceConfig-meta.xml` (lowercase `e`) breaks
`sf project deploy --metadata` for the *entire package* with a
`TypeInferenceError`, even for unrelated components. Both files in this repo have
been renamed to `.EmbeddedServiceConfig-meta.xml`.

**Scope agent deploys with `--source-dir`.** `--metadata AiAuthoringBundle:X`
walks the whole package directory and fails on any malformed filename anywhere
in it.

**A custom field deploys with no visibility to anyone, including admins.** A
successful 16/16 deploy is not enough: `sf data query` returns *"No such column
'Conversation_Id__c'"* and `/describe` reports zero custom fields, which reads
exactly like a failed deploy. The fields are there — retrieve the object and
count `<fields>` to prove it. They need `FieldPermissions` on some permission
set before anything can see them. `scripts/grant-logging-access.apex` does this.

**`ObjectPermissions` / `FieldPermissions` cannot be upserted.** No external id,
so `Database.upsert` inserts duplicates and every row fails `DUPLICATE_VALUE` on
a second run. Query the existing rows and insert only the difference.

**`FieldPermissions` rejects required fields.** Master-detail and required fields
are always visible, so passing one returns an error. Omit them from the list.

**`isClientCredentialsEnabled` does not exist in `ConnectedAppOauthConfig`.** The
Metadata API schema has only `callbackUrl`, `certificate`, `consumerKey`,
`consumerSecret`, `idTokenConfig`, `isAdminApproved`, `scopes`, `singleLogoutUrl`.
Enabling client credentials, setting "Run As", and reading the consumer secret are
all UI-only. See [03-heroku-and-env.md](03-heroku-and-env.md).

**A whole-package dry run fails while an agent is active.** Expect
`Cannot update record as Agent is Active` / `Can't edit an active bot version` on
`sf project deploy start --dry-run` with no `--source-dir`. That is the active
agent version refusing to be overwritten, not a broken repo.

## `sf` CLI

**It prepends an update banner to stdout.** Strip it before parsing:
`sed -n '/^{/,$p'`. `scripts/provision-industry.mjs` slices from the first `{`.

**`sf org display --json` redacts `accessToken`.** Use
`sf org auth show-access-token --json`.

**SOQL rejects a subquery in a scalar `WHERE` position.**
`WHERE ConversationId = (SELECT ... )` is `MALFORMED_QUERY`. Query the id first,
pass it as a literal.

## Agent Script

**Conversation stickiness is not automatic.** Salesforce re-enters the router
every turn. Without a guard, a caller mid-booking gets re-classified and the
agent starts improvising questions it was told never to ask. The pattern that
works: each subagent stamps a flow variable in its own `before_reasoning`, and
the router's `before_reasoning` reads it and transitions straight back.

**No `else if`, no nested `if`.** Flat `if`/`else` only. Use sequential `if`s or
compound conditions.

**`@utils.transition to` only in `reasoning.actions`; bare `transition to` only
in `before_reasoning`/`after_reasoning`.**

**Read the traces, don't trust the reply text.** An agent will happily claim it
booked something it never called an action for. Local traces:
`salesforce/.sfdx/agents/<AgentName>/sessions/<uuid>/traces/<planId>.json`.
Step order reveals routing: `NodeEntryStateStep` (carries `agent_name`) →
`EnabledToolsStep` → `LLMStep` → `UpdateTopicStep` → `TransitionStep` → next
`NodeEntryStateStep`. **A turn with only one `NodeEntryStateStep` never left that
agent.** `FunctionStep` shows the action name, input, and output.

## Local environment

**macOS has no `timeout`.** Background long-running commands instead.

**A stale `next start` holds its port.** `EADDRINUSE` on a port you thought was
free is usually a leftover dev server. `lsof -nP -iTCP:<port> -sTCP:LISTEN`.

**`public/index.html` would shadow the Next route.** The old Express prototype
lives in `legacy/` for exactly this reason.
