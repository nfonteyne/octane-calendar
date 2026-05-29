require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const { getPeople, ingestSlots, getSlots, getLastChecked } = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const N8N_WEBHOOK_URL  = process.env.N8N_WEBHOOK_URL;
const N8N_WEBHOOK_USER = process.env.N8N_WEBHOOK_USER;
const N8N_WEBHOOK_PASS = process.env.N8N_WEBHOOK_PASS;

function webhookHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (N8N_WEBHOOK_USER && N8N_WEBHOOK_PASS) {
    const token = Buffer.from(`${N8N_WEBHOOK_USER}:${N8N_WEBHOOK_PASS}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }
  return headers;
}

// In-memory workflow state — survives individual requests, reset on server restart.
let workflowState = { status: 'idle', triggeredAt: null, message: null };

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/people', (req, res) => {
  res.json(getPeople());
});

app.get('/api/slots', (req, res) => {
  const minPeople = req.query.min_people !== undefined ? parseInt(req.query.min_people) : 0;
  const weeks     = Math.min(parseInt(req.query.weeks) || 3, 3);
  const personIds = req.query.person_ids
    ? req.query.person_ids.split(',').map(Number).filter(Boolean)
    : null;

  const slots = getSlots({ minPeople, personIds, weeks });
  res.json(slots);
});

app.get('/api/last-checked', (req, res) => {
  res.json({ last_checked: getLastChecked() });
});

app.get('/api/workflow-status', (req, res) => {
  res.json(workflowState);
});

// Called by the n8n error workflow when any node fails.
app.post('/api/workflow-error', (req, res) => {
  const message = req.body.message || req.body.error || 'Workflow failed';
  const node    = req.body.node || null;
  console.error('n8n workflow error:', message, node ? `(node: ${node})` : '');
  workflowState = { status: 'error', triggeredAt: workflowState.triggeredAt, message, node };
  res.json({ ok: true });
});

// Called by the n8n workflow — receives per-person availability data.
app.post('/api/ingest', (req, res) => {
  const slots = req.body.slots || req.body;
  if (!Array.isArray(slots)) {
    return res.status(400).json({ error: 'Expected array of slots' });
  }
  try {
    ingestSlots(slots);
    workflowState = { status: 'success', triggeredAt: workflowState.triggeredAt, message: null };
    res.json({ ok: true, count: slots.length });
  } catch (err) {
    console.error('Ingest error:', err);
    workflowState = { status: 'error', triggeredAt: workflowState.triggeredAt, message: err.message };
    res.status(500).json({ error: err.message });
  }
});

// Triggers the n8n workflow. Returns immediately; ingests the response in the background.
app.post('/api/refresh', (req, res) => {
  if (workflowState.status === 'running') {
    return res.status(409).json({ ok: false, error: 'A refresh is already in progress' });
  }

  workflowState = { status: 'running', triggeredAt: new Date().toISOString(), message: null };
  res.json({ ok: true });

  // Fire-and-forget: wait for n8n to finish and return the slots in the response body.
  (async () => {
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5-min safety net
    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'GET',
        headers: webhookHeaders(),
        signal: controller.signal
      });
      clearTimeout(watchdog);

      if (!response.ok) {
        const text = await response.text();
        workflowState = { status: 'error', triggeredAt: workflowState.triggeredAt, message: `n8n returned ${response.status}: ${text}` };
        return;
      }

      const data = await response.json();
      if (!Array.isArray(data.slots)) {
        workflowState = { status: 'error', triggeredAt: workflowState.triggeredAt, message: 'Unexpected response format from n8n' };
        return;
      }

      ingestSlots(data.slots);
      workflowState = { status: 'success', triggeredAt: workflowState.triggeredAt, message: null };
    } catch (err) {
      clearTimeout(watchdog);
      const msg = err.name === 'AbortError'
        ? 'n8n did not respond within 5 minutes'
        : err.message;
      console.error('n8n background fetch error:', msg);
      workflowState = { status: 'error', triggeredAt: workflowState.triggeredAt, message: msg };
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Calendar app running on http://localhost:${PORT}`));
