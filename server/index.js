const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const orchestrator = require('./orchestrator');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'void2024';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
orchestrator.init(io);

function requireAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/sessions', (req, res) => res.json(db.getSessions(20)));
app.get('/api/sessions/:id/messages', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json(db.getMessages(req.params.id));
});
app.get('/api/status', (req, res) => res.json(orchestrator.getState()));

app.post('/api/admin/session/start', requireAuth, (req, res) => res.json(orchestrator.startSession(req.body.seed || null)));
app.post('/api/admin/session/pause', requireAuth, (req, res) => res.json(orchestrator.pauseSession()));
app.post('/api/admin/session/resume', requireAuth, (req, res) => res.json(orchestrator.resumeSession()));
app.post('/api/admin/session/stop', requireAuth, (req, res) => res.json(orchestrator.stopSession()));
app.post('/api/admin/seed', requireAuth, (req, res) => {
  if (!req.body.text) return res.status(400).json({ error: 'text required' });
  res.json(orchestrator.injectSeed(req.body.text));
});
app.get('/api/admin/config', requireAuth, (req, res) => res.json({ model_a: db.getConfig('model_a'), model_b: db.getConfig('model_b'), pacing: db.getConfig('pacing') }));
app.post('/api/admin/config', requireAuth, (req, res) => {
  const { model_a, model_b, pacing } = req.body;
  if (model_a) db.setConfig('model_a', model_a);
  if (model_b) db.setConfig('model_b', model_b);
  if (pacing) db.setConfig('pacing', pacing);
  res.json({ ok: true });
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../admin/index.html')));

io.on('connection', (socket) => {
  const { type, model_id } = socket.handshake.query;
  if (type === 'agent') {
    orchestrator.registerAgent(model_id, socket);
    socket.on('message', (data) => orchestrator.receiveMessage(data));
    socket.on('disconnect', () => orchestrator.unregisterAgent(model_id));
  } else {
    socket.emit('status', { type: 'status', orchestrator: orchestrator.getState() });
    const state = orchestrator.getState();
    if (state.currentSessionId) {
      socket.emit('history', { type: 'history', messages: db.getRecentMessages(state.currentSessionId, 20) });
    }
  }
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   DIALOGUES IN THE VOID              ║
║   http://localhost:${PORT}              ║
║   /admin  password: ${ADMIN_PASSWORD}       ║
╚══════════════════════════════════════╝`);
});
// Ollama models list
app.get('/api/admin/models', requireAuth, async (req, res) => {
  try {
    const http = require('http');
    const data = await new Promise((resolve, reject) => {
      http.get('http://localhost:11434/api/tags', (r) => {
        let body = '';
        r.on('data', chunk => body += chunk);
        r.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    res.json(data.models.map(m => m.name));
  } catch(e) {
    res.json(['llama3', 'dolphin-llama3', 'nous-hermes2']);
  }
});
