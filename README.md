# Talk to Agentforce

**A browser-based voice demo for Salesforce Agentforce.** A visitor opens a link on their phone, taps to talk, and has a spoken conversation with a live Agentforce agent. There's no login, no app to install, and no phone call.

The repo has the Next.js web app (deployable to Heroku) and the Salesforce metadata behind it: industry agents written in Agent Script, Apex actions, custom objects, Messaging for In-App and Web (MIAW) channels, and routing flows.

| Industry template | Agent | What it can do |
|---|---|---|
| **HVAC field service** | `HVAC_Service_Voice_Agent` | Triage emergencies, check technician availability, book, reschedule, or cancel visits, explain service plans, answer from knowledge |
| **Financial services** | `Financial_Services_Voice_Agent` | Account balances, recent transactions, lock a card, file a dispute, loan status, answer from knowledge |
| Retail | *(coming soon)* | |

## How it works

```
mic ─► Web Speech API (speech-to-text, in browser)
        │ text
        ▼
   MIAW Custom Client ─────────────► Salesforce scrt2 endpoints ─► Messaging channel ─► Routing flow ─► Agentforce agent
   (anonymous guest token)                                                                              (all reasoning)
        │ ◄── SSE reply text ──────────────────────────────────────────────────────────────────────────────┘
        ▼
   POST /api/tts ─► server-side ElevenLabs proxy (API key never reaches the browser) ─► audio playback
   POST /api/log ─► Salesforce REST (client credentials) ─► Demo_Session__c / Demo_Turn__c transcripts (PII-scrubbed)
```

Some details that make the voice experience work:
- **Pre-rendered greetings and filler phrases** cover the agent's cold start and the 4–7 second planner wait, so the call never goes silent.
- **Turn-taking guards.** The mic pauses during playback so the agent never hears itself, and the app handles a visitor who speaks before the agent's first reply without producing a doubled greeting.
- **A blueprint panel** shows the agent's topics, actions, and variables. It's extracted from the `.agent` file at build time and leaves out org-specific values.
- **Rate limiting on `/api/tts`**, the only endpoint that costs money.
- **PII scrubbing** (phone numbers, emails, street addresses, card numbers, postal codes) runs on every turn before it's logged. It doesn't touch ordinary numbers like "12000 BTU".

## Repo layout

| Path | Contents |
|---|---|
| `app/`, `components/`, `lib/` | Next.js app: industry picker, call screen, MIAW client, TTS proxy, logging, scrubbing |
| `public/` | Pre-rendered greeting and filler audio, icons, extracted blueprints |
| `salesforce/` | SFDX project: agents (`aiAuthoringBundles`), Apex actions, objects, MIAW channels, flows, permission sets |
| `knowledge/` | Sample knowledge articles for each industry |
| `specs/` | Agent Specs (design docs) for each agent |
| `scripts/` | Provisioning, audio rendering, blueprint extraction, latency and transport tests |
| `docs/` | Architecture, how to add an industry, Heroku and env setup, rejected approaches, transcripts, gotchas |
| `legacy/`, `voicetest/` | The original Express prototype and a single-file voice test page |

## Quick start

**Prerequisites:** Node 24, the Salesforce CLI (`sf`), an Agentforce-enabled org, and an ElevenLabs API key.

1. **Deploy the Salesforce side.** Follow [`docs/02-add-an-industry.md`](docs/02-add-an-industry.md). Before deploying, set `default_agent_user` in each `.agent` file and `botUser` in each `.bot-meta.xml` to your org's Einstein Agent User username. Once an agent is published, `scripts/provision-industry.mjs` creates and activates its routing flow, messaging channel, and MIAW deployment.
2. **Configure the app.** Copy `.env.example` to `.env` and fill it in. The full variable reference is in [`docs/03-heroku-and-env.md`](docs/03-heroku-and-env.md).
3. **Run it.**
   ```bash
   npm install
   npm run dev        # http://localhost:3000
   npm test           # transport, rate limiter, fillers, PII scrubbing
   ```
4. **Deploy.** `git push heroku <branch>:main`. Heroku detects Next.js, and the `Procfile` starts it.

Transcript logging is optional. Leave the three `SF_*` credential variables unset and the demo runs without logging.

## Documentation

Start at [`docs/README.md`](docs/README.md).

## License

[MIT](LICENSE)
