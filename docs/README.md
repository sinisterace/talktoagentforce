# Build docs

How the public Agentforce voice demo is put together, and how to repeat it for
the next industry template.

| Doc | Read it when |
|---|---|
| [01-architecture.md](01-architecture.md) | Understanding how a visitor's voice reaches Agentforce and comes back. |
| [02-add-an-industry.md](02-add-an-industry.md) | **Adding agent #2, #3, #N.** The repeatable runbook. |
| [03-heroku-and-env.md](03-heroku-and-env.md) | Deploying, config vars, rotating keys, enabling logging. |
| [04-rejected-approaches.md](04-rejected-approaches.md) | Wondering "why not just use telephony / the Agent API?" |
| [05-transcripts.md](05-transcripts.md) | Working with `Demo_Session__c` / `Demo_Turn__c`, or the PII question. |
| [06-gotchas.md](06-gotchas.md) | Something is failing in a way that makes no sense. |

## The short version

A visitor opens a Heroku URL on their phone, taps to talk, and holds a
conversation with a live Agentforce agent. No login, no app, no phone call.

- **Ears:** Web Speech API in the browser. Free, on-device.
- **Brain:** Agentforce, reached over MIAW Custom Client with an anonymous guest
  token. All reasoning happens here.
- **Mouth:** ElevenLabs, behind a server-side proxy that holds the API key.
- **Memory:** `Demo_Session__c` / `Demo_Turn__c`, written by the server.

## Current state

| | |
|---|---|
| Agent #1 | `HVAC_Service_Voice_Agent`, published and activated as v3 |
| Channel stack | `HVAC_Service_Web` → `HVAC_Route_To_Voice_Agent` → `HVAC_Service_Api` |
| Anonymous transport | verified end to end (`scripts/smoke-transport.mjs`) |
| `/api/tts` | working, returns `audio/mpeg`; rate-limited [03](03-heroku-and-env.md) |
| `/api/config` | working |
| `/api/log` | working — verified writing real `Demo_Session__c` / `Demo_Turn__c` rows |
| PII scrubbing | `lib/scrub.ts`, applied to every turn before insert |
| Greeting audio | pre-rendered, `public/greetings/hvac.mp3`; hides the cold start |
| Filler audio | pre-rendered, `public/fillers/`; covers the 4–7s per-turn think. Shared by every template [01](01-architecture.md#fillers-covering-the-per-turn-wait) |
| Blueprint panel | static, extracted from the `.agent` at build time by `npm run blueprint` |
| Front end | built — `app/page.tsx` picker + `components/CallScreen.tsx`, WebGL visuals |
| Tests | `npm test`, 76 checks (transport, rate limiter, fillers, scrubbing) |
| Live | **deployed** — https://<your-app>.herokuapp.com/ |

## Open items

1. **Warm-keep each live agent** every ~10 min so the visitor's *first reply*
   does not hit the cold planner. The greeting itself is already covered.
   [01](01-architecture.md)
2. **Agents #2 and #3** from the runbook. [02](02-add-an-industry.md)
3. Optional: a live trace panel next to the static blueprint.

Done since the last pass: the transcript objects are trimmed to three fields on
`Demo_Session__c` with no `end` action [05](05-transcripts.md); both known bugs
are fixed and covered by tests (the 401 recursion in `lib/salesforce-rest.ts`,
and `lib/scrub.ts` rewriting `12000 BTU` as `[zip] BTU`); the agent no longer
re-introduces itself mid-call.

Deferred by decision: rotating the ElevenLabs key and consumer secret (both
appeared in plaintext in a build transcript).
