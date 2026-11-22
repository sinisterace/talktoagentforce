# Rejected approaches

Written down so the same ground is not re-covered. Each of these was
investigated against the live org, not reasoned about abstractly.

## Salesforce telephony (NativeVoice / Service Cloud Voice)

**Why it looked right.** Agentforce has a real voice stack. The `.agent` file
even has a `modality voice:` block with `voice_id`, `outbound_speed`,
`outbound_stability`, `outbound_similarity`.

**Why it does not work here.** NativeVoice owns a PSTN audio stream end to end.
The audio goes phone → carrier → Salesforce → agent. There is no supported way
to hand that stream to a web page. The Salesforce softphone is a *Service
Console* surface for employees, not something a public visitor can open.

Bridging it means a third party: Twilio Voice JS SDK opens a WebRTC call from the
browser out to the PSTN and dials the Salesforce number. That works, and it costs
per minute personally.

Also, in this org `NativeVoicePsl` has 0 total licenses, and Agent Builder hides
Connections → Telephony until there is a NativeVoice contact center, an active
Phone-type `MessagingChannel`, and a `connection telephony:` block in the
`.agent`. Licensing is fixable; the audio-path problem is not.

**Consequence for the `.agent` file.** The `modality voice:` block is inert in
this deployment — those settings only apply when Salesforce owns the audio.
They are kept because they are the same values the ElevenLabs proxy uses (the
parameter names are ElevenLabs' own, because NativeVoice uses ElevenLabs
underneath), so the browser demo and a future NativeVoice deployment sound like
the same agent.

**Not thrown away.** Nothing built here blocks adding a Twilio "call it for real"
button later as a second channel on the same agent.

## Agentforce Agent API

`POST https://api.salesforce.com/einstein/ai-agent/v1/agents/{id}/sessions`

Returns **404** with a plain `sf` session token — including against the instance
URL, which serves Salesforce's "URL No Longer Exists" HTML. It requires
connected-app OAuth client-credentials on every session.

That means either shipping OAuth credentials to the browser (no) or proxying
every single turn through Heroku (a hop, a rate limit, and a failure mode in the
critical path). It also produces no `MessagingSession` record.

The MIAW Custom Client gives true anonymous guest tokens direct from the browser,
real `MessagingSession` rows, and needs nothing new provisioned.

## `ConversationEntry` for transcripts

`MessagingSession` rows exist for every demo conversation (MS-00000001 onward),
but `ConversationEntry` returned **0 rows** for all of them. Cause not pinned
down — either entries land only after session close, or a field-level permission
is missing. Roughly 30 minutes to diagnose.

Not worth diagnosing, because even working it cannot answer the questions that
matter for a demo library: which industry template did the visitor try, how long
did each turn take, and where did they give up. Hence `Demo_Session__c` and
`Demo_Turn__c` — see [05-transcripts.md](05-transcripts.md).

## External speech-to-speech model

Would be lower latency and would completely defeat the purpose. The Agent
Script — its guardrails, its safety gates, its actions — is the thing being
demoed. Agentforce does all the reasoning. STT and TTS are ears and a mouth.

## Custom hidden prechat parameters

Standard for passing page context into a routing flow, and
acknowledged-broken by Salesforce engineering as of May 2026: custom hidden
parameters silently drop between scrt2 and the routing-flow input variable.

Moot here anyway. Visitors are anonymous with no page context to carry, so the
routing flow takes only `recordId` and makes a single `routeWork` call.
