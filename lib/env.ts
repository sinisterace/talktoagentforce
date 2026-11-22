/**
 * Server-side environment. Throws at first use if a required var is missing, so
 * a misconfigured Heroku release fails loudly on the first request instead of
 * silently returning 500s from deep inside a fetch.
 *
 * Nothing here is exported to the browser except through `publicConfig()`, which
 * deliberately contains no secrets: the scrt2 host and org id are safe to ship
 * (they only ever mint anonymous guest tokens), while the ElevenLabs key stays
 * server-side behind /api/tts.
 */

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required environment variable ${name}. Set it with: heroku config:set ${name}=... -a talktoagentforce`)
  return v
}

export const serverEnv = {
  get elevenLabsKey() {
    return required('ELEVENLABS_API_KEY')
  },
  get elevenLabsVoiceId() {
    return process.env.ELEVENLABS_VOICE_ID ?? 'UgBBYS2sOqTuMpoF3BR0'
  },
  get elevenLabsModelId() {
    return process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5'
  },
  get scrt2Url() {
    return required('SF_SCRT2_URL').replace(/\/$/, '')
  },
  /** 15-character org id. The scrt2 endpoints reject the 18-character form. */
  get orgId() {
    return required('SF_ORG_ID').slice(0, 15)
  },
  /** Alphanumeric, underscore and period only — hyphens are rejected as INVALID_INPUT. */
  get miawAppName() {
    return process.env.SF_MIAW_APP_NAME ?? 'heroku_demo'
  },
  /** Optional. When absent, transcripts are simply not logged. */
  get salesforceLogging() {
    const instanceUrl = process.env.SF_INSTANCE_URL
    const clientId = process.env.SF_CLIENT_ID
    const clientSecret = process.env.SF_CLIENT_SECRET
    if (!instanceUrl || !clientId || !clientSecret) return null
    return { instanceUrl: instanceUrl.replace(/\/$/, ''), clientId, clientSecret }
  },
}

export type PublicConfig = {
  scrt2Url: string
  orgId: string
  appName: string
}

export function publicConfig(): PublicConfig {
  return {
    scrt2Url: serverEnv.scrt2Url,
    orgId: serverEnv.orgId,
    appName: serverEnv.miawAppName,
  }
}
