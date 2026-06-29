const Database = require('better-sqlite3');
const fs   = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(dataDir, 'calendar.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT    NOT NULL UNIQUE,
    color TEXT   NOT NULL DEFAULT '#4285f4'
  );

  CREATE TABLE IF NOT EXISTS time_slots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lower       TEXT    NOT NULL,
    upper       TEXT    NOT NULL,
    slot_date   TEXT    NOT NULL,
    day_of_week INTEGER NOT NULL,
    UNIQUE(lower, upper)
  );

  CREATE TABLE IF NOT EXISTS slot_availability (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id      INTEGER NOT NULL REFERENCES time_slots(id)  ON DELETE CASCADE,
    person_id    INTEGER NOT NULL REFERENCES people(id)       ON DELETE CASCADE,
    is_available INTEGER NOT NULL DEFAULT 1,
    checked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(slot_id, person_id)
  );
`);

// Seed people if empty
const { count } = db.prepare('SELECT COUNT(*) as count FROM people').get();
if (count === 0) {
  const ins = db.prepare('INSERT INTO people (name, color) VALUES (?, ?)');
  ins.run('Nathan',  '#4285f4');
  ins.run('Raphaël', '#fbbc05');
  ins.run('Yann',    '#34a853');
  ins.run('Jules',   '#a142f4');
  ins.run('AK',      '#24c1e0');
}

// Nathan & Estelle is Nathan's shared calendar — Estelle is not a band member.
db.prepare("DELETE FROM people WHERE name = 'Estelle'").run();

// ── helpers ──────────────────────────────────────────────────────────────────

function getPeople() {
  return db.prepare('SELECT * FROM people ORDER BY id').all();
}

function upsertPerson(name) {
  const colors = ['#4285f4','#ea4335','#fbbc05','#34a853','#a142f4','#24c1e0','#ff6d00','#795548'];
  const existing = db.prepare('SELECT id FROM people WHERE name = ?').get(name);
  if (existing) return existing.id;
  const allPeople = getPeople();
  const color = colors[allPeople.length % colors.length];
  const result = db.prepare('INSERT INTO people (name, color) VALUES (?, ?)').run(name, color);
  return result.lastInsertRowid;
}

const upsertSlot = db.prepare(`
  INSERT INTO time_slots (lower, upper, slot_date, day_of_week)
  VALUES (@lower, @upper, @slot_date, @day_of_week)
  ON CONFLICT(lower, upper) DO UPDATE SET
    slot_date   = excluded.slot_date,
    day_of_week = excluded.day_of_week
  RETURNING id
`);

const upsertAvail = db.prepare(`
  INSERT INTO slot_availability (slot_id, person_id, is_available, checked_at)
  VALUES (@slot_id, @person_id, @is_available, datetime('now'))
  ON CONFLICT(slot_id, person_id) DO UPDATE SET
    is_available = excluded.is_available,
    checked_at   = excluded.checked_at
`);

// Normalize ISO datetime to minute precision in UTC so the UNIQUE(lower,upper)
// constraint fires correctly across runs (n8n includes milliseconds that differ each time).
function normalizeISO(iso) {
  const d = new Date(iso);
  d.setSeconds(0, 0);
  return d.toISOString(); // always UTC, no milliseconds variance
}

// Slot date in Europe/Paris so "18:30 +02:00" stays on the correct calendar day.
function slotDateParis(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}

function ingestSlots(slots) {
  const ingest = db.transaction((slots) => {
    for (const slot of slots) {
      const lower = normalizeISO(slot.lower);
      const upper = normalizeISO(slot.upper);
      const slotDate = slotDateParis(slot.lower);
      const dow = (() => {
        const d = parseInt(new Date(slot.lower)
          .toLocaleDateString('en-US', { timeZone: 'Europe/Paris', weekday: 'short' })
          .slice(0, 3)
          .replace(/Mon/,'1').replace(/Tue/,'2').replace(/Wed/,'3')
          .replace(/Thu/,'4').replace(/Fri/,'5').replace(/Sat/,'6').replace(/Sun/,'7'));
        return isNaN(d) ? new Date(slot.lower).getDay() || 7 : d;
      })();

      const { id: slotId } = upsertSlot.get({ lower, upper, slot_date: slotDate, day_of_week: dow });

      // people may arrive as a JSON string from n8n's Set node serialisation
      const people = typeof slot.people === 'string' ? JSON.parse(slot.people) : (slot.people || []);

      for (const person of people) {
        if (!person || !person.name) continue;
        const personId = upsertPerson(person.name);
        upsertAvail.run({
          slot_id: slotId,
          person_id: personId,
          is_available: person.available ? 1 : 0
        });
      }
    }
  });
  ingest(slots);
}

function getSlots({ minPeople = 1, personIds = null, weeks = 3 } = {}) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + weeks * 7);

  const endStr = end.toISOString().substring(0, 10);
  const nowStr = now.toISOString().substring(0, 10);

  // Build person filter clause
  let personFilter = '';
  if (personIds && personIds.length > 0) {
    const placeholders = personIds.map(() => '?').join(',');
    personFilter = `AND sa.person_id IN (${placeholders})`;
  }

  const rows = db.prepare(`
    SELECT
      ts.id,
      ts.lower,
      ts.upper,
      ts.slot_date,
      ts.day_of_week,
      SUM(CASE WHEN sa.is_available = 1 THEN 1 ELSE 0 END) AS available_count,
      COUNT(sa.id) AS total_in_filter
    FROM time_slots ts
    JOIN slot_availability sa ON sa.slot_id = ts.id
    WHERE ts.slot_date >= ? AND ts.slot_date <= ?
    ${personFilter}
    GROUP BY ts.id
    HAVING available_count >= ?
    ORDER BY ts.lower
  `).all([nowStr, endStr, ...(personIds || []), minPeople]);

  // Attach per-person detail for each slot
  return rows.map(row => {
    const people = db.prepare(`
      SELECT p.id, p.name, p.color, sa.is_available
      FROM slot_availability sa
      JOIN people p ON p.id = sa.person_id
      WHERE sa.slot_id = ?
      ORDER BY p.id
    `).all(row.id);

    return { ...row, people };
  });
}

function getLastChecked() {
  const row = db.prepare('SELECT MAX(checked_at) as ts FROM slot_availability').get();
  return row ? row.ts : null;
}

module.exports = { getPeople, ingestSlots, getSlots, getLastChecked };
