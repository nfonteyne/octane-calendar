/* ── State ──────────────────────────────────────────────────── */
let state = {
  people:    [],
  slots:     [],   // all slots with all people's availability
  personIds: [],   // IDs of people whose dots are shown
};

/* ── Boot ────────────────────────────────────────────────────── */
async function boot() {
  await loadPeople();
  buildFilters();
  await loadSlots();
  loadLastChecked();
}

/* ── Data loading ────────────────────────────────────────────── */
async function loadPeople() {
  const res = await fetch('/api/people');
  state.people = await res.json();
  state.personIds = state.people.map(p => p.id);
}

async function loadSlots() {
  const res = await fetch('/api/slots?weeks=3');
  state.slots = await res.json();
  renderCalendar();
}

async function loadLastChecked() {
  const res = await fetch('/api/last-checked');
  const { last_checked } = await res.json();
  const el = document.getElementById('last-checked');
  el.textContent = last_checked
    ? 'Last updated: ' + formatDatetime(last_checked)
    : 'No data yet — click Refresh';
}

/* ── Calendar rendering ──────────────────────────────────────── */
function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const selectedSet = new Set(state.personIds);

  const slotMap = new Map();
  for (const slot of state.slots) {
    slotMap.set(slot.slot_date, slot);
  }

  // Grid starts on Monday of the current week so columns align Mon→Sun.
  const start = new Date(today);
  const dow = start.getDay();
  start.setDate(start.getDate() + (dow === 0 ? -6 : 1 - dow));

  // Always show exactly 21 days from today.
  // Pad the grid to a complete number of weeks (7-col alignment).
  const daysBeforeToday = Math.round((today - start) / 86400000); // 0 on Mon, 6 on Sun
  const totalDays = Math.ceil((daysBeforeToday + 21) / 7) * 7;

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);

    const isPastDay   = date < today;
    const isBeyond21  = i >= daysBeforeToday + 21;
    const isToday     = date.getTime() === today.getTime();
    const slot        = slotMap.get(isoDate(date));

    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (isToday ? ' today' : '');

    // Alignment cells after the 21-day window — empty, no label
    if (isBeyond21) {
      cell.classList.add('empty');
      grid.appendChild(cell);
      continue;
    }

    const dateLabel = document.createElement('div');
    dateLabel.className = 'cell-date';
    dateLabel.innerHTML = `<span class="day-num">${date.getDate()}</span>${shortMonth(date)}`;
    cell.appendChild(dateLabel);

    if (isPastDay) {
      cell.classList.add('empty');
      const lbl = document.createElement('div');
      lbl.className = 'no-slot-label';
      lbl.textContent = 'past';
      cell.appendChild(lbl);

    } else if (slot) {
      const visible = slot.people.filter(p => selectedSet.has(p.id));
      const avail   = visible.filter(p => p.is_available);

      cell.classList.add('has-slot');
      if (visible.length > 0) {
        if (avail.length === visible.length) {
          cell.classList.add('all-available');
        } else {
          const unavailRatio = (visible.length - avail.length) / visible.length;
          if      (unavailRatio <= 0.2) cell.classList.add('heat-1');
          else if (unavailRatio <= 0.4) cell.classList.add('heat-2');
          else if (unavailRatio <= 0.6) cell.classList.add('heat-3');
          else if (unavailRatio <= 0.8) cell.classList.add('heat-4');
          else                          cell.classList.add('heat-5');
        }
      }

      const timeEl = document.createElement('div');
      timeEl.className = 'cell-time';
      timeEl.textContent = formatTime(slot.lower) + '–' + formatTime(slot.upper);
      cell.appendChild(timeEl);

      const dotsEl = document.createElement('div');
      dotsEl.className = 'cell-dots';
      for (const person of visible) {
        const dot = document.createElement('div');
        dot.className = 'cell-dot' + (person.is_available ? '' : ' busy');
        dot.style.backgroundColor = person.color;
        dot.title = person.name + (person.is_available ? ' ✓' : ' ✗');
        dotsEl.appendChild(dot);
      }
      cell.appendChild(dotsEl);

      cell.addEventListener('click', () => openModal(date, slot, visible));

      const countEl = document.createElement('div');
      countEl.className = 'cell-count';
      countEl.textContent = avail.length + '/' + visible.length;
      cell.appendChild(countEl);

    } else {
      cell.classList.add('empty');
      const lbl = document.createElement('div');
      lbl.className = 'no-slot-label';
      lbl.textContent = 'no data';
      cell.appendChild(lbl);
    }

    grid.appendChild(cell);
  }
}

/* ── Filter UI ───────────────────────────────────────────────── */
function buildFilters() {
  // Person toggles — toggling re-renders immediately without an API call
  const listEl = document.getElementById('people-list');
  for (const person of state.people) {
    const row = document.createElement('label');
    row.className = 'person-toggle';
    row.dataset.id = person.id;

    const dot = document.createElement('span');
    dot.className = 'person-dot';
    dot.style.backgroundColor = person.color;

    row.appendChild(dot);
    row.appendChild(document.createTextNode(person.name));

    row.addEventListener('click', () => {
      const id = person.id;
      if (state.personIds.includes(id)) {
        if (state.personIds.length === 1) return; // keep at least one
        state.personIds = state.personIds.filter(x => x !== id);
        row.classList.add('excluded');
      } else {
        state.personIds.push(id);
        row.classList.remove('excluded');
      }
      renderCalendar(); // instant, no API call needed
    });

    listEl.appendChild(row);
  }

  buildLegend();

  // Refresh button
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    showToast('Triggering n8n workflow…');
    try {
      const res  = await fetch('/api/refresh', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showToast('Workflow running — waiting for results…');
        pollWorkflowStatus(btn);
      } else {
        showToast('Could not trigger workflow: ' + (data.error || 'unknown'), true);
        btn.disabled = false;
        btn.textContent = 'Refresh availability';
      }
    } catch (e) {
      showToast('Could not reach server: ' + e.message, true);
      btn.disabled = false;
      btn.textContent = 'Refresh availability';
    }
  });
}

function pollWorkflowStatus(btn, maxMs = 180000, intervalMs = 4000) {
  const started = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - started > maxMs) {
      clearInterval(timer);
      showToast('Workflow timed out — no result after 3 min', true);
      btn.disabled = false;
      btn.textContent = 'Refresh availability';
      return;
    }
    try {
      const res  = await fetch('/api/workflow-status');
      const data = await res.json();
      if (data.status === 'success') {
        clearInterval(timer);
        showToast('Calendar updated!');
        btn.disabled = false;
        btn.textContent = 'Refresh availability';
        loadSlots();
        loadLastChecked();
      } else if (data.status === 'error') {
        clearInterval(timer);
        const detail = data.node ? ` (node: ${data.node})` : '';
        showToast('Workflow error: ' + (data.message || 'unknown') + detail, true);
        btn.disabled = false;
        btn.textContent = 'Refresh availability';
      }
    } catch (_) { /* transient, keep polling */ }
  }, intervalMs);
}

/* ── Modal ───────────────────────────────────────────────────── */
function openModal(date, slot, visible) {
  const avail = visible.filter(p => p.is_available);
  const busy  = visible.filter(p => !p.is_available);

  document.getElementById('modal-date').textContent = date.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris'
  });
  document.getElementById('modal-time').textContent =
    formatTime(slot.lower) + ' – ' + formatTime(slot.upper);

  const renderPeople = (list, containerId, isBusy) => {
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    if (list.length === 0) {
      const em = document.createElement('div');
      em.className = 'modal-empty';
      em.textContent = isBusy ? 'None' : 'None';
      el.appendChild(em);
      return;
    }
    for (const person of list) {
      const row = document.createElement('div');
      row.className = 'modal-person' + (isBusy ? ' busy-person' : '');
      const dot = document.createElement('span');
      dot.className = 'person-dot';
      dot.style.backgroundColor = person.color;
      row.appendChild(dot);
      row.appendChild(document.createTextNode(person.name));
      el.appendChild(row);
    }
  };

  renderPeople(avail, 'modal-available', false);
  renderPeople(busy,  'modal-busy',      true);

  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
});

function buildLegend() {
  const el = document.getElementById('legend');
  for (const person of state.people) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.backgroundColor = person.color;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(person.name));
    el.appendChild(item);
  }
  const allItem = document.createElement('div');
  allItem.className = 'legend-item';
  allItem.innerHTML = '<span style="width:14px;height:14px;border-radius:3px;display:inline-block;background:#34a85322;border:1px solid #34a853;"></span> Everyone free';
  el.appendChild(allItem);
}

/* ── Toast ───────────────────────────────────────────────────── */
function showToast(msg, isError = false, duration = 5000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden', 'error');
  if (isError) el.classList.add('error');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), duration);
}

/* ── Utils ───────────────────────────────────────────────────── */
function isoDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function shortMonth(d) {
  return d.toLocaleDateString('fr-FR', { month: 'short' });
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
}

function formatDatetime(iso) {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function isPast(d) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

boot();
