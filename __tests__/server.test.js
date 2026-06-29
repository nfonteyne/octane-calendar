jest.mock('../database', () => ({
  getPeople: jest.fn(),
  ingestSlots: jest.fn(),
  getSlots: jest.fn(),
  getLastChecked: jest.fn(),
}));

jest.mock('node-fetch', () => jest.fn());

const request = require('supertest');
const fetch = require('node-fetch');
const { app, _resetWorkflowState } = require('../server');
const { getPeople, ingestSlots, getSlots, getLastChecked } = require('../database');

beforeEach(() => {
  _resetWorkflowState();
  jest.resetAllMocks();
  // Keep the background fetch pending so it never resolves mid-test and flips workflow state
  fetch.mockReturnValue(new Promise(() => {}));
});

describe('GET /api/people', () => {
  it('returns people array from database', async () => {
    getPeople.mockReturnValue([{ id: 1, name: 'Nathan', color: '#4285f4' }]);
    const res = await request(app).get('/api/people');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, name: 'Nathan', color: '#4285f4' }]);
  });
});

describe('GET /api/slots', () => {
  beforeEach(() => getSlots.mockReturnValue([]));

  it('uses default params when none provided', async () => {
    const res = await request(app).get('/api/slots');
    expect(res.status).toBe(200);
    expect(getSlots).toHaveBeenCalledWith({ minPeople: 0, personIds: null, weeks: 3 });
  });

  it('parses weeks, min_people and person_ids query params', async () => {
    await request(app).get('/api/slots?weeks=2&min_people=3&person_ids=1,2');
    expect(getSlots).toHaveBeenCalledWith({ minPeople: 3, personIds: [1, 2], weeks: 2 });
  });

  it('caps weeks at 3', async () => {
    await request(app).get('/api/slots?weeks=10');
    expect(getSlots).toHaveBeenCalledWith({ minPeople: 0, personIds: null, weeks: 3 });
  });

  it('ignores invalid person_ids entries', async () => {
    await request(app).get('/api/slots?person_ids=1,abc,2');
    expect(getSlots).toHaveBeenCalledWith({ minPeople: 0, personIds: [1, 2], weeks: 3 });
  });
});

describe('GET /api/last-checked', () => {
  it('returns the last checked timestamp', async () => {
    getLastChecked.mockReturnValue('2026-06-29 10:00:00');
    const res = await request(app).get('/api/last-checked');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ last_checked: '2026-06-29 10:00:00' });
  });

  it('returns null when no data has been ingested', async () => {
    getLastChecked.mockReturnValue(null);
    const res = await request(app).get('/api/last-checked');
    expect(res.body).toEqual({ last_checked: null });
  });
});

describe('GET /api/workflow-status', () => {
  it('returns idle state on startup', async () => {
    const res = await request(app).get('/api/workflow-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'idle', triggeredAt: null, message: null });
  });
});

describe('POST /api/workflow-error', () => {
  it('sets workflow state to error with message and node', async () => {
    const res = await request(app)
      .post('/api/workflow-error')
      .send({ message: 'Something failed', node: 'HTTP Request' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const status = await request(app).get('/api/workflow-status');
    expect(status.body.status).toBe('error');
    expect(status.body.message).toBe('Something failed');
    expect(status.body.node).toBe('HTTP Request');
  });

  it('falls back to default message when body has no message field', async () => {
    await request(app).post('/api/workflow-error').send({});
    const status = await request(app).get('/api/workflow-status');
    expect(status.body.message).toBe('Workflow failed');
  });
});

describe('POST /api/ingest', () => {
  it('accepts slots wrapped in { slots: [...] }', async () => {
    const slots = [{ lower: '2026-07-01T16:30:00Z', upper: '2026-07-01T19:00:00Z', people: [] }];
    const res = await request(app).post('/api/ingest').send({ slots });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 1 });
    expect(ingestSlots).toHaveBeenCalledWith(slots);
  });

  it('accepts a bare slots array as body', async () => {
    const slots = [{ lower: '2026-07-01T16:30:00Z', upper: '2026-07-01T19:00:00Z', people: [] }];
    const res = await request(app).post('/api/ingest').send(slots);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('returns 400 when body is not an array', async () => {
    const res = await request(app).post('/api/ingest').send({ invalid: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Expected array of slots');
  });

  it('returns 500 and sets error state when ingestSlots throws', async () => {
    ingestSlots.mockImplementation(() => { throw new Error('DB locked'); });
    const res = await request(app).post('/api/ingest').send({ slots: [] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB locked');

    const status = await request(app).get('/api/workflow-status');
    expect(status.body.status).toBe('error');
  });
});

describe('POST /api/refresh', () => {
  it('starts the workflow when idle', async () => {
    const res = await request(app).post('/api/refresh');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const status = await request(app).get('/api/workflow-status');
    expect(status.body.status).toBe('running');
    expect(status.body.triggeredAt).not.toBeNull();
  });

  it('returns 409 when a workflow is already running', async () => {
    await request(app).post('/api/refresh');
    const res = await request(app).post('/api/refresh');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'A refresh is already in progress' });
  });
});
