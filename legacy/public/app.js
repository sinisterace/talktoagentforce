/**
 * Wires the UI to Agentforce and the voice layer.
 *
 * Turn cycle: hold mic -> SpeechRecognition transcribes -> release sends the
 * text to Agentforce -> reply arrives on SSE -> ElevenLabs speaks it.
 *
 * The mic is disabled while the agent is speaking. Without real barge-in
 * support, a hot mic just transcribes the agent's own voice back at it.
 *
 * All agent and visitor text lands in the DOM via textContent. Never innerHTML:
 * a reply is remote content, and the demo is public.
 */
import { AgentforceConversation } from './agentforce-client.js';
import { Microphone, Speaker, speechInputSupported } from './voice.js';

const els = {
  lobby: document.getElementById('lobby'),
  call: document.getElementById('call'),
  agentList: document.getElementById('agent-list'),
  back: document.getElementById('back'),
  title: document.getElementById('call-title'),
  status: document.getElementById('call-status'),
  dot: document.getElementById('live-dot'),
  transcript: document.getElementById('transcript'),
  mic: document.getElementById('mic'),
  micHint: document.getElementById('mic-hint'),
  typeForm: document.getElementById('type-form'),
  typeInput: document.getElementById('type-input'),
};

const GLYPHS = { hvac: '🌡', default: '◆' };

let config;
let conversation = null;
let speaker = null;
let microphone = null;
let partialBubble = null;
let typingBubble = null;
let agentSpeaking = false;

// ── boot ─────────────────────────────────────────────────────────────

(async function boot() {
  config = await (await fetch('/api/config')).json();
  renderLobby();
  // Chrome populates the voice list asynchronously; touching it early means
  // the browser fallback has real voices to choose from if it's ever needed.
  window.speechSynthesis?.getVoices();
})().catch(err => {
  const li = document.createElement('li');
  li.className = 'disclosure';
  li.textContent = `Could not load configuration: ${err.message}`;
  els.agentList.replaceChildren(li);
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderLobby() {
  els.agentList.replaceChildren(...config.agents.map(agent => {
    const card = el('button', 'agent-card');
    card.append(el('span', 'glyph', GLYPHS[agent.id] ?? GLYPHS.default));

    const copy = el('span');
    copy.append(el('span', 'name', agent.label), document.createElement('br'));
    copy.append(el('span', 'tagline', agent.tagline ?? ''));
    card.append(copy, el('span', 'chevron', '›'));

    card.addEventListener('click', () => startCall(agent));
    const li = document.createElement('li');
    li.append(card);
    return li;
  }));
}

// ── call lifecycle ───────────────────────────────────────────────────

async function startCall(agent) {
  els.lobby.classList.remove('is-active');
  els.call.classList.add('is-active');
  els.title.textContent = agent.label;
  els.transcript.replaceChildren();
  setStatus('connecting…');

  speaker = new Speaker({ agentId: agent.id, ttsEnabled: config.ttsEnabled });
  // Tapping the card is the user gesture iOS requires before audio can play.
  speaker.unlock();

  microphone = new Microphone({
    onPartial: showPartial,
    onFinal: sendTurn,
    onError: message => note(message, true),
  });

  conversation = new AgentforceConversation({
    ...config.salesforce,
    esConfigName: agent.esConfigName,
    onAgentMessage: receiveAgentMessage,
    onStatus: (state, detail) => {
      if (state === 'ready') {
        setStatus('connected', { live: true });
        setComposerEnabled(true);
        els.micHint.textContent = speechInputSupported ? 'Hold to talk' : 'Type below — no mic in this browser';
      } else if (state === 'error') {
        setStatus(detail ? `error: ${detail}` : 'connection lost', { error: true });
      } else if (state === 'ended') {
        setStatus('call ended');
      }
    },
  });

  setComposerEnabled(false);
  try {
    await conversation.start();
  } catch (err) {
    setStatus('could not connect', { error: true });
    note(err.message, true);
  }
}

async function endCall() {
  speaker?.stop();
  microphone?.stop();
  clearTyping();
  await conversation?.end();
  conversation = null;
  els.call.classList.remove('is-active');
  els.lobby.classList.add('is-active');
  setComposerEnabled(false);
}

els.back.addEventListener('click', endCall);

// ── turns ────────────────────────────────────────────────────────────

async function sendTurn(text) {
  clearPartial();
  bubble(text, 'me');
  showTyping();
  try {
    await conversation.send(text);
  } catch (err) {
    clearTyping();
    note(err.message, true);
  }
}

function receiveAgentMessage(text) {
  clearTyping();
  bubble(text, 'agent');
  agentSpeaking = true;
  els.mic.disabled = true;
  els.mic.classList.add('is-speaking');
  els.micHint.textContent = 'Agent speaking…';
  speaker.speak(text, {
    onEnd: () => {
      agentSpeaking = false;
      els.mic.disabled = false;
      els.mic.classList.remove('is-speaking');
      els.micHint.textContent = speechInputSupported ? 'Hold to talk' : 'Type below';
    },
  });
}

// ── mic button ───────────────────────────────────────────────────────

function pressMic(event) {
  event.preventDefault();
  if (agentSpeaking || !conversation) return;
  microphone.start();
  els.mic.classList.add('is-listening');
  els.micHint.textContent = 'Listening — release to send';
}

function releaseMic(event) {
  event.preventDefault();
  if (!microphone?.active) return;
  microphone.stop();
  els.mic.classList.remove('is-listening');
  els.micHint.textContent = 'Sending…';
}

els.mic.addEventListener('pointerdown', pressMic);
els.mic.addEventListener('pointerup', releaseMic);
els.mic.addEventListener('pointercancel', releaseMic);
// Dragging off the button counts as release, otherwise the mic stays open.
els.mic.addEventListener('pointerleave', releaseMic);

els.typeForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = els.typeInput.value.trim();
  if (!text || !conversation) return;
  els.typeInput.value = '';
  sendTurn(text);
});

// ── view helpers ─────────────────────────────────────────────────────

function bubble(text, kind) {
  const node = el('div', `bubble ${kind}`, text);
  els.transcript.append(node);
  scrollDown();
  return node;
}

function note(text, isError = false) {
  const node = bubble(text, 'note');
  if (isError) node.classList.add('is-error');
}

function showPartial(text) {
  if (!text) return clearPartial();
  partialBubble ??= bubble('', 'me is-partial');
  partialBubble.textContent = text;
  scrollDown();
}

function clearPartial() {
  partialBubble?.remove();
  partialBubble = null;
}

function showTyping() {
  clearTyping();
  typingBubble = el('div', 'bubble agent typing');
  typingBubble.append(el('span'), el('span'), el('span'));
  els.transcript.append(typingBubble);
  scrollDown();
}

function clearTyping() {
  typingBubble?.remove();
  typingBubble = null;
}

function setStatus(text, { live = false, error = false } = {}) {
  els.status.textContent = text;
  els.status.classList.toggle('is-error', error);
  els.dot.classList.toggle('is-live', live);
}

function setComposerEnabled(enabled) {
  els.mic.disabled = !enabled || !speechInputSupported;
  els.typeInput.disabled = !enabled;
  els.typeForm.querySelector('button').disabled = !enabled;
}

function scrollDown() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}
