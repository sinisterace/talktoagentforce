# Transcripts and instrumentation

Two custom objects, written by the Heroku server, never by the agent.

## Why custom objects

`MessagingSession` rows exist for every conversation, but `ConversationEntry`
returned 0 rows for all of them, and would not answer the questions that matter
for a demo library anyway:

- which industry template did this visitor try?
- how long did each turn actually take?
- how far did they get before giving up?
- were they on a phone?
- did the agent ever produce a real outcome, or just talk?

That is a feedback loop on the demo itself, which is a different thing from a
support transcript.

## Demo_Session__c

One row per visitor conversation. `DS-{00000000}`, sharing `ReadWrite`.

| Field | Type | Notes |
|---|---|---|
| `Agent_Template__c` | Text(80) | The `key` from `lib/agents.ts`, e.g. `hvac`. |
| `Conversation_Id__c` | Text(64), external id | The client-minted MIAW UUID. Joins to `MessagingSession`. |
| `Started_At__c` | DateTime | |
| `Ended_At__c` | DateTime | Empty means they abandoned it. |
| `Turn_Count__c` | Number(5,0) | Low numbers mean the demo lost them early. |
| `Input_Mode__c` | Picklist | `voice` / `text` / `mixed`, restricted. |
| `User_Agent__c` | Text(255) | Whether the demo is being tried on mobile. |
| `Reached_Outcome__c` | Checkbox | True when the agent produced a confirmation number. |

## Demo_Turn__c

One row per spoken turn. Visitor speech and agent reply are separate rows.
`DT-{000000000}`, sharing `ControlledByParent`.

| Field | Type | Notes |
|---|---|---|
| `Demo_Session__c` | Master-Detail | Non-reparentable. |
| `Speaker__c` | Picklist | `visitor` / `agent`, restricted. |
| `Transcript__c` | LongTextArea(32768) | Browser STT output, or the agent reply. |
| `Turn_Number__c` | Number(5,0) | Ordinal, from 1. |
| `Spoken_At__c` | DateTime | |
| `Latency_Ms__c` | Number(8,0) | Agent rows only: send → reply. Blank on visitor rows. |

## The API

`POST /api/log`, one endpoint, three actions:

```jsonc
{ "action": "start", "conversationId": "<uuid>", "agentKey": "hvac", "inputMode": "voice" }
// -> { "logged": true, "sessionId": "a0..." }

{ "action": "turn", "sessionId": "a0...", "speaker": "agent", "text": "...", "turnNumber": 3, "latencyMs": 5221 }
// -> { "logged": true }

{ "action": "end", "sessionId": "a0...", "turnCount": 8, "reachedOutcome": true }
// -> { "logged": true }
```

**It always fails soft.** Every error path returns HTTP 200 with
`{ logged: false, reason }`. A demo must never break because analytics broke:
the conversation is the product, this is the instrumentation. `unknown-agent`
keys are rejected so a crafted request cannot fill the object with junk.

## Auth

`lib/salesforce-rest.ts` uses the OAuth client-credentials flow against the
`Voice_Demo_Logger` connected app — the only grant that works with no human at
a browser. The token is cached in module scope for an hour and refetched on a
401. Setup steps are in [03-heroku-and-env.md](03-heroku-and-env.md).

## PII

Visitors give a name, phone, and address to a demo agent. **Resolved: scrub
before insert, keep no retention job.** If the data never lands raw, retention
stops being a question — which is why there is no scheduled delete.

`lib/scrub.ts` runs on every turn inside `createTurn`, deliberately not in the
route handler, so there is exactly one path to the database and no way to insert
raw visitor text by accident. It is a blunt regex pass, not a classifier: it runs
in the request path, so it has to be cheap and predictable.

| Pattern | Becomes |
|---|---|
| `dana@example.com` | `[email]` |
| `415-555-0132`, `4155550132`, `+1 (415) 555-0132` | `[phone]` |
| `1234 Elm Street` | `[address]` |
| `94110`, `94110-1234` | `[zip]` |
| 13–19 digit runs | `[card]` |

Applied to agent replies too, since the agent reads back what the visitor gave
it. Verified to leave ordinary conversation alone — durations (`3 hours`),
temperatures (`52 degrees`), quantities (`2 units`) and confirmation numbers
(`WO-00012345`) all survive. A stored turn looks like:

```
My furnace died. I'm Dana, [phone], at [address], [zip]. Email [email]
```

Names are **not** scrubbed. A first name alone is low-risk and it is the one
thing that makes a transcript readable when reviewing how a demo went.

## Reading the data

```bash
sf data query -o talktoAgentforceSDO -q "SELECT Name, Agent_Template__c, Turn_Count__c, Reached_Outcome__c, Started_At__c FROM Demo_Session__c ORDER BY Started_At__c DESC LIMIT 20"

sf data query -o talktoAgentforceSDO -q "SELECT Turn_Number__c, Speaker__c, Latency_Ms__c, Transcript__c FROM Demo_Turn__c WHERE Demo_Session__r.Conversation_Id__c = '<uuid>' ORDER BY Turn_Number__c"
```

Both objects have `enableReports: true`, so "abandonment by template" and
"median latency by template" are report-builder work, not code.
