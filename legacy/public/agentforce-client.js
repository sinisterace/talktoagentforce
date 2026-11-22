/**
 * Anonymous Agentforce messaging client (MIAW / Embedded Service, API deployment).
 *
 * Four calls make a conversation:
 *   1. POST .../authorization/unauthenticated/access-token  -> guest JWT
 *   2. POST .../conversation                                -> open it
 *   3. GET  /eventrouter/v1/sse                             -> receive replies
 *   4. POST .../conversation/{id}/message                   -> send a turn
 * plus DELETE to hang up.
 *
 * No Salesforce login anywhere: the visitor is a guest, which is the whole
 * point of a public demo link.
 */
export class AgentforceConversation {
  #scrt2;
  #orgId;
  #esConfigName;
  #token = null;
  #conversationId = null;
  #sseAbort = null;
  /** Entry ids already surfaced. The stream echoes our own turns back. */
  #seen = new Set();

  /**
   * @param {object} opts
   * @param {string} opts.scrt2Url        e.g. https://<org>.my.salesforce-scrt.com
   * @param {string} opts.orgId           15-character org id
   * @param {string} opts.esConfigName    EmbeddedServiceConfig DeveloperName (deploymentType Api)
   * @param {(text: string) => void} opts.onAgentMessage
   * @param {(state: string, detail?: string) => void} [opts.onStatus]
   */
  constructor({ scrt2Url, orgId, esConfigName, onAgentMessage, onStatus }) {
    this.#scrt2 = scrt2Url.replace(/\/$/, '');
    this.#orgId = orgId;
    this.#esConfigName = esConfigName;
    this.onAgentMessage = onAgentMessage;
    this.onStatus = onStatus ?? (() => {});
  }

  get conversationId() { return this.#conversationId; }

  async #call(path, { method = 'POST', body, auth = true } = {}) {
    const res = await fetch(this.#scrt2 + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${this.#token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const raw = await res.text();
    return raw ? JSON.parse(raw) : {};
  }

  async start() {
    this.onStatus('connecting');
    const auth = await this.#call('/iamessage/api/v2/authorization/unauthenticated/access-token', {
      auth: false,
      body: {
        orgId: this.#orgId,
        esDeveloperName: this.#esConfigName,
        capabilitiesVersion: '1',
        platform: 'Web',
      },
    });
    this.#token = auth.accessToken;

    // The client owns the conversation id; Salesforce does not mint one.
    this.#conversationId = crypto.randomUUID();
    await this.#call('/iamessage/api/v2/conversation', {
      body: { conversationId: this.#conversationId, esDeveloperName: this.#esConfigName },
    });

    this.#listen();
    this.onStatus('ready');
  }

  /**
   * EventSource cannot set an Authorization header, so read the SSE body by
   * hand. Reconnects once on a dropped stream — a demo shouldn't die because a
   * phone slept for ten seconds.
   */
  async #listen(retry = 0) {
    this.#sseAbort = new AbortController();
    try {
      const res = await fetch(`${this.#scrt2}/eventrouter/v1/sse`, {
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'text/event-stream',
          'X-Org-Id': this.#orgId,
        },
        signal: this.#sseAbort.signal,
      });
      if (!res.ok) throw new Error(`sse ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; the tail may be partial.
        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const frame of frames) {
          const line = frame.split('\n').find(l => l.startsWith('data:'));
          if (line) this.#handleFrame(line.slice(5).trim());
        }
      }
      if (this.#conversationId && retry < 2) this.#listen(retry + 1);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (this.#conversationId && retry < 2) return this.#listen(retry + 1);
      this.onStatus('error', err.message);
    }
  }

  #handleFrame(data) {
    let entry, payload;
    try {
      entry = JSON.parse(data).conversationEntry;
      payload = JSON.parse(entry.entryPayload);
    } catch { return; }

    if (payload.entryType !== 'Message') return;
    if (this.#seen.has(entry.identifier)) return;
    this.#seen.add(entry.identifier);
    // Our own turn comes back on the stream too. Only render the agent's.
    if (entry.sender?.role === 'EndUser') return;

    const text = payload.abstractMessage?.staticContent?.text;
    if (text) this.onAgentMessage(text);
  }

  async send(text) {
    await this.#call(`/iamessage/api/v2/conversation/${this.#conversationId}/message`, {
      body: {
        message: {
          id: crypto.randomUUID(),
          messageType: 'StaticContentMessage',
          staticContent: { formatType: 'Text', text },
        },
        esDeveloperName: this.#esConfigName,
        isNewMessagingSession: false,
      },
    });
  }

  async end() {
    const id = this.#conversationId;
    this.#conversationId = null;
    this.#sseAbort?.abort();
    if (!id) return;
    try {
      await this.#call(`/iamessage/api/v2/conversation/${id}?esDeveloperName=${this.#esConfigName}`, {
        method: 'DELETE',
      });
    } catch { /* hanging up is best-effort; the session times out server-side anyway */ }
    this.onStatus('ended');
  }
}
