# Heroku and environment

## The app

| | |
|---|---|
| App | `talktoagentforce` |
| URL | https://<your-app>.herokuapp.com/ |
| Stack | `heroku-26` |
| Dynos | `web:1` |
| Git | `https://git.heroku.com/talktoagentforce.git` |

Deploy is `git push heroku master:main` — the local branch is `master`, Heroku's
is `main`, so the refspec is not optional. Heroku detects Next.js from
`package.json`, runs `npm run build`, and `Procfile` starts it with
`next start -p $PORT`.

```bash
git remote add heroku https://git.heroku.com/talktoagentforce.git   # once
git push heroku master:main
```

### First deploy, July 2026 — three things that were in the way

1. **The remote held an unrelated app.** `heroku/main` was an unrelated
   Next starter with no common ancestor, so the push was rejected as a
   non-fast-forward. `--force` was correct here, but only after confirming that
   app's history was preserved in a separate local repo
   (same HEAD, `de5eae4`). Heroku git is a real remote, not a deploy target —
   force-pushing it destroys the only copy of whatever was there.
2. **`salesforce/.sfdx` was committed** — 28 MB across 637 files of local
   `sf agent preview` traces and session caches, none of it meaningful off the
   machine that made it. Now gitignored along with `salesforce/.sf/`.
3. **`.slugignore`** keeps `salesforce/`, `docs/`, `specs/`, `knowledge/`,
   `legacy/` and `voicetest/` out of the dyno. Nothing there is read at runtime:
   the blueprint panel is served from the pre-extracted
   `public/blueprint/*.json`, not from the `.agent` source. Slug is 144 MB.

Post-deploy smoke test, all of which should be `200`:

```bash
U=https://<your-app>.herokuapp.com
curl -s $U/api/config | head -c 200
for p in /blueprint/hvac.json /greetings/hvac.mp3; do
  curl -s -o /dev/null -w "$p %{http_code}\n" $U$p
done
curl -s -X POST $U/api/tts -H 'content-type: application/json' \
  -d '{"text":"Deploy check."}' -o /dev/null -w "tts %{http_code} %{content_type}\n"
```

## Config vars

```bash
heroku config -a talktoagentforce
```

| Var | Purpose | Secret |
|---|---|---|
| `ELEVENLABS_API_KEY` | TTS. Personal cost — never send to the browser. | **yes** |
| `ELEVENLABS_VOICE_ID` | `UgBBYS2sOqTuMpoF3BR0` (Mark). | no |
| `ELEVENLABS_MODEL_ID` | `eleven_turbo_v2_5`. | no |
| `SF_SCRT2_URL` | `https://<your-domain>.my.salesforce-scrt.com` | no |
| `SF_ORG_ID` | `00Dxx0000000000` — **15-char**; scrt2 rejects the 18-char form. | no |
| `SF_MIAW_APP_NAME` | `heroku_demo`. Alphanumeric, `_` and `.` only. | no |
| `SF_INSTANCE_URL` | Org instance URL. Logging only; omit to disable. | no |
| `SF_CLIENT_ID` | `Voice_Demo_Logger` consumer key. Logging only. | **yes** |
| `SF_CLIENT_SECRET` | `Voice_Demo_Logger` consumer secret. Logging only. | **yes** |
| `ALLOWED_ORIGINS` | Optional, comma-separated. Extra origins allowed to call `/api/tts` — set it only if the demo is ever embedded on another host. | no |

`SF_SCRT2_URL`, `SF_ORG_ID` and `SF_MIAW_APP_NAME` are served to the browser by
`/api/config`. That is intentional and safe: tokens minted from them are scoped
to a single anonymous guest with messaging access only. The three secrets stay
server-side.

Logging is all-or-nothing on the three `SF_*` credential vars. With any of them
missing, `/api/log` returns `{ logged: false, reason: 'logging-not-configured' }`
and the demo runs normally.

## Local development

`.env` at the repo root is gitignored and loaded by Next automatically:

```
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=UgBBYS2sOqTuMpoF3BR0
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5
SF_SCRT2_URL=https://<your-domain>.my.salesforce-scrt.com
SF_ORG_ID=00Dxx0000000000
SF_MIAW_APP_NAME=heroku_demo
```

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run build
```

`scripts/smoke-transport.mjs` runs outside Next, so it parses `.env` itself.

## Rotating the ElevenLabs key

Do this once more before the link goes public — the current key has appeared in
plaintext in a build transcript.

Scope the key to **text-to-speech only**. `/api/tts` reads the voice and model
from config vars and never calls `/v1/voices` or `/v1/models`, so no other
permission is needed. Verify the scoping is tight:

```bash
for ep in user user/subscription voices models; do
  printf "%-18s %s\n" "$ep" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H "xi-api-key: $KEY" https://api.elevenlabs.io/v1/$ep)"
done
```

All four should return `401` while TTS returns `200`.

1. New key at https://elevenlabs.io/app/settings/api-keys, revoke the old one.
2. `heroku config:set ELEVENLABS_API_KEY=sk_... -a talktoagentforce`
3. Update `.env`.
4. `curl -s -o /tmp/t.mp3 -w '%{http_code} %{size_download}\n' -X POST https://<your-app>.herokuapp.com/api/tts -H 'Content-Type: application/json' -d '{"text":"Rotation check."}'` — expect `200` and tens of KB.

A 401 from ElevenLabs surfaces as a 502 from `/api/tts` with the upstream status
in the body, which is the signal that a rotation skipped step 2.

## Enabling transcript logging

**Done for this org.** Recorded here because it took four failed attempts, each
with an error that pointed somewhere other than the real cause.

Three things must all be true. Each one fails differently:

| Missing | Error from `/services/oauth2/token` or the insert |
|---|---|
| Client Credentials Flow not enabled | `no client credentials user enabled` |
| Run As user not granted the app | `user is not admin approved to access this app` |
| No field-level security | `No such column 'Conversation_Id__c'` |

That third error is the trap — it reads like the deploy failed, but the fields
are in the org and simply invisible. See [06-gotchas.md](06-gotchas.md).

**Steps 1 and 2 are UI-only.** Setup → App Manager → Voice Demo Logger:

1. **Edit** → check **Enable Client Credentials Flow** → **Save**.
2. **Manage** → **Edit Policies** → a *Client Credentials Flow* section now
   appears with a **Run As** lookup. Set `admin@your-org.example` → Save.
   The section is hidden until step 1 is saved. Do not confuse it with the
   *Run As* under **Custom Connected App Handler** — that one is for an Apex
   plugin class and does nothing here.
3. **Manage Consumer Details** → copy key and secret:

```bash
heroku config:set \
  SF_INSTANCE_URL=https://<your-domain>.my.salesforce.com \
  SF_CLIENT_ID=... \
  SF_CLIENT_SECRET=... \
  -a talktoagentforce
```

**Then grant the permissions.** Idempotent, safe to re-run after adding a field:

```bash
sf apex run -o talktoAgentforceSDO -f scripts/grant-logging-access.apex
```

It creates `Voice_Demo_Logger_Access`, assigns it to the Run As user, and grants
object + field access. It cannot insert the `SetupEntityAccess` row that grants
the connected app itself — Apex has no write access to that object — so it prints
the one `curl` needed. Note `SetupEntityType` must be **omitted** from that
payload; sending it returns `INVALID_FIELD_FOR_INSERT_UPDATE`.

Verify locally (`npx next start -p 3333`) or against Heroku once deployed:

```bash
curl -s -X POST http://localhost:3333/api/log \
  -H 'Content-Type: application/json' \
  -d '{"action":"start","conversationId":"probe-1","agentKey":"hvac"}'
```

Expect `{"logged":true,"sessionId":"a2y..."}`. Clean up probe rows with:

```bash
sf data query -o talktoAgentforceSDO \
  -q "SELECT Id FROM Demo_Session__c WHERE Conversation_Id__c LIKE 'probe-%'"
```

## Cost, and the limits that bound it

Salesforce org, metadata, and MIAW messaging: no personal cost. Twilio: not used,
see [04-rejected-approaches.md](04-rejected-approaches.md). **ElevenLabs TTS is
the only thing in this app that spends real money**, billed per character, which
makes `/api/tts` the only route that needs metering. Its URL is visible to anyone
who opens devtools on the public demo.

Four independent limits, in `lib/rate-limit.ts` and the route. Each exists
because the others do not cover its case:

| Limit | Value | Stops |
|---|---|---|
| Per-request length | 1,200 chars | One absurd request. Was already there. |
| Per IP, characters | 20,000 / hour | One visitor burning the budget. ≈8 full conversations. |
| Per IP, requests | 120 / hour | Many cheap requests, which still cost a round trip each. |
| Global, characters | 250,000 / hour | A thousand IPs doing the same. A wallet backstop, well above ten concurrent prospects (~25k). |

Plus an `Origin` check, which returns `403` **before** the body is read. It is
not a security boundary — `Origin` is trivially forged outside a browser, and the
per-IP budget is what actually bounds spend. What it does stop is the cheap and
likely abuse: someone embedding our `/api/tts` in their own page as a free TTS
backend, which a browser will not let them do once the header is checked. A
*missing* `Origin` is allowed, because that is what `curl` and uptime checks look
like; those callers still face the IP budget.

Design notes worth keeping:

- **Continuously-refilling token buckets**, not fixed windows. A fixed window
  hands out the full allowance again the instant it rolls over, so an abuser gets
  2× the cap across a boundary; a bucket refills smoothly and a refused caller
  can retry a small request in seconds rather than waiting out the hour.
- **All-or-nothing debiting.** A refused request debits nothing. Charging anyway
  would push the caller further into the red and they could never recover inside
  the window — tested in `scripts/test-rate-limit.mjs`.
- **`X-Forwarded-For`'s LAST entry, not the first.** Heroku's router appends the
  socket address it actually saw to whatever the client sent, so the first entry
  is attacker-controlled. Keying the limiter on it would let one client mint a
  fresh full bucket on every request by varying one header. This is the single
  easiest thing to get wrong here.
- **In-process, no Redis, no add-on.** One web dyno means one counter. A restart
  (deploy, or Heroku's daily cycle) forgets the buckets; worst case is one extra
  window of spend, which is bounded and small. **If this ever scales past one
  dyno the per-IP caps silently become per-IP-per-dyno** and want a shared store.
- **Client side:** a 429 or 403 throws `VoiceQuietError` in `lib/voice.ts`, which
  the call screen shows verbatim as a notice ("Too many voice replies from this
  connection. The reply is still in the transcript."). The conversation keeps
  going in text — the demo goes quiet, never broken.

Verify against a running server:

```bash
# 403, and no ElevenLabs spend, because Origin is checked before the body is read
curl -s -X POST $U/api/tts -H 'content-type: application/json' \
  -H 'origin: https://evil.example' -d '{"text":"steal"}' -w "\n<- %{http_code}\n"

# 429 with Retry-After on request 121
for i in $(seq 1 122); do
  curl -s -o /dev/null -X POST $U/api/tts -H 'content-type: application/json' \
    -H "origin: $U" -d '{"text":"."}' -w "%{http_code}\n"
done | sort | uniq -c
```

`npm test` covers the limiter's arithmetic without waiting an hour — the clock is
injected — including refill, eviction, and the `X-Forwarded-For` spoof case.
