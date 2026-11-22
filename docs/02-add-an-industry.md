# Add an industry template

The repeatable runbook. About 15 minutes of channel work per industry once the
agent itself exists.

## Prerequisites

- The agent is authored, validated, published, and **activated**. Until it is
  activated there is no `BotDefinition` for the routing flow to point at.
- `sf` CLI authenticated to the org (`talktoAgentforceSDO`).

## Step 1 — Author the agent

Follow the normal Agent Script lifecycle. Copy an existing bundle as a starting
point; `HVAC_Service_Voice_Agent` already carries the voice rules worth keeping:

- one or two sentences per turn, one question at a time
- never speak URLs, markdown, or digit-grouping commas; money in words
- confirmation numbers read digit by digit
- never claim a booking without a confirmation number in hand
- the demo-line rule: no transfer, no hold, no callback, no message — name the
  boundary, say what a real deployment would do, offer what you can

```bash
cd salesforce
sf agent generate authoring-bundle --json --no-spec --name "Retail Service Agent" --api-name Retail_Service_Voice_Agent
# edit the .agent file
sf agent validate authoring-bundle --json --api-name Retail_Service_Voice_Agent
sf project deploy start --json --source-dir force-app/main/default/aiAuthoringBundles/Retail_Service_Voice_Agent
```

Scope the deploy with `--source-dir`, not `--metadata AiAuthoringBundle:X`. The
`--metadata` form walks the whole package directory and fails on any malformed
filename anywhere in it.

Smoke-test with live actions and read the traces before publishing:

```bash
sf agent preview start --json --use-live-actions --authoring-bundle Retail_Service_Voice_Agent
sf agent preview send --json --authoring-bundle Retail_Service_Voice_Agent --session-id <ID> -u "..."
# traces: salesforce/.sfdx/agents/<AgentName>/sessions/<uuid>/traces/<planId>.json
```

Then release:

```bash
sf agent publish authoring-bundle --json --api-name Retail_Service_Voice_Agent
sf agent activate --json --api-name Retail_Service_Voice_Agent
```

## Step 2 — Provision the channel stack

One command. It renders three metadata files from `scripts/templates/`, deploys
them, activates the channel via anonymous Apex (`IsActive` is read-only through
the Metadata API), and verifies the live scrt2 config reports
`authMode: UnAuth`:

```bash
node scripts/provision-industry.mjs --key retail --agent Retail_Service_Voice_Agent
```

Preview without deploying:

```bash
node scripts/provision-industry.mjs --key retail --agent Retail_Service_Voice_Agent --dry-run
```

What it creates, for `--key retail`:

| Metadata | Name |
|---|---|
| RoutingFlow | `Retail_Route_To_Agent` |
| MessagingChannel | `Retail_Web` |
| EmbeddedServiceConfig (API) | `Retail_Api` |

It refuses to run if the queue has no `QueueRoutingConfigId` — a plain
Salesforce queue instead of an Omni-Channel queue is the cause of the
"agents are not available" dead end, and the routing-flow error email goes to
the flow owner, not the visitor, so it is easy to miss.

## Step 3 — Register it in the app

Add the entry the script prints to `AGENTS` in `lib/agents.ts`:

```ts
{
  key: 'retail',
  label: 'Retail Service Agent',
  blurb: 'What the visitor can try, in one line.',
  esConfigName: 'Retail_Api',
  greeting: 'Thanks for calling. This is the retail service agent. How can I help?',
  live: true,
}
```

`greeting` must be a **verbatim** copy of `system.messages.welcome` from the
`.agent` file. Then render its audio:

```bash
npm run greetings
```

That writes `public/greetings/retail.mp3`, which the UI plays the instant the
visitor taps so nobody waits out the 25–30s cold planner. The script refuses to
run if the two strings have drifted apart, because a mismatch means the visitor
hears the greeting twice. Commit the MP3.

Set `live: false` while building — the entry stays out of the public list but
`/api/config` still resolves it for local testing.

## Step 3b — Extract the blueprint

The "Look inside" panel reads `public/blueprint/<key>.json`, extracted from the
`.agent` file:

```bash
npm run blueprint          # writes public/blueprint/retail.json
npm run blueprint:check    # non-zero exit if any is stale
```

Commit the JSON. **Re-run this after every `.agent` edit**, including edits to an
industry that already shipped — `--check` is what catches a forgotten one, so it
belongs in a pre-deploy step.

The bundle directory has to start with the key: `--key retail` looks for a bundle
under `aiAuthoringBundles/` beginning `retail`, case-insensitively, so
`Retail_Service_Voice_Agent` matches.

**Nothing to do for fillers.** The holding lines spoken during the planner's
4-to-7-second think are generic, shared by every template, and already rendered —
see [01-architecture.md](01-architecture.md#fillers-covering-the-per-turn-wait)
for why guessing per-industry lines was a mistake. A new industry inherits them
with no configuration. Only touch `npm run fillers` if you are changing the lines
or the voice for everyone.

All three audio/data steps at once:

```bash
npm run audio          # blueprint + greetings + fillers
npm run audio:check    # verify all three; non-zero exit if any is stale
```

## Step 4 — Verify anonymously

```bash
node scripts/smoke-transport.mjs --esconfig Retail_Api --say "what do you help with?"
```

Passes when: token is `authMode: UnAuth`, conversation returns 201, a greeting
arrives, and the reply to your utterance arrives. Expect 25–30s for the greeting
on a cold planner and ~5s per turn after that. The visitor never sees that gap —
the pre-rendered MP3 covers it — but this script does.

## Step 5 — Ship

```bash
git add -A && git commit -m "Add retail industry template"
git push heroku main
```

## Naming

Derived from `--key` (lowercase, letters/digits/underscores). `retail` gives
`Retail_Route_To_Agent`, `Retail_Web`, `Retail_Api`, label "Retail". Override the
label with `--label "Retail Service"`; the API names still come from the key.

Every industry gets its own channel and flow rather than sharing one. Channels
are cheap, and sharing would mean one routing flow branching on something the
anonymous visitor cannot supply.
