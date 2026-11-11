/* Capture: offline voice/text capture for the rabbit r1 that syncs tasks, events
   and notes into an Obsidian vault folder through a private GitHub repo. */
(() => {
'use strict';

const VERSION = '1.4.1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const IS_R1 = typeof window.PluginMessageHandler !== 'undefined';

/* ---------- storage (r1 creationStorage, localStorage fallback) ---------- */
const b64e = (str) => btoa(unescape(encodeURIComponent(str)));
const b64d = (b64) => decodeURIComponent(escape(atob(b64)));

// Saves go to the r1's own storage. Secure storage is tried first for keys, but it is not
// available on every r1 build, so every value is also kept in plain r1 storage and in the
// browser's storage. Reads take the first copy found, so a value survives app restarts and updates.
const store = {
  async get(key, secure = false) {
    const cs = window.creationStorage;
    if (cs) {
      if (secure) { try { const r = await cs.secure.getItem(key); if (r != null) return b64d(r); } catch (e) {} }
      try { const r = await cs.plain.getItem(secure ? 'sec_' + key : key); if (r != null) return b64d(r); } catch (e) {}
    }
    try { return localStorage.getItem('cap_' + key); } catch (e) { return null; }
  },
  async set(key, value, secure = false) {
    const cs = window.creationStorage;
    if (cs) {
      if (secure) { try { await cs.secure.setItem(key, b64e(value)); } catch (e) {} }
      try { await cs.plain.setItem(secure ? 'sec_' + key : key, b64e(value)); } catch (e) {}
    }
    try { localStorage.setItem('cap_' + key, value); } catch (e) {}
  },
  async del(key, secure = false) {
    const cs = window.creationStorage;
    if (cs) {
      if (secure) { try { await cs.secure.removeItem(key); } catch (e) {} }
      try { await cs.plain.removeItem(secure ? 'sec_' + key : key); } catch (e) {}
    }
    try { localStorage.removeItem('cap_' + key); } catch (e) {}
  }
};

/* ---------- state ---------- */
let items = [];          // newest first
let cfg = { owner: '', repo: '', branch: 'main', folder: '', gh: '', groq: '', auto: true,
  habits: ['Workout', 'Eat well', 'Work done'], oneThing: true };
let days = {};           // 'YYYY-MM-DD' -> { habits: {name: true}, one: {id, done: true|false|null}, dirty }
let skills = [];         // { id, name, baseHours, goals: [{ id, text, due, doneAt }], created, dirty }
let sessions = [];       // { id, skillId, at, minutes, source }
let timer = null;        // { skillId, start }
let skSel = 0;
let skillId = null;
let formMode = '';
let formChoice = null;
let filter = 'all';
let sel = 0;
let detailId = null;
let typeKind = 'auto';
let typeMode = 'entry';  // 'entry' | 'one'
let recForOne = false;
let focusIdx = -1;       // scroll-wheel focus on the Today screen
let busy = false;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function loadState() {
  try { items = JSON.parse(await store.get('items') || '[]'); } catch { items = []; }
  try { days = JSON.parse(await store.get('days') || '{}'); } catch { days = {}; }
  try { skills = JSON.parse(await store.get('skills') || '[]'); } catch { skills = []; }
  try { sessions = JSON.parse(await store.get('sessions') || '[]'); } catch { sessions = []; }
  try { timer = JSON.parse(await store.get('timer') || 'null'); } catch { timer = null; }
  try { Object.assign(cfg, JSON.parse(await store.get('cfg') || '{}')); } catch {}
  cfg.gh = (await store.get('gh', true)) || cfg.gh || '';
  cfg.groq = (await store.get('groq', true)) || cfg.groq || '';
  // anything stuck mid-processing after a restart goes back in the queue
  items.forEach((it) => { if (it.status === 'processing') it.status = it.kind ? 'ready' : 'recorded'; });
}
const saveItems = () => store.set('items', JSON.stringify(items));
const saveDays = () => {
  // keep about two months of day records on the device; the vault keeps everything
  const keys = Object.keys(days).sort();
  keys.slice(0, Math.max(0, keys.length - 60)).forEach((k) => delete days[k]);
  return store.set('days', JSON.stringify(days));
};
const saveSkills = () => Promise.all([store.set('skills', JSON.stringify(skills)), store.set('sessions', JSON.stringify(sessions)), store.set('timer', JSON.stringify(timer))]);
const todayKey = () => isoDate(new Date());
function day(key = todayKey()) {
  if (!days[key]) days[key] = { habits: {}, one: null, dirty: false };
  return days[key];
}
const markDay = (key = todayKey()) => { day(key).dirty = true; };
async function saveCfg() {
  const { gh, groq, ...plain } = cfg;
  await store.set('cfg', JSON.stringify(plain));
  await store.set('gh', gh, true);
  await store.set('groq', groq, true);
}

/* ---------- dates (display MM-DD-YYYY, store YYYY-MM-DD) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mdy = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${m}-${d}-${y}`; };
const clock = (hhmm) => {
  if (!hhmm) return '';
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${pad(m || 0)} ${ap}`;
};
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/* ---------- offline fallback parser ---------- */
function heuristicParse(text, base = new Date()) {
  let t = text.trim();
  const low = t.toLowerCase();
  let kind = 'note';
  const lead = low.match(/^(task|to ?do|event|note|reminder|remind me)\b[\s,:.-]*/);
  if (lead) {
    const w = lead[1];
    kind = w === 'event' ? 'event' : w === 'note' ? 'note' : 'task';
    t = t.slice(lead[0].length);
  } else if (/\b(meeting|appointment|appt|dentist|doctor|call with|lunch with|dinner with|party|inspection at)\b/.test(low)) {
    kind = 'event';
  } else if (/\b(need to|have to|got to|gotta|don't forget|remember to|make sure|buy|pick up|call|email|send|order|schedule|follow up)\b/.test(low)) {
    kind = 'task';
  }

  let date = '';
  const d = new Date(base);
  if (/\btoday|tonight\b/.test(low)) date = isoDate(d);
  else if (/\btomorrow\b/.test(low)) { d.setDate(d.getDate() + 1); date = isoDate(d); }
  else {
    const wd = DAYS.findIndex((n) => new RegExp('\\b' + n + '\\b').test(low));
    if (wd >= 0) {
      let diff = (wd - d.getDay() + 7) % 7; if (diff === 0) diff = 7;
      if (/\bnext\b/.test(low) && diff < 7) diff += 7;
      d.setDate(d.getDate() + diff); date = isoDate(d);
    }
    const md = low.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
    if (md) {
      let y = md[3] ? Number(md[3]) : base.getFullYear(); if (y < 100) y += 2000;
      const cand = new Date(y, Number(md[1]) - 1, Number(md[2]));
      if (!md[3] && cand < new Date(base.getFullYear(), base.getMonth(), base.getDate())) cand.setFullYear(y + 1);
      if (!isNaN(cand)) date = isoDate(cand);
    }
    const mn = low.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (mn) {
      const cand = new Date(base.getFullYear(), MONTHS.indexOf(mn[1]), Number(mn[2]));
      if (cand < new Date(base.getFullYear(), base.getMonth(), base.getDate())) cand.setFullYear(base.getFullYear() + 1);
      date = isoDate(cand);
    }
  }
  let time = '';
  const tm = low.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/) || low.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (tm) {
    let h = Number(tm[1]); const m = Number(tm[2] || 0);
    const ap = (tm[3] || '').replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 6) h += 12; // "at 3" almost always means afternoon
    if (h < 24 && m < 60) time = `${pad(h)}:${pad(m)}`;
  }
  if (kind === 'note' && date && time) kind = 'event';
  let title = t;
  if (date || time) {
    title = title
      .replace(/\b(?:on\s+)?(?:next\s+)?(?:today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, '')
      .replace(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/gi, '')
      .replace(/\bat\s+\d{1,2}(?::\d{2})?\b/gi, '');
  }
  title = title.replace(/\s+/g, ' ').replace(/[\s,.;:-]+$/, '').trim() || t.trim();
  return { kind, title: title.charAt(0).toUpperCase() + title.slice(1), date, time };
}

/* ---------- r1 built-in LLM (one request at a time) ---------- */
let llmWaiter = null;
window.onPluginMessage = (data) => {
  if (!llmWaiter) return;
  const w = llmWaiter; llmWaiter = null; clearTimeout(w.timer);
  w.resolve(data);
};
function askR1(prompt, ms = 25000) {
  return new Promise((resolve, reject) => {
    if (!IS_R1) return reject(new Error('not on r1'));
    if (llmWaiter) return reject(new Error('llm busy'));
    const timer = setTimeout(() => { llmWaiter = null; reject(new Error('llm timeout')); }, ms);
    llmWaiter = { resolve, timer };
    window.PluginMessageHandler.postMessage(JSON.stringify({ message: prompt, useLLM: true, wantsR1Response: false, wantsJournalEntry: false }));
  });
}
function extractJSON(data) {
  const cands = [];
  if (data && typeof data === 'object') { if (data.data) cands.push(data.data); if (data.message) cands.push(data.message); }
  else cands.push(String(data));
  for (const c of cands) {
    if (typeof c === 'object') return c;
    const m = String(c).match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
  }
  return null;
}
async function classify(text, createdISO) {
  const base = new Date(createdISO);
  const fallback = heuristicParse(text, base);
  const forced = /^(task|to ?do|event|note|reminder|remind me)\b/i.test(text.trim()) ? fallback.kind : null;
  if (!IS_R1) return fallback;
  const today = `${DAYS[base.getDay()]} ${isoDate(base)}`;
  const prompt =
    `You sort quick voice memos into a task, an event, or a note. The memo was recorded on ${today} at ${pad(base.getHours())}:${pad(base.getMinutes())}.\n` +
    `task = something to do. event = something happening at a date/time. note = anything else.\n` +
    `Resolve relative dates ("tomorrow", "Friday") against the recording date. Leave date/time empty if not stated.\n` +
    `title = the memo cleaned up into a short line, keeping names, numbers and addresses exact. Drop words like "task" or "remind me".\n` +
    `Respond ONLY with JSON: {"kind":"task|event|note","title":"...","date":"YYYY-MM-DD or empty","time":"HH:MM 24h or empty"}\n` +
    `Memo: """${text}"""`;
  try {
    const j = extractJSON(await askR1(prompt));
    if (!j || !['task', 'event', 'note'].includes(j.kind)) return fallback;
    return {
      kind: forced || j.kind,
      title: String(j.title || fallback.title).trim() || fallback.title,
      date: /^\d{4}-\d{2}-\d{2}$/.test(j.date || '') ? j.date : '',
      time: /^\d{2}:\d{2}$/.test(j.time || '') ? j.time : ''
    };
  } catch { return fallback; }
}

/* ---------- transcription (Groq Whisper, OpenAI-compatible) ---------- */
function b64ToBlob(b64, type) {
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}
async function transcribe(it) {
  if (!cfg.groq) throw new Error('Add a Groq key in Settings to turn voice into text');
  const b64 = await store.get('audio_' + it.id);
  if (!b64) throw new Error('Audio is missing');
  const blob = b64ToBlob(b64, it.mime || 'audio/webm');
  const ext = (it.mime || '').includes('mp4') ? 'm4a' : (it.mime || '').includes('ogg') ? 'ogg' : 'webm';
  const fd = new FormData();
  fd.append('file', blob, `memo.${ext}`);
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('language', 'en');
  fd.append('response_format', 'json');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + cfg.groq }, body: fd
  });
  if (!r.ok) throw httpErr('Transcription', r.status, await r.text());
  return ((await r.json()).text || '').trim();
}
function httpErr(what, status, body) {
  const e = new Error(`${what} failed (${status})${status === 401 ? ': check the key in Settings' : ''}`);
  e.status = status; e.body = body; e.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return e;
}
const isNetErr = (e) => e instanceof TypeError || /network|fetch|load failed/i.test(e.message);

/* ---------- GitHub sync ---------- */
const ghBase = () => `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/`;
const ghHeaders = () => ({ Authorization: 'Bearer ' + cfg.gh, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
const encPath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const fileFor = (it) => {
  const name = mdy(isoDate(new Date(it.created))) + '.md';   // local date, not UTC
  const folder = (cfg.folder || '').replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/${name}` : name;
};

async function ghGet(path) {
  const r = await fetch(ghBase() + encPath(path) + `?ref=${encodeURIComponent(cfg.branch || 'main')}&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) return { text: null, sha: null };
  if (!r.ok) throw httpErr('GitHub read', r.status, await r.text());
  const j = await r.json();
  return { text: b64d(j.content.replace(/\n/g, '')), sha: j.sha };
}
async function ghPut(path, text, sha, message) {
  const body = { message, content: b64e(text), branch: cfg.branch || 'main' };
  if (sha) body.sha = sha;
  const r = await fetch(ghBase() + encPath(path), { method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw httpErr('GitHub write', r.status, await r.text());
}

const SECTIONS = { task: '## Tasks', event: '## Events', note: '## Notes' };
function lineFor(it) {
  const tag = ` ^r1-${it.id}`;
  const capT = new Date(it.created);
  const capClock = clock(`${pad(capT.getHours())}:${pad(capT.getMinutes())}`);
  // Formats match the vault: Tasks plugin (global filter #task, emoji dates) and the
  // Dataview calendar (list items with [date:: YYYY-MM-DD] and optional [time:: ...]).
  if (it.kind === 'task') {
    const at = it.time ? ` at ${clock(it.time)}` : '';
    const due = it.date ? ` 📅 ${it.date}` : '';
    const doneOn = it.done && it.doneAt ? ` ✅ ${isoDate(new Date(it.doneAt))}` : '';
    return `- [${it.done ? 'x' : ' '}] #task ${it.title}${at}${due}${doneOn}${tag}`;
  }
  if (it.kind === 'event') {
    if (!it.date) return `- ${it.title} (no date given)${tag}`;
    return `- ${it.title} [date:: ${it.date}]${it.time ? ` [time:: ${clock(it.time)}]` : ''}${tag}`;
  }
  return `- ${capClock} ${it.text || it.title}${tag}`;
}
function newFile(dateISO) {
  return `---\nsource: r1\ndate: ${mdy(dateISO)}\n---\n\n## Day\n\n## Tasks\n\n## Events\n\n## Notes\n`;
}
function insertLine(text, it) {
  const tagRe = new RegExp(`^.*\\^r1-${it.id}[ \\t]*$`, 'm');
  if (tagRe.test(text)) return text.replace(tagRe, lineFor(it)); // already there: keep it current (e.g. checked off)
  const heading = SECTIONS[it.kind];
  const lines = text.replace(/\s+$/, '').split('\n');
  let h = lines.findIndex((l) => l.trim() === heading);
  if (h < 0) { lines.push('', heading); h = lines.length - 1; }
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  let at = end;
  while (at > h + 1 && lines[at - 1].trim() === '') at--;   // after the last entry, before blank lines
  lines.splice(at, 0, lineFor(it));
  return lines.join('\n') + '\n';
}
/* ----- the "## Day" wrap-up section, rewritten each time the day changes ----- */
const habitKey = (h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const itemsOn = (key) => items.filter((i) => i.created && i.kind !== 'log' && isoDate(new Date(i.created)) === key);
function nextEventAfter(key) {
  const now = new Date(); const nowKey = isoDate(now); const nowT = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return items.filter((i) => i.kind === 'event' && i.date && (i.date > key || (i.date === key && key === nowKey && (i.time || '99') >= nowT)))
    .sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')))[0] || null;
}
function daySummary(key) {
  const d = day(key); const its = itemsOn(key);
  const lines = [];
  if (d.one) {
    const it = items.find((i) => i.id === d.one.id);
    const what = it ? (it.title || it.text || 'Voice memo') : 'Set by voice';
    const st = d.one.done === true ? 'done' : d.one.done === false ? 'not today' : 'open';
    lines.push(`- One thing: ${what} (${st})`);
  }
  const hs = (cfg.habits || []).filter(Boolean);
  if (hs.length) {
    const yes = hs.filter((h) => d.habits[h]); const no = hs.filter((h) => !d.habits[h]);
    lines.push(`- Habits: ${yes.length ? 'did ' + yes.join(', ') : 'none logged'}${no.length && yes.length ? '; skipped ' + no.join(', ') : ''}`);
  }
  const n = (k) => its.filter((i) => i.kind === k).length;
  if (its.length) {
    const doneT = items.filter((i) => i.kind === 'task' && i.doneAt && isoDate(new Date(i.doneAt)) === key).length;
    const pl = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
    lines.push(`- Captured ${its.length}: ${pl(n('task'), 'task')}, ${pl(n('event'), 'event')}, ${pl(n('note'), 'note')}${doneT ? `; ${pl(doneT, 'task')} done` : ''}`);
  }
  const skMin = {};
  sessions.filter((x) => isoDate(new Date(x.at)) === key).forEach((x) => { skMin[x.skillId] = (skMin[x.skillId] || 0) + x.minutes; });
  const skParts = Object.entries(skMin).map(([id, m]) => { const sk = skillById(id); return sk ? `[[${skillPath(sk).replace(/\.md$/, '').split('/').pop()}|${sk.name}]] ${fmtMin(m)} (Lv ${levelOf(skillHours(sk))})` : null; }).filter(Boolean);
  if (skParts.length) lines.push(`- Skills: ${skParts.join(', ')}`);
  const nx = nextEventAfter(key);
  if (nx) lines.push(`- Next up: ${[mdy(nx.date), clock(nx.time)].filter(Boolean).join(' ')} ${nx.title}`);
  return lines.length ? lines.join('\n') : '- Nothing logged';
}
function setFrontmatter(text, fields) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  let fm = m ? m[1].split('\n') : [];
  for (const [k, v] of Object.entries(fields)) {
    const idx = fm.findIndex((l) => l.startsWith(k + ':'));
    if (v === undefined) { if (idx >= 0) fm.splice(idx, 1); continue; }
    const line = `${k}: ${v}`;
    if (idx >= 0) fm[idx] = line; else fm.push(line);
  }
  const block = `---\n${fm.join('\n')}\n---\n`;
  return m ? block + text.slice(m[0].length) : block + '\n' + text;
}
function upsertDay(text, key) {
  const d = day(key);
  const fields = {};
  (cfg.habits || []).filter(Boolean).forEach((h) => { fields[habitKey(h)] = !!d.habits[h]; });
  fields.one_thing_done = d.one && d.one.done !== null && d.one.done !== undefined ? d.one.done : undefined;
  let out = setFrontmatter(text, fields);
  const lines = out.replace(/\s+$/, '').split('\n');
  let h = lines.findIndex((l) => l.trim() === '## Day');
  if (h < 0) {
    let fmEnd = 0;
    if (lines[0] === '---') { fmEnd = lines.indexOf('---', 1) + 1; }
    lines.splice(fmEnd, 0, '', '## Day'); h = fmEnd + 1;
  }
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  lines.splice(h + 1, end - (h + 1), ...daySummary(key).split('\n'), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
const pathForDate = (key) => {
  const folder = (cfg.folder || '').replace(/^\/+|\/+$/g, '');
  return (folder ? folder + '/' : '') + mdy(key) + '.md';
};
async function syncDays() {
  for (const key of Object.keys(days).filter((k) => days[k].dirty).sort()) {
    const path = pathForDate(key);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { text, sha } = await ghGet(path);
        const out = upsertDay(text == null ? newFile(key) : text, key);
        if (out !== text) await ghPut(path, out, sha, `r1: day summary ${mdy(key)}`);
        days[key].dirty = false;
        break;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
        throw e;
      }
    }
    await saveDays();
  }
}

async function syncItems(list) {
  const groups = {};
  list.forEach((it) => { (groups[fileFor(it)] = groups[fileFor(it)] || []).push(it); });
  for (const [path, group] of Object.entries(groups)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { text, sha } = await ghGet(path);
        let out = text == null ? newFile(isoDate(new Date(group[0].created))) : text;
        group.forEach((it) => { out = insertLine(out, it); });
        if (out !== text) await ghPut(path, out, sha, `r1: add ${group.length} item${group.length > 1 ? 's' : ''}`);
        const now = new Date().toISOString();
        group.forEach((it) => { it.status = 'synced'; it.syncedAt = now; it.error = ''; markDay(isoDate(new Date(it.created))); });
        break;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue; // file changed under us; re-read
        throw e;
      }
    }
    await saveItems(); render();
  }
}

/* ---------- pipeline ---------- */
async function runPipeline(manual = false) {
  if (busy) return;
  busy = true; setNet();
  try {
    // 1. voice -> text -> task/event/note
    for (const it of items.filter((i) => i.status === 'recorded' || (i.status === 'error' && !i.kind && manual))) {
      it.status = 'processing'; it.error = ''; render();
      try {
        if (!it.text) {
          it.text = await transcribe(it);
          if (!it.text) { it.text = '(nothing heard)'; }
        }
        const lg = !it.forceKind && !it.oneThing ? parseLog(it.text) : null;
        if (lg) {
          const sk = skillById(lg.skillId);
          Object.assign(it, { kind: 'log', title: `Logged ${fmtMin(lg.minutes)} to ${sk.name}`, status: 'synced', syncedAt: new Date().toISOString() });
          await store.del('audio_' + it.id); await saveItems();
          await addSession(lg.skillId, lg.minutes, 'voice', it.created);
          continue;
        }
        const p = it.forceKind ? { ...heuristicParse(it.text, new Date(it.created)), kind: it.forceKind } : await classify(it.text, it.created);
        if (it.forceKind && IS_R1 && it.forceKind !== 'note') {
          const c = await classify(it.text, it.created); p.title = c.title; p.date = c.date; p.time = c.time;
        }
        Object.assign(it, p);
        if (it.kind === 'note') {
          const clean = it.text.replace(/^note\b[\s,:.-]*/i, '');
          it.text = clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : it.text;
          it.title = it.text;
        }
        it.status = 'ready';
        await store.del('audio_' + it.id);
      } catch (e) {
        if (isNetErr(e)) { it.status = 'recorded'; it.error = 'Waiting for a connection'; await saveItems(); render(); break; }
        it.status = e.permanent || /Groq key/.test(e.message) ? 'error' : 'recorded';
        it.error = e.message;
      }
      await saveItems(); render();
    }
    // 2. ready -> vault
    if (cfg.auto || manual) {
      const ready = items.filter((i) => i.status === 'ready' || (manual && i.status === 'error' && i.kind));
      if (ready.length) await sendToVault(ready);
    }
    // 3. day wrap-up section (habits, one thing, counts) -> vault
    if (cfg.gh && cfg.owner && cfg.repo && Object.values(days).some((d) => d.dirty)) {
      try { await syncDays(); } catch (e) { if (!isNetErr(e)) toast(e.message); }
    }
    // 4. skill notes -> vault
    if (cfg.gh && cfg.owner && cfg.repo && skills.some((x) => x.dirty)) {
      try { await syncSkills(); } catch (e) { if (!isNetErr(e)) toast(e.message); }
    }
  } finally { busy = false; setNet(); render(); }
}
async function sendToVault(list) {
  if (!cfg.gh || !cfg.owner || !cfg.repo) { toast('Add GitHub details in Settings to send'); return false; }
  try { await syncItems(list); toast(`Sent to vault`); return true; }
  catch (e) {
    if (isNetErr(e)) { toast('No connection. Will send later.'); return false; }
    list.forEach((it) => { if (it.status !== 'synced') { it.status = e.permanent ? 'error' : 'ready'; it.error = e.message; } });
    await saveItems(); render(); toast(e.message); return false;
  }
}

/* ---------- recording ---------- */
let rec = null, recChunks = [], recStart = 0, recTimer = null, recStream = null;
function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return (window.MediaRecorder && opts.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m))) || '';
}
async function startRec() {
  if (rec || !(currentViewIs('list') || currentViewIs('today') || currentViewIs('week') || (currentViewIs('type') && typeMode === 'one'))) return;
  recForOne = currentViewIs('type') && typeMode === 'one';
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) { toast('Microphone not available: ' + (e.message || e.name)); return; }
  const mime = pickMime();
  rec = new MediaRecorder(recStream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined);
  recChunks = [];
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
  rec.onstop = finishRec;
  rec.start(250);
  recStart = Date.now();
  $('#rec').classList.add('on');
  $('#rec-time').textContent = '0:00';
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $('#rec-time').textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
    if (s >= 300) stopRec();
  }, 250);
}
function stopRec() { if (rec && rec.state !== 'inactive') rec.stop(); }
async function finishRec() {
  clearInterval(recTimer);
  $('#rec').classList.remove('on');
  const mime = (rec && rec.mimeType) || 'audio/webm';
  recStream && recStream.getTracks().forEach((t) => t.stop());
  rec = null; recStream = null;
  if (Date.now() - recStart < 700) { toast('Too short. Hold the button while you talk.'); return; }
  const blob = new Blob(recChunks, { type: mime });
  const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  const it = { id: newId(), created: new Date().toISOString(), status: 'recorded', mime, text: '', kind: '', title: '', date: '', time: '' };
  if (recForOne) { it.forceKind = 'task'; it.kind = 'task'; it.title = "Today's one thing"; }
  await store.set('audio_' + it.id, b64);
  items.unshift(it); filter = 'all'; sel = 0;
  if (recForOne) { setOneThing(it); recForOne = false; show('today'); }
  await saveItems(); render();
  toast(navigator.onLine ? 'Saved. Processing…' : 'Saved offline');
  runPipeline();
}

/* ---------- daily loop ---------- */
function setOneThing(it) {
  const d = day(); d.one = { id: it.id, done: null }; it.oneThing = todayKey();
  markDay(); saveDays();
}
function oneThingItem(key = todayKey()) {
  const d = days[key]; if (!d || !d.one) return null;
  return items.find((i) => i.id === d.one.id) || null;
}
async function answerOne(done) {
  const d = day(); if (!d.one) return;
  d.one.done = done;
  const it = oneThingItem();
  if (it) setDone(it, done, false);
  markDay(); await saveDays(); await saveItems(); renderToday(); runPipeline();
}
function setDone(it, done, save = true) {
  it.done = !!done; it.doneAt = done ? new Date().toISOString() : null;
  if (it.status === 'synced') it.status = 'ready';   // push the checkbox change to the vault
  markDay(isoDate(new Date(it.created)));
  if (it.oneThing && days[it.oneThing] && days[it.oneThing].one && days[it.oneThing].one.id === it.id) {
    days[it.oneThing].one.done = done ? true : null;
  }
  if (save) { saveItems(); saveDays(); }
}
async function toggleHabit(name) {
  const d = day(); d.habits[name] = !d.habits[name];
  if (!d.habits[name]) delete d.habits[name];
  markDay(); await saveDays(); renderToday();
  clearTimeout(toggleHabit.t); toggleHabit.t = setTimeout(() => runPipeline(), 4000); // batch quick taps
}
const isEvening = () => new Date().getHours() >= 17;
const openTasks = () => items.filter((i) => i.kind === 'task' && !i.done);

function renderToday() {
  const now = new Date(); const key = todayKey(); const d = day(key);
  $('#td-date').textContent = `${now.toLocaleDateString([], { weekday: 'short' })} ${mdy(key).slice(0, 5)}`;
  // top card: agenda in the day, wrap-up in the evening
  const top = $('#td-top'); const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tasksN = openTasks().length;
  if (isEvening()) {
    const its = itemsOn(key);
    const doneT = items.filter((i) => i.doneAt && isoDate(new Date(i.doneAt)) === key).length;
    const nx = nextEventAfter(key);
    top.innerHTML = `<div class="ln"><b>Wrap-up</b> · ${its.length} captured${doneT ? `, ${doneT} done` : ''}</div>` +
      `<div class="ln ${nx ? '' : 'muted'}">${nx ? 'Next: ' + esc([nx.date === key ? '' : mdy(nx.date).slice(0, 5), clock(nx.time)].filter(Boolean).join(' ') + ' ' + nx.title) : 'Nothing scheduled next'}</div>`;
  } else {
    const evs = items.filter((i) => i.kind === 'event' && i.date === key).sort((a, b) => (a.time || '99').localeCompare(b.time || '99')).slice(0, 2);
    top.innerHTML = (evs.length ? evs.map((e) => `<div class="ln">${esc(clock(e.time) || 'Today')} ${esc(e.title)}</div>`).join('') : '<div class="ln muted">No events today</div>') +
      `<div class="ln muted">${tasksN} open task${tasksN === 1 ? '' : 's'}</div>`;
  }
  if (timer && skillById(timer.skillId)) {
    const tl = document.createElement('div'); tl.className = 'ln'; tl.innerHTML = '<b>●</b> ';
    tl.appendChild(document.createTextNode(`${skillById(timer.skillId).name} · ${fmtMin(timerMinutes())}`));
    top.prepend(tl); if (top.children.length > 3) top.lastChild.remove();
  }
  // one thing
  const one = $('#td-one'); one.className = 'card one focusable';
  if (!cfg.oneThing) { one.style.display = 'none'; }
  else {
    one.style.display = '';
    const it = oneThingItem(key);
    if (!d.one) {
      one.classList.add('empty-one');
      one.innerHTML = isEvening() ? 'No one thing today' : "Tap to set today's one thing";
    } else {
      const txt = it ? (it.status === 'recorded' || it.status === 'processing' ? 'Voice memo (converting)' : it.title) : '…';
      if (d.one.done === true) one.classList.add('done-one');
      const ask = isEvening() && d.one.done == null;
      one.innerHTML = `<div class="lbl">One thing${d.one.done === true ? ' · done' : d.one.done === false ? ' · not today' : ''}</div><div class="txt"></div>` +
        (ask ? '<div class="yn"><button class="yes" data-one="yes">Done</button><button data-one="no">Not today</button></div>' : '');
      one.querySelector('.txt').textContent = txt;
    }
  }
  // habits
  const hb = $('#td-habits'); hb.innerHTML = '';
  (cfg.habits || []).filter(Boolean).slice(0, 4).forEach((h) => {
    const b = document.createElement('button'); b.className = 'focusable' + (d.habits[h] ? ' on' : '');
    b.textContent = (d.habits[h] ? '✓ ' : '') + h; b.onclick = () => toggleHabit(h);
    hb.appendChild(b);
  });
  applyFocus();
}
const focusables = () => $$('#view-today .focusable').filter((el) => el.offsetParent !== null);
function applyFocus() {
  const f = focusables(); f.forEach((el, i) => el.classList.toggle('focus', i === focusIdx));
}
function activateFocused() {
  const el = focusables()[focusIdx]; if (el) el.click();
}

/* ---------- skills ---------- */
// Level n needs n² total hours: level 1 at 1 h, 10 at 100 h, 30 at 900 h, 100 (mastery) at 10,000 h.
const MAX_LEVEL = 100;
const levelOf = (h) => Math.min(MAX_LEVEL, Math.floor(Math.sqrt(Math.max(0, h) + 1e-9)));
const skillHours = (s) => (s.baseHours || 0) + sessions.filter((x) => x.skillId === s.id).reduce((n, x) => n + x.minutes, 0) / 60;
const fmtH = (h) => h < 1 ? `${Math.round(h * 60)} min` : `${(Math.round(h * 10) / 10).toLocaleString()} h`;
const fmtMin = (m) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
function levelInfo(s) {
  const h = skillHours(s); const lv = levelOf(h);
  if (lv >= MAX_LEVEL) return { h, lv, pct: 100, toNext: 0 };
  const lo = lv * lv, hi = (lv + 1) * (lv + 1);
  return { h, lv, pct: Math.max(0, Math.min(100, ((h - lo) / (hi - lo)) * 100)), toNext: hi - h };
}
const skillById = (id) => skills.find((s) => s.id === id);

async function addSession(sid, minutes, source, atISO = new Date().toISOString()) {
  const s = skillById(sid); if (!s || minutes < 1) return;
  const before = levelOf(skillHours(s));
  sessions.push({ id: newId(), skillId: sid, at: atISO, minutes: Math.round(minutes), source });
  s.dirty = true; markDay(isoDate(new Date(atISO)));
  await saveSkills(); await saveDays();
  const after = levelOf(skillHours(s));
  if (after > before) celebrate(s, before, after); else toast(`${fmtMin(Math.round(minutes))} logged to ${s.name}`);
  render();
  clearTimeout(addSession.t); addSession.t = setTimeout(() => runPipeline(), 3000);
}
const timerMinutes = () => timer ? Math.floor((Date.now() - timer.start) / 60000) : 0;
async function startTimer(sid) {
  if (timer && timer.skillId === sid) return stopTimer();
  if (timer) await stopTimer();
  timer = { skillId: sid, start: Date.now() }; await saveSkills();
  toast(`Timer started: ${skillById(sid).name}`); render();
}
async function stopTimer() {
  if (!timer) return;
  const t = timer; timer = null; await saveSkills();
  let m = Math.floor((Date.now() - t.start) / 60000);
  if (m < 1) { toast('Under a minute, not logged'); render(); return; }
  if (m > 600) { m = 600; toast('Capped at 10 hours'); }
  await addSession(t.skillId, m, 'timer', new Date(t.start).toISOString());
}

/* level-up moment: big number, a burst, and a short chiptune */
function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ac = chime.ac || (chime.ac = new AC()); if (ac.state === 'suspended') ac.resume();
    const t0 = ac.currentTime + 0.02;
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'square'; o.frequency.value = f;
      const t = t0 + i * 0.09, len = i === 4 ? 0.45 : 0.12;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + len + 0.02);
    });
  } catch {}
}
let lvT = null;
function celebrate(s, from, to) {
  const el = $('#lvup'); const burst = $('#lv-burst'); burst.innerHTML = '';
  const colors = ['#ff5a1f', '#ffb347', '#ffd166', '#6fcf97', '#56ccf2', '#ffffff'];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3, r = 80 + Math.random() * 50;
    const p = document.createElement('i');
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', `${Math.cos(a) * r}px`); p.style.setProperty('--dy', `${Math.sin(a) * r}px`);
    p.style.animationDelay = `${0.1 + Math.random() * 0.15}s`;
    burst.appendChild(p);
  }
  $('#lv-skill').textContent = s.name;
  $('#lv-sub').textContent = to >= MAX_LEVEL ? 'Mastered. 10,000 hours.' : (to - from > 1 ? `+${to - from} levels · ` : '') + `${fmtH(((to + 1) ** 2) - skillHours(s))} to level ${to + 1}`;
  const num = $('#lv-num'); num.textContent = String(to);
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  chime();
  clearTimeout(lvT); lvT = setTimeout(() => el.classList.remove('on'), 3800);
}
const lvupShowing = () => $('#lvup').classList.contains('on');
const closeLvup = () => { clearTimeout(lvT); $('#lvup').classList.remove('on'); };

function renderSkills() {
  const ul = $('#sk-list'); ul.innerHTML = '';
  if (skSel >= skills.length) skSel = Math.max(0, skills.length - 1);
  skills.forEach((s, i) => {
    const li = document.createElement('li'); if (i === skSel) li.className = 'sel';
    const L = levelInfo(s); const running = timer && timer.skillId === s.id;
    li.innerHTML = `<div class="sk-top"><span class="sk-name"></span><span class="sk-lv">Lv ${L.lv}</span></div>` +
      `<div class="bar-track"><div class="bar-fill" style="width:${L.pct}%"></div></div>` +
      `<div class="sk-sub"><span class="${running ? 'run' : ''}">${running ? '● ' + fmtMin(timerMinutes()) + ' running' : fmtH(L.h)}</span><span>${L.lv >= MAX_LEVEL ? 'Mastered' : fmtH(L.toNext) + ' to ' + (L.lv + 1)}</span></div>`;
    li.querySelector('.sk-name').textContent = s.name;
    li.onclick = () => { skSel = i; openSkill(s.id); };
    ul.appendChild(li);
  });
  $('#sk-empty').style.display = skills.length ? 'none' : 'block';
  ul.style.display = skills.length ? 'block' : 'none';
  const sel = ul.querySelector('.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function openSkill(id) { skillId = id; renderSkill(); show('skill'); }
function renderSkill() {
  const s = skillById(skillId); if (!s) { show('skills'); renderSkills(); return; }
  const L = levelInfo(s); const running = timer && timer.skillId === s.id;
  $('#sd-name').textContent = s.name;
  $('#sd-lv').textContent = `Lv ${L.lv}`;
  $('#sd-hours').textContent = `${fmtH(L.h)} total`;
  $('#sd-bar').style.width = L.pct + '%';
  $('#sd-next').textContent = L.lv >= MAX_LEVEL ? 'Mastered' : `${fmtH(L.toNext)} to level ${L.lv + 1}`;
  const tb = $('#sd-timer'); tb.classList.toggle('running', !!running);
  tb.textContent = running ? `Stop · ${fmtMin(timerMinutes())}` : 'Start timer';
  const ul = $('#sd-goals'); ul.innerHTML = '';
  if (!s.goals.length) { const li = document.createElement('li'); li.innerHTML = '<span class="gt" style="color:#777">No goals yet. Add one with a clear finish line.</span>'; ul.appendChild(li); }
  s.goals.forEach((g) => {
    const li = document.createElement('li'); if (g.doneAt) li.className = 'done';
    li.innerHTML = `<span class="ck">${g.doneAt ? '🏆' : '☐'}</span><span class="gt"></span>`;
    const gt = li.querySelector('.gt'); gt.textContent = g.text;
    const sub = document.createElement('span'); sub.className = 'gd';
    sub.textContent = g.doneAt ? `Finished ${mdy(isoDate(new Date(g.doneAt)))}` : g.due ? `By ${mdy(g.due)}` : 'No deadline';
    gt.appendChild(sub);
    li.onclick = () => toggleGoal(s, g);
    ul.appendChild(li);
  });
}
async function toggleGoal(s, g) {
  g.doneAt = g.doneAt ? null : new Date().toISOString();
  s.dirty = true; markDay(); await saveSkills(); await saveDays(); renderSkill();
  if (g.doneAt) { toast('🏆 Goal finished'); chime(); }
  clearTimeout(addSession.t); addSession.t = setTimeout(() => runPipeline(), 3000);
}

/* new skill / new goal form */
const PAST_HOURS = [0, 10, 50, 100, 500, 1000, 2500, 5000];
const DUE_CHOICES = [['None', 0], ['1 month', 1], ['3 months', 3], ['6 months', 6], ['1 year', 12]];
function openForm(mode) {
  formMode = mode; formChoice = mode === 'skill' ? 0 : 0;
  $('#f-text').value = '';
  const ex = $('#f-extra'); ex.innerHTML = '';
  const chips = document.createElement('div'); chips.className = 'chips';
  if (mode === 'skill') {
    $('#f-title').textContent = 'New skill'; $('#f-lbl1').textContent = 'Name (drawing, guitar, pest control…)';
    const l = document.createElement('label'); l.className = 'f-lbl'; l.textContent = 'Hours already put in (rough is fine)'; ex.appendChild(l);
    PAST_HOURS.forEach((h) => { const b = document.createElement('button'); b.textContent = h.toLocaleString(); b.dataset.v = h; chips.appendChild(b); });
  } else {
    $('#f-title').textContent = 'New goal'; $('#f-lbl1').textContent = 'A clear finish line (done or not done)';
    const l = document.createElement('label'); l.className = 'f-lbl'; l.textContent = 'Deadline'; ex.appendChild(l);
    DUE_CHOICES.forEach(([t, v]) => { const b = document.createElement('button'); b.textContent = t; b.dataset.v = v; chips.appendChild(b); });
  }
  ex.appendChild(chips);
  const mark = () => chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === formChoice));
  chips.querySelectorAll('button').forEach((b) => b.onclick = () => { formChoice = Number(b.dataset.v); mark(); });
  mark(); show('form'); setTimeout(() => $('#f-text').focus(), 50);
}
async function saveForm() {
  const text = $('#f-text').value.trim(); if (!text) { toast('Type a name first'); return; }
  if (formMode === 'skill') {
    if (skills.some((s) => s.name.toLowerCase() === text.toLowerCase())) { toast('You already have that skill'); return; }
    const s = { id: newId(), name: text, baseHours: formChoice || 0, goals: [], created: new Date().toISOString(), dirty: true };
    skills.push(s); skSel = skills.length - 1; await saveSkills();
    show('skills'); render();
    if (s.baseHours) toast(`${s.name} starts at level ${levelOf(s.baseHours)}`);
  } else {
    const s = skillById(skillId); if (!s) return;
    let due = '';
    if (formChoice) { const d = new Date(); d.setMonth(d.getMonth() + formChoice); due = isoDate(d); }
    s.goals.push({ id: newId(), text, due, doneAt: null }); s.dirty = true; await saveSkills();
    show('skill'); renderSkill();
  }
  runPipeline();
}

/* voice logging: "drew for an hour", "45 minutes of guitar" */
function parseDuration(text) {
  const t = text.toLowerCase();
  let m = 0;
  const hm = t.match(/(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|half an?)\s*(?:and a half\s*)?(hours?|hrs?|h\b)/);
  const mm = t.match(/(\d+)\s*(minutes?|mins?|m\b)/);
  const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, 'half a': 0.5, 'half an': 0.5 };
  if (hm) { let v = isNaN(Number(hm[1])) ? words[hm[1]] : Number(hm[1]); if (/and a half/.test(hm[0]) || /(hours?|hrs?)\s+and a half/.test(t)) v += 0.5; m += v * 60; }
  if (mm) m += Number(mm[1]);
  return Math.round(m);
}
function matchSkill(text) {
  const t = text.toLowerCase();
  let best = null, score = 0;
  for (const s of skills) {
    const n = s.name.toLowerCase();
    let sc = t.includes(n) ? 10 : 0;
    const stem = n.replace(/(ing|s)$/, '');
    if (!sc && stem.length >= 3 && t.includes(stem)) sc = 6;          // "drew"/"draw" vs "drawing" handled below
    if (!sc && /^draw/.test(n) && /\bdrew\b/.test(t)) sc = 6;
    if (sc > score) { score = sc; best = s; }
  }
  return best;
}
function parseLog(text) {
  if (!skills.length) return null;
  const minutes = parseDuration(text); if (!minutes) return null;
  const s = matchSkill(text); if (!s) return null;
  if (!/\b(for|of|on|spent|practiced|worked|did|logged|drew|played|studied)\b/i.test(text)) return null;
  return { skillId: s.id, minutes };
}

function skillFile(s) {
  const L = levelInfo(s);
  const lines = ['---', 'type: skill', `level: ${L.lv}`, `hours: ${Math.round(L.h * 10) / 10}`, `updated: ${mdy(todayKey())}`, '---', '',
    `# ${s.name}`, '', `Level ${L.lv} · ${fmtH(L.h)}${L.lv >= MAX_LEVEL ? ' · Mastered' : ` · ${fmtH(L.toNext)} to level ${L.lv + 1}`}`, '',
    '%% This file is rewritten by Capture on the r1. Edit goals on the device. %%', '', '## Goals'];
  if (!s.goals.length) lines.push('- No goals yet');
  s.goals.forEach((g) => lines.push(`- [${g.doneAt ? 'x' : ' '}] ${g.text}${g.doneAt ? ` (finished ${mdy(isoDate(new Date(g.doneAt)))})` : g.due ? ` (by ${mdy(g.due)})` : ''}`));
  lines.push('', '## Log', '', '| Date | Time |', '| --- | --- |');
  const byDay = {};
  sessions.filter((x) => x.skillId === s.id).forEach((x) => { const k = isoDate(new Date(x.at)); byDay[k] = (byDay[k] || 0) + x.minutes; });
  const keys = Object.keys(byDay).sort().reverse();
  keys.forEach((k) => lines.push(`| ${mdy(k)} | ${fmtMin(byDay[k])} |`));
  if (s.baseHours) lines.push(`| Before tracking | ${fmtH(s.baseHours)} |`);
  return lines.join('\n') + '\n';
}
const skillPath = (s) => {
  const folder = (cfg.folder || '').replace(/^\/+|\/+$/g, '');
  const name = s.name.replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Skill';
  return (folder ? folder + '/' : '') + `Skills/${name}.md`;
};
async function syncSkills() {
  for (const s of skills.filter((x) => x.dirty)) {
    const path = skillPath(s);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { text, sha } = await ghGet(path);
        const out = skillFile(s);
        if (out !== text) await ghPut(path, out, sha, `r1: ${s.name} level ${levelOf(skillHours(s))}`);
        s.dirty = false; break;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
        throw e;
      }
    }
    await saveSkills();
  }
}

function renderWeek() {
  const body = $('#wk-body'); body.innerHTML = '';
  const keys = []; for (let i = 6; i >= 0; i--) { const t = new Date(); t.setDate(t.getDate() - i); keys.push(isoDate(t)); }
  const row = (label, hits, of) => {
    const r = document.createElement('div');
    r.innerHTML = `<div class="wk-row"><span></span><span>${hits.filter(Boolean).length} of ${of}</span></div><div class="wk-dots">${hits.map((h) => `<i class="${h ? 'on' : ''}"></i>`).join('')}</div>`;
    r.querySelector('span').textContent = label; body.appendChild(r);
  };
  (cfg.habits || []).filter(Boolean).slice(0, 4).forEach((h) => row(h, keys.map((k) => !!(days[k] && days[k].habits[h])), 7));
  if (cfg.oneThing) {
    const set = keys.filter((k) => days[k] && days[k].one);
    row('One thing done', keys.map((k) => !!(days[k] && days[k].one && days[k].one.done === true)), set.length || 0);
  }
  const since = new Date(keys[0] + 'T00:00:00');
  skills.forEach((s) => {
    const m = sessions.filter((x) => x.skillId === s.id && new Date(x.at) >= since).reduce((n, x) => n + x.minutes, 0);
    if (!m) return;
    const r = document.createElement('div'); r.className = 'wk-row'; r.innerHTML = '<span></span><span></span>';
    r.firstChild.textContent = s.name; r.lastChild.textContent = fmtMin(m); body.appendChild(r);
  });
  const cap = keys.reduce((n, k) => n + itemsOn(k).length, 0);
  const r = document.createElement('div'); r.className = 'wk-row'; r.innerHTML = '<span>Captured</span><span></span>';
  r.lastChild.textContent = String(cap); body.appendChild(r);
}

/* ---------- UI ---------- */
const ICON = { task: '☐', event: '◷', note: '✎', log: '⏱' };
const STATUS_TXT = { recorded: 'Waiting for connection', processing: 'Working…', ready: 'Ready to send', synced: 'In vault', error: 'Needs attention' };
const visible = () => items.filter((i) => filter === 'all' || i.kind === filter);

function render() {
  const list = $('#list'); const v = visible();
  if (sel >= v.length) sel = Math.max(0, v.length - 1);
  list.innerHTML = '';
  v.forEach((it, i) => {
    const li = document.createElement('li');
    if (i === sel) li.className = 'sel';
    if (it.done) li.classList.add('done');
    const sub = it.kind === 'note' || !it.kind
      ? (() => { const c = new Date(it.created); return `${mdy(isoDate(c))} ${clock(`${pad(c.getHours())}:${pad(c.getMinutes())}`)}`; })()
      : [mdy(it.date), clock(it.time)].filter(Boolean).join(' ') || (it.kind === 'task' ? 'No due date' : 'No date');
    const title = it.title || it.text || (it.status === 'recorded' ? 'Voice memo' : '…');
    li.innerHTML = `<span class="ic">${it.kind ? ICON[it.kind] : '🎙'}</span><span class="main"><div class="t"></div><div class="s"></div></span><span class="dot st-${it.status}"></span>`;
    li.querySelector('.t').textContent = title;
    li.querySelector('.s').textContent = it.error && it.status !== 'synced' ? it.error : sub;
    li.onclick = () => { sel = i; openDetail(it.id); };
    list.appendChild(li);
  });
  $('#empty').style.display = v.length ? 'none' : 'block';
  list.style.display = v.length ? 'block' : 'none';
  const waiting = items.filter((i) => i.status === 'recorded').length;
  const ready = items.filter((i) => i.status === 'ready').length;
  const err = items.filter((i) => i.status === 'error').length;
  $('#summary').textContent = [waiting && `${waiting} waiting`, ready && `${ready} ready`, err && `${err} error`].filter(Boolean).join(' · ') || 'All sent';
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  const s = list.querySelector('.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
  if (detailId && currentViewIs('detail')) fillDetail();
  if (currentViewIs('today')) renderToday();
  if (currentViewIs('week')) renderWeek();
  if (currentViewIs('skills')) renderSkills();
  if (currentViewIs('skill')) renderSkill();
  const inb = $('#btn-inbox'); if (inb) inb.textContent = waiting + ready + err ? `Inbox · ${waiting + ready + err}` : 'Inbox';
}
function setNet() {
  const n = $('#net'); n.classList.toggle('on', navigator.onLine);
  $('#btn-sync').style.opacity = busy ? .4 : 1;
}
function show(name) { $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name)); }
const currentViewIs = (name) => $('#view-' + name).classList.contains('active');

function openDetail(id) { detailId = id; fillDetail(); show('detail'); }
function fillDetail() {
  const it = items.find((i) => i.id === detailId); if (!it) { show('list'); return; }
  $('#d-status').textContent = STATUS_TXT[it.status] || '';
  $$('#d-kinds button').forEach((b) => b.classList.toggle('on', b.dataset.k === it.kind));
  $('#d-title').textContent = it.title || (it.status === 'recorded' ? 'Voice memo (not transcribed yet)' : '');
  $('#d-when').textContent = it.kind === 'note' ? '' : [mdy(it.date), clock(it.time)].filter(Boolean).join(' ');
  $('#d-text').textContent = it.text && it.text !== it.title ? `"${it.text}"` : '';
  $('#d-err').textContent = it.status === 'synced' ? '' : (it.error || '');
  const send = $('#d-send');
  send.textContent = it.status === 'synced' ? 'Sent ✓' : it.status === 'error' ? 'Retry' : 'Send';
  send.disabled = it.status === 'synced' || it.status === 'processing';
  send.style.opacity = send.disabled ? .4 : 1;
  const dn = $('#d-done');
  dn.style.display = it.kind === 'task' ? '' : 'none';
  dn.textContent = it.done ? 'Undo done' : 'Done';
}

let toastT = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
}

function goBack() {
  if (lvupShowing()) { closeLvup(); return; }
  if (currentViewIs('skill')) { show('skills'); render(); return; }
  if (currentViewIs('form')) { show(formMode === 'goal' ? 'skill' : 'skills'); render(); return; }
  const toList = currentViewIs('detail') || (currentViewIs('type') && typeMode === 'entry');
  show(toList ? 'list' : 'today');
  detailId = null; typeMode = 'entry'; stopScan(); focusIdx = -1; render();
}
function openType(mode) {
  typeMode = mode; typeKind = 'auto'; $('#t-text').value = '';
  const one = mode === 'one';
  $('#t-title').textContent = one ? "Today's one thing" : 'New entry';
  $('#t-hint').textContent = one ? 'Hold the side button and say it, or type it.' : '';
  $('#t-kinds').style.display = one ? 'none' : '';
  $$('#t-kinds button').forEach((x) => x.classList.toggle('on', x.dataset.k === 'auto'));
  show('type');
  if (!one) setTimeout(() => $('#t-text').focus(), 50);
}

/* ---------- settings + QR setup ---------- */
function fillSettings() {
  $('#s-owner').value = cfg.owner; $('#s-repo').value = cfg.repo; $('#s-branch').value = cfg.branch || 'main';
  $('#s-folder').value = cfg.folder || ''; $('#s-gh').value = cfg.gh; $('#s-groq').value = cfg.groq; $('#s-auto').checked = !!cfg.auto;
  $('#s-habits').value = (cfg.habits || []).join(', '); $('#s-one').checked = !!cfg.oneThing;
  $('#s-msg').textContent = `v${VERSION}${IS_R1 ? '' : ' · preview mode (not on r1)'}`;
}
function readSettings() {
  cfg.owner = $('#s-owner').value.trim(); cfg.repo = $('#s-repo').value.trim(); cfg.branch = $('#s-branch').value.trim() || 'main';
  cfg.folder = $('#s-folder').value.trim(); cfg.gh = $('#s-gh').value.trim(); cfg.groq = $('#s-groq').value.trim(); cfg.auto = $('#s-auto').checked;
  cfg.habits = $('#s-habits').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4);
  cfg.oneThing = $('#s-one').checked;
}
function applySetupPayload(raw) {
  let j; try { j = JSON.parse(raw); } catch { return false; }
  if (!j || j.app !== 'r1-capture') return false;
  ['owner', 'repo', 'branch', 'folder', 'gh', 'groq'].forEach((k) => { if (typeof j[k] === 'string') cfg[k] = j[k]; });
  if (typeof j.auto === 'boolean') cfg.auto = j.auto;
  return true;
}
/* setup code: the setup page encrypts the settings into setup.json (published next to the app);
   the short code typed here is the key. Nothing secret travels in the clear. */
function unb64(s) { const b = atob(s); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
async function loadSetupCode() {
  const msg = $('#s-msg');
  const code = $('#s-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 10) { msg.textContent = 'The code is 10 letters and numbers, like ABCDE-23456.'; return; }
  msg.textContent = 'Loading…';
  try {
    const r = await fetch('setup.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) { msg.textContent = r.status === 404 ? 'setup.json is not uploaded yet (or not live). Wait a minute and try again.' : `Could not load setup (${r.status})`; return; }
    const j = await r.json();
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(j.salt), iterations: j.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    let plain;
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv) }, key, unb64(j.data)); }
    catch { msg.textContent = 'That code does not match. Check it and try again.'; return; }
    if (!applySetupPayload(new TextDecoder().decode(plain))) { msg.textContent = 'Setup file is not valid.'; return; }
    await saveCfg(); fillSettings(); $('#s-code').value = '';
    msg.textContent = 'Setup loaded and saved. Testing…';
    await testConnection();
    runPipeline();
  } catch (e) { msg.textContent = isNetErr(e) ? 'No connection. Connect to Wi-Fi and try again.' : 'Setup failed: ' + e.message; }
}
let scanStream = null, scanLoop = null;
async function startScan() {
  if (!('BarcodeDetector' in window)) { $('#s-msg').textContent = 'QR scanning is not supported here. Type the values instead.'; return; }
  try {
    const det = new window.BarcodeDetector({ formats: ['qr_code'] });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('#s-video'); v.srcObject = scanStream; v.style.display = 'block'; await v.play();
    $('#s-msg').textContent = 'Point the camera at the setup QR…';
    scanLoop = setInterval(async () => {
      try {
        const codes = await det.detect(v);
        if (codes.length && applySetupPayload(codes[0].rawValue)) {
          stopScan(); await saveCfg(); fillSettings(); $('#s-msg').textContent = 'Setup loaded and saved.';
          runPipeline();
        }
      } catch {}
    }, 400);
  } catch (e) { $('#s-msg').textContent = 'Camera error: ' + (e.message || e.name); }
}
function stopScan() {
  clearInterval(scanLoop); scanLoop = null;
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null; const v = $('#s-video'); if (v) v.style.display = 'none';
}
async function testConnection() {
  readSettings(); const out = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`, { headers: ghHeaders() });
    out.push(r.ok ? 'GitHub: OK' : `GitHub: failed (${r.status})`);
  } catch (e) { out.push('GitHub: no connection'); }
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + cfg.groq } });
    out.push(r.ok ? 'Groq: OK' : `Groq: failed (${r.status})`);
  } catch (e) { out.push('Groq: no connection'); }
  $('#s-msg').textContent = out.join(' · ');
}

/* ---------- input wiring ---------- */
function moveSel(d) {
  if (lvupShowing()) return;
  if (currentViewIs('skills')) { if (!skills.length) return; skSel = Math.min(skills.length - 1, Math.max(0, skSel + d)); renderSkills(); return; }
  if (currentViewIs('today')) { const n = focusables().length; if (!n) return; focusIdx = focusIdx < 0 ? (d > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, focusIdx + d)); applyFocus(); }
  else if (currentViewIs('list')) { const n = visible().length; if (!n) return; sel = Math.min(n - 1, Math.max(0, sel + d)); render(); }
  else { const body = document.querySelector('.view.active .detail-body, .view.active .settings-body, .view.active .type-body'); if (body) body.scrollTop += d * 40; }
}
function sideClick() {
  if (lvupShowing()) { closeLvup(); return; }
  if (currentViewIs('skills')) { const sk = skills[skSel]; if (sk) startTimer(sk.id); return; }
  if (currentViewIs('skill')) { if (skillId) startTimer(skillId); return; }
  if (currentViewIs('today')) { if (focusIdx >= 0) activateFocused(); }
  else if (currentViewIs('list')) { const it = visible()[sel]; if (it) openDetail(it.id); }
  else if (!currentViewIs('type')) goBack();
}

function wire() {
  // r1 hardware
  window.addEventListener('scrollUp', () => moveSel(-1));
  window.addEventListener('scrollDown', () => moveSel(1));
  window.addEventListener('sideClick', sideClick);
  window.addEventListener('longPressStart', startRec);
  window.addEventListener('longPressEnd', stopRec);
  // keyboard stand-ins for testing on a computer: arrows, Enter, hold Space
  let spaceDown = false;
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
    else if (e.key === 'Enter') { e.preventDefault(); sideClick(); }
    else if (e.code === 'Space' && !spaceDown) { e.preventDefault(); spaceDown = true; startRec(); }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceDown) { spaceDown = false; stopRec(); } });

  $$('[data-back]').forEach((b) => b.onclick = goBack);
  $$('#tabs button').forEach((b) => b.onclick = () => { filter = b.dataset.f; sel = 0; render(); });
  $('#btn-settings').onclick = () => { fillSettings(); show('settings'); };
  $('#btn-sync').onclick = () => { toast('Syncing…'); runPipeline(true); };
  $('#btn-type').onclick = () => openType('entry');
  $('#btn-inbox').onclick = () => { focusIdx = -1; show('list'); render(); };
  $('#btn-week').onclick = () => { focusIdx = -1; show('week'); renderWeek(); };
  $('#btn-skills').onclick = () => { focusIdx = -1; show('skills'); renderSkills(); };
  $('#btn-addskill').onclick = () => openForm('skill');
  $('#sd-addgoal').onclick = () => openForm('goal');
  $('#f-save').onclick = saveForm;
  $('#f-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveForm(); } });
  $('#sd-timer').onclick = () => skillId && startTimer(skillId);
  $$('.quick button').forEach((b) => b.onclick = () => skillId && addSession(skillId, Number(b.dataset.min), 'manual'));
  $('#lvup').onclick = closeLvup;
  $('#sd-delete').onclick = async () => {
    const btn = $('#sd-delete'); const s = skillById(skillId); if (!s) return;
    if (btn.dataset.confirm !== s.id) { btn.dataset.confirm = s.id; btn.textContent = 'Tap again to delete'; setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Delete skill'; }, 2500); return; }
    btn.dataset.confirm = ''; btn.textContent = 'Delete skill';
    if (timer && timer.skillId === s.id) timer = null;
    skills = skills.filter((x) => x.id !== s.id); sessions = sessions.filter((x) => x.skillId !== s.id);
    await saveSkills(); toast('Skill removed from r1 (its vault note stays)'); show('skills'); render();
  };
  $('#td-one').onclick = (e) => {
    const yn = e.target.closest('[data-one]');
    if (yn) { e.stopPropagation(); answerOne(yn.dataset.one === 'yes'); return; }
    const d = day();
    if (!d.one) { if (!isEvening()) openType('one'); return; }
    if (isEvening() && d.one.done == null) { answerOne(true); return; } // wheel + click on the card = done
    const it = oneThingItem(); if (it) { show('list'); openDetail(it.id); }
  };
  $$('#t-kinds button').forEach((b) => b.onclick = () => { typeKind = b.dataset.k; $$('#t-kinds button').forEach((x) => x.classList.toggle('on', x === b)); });
  $('#t-save').onclick = async () => {
    const text = $('#t-text').value.trim(); if (!text) return goBack();
    const it = { id: newId(), created: new Date().toISOString(), status: 'recorded', text, kind: '', title: '', date: '', time: '' };
    if (typeMode === 'one') {
      Object.assign(it, heuristicParse(text), { kind: 'task', forceKind: 'task' });
      items.unshift(it); setOneThing(it); await saveItems(); goBack(); runPipeline(); return;
    }
    if (typeKind !== 'auto') it.forceKind = typeKind;
    // typed entries get sorted right away so they are useful offline; the AI refines them later
    const p = heuristicParse(text); Object.assign(it, p, typeKind !== 'auto' ? { kind: typeKind } : {});
    if (it.kind === 'note') it.title = text;
    items.unshift(it); filter = 'all'; sel = 0; await saveItems(); goBack(); runPipeline();
  };
  $$('#d-kinds button').forEach((b) => b.onclick = async () => {
    const it = items.find((i) => i.id === detailId); if (!it || it.status === 'synced') { if (it && it.status === 'synced') toast('Already in the vault'); return; }
    it.kind = b.dataset.k; it.forceKind = b.dataset.k; if (it.kind === 'note') it.title = it.text || it.title;
    await saveItems(); fillDetail();
  });
  $('#d-send').onclick = async () => {
    const it = items.find((i) => i.id === detailId); if (!it) return;
    if (!it.kind || it.status === 'recorded' || (it.status === 'error' && !it.kind)) { toast('Converting first…'); await runPipeline(true); return; }
    await sendToVault([it]); fillDetail();
  };
  $('#d-done').onclick = async () => {
    const it = items.find((i) => i.id === detailId); if (!it || it.kind !== 'task') return;
    setDone(it, !it.done); await saveItems(); await saveDays(); fillDetail(); render(); runPipeline();
  };
  $('#d-delete').onclick = async () => {
    const it = items.find((i) => i.id === detailId); if (!it) return;
    const btn = $('#d-delete');
    if (btn.dataset.confirm !== it.id) { btn.dataset.confirm = it.id; btn.textContent = 'Sure?'; setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Delete'; }, 2500); return; }
    btn.dataset.confirm = ''; btn.textContent = 'Delete';
    items = items.filter((i) => i.id !== it.id); await store.del('audio_' + it.id); await saveItems();
    toast(it.status === 'synced' ? 'Removed from r1 (still in vault)' : 'Deleted'); goBack();
  };
  $('#s-save').onclick = async () => { readSettings(); await saveCfg(); $('#s-msg').textContent = 'Saved.'; runPipeline(); };
  $('#s-test').onclick = testConnection;
  $('#s-scan').onclick = () => (scanStream ? stopScan() : startScan());
  if (IS_R1) $('#s-scan').style.display = 'none'; // live camera crashes creations on the r1; use the setup code
  $('#s-loadcode').onclick = loadSetupCode;

  window.addEventListener('online', () => { setNet(); runPipeline(); });
  window.addEventListener('offline', setNet);
  setInterval(() => { if (navigator.onLine) runPipeline(); }, 45000);
}

/* ---------- boot ---------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await loadState();
  wire(); setNet(); show('today'); render();
  if (!cfg.gh || !cfg.groq) toast('Open ⚙ to finish setup');
  runPipeline();
  // roll the Today screen over at midnight and switch to the evening view at 5 PM without a reload
  let lastKey = todayKey(), lastEve = isEvening();
  setInterval(() => { if (timer || todayKey() !== lastKey || isEvening() !== lastEve) { lastKey = todayKey(); lastEve = isEvening(); render(); } }, timer ? 20000 : 60000);
  setInterval(() => { if (timer) render(); }, 20000);
}
window.__capture = { heuristicParse, insertLine, lineFor, newFile, upsertDay, parseLog, levelOf, get skills() { return skills; }, get sessions() { return sessions; }, get items() { return items; }, get days() { return days; } }; // for testing
boot();
})();
