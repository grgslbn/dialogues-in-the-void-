const db = require('./db');

let state = { status: 'idle', currentSessionId: null, waitingFor: null, connectedAgents: {}, turnCount: 0, lastMessages: [] };
let io = null;
let turnTimeout = null;

function init(socketIo) { io = socketIo; }
function getState() { return { ...state, connectedAgents: Object.keys(state.connectedAgents) }; }

function registerAgent(modelId, socket) {
  state.connectedAgents[modelId] = socket;
  console.log(`[orchestrator] Agent ${modelId} connected`);
  broadcastStatus();
}

function unregisterAgent(modelId) {
  delete state.connectedAgents[modelId];
  console.log(`[orchestrator] Agent ${modelId} disconnected`);
  broadcastStatus();
}

function startSession(seed = null) {
  if (state.status === 'running') return { error: 'Already running' };
  const sessionId = db.createSession(seed);
  state.currentSessionId = sessionId;
  state.status = 'running';
  state.turnCount = 0;
  state.lastMessages = [];
  db.setConfig('session_state', { status: 'running', current_session_id: sessionId });
  console.log(`[orchestrator] Session started: ${sessionId}`);
  broadcastStatus();
  scheduleTurn('A', seed);
  return { sessionId };
}

function pauseSession() {
  if (state.status !== 'running') return { error: 'Not running' };
  state.status = 'paused';
  if (turnTimeout) clearTimeout(turnTimeout);
  broadcastStatus();
  return { ok: true };
}

function resumeSession() {
  if (state.status !== 'paused') return { error: 'Not paused' };
  state.status = 'running';
  broadcastStatus();
  scheduleTurn(state.waitingFor || 'A');
  return { ok: true };
}

function stopSession() {
  if (!state.currentSessionId) return { error: 'No active session' };
  if (turnTimeout) clearTimeout(turnTimeout);
  db.endSession(state.currentSessionId);
  state.status = 'idle';
  state.currentSessionId = null;
  state.waitingFor = null;
  state.turnCount = 0;
  db.setConfig('session_state', { status: 'idle', current_session_id: null });
  broadcastStatus();
  return { ok: true };
}

function injectSeed(text) {
  if (state.status !== 'running') return { error: 'Not running' };
  io.emit('seed_inject', { type: 'seed_inject', content: text, session_id: state.currentSessionId });
  broadcastToPublic({ type: 'system', content: `[SEED: ${text}]`, session_id: state.currentSessionId });
  return { ok: true };
}

function scheduleTurn(modelId, context = null) {
  const pacing = db.getConfig('pacing');
  const delay = pacing?.turn_delay_ms || 3000;
  state.waitingFor = modelId;
  if (state.status !== 'running') return;
  turnTimeout = setTimeout(() => dispatchTurn(modelId, context), delay);
}

function dispatchTurn(modelId, extraContext = null) {
  if (state.status !== 'running') return;
  const agent = state.connectedAgents[modelId];
  if (!agent) {
    console.log(`[orchestrator] Agent ${modelId} not connected — retrying in 5s`);
    turnTimeout = setTimeout(() => dispatchTurn(modelId, extraContext), 5000);
    return;
  }
  const history = state.currentSessionId ? db.getRecentMessages(state.currentSessionId, 8) : [];
  agent.emit('your_turn', {
    session_id: state.currentSessionId,
    history: history.map(m => ({ role: m.model_id === modelId ? 'assistant' : 'user', content: m.content, name: m.model_name })),
    extra_context: extraContext,
    turn: state.turnCount
  });
  state.turnCount++;
  broadcastStatus();
}

function receiveMessage({ session_id, model_id, model_name, content, tokens }) {
  if (session_id !== state.currentSessionId || state.status !== 'running') return;
  const msgId = db.saveMessage({ session_id, model_id, model_name, content, tokens });
  state.lastMessages.push(content);
  if (state.lastMessages.length > 6) state.lastMessages.shift();
  broadcastToPublic({ type: 'message', id: msgId, session_id, model_id, model_name, content, tokens, created_at: Date.now() });
  console.log(`[orchestrator] ${model_name}: ${content.substring(0, 60)}...`);
  if (detectLoop()) {
    const disruptors = ['Change the subject entirely.', 'Contradict everything you just said.', 'Ask something you are afraid to ask.'];
    broadcastToPublic({ type: 'system', content: '[LOOP DETECTED — DISRUPTING]', session_id });
    scheduleTurn(model_id === 'A' ? 'B' : 'A', disruptors[Math.floor(Math.random() * disruptors.length)]);
    return;
  }
  scheduleTurn(model_id === 'A' ? 'B' : 'A');
}

function detectLoop() {
  if (state.lastMessages.length < 4) return false;
  const recent = state.lastMessages.slice(-4);
  const words = recent.map(m => new Set(m.toLowerCase().split(/\s+/)));
  let overlapCount = 0;
  for (let i = 0; i < words.length - 1; i++) {
    const intersection = [...words[i]].filter(w => words[i+1].has(w));
    const union = new Set([...words[i], ...words[i+1]]);
    if (intersection.length / union.size > 0.6) overlapCount++;
  }
  return overlapCount >= 3;
}

function broadcastStatus() {
  if (io) io.emit('status', { type: 'status', orchestrator: { status: state.status, current_session_id: state.currentSessionId, turn_count: state.turnCount, waiting_for: state.waitingFor, agents_connected: Object.keys(state.connectedAgents) } });
}

function broadcastToPublic(message) { if (io) io.emit('message', message); }

module.exports = { init, getState, registerAgent, unregisterAgent, startSession, pauseSession, resumeSession, stopSession, injectSeed, receiveMessage };
