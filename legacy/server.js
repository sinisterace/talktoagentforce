/**
 * Heroku host for the Agentforce voice demo.
 *
 * Deliberately thin. The browser talks to Salesforce MIAW directly (the org
 * already CORS-whitelists *.herokuapp.com), so this server does exactly two
 * things it has to do server-side:
 *
 *   1. Serves the static UI.
 *   2. Proxies text-to-speech to ElevenLabs, because the API key must never
 *      reach the client. That is the entire reason this file exists.
 *
 * Nothing about the conversation is interpreted here. No prompt, no rewriting,
 * no fallback answers: if Agentforce is down the demo is down, which is the
 * honest behaviour for a demo whose point is the agent.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
// Mark (en_US) — the same voice id Agentforce Voice ships as its default, so
// the demo sounds like the product rather than better than it.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'UgBBYS2sOqTuMpoF3BR0';
// eleven_turbo_v2_5 is the low-latency model. Quality is a hair below
// multilingual_v2 but a voice demo lives or dies on time-to-first-audio.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';

/** Agent registry. Agents 2 and 3 get appended here; the UI reads it at load. */
const AGENTS = [
  {
    id: 'hvac',
    label: 'HVAC Service Agent',
    tagline: 'Residential & commercial heating and cooling',
    esConfigName: 'HVAC_Service_Api',
    // Voice tuning mirrors the Agentforce Voice defaults (speed 1,
    // stability 0.65, similarity 0.75) so the demo matches the product.
    voiceId: DEFAULT_VOICE_ID,
    stability: 0.65,
    similarityBoost: 0.75,
    speed: 1,
  },
];

const SALESFORCE = {
  scrt2Url: process.env.SF_SCRT2_URL || '',
  // 15-character org id — the config endpoint rejects the 18-character form.
  orgId: (process.env.SF_ORG_ID || '').slice(0, 15),
};

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ttsConfigured: Boolean(ELEVEN_KEY), agents: AGENTS.length });
});

/** Everything the client needs to reach Salesforce. No secrets in here. */
app.get('/api/config', (_req, res) => {
  res.json({
    salesforce: SALESFORCE,
    ttsEnabled: Boolean(ELEVEN_KEY),
    agents: AGENTS.map(({ id, label, tagline, esConfigName }) => ({ id, label, tagline, esConfigName })),
  });
});

/**
 * POST /api/tts { text, agentId } -> audio/mpeg
 *
 * Streams the MP3 straight through so the browser can start playing before
 * ElevenLabs has finished generating.
 */
app.post('/api/tts', express.json({ limit: '32kb' }), async (req, res) => {
  if (!ELEVEN_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY is not set' });

  const { text, agentId } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  // Agent replies are a few sentences. A long body means something upstream
  // went wrong, and synthesising it would burn credits for no benefit.
  if (text.length > 2000) return res.status(413).json({ error: 'text too long' });

  const agent = AGENTS.find(a => a.id === agentId) ?? AGENTS[0];

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${agent.voiceId}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          model_id: MODEL_ID,
          voice_settings: {
            stability: agent.stability,
            similarity_boost: agent.similarityBoost,
            speed: agent.speed,
          },
        }),
      },
    );

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error('elevenlabs %s: %s', upstream.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'tts upstream failed', status: upstream.status });
    }

    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    // Node fetch gives a web ReadableStream; Response.pipeTo needs a writable,
    // so pump it manually into the Express response.
    const reader = upstream.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error('tts error', err);
    if (!res.headersSent) res.status(502).json({ error: 'tts request failed' });
    else res.end();
  }
});

app.use(express.static(join(here, 'public'), { extensions: ['html'] }));

// Single-page app: anything unmatched falls back to the shell.
app.use((_req, res) => {
  res.type('html').send(readFileSync(join(here, 'public', 'index.html'), 'utf8'));
});

app.listen(PORT, () => {
  console.log(`listening on :${PORT} — tts ${ELEVEN_KEY ? 'enabled' : 'DISABLED (no key)'}`);
});
