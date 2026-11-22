# Architecture

A public Heroku app where anyone with the link taps a mobile UI and talks to a
live Agentforce agent. No login, no download, no phone call. Several industry
templates share one org and one codebase.

## The chain

```
visitor's browser                      Heroku (Next.js)          Salesforce
─────────────────                      ────────────────          ──────────
mic  ──► Web Speech API (STT, free)
          │
          │ text
          ▼
     AgentforceConversation ──────────────────────────────────►  scrt2
       (lib/agentforce-client.ts)      direct, CORS: *           MIAW endpoints
          │                                                          │
          │                                                     MessagingChannel
          │                                                          │
          │                                                     RoutingFlow
          │                                                          │
          │                                                     Omni queue
          │                                                          │
          │  ◄── SSE ─────────────────────────────────────────  Agentforce agent
          │                                                     (all reasoning)
          │ reply text
          ▼
     POST /api/tts ──────────────►  ElevenLabs proxy  ──────►  ElevenLabs
          │                         (holds the API key)
          │  ◄── audio/mpeg ──────────────────────────────────────
          ▼
     <audio> playback

     POST /api/log ──────────────►  Salesforce REST  ────────►  Demo_Session__c
                                    (client credentials)        Demo_Turn__c
```

## Why each piece is what it is

**Browser STT, not Salesforce STT.** The Web Speech API is free, runs on-device,
and needs no provisioning. Salesforce's own speech stack lives inside
NativeVoice, which owns a PSTN audio stream — it cannot reach a web page. See
[04-rejected-approaches.md](04-rejected-approaches.md).

**ElevenLabs behind a proxy, not from the browser.** The API key is a personal
cost. It must never ship in a JS bundle. `/api/tts` is the only server hop in
the voice path.

**Agentforce does all the reasoning.** No external speech-to-speech model. The
agent's Agent Script — its guardrails, its actions, its safety gates — is the
thing being demoed. STT and TTS are just ears and a mouth.

**MIAW Custom Client, not the Agent API.** `EmbeddedServiceConfig` with
`deploymentType: API` and `areGuestUsersAllowed: true` yields
`authMode: UnAuth`: the browser gets a guest JWT straight from the scrt2
endpoint with no Salesforce login anywhere. The Agentforce Agent API
(`api.salesforce.com/einstein/ai-agent/v1`) requires connected-app OAuth on
every session, which means either shipping credentials to the browser or
proxying every turn. The MIAW path also produces real `MessagingSession`
records and needs no Publish click in Setup.

**Messaging is browser-to-Salesforce direct.** The scrt2 endpoints answer with
`access-control-allow-origin: *` and the guest token is scoped to a single
anonymous visitor, so there is nothing to protect and no reason to add a hop.
Verify with:

```bash
curl -s -i -X POST "$SF_SCRT2_URL/iamessage/api/v2/authorization/unauthenticated/access-token" \
  -H 'Content-Type: application/json' \
  -d '{"orgId":"'"$SF_ORG_ID"'","esDeveloperName":"HVAC_Service_Api","capabilitiesVersion":"1","platform":"Web"}' \
  | grep -i access-control-allow-origin
```

**Custom transcript objects, not `ConversationEntry`.** `MessagingSession` rows
exist for every demo conversation, but `ConversationEntry` queries returned 0
rows for all of them. Even working, it would not capture which industry template
a visitor tried, per-turn latency, or where they gave up — which is the whole
point of instrumenting a demo. See [05-transcripts.md](05-transcripts.md).

## The four calls that make a conversation

All against `$SF_SCRT2_URL`. Implemented in `lib/agentforce-client.ts`, and
reproduced without a browser in `scripts/smoke-transport.mjs`.

| # | Call | Expect |
|---|---|---|
| 1 | `POST /iamessage/api/v2/authorization/unauthenticated/access-token` | 200, ~2000-char JWT, `authMode: UnAuth` |
| 2 | `POST /iamessage/api/v2/conversation` (client mints the UUID) | 201 |
| 3 | `GET /eventrouter/v1/sse` | 200, stays open |
| 4 | `POST /iamessage/api/v2/conversation/{id}/message` | 202 |
| — | `DELETE /iamessage/api/v2/conversation/{id}` | best-effort hang-up |

Two ordering rules the API does not document:

1. **Open the SSE stream before call 2.** The agent's greeting is pushed the
   moment routing completes. A stream opened after the conversation misses it.
2. **The client owns the conversation id.** Salesforce does not mint one; send a
   `crypto.randomUUID()`.

## Timing, measured

From `scripts/smoke-transport.mjs` against the live HVAC agent:

| Step | Cold | Warm |
|---|---|---|
| Guest token | 0.3s | 0.3s |
| SSE open | 0.6s | 0.6s |
| Conversation created | 1.8s | 1.8s |
| **First agent greeting** | **25–30s** | 4.4–5.7s |
| Each subsequent turn | ~5s | ~5s |

The cold-start penalty is **the planner's first inference, not Omni routing** —
`scripts/diagnose-greeting-latency.mjs` prints the SSE event sequence, and it
shows routing finishing at 3.9s and the agent joining at 6.8s, followed by ~23s
of silence before the greeting arrives. Salesforce's typing indicator cannot be
used to cover it: on a cold run `TypingStoppedIndicator` arrived *before* the
message with no `TypingStarted` at all.

Measured over five runs: 30.3s cold, then 4.4 / 5.5 / 5.7 / 4.6s. The warm
window is longer than 11 minutes (verified with a `sleep 660` gap); the upper
bound is untested.

**The greeting gap is covered by pre-rendered audio.** See "Pre-rendered
greetings" below. What that does *not* cover is the visitor's first real reply,
which still eats the penalty if the planner was cold when they finished
speaking — that is what the keep-alive is for.

## Pre-rendered greetings

Every template's welcome message is a fixed string, identical for every visitor
forever, yet Agentforce takes up to 30 seconds to push it. So it is rendered to
a static MP3 ahead of time and played the instant the visitor taps:

```bash
npm run greetings          # render missing or changed greetings
npm run greetings:check    # verify only; non-zero exit if stale
```

`scripts/render-greetings.mjs` writes `public/greetings/<key>.mp3` plus a `.sha`
sidecar fingerprinting the text, voice and model, so changing any of the three
re-renders. The MP3s are committed — they are build inputs, and Heroku must not
need an ElevenLabs key to serve them.

`/api/config` returns `greeting` and `greetingAudio` per template. The browser
plays `greetingAudio` immediately and passes `greeting` to
`AgentforceConversation` as `suppressGreeting`, which drops the live copy when it
eventually arrives so it is not spoken twice. Only the first match is dropped.

If the `welcome:` line in a `.agent` file is edited and `lib/agents.ts` is not,
the visitor would hear the greeting twice. `render-greetings.mjs` compares the
two and refuses to run on a mismatch, so `npm run greetings:check` in a
pre-deploy step catches it.

## Fillers: covering the per-turn wait

The greeting gap is covered by a pre-rendered MP3. Every turn *after* it has its
own gap — 4 to 7 seconds, median ~4.9s across nine measured turns — and this
channel sends the client nothing during it that can be shown or spoken.

There is no progress-indicator frame on the MIAW custom client. Verified across
four unfiltered `scripts/dump-frames.mjs` runs, including turns that fired Apex:
the vocabulary is `ConversationUpdated`, `RoutingResult`, `RoutingWorkResult`,
`SessionStatusChanged`, `ParticipantChanged`, `TypingStartedIndicator`,
`TypingStoppedIndicator`, `Message`, and bare `event: ping`. Nothing carries the
`progress_indicator_message` text authored on each action, and
`TypingStartedIndicator` has no text field at all. `capabilitiesVersion` 2, 3 and
4 all return HTTP 400. The whole wait lands in the
`TypingStartedIndicator` → `Message` gap.

So the holding line is spoken locally, from static audio:

```bash
npm run fillers          # render missing or changed clips
npm run fillers:check    # verify only; non-zero exit if stale
npm run fillers -- --force   # re-render everything
```

`scripts/render-fillers.mjs` writes flat `public/fillers/<slug>.mp3` files plus a
single shared `public/fillers/manifest.json`:

```json
{
  "openers": [{ "id": "one-moment", "text": "One moment.", "audio": "/fillers/one-moment.mp3", "stamp": "…" }],
  "waits":   [{ "id": "still-looking", "text": "Still looking.", "audio": "/fillers/still-looking.mp3", "stamp": "…" }]
}
```

`stamp` is a sha256 of voice id + model id + text, so editing a line or changing
the voice re-renders exactly that clip. The MP3s are committed, same reason as
the greetings: Heroku must not need an ElevenLabs key to serve them.

**The lines say nothing about what the agent is about to do, and that is the
whole design.** The first version picked a clip by keyword-matching the visitor's
utterance against each action's `progress_indicator_message` — "Checking the
schedule" when they said *book*, "Looking up the appointment" when they said
*reschedule*. It was wrong in principle, not in tuning. Those messages are
authored to narrate an action **already executing**; spoken *before* the planner
has decided anything, they assert a decision that has not been made. A visitor
saying "I want to move my Thursday visit" heard "Let me look that up" and then
got asked for a phone number — the agent had announced a lookup it could not
perform yet. No keyword threshold fixes that: a topically-correct guess still
produces a false sentence. See the header comment in `lib/fillers.ts`.

The replacement is eight generic lines, four per group, each true of every turn,
picked by rotation:

```ts
nextFiller(clips, turn)   // clips[turn % clips.length]
```

Rotation rather than random so the same line never lands twice in a row.
`lib/fillers.ts` is that function and two types; there is no picker, no
tokeniser, no threshold, and no per-template manifest. **Adding an industry needs
zero filler configuration.**

Two timers per turn, both in `lib/use-call.ts`:

| Timer | Delay | Group | Why |
|---|---|---|---|
| `fillerTimerRef` | 1200ms | `openers` | Fires on essentially every turn. Not zero, so a genuinely fast reply just arrives instead of queueing behind a clip. |
| `secondFillerTimerRef` | 4500ms | `waits` | Normally cleared before it fires. It is for the tail — the org occasionally takes 15 to 30s, and one clip followed by twenty seconds of nothing is barely better than silence. 4500 and not sooner because the opener is about a second long and two clips back to back sound like a stutter. |

Both are cleared the moment `onAgentMessage` arrives, or on a send failure.
`Voice.speakFiller` drops a clip if anything is already queued or speaking: by
then there is no silence left to fill, so playing it late would talk over the
real reply. The caption is set to the clip's text, so the visitor reading the
screen and the visitor listening get the same words.

Coverage: `scripts/test-fillers.mjs` (14 checks in `npm test`) tests rotation
against the real manifest and asserts every line is ≤40 characters and that **no
line commits the agent to an action** — a regex over book/schedule/cancel/
dispatch/create/update/confirm, which is the mistake above encoded as a test.
`scripts/verify-fillers.mjs` drives a real browser and times when each clip is
actually audible.

## Blueprint extraction: the "Look inside" panel

The demo shows a prospect the real agent configuration — topics, instructions,
action signatures, variables, the routing graph. That data is extracted from the
`.agent` file at build time into `public/blueprint/<key>.json`:

```bash
npm run blueprint          # write every live template
npm run blueprint:check    # verify only; non-zero exit if stale
```

**Build time, not runtime, because the org cannot answer the question.** There is
no queryable planner-trace object in this org — `AiAgentSession`,
`GenAiPlannerFunctionInvocation` and friends do not exist — and the objects that
do exist, `GenAiPlannerDefinition` and `GenAiPluginDefinition`, return names
without instructions, action shapes, or the graph. The `.agent` file has all of
it, it is the artifact a builder actually edits, and reading it at build time
costs the visitor nothing and cannot fail mid-demo.

`scripts/extract-blueprint.mjs` parses the file to an indentation tree first and
reads meaning off the tree, rather than regexing the source — regex gets the
shallow fields right and the nested ones subtly wrong. It emits per topic: the
instruction blocks (flattened, with their `if` conditions kept as branches,
which is the part that surprises people), `before_reasoning` /`after_reasoning`
guards, transitions, `setVariables` setters, gated action calls with their
`available when` expressions, and the full input/output signature of every Apex
and standard action.

One redaction, done here so it happens once: `default_agent_user` is an org
username and is dropped. Everything else in a `.agent` file *is* the thing being
demonstrated.

**Editing a `.agent` file makes the blueprint stale.** `--check` exits non-zero
in that case; run `npm run blueprint` after any agent edit and commit the JSON.
`npm run audio` does blueprint, greetings and fillers in one go.

## Stream reconnection

The SSE stream is *expected* to end and be re-opened mid-conversation — a phone
locking, a wifi-to-cellular handoff, or the server recycling a long connection.
`listen()` counts only *consecutive* failed re-opens (budget 5, backoff 0.5s
doubling to 8s) and resets the count the moment a stream delivers any bytes. A
counter that only incremented would run out mid-call and leave the agent mute
with no error anywhere — indistinguishable from a broken agent, and invisible on
a desktop.

Exhausting the budget emits `onStatus('error', ...)`; a retry in progress emits
`'reconnecting'`, and `'ready'` again on recovery. `scripts/test-client.mjs`
(`npm test`) covers all of it against a mocked transport, including ten healthy
renewals in a row.

## Repo layout

```
app/api/config/route.ts     scrt2 host, org id, live agent list → browser
app/api/tts/route.ts        ElevenLabs proxy; holds the API key
app/api/log/route.ts        transcript logging; fails soft, always
lib/agentforce-client.ts    the four-call MIAW client (runs in the browser)
lib/agents.ts               the industry template library
lib/use-call.ts             one hook holding an entire call, including the filler timers
lib/voice.ts                mic in, ElevenLabs playback out, half-duplex
lib/fillers.ts              rotation over the shared holding lines
lib/scrub.ts                PII redaction, applied on the way to the database
lib/env.ts                  server env, throws loudly on missing vars
lib/salesforce-rest.ts      client-credentials REST client for logging
scripts/provision-industry.mjs   one command per new industry template
scripts/smoke-transport.mjs      end-to-end transport test, no browser
scripts/render-greetings.mjs     pre-renders greeting audio; hides the cold start
scripts/render-fillers.mjs       pre-renders the shared holding lines
scripts/extract-blueprint.mjs    .agent file → public/blueprint/<key>.json
scripts/test-client.mjs          npm test — reconnect + greeting suppression
scripts/test-fillers.mjs         npm test — rotation, and no line claims an action
scripts/test-scrub.mjs           npm test — redaction, and units surviving it
scripts/verify-fillers.mjs       drives a real browser; times when clips are audible
scripts/dump-frames.mjs          every SSE frame, unfiltered
scripts/diagnose-greeting-latency.mjs  prints every SSE frame with timings
scripts/templates/               the three metadata templates it renders
public/greetings/                committed greeting MP3s, one per template
public/fillers/                  committed holding-line MP3s + manifest.json (shared)
public/blueprint/                extracted agent configuration, one per template
salesforce/force-app/main/default/
  aiAuthoringBundles/        the agents themselves
  embeddedServiceConfigs/    one API-type ESC per industry
  messagingChannels/         one channel per industry
  flows/                     one routing flow per industry
  objects/Demo_Session__c/   transcript header
  objects/Demo_Turn__c/      transcript lines
  connectedApps/             Voice_Demo_Logger (server-side logging creds)
legacy/                      the pre-Next Express prototype, kept for reference
```
