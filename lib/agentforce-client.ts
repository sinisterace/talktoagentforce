/**
 * Anonymous Agentforce messaging client — MIAW Custom Client (EmbeddedServiceConfig
 * with deploymentType API).
 *
 * Four calls make a conversation:
 *   1. POST .../authorization/unauthenticated/access-token  -> guest JWT
 *   2. POST .../conversation                                -> open it
 *   3. GET  /eventrouter/v1/sse                             -> receive replies
 *   4. POST .../conversation/{id}/message                   -> send a turn
 * plus DELETE to hang up.
 *
 * This runs in the browser. The scrt2 endpoints answer with
 * `access-control-allow-origin: *` and mint tokens scoped to a single anonymous
 * guest, so there is nothing to proxy and no secret to protect — the visitor
 * never logs in to Salesforce at all. (The ElevenLabs key is a different story;
 * that one stays server-side behind /api/tts.)
 */

export type ConversationStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  /** The event stream dropped and is being re-opened. Replies are paused. */
  | 'reconnecting'
  | 'ended'
  | 'error'

export type AgentforceOptions = {
  scrt2Url: string
  /** 15-character org id. */
  orgId: string
  /** EmbeddedServiceConfig DeveloperName. */
  esConfigName: string
  /** Alphanumeric, underscore and period only. Hyphens are rejected. */
  appName: string
  /**
   * The template's `greeting` from lib/agents.ts. When set, the matching message
   * arriving over SSE is dropped, because the UI has already played the
   * pre-rendered audio for it (see scripts/render-greetings.mjs). Only the first
   * match is suppressed — if the agent says the same sentence again later, that
   * one is real.
   */
  suppressGreeting?: string
  onAgentMessage: (text: string) => void
  onStatus?: (status: ConversationStatus, detail?: string) => void
  /** Fired when the agent starts typing — useful for a thinking indicator. */
  onTyping?: () => void
}

/** Attempts at re-opening a dropped stream before giving up. */
const MAX_STREAM_RETRIES = 5

type Frame = {
  conversationEntry?: {
    identifier?: string
    entryPayload?: string
    sender?: { role?: string }
  }
}

export class AgentforceConversation {
  private scrt2: string
  private orgId: string
  private esConfigName: string
  private appName: string
  private suppressGreeting: string | null
  private onAgentMessage: (text: string) => void
  private onStatus: (status: ConversationStatus, detail?: string) => void
  private onTyping: () => void

  private token: string | null = null
  private convId: string | null = null
  private abort: AbortController | null = null
  /** Entry ids already surfaced. The stream echoes our own turns back. */
  private seen = new Set<string>()
  /** Cleared once the pre-rendered greeting's live twin has been dropped. */
  private greetingPending: boolean

  constructor(opts: AgentforceOptions) {
    this.scrt2 = opts.scrt2Url.replace(/\/$/, '')
    this.orgId = opts.orgId
    this.esConfigName = opts.esConfigName
    this.appName = opts.appName
    this.suppressGreeting = opts.suppressGreeting?.trim() || null
    this.greetingPending = this.suppressGreeting !== null
    this.onAgentMessage = opts.onAgentMessage
    this.onStatus = opts.onStatus ?? (() => {})
    this.onTyping = opts.onTyping ?? (() => {})
  }

  get conversationId(): string | null {
    return this.convId
  }

  private async call(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) {
    const { method = 'POST', body, auth = true } = init
    const res = await fetch(this.scrt2 + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
    const raw = await res.text()
    return raw ? JSON.parse(raw) : {}
  }

  async start(): Promise<void> {
    this.onStatus('connecting')
    const auth = await this.call('/iamessage/api/v2/authorization/unauthenticated/access-token', {
      auth: false,
      body: {
        orgId: this.orgId,
        esDeveloperName: this.esConfigName,
        capabilitiesVersion: '1',
        platform: 'Web',
        context: {
          appName: this.appName,
          clientVersion: '1.0.0',
        },
      },
    })
    this.token = auth.accessToken

    // The client owns the conversation id; Salesforce does not mint one.
    this.convId = crypto.randomUUID()

    // Start listening before opening the conversation. The agent's greeting is
    // pushed the moment routing completes, and a stream opened afterwards would
    // miss it.
    void this.listen()

    await this.call('/iamessage/api/v2/conversation', {
      body: { conversationId: this.convId, esDeveloperName: this.esConfigName },
    })
    this.onStatus('ready')
  }

  /**
   * EventSource cannot set an Authorization header, so read the SSE body by hand.
   *
   * The stream is expected to end and be re-opened during a normal conversation —
   * a phone locking the screen, a network switching from wifi to cellular, or the
   * server simply recycling a long-lived connection. So `retry` counts
   * *consecutive* failed re-opens and resets the moment a stream delivers
   * anything. A counter that only ever increments would quietly run out mid-call
   * and leave the agent mute with no error anywhere, which looks identical to a
   * broken agent.
   *
   * When the budget really is gone the status goes to 'error' rather than just
   * returning, so the UI can say so instead of showing a connected conversation
   * that no longer receives replies.
   */
  private async listen(retry = 0): Promise<void> {
    this.abort = new AbortController()
    /** Whether this attempt got far enough to prove the stream works. */
    let delivered = false
    try {
      const res = await fetch(`${this.scrt2}/eventrouter/v1/sse`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'text/event-stream',
          'X-Org-Id': this.orgId,
        },
        signal: this.abort.signal,
      })
      if (!res.ok || !res.body) throw new Error(`sse ${res.status}`)
      // Came back from a 'reconnecting' state — tell the UI it can stop warning.
      if (retry > 0) this.onStatus('ready')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        delivered = true
        buffer += decoder.decode(value, { stream: true })
        // SSE frames are separated by a blank line; the tail may be partial.
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (line) this.handleFrame(line.slice(5).trim())
        }
      }
      return this.reopen(retry, delivered)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      return this.reopen(retry, delivered, err)
    }
  }

  /**
   * Re-opens the stream after it ended, with backoff. `delivered` means this
   * attempt carried traffic, so the connection is healthy and the retry budget
   * starts over.
   */
  private async reopen(retry: number, delivered: boolean, err?: unknown): Promise<void> {
    if (!this.convId) return // hung up while we were reading
    const next = delivered ? 0 : retry + 1
    if (next > MAX_STREAM_RETRIES) {
      this.onStatus(
        'error',
        `Lost the connection to the agent after ${MAX_STREAM_RETRIES} attempts to reconnect.` +
          (err instanceof Error ? ` Last error: ${err.message}` : ''),
      )
      return
    }
    if (next > 0) {
      this.onStatus('reconnecting')
      // 0.5s, 1s, 2s, 4s, 8s. Enough for a phone coming out of sleep to get its
      // radio back without hammering the endpoint.
      await new Promise((r) => setTimeout(r, 500 * 2 ** (next - 1)))
      if (!this.convId) return
    }
    return this.listen(next)
  }

  private handleFrame(data: string): void {
    let entry: NonNullable<Frame['conversationEntry']>
    let payload: Record<string, unknown>
    try {
      const parsed = JSON.parse(data) as Frame
      if (!parsed.conversationEntry?.entryPayload) return
      entry = parsed.conversationEntry
      payload = JSON.parse(entry.entryPayload!)
    } catch {
      return
    }

    if (payload.entryType === 'TypingStartedIndicator') {
      this.onTyping()
      return
    }
    if (payload.entryType !== 'Message') return

    const id = entry.identifier
    if (id) {
      if (this.seen.has(id)) return
      this.seen.add(id)
    }
    // Our own turn comes back on the stream too. Only render the agent's.
    if (entry.sender?.role === 'EndUser') return

    const msg = payload.abstractMessage as { staticContent?: { text?: string } } | undefined
    const text = msg?.staticContent?.text
    if (!text) return

    // The UI already played the pre-rendered greeting audio, up to 30 seconds
    // before this arrived. Drop the live copy so it is not said twice. Only the
    // first match is dropped; the same sentence later in the call is genuine.
    if (this.greetingPending && text.trim() === this.suppressGreeting) {
      this.greetingPending = false
      return
    }

    this.onAgentMessage(text)
  }

  async send(text: string): Promise<void> {
    if (!this.convId) throw new Error('Conversation not started.')
    // Do not clear greetingPending here. On a cold planner the live greeting can
    // arrive 25-30s after the visitor has already spoken, and clearing it on send
    // un-suppresses that late greeting so it gets spoken on top of the reply — the
    // visitor hears the opening line twice. handleFrame already suppresses only
    // the first matching message and flips the flag itself, so a genuine later
    // repeat is still spoken; leaving the flag alone here is what makes the late
    // greeting drop correctly.
    await this.call(`/iamessage/api/v2/conversation/${this.convId}/message`, {
      body: {
        message: {
          id: crypto.randomUUID(),
          messageType: 'StaticContentMessage',
          staticContent: { formatType: 'Text', text },
        },
        esDeveloperName: this.esConfigName,
        isNewMessagingSession: false,
      },
    })
  }

  async end(): Promise<void> {
    const id = this.convId
    this.convId = null
    this.abort?.abort()
    if (!id) return
    try {
      await this.call(`/iamessage/api/v2/conversation/${id}?esDeveloperName=${this.esConfigName}`, {
        method: 'DELETE',
      })
    } catch {
      // Hanging up is best-effort; the session times out server-side anyway.
    }
    this.onStatus('ended')
  }
}
