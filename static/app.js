/* brain viewer — a readable layered network of an agent that is thinking right now */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hhmmss = ts => ts ? new Date(ts * 1000).toLocaleTimeString('en-GB') : '';

const C = {
  mint: '#7fe0c4',   // schema gate: contract check
  fire: '#ff8a5c',   // guard gate: interception
  gold: '#e8a13a', blue: '#3f6cff', green: '#3ddc97', red: '#ff5f6b',
  teal: '#2dd4bf', violet: '#8b7cf6',
  ink: '#e8ecf4', dim: '#8a93a6', faint: '#2a3348', cap: '#77839c' };   // 5.3:1 on the flat background: the caption is the only stage marker

/* edge colour = purpose of that boundary, so the flow reads at a glance */
const PHASES = [
  { color: C.teal,   name: 'trigger' },  // skill    → memory    a playbook was picked
  { color: C.gold,   name: 'recall' },   // memory   → reasoning the brain remembers before it thinks
  { color: '#22d3ee', name: 'reason' }, // reasoning→ gates     it settles on an intent (matches the cyan column)
  { color: C.fire,   name: 'gate' },     // gates    → action    the checks passed
  { color: C.green,  name: 'deliver' },  // action   → output    what leaves the brain
];/* column geometry: seven equal columns — same gap, same node size, so nothing implies
   that one stage matters more than another. */
const XF = [0.070, 0.2925, 0.515, 0.7375, 0.930];   // fallback only; layout uses the rail
const XF_M = [0.12, 0.373, 0.626, 0.88];
const RNODE = [12, 12, 12, 12];
const COL_ACCENT = [C.gold, '#22d3ee', null, C.green];   // reasoning reads cyan (Khanh 23/10)
/* column identity (nodes carry it, edges carry the boundary purpose) */
/* hue → hex, so a placeholder accent can still feed every rgba() call site */
function hslHex(h, s = 95, l = 62) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = v => Math.round(255 * v).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}
const rgba = (hex, a) => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
};

/* tool nodes keep a permanent colour per task type — so "what kind of work" reads instantly */
/* output nodes are three different outcomes, not one colour: what came back to you, what
   changed on disk, and what the brain learned are not the same news */
const NODE_ACCENT = {
  'out:reply':    'rainbow',   // the answer itself: every colour at once (Khanh 23/10)
  'th:6':         '#ff4d5e',   // write: the node that hands the draft to reply, red with its wire
  'out:artifact': '#38bdf8',   // sky: something on disk moved
  'out:learning': '#c084fc',   // lilac: a note or skill was written
  'in:memory':    '#ffe066',   // the always-loaded memo file, brighter than the storage tiers
  'th:2':         '#f472b6',   // recall: the fan-in that reaches for memory (Khanh 23/10)
  'th:5':         '#a3e635',   // result: the fan-in that reads what a tool returned
};

/* the action column is the busiest place on the graph, so its eight tools sweep the hue
   wheel instead of sitting in two blues: one glance tells you which kind of work is running */
const TOOL_COLOR = {
  'tool:terminal': '#ff4d5e',  // red      shell / system
  'tool:code':     '#ffa62b',  // orange   python sandbox
  'tool:read':     '#ffd93d',  // yellow   file + code reading
  'tool:web':      '#7dd3fc',  // pale sky the internet: search AND a real browser
  'tool:write':    '#2ee6a8',  // mint     mutating disk
  'tool:delegate': '#4d7cff',  // blue     helper agents
  'tool:memory':   '#a06bff',  // violet   mnemosyne r/w
  'tool:skill':    '#ff5ce1',  // magenta  procedures
};

const cv = $('#brain'), ctx = cv.getContext('2d');
let MOBILE = innerWidth < 760;

/* ---------------- network definition ---------------- */
/* What KIND of job the prompt is — classified from the inbound message, so intent shows up
   before any tool runs. Discord/cron/webhook are all just "a prompt arrived"; the type is the signal. */
const TASK_RULES = [
  ['task:research', /(research|nghiên cứu|tìm hiểu|tìm|search|tra cứu|so sánh|nguồn|khảo sát|tham khảo|market|competitor)/i],
  ['task:data',     /(kho|inventory|stock|tồn|nhập|xuất|đơn|order|csv|excel|giá|price|doanh thu|báo cáo|recipes|sổ bán)/i],
  ['task:visual',   /(ảnh|hình|design|thiết kế|ui\b|ux\b|3d|model|animation|màu|layout|font|render|halftone|glow|hero)/i],
  ['task:reach',    /(threads|reddit|instagram|\big\b|comment|reply|đăng|khách|lead|inbox|\bdm\b|outreach|đối tác)/i],
  ['task:ops',      /(cron|gateway|config|skill|memory|mnemosy|tailscale|server|log|backup|tool|profile|hermes|system)/i],
  ['task:build',    /(code|build|làm|sửa|fix|deploy|site|web|html|css|\bjs\b|api|python|script|lỗi|bug|thêm|add|tạo)/i],
];
function classifyTask(msg) {
  if (!msg) return null;
  let best = null, score = 0;
  for (const [id, re] of TASK_RULES) {
    const m = msg.match(new RegExp(re.source, 'gi'));
    const s = m ? m.length : 0;
    if (s > score) { score = s; best = id; }
  }
  return best;
}

const LAYERS = [
  { label: 'memory',    sub: 'what it remembers', desc: 'Past facts and notes, recalled before it starts thinking.',
    nodes: [
      // read order, not storage order: the memo file is in the prompt before anything is
      // searched, then recall reaches for the freshest tier first
      { id: 'in:memory',     label: 'memo file', desc: 'always loaded' },
      { id: 'mem:working',   label: 'working',   desc: 'notes just captured' },
      { id: 'mem:episodic',  label: 'episodic',  desc: 'notes from past sessions' },
      { id: 'mem:facts',     label: 'facts',     desc: 'small single facts' },
      { id: 'mem:canonical', label: 'canonical', desc: 'settled, stable facts' },
      { id: 'mem:graph',     label: 'graph',     desc: 'facts linked to skills' } ] },
  { label: 'reasoning', sub: 'how it thinks', desc: 'Think, act, read the result, repeat until the answer is ready.',
    nodes: [
      { id: 'th:1', label: 'parse',       desc: 'reads your ask' },
      { id: 'th:2', label: 'recall',      desc: 'gathers context' },
      { id: 'th:3', label: 'decide',      desc: 'picks a step' },
      { id: 'th:4', label: 'call tool',   desc: 'chooses a tool' },
      { id: 'th:5', label: 'read result', desc: 'reads the output' },
      { id: 'th:6', label: 'write',       desc: 'writes the reply' } ] },
  { label: 'action',    sub: 'what it runs', desc: 'The tools it actually runs. Thicker line = more often.',
    nodes: [
      { id: 'tool:terminal', label: 'terminal', desc: 'shell on this PC' },
      { id: 'tool:web',      label: 'browse',   desc: 'searches + drives a browser' },
      { id: 'tool:read',     label: 'read',     desc: 'opens files' },
      { id: 'tool:write',    label: 'write',    desc: 'edits files' },
      { id: 'tool:code',     label: 'code',     desc: 'python runs', big: true, spin: false },
      { id: 'tool:delegate', label: 'delegate', desc: 'helper agents', big: true, progress: null, run: false },
      { id: 'tool:memory',   label: 'memory',   desc: 'reads/writes notes' },
      { id: 'tool:skill',    label: 'skill',    desc: 'loads playbooks' } ] },
  { label: 'output',    sub: 'what comes back', desc: 'What comes back to you, and what changed on disk.',
    nodes: [
      { id: 'out:reply',    label: 'reply',   desc: 'message to you' },
      { id: 'out:artifact', label: 'file Δ',  desc: 'files changed' },
      { id: 'out:learning', label: 'learned', desc: 'new skill or note' } ] },
];

function toolNeuron(name) {
  if (TOOL_MAP[name]) return TOOL_MAP[name];      // the install's own tool → node map
  const t = (name || '').toLowerCase();
  if (/delegate|cronjob/.test(t)) return 'tool:delegate';
  if (/execute_code/.test(t)) return 'tool:code';
  if (/playwright|browser_|browser_exec|web_search|web_extract/.test(t)) return 'tool:web';
  if (/read_file|search_files/.test(t)) return 'tool:read';
  if (/write_file|patch/.test(t)) return 'tool:write';
  if (/memory/.test(t)) return 'tool:memory';
  if (/skill/.test(t)) return 'tool:skill';
  if (/terminal|shell|process/.test(t)) return 'tool:terminal';
  return 'tool:web';
}

/* ---------------- state ---------------- */
const NEURONS = [], neuronById = {}, WEIGHTS = [], CLICKS = {};
/* Every kind the log can emit, in one place. Three times now an event has been renamed on the
   server (speak → stream/deliver) or added (in) and a hard-coded list somewhere else silently
   stopped it: the pulse never reached firePulses and the wire looked dead. Use this constant. */
const FLOW_KINDS = ['in', 'think', 'act', 'stream', 'deliver', 'end'];

let pulses = [], hoverN = null, hotEdges = new Map();
/* cosmetic only: a hub that is being fed shows it. Each arrival pushes an expanding ring whose
   size grows with the number of arrivals in the current burst and whose hue steps every time. */
let PINGS = [];
const RECV = new Map();   // nodeId → { combo, last, hue }
/* the three sinks are final: when a burst of data has finished landing in one of them, it
   rings and a small arcade "delivered" pops out of the node */
const SINK_IDS = new Set(['out:reply', 'out:artifact', 'out:learning']);
let POPS = [];
const SINK_TIMERS = new Map();
/* Every wire at rest is the same pale yellow: colour is the signal that data is moving,
   so a resting wire must not own a phase colour. Thin and quiet, so it never competes
   with an activation. */
const MESH_C = '#ffe066';
const MESH_A = 0.15;         // resting wire alpha, set explicitly by Khanh: 15%
const FADE_MS = 4000;
/* an activated edge has ONE thickness on every link; brightness and the beam carry the
   weight instead. Smaller on the phone so a 390px canvas does not turn into a slab. */
const activeW = () => MOBILE ? 2.6 : 2.9;      // evaluated per frame: MOBILE flips on resize
const warmW = () => MOBILE ? 1.9 : 2.1;        // a lit line never cuts: it dims out over four seconds
let PULSE_SLOW = 0.25;       // 4× slower than the original travel speed; the demo raises it
const COLX = [];
let MIN_GAP = [];  // column centres for caption tap targets
const BANDY = []; // phone: the six horizontal stage bands (y centre + height)
let BAND_F = [0.5, 1.5, 2.5, 3.5];   // band centres in bandH units — the reasoning→action gap is wide
let brain = { state: 'idle', label: 'idle', session: '', model: '' };
let mne = null;   // mnemosyne tiers + recent
let PEEK = null;
let THINK = { text: '', chars: 0, ts: 0, start: 0, seen: 0, shown: '' };  // what the code / delegate nodes are doing, verbatim
const LAST_ACT = {}; // tool id → ms of its last real call
let _peekSig = '';   // what the last sample was, so a NEW sample can be revealed
let _peekAnim = 0;   // ms when the reveal started (0 = finished)
let USE = null;   // token economy + delegations
let ORIGINS = null; // which discord channel/thread each prompt comes from
let lastThink = null, lastAct = null;
const TURN = { start: 0, tools: 0, thinks: 0, out: 0, lastTool: '', lastDur: 0, task: '' };
let lastSig = '', thCursor = 0, lastToolId = null;

let LAYOUT_EPOCH = 0;
/* ---------------- the install decides the graph ----------------
   A hard-coded node list draws somebody else's agent. /api/profile comes from scan.py, which
   reads this Hermes: which memory tiers exist, which tools actually ran, how often. The
   reasoning column stays fixed — parse → recall → decide → call → read → write is Hermes' loop,
   not a preference. Everything else is measured. */
let PROFILE = null, TOOL_MAP = {};

const fmtN = n => {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
};

async function applyProfile() {
  let p;
  try { p = await (await fetch('/api/profile')).json(); } catch { return; }
  if (!p || !Array.isArray(p.actions) || !p.actions.length) return;   // no scan: keep the defaults
  PROFILE = p;
  TOOL_MAP = p.tool_map || {};

  if (Array.isArray(p.memory) && p.memory.length) {
    // the memo file is the one tier that is always in the prompt, so it stays the entry node
    LAYERS[0].nodes = [{ id: 'in:memory', label: 'memo file', desc: 'always loaded' }]
      .concat(p.memory.filter(m => m.id !== 'mem:notes').map(m => ({
        id: m.id, label: m.label, desc: m.desc, value: fmtN(m.count)
      })));
  }
  LAYERS[2].nodes = p.actions.map(a => ({
    id: a.id, label: a.label, desc: a.desc, big: !!a.big, value: fmtN(a.count)
  }));

  // one colour per tool, taken from the scan so the node, its wire and its packet agree
  for (const k of Object.keys(TOOL_COLOR)) if (k.startsWith('tool:')) delete TOOL_COLOR[k];
  p.actions.forEach(a => { TOOL_COLOR[a.id] = a.accent; });

  // rewire: memory tiers feed recall, every action hangs off "call tool", and the nodes that
  // write files also report to the artifact sink
  const keep = LINKS.filter(([a, b]) => !(String(a).match(/^(tool|mem):/) || String(b).match(/^(tool|mem):/)));
  LINKS.length = 0; LINKS.push(...keep);
  LAYERS[0].nodes.forEach(n => LINKS.push([n.id, n.id === 'in:memory' ? 'th:1' : 'th:2']));
  p.actions.forEach(a => {
    LINKS.push(['th:4', a.id], [a.id, 'th:5']);
    if (/write|patch|edit|artifact/i.test(a.id + ' ' + a.label)) LINKS.push([a.id, 'out:artifact']);
  });

  const sub = document.getElementById('sub');
  if (sub && p.stats) {
    const bits = [];
    if (p.stats.sessions) bits.push(`${p.stats.sessions} sessions`);
    if (p.stats.tool_results) bits.push(`${fmtN(p.stats.tool_results)} tool calls`);
    if (p.skills && p.skills.count) bits.push(`${p.skills.count} skills`);
    if (bits.length) sub.textContent = bits.join(' · ');
  }
}

function layout() {
  LAYOUT_EPOCH++;
  EP_CACHE.clear();                       // geometry changed: every route is stale
  NEURONS.length = 0;
  for (const k in neuronById) delete neuronById[k];
  MOBILE = innerWidth < 760;
  initOrb();
  const W = innerWidth;
  const card = document.getElementById('now');
  const cardBottom = card ? card.getBoundingClientRect().bottom : 0;
  const headBottom = (document.querySelector('header')?.getBoundingClientRect().bottom) || 57;
  const SAT = safeTop();                                  // dynamic island / notch strip
  // the rail is a left column on desktop: it must never push the graph down, or every
  // column ends up squeezed into the bottom third of the screen
  const top = MOBILE ? Math.max(SAT + 150, cardBottom + 10)
                     : Math.max(SAT + 120, headBottom + 46);
  const tk = document.getElementById('ticker');
  const tickTop = tk && tk.getBoundingClientRect().height ? tk.getBoundingClientRect().top : innerHeight - 52;
  // the bottom band hugged a 52px reserve it did not need: measured 73px of dead space
  // under the last chip. Use the ticker's real top, and let the top card take the rest.
  // leave a real bottom margin: the slack under the last band is what pays for the taller
  // status card above it, so the graph's bottom edge moves UP rather than down
  const usable = Math.max(160, MOBILE ? (tickTop - top - 18)
                                      : Math.min(innerHeight - top - 74, tickTop - top - 24));
  const bandH = usable / LAYERS.length;                  // phone: one horizontal band per stage
  // 16 of the 32 wires run reasoning → action, so that gap gets the room and the others
  // give it up. Fractions are in bandH units and still sum to LAYERS.length.
  BAND_F = [0.40, 1.25, 2.75, 3.60];   // gaps 0.85 / 1.50 / 0.85: outer gaps matched, middle keeps the 16 wires
  /* The phone's last band was floating: reply / file / learned sat 35–38px above the ticker while
     the top gap stayed tight, which read as the graph running out of steam at the bottom. Drop the
     output stage onto the floor of the canvas instead, keeping a 12px margin of air. */
  if (MOBILE) {
    const outN = Math.max(1, LAYERS[LAYERS.length - 1].nodes.length);
    const outBw = Math.min(46, (W - 14 * 2) / outN - 3);
    const outHh = Math.round(outBw * 4 / 3) / 2;
    BAND_F[3] = (tickTop - top - 12 - outHh) / bandH;
  }
  BANDY.length = 0;
  LAYERS.forEach((L, li) => BANDY.push({ y: top + bandH * (BAND_F[li] != null ? BAND_F[li] : li + 0.5), h: bandH, layer: li }));
  // the status rail owns the left edge on desktop, so the columns start after its right
  // edge and stay equally spaced in whatever room is left
  const rail = MOBILE ? 0 : (document.getElementById('now')?.getBoundingClientRect().right || 0);
  const x0 = MOBILE ? 0 : rail + 34;
  const x1 = W - W * 0.058;
  // the same imbalance on desktop: 16 wires cross reasoning → action, so that gutter is
  // 0.34 of the width while memory → reasoning keeps 0.20 and action → output 0.21
  // three equal gutters: 0.10 → 0.90 with 0.2667 between every pair (was 0.24 / 0.34 / 0.24)
  const COL_F = [0.022, 0.2887, 0.5553, 0.822];
  const colX = li => MOBILE ? W * XF_M[li] : x0 + (x1 - x0) * COL_F[li];
  LAYERS.forEach((L, li) => {
    const n = Math.max(1, L.nodes.length);          // never divide by an empty column
    const pad = MOBILE ? 14 : 0;
    L.nodes.forEach((def, i) => {
      const x = MOBILE
        ? pad + (W - pad * 2) * ((i + 0.5) / n)      // stage reads left → right inside its band
        : colX(li);
      const y = MOBILE
        ? top + bandH * (BAND_F[li] != null ? BAND_F[li] : li + 0.5)   // stages stack top → bottom
        : n <= 2
          ? top + usable * (0.5 + (i - (n - 1) / 2) * 0.16)   // a 2-node column reads as one stage, not two ends
          : top + usable * ((i + 0.5) / n);
      // a node is a chip with an in-port and an out-port: portrait on a phone (flow runs
      // down), landscape on desktop (flow runs right). 3:4 either way.
      // a band of 8 on a 390px screen gives each node 42.2px: a 'big' 46px chip overlapped
      // its neighbours by 0.8px, which only became visible once hubs got a frame
      const slot = MOBILE ? (W - pad * 2) / n : 0;
      const bwWish = MOBILE ? (def.big ? 52 : 46) : (def.big ? 84 : 76);
      const bw = MOBILE ? Math.min(bwWish, slot - 3) : bwWish;
      const bh = Math.round(bw * (MOBILE ? 4 / 3 : 3 / 4));
      const nr = { id: def.id, label: def.label, desc: def.desc || '', x, y,
                   value: MOBILE && def.valueShort ? def.valueShort : (def.value || ''),
                   _call: def._call, _skill: def._skill,
                   accent: TOOL_COLOR[def.id] || NODE_ACCENT[def.id] || COL_ACCENT[li] || null,
                   w: bw, h: bh, hw: bw / 2, hh: bh / 2,
                   r: Math.max(bw, bh) / 2,
                   progress: def.progress, spin: def.spin, run: def.run,
                   act: 0, layer: li, info: '', click: CLICKS[def.id] || null, glowT: 0 };
      NEURONS.push(nr); neuronById[def.id] = nr;
    });
  });
  // how many wires arrive here: a node with many inlets is a hub, and it must read as one.
  // Counted from LINKS, not WEIGHTS, so it survives a layout() that runs before the weights.
  const degMap = {};
  for (const [a, b] of LINKS) degMap[b] = (degMap[b] || 0) + 1;
  for (const nr of NEURONS) nr.deg = degMap[nr.id] || 0;
  // nodes sit at evenly spaced fractions of the band, so the label budget is exact
  MIN_GAP = LAYERS.map(L => (W - (MOBILE ? 14 * 2 : 0)) / Math.max(1, L.nodes.length));
  COLX.length = 0;
  LAYERS.forEach((L, li) => COLX.push({ x: colX(li), layer: li }));
  // equal gutters leave the drawing off-centre (295px of air on the left, 232 on the right)
  // because the widest column is not the middle one: nudge the whole graph so the margins match
  if (!MOBILE) {
    let lo = Infinity, hi = -Infinity;
    for (const n of NEURONS) { lo = Math.min(lo, n.x - n.hw); hi = Math.max(hi, n.x + n.hw); }
    const shift = (W - (lo + hi)) / 2;
    if (Math.abs(shift) > 0.5) for (const n of NEURONS) n.x += shift;
    for (const c of COLX) c.x += shift;
  }
  buildMesh();          // geometry moved → re-bake the quiet mesh
}

/* Every line has to be a thing that can happen. A full mesh between columns looked
   busy but claimed "canonical facts feed the reply" and "delegate writes a file", so
   the drawing now follows the real path: memo is in the prompt, recall reads the
   tiers, the step chain runs down the reasoning column, one tool call picks one tool,
   and that tool produces one of the three outputs. */
const LINKS = [
  ['in:memory', 'th:1'],
  ['mem:working', 'th:2'], ['mem:episodic', 'th:2'], ['mem:facts', 'th:2'],
  ['mem:canonical', 'th:2'], ['mem:graph', 'th:2'],
  ['th:1', 'th:2'], ['th:2', 'th:3'], ['th:3', 'th:4'], ['th:4', 'th:5'], ['th:5', 'th:6'],
  ['th:4', 'tool:memory'], ['th:4', 'tool:read'], ['th:4', 'tool:terminal'],
  ['th:4', 'tool:code'], ['th:4', 'tool:web'], ['th:4', 'tool:write'],
  ['th:4', 'tool:skill'], ['th:4', 'tool:delegate'],
  // the loop: a tool hands its result back to be read (right → left, the one real back-edge)
  ['tool:memory', 'th:5'], ['tool:read', 'th:5'], ['tool:terminal', 'th:5'],
  ['tool:code', 'th:5'], ['tool:web', 'th:5'], ['tool:write', 'th:5'],
  ['tool:skill', 'th:5'], ['tool:delegate', 'th:5'],
  // and the reply is written by compose, not by a tool: one leap over the action column
  ['th:6', 'out:reply'],
  ['tool:write', 'out:artifact'], ['tool:code', 'out:artifact'], ['tool:web', 'out:artifact'],
  ['tool:memory', 'out:learning'], ['tool:skill', 'out:learning'],
];



/* A real 5x7 bitmap alphabet for the one word that has to read as a game, not a caption.
   Monospace at the same size reads as UI text; blocks on a pixel grid read as 8-bit. */
const PIXGLYPH = {
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
};
const RUN_CACHE = new Map();
function wordRuns(txt) {
  if (RUN_CACHE.has(txt)) return RUN_CACHE.get(txt);
  const rows = 7, cols = txt.length * 6 - 1;
  const out = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    // glyph[r] is a whole row string: push its CELLS, not the string itself
    for (const ch of txt) { for (const c of (PIXGLYPH[ch] ? PIXGLYPH[ch][r] : '00000')) line.push(c); line.push('0'); }
    line.pop();                                   // no gap after the last glyph
    // merge consecutive lit cells into one rect: 63 runs instead of 225 fills
    let i = 0;
    while (i < line.length) {
      if (line[i] === '1') { let n = 0; while (line[i + n] === '1') n++; out.push([r, i, n]); i += n; }
      else i++;
    }
  }
  const res = { runs: out, cols };
  RUN_CACHE.set(txt, res);
  return res;
}

/* ---------------------------------------------------------------- demo walk
   One scripted turn that touches all 23 nodes, so the graph can be shown end to
   end without waiting for a real task. Every step is a link that actually exists
   in LINKS, in the order a real turn would take them. `?demo` plays it; D replays. */
const DEMO_STEPS = [
  [   0, ['in:memory', 'th:1'],            'prompt arrives',              C.teal],
  [ 900, ['in:memory', 'th:1'],            '',                            C.teal],
  [1500, ['th:1', 'th:2'],                 'parse the ask',               C.violet],
  [1700, ['mem:working', 'th:2'],          'working memory',              C.gold],
  [1950, ['mem:episodic', 'th:2'],         'episodic',                    C.gold],
  [2200, ['mem:facts', 'th:2'],            'facts',                       C.gold],
  [2450, ['mem:canonical', 'th:2'],        'canonical',                   C.gold],
  [2700, ['mem:graph', 'th:2'],            'graph',                       C.gold],
  [3400, ['th:2', 'th:3'],                 'plan the steps',              C.violet],
  [3800, ['th:3', 'th:4'],                 'decide which tools',          C.violet],
  [4200, ['th:4', 'tool:memory'],          'read the reorder policy',     C.blue],
  [4500, ['th:4', 'tool:read'],            'inventory.csv',               C.blue],
  [4800, ['th:4', 'tool:terminal'],        'ls reports/',                 C.blue],
  [5100, ['th:4', 'tool:code'],            'deduct 3 FLORIA · 2 STRATA',  C.blue],
  [5400, ['th:4', 'tool:web'],             'check PLA price',             C.blue],
  [5700, ['th:4', 'tool:write'],           'write stock_check.md',        C.blue],
  [6000, ['th:4', 'tool:skill'],           'release-notes',   C.blue],
  [6300, ['th:4', 'tool:delegate'],        'cross-check by subagent',     C.blue],
  [7000, ['tool:memory', 'th:5'],          'policy back',                 C.blue],
  [7200, ['tool:read', 'th:5'],            'csv back',                    C.blue],
  [7400, ['tool:terminal', 'th:5'],        'listing back',                C.blue],
  [7600, ['tool:code', 'th:5'],            'numbers back',                C.blue],
  [7800, ['tool:web', 'th:5'],             'price back',                  C.blue],
  [8000, ['tool:write', 'th:5'],           'file written',                C.blue],
  [8200, ['tool:skill', 'th:5'],           'skill back',                  C.blue],
  [8400, ['tool:delegate', 'th:5'],        'subagent verdict',            C.blue],
  [9000, ['th:5', 'th:6'],                 'compose the answer',          C.violet],
  [9800, ['th:6', 'out:reply'],            'sent to discord',             C.green],
  [10100,['tool:write', 'out:artifact'],   'reports/stock_check.md',      '#38bdf8'],
  [10400,['tool:skill', 'out:learning'],   'skill updated',               '#c084fc'],
];
let demoIdx = 0, demoTimer = null, DEMO_ON = false;

function demoStop() {
  clearTimeout(demoTimer); demoTimer = null; demoIdx = 0;
}

function demoPlay() {
  demoStop();
  DEMO_ON = true;
  PULSE_SLOW = 1.6;                                  // a walk, not a screenshot: let it move
  hotEdges.clear(); PINGS.length = 0; POPS.length = 0;
  const base = performance.now();
  const tick = () => {
    if (demoIdx >= DEMO_STEPS.length) {
      demoTimer = setTimeout(() => { DEMO_ON = false; PULSE_SLOW = 0.25; demoIdx = 0; }, 2600);
      return;
    }
    const [at, pts, label, col] = DEMO_STEPS[demoIdx];
    const wait = at - (performance.now() - base);
    if (wait > 24) { demoTimer = setTimeout(tick, wait); return; }
    firePath(pts, col, label, performance.now());
    demoIdx++;
    tick();
  };
  tick();
}

/* --------------------------------------------------------- showcase (Ctrl+Shift+C)
   Three turns at once. Every step is a link that already exists in the graph, staggered so
   all four columns are busy at the same time — this is the picture of "several tasks in
   flight", which the single scripted walk above can never show. Re-running restarts it, and
   the tail timer is the only thing left running afterwards. */
const SHOW_TASKS = [
  /* Real timings, not animation timings: recall takes a beat, a tool call takes seconds to
     come back, and the next thought waits for it. Three tasks, four seconds apart. */
  { t0: 0, hue: '#22d3ee', steps: [
    ['in:memory','th:1','restock question',0],
    ['th:1','th:2','parse',900],
    ['mem:working','th:2','working memory',1400],
    ['mem:facts','th:2','facts',1650],
    ['th:2','th:3','plan',2500],
    ['th:3','th:4','pick tools',3400],
    ['th:4','tool:read','inventory.csv',3700],
    ['th:4','tool:code','deduct 3 FLORIA · 2 STRATA',4200],
    ['tool:read','th:5','rows back',6100],
    ['tool:code','th:5','numbers back',6900],
    ['th:5','th:6','compose',7700],
    ['th:6','out:reply','sent to discord',8700],
    ['tool:code','out:artifact','reports/stock_check.md',9100],
  ] },
  { t0: 3500, hue: '#ff5ce1', steps: [
    ['in:memory','th:1','partner brief',0],
    ['th:1','th:2','parse',800],
    ['mem:episodic','th:2','episodic',1300],
    ['mem:graph','th:2','graph',1550],
    ['th:2','th:3','plan',2400],
    ['th:3','th:4','pick tools',3300],
    ['th:4','tool:web','price check',3600],
    ['th:4','tool:delegate','second pair of eyes',4100],
    ['th:4','tool:memory','look up a fact',5300],
    ['tool:web','th:5','market back',6200],
    ['tool:delegate','th:5','verdict back',7000],
    ['tool:memory','th:5','fact back',7600],
    ['th:5','th:6','compose',8400],
    ['th:6','out:reply','reply drafted',9300],
    ['tool:memory','out:learning','fact remembered',9700],
  ] },
  { t0: 7000, hue: '#4d7cff', steps: [
    ['in:memory','th:1','nav fix',0],
    ['th:1','th:2','parse',850],
    ['mem:canonical','th:2','canonical',1350],
    ['th:2','th:3','plan',2400],
    ['th:3','th:4','pick tools',3200],
    ['th:4','tool:terminal','grep nav',3500],
    ['th:4','tool:write','rewrite config.yaml',4000],
    ['th:4','tool:memory','reload policy',4500],
    ['th:4','tool:skill','sheet-diff',5000],
    ['tool:terminal','th:5','matches back',6400],
    ['tool:write','th:5','diff back',7000],
    ['tool:memory','th:5','policy back',7500],
    ['tool:skill','th:5','steps back',8000],
    ['th:5','th:6','compose',8800],
    ['th:6','out:reply','sent',9700],
    ['tool:write','out:artifact','config/schedule.yaml',10100],
    ['tool:skill','out:learning','skill updated',10500],
  ] },
];
let showTimers = [], SHOW_ON = false;
function showcase() {
  showTimers.forEach(clearTimeout); showTimers = [];
  PULSE_SLOW = 0.30;                       // near the real travel speed: a busy brain, not a screensaver
  SHOW_ON = true;
  for (const task of SHOW_TASKS) {
    for (const [a, b, label, at] of task.steps) {
      if (!neuronById[a] || !neuronById[b] || !edgeOf(a, b)) continue;   // never fire a missing link
      showTimers.push(setTimeout(() => {
        const src = neuronById[a];
        const col = (src.accent && src.accent !== 'rainbow') ? src.accent : task.hue;
        firePath([a, b], col, label, performance.now(), 2);
      }, task.t0 + at));
    }
  }
  // the last step lands at ~17.5s; let the final packets arrive before releasing the pace
  showTimers.push(setTimeout(() => { SHOW_ON = false; PULSE_SLOW = 0.25; }, 20000));
}
window.showcase = showcase;

function buildWeights() {
  WEIGHTS.length = 0;
  // a rebuild makes new edge objects and new node positions: stale hot edges and
  // in-flight pulses would keep drawing on the old geometry forever
  hotEdges.clear();
  pulses.length = 0;
  const layerOf = {};
  LAYERS.forEach((L, li) => L.nodes.forEach(nd => { layerOf[nd.id] = li; }));
  for (const [a, b] of LINKS) {
    if (!(a in layerOf) || !(b in layerOf)) continue;
    const li = Math.min(layerOf[a], LAYERS.length - 2);
    // data leaving a tool carries that tool's colour, so a magenta packet tells you skill
    // ran without reading a label; the other columns keep the phase language
    const src = neuronById[a];
    const ownHue = VIA[a + '>' + b] ? VIA_COLOR
                 : (TOOL_COLOR[a] || NODE_ACCENT[a] || (src && src.accent !== 'rainbow' && src.accent) || null);
    WEIGHTS.push({ from: a, to: b, w: 0, color: ownHue || PHASES[li].color, phase: PHASES[li].name,
                   leap: Math.abs(layerOf[a] - layerOf[b]) > 1 && !VIA[a + '>' + b] });
  }
  buildMesh();
}

/* The quiet mesh is static geometry: bake it once per layout instead of
   stroking ~170 bezier curves every frame. Only the lit edges are drawn live. */
let meshCv = null;
function buildMesh() {
  const DW = innerWidth, DH = innerHeight, dpr = DP();
  if (!meshCv) meshCv = document.createElement('canvas');
  if (meshCv.width !== Math.round(DW * dpr) || meshCv.height !== Math.round(DH * dpr)) {
    meshCv.width = Math.round(DW * dpr); meshCv.height = Math.round(DH * dpr);
  }
  const g = meshCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, DW, DH);
  for (const w of WEIGHTS) {
    const a = neuronById[w.from], b = neuronById[w.to];
    if (!a || !b) continue;
    const ep = edgePath(a, b);
    g.strokeStyle = rgba(MESH_C, MESH_A);
    g.lineWidth = 0.32 + w.w * 0.70;
    // the leap is a solid hairline like every other wire: a permanent dashed scratch
    // running the height of the canvas read as a 'ghost line', not as wiring
    g.beginPath(); tracePath(g, ep); g.stroke();
  }
}
const edgeOf = (a, b) => WEIGHTS.find(w => w.from === a && w.to === b);

/* ---------------- data → activations & weights ---------------- */
const TOOL_COUNT = {};
const toolTraffic = id => Object.entries(TOOL_COUNT)
  .reduce((acc, [t, c]) => toolNeuron(t) === id ? acc + c : acc, 0);

function applyLive(d) {
  const evs = d.events || [];
  brain.session = d.active_session || '';
  const last = [...evs].reverse().find(e => ['think', 'act'].includes(e.kind));
  // a delivered reply ends the turn even if the server still reports busy: the log can
  // keep ticking (warnings, watch notifications) long after the answer has gone out.
  const flowEv = [...evs].reverse().find(e => FLOW_KINDS.includes(e.kind));
  // only delivery ends a turn; a flushed batch means the answer is still being written
  const over = flowEv && (flowEv.kind === 'end' || flowEv.kind === 'deliver');
  brain.state = window.__idleTest ? 'idle'
              : (!d.busy || over) ? 'idle'
              : (flowEv?.kind === 'act' ? 'act' : 'think');
  brain.label = brain.state === 'act' ? (last?.tool || 'acting')
              : brain.state === 'think' ? 'thinking' : 'idle';
  if (last?.model) brain.model = `${last.model} · ${last.provider}`;

  for (const nr of NEURONS) nr.act = Math.max(0, nr.act * 0.90);

  const thAct = {}, outAct = { 'out:reply': 0, 'out:artifact': 0, 'out:learning': 0 };
  let speaks = 0;
  for (const e of evs) {
    if (e.kind === 'deliver') { speaks++; outAct['out:reply']++; }
    else if (e.kind === 'think') { thAct[e.n % 6] = (thAct[e.n % 6] || 0) + 1;
      if (e.model) brain.model = `${e.model} · ${e.provider}`; }
    else if (e.kind === 'act') { TOOL_COUNT[e.tool] = (TOOL_COUNT[e.tool] || 0) + 1;
      const nr = neuronById[toolNeuron(e.tool)];
      if (nr) nr.act = Math.min(1, nr.act + 0.35); }
  }
  /* max, not add: this runs on every poll, so `act += v` climbed 0.16 per poll while the
     decay only took 10% — the memo node staircased 0.30 → 0.43 → 0.55 → 0.65 … and read as
     a node blinking to send something. Warmth is a level, not an accumulator. */
  const bump = (id, v) => { const nr = neuronById[id]; if (nr) nr.act = Math.max(nr.act, v); };
  // skill layer: which playbook is loaded right now (+ keep the task chip for the prompt's intent)
  for (const e of evs) {
    if (e.kind !== 'in') continue;
    const t = classifyTask(e.msg);
    if (t) TURN.task = t;
  }
  bump('in:memory', 0.26);                      // steady, not accumulating: it is in the prompt all turn
  // the two hubs carry a number, not just a name: recall shows the retrieved volume and
  // read-result the size of the payload that came back through it
  if (mne && mne.total) patchNode('th:2', { value: fTok(mne.total), desc: 'recall volume' });
  // mnemosyne layer: activation from real tier volume + 24h activity
  if (mne && mne.tiers) {
    const maxCount = Math.max(...mne.tiers.map(t => t.count), 1);
    for (const t of mne.tiers) {
      const vol = 0.18 + 0.42 * (t.count / maxCount);
      const fresh = Math.min(0.4, (t.recent24h || 0) * 0.035);
      bump('mem:' + t.id, vol + fresh);
    }
  }
  // turn telemetry lives on the NOW card, not in a column
  updateTurn(evs);
  paintTurn();
  // "live" = data is being processed in this node RIGHT NOW (drives the sustained glow)
  for (const nr of NEURONS) { nr.live = false; if (brain.state !== 'act') nr.spin = false; }
  const thId = 'th:' + ((thCursor % 6) + 1);
  if (brain.state === 'think') {
    // what is actually held in context while it thinks: the memo file and the current step
    if (neuronById['in:memory']) neuronById['in:memory'].live = true;
    if (neuronById[thId]) neuronById[thId].live = true;
    // compose is the step that writes the reply: it loads while the model is generating
    if (thId === 'th:6' && neuronById['th:6']) neuronById['th:6'].spin = true;
  } else if (brain.state === 'act' && lastAct) {
    if (neuronById[thId]) neuronById[thId].live = true;
    const tn = neuronById[toolNeuron(lastAct.tool)];
    if (tn) tn.live = true;
    const cn = neuronById['tool:code'];
    if (cn) cn.spin = /execute_code/.test(lastAct.tool || '');
    const wn = neuronById['tool:web'];
    if (wn) wn.spin = /web_search|web_extract|browser/.test(lastAct.tool || '');
  }
  for (const [i, v] of Object.entries(thAct)) bump('th:' + ((+i % 6) + 1), 0.32 + v * 0.12);
  for (const [k, v] of Object.entries(outAct)) if (v) bump(k, 0.4);

  // weights = share of traffic arriving at each target (thicker = busier)
  const totals = LAYERS.slice(1).map(L =>
    L.nodes.reduce((s, nd) => s + (nd.id.startsWith('tool:') ? toolTraffic(nd.id)
                                    : (neuronById[nd.id]?.act || 0)), 0) || 1);
  for (const w of WEIGHTS) {
    const tgt = neuronById[w.to];
    const my = w.to.startsWith('tool:') ? toolTraffic(w.to) : (tgt?.act || 0);
    w.w = Math.min(1, my / totals[tgt.layer - 1]);
  }
}

/* ---------------- turn depth (loop layer) ---------------- */
function fmtDur(s) {
  if (!s || s < 1) return '—';
  if (s < 60) return Math.round(s) + 's';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}m${String(r).padStart(2, '0')}s`;
}
const SHORT_TOOL = { execute_code: 'code', read_file: 'read', write_file: 'write',
  search_files: 'grep', web_search: 'search', web_extract: 'fetch',
  delegate_task: 'agent', skill_view: 'skill', skill_manage: 'skill',
  process_manage: 'proc', browser_navigate: 'browser' };
const shortTool = t => {
  let s = SHORT_TOOL[t] || String(t || '').replace(/^mcp__\w+__/, '');
  if (/^browser_/.test(s)) s = 'browse';      // the node's own name
  return s || '—';
};

function updateTurn(evs) {
  // a turn starts at the last inbound message; everything after it belongs to this answer
  let i = -1;
  for (let k = evs.length - 1; k >= 0; k--) if (evs[k].kind === 'in') { i = k; break; }
  const since = i >= 0 ? evs.slice(i + 1) : evs.slice(-12);
  TURN.tools = since.filter(e => e.kind === 'act').length;
  TURN.thinks = since.filter(e => e.kind === 'think').length;
  TURN.out = since.filter(e => e.kind === 'think').reduce((s, e) => s + (e.tout || 0), 0);
  const acts = since.filter(e => e.kind === 'act');
  if (acts.length) { TURN.lastTool = acts[acts.length - 1].tool; TURN.lastDur = acts[acts.length - 1].dur; }
  TURN.start = (i >= 0 && evs[i].ts) || since[0]?.ts || TURN.start;
}

function paintTurn() {
  paintMobile();
  const el = $('#now-turn'); if (!el) return;
  const elSec = TURN.start ? Date.now() / 1000 - TURN.start : 0;
  el.innerHTML = [
    TURN.task ? `<span class="c teal"><b>${esc(TURN.task.replace('task:', ''))}</b> task</span>` : '',
    `<span class="c gold"><b>step ${TURN.tools + 1}</b></span>`,
    TURN.lastTool ? `<span class="c blue"><b>${esc(shortTool(TURN.lastTool))}</b> ${(+TURN.lastDur).toFixed(2)}s</span>` : '',
    `<span class="c"><b>${TURN.out >= 1000 ? (TURN.out / 1000).toFixed(1) + 'k' : TURN.out}</b> tok out</span>`,
    `<span class="c"><b>${fmtDur(elSec)}</b> this turn</span>`
  ].filter(Boolean).join('');
  relayoutCard();
  paintFocus();
}

/* the NOW card grows as chips fill in — keep the network below it instead of under it */
let _cardB = 0;
function relayoutCard() {
  const c = document.getElementById('now');
  if (!c) return;
  const b = c.getBoundingClientRect().bottom;
  if (Math.abs(b - _cardB) > 3) { _cardB = b; layout(); }
}

const fTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);

function paintUsage() {
  const el = $('#now-usage'); if (!el) return;
  if (!USE || !USE.today) { el.innerHTML = ''; return; }
  const t = USE.today;
  el.innerHTML = [
    `<span class="c teal"><b>${fTok(t.in)}</b> in</span>`,
    `<span class="c violet"><b>${fTok(t.out)}</b> out</span>`,
    `<span class="c gold"><b>${t.cache_pct}%</b> cached</span>`,
    `<span class="c"><b>${(t.calls || 0).toLocaleString()}</b> calls</span>`,
    USE.delegates_today ? `<span class="c"><b>${USE.delegates_today}</b> helpers</span>` : ''
  ].filter(Boolean).join('');
  relayoutCard();
}

async function fetchUsage() {
  try { const d = await (await fetch('/api/usage')).json(); if (d && d.today) { USE = d; paintUsage(); } } catch {}
}

/* Heaviest node in the middle of its column, weight falling off toward the edges.
   A column sorted top-down always looks tilted: all the traffic hugs one side and the
   pulses read as a skew. Centred weight makes the same movement look balanced. */
function centerOut(arr, weight) {
  const n = arr.length;
  if (n < 3) return arr.slice();
  const sorted = arr.slice().sort((a, b) => weight(b) - weight(a));
  const mid = Math.floor((n - 1) / 2);
  const order = [mid];
  for (let k = 1; order.length < n; k++) {
    if (mid + k < n) order.push(mid + k);
    if (order.length < n && mid - k >= 0) order.push(mid - k);
  }
  const out = new Array(n);
  sorted.forEach((v, i) => { out[order[i]] = v; });
  return out;
}


/* ---------------- action: order the tools by how often they really run ---------------- */
let TOOLS = null;
async function fetchTools(rebuild) {
  try { const d = await (await fetch('/api/tools')).json(); if (d && d.tools) TOOLS = d; } catch {}
  if (!TOOLS || !TOOLS.tools.length) return;
  const per = {};
  for (const t of TOOLS.tools) {
    const id = toolNeuron(t.name);
    per[id] = (per[id] || 0) + t.n;
  }
  // the code hub always carries a number, even before the next run: lifetime call count
  // Khanh 23/10: the code node keeps the hub frame but loses the stat readout — the number
  // sat inside the chip and the wires had to be routed around it. Drop the value entirely.
  // never wipe a live flash: this poll was clearing the readout the moment it appeared
  const c = neuronById['tool:code'];
  if (c && c.value && c.valueT0 == null) patchNode('tool:code', { value: '' });
  const L = LAYERS[2];
  const before = L.nodes.map(n => n.id).join('|');
  const after = centerOut(L.nodes, n => per[n.id] || 0);
  L.nodes = after;
  if (rebuild || before !== L.nodes.map(n => n.id).join('|')) { layout(); buildWeights(); }
}

/* ---------------- subagents + the code node's progress ---------------- */
let DELEG = null;
let delegWasRunning = false;

function patchNode(id, patch) {
  // search every stage, not just action: the reasoning hubs carry a readout too, and a
  // layout() rebuild would otherwise drop it back to the definition
  let def = null;
  for (const L of LAYERS) { def = L.nodes.find(n => n.id === id); if (def) break; }
  if (def) Object.assign(def, patch);
  const nr = neuronById[id];
  if (nr) Object.assign(nr, patch);          // no relayout: positions stay put, only the readout moves
}

/* Khanh 23/10: a readout on the code / delegate chips is a notification, not a fixture —
   it appears the moment the tool starts and is gone three seconds later. */
function flashNode(id, patch, ms = 3000) {
  patchNode(id, Object.assign({}, patch, { valueT0: performance.now() }));
  const t0 = neuronById[id] ? neuronById[id].valueT0 : 0;
  setTimeout(() => {
    const nr = neuronById[id];
    if (nr && nr.valueT0 === t0) patchNode(id, { value: '', valueShort: '', valueT0: null });
  }, ms + 80);
}

async function fetchDelegates(rebuild) {
  try { const d = await (await fetch('/api/delegations?limit=6')).json(); if (d && d.recent) DELEG = d; } catch {}
  if (!DELEG || !DELEG.recent.length) return;
  const last = DELEG.recent[0];
  const running = last.state === 'running';
  const done = last.tasks ? last.done / last.tasks : (running ? 0.35 : 1);
  const chip = {
    desc: running ? 'subagent working' : 'last batch done',
    progress: last.done ? Math.min(1, done) : null,   // nothing finished yet = unknown, not zero
    run: running,
  };
  // the readout is the "it started" signal: show it on the transition, let it fade
  if (running && !delegWasRunning) {
    flashNode('tool:delegate', Object.assign(chip, {
      value: last.done + '/' + last.tasks + ' · ' + Math.round(last.elapsed) + 's',
      valueShort: last.done + '/' + last.tasks,
    }));
  } else {
    patchNode('tool:delegate', chip);
  }
  delegWasRunning = running;
  if (rebuild) { layout(); buildWeights(); }
}

/* mcp__playwright__browser_click is a path, not a name. Everything that shows a tool to a
   human goes through here: "playwright · click" reads at a glance, "browser_click" does not. */
function prettyTool(raw) {
  const t = String(raw || '');
  const pm = t.match(/playwright.*browser_(\w+)/);
  if (pm) return 'playwright · ' + pm[1].replace(/_/g, ' ');
  if (/browser_exec/.test(t)) return 'playwright · exec';
  return shortTool(MOBILE ? t : t.replace(/^mcp__\w+__/, ''));
}

/* ---------------- NOW card ----------------
   The card and the orb must agree with the graph: memory gold, reasoning cyan, the tool's
   own hue while acting, output mint. One function decides, so they can never drift. */
function liveColor() {
  const st = brain.state;
  if (st === 'act') return TOOL_COLOR[toolNeuron(lastAct && lastAct.tool)] || C.blue;
  if (st === 'think') return PHASES[2].color;        // cyan — the reasoning column's colour
  if (st === 'idle') return IDLE_COL;
  return C.green;                                    // delivering: output
}

/* Colour does not switch, it travels. Hue is eased along the shortest arc in HSL, because a
   straight sRGB crossfade dips through grey between two saturated hues (red → cyan goes
   through dishwater). ~0.4s time constant: a state change settles in about a second. */
function hslOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
  const l = (mx + mn) / 2;
  // HSL saturation, NOT the HSV one: d/(1-|2l-1|). Using d/mx here washes every colour out
  // ~30% when it is round-tripped (a saturated red came back as dusty pink).
  const den = 1 - Math.abs(2 * l - 1);
  return { h: h * 60, s: den > 1e-6 ? Math.min(1, d / den) : 0, l };
}
function hexOfHsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return '#' + rgb.map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
/* A finite, eased tween instead of an exponential chase: exponential starts at full speed and
   never quite arrives (a saturated red would still be a few degrees off a second later), which
   reads as drift rather than motion. Cubic in-out over LIVE_T both starts and stops at rest. */
const LIVE = { h: 0, s: 0, l: 0, fromH: 0, fromS: 0, fromL: 0, toH: 0, toS: 0, toL: 0,
               t0: -1, hex: '', target: '', ready: false };
const LIVE_T = 1150;                       // ms for a full colour swap

function tickLive() {
  const now = performance.now();
  const target = liveColor();
  if (target !== LIVE.target) {
    const c = hslOf(target);
    LIVE.target = target;
    if (!LIVE.ready) {
      LIVE.h = c.h; LIVE.s = c.s; LIVE.l = c.l; LIVE.ready = true;
    }
    let dh = c.h - LIVE.h;
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;   // travel the short way round the wheel
    LIVE.fromH = LIVE.h; LIVE.fromS = LIVE.s; LIVE.fromL = LIVE.l;
    LIVE.toH = LIVE.h + dh; LIVE.toS = c.s; LIVE.toL = c.l;
    LIVE.t0 = now;
  }
  if (!LIVE.ready) return;
  const p = Math.min(1, (now - LIVE.t0) / LIVE_T);
  const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  LIVE.h = LIVE.fromH + (LIVE.toH - LIVE.fromH) * e;
  LIVE.s = LIVE.fromS + (LIVE.toS - LIVE.fromS) * e;
  LIVE.l = LIVE.fromL + (LIVE.toL - LIVE.fromL) * e;
  const hex = hexOfHsl(LIVE.h, LIVE.s, LIVE.l);
  if (hex !== LIVE.hex) {
    LIVE.hex = hex;
    const card = $('#now');
    if (card) { card.style.setProperty('--live', hex); card.style.setProperty('--live-a', hex + '48'); }
  }
}
function liveNow() { return LIVE.hex || liveColor(); }

function updateNow() {
  const st = $('#now-state'), sub = $('#now-sub'), stats = $('#now-stats');
  const card = $('#now');
  if (card && !LIVE.ready) {                          // tickLive() owns the variable once running
    const lc = liveColor();
    card.style.setProperty('--live', lc);
    card.style.setProperty('--live-a', lc + '48');
  }
  st.className = 'nstate ' + (brain.state === 'think' ? 'think' : brain.state === 'act' ? 'act' : 'idle');
  if (brain.state === 'act') st.innerHTML = `acting<span class="cur">▌</span>`;
  else if (brain.state === 'think') st.innerHTML = `thinking<span class="cur">▌</span>`;
  else st.textContent = 'idle';

  if (brain.state === 'act' && lastAct)
    sub.textContent = `${prettyTool(lastAct.tool)} · ${lastAct.dur}s · ${lastAct.chars.toLocaleString()} chars out`;
  else if (brain.state === 'think' && lastThink)
    sub.textContent = `call #${lastThink.n} · ${lastThink.tout} tokens out · ${lastThink.latency}s · cache ${lastThink.cache}%`;
  else if (brain.state === 'idle') sub.textContent = 'waiting for input';
  else sub.textContent = prettyTool(brain.label);

  stats.innerHTML = [
    brain.session ? `<span><b>session</b> ${esc(brain.session.slice(0, 18))}</span>` : '',
    brain.model ? `<span><b>model</b> ${esc(brain.model)}</span>` : '',
    mne && mne.total ? `<span><b>mnemosyne</b> ${mne.total.toLocaleString()}</span>` : ''
  ].filter(Boolean).join('');
}

/* ---------------- pulses ---------------- */
function firePulses(evs) {
  const now = performance.now();
  for (const e of evs) {
    if (e.kind === 'think') {
      const prevStep = Math.min(5, Math.max(1, thCursor || 1));
      thCursor = thCursor >= 5 ? 1 : thCursor + 1;
      lastThink = { n: e.n, tin: e.tin, tout: e.tout, latency: e.latency, cache: e.cache };
      orbImpulse('think', C.violet, Math.min(1, (e.tout || 0) / 1500));
      if (thCursor > prevStep) firePath(['th:' + prevStep, 'th:' + thCursor], C.gold, '#' + e.n, now);
      if (thCursor === 2) {
        // recall is a query over ONE hybrid index: light the tiers that hold recent
        // material, so the memory column is crossed through its real nodes, not the memo
        const tiers = (mne && mne.tiers ? mne.tiers : []).filter(t => (t.count || 0) > 0);
        for (const t of tiers.slice(0, 5)) {
          if (neuronById['mem:' + t.id]) firePath(['mem:' + t.id, 'th:2'], C.gold, 'recall', now);
        }
      }
    } else if (e.kind === 'act') {
      lastAct = { tool: e.tool, dur: e.dur, chars: e.chars };
      if (/execute_code/.test(e.tool || '')) {
        const ch = e.chars >= 1000 ? (e.chars / 1000).toFixed(1) + 'k' : e.chars;
        flashNode('tool:code', { value: (+e.dur).toFixed(2) + 's · ' + ch + 'ch',
                                 valueShort: ch + 'ch', desc: 'code ran' });
      }
      if (/playwright|browser_|browser_exec|web_search|web_extract/.test(e.tool || '')) {
        const what = (String(e.tool).match(/browser_(\w+)/) || [, /web_search/.test(e.tool) ? 'search' : 'read'])[1].replace(/_/g, ' ');
        flashNode('tool:web', { value: what, desc: 'on the internet' });
      }
      orbImpulse('act', TOOL_COLOR[toolNeuron(e.tool)] || C.blue, Math.min(1, (e.dur || 0) / 3));
      setTimeout(fetchTools, 6000);                                    // tool ranking drifts slowly
      setTimeout(fetchPeek, 900);                                      // what was just written

      setTimeout(fetchDelegates, 400);                                 // a subagent may have moved
      lastToolId = toolNeuron(e.tool);
      LAST_ACT[lastToolId] = Date.now();
      const wrote = lastToolId === 'tool:write' || lastToolId === 'tool:code'
                 || /screenshot|browser_(pdf|download)/.test(e.tool || '');
      firePath(['th:4', lastToolId], TOOL_COLOR[lastToolId] || C.blue, shortTool(e.tool), now);
      // the result comes back and is read: this is the only right-to-left motion in the graph
      const tid = lastToolId, tnow = now;
      patchNode('th:5', { value: fTok(e.chars), desc: 'result read' });
      setTimeout(() => {
        firePath([tid, 'th:5'], C.violet, 'result back', tnow + 240);
        if (wrote) firePath([tid, 'out:artifact'], C.blue, 'file Δ', tnow + 240);
      }, 240);
      // the result does not stop at compose: it is the material of the answer, so one packet
      // keeps moving toward the reply for every tool call, not only when the turn ends
      setTimeout(() => {
        const c6 = neuronById['th:6'];
        if (c6) c6.act = Math.max(c6.act, 0.3);   // the result reached compose: it is composing
        sparkReply(tnow + 460, 1.5);
      }, 460);
    } else if (e.kind === 'stream') {
      // the reply text is leaving in batches, but the turn is still running: compose is
      // writing, and the reply node has NOT received anything yet
      if (neuronById['th:6']) {
        patchNode('th:6', { act: Math.min(1, 0.35 + (e.chars || 0) / 2200) });
        neuronById['th:6'].spin = true;
      }
      // the text is leaving for Discord as it is written, so the reply node sits on that path
      // and takes a hit for every batch — not only for the final delivery
      if (neuronById['out:reply']) {
        const rn = neuronById['out:reply'];
        patchNode('out:reply', { act: Math.max(0.65, (rn.act || 0) * 0.75),
                                 value: fTok(e.chars), desc: 'sending batch' });
        firePath(['th:6', 'out:reply'], C.green, 'sending', now);
      }
    } else if (e.kind === 'deliver') {
      // gateway "response ready": the message actually reached Discord. This is the only
      // thing that may light the reply node, because it is the only thing that is delivery.
      if (neuronById['out:reply'])
        patchNode('out:reply', { act: 1, value: (e.chars || 0).toLocaleString() + 'ch',
                                 desc: 'sent to ' + (e.platform || 'discord') });
      orbImpulse('speak', C.green, 0.3);
      firePath(['th:6', 'out:reply'], C.green, 'delivered', now);
      if (lastToolId) setTimeout(() => patchNode(lastToolId, { act: 0.2 }), 0);
      brain.state = 'idle';
      brain.label = 'idle';
    } else if (e.kind === 'end') {
      brain.state = 'idle';
      brain.label = 'idle';
    } else if (e.kind === 'in') {
      orbImpulse('in', C.teal, 0.15);
      const t = classifyTask(e.msg); if (t) TURN.task = t;
      // the prompt arrives from Discord, not from memory: light the two things that are
      // already in context (memo file) and the parse step, with the real edge between them
      firePath(['in:memory', 'th:1'], C.teal, 'prompt', now);
    }
  }
}
/* A via wire is a polyline, and a packet must travel it by DISTANCE: indexing corners makes
   the packet crawl through 8px chamfers and bolt through 170px runs — that read as a glitch. */
function viaPoly(a, b) {
  const vid = VIA[a.id + '>' + b.id];
  if (!vid) return null;
  const ep = edgePath(a, b);
  if (!ep || ep._joinLen == null) return null;
  const n = ep.pts.length - 1;
  const pts = ep.pts.map((q, i) => ({ id: i === 0 ? a.id : i === n ? b.id : null,
    x: q[0], y: q[1], layer: a.layer, hw: 0, hh: 0, tint: VIA_COLOR }));
  return { pts, cum: ep.cum.slice(), len: ep.len };
}
/* position on a packet's own polyline, by arc length */
function pulseAt(p, t) {
  const { cum, len } = p.poly;
  const d = Math.max(0, Math.min(1, t)) * len;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = cum[i - 1], b = cum[i], k = b > a ? (d - a) / (b - a) : 0;
  const p0 = p.pts[i - 1], p1 = p.pts[i];
  return { x: p0.x + (p1.x - p0.x) * k, y: p0.y + (p1.y - p0.y) * k, seg: i - 1 };
}

/* a packet remembers the node it left: tint travels with the point */
const ptOf = n => ({ id: n.id, x: n.x, y: n.y, layer: n.layer, hw: n.hw, hh: n.hh,
                     tint: (n.layer === 1 || n.layer === 2) && n.accent !== 'rainbow' ? (n.accent || null) : null });
function firePath(ids, color, label, now, n = 3) {
  const ns = ids.map(id => neuronById[id]).filter(Boolean);
  if (ns.length < 2) return;
  ns.forEach(n => n.glowT = 1);
  for (let i = 0; i < ns.length - 1; i++) {
    const w = edgeOf(ns[i].id, ns[i + 1].id);
    if (w) hotEdges.set(w, now + FADE_MS);   // light stays 3s, then eases out
  }
  let pts = ns.map(ptOf), poly = null, mark = null;
  if (ns.length === 2) {
    const vp = viaPoly(ns[0], ns[1]);
    if (vp) {
      pts = vp.pts; poly = { cum: vp.cum, len: vp.len };
      /* The line only *appears* to pass through the terminal: the node it is routed via has to
         react, or the wire ghosts across it. Find the arc-length where the polyline is closest
         to that chip and light it as each packet crosses. */
      const vid = VIA[ns[0].id + '>' + ns[1].id];
      const tn = neuronById[vid];
      if (tn) {
        let best = 0, bd = Infinity;
        vp.pts.forEach((q, i) => {
          const dd = Math.hypot(q.x - tn.x, q.y - tn.y);
          if (dd < bd) { bd = dd; best = i; }
        });
        mark = { d: vp.cum[best], id: vid };
      }
    }
  }
  const T = performance.now();
  // one packet reads as a dot; three, spaced 170ms apart, read as a stream
  for (let k = 0; k < n; k++)
    pulses.push({ pts, poly, mark, t: 0, speed: 0.022, color, label: k ? '' : label, d0: T + k * 170 });
}

/* ---------------- pulse queue: one path at a time, never a light show ---------------- */
let pending = [], draining = false;
function enqueue(evs) { pending.push(...evs); drain(); }
function drain() {
  if (draining || !pending.length) return;
  draining = true;
  firePulses([pending.shift()]);
  setTimeout(() => { draining = false; drain(); }, 620);
}

/* ---------------- polling ---------------- */
const SEEN = new Set();
const keyOf = e => `${e.ts}|${e.kind}|${e.n ?? ''}|${e.tool ?? ''}|${e.chars ?? ''}`;
let primed = false;

async function pollLive() {
  if (DEMO_ON) return;   // the walk owns the graph while it plays
  try {
    const d = await (await fetch('/api/live')).json();
    const evs = d.events || [];
    applyLive(d);
    updateNow();
    paintMobile();
    if (!primed) { evs.forEach(e => SEEN.add(keyOf(e))); primed = true; return; }
    const fresh = [];
    for (const e of evs) { const k = keyOf(e); if (!SEEN.has(k)) { SEEN.add(k); fresh.push(e); } }
    if (fresh.length) {
      renderTicker(evs.slice(-4).reverse());
      enqueue(fresh.filter(e => FLOW_KINDS.includes(e.kind)));
    }
  } catch { $('#now-sub').textContent = 'offline — is the server running?'; }
}

async function fetchSessions() { try { return await (await fetch('/api/sessions')).json(); } catch { return []; } }

/* ---------------- drawer ---------------- */
function drawer(title, html) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').innerHTML = html;
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('on');
  $('#drawer-body').scrollTop = 0;
}

function closeDrawer() {
  const d = $('#drawer');
  d.classList.remove('open');
  d.style.transform = '';
  $('#scrim').classList.remove('on');
}

$('#drawer-close').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

/* swipe the sheet down to dismiss — the gesture everyone tries first on a phone */
(() => {
  const d = $('#drawer');
  let y0 = 0, dy = 0, dragging = false;
  d.addEventListener('touchstart', e => {
    if (!matchMedia('(max-width:760px)').matches) return;
    if ($('#drawer-body').scrollTop > 0) return;
    y0 = e.touches[0].clientY; dy = 0; dragging = true;
    d.style.transition = 'none';
  }, { passive: true });

  d.addEventListener('touchmove', e => {
    if (!dragging) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    d.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    d.style.transition = '';
    if (dy > 84) closeDrawer();
    else d.style.transform = '';
    dy = 0;
  };
  d.addEventListener('touchend', end);
  d.addEventListener('touchcancel', end);
})();

async function openSession(s) {
  drawer(s.name || s.id, '<div class="empty">loading thought chain…</div>');
  const d = await (await fetch('/api/session?id=' + encodeURIComponent(s.id))).json();
  const kl = { user: 'you', reason: 'reasoning', toolcall: 'tool call', result: 'result', reply: 'hermes' };
  const html = d.messages.map(m => {
    if (m.kind === 'toolcall')
      return `<div class="node toolcall"><span class="k">tool call</span><span class="tm">${hhmmss(m.ts)}</span>` +
        m.tools.map(t => `<div class="tn">→ ${esc(t.name)}</div><div class="a">${esc(t.args)}</div>`).join('') + '</div>';
    return `<div class="node ${esc(m.kind)}"><span class="k">${kl[m.kind] || esc(m.kind)}</span><span class="tm">${hhmmss(m.ts)}</span><div class="b">${esc(m.text)}</div></div>`;
  }).join('') || '<div class="empty">no messages</div>';
  drawer(s.name || s.id, html);
}

async function wireClicks() {
  const mb = document.getElementById('menu-btn');
  if (mb) mb.onclick = openMenu;
  const ss = await fetchSessions();
  const by = src => (ss || []).find(s => s.source === src && !s.error);
  const set = (id, sess) => { const n = neuronById[id];
    if (n) n.click = sess ? () => openSession(sess) : () => drawer(id, '<div class="empty">no session yet</div>'); };
  const discord = by('discord');
  set('in:discord', discord);
  set('in:webhook', by('webhook')); set('in:cron', by('cron'));
  const openMem = async () => {
    drawer('memory', '<div class="empty">loading…</div>');
    const d = await (await fetch('/api/memory')).json();
    drawer('memory — MEMORY.md', `<pre>${esc((d.memory || '').slice(0, 8000))}</pre><h2 style="margin-top:16px">USER.md</h2><pre>${esc((d.user || '').slice(0, 4000))}</pre>`);
  };
  neuronById['in:memory'].click = openMem;
  neuronById['tool:memory'].click = () => openMnemo('working');
  neuronById['tool:delegate'].click = openDelegates;
  const nu = $('#now-usage'); if (nu) nu.onclick = openUsage;
  const nh = $('#now-health'); if (nh) nh.onclick = openHealth;
  const ow = document.querySelector('.orbwrap'); if (ow) ow.onclick = () => toggleOrbFocus();
  const of = document.getElementById('orbFocus'); if (of) of.onclick = () => toggleOrbFocus(false);
  addEventListener('keydown', e => { if (e.key === 'Escape' && ORB.focus) toggleOrbFocus(false); });
  // mnemosyne layer — click a tier to read its most recent entries
  for (const tier of ['working', 'episodic', 'facts', 'canonical', 'graph']) {
    const n = neuronById['mem:' + tier];
    if (n) n.click = () => openMnemo(tier);
  }
  // every remaining neuron explains itself on tap
  for (const nr of NEURONS) if (!nr.click) nr.click = () => openInfo(neuronById[nr.id] || nr);
  for (const nr of NEURONS) CLICKS[nr.id] = nr.click;   // survive relayout()
}

/* ---------------- labels + the delegate drawer ---------------- */
/* Subagents: what was asked, how many tasks finished, how long it ran. */
async function openDelegates() {
  drawer('subagents', '<div class="empty">loading delegations…</div>');
  let d = null;
  try { d = await (await fetch('/api/delegations?limit=12')).json(); } catch {}
  if (!d || d.error) { drawer('subagents', '<div class="empty">no delegation data</div>'); return; }
  const rows = (d.recent || []).map(x => `
    <div class="node"><span class="k">${esc(x.state)}</span><span class="tm">${x.elapsed.toFixed(0)}s</span>
      <div class="b">${esc(x.goal || '(no goal recorded)')}</div>
      <div class="tn">${x.done}/${x.tasks} tasks · ${x.id}</div>
    </div>`).join('');
  drawer('subagents', `<div class="exp-row"><span>running now</span><b>${d.running}</b></div>
    <div class="exp-row"><span>finished · 7d</span><b>${d.done7}</b></div>` +
    (rows || '<div class="empty">no delegations yet</div>'));
}

/* ---------------- health: errors, delivery, cron ---------------- */
let HEALTH = null;

async function fetchHealth() {
  try { const d = await (await fetch('/api/health')).json(); if (d && d.errors) HEALTH = d; } catch {}
  return HEALTH;
}

function paintHealth() {
  const el = $('#now-health');
  if (!el || !HEALTH) return;
  const e = HEALTH.errors || {}, del = HEALTH.delivery || {};
  const pct = e.today ? Math.round(((e.warnings || 0) / Math.max(1, e.today)) * 0) : 0;
  el.innerHTML =
    `<span class="c red"><b>${e.today ?? '—'}</b> err</span>` +
    `<span class="c gold"><b>${e.warnings ?? '—'}</b> warn</span>` +
    (del.failed ? `<span class="c red"><b>${del.failed}</b> delivery</span>` : '');
  el.title = 'click for errors + cron board';
}

async function openHealth() {
  drawer('health', '<div class="empty">reading logs…</div>');
  await fetchHealth();
  if (!HEALTH) { drawer('health', '<div class="empty">no health data</div>'); return; }
  const e = HEALTH.errors || {}, del = HEALTH.delivery || {};
  const errs = (e.top || []).map(x =>
    `<div class="node"><span class="k">${esc((x.level || '').toLowerCase())}</span><span class="tm">${x.n}×</span>
       <div class="b">${esc(x.text)}</div></div>`).join('');
  const crons = (HEALTH.cron || []).map(c =>
    `<div class="exp-row"><span>${esc(c.name)}</span><b>${c.enabled ? esc(c.expr || c.kind) : 'off'}</b></div>`).join('');
  drawer('health',
    `<div class="exp-row"><span>errors today</span><b>${e.today ?? 0}</b></div>
     <div class="exp-row"><span>warnings today</span><b>${e.warnings ?? 0}</b></div>
     <div class="exp-row"><span>delivery failed</span><b>${del.failed ?? 0}</b></div>` +
    (errs || '<div class="empty">no errors</div>') +
    `<h3 class="exp-h">cron</h3>` + (crons || '<div class="empty">no jobs</div>'));
}

/* ---------------- usage: tokens, never money ---------------- */
async function openUsage() {
  drawer('tokens', '<div class="empty">loading usage…</div>');
  let d = null;
  try { d = await (await fetch('/api/usage')).json(); } catch {}
  if (!d) { drawer('tokens', '<div class="empty">no usage data</div>'); return; }
  const row = (k, v) => `<div class="exp-row"><span>${k}</span><b>${v}</b></div>`;
  const fmt = n => (n == null ? '—' : Number(n).toLocaleString());
  drawer('tokens',
    row('today in', fmt(d.today_in)) + row('today out', fmt(d.today_out)) +
    row('7d in', fmt(d.week_in)) + row('7d out', fmt(d.week_out)) +
    row('cache hit', (d.cache_hit_pct ?? '—') + '%') +
    row('calls today', fmt(d.calls_today)));
}

/* ---------- explanation drawers ---------- */
function openInfo(nr) {
  if (nr.id === 'tool:code') return openCode();
  if (nr.id === 'tool:delegate') return openDelegates();
  const L = LAYERS[nr.layer];
  const traffic = nr.id.startsWith('tool:') ? toolTraffic(nr.id) : null;
  const tier = nr.id.startsWith('mem:') ? (mne?.tiers || []).find(t => t.id === nr.id.split(':')[1]) : null;
  const html = `
    <div class="exp"><div class="exp-desc">${esc(nr.desc || '—')}</div>
      ${nr.value ? `<div class="exp-row"><span>live now</span><b>${esc(nr.value)}</b></div>` : ''}
      <div class="exp-row"><span>column</span><b>${esc(L.label)} — ${esc(L.sub)}</b></div>
      ${traffic != null ? `<div class="exp-row"><span>calls seen</span><b>${traffic.toLocaleString()}</b></div>` : ''}
      ${tier ? `<div class="exp-row"><span>stored</span><b>${tier.count.toLocaleString()} entries · ${tier.recent24h || 0} new in 24h</b></div>` : ''}
      <div class="exp-row"><span>activation now</span><b>${(nr.act || 0).toFixed(2)}</b></div>
      <div class="exp-note">${esc(L.desc)}</div>
    </div>`;
  drawer(nr.label, html);
}

/* One door for the phone. Every drawer on this page is reachable from here, in text, with a
   44px row — including the four phase columns and all 23 nodes, so nothing is discoverable
   only by hitting a 34px chip with a fingertip. */
function openMenu() {
  const row = (txt, sub, col, act) =>
    `<button class="mrow" data-act="${act}"><i class="msw" style="background:${col}"></i>` +
    `<span>${esc(txt)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
  let h = '<div class="mtitle">live data</div>';
  h += row('tokens & cost', 'usage', C.blue, 'usage');
  h += row('errors & cron', 'health', C.red, 'health');
  h += row('subagents', 'delegations', C.mint, 'deleg');
  h += row('memory files', 'MEMORY.md', C.gold, 'mem');
  h += row('mnemosyne', 'memory tiers', C.teal, 'mnemo');
  h += '<div class="mtitle">phases</div>';
  LAYERS.forEach((L, i) => { h += row(L.label, L.nodes.length + ' nodes', PHASES[i].color, 'col' + i); });
  h += '<div class="mtitle">nodes</div>';
  LAYERS.forEach((L, i) => {
    L.nodes.forEach(nd => { h += row(nd.label, nd.desc || '', PHASES[i].color, 'n:' + nd.id); });
  });
  drawer('everything on this page', h);
  document.querySelectorAll('#drawer-body .mrow').forEach(b => {
    b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'usage') return openUsage();
      if (a === 'health') return openHealth();
      if (a === 'deleg') return openDelegates();
      if (a === 'mem') { const n = neuronById['in:memory']; return (n && n.click) ? n.click() : 0; }
      if (a === 'mnemo') return openMnemo('working');
      if (a.slice(0, 3) === 'col') return openColumn(parseInt(a.slice(3), 10));
      if (a.slice(0, 2) === 'n:') {
        const id = a.slice(2), n = neuronById[id];
        if (!n) return 0;
        return (n.click ? n.click : () => openInfo(n))();
      }
    };
  });
}

function openColumn(li) {
  const L = LAYERS[li];
  const rows = L.nodes.map(nd => `<div class="exp-row"><span>${esc(nd.label)}</span><b>${esc(nd.desc || '')}</b></div>`).join('');
  drawer(L.label, `<div class="exp"><div class="exp-desc">${esc(L.desc)}</div>${rows}</div>`);
}

/* A tier is full even when nothing was written today: show the size and the age, so
   "quiet" is not mistaken for "empty". */
/* Phone labels have ~40px each: cut the filler words before eliding. */
// the nodes that actually carry the work: the code sandbox, the recall fan-in and the
// result fan-in. Inlet count is not the test (code takes one wire) — importance is.
const HUB_IDS = new Set(['tool:code', 'th:2', 'th:5']);

const SHORT_M = { 'read result': 'result', 'call tool': 'call', 'memo file': 'memo',
                  'canonical': 'canon.', 'compose': 'draft' };   // 'draft' fits 7px on a 40px chip

/* A node's name is a caption, not a heading: it must read in full at any width.
   Fit by wrapping at the space, then by shrinking the type — never by cutting it
   (Khanh 23/10: "all the text on the node to be BOLD and full caption"). */
function nodeLabel(ctx, txt, maxW, startPx, minPx) {
  let size = startPx;
  for (;;) {
    ctx.font = '700 ' + size + 'px Montserrat';
    if (ctx.measureText(txt).width <= maxW) return { lines: [txt], size };
    const words = txt.split(' ');
    if (words.length > 1) {
      const mid = Math.ceil(words.length / 2);
      const a = words.slice(0, mid).join(' '), b = words.slice(mid).join(' ');
      if (ctx.measureText(a).width <= maxW && ctx.measureText(b).width <= maxW)
        return { lines: [a, b], size };
    }
    if (size <= minPx) return { lines: [txt], size };
    size = Math.max(minPx, size - 0.25);
  }
}

/* Keep a node name inside its share of the band: elide, never overlap. */
function fitText(ctx, txt, maxW) {
  if (ctx.measureText(txt).width <= maxW) return txt;
  let t = txt;
  while (t.length > 2 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function ageShort(iso) {
  if (!iso) return '—';
  const t = Date.parse(String(iso).replace(' ', 'T'));
  if (!t) return '—';
  const h = (Date.now() - t) / 3600000;
  return h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd';
}

/* ---------------- live peeks: the code being written, the subagent's actual task ---------------- */
let _peekAt = 0, _peekMiss = 0;

/* ---------------- thinking, in the status card ----------------
   The row lands complete, so this is a REVEAL, not a live token stream: the newest
   completed thought is drawn progressively and then left on screen while it is recent. */
async function fetchThink() {
  try {
    const d = await (await fetch('/api/think')).json();
    if (!d || typeof d.text !== 'string') return;
    if (d.text && (d.ts !== THINK.ts || d.text !== THINK.text)) {
      THINK.text = d.text;
      THINK.chars = d.chars || d.text.length;
      THINK.ts = d.ts || 0;
      THINK.start = performance.now();
      THINK.age = d.age;
    }
    THINK.seen = performance.now();
    paintThink();
  } catch (_) {}
}

function paintThink() {
  const box = document.getElementById('now-think');
  if (!box) return;
  const busy = brain.state !== 'idle';
  const fresh = THINK.text && (busy || (THINK.age != null && THINK.age < 420));
  if (!fresh) {
    if (!box.hidden) { box.hidden = true; box.textContent = ''; relayoutCard(); }
    return;
  }
  const now = performance.now();
  const dur = Math.max(280, Math.min(1100, THINK.text.length * 3.2));
  const k = Math.min(1, (now - THINK.start) / dur);
  const shown = THINK.text.slice(0, Math.ceil(THINK.text.length * k));
  // keep the newest words visible: a 700-char thought cannot fit in three lines
  const tail = shown.length > (MOBILE ? 900 : 1600) ? shown.slice(MOBILE ? -900 : -1600) : shown;
  const html = escapeHtml(tail) + (k < 1 ? '<span class="caret">▍</span>' : '');
  if (html !== THINK.shown) {
    THINK.shown = html;
    const wasHidden = box.hidden;
    box.innerHTML = html;
    box.hidden = false;
    box.scrollTop = box.scrollHeight;
    if (wasHidden) relayoutCard();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
}

async function fetchPeek() {
  try {
    const d = await (await fetch('/api/peek')).json();
    // an empty scan must not wipe the last good sample, or the card flickers away
    if (!d.code && !d.file && PEEK && (PEEK.code || PEEK.file)) {
      PEEK = { ...PEEK, deleg: d.deleg || PEEK.deleg };
    } else PEEK = d;
    _peekAt = Date.now();
    const c = PEEK.code || PEEK.file;
    const sig = c ? [c.tool, c.chars, (c.lines || []).slice(-1)[0] || ''].join('|') : '';
    if (sig && _peekSig && sig !== _peekSig) _peekAnim = Date.now();
    _peekSig = sig || _peekSig;
    // a scan can land between two tool calls: try again shortly, but never in a loop
    if (!d.code && !d.file && _peekMiss++ < 3) setTimeout(fetchPeek, 1800);
    else _peekMiss = 0;
  } catch {}
}

function wrapText(c, txt, maxW, maxLines) {
  const words = String(txt || '').split(/\s+/).filter(Boolean);
  const out = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (c.measureText(t).width > maxW && line) { out.push(line); line = w; if (out.length === maxLines - 1) break; }
    else line = t;
  }
  if (line && out.length < maxLines) out.push(line);
  return out;
}

/* perimeter helpers: the only way to animate the bevel of a rounded rectangle */
/* A point a given distance along a rounded rectangle's outline (clockwise from just after
   the top-left corner). Constant arc length is what keeps the comet from racing on the
   straight runs and crawling through the corners. */
function rrPoint(x, y, w, h, r, d) {
  const Lh = Math.max(0.01, w - 2 * r), Lv = Math.max(0.01, h - 2 * r), A = (Math.PI / 2) * r;
  const P = 2 * Lh + 2 * Lv + 4 * A;
  d = ((d % P) + P) % P;
  if (d < Lh) return { x: x + r + d, y };
  d -= Lh;
  if (d < A) { const t = d / A * Math.PI / 2 - Math.PI / 2;
    return { x: x + w - r + Math.cos(t) * r, y: y + r + Math.sin(t) * r }; }
  d -= A;
  if (d < Lv) return { x: x + w, y: y + r + d };
  d -= Lv;
  if (d < A) { const t = d / A * Math.PI / 2;
    return { x: x + w - r + Math.cos(t) * r, y: y + h - r + Math.sin(t) * r }; }
  d -= A;
  if (d < Lh) return { x: x + w - r - d, y: y + h };
  d -= Lh;
  if (d < A) { const t = d / A * Math.PI / 2 + Math.PI / 2;
    return { x: x + r + Math.cos(t) * r, y: y + h - r + Math.sin(t) * r }; }
  d -= A;
  if (d < Lv) return { x, y: y + h - r - d };
  d -= Lv;
  const t = d / A * Math.PI / 2 + Math.PI;
  return { x: x + r + Math.cos(t) * r, y: y + r + Math.sin(t) * r };
}

/* The comet: a bright head, a tail that both thins and fades, and a small bloom behind the
   head. Drawn as short strokes rather than one dashed path so the taper is continuous. */
function bevelComet(ctx, x, y, w, h, r, head, tail, col, aMax, wMax) {
  const P = perim(w, h, r);
  const n = Math.max(6, Math.round(tail / 2.2));
  ctx.lineCap = 'round';
  let prev = rrPoint(x, y, w, h, r, head);
  for (let i = 1; i <= n; i++) {
    const k = 1 - i / n;                       // 1 at the head, 0 at the tip of the tail
    const q = rrPoint(x, y, w, h, r, head - tail * (i / n) + P * 4);
    ctx.strokeStyle = rgba(col, aMax * Math.pow(k, 1.7));
    ctx.lineWidth = 0.7 + (wMax - 0.7) * k;
    ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    prev = q;
  }
  const hp = rrPoint(x, y, w, h, r, head);
  const gr = ctx.createRadialGradient(hp.x, hp.y, 0, hp.x, hp.y, 7);
  gr.addColorStop(0, rgba(col, aMax * 0.55));
  gr.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(hp.x, hp.y, 7, 0, 7); ctx.fill();
}

function rrPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r);
  c.closePath();
}
const perim = (w, h, r) => 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;

/* A callout sits in the gutter beside a node: the node says "code", this says which code. */
/* The card sits in the gutter to the right of its chip. Two things bound it: the next
   column's chips, and the leap corridor that now hugs the output column. */
function calloutBox(nr) {
  const nx = COLX[nr.layer + 1] ? COLX[nr.layer + 1].x : nr.x + 200;
  const x = nr.x + nr.hw + 8;
  let maxR = nx - nr.hw - 12;
  if (nr.layer === 2 && COLX[3]) maxR = Math.min(maxR, COLX[2].x + (COLX[3].x - COLX[2].x) * 0.78 - 9);
  return { x, nx, w: Math.max(100, Math.min(150, maxR - x)) };
}

function drawCallout(nr, head, lines, color, alpha, caret, align) {
  if (!nr || !lines || !lines.length || alpha < 0.04) return;
  if (MOBILE) return drawCalloutMobile(nr, head, lines, color, alpha, caret);
  const { x, w } = calloutBox(nr);
  const lh = 9, pad = 6;
  const h = pad * 2 + 10 + lines.length * lh;
  // 'up' clears the subagent lane to the left; 'down' parks the card beside the lower half
  // of its chip, where the gutter is empty instead of stacking under the caption above
  let y = align === 'up' ? nr.y - nr.hh - h - 7
        : align === 'down' ? nr.y - nr.hh + 6
        : nr.y - h / 2;
  y = Math.max(76, Math.min(innerHeight - h - 44, y));

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fillStyle = 'rgba(7,10,17,.92)'; ctx.fill();
  ctx.strokeStyle = rgba(color, .34); ctx.lineWidth = 1; ctx.stroke();
  // connector from the node to its card
  ctx.beginPath();
  if (align === 'up') { ctx.moveTo(nr.x + nr.hw * 0.45, nr.y - nr.hh); ctx.lineTo(x, y + h); }
  else if (align === 'down') { ctx.moveTo(nr.x + nr.hw, nr.y); ctx.lineTo(x, Math.max(y + 6, Math.min(y + h - 6, nr.y))); }
  else { ctx.moveTo(nr.x + nr.hw, nr.y); ctx.lineTo(x, nr.y); }
  ctx.strokeStyle = rgba(color, .45); ctx.stroke();

  ctx.font = '600 6.5px Montserrat'; ctx.textAlign = 'left';
  ctx.fillStyle = rgba(color, .95);
  ctx.fillText(fitText(ctx, head.toUpperCase(), w - pad * 2), x + pad, y + pad + 5);

  ctx.font = '400 7px ui-monospace, Consolas, monospace';
  ctx.fillStyle = 'rgba(222,230,244,.78)';
  lines.forEach((ln, i) => {
    const txt = fitText(ctx, String(ln).replace(/\t/g, '  ').replace(/\s+$/, ''), w - pad * 2);
    ctx.fillText(txt, x + pad, y + pad + 13 + i * lh);
    // the caret follows the reveal, so the card reads as being written
    if (caret && i === lines.length - 1) {
      const cx = x + pad + ctx.measureText(txt).width + 2;
      ctx.fillStyle = rgba(color, .85);
      ctx.fillRect(cx, y + pad + 5 + i * lh, 4, 8);
    }
  });
  ctx.restore();
}

/* On a phone there is no gutter, so the card has to find a hole in the picture. Above and
   below a chip the wire enters and leaves through the port, so the old placement always
   ran a real line straight through the card. Candidates are now scored against the wires
   and the neighbouring chips, and a small cache keeps the search off the frame budget. */
const _SPOT = new Map();

function wireHits(x, y, w, h) {
  const x0 = x + 2, x1 = x + w - 2, y0 = y + 2, y1 = y + h - 2;
  let hits = 0;
  for (const wgt of WEIGHTS) {
    const a = neuronById[wgt.from], b = neuronById[wgt.to];
    if (!a || !b) continue;
    const ep = edgePath(a, b);
    const n = Math.max(8, Math.round(ep.len / 7));
    for (let k = 0; k <= n; k++) {
      const p = onPath(ep, k / n);
      if (p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1) { hits++; break; }
    }
  }
  return hits;
}

function chipHits(x, y, w, h, skip) {
  let hits = 0;
  for (const c of NEURONS) {
    if (c === skip) continue;
    if (Math.abs(c.x - (x + w / 2)) < c.hw + w / 2 - 1 &&
        Math.abs(c.y - (y + h / 2)) < c.hh + h / 2 - 1) hits++;
  }
  return hits;
}

/* the best empty rectangle for a card of this size, near this chip */
function calloutSpot(nr, w, h) {
  const key = nr.id + '|' + LAYOUT_EPOCH + '|' + Math.round(w) + '|' + Math.round(h);
  const hit = _SPOT.get(key);
  if (hit) return hit;
  const g = 7;
  const tkTop = (document.getElementById('ticker')?.getBoundingClientRect().top) || innerHeight - 40;
  const cands = [
    // the strip under the last band is the only place on a phone with no wiring in it:
    // a card docked there can never cut a line, and the slack is already empty
    { x: nr.x - w / 2, y: tkTop - h - 10, side: 'dock' },
    { x: nr.x + nr.hw + g, y: tkTop - h - 10, side: 'dock' },
    { x: nr.x - nr.hw - g - w, y: tkTop - h - 10, side: 'dock' },
    { x: nr.x - w / 2, y: nr.y + nr.hh + g, side: 'below' },
    { x: nr.x - w / 2, y: nr.y - nr.hh - h - g, side: 'above' },
    { x: nr.x + nr.hw + g, y: nr.y - h / 2, side: 'right' },
    { x: nr.x - nr.hw - g - w, y: nr.y - h / 2, side: 'left' },
    { x: nr.x + nr.hw + g, y: nr.y - nr.hh - h - g, side: 'right' },
    { x: nr.x - nr.hw - g - w, y: nr.y - nr.hh - h - g, side: 'left' },
  ];
  let best = null;
  for (const c of cands) {
    const x = Math.max(8, Math.min(innerWidth - w - 8, c.x));
    const y = Math.max(8, Math.min(tkTop - h - 8, c.y));
    // a card on top of a chip is always wrong; a wire through it is bad but survivable
    // a wire through the card is the defect he reported, so it costs more than distance;
    // a chip under it is disqualifying; docking in the empty strip is preferred outright
    const score = chipHits(x, y, w, h, nr) * 60 + wireHits(x, y, w, h) * 18
                + (c.side === 'dock' ? 0 : 6)
                + Math.abs(x + w / 2 - nr.x) / innerWidth;
    if (!best || score < best.score) best = { x, y, side: c.side, score };
  }
  if (_SPOT.size > 60) _SPOT.clear();
  _SPOT.set(key, best);
  return best;
}

function drawCalloutMobile(nr, head, lines, color, alpha, caret, prefer) {
  const lh = 7.5, pad = 4;
  let n = Math.min(lines.length, 3);
  const w = Math.min(innerWidth - 16, Math.max(112, nr.w * 3.6));
  const need = k => pad * 2 + 6 + k * lh;
  let h = need(n);
  // a three-line card is only worth it if three lines fit in a hole somewhere
  let spot = calloutSpot(nr, w, h);
  if (n > 1 && spot.score >= 40) { n = 2; h = need(n); spot = calloutSpot(nr, w, h); }
  if (n > 1 && spot.score >= 40) { n = 1; h = need(n); spot = calloutSpot(nr, w, h); }
  const { x, y } = spot;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 6);
  ctx.fillStyle = 'rgba(7,10,17,.94)'; ctx.fill();
  ctx.strokeStyle = rgba(color, .34); ctx.lineWidth = 1; ctx.stroke();
  // connector: shortest way out of the chip, never across the card face
  ctx.beginPath();
  if (spot.side === 'dock') {
    // down the chip's own x, then sideways along the strip: a clean L, never across a card
    const cx = Math.max(x + 6, Math.min(x + w - 6, nr.x));
    ctx.moveTo(nr.x, nr.y + nr.hh); ctx.lineTo(nr.x, y - 4); ctx.lineTo(cx, y - 4);
  }
  else if (spot.side === 'below') { ctx.moveTo(nr.x, nr.y + nr.hh); ctx.lineTo(nr.x, y); }
  else if (spot.side === 'above') { ctx.moveTo(nr.x, nr.y - nr.hh); ctx.lineTo(nr.x, y + h); }
  else if (spot.side === 'right') { ctx.moveTo(nr.x + nr.hw, nr.y); ctx.lineTo(x, Math.max(y + 4, Math.min(y + h - 4, nr.y))); }
  else { ctx.moveTo(nr.x - nr.hw, nr.y); ctx.lineTo(x + w, Math.max(y + 4, Math.min(y + h - 4, nr.y))); }
  ctx.strokeStyle = rgba(color, .45); ctx.stroke();

  ctx.font = '600 6px Montserrat'; ctx.textAlign = 'left';
  ctx.fillStyle = rgba(color, .95);
  ctx.fillText(fitText(ctx, head.toUpperCase(), w - pad * 2), x + pad, y + pad + 4.5);
  ctx.font = '400 6px ui-monospace, Consolas, monospace';
  ctx.fillStyle = 'rgba(222,230,244,.80)';
  lines.slice(0, n).forEach((ln, i) => {
    const txt = fitText(ctx, String(ln).replace(/\t/g, '  ').replace(/\s+$/, ''), w - pad * 2);
    ctx.fillText(txt, x + pad, y + pad + 11 + i * lh);
    if (caret && i === n - 1) {
      const cx = x + pad + ctx.measureText(txt).width + 2;
      ctx.fillStyle = rgba(color, .85);
      ctx.fillRect(cx, y + pad + 5 + i * lh, 3, 6);
    }
  });
  ctx.restore();
}

/* These cards are a task indicator, not decoration: no task, no card. */
const TASK_WINDOW = 20000;   // a tool call counts as "in progress" for 20s
function paintPeek() {
  if (!PEEK || !_peekAt) return;
  /* the card is part of its node, so it wears that node's colour instead of one global blue
     (Khanh 23/10): a code card is orange, a delegate card is the delegate blue */
  const accentOf = id => {
    const n = neuronById[id];
    return (n && n.accent && n.accent !== 'rainbow') ? n.accent : C.blue;
  };
  const t = Date.now();
  const code = neuronById['tool:code'], dele = neuronById['tool:delegate'];
  const dl = PEEK.deleg;

  const codeBusy = t - (LAST_ACT['tool:code'] || 0) < TASK_WINDOW
                || t - (LAST_ACT['tool:write'] || 0) < TASK_WINDOW;
  // a delegate row can stay 'running' after the child dies; ignore anything absurdly old
  const delegBusy = !!dl && ((dl.state === 'running' && dl.elapsed < 1800)
                        || t - (LAST_ACT['tool:delegate'] || 0) < TASK_WINDOW);

  // decide FIRST, draw second: on a phone the two cards share one band, 42px apart,
  // so the newer task wins and the other card is not drawn at all
  let showCode = codeBusy, showDeleg = delegBusy;
  if (MOBILE && showCode && showDeleg) {
    const ec = Math.max(LAST_ACT['tool:code'] || 0, LAST_ACT['tool:write'] || 0);
    const ed = (LAST_ACT['tool:delegate'] || 0) + (dl.state === 'running' ? 6000 : 0);
    if (ec > ed) showDeleg = false; else showCode = false;
  }

  /* Khanh 23/10: the card is a two-second notification, not a fixture — it holds, then
     fades over its last 650ms, timed from the moment the tool actually ran. */
  const PEEK_MS = 2000, PEEK_FADE = 650;
  const peekAlpha = t0 => {
    if (!t0) return 0;
    const age = t - t0;
    if (age < 0 || age > PEEK_MS) return 0;
    return 0.95 * Math.min(1, (PEEK_MS - age) / PEEK_FADE);
  };

  const pick = PEEK.code || PEEK.file;
  const codeA = peekAlpha(Math.max(LAST_ACT['tool:code'] || 0, LAST_ACT['tool:write'] || 0));
  if (showCode && pick && code && codeA > 0.04) {
    const head = pick.tool + ' · ' + (pick.chars >= 1000 ? (pick.chars / 1000).toFixed(1) + 'k' : pick.chars);
    const all = pick.lines || [];
    // three lines fit now that the card docks in the empty strip under the graph
    let lines = (MOBILE ? all.slice(-3) : all.slice(-4))
      .map((l, i) => i === 0 ? l.replace(/^…\s*/, '… ') : l);
    if (all.length > lines.length && !lines[0].startsWith('…')) lines[0] = '… ' + lines[0];
    let typing = false;
    if (_peekAnim) {
      const full = lines.join('\n');
      const ms = Math.max(420, Math.min(1100, full.length * 3));
      const prog = Math.min(1, (Date.now() - _peekAnim) / ms);
      if (prog >= 1) _peekAnim = 0;
      else { lines = full.slice(0, Math.floor(prog * full.length)).split('\n'); typing = true; }
    }
    drawCallout(code, head, lines, accentOf(toolNeuron(pick.tool) || 'tool:code'), codeA, typing);
  }

  const delegA = peekAlpha(LAST_ACT['tool:delegate'] || 0);
  if (showDeleg && dele && dl && delegA > 0.04) {
    ctx.save(); ctx.font = '400 7px Montserrat';
    const goal = wrapText(ctx, dl.goal, MOBILE ? 108 : Math.max(92, calloutBox(dele).w - 12), 2);
    ctx.restore();
    const head = 'subagent · ' + dl.done + '/' + dl.tasks + ' · ' + Math.round(dl.elapsed) + 's';
    drawCallout(dele, head, goal.slice(0, 2), accentOf('tool:delegate'), delegA, false, 'down');
  }
}

/* Which memory tier is actually carrying load? Log-scale the counts onto the
   memory→recall lines so the busiest tier reads brighter even when nothing is
   happening — otherwise every turn looks like it only ever opens the memo file. */
function biasMemory() {
  if (!mne || !mne.tiers) return;
  const tiers = mne.tiers.filter(t => (t.count || 0) > 0 && neuronById['mem:' + t.id]);
  if (!tiers.length) return;
  const max = Math.max(...tiers.map(t => Math.log10(1 + t.count)), 1);
  for (const t of tiers) {
    const e = edgeOf('mem:' + t.id, 'th:2');
    if (!e) continue;
    // corpus size sets the baseline (a tier with 29 rows really is a thin line);
    // being written to today is a small bonus, not a penalty for being quiet
    e.bias = 0.5 + 0.5 * (Math.log10(1 + t.count) / max) + (t.recent24h ? 0.08 : 0);
  }
  buildMesh();
}

async function fetchMnemo() {
  try {
    const d = await (await fetch('/api/mnemosyne')).json();
    if (d && d.tiers) {
      mne = d;
      for (const t of d.tiers) {
        const id = 'mem:' + t.id;
        const v = t.count.toLocaleString() + ' · ' + (t.recent24h ? t.recent24h + ' new' : ageShort(t.last));
        const def = LAYERS[0].nodes.find(n => n.id === id);   // layout() rebuilds from the def
        if (def) { def.value = v; def.valueShort = t.count.toLocaleString(); }
        const nr = neuronById[id];
        if (nr) nr.value = MOBILE ? t.count.toLocaleString() : v;
      }
      biasMemory();
      updateNow();
    }
  } catch {}
}

async function openCode() {
  drawer('code — what is being written', '<div class="empty">reading…</div>');
  await fetchPeek();
  const d = PEEK || {};
  const block = (it, label) => {
    if (!it) return '';
    const head = `${esc(label)} · ${it.tool} · ${it.chars.toLocaleString()} chars`
      + (it.more ? ` · …${it.more} earlier lines` : '');
    const body = (it.lines || []).map(l => esc(l)).join('\n');
    return `<div class="exp"><div class="exp-h">${head}</div>
      ${it.path ? `<div class="exp-note">${esc(it.path)}</div>` : ''}
      <pre class="code">${body}</pre></div>`;
  };
  const html = block(d.code, 'running python') + block(d.file, 'last file written')
    + (d.deleg ? `<div class="st">subagent · ${esc(d.deleg.state)} · ${d.deleg.done}/${d.deleg.tasks} tasks · ${Math.round(d.deleg.elapsed)}s</div>
        <div class="exp-desc">${esc(d.deleg.goal || '')}</div>` : '');
  drawer('code — what is being written', html || '<div class="empty">nothing written yet</div>');
}

async function openMnemo(tier) {
  drawer('mnemosyne — ' + tier, '<div class="empty">loading…</div>');
  const d = await (await fetch('/api/mnemosyne?tier=' + tier + '&limit=20')).json();
  const t = (d.tiers || []).find(x => x.id === tier);
  const nd = neuronById['mem:' + tier];
  const head = (nd ? `<div class="exp"><div class="exp-desc">${esc(nd.desc || '')}</div></div>` : '') +
    (t ? `<div class="mh"><b>${esc(t.label)}</b> · ${t.count.toLocaleString()} total · ${t.recent24h || 0} in last 24h</div>` : '');
  const rows = (d.recent || []).map(e => {
    const ts = String(e.ts || '').replace('T', ' ').slice(0, 16);
    const score = e.score != null ? Number(e.score).toFixed(2) : '';
    return `<div class="mem-row"><span class="mr-meta">${ts}${score ? ' · ' + score : ''}</span>
              <div class="mr-text">${esc(String(e.text || '').slice(0, 700))}</div></div>`;
  }).join('');
  drawer('mnemosyne — ' + tier, head + (rows || '<div class="empty">no entries</div>'));
}

/* ---------------- idle: the brain at rest still breathes ---------------- */
const IDLE_COL = '#4f6bb5';                 // muted Persian blue — calm, clearly "not working"
const IDLE_WAVE = { period: 8.0, sigma: 0.11, amp: 0.30 };

const IDLE = { next: 0, i: 0, order: null, byNode: null, nodes: null };
// at rest the wires are not silent: dim packets drift along them, memory → output, so the
// graph keeps the same visual language it uses when it works (a stream, not a pulse wave)
function noteArrival(nr, now) {
  if (!nr) return;
  if (SINK_IDS.has(nr.id)) { sinkArrival(nr, now); return; }
  if (!HUB_IDS.has(nr.id)) return;
  const r = RECV.get(nr.id) || { combo: 0, last: 0, hue: 190 };
  const gap = now - r.last;
  // sustained input builds the burst; a pause resets it, so a lone packet stays a small ring
  r.combo = Math.min(5, gap < 1100 ? r.combo + 1 : 1);
  r.last = now;
  r.hue = (r.hue + 53) % 360;
  RECV.set(nr.id, r);
  PINGS.push({ x: nr.x, y: nr.y, w: nr.w, h: nr.h, t0: now, hue: r.hue, power: r.combo, r: MOBILE ? 6 : 7 });
  if (PINGS.length > 40) PINGS.shift();
}

function sinkArrival(nr, now) {
  const r = RECV.get(nr.id) || { combo: 0, last: 0, hue: 200 };
  r.combo = Math.min(5, now - r.last < 1100 ? r.combo + 1 : 1);
  r.last = now;
  r.hue = (r.hue + 61) % 360;
  RECV.set(nr.id, r);
  PINGS.push({ x: nr.x, y: nr.y, w: nr.w, h: nr.h, t0: now, hue: r.hue, power: r.combo, r: MOBILE ? 6 : 7 });
  if (PINGS.length > 40) PINGS.shift();
  // the word only appears once the flow into this node has stopped, not on every packet
  clearTimeout(SINK_TIMERS.get(nr.id));
  SINK_TIMERS.set(nr.id, setTimeout(() => {
    POPS.push({ x: nr.x, y: nr.y, hh: nr.hh, hw: nr.w / 2, t0: performance.now(), hue: r.hue, n: r.combo });
    if (POPS.length > 8) POPS.shift();
  }, 340));
}

/* One packet on compose → reply. Used in three places: every tool result that lands in
   compose, every batch actually sent to the platform, and a slow trickle while compose is
   warm. Without it the reply node only blinked at the very end of a turn. */
function sparkReply(now, k) {
  const a = neuronById['th:6'], b = neuronById['out:reply'];
  if (!a || !b) return;
  // do NOT warm compose here: the trickle reads compose's warmth to decide whether to run,
  // so warming it from this function kept the trickle alive for ever (reply never went dark)
  b.act = Math.max(b.act, 0.24 * k);   // k: 1.8 trickle, 1.4 a tool result, 4 delivery
  const w = edgeOf('th:6', 'out:reply');
  if (w) hotEdges.set(w, now + FADE_MS);
  const vp = viaPoly(a, b);
  pulses.push(vp
    ? { pts: vp.pts, poly: { cum: vp.cum, len: vp.len }, t: 0, speed: 0.022, color: VIA_COLOR, label: '', d0: performance.now() }
    : { pts: [ptOf(a), ptOf(b)], t: 0, speed: 0.022, color: C.green, label: '', d0: performance.now() });
}

function idleDrift(now) {
  if (!atRest()) return;                          // real traffic always wins
  // WEIGHTS holds ids, not node references — resolve them before touching layer/y
  if (!IDLE.order) {
    IDLE.order = WEIGHTS.filter(w => !w.leap && neuronById[w.from] && neuronById[w.to])
      .sort((x, y) => (neuronById[x.from].layer - neuronById[y.from].layer)
                   || (neuronById[x.from].y - neuronById[y.from].y));
    // group by source, so a wanderer can be launched FROM a node rather than from a list
    const m = new Map();
    for (const w of IDLE.order) {
      if (!m.has(w.from)) m.set(w.from, []);
      m.get(w.from).push(w);
    }
    IDLE.byNode = m;
    IDLE.nodes = [...m.keys()];
    IDLE.i = 0;
  }
  if (!IDLE.order.length || now < IDLE.next) return;
  const busy = new Set();
  let live = 0;
  for (const p of pulses) if (p.dim) { live++; busy.add(p.key); }
  const MAX = MOBILE ? 13 : 20;                   // a swarm reads as a resting brain
  if (live >= MAX) { IDLE.next = now + 90; return; }
  IDLE.next = now + 70 + Math.random() * 140;     // no metronome: irregular, like fireflies
  // round-robin across every node that has an outgoing wire, so all of them emit
  const nodes = IDLE.nodes, N = nodes.length;
  let w = null;
  for (let k = 0; k < N; k++) {
    const outs = IDLE.byNode.get(nodes[(IDLE.i + k) % N]) || [];
    const free = outs.filter(c => !busy.has(c.from + '>' + c.to));
    if (free.length) {
      w = free[(Math.random() * free.length) | 0];
      IDLE.i = (IDLE.i + k + 1) % N;
      break;
    }
  }
  if (!w) { IDLE.i = (IDLE.i + 1) % N; return; }
  const a = neuronById[w.from], b = neuronById[w.to];
  if (!a || !b) return;
  pulses.push({ pts: [a, b].map(ptOf),
                key: w.from + '>' + w.to,
                t: 0, speed: 0.007 + Math.random() * 0.014,           // 2.5–7s per wire
                gain: 0.40 + Math.random() * 0.45,                    // many and faint, not few and loud
                color: IDLE_COL, label: '', d0: now, dim: true });
}

function atRest() {
  const idle = brain.state === 'idle' || window.__idleTest;
  return idle && (window.__idleTest || ORB.excite <= 0.12);
}

function idleWave(now) {
  const idle = brain.state === 'idle' || window.__idleTest;      // __idleTest: preview the rest state on demand
  if (!idle || (!window.__idleTest && ORB.excite > 0.12)) return null;   // real traffic always wins
  const p = ((now / 1000) % IDLE_WAVE.period) / IDLE_WAVE.period;
  return { x: -0.15 + p * 1.3, env: Math.pow(Math.sin(Math.PI * p), 0.55) };
}


/* Each chip has one entry and one exit. Which pair of faces meets depends on the axis,
   so a line leaves a box edge and lands on a box edge — never in the middle of one. */
/* Which face a wire leaves and enters on. Cross-stage wires use the flow axis (columns run
   right, bands run down). Two nodes of the SAME stage are not crossing anything, so they
   use the axis they are actually arranged on: the think chain is a vertical spine on
   desktop and a sideways run inside one band on the phone. Using the flow axis for those
   put the vertical segment between the two chip faces — i.e. straight through both chips. */
function ports(a, b) {
  // a pulse trail stores bare {x,y} points, so a missing half-size means "centre"
  const ahw = a.hw || 0, ahh = a.hh || 0, bhw = b.hw || 0, bhh = b.hh || 0;
  const sameStage = a.layer != null && a.layer === b.layer;
  if (MOBILE) {                              // bands stack top → bottom: in on top, out below
    if (sameStage) {
      const right = b.x >= a.x;
      return { ax: a.x + (right ? ahw : -ahw), ay: a.y,
               bx: b.x + (right ? -bhw : bhw), by: b.y };
    }
    const down = b.y >= a.y;
    return { ax: a.x, ay: a.y + (down ? ahh : -ahh),
             bx: b.x, by: b.y + (down ? -bhh : bhh) };
  }
  if (sameStage && Math.abs(b.y - a.y) > 1) {   // the think chain runs down its own column
    const down = b.y >= a.y;
    return { ax: a.x, ay: a.y + (down ? ahh : -ahh),
             bx: b.x, by: b.y + (down ? -bhh : bhh) };
  }
  const right = b.x >= a.x;                  // columns run left → right: in left, out right
  return { ax: a.x + (right ? ahw : -ahw), ay: a.y,
           bx: b.x + (right ? -bhw : bhw), by: b.y };
}

/* ---------------- orthogonal wiring: right angles, chamfered corners ----------------
   A curve reads as decoration; a wire that turns 90° reads as wiring. Each corner is cut
   by a small chamfer so the eye never has to follow a hairpin. */
const EP_CACHE = new Map();
/* Two wires that share a gap used to meet at the same midpoint and read as one thick
   line. Every edge now gets its own lane inside the gap, sorted so lanes do not cross. */
const LANE = new Map();
let LANE_EPOCH = -1;
function colOf(n) {
  let bi = 0, bd = 1e9;
  COLX.forEach((c, i) => { const d = Math.abs(c.x - n.x); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
let LANE_N = -1;
function ensureLanes() {
  if (LANE_EPOCH === LAYOUT_EPOCH && LANE_N === WEIGHTS.length) return;
  LANE.clear();
  LANE_EPOCH = LAYOUT_EPOCH;
  LANE_N = WEIGHTS.length;
  const groups = new Map();
  for (const w of WEIGHTS) {
    const a = neuronById[w.from], b = neuronById[w.to];
    if (!a || !b) continue;
    const k = MOBILE ? Math.min(a.layer, b.layer) + '>' + Math.max(a.layer, b.layer)
                     : Math.min(colOf(a), colOf(b)) + '>' + Math.max(colOf(a), colOf(b));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  for (const list of groups.values()) {
    // order by where the line lands, so the fan opens instead of braiding
    list.sort((x, y) => {
      const nx = neuronById[x.to], ny = neuronById[y.to];
      return (MOBILE ? nx.x - ny.x : nx.y - ny.y) || (x.from < y.from ? -1 : 1);
    });
    list.forEach((w, i) => LANE.set(w.from + '>' + w.to, (i + 1) / (list.length + 1)));
  }
}
function chamferPts(pts, c) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], d = pts[i + 1];
    const l1 = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const l2 = Math.hypot(d[0] - b[0], d[1] - b[1]) || 1;
    const c1 = Math.min(c, l1 / 2), c2 = Math.min(c, l2 / 2);
    const p1 = [b[0] + (a[0] - b[0]) / l1 * c1, b[1] + (a[1] - b[1]) / l1 * c1];
    const p2 = [b[0] + (d[0] - b[0]) / l2 * c2, b[1] + (d[1] - b[1]) / l2 * c2];
    if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < 0.5) out.push(b);   // too short to cut
    else { out.push(p1); out.push(p2); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/* Eight wires leave `th:4` and eight arrive at `th:5`. From a single port point they
   overlap for the first 20px and read as one thick line, which is the "lines touching"
   look. Every wire now gets its own spot on the face, ordered by where it is going so the
   fan opens outwards instead of braiding. */
const FAN = new Map();
let FAN_EPOCH = -1, FAN_N = -1;
/* the axis a wire spreads along: across the face it enters or leaves */
function fanAxis(a, b) {
  const sameStage = a.layer != null && a.layer === b.layer;
  return MOBILE ? (sameStage ? 'y' : 'x') : (sameStage ? 'x' : 'y');
}
function ensureFan() {
  if (FAN_EPOCH === LAYOUT_EPOCH && FAN_N === WEIGHTS.length) return;
  FAN_EPOCH = LAYOUT_EPOCH;
  FAN_N = WEIGHTS.length;
  FAN.clear();
  const outG = new Map(), inG = new Map();
  for (const w of WEIGHTS) {
    const a = neuronById[w.from], b = neuronById[w.to];
    if (!a || !b) continue;
    const ax = fanAxis(a, b);
    const ko = w.from + '|' + ax, ki = w.to + '|' + ax;
    if (!outG.has(ko)) outG.set(ko, []);
    if (!inG.has(ki)) inG.set(ki, []);
    outG.get(ko).push(w);
    inG.get(ki).push(w);
  }
  const spread = (list, node, other, side) => {
    const ax = fanAxis(neuronById[list[0].from], neuronById[list[0].to]);
    list.sort((x, y) => {
      const ox = other(x), oy = other(y);
      return (ax === 'y' ? ox.y - oy.y : ox.x - oy.x) || (x.from < y.from ? -1 : 1);
    });
    const face = ax === 'y' ? node.h : node.w;
    // two or three wires were sitting 4.5px apart for no reason: there is face to spare.
    // From four up the tidy bundle is the point, so the cap stays.
    const step = list.length <= 3
      ? (face * (list.length === 2 ? 0.55 : 0.62)) / Math.max(1, list.length - 1)
      : Math.min(4.5, (face * 0.62) / Math.max(1, list.length - 1));
    list.forEach((w, i) => {
      const s = (i - (list.length - 1) / 2) * step;
      const k = w.from + '>' + w.to;
      const rec = FAN.get(k) || {};
      rec[side] = s;
      FAN.set(k, rec);
    });
  };
  for (const [k, list] of outG) spread(list, neuronById[list[0].from], w => neuronById[w.to], 'sa');
  for (const [k, list] of inG) spread(list, neuronById[list[0].to], w => neuronById[w.from], 'sb');
}

/* Khanh: the compose→reply leap still read badly however it was routed, so it is no longer a
   leap — the wire is two ordinary hops (compose→terminal, terminal→reply) joined behind the
   terminal chip. The chip paints over the join, so it reads as a hand-off through the tool. */
const VIA = { 'th:6>out:reply': 'tool:terminal' };
const VIA_COLOR = '#ff4d5e';    // Khanh: this one line reads red the whole way
function viaPath(a, b, vid) {
  const v = neuronById[vid];
  if (!v) return null;
  /* An explicit stair, not two auto-routes glued together: every hop is axis-aligned and the
     chip is crossed in one straight pass, so the wire never leaves the chip on a slope. */
  const off = Math.max(7, Math.min(v.hh, v.hw) * 0.42);   // its own lane, clear of terminal's own wire
  // orientation comes from the layout, not from geometry: compose sits at the bottom of its
  // column, so its vertical distance to terminal is larger than the horizontal one
  const sideBySide = !MOBILE;
  const raw = [];
  let entry;
  if (sideBySide) {
    const y = v.y + off;
    const x0 = a.x + a.hw, x1 = b.x - b.hw;
    const g1 = (x0 + v.x - v.hw) / 2, g2 = (v.x + v.hw + x1) / 2;
    raw.push([x0, a.y], [g1, a.y], [g1, y], [v.x - v.hw, y], [v.x + v.hw, y], [g2, y], [g2, b.y], [x1, b.y]);
    entry = [v.x - v.hw, y];
  } else {
    const x = v.x + off;
    const y0 = a.y + a.hh, y1 = b.y - b.hh;
    const g1 = (y0 + v.y - v.hh) / 2, g2 = (v.y + v.hh + y1) / 2;
    raw.push([a.x, y0], [a.x, g1], [x, g1], [x, v.y - v.hh], [x, v.y + v.hh], [x, g2], [b.x, g2], [b.x, y1]);
    entry = [x, v.y - v.hh];
  }
  const pts = chamferPts(raw, MOBILE ? 5 : 8);
  const cum = [0];
  let L = 0, joinLen = 0, bestD = Infinity;
  for (let i = 1; i < pts.length; i++) { L += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]); cum.push(L); }
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - entry[0], pts[i][1] - entry[1]);
    if (d < bestD) { bestD = d; joinLen = cum[i]; }
  }
  return { pts, cum, len: L || 1, ax: pts[0][0], ay: pts[0][1],
           bx: pts[pts.length-1][0], by: pts[pts.length-1][1], _joinLen: joinLen, _via: vid };
}

function edgePath(a, b) {
  const ka = a.id || (a.x.toFixed(1) + ',' + a.y.toFixed(1));
  const kb = b.id || (b.x.toFixed(1) + ',' + b.y.toFixed(1));
  const key = ka + '>' + kb;
  const hit = EP_CACHE.get(key);
  if (hit) return hit;
  const p = ports(a, b);
  const sameStage = a.layer != null && a.layer === b.layer;
  const leap0 = a.layer != null && b.layer != null && Math.abs(b.layer - a.layer) > 1;
  const ch = MOBILE ? 5 : 8;
  ensureLanes();
  ensureFan();
  const f = LANE.get(a.id + '>' + b.id);
  // own spot on each face, so eight wires do not leave the same pixel
  const fan = FAN.get(a.id + '>' + b.id) || {};
  // A hub carries a readout in the lower half of the chip. A fan offset of 17px pushed the
  // result wire out of the chip right under that number, which read as the stat "blocking"
  // the line: on a hub the port stays within ±4px of the face centre so the wire clears it.
  const lim = (id, off) => HUB_IDS.has(id) ? Math.max(-4, Math.min(4, off)) : off;
  if (fanAxis(a, b) === 'x') { p.ax += lim(a.id, fan.sa || 0); p.bx += lim(b.id, fan.sb || 0); }
  else { p.ay += lim(a.id, fan.sa || 0); p.by += lim(b.id, fan.sb || 0); }
  let raw;
  if (sameStage) {
    // a wire inside one stage crosses nothing, so it runs straight along the arrangement
    // axis instead of detouring into the gutter where it used to cut through both chips
    if (MOBILE) {
      const blocked = NEURONS.some(n => n !== a && n !== b && n.layer === a.layer &&
        n.x > Math.min(a.x, b.x) + 1 && n.x < Math.max(a.x, b.x) - 1);
      if (blocked) {
        const band = BANDY[a.layer];
        const yG = band ? band.y + band.h / 2 - 6 : Math.max(p.ay, p.by) + 20;
        raw = [[a.x, a.y + a.hh], [a.x, yG], [b.x, yG], [b.x, b.y + b.hh]];
      } else {
        const mx = (p.ax + p.bx) / 2;
        raw = [[p.ax, p.ay], [mx, p.ay], [mx, p.by], [p.bx, p.by]];
      }
    } else {
      const my = (p.ay + p.by) / 2;
      raw = [[p.ax, p.ay], [p.ax, my], [p.bx, my], [p.bx, p.by]];
    }
  } else if (MOBILE) {
    // bands stack vertically: drop into the gutter line between the two bands, run across,
    // then drop again onto the entry port
    if (leap0) {
      const vid = VIA[a.id + '>' + b.id];
      const vp = vid ? viaPath(a, b, vid) : null;
      if (vp) { EP_CACHE.set(key, vp); return vp; }
      const b0 = leapRoute(a, b, a.id + '>' + b.id);
      const pts0 = b0.pts, cum0 = [0];
      let L0 = 0;
      for (let i = 1; i < pts0.length; i++) { L0 += Math.hypot(pts0[i][0] - pts0[i - 1][0], pts0[i][1] - pts0[i - 1][1]); cum0.push(L0); }
      const ep0 = { pts: pts0, cum: cum0, len: L0 || 1, ax: pts0[0][0], ay: pts0[0][1],
                    bx: pts0[pts0.length - 1][0], by: pts0[pts0.length - 1][1],
                    _cost: Math.round(b0.cost), _x: b0.cross, _chip: b0.chip };
      EP_CACHE.set(key, ep0);
      return ep0;
    }
    else {
      const lo = Math.min(p.ay, p.by), hi = Math.max(p.ay, p.by);
      const my = f != null ? lo + (hi - lo) * f : (p.ay + p.by) / 2;
      raw = [[p.ax, p.ay], [p.ax, my], [p.bx, my], [p.bx, p.by]];
    }
  } else if (leap0) {
    // A leap must not run through a chip. It leaves the source, turns into the corridor
    // between the two columns, goes around the near end of the skipped column (top or
    // bottom, whichever is closer), then descends the far corridor and enters the target
    // from its left face.
    // Round the OUTSIDE of the whole graph, and round it on the side where the source column
    // has nothing left to pass. Going up from compose looked like the short way but every
    // lane between reasoning and action runs horizontally there: it crossed sixteen wires.
    // compose is the lowest chip in its column, so dropping below the action band and coming
    // in along the right margin crosses nothing at all.
    const vid = VIA[a.id + '>' + b.id];
    const vp = vid ? viaPath(a, b, vid) : null;
    if (vp) { EP_CACHE.set(key, vp); return vp; }
    const best = leapRoute(a, b, a.id + '>' + b.id);
    const pts0 = best.pts;
    const cum0 = [0];
    let L0 = 0;
    for (let i = 1; i < pts0.length; i++) { L0 += Math.hypot(pts0[i][0] - pts0[i - 1][0], pts0[i][1] - pts0[i - 1][1]); cum0.push(L0); }
    const ep0 = { pts: pts0, cum: cum0, len: L0 || 1, ax: pts0[0][0], ay: pts0[0][1],
                  bx: pts0[pts0.length - 1][0], by: pts0[pts0.length - 1][1],
                  _cost: Math.round(best.cost), _x: best.cross, _chip: best.chip };
    EP_CACHE.set(key, ep0);
    return ep0;
  } else {
    // the standard case: out, into this edge's own lane, across, in
    const lo = Math.min(p.ax, p.bx), hi = Math.max(p.ax, p.bx);
    const mx = f != null ? lo + (hi - lo) * f : (p.ax + p.bx) / 2;
    raw = [[p.ax, p.ay], [mx, p.ay], [mx, p.by], [p.bx, p.by]];
  }
  const pts = chamferPts(raw, ch);
  const cum = [0];
  let L = 0;
  for (let i = 1; i < pts.length; i++) { L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); cum.push(L); }
  const ep = { pts, cum, len: L || 1,
               ax: pts[0][0], ay: pts[0][1],
               bx: pts[pts.length - 1][0], by: pts[pts.length - 1][1] };
  EP_CACHE.set(key, ep);
  return ep;
}


/* The leap has to get from the bottom of the reasoning column to the top of the output
   column, which means crossing the action column's field one way or another. Rather than
   hard-code "go round the outside" (which looked absurd: a screen-wide detour for a hop of
   570px) this scores a small set of orthogonal candidates on chip hits, wire crossings and
   length, and takes the cheapest. The winner usually threads the gaps between bands. */
function segX(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (!d) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

function leapRoute(a, b, selfKey) {
  // the port can slide along the face: dropping straight down out of compose lands on the
  // delegate chip below it, and a 10px shift clears it
  const face = (n, side, off = 0) => side === 'l' ? [n.x - n.w / 2, n.y + off]
    : side === 'r' ? [n.x + n.w / 2, n.y + off]
    : side === 't' ? [n.x + off, n.y - n.hh] : [n.x + off, n.y + n.hh];
  // channels: every gap between bands, plus the margins outside the whole graph
  const spans = LAYERS.map(L => {
    const yy = L.nodes.map(n => neuronById[n.id]).filter(Boolean);
    return { top: Math.min(...yy.map(n => n.y - n.hh)), bot: Math.max(...yy.map(n => n.y + n.hh)) };
  }).filter(s => isFinite(s.top));
  const ys = [], xs = [];
  for (let i = 0; i < spans.length - 1; i++) ys.push((spans[i].bot + spans[i + 1].top) / 2);
  ys.push(spans[0].top - 26);
  ys.push(spans[spans.length - 1].bot + 18);
  const leftMost = Math.min(...NEURONS.map(n => n.x - n.w / 2));
  const rightMost = Math.max(...NEURONS.map(n => n.x + n.w / 2));
  xs.push(leftMost - 16, rightMost + 16);
  for (let i = 0; i < COLX.length - 1; i++) xs.push((COLX[i].x + COLX[i + 1].x) / 2);
  if (MOBILE) for (let i = 1; i < 8; i++) xs.push(26 + i * ((innerWidth - 52) / 8));   // between action chips

  const cands = [];
  const offs = MOBILE ? [-18, -9, 0, 9, 18] : [-26, -13, 0, 13, 26];
  for (const ea of ['b', 't', 'l', 'r']) for (const eb of ['l', 'r', 't', 'b']) for (const oa of offs) {
    const A = face(a, ea, oa), B = face(b, eb);
    const vertA = ea === 'b' || ea === 't', vertB = eb === 't' || eb === 'b';
    if (vertA && vertB) {
      for (const y of ys) cands.push([[A[0], A[1]], [A[0], y], [B[0], y], [B[0], B[1]]]);
    } else if (!vertA && !vertB) {
      for (const x of xs) cands.push([[A[0], A[1]], [x, A[1]], [x, B[1]], [B[0], B[1]]]);
    } else {
      const c = vertA ? [A[0], B[1]] : [B[0], A[1]];
      cands.push([[A[0], A[1]], c, [B[0], B[1]]]);
      if (vertA) { for (const x of xs) cands.push([[A[0], A[1]], [A[0], B[1]], [x, B[1]], [B[0], B[1]]]); }
      else { for (const y of ys) cands.push([[A[0], A[1]], [B[0], A[1]], [B[0], y], [B[0], B[1]]]); }
      // both corner orders: out-then-across, or across-then-out
      for (const x of xs) cands.push([[A[0], A[1]], [x, A[1]], [x, B[1]], [B[0], B[1]]]);
      for (const y of ys) cands.push([[A[0], A[1]], [A[0], y], [B[0], y], [B[0], B[1]]]);
      // two channels: along a margin AND through a band gap, which is the only way to get
      // under the output band and still enter a chip from its bottom face
      for (const x of xs) for (const y of ys) cands.push([[A[0], A[1]], [x, A[1]], [x, y], [B[0], y], [B[0], B[1]]]);
    }
  }

  // crossings only mean something if the other wires already exist: build them first
  for (const w of WEIGHTS) {
    if (w.leap) continue;
    const kk = w.from + '>' + w.to;
    if (!EP_CACHE.has(kk) && neuronById[w.from] && neuronById[w.to]) edgePath(neuronById[w.from], neuronById[w.to]);
  }

  let best = null;
  for (const raw of cands) {
    const pts = chamferPts(raw, MOBILE ? 5 : 8);
    let len = 0, chip = 0, cross = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const probes = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      const nsteps = Math.max(1, Math.ceil(d / 4));
      for (let t = 0; t <= nsteps; t++) probes.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t / nsteps,
                                                    pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t / nsteps]);
    }
    for (const n of NEURONS) {
      if (n === a || n === b) continue;
      for (const q of probes) {
        if (Math.abs(q[0] - n.x) < n.w / 2 + 1 && Math.abs(q[1] - n.y) < n.h / 2 + 1) { chip++; break; }
      }
    }
    for (const w of WEIGHTS) {
      if (w.from + '>' + w.to === selfKey || w.leap) continue;
      const ep = EP_CACHE.get(w.from + '>' + w.to);
      if (!ep) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        for (let k = 0; k < ep.pts.length - 1; k++) {
          if (segX(pts[i], pts[i + 1], ep.pts[k], ep.pts[k + 1])) { cross++; break; }
        }
      }
    }
    const cost = chip * 900 + cross * 14 + len * 0.25;
    if (!best || cost < best.cost) best = { cost, pts, chip, cross, len };
  }
  return best;
}

function tracePath(c, ep) {
  c.moveTo(ep.pts[0][0], ep.pts[0][1]);
  for (let i = 1; i < ep.pts.length; i++) c.lineTo(ep.pts[i][0], ep.pts[i][1]);
}

/* position at fraction t of the path, measured by arc length — a right-angle route is not
   parameterised evenly, so t must be distance, not a corner index */
function onPath(ep, t) {
  const d = Math.max(0, Math.min(1, t)) * ep.len;
  let i = 1;
  while (i < ep.cum.length - 1 && ep.cum[i] < d) i++;
  const a = ep.pts[i - 1], b = ep.pts[i];
  const seg = (ep.cum[i] - ep.cum[i - 1]) || 1;
  const k = (d - ep.cum[i - 1]) / seg;
  return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k };
}
/* full device resolution: crispness beats fill-rate here — the mesh is baked and
   only lit edges are stroked, so the extra pixels are affordable. */
const DP = () => Math.min(3, devicePixelRatio || 1);
function ptOnBez(a, b, t) { return onPath(edgePath(a, b), t); }

/* A beam is a short bright segment riding the curve — one gesture that says both
   "this link is active" and "which way the data goes". Dashes read as a broken line. */
function beamOn(ep, tA, tB, col, a, wMax) {
  if (tB - tA < 0.004 || tB < 0) return;
  const N = 16;
  let prev = null;
  ctx.strokeStyle = col;
  ctx.lineCap = 'round';
  for (let i = 0; i <= N; i++) {
    const q = onPath(ep, tA + (tB - tA) * (i / N));
    const x = q.x, y = q.y;
    if (prev) {
      const k = i / N;
      ctx.globalAlpha = a * (0.06 + 0.94 * k * k);
      ctx.lineWidth = 0.4 + wMax * k;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke();
    }
    prev = { x, y };
  }
}

let t0 = performance.now();
/* ---------------- pointcloud orb: a seismograph of the dataflow ---------------- */
const orbCv = document.getElementById('orb');
const octx = orbCv ? orbCv.getContext('2d') : null;
const bigCv = document.getElementById('orbBig');
const bctx = bigCv ? bigCv.getContext('2d') : null;
const ORB = {
  pts: [], big: [], amp: 0.08, size: 0, bsize: 0,
  excite: 0, kick: 0, spinV: 0.2, rotY: 0,
  rings: [], ev: [], flow: 0, flowT: 0, focus: false
};

function spherePts(n) {
  const a = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) / n * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.39996323;                 // golden angle → even sphere
    a.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r,
             ph: Math.random() * 6.2832, sp: 0.6 + Math.random() * 0.9 });
  }
  return a;
}
function initOrb() {
  const n = MOBILE ? 120 : 200;
  if (ORB.pts.length !== n) ORB.pts = spherePts(n);
  if (ORB.big.length !== 340) ORB.big = spherePts(340);
}

/* every real event pokes the orb: magnitude comes from the event itself */
function orbImpulse(kind, color, w = 0) {
  const now = performance.now();
  ORB.ev.push(now);
  if (ORB.ev.length > 300) ORB.ev.shift();
  w = Math.max(0, Math.min(1, w || 0));
  ORB.excite = Math.min(1.4, ORB.excite + 0.40 + w * 0.55);
  ORB.kick += (kind === 'act' ? 1.6 : kind === 'speak' ? 1.0 : 1.2) * (0.55 + w);
  ORB.flow = kind === 'act' ? -1 : kind === 'speak' ? 1 : kind === 'in' ? -0.45 : 0;
  ORB.flowT = 1;
  ORB.rings.push({ r: 0.10, life: 1, color: color || C.teal,
                   kind, sp: kind === 'act' ? 2.0 : 1.35 });
  if (ORB.rings.length > 5) ORB.rings.shift();
}

function orbRate() {          // events per second over the last 10s
  const now = performance.now();
  ORB.ev = ORB.ev.filter(t => now - t < 10000);
  return ORB.ev.length / 10;
}

function tickOrb(dt, now) {
  const st = brain.state;
  const target = st === 'act' ? 1 : st === 'think' ? 0.55 : st === 'idle' ? 0.07 : 0.4;
  ORB.amp += (target - ORB.amp) * Math.min(1, dt * 2.8);
  ORB.excite = Math.max(0, ORB.excite - dt * 1.15);
  ORB.kick = Math.max(0, ORB.kick - dt * 1.7);
  ORB.flowT = Math.max(0, ORB.flowT - dt * 0.85);
  const spin = (st === 'act' ? 1.9 : st === 'think' ? 0.95 : 0.2) + ORB.kick * 1.6;
  ORB.spinV += (spin - ORB.spinV) * Math.min(1, dt * 4);
  ORB.rotY += ORB.spinV * dt;
  for (const rg of ORB.rings) { rg.life -= dt * 1.15; rg.r += dt * 1.5; }
  ORB.rings = ORB.rings.filter(rg => rg.life > 0);
}

function paintOrb(g, size, now, dt, pts) {
  const st = brain.state, t = now / 1000;
  const amp = ORB.amp, ex = Math.min(1.2, ORB.excite);
  const col = liveNow();     // eased, so the sphere never jumps hue between states
  const rotY = ORB.rotY;
  const rotX = Math.sin(t * 0.4) * 0.30 + (st === 'act' ? 0.2 : 0) + ex * 0.12;
  const cx = size / 2, cy = size / 2, R = size * 0.325;
  /* The glow used to reach R*2 = 0.65*size, past the half-size edge of a square canvas, so
     the fill was guillotined by the canvas bounds and the whole orb read as a boxed image.
     It now ends exactly on the edge and fades to zero before it, so nothing is cut. */
  const EDGE = size * 0.5;
  const cg = g.createRadialGradient(cx, cy, 0, cx, cy, EDGE);
  cg.addColorStop(0, rgba(col, 0.15 + amp * 0.30 + ex * 0.24));
  cg.addColorStop(0.42, rgba(col, 0.07 + amp * 0.13 + ex * 0.11));
  cg.addColorStop(0.72, rgba(col, 0.02 + amp * 0.03 + ex * 0.03));
  cg.addColorStop(1, rgba(col, 0));
  g.fillStyle = cg; g.fillRect(0, 0, size, size);
  // shock rings: one per real event, expanding and fading
  for (const rg of ORB.rings) {
    const rr = Math.min(EDGE * 0.97, R * (0.35 + rg.r * 1.9));
    // fade the ring out as it approaches the edge: a ring that stops dead at the canvas
    // boundary draws the square again
    const a = Math.pow(Math.max(0, rg.life), 1.7) * 0.55 * (1 - Math.pow(rr / EDGE, 6));
    if (a < 0.004) continue;
    g.strokeStyle = rgba(rg.color, a);
    g.lineWidth = 0.8 + rg.life * 1.3;
    g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.stroke();
  }
  // data flow: points stream in while a tool runs, out when it answers
  const flowAmt = ORB.flowT * ORB.flow * (0.10 + 0.20 * amp);
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  for (const p of pts) {
    const pulse = Math.sin(t * (2.2 + p.sp * 2.4) + p.ph * 2.1);
    const wob = 1 + 0.045 * Math.sin(t * 1.7 * p.sp + p.ph)
                  + (0.13 * amp + 0.20 * ex) * pulse
                  + flowAmt * (0.6 + 0.4 * pulse);
    const x0 = p.x * wob, y0 = p.y * wob, z0 = p.z * wob;
    const x1 = x0 * cosY - z0 * sinY, z1 = x0 * sinY + z0 * cosY;
    const y1 = y0 * cosX - z1 * sinX, z2 = y0 * sinX + z1 * cosX;
    const persp = 1 / (1.85 - z2 * 0.55);
    let sx = cx + x1 * R * persp * 1.42, sy = cy + y1 * R * persp * 1.42;
    const dist = Math.hypot(sx - cx, sy - cy), lim = EDGE * 0.86;
    if (dist > lim) { const k = lim / dist; sx = cx + (sx - cx) * k; sy = cy + (sy - cy) * k; }
    const depth = (z2 + 1) / 2;                       // 0 back … 1 front
    const rad = (0.45 + depth * 1.5) * (1 + amp * 0.4 + ex * 0.5);
    g.globalAlpha = Math.min(1, 0.08 + depth * 0.72 + ex * 0.22 * depth);
    g.fillStyle = ex > 0.55 && depth > 0.72 ? '#ffffff' : col;
    g.beginPath(); g.arc(sx, sy, rad, 0, 7); g.fill();
  }
  g.globalAlpha = 1;
  // orbit rings only while something is really running
  if (amp > 0.35) {
    g.strokeStyle = rgba(col, 0.06 + (amp - 0.35) * 0.22 + ex * 0.06);
    g.lineWidth = 0.7;
    for (let k = 0; k < 2; k++) {
      g.save(); g.translate(cx, cy);
      g.rotate(t * (0.7 + k * 0.55) * (k ? -1 : 1) + ORB.kick * 0.2);
      g.beginPath(); g.ellipse(0, 0, R * 1.45, R * (0.42 + k * 0.22), 0, 0, 7); g.stroke();
      g.restore();
    }
  }
}

function drawOrb(now, dt) {
  if (!octx || !orbCv) return;
  const css = orbCv.clientWidth || 76;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (ORB.size !== css) { ORB.size = css; orbCv.width = Math.round(css * dpr); orbCv.height = Math.round(css * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, css, css);
  paintOrb(octx, css, now, dt, ORB.pts);
}

function drawOrbBig(now, dt) {
  if (!ORB.focus || !bctx || !bigCv) return;
  const css = bigCv.clientWidth || 360;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (ORB.bsize !== css) { ORB.bsize = css; bigCv.width = Math.round(css * dpr); bigCv.height = Math.round(css * dpr); }
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bctx.clearRect(0, 0, css, css);
  paintOrb(bctx, css, now, dt, ORB.big);
}

function toggleOrbFocus(on) {
  ORB.focus = on === undefined ? !ORB.focus : !!on;
  const el = document.getElementById('orbFocus');
  if (el) el.classList.toggle('on', ORB.focus);
  if (ORB.focus) paintFocus();
}

function paintFocus() {
  if (!ORB.focus) return;
  const s = document.getElementById('of-state'), m = document.getElementById('of-meta');
  if (!s || !m) return;
  const st = brain.state;
  s.textContent = st === 'act' ? (lastAct ? shortTool(lastAct.tool) : 'acting') : st;
  s.className = 'of-state ' + (st === 'act' ? 'act' : st === 'think' ? 'think' : 'idle');
  m.innerHTML = [
    TURN.task ? `task · ${TURN.task.replace('task:', '')}` : '',
    `step ${TURN.tools + 1} · ${TURN.thinks} think`,
    lastAct ? `${shortTool(lastAct.tool)} ${(+lastAct.dur).toFixed(2)}s · ${lastAct.chars.toLocaleString()} chars` : '',
    `${TURN.out.toLocaleString()} tok out · ${fmtDur(TURN.start ? Date.now() / 1000 - TURN.start : 0)}`,
    `${orbRate().toFixed(2)} events/s · ${ORB.rings.length} pulses`,
    mne ? `mnemosyne ${mne.total.toLocaleString()} entries` : ''
  ].filter(Boolean).join('<br>');
}

function render(now) {
  requestAnimationFrame(render);        // reschedule first: one bad frame must never kill the loop
  const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
  tickLive();                            // the card and the orb cross-fade between states
  tickOrb(dt, now);
  if (MOBILE) {                        // phone: the card orb still breathes alongside the vertical graph
    drawOrb(now, dt);
  }
  const DW = cv.width / DP(), DH = cv.height / DP();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (meshCv) ctx.drawImage(meshCv, 0, 0);   // baked at device scale → 1:1 blit, no resampling
  ctx.setTransform(DP(), 0, 0, DP(), 0, 0);
  drawOrb(now, dt); drawOrbBig(now, dt);

  // column bands + captions
  ctx.textAlign = 'center';
  LAYERS.forEach((L, li) => {
    const first = L.nodes[0];
    if (!first) return;                       // a column that has not loaded yet must never break the frame
    const n = neuronById[first.id];
    if (!n) return;
    if (MOBILE) {
      // phone: one horizontal band per stage, caption pinned to the left edge
      // the phone drops the stage captions entirely: the chips already say what they are,
      // and a 7px word at the left edge was just noise on a 390px screen
      return;
    }
    // no column tint: one flat colour behind everything, the caption marks the stage
    // captions sit just above their own column's first node, never under the NOW card
    const cy = Math.max(96, n.y - 46);
    ctx.font = '600 9.5px Montserrat'; ctx.fillStyle = C.cap;
    ctx.fillText(L.label.toUpperCase(), n.x, cy);
    // the sub-line was 74,84,112 at 75% — about 1.9:1, unreadable on a dark screen
    ctx.font = '400 9px Montserrat'; ctx.fillStyle = 'rgba(138,150,175,.85)';
    ctx.fillText(L.sub, n.x, cy + 14);
  });

  // edges — faint base mesh, hot path ignites; at rest a slow wave sweeps through it
  const wave = null;   // no left→right ping any more: at rest only the drifting packets move
  const wNorm = p => MOBILE ? (p.y - 0) / DH : p.x / DW;     // phone: sweeps top→bottom, desktop left→right
  for (const w of WEIGHTS) {
    const a = neuronById[w.from], b = neuronById[w.to];
    if (!a || !b) continue;
    const hotT = hotEdges.get(w) || 0;
    const left = hotT ? hotT - now : 0;
    if (hotT && left <= 0) hotEdges.delete(w);
    // a lit line never cuts: it eases out over 3s and only then goes dark
    const f = left > 0 ? Math.pow(Math.min(1, left / FADE_MS), 0.65) : 0;
    const hot = f > 0.015;
    const hoverHot = hoverN && (a === hoverN || b === hoverN);
    // warm = both ends are processing right now → data is really flowing through this link
    const warm = a.liveT > 0.2 && b.liveT > 0.2;
    let wv = 0;
    if (wave) {
      const dx = (wNorm(a) + wNorm(b)) / 2 - wave.x;
      wv = Math.exp(-(dx * dx) / (IDLE_WAVE.sigma * IDLE_WAVE.sigma)) * wave.env;
    }
    if (!hot && !warm && !hoverHot && wv < 0.03) continue;    // the quiet mesh is baked into meshCv
    const ep = edgePath(a, b);
    // quiet by default: the mesh is almost invisible unless traffic is flowing through it
    const baseA = MESH_A;
    ctx.strokeStyle = hot ? rgba(w.color, 0.92 * f)
      : warm ? rgba(w.color, 0.34)
      : hoverHot ? rgba(w.color, 0.5)
      : wv >= 0.03 ? rgba(MESH_C, MESH_A + IDLE_WAVE.amp * wv * 0.5)
      : rgba(MESH_C, baseA);
    // one thickness for every active line: traffic share changes how BRIGHT a link is,
    // never how fat — a heavy edge used to read as a different kind of line
    ctx.lineWidth = hot ? activeW()
      : warm ? warmW()
      : hoverHot ? 1.1 + w.w * 2.0
      : wv >= 0.03 ? 0.36 + 0.62 * wv
      : 0.32 + w.w * 0.70;
    if (hot || warm || wv > 0.55) { ctx.shadowColor = rgba(hot ? w.color : wv > 0.55 ? IDLE_COL : w.color, hot ? 0.7 * f : 0.25 * wv); ctx.shadowBlur = hot ? 8 * f : wv > 0.55 ? 5 * wv : 4; }
    // a leap is a logical shortcut, not a physical wire: dashed, and it passes behind
    // the boxes it crosses (edges are painted before nodes, so the chip hides it)
    ctx.beginPath(); tracePath(ctx, ep); ctx.stroke();
    ctx.shadowBlur = 0;
    // While the link is live a beam runs along it, source → target, one and a half
    // times a second: motion with a direction instead of a broken dashed line.
    if ((hot || warm) && !w.leap) {
      const ww = Math.min(1, w.w);
      const speed = 0.85 + 0.55 * ww;                       // traversals per second
      const tail = 0.22 + 0.14 * ww;
      const cycle = 1 + tail;
      const a0 = hot ? 0.72 : 0.34;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let b = 0; b < 2; b++) {
        const ph = ((now / 1000) * speed + b * cycle / 2) % cycle;
        const head = Math.min(1, ph), tailT = Math.max(0, ph - tail);
        if (head > tailT) beamOn(ep, tailT, head, w.color, a0 * (b ? 0.55 : 1), activeW());
      }
      ctx.restore();
    }
    if (hoverHot) {
      const mid = ptOnBez(a, b, 0.5);
      ctx.font = '600 9px ui-monospace,Consolas,monospace'; ctx.fillStyle = w.color;
      ctx.fillText(w.w.toFixed(2), mid.x, mid.y - 4);
    }
  }

  idleDrift(now);
  paintThink();

  // packets — a comet built from tapered streaks (beads read as dots, a streak reads as
  // flow), drawn additively so overlapping trails bloom instead of stacking flat
  pulses = pulses.filter(p => p.t < 1);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of pulses) {
    if (now < (p.d0 || 0)) continue;            // packets queue behind the head
    const tBefore = p.t;
    p.t += p.speed * (dt * 60) * 1.4 * PULSE_SLOW;
    // a real packet that just crossed into its destination has been *received*
    if (!p.dim && tBefore < 1 && p.t >= 1) noteArrival(neuronById[p.pts[p.pts.length - 1].id], now);
    let segT = 0, seg = 0, lt = 0, a, b, pos;
    if (p.poly) {
      pos = pulseAt(p, p.t);
      seg = pos.seg; a = p.pts[seg]; b = p.pts[seg + 1]; lt = 0;
    } else {
      segT = p.t * (p.pts.length - 1);
      seg = Math.min(p.pts.length - 2, Math.max(0, Math.floor(segT)));
      lt = Math.max(0, Math.min(1, segT - seg));
      a = p.pts[seg]; b = p.pts[seg + 1];
      pos = ptOnBez(a, b, lt);
    }
    p.pos = pos;
    /* transit: a node the path runs through takes the hit, not just the two endpoints */
    if (p.mark && !p.marked && p.poly) {
      const travelled = Math.max(0, Math.min(1, p.t)) * p.poly.len;
      if (travelled >= p.mark.d) {
        p.marked = true;
        const tn = neuronById[p.mark.id];
        if (tn) {
          tn.glowT = 1;
          PINGS.push({ x: tn.x, y: tn.y, w: tn.w, h: tn.h, t0: now,
                       hue: hslOf(VIA_COLOR).h, power: 0.8, r: MOBILE ? 6 : 7 });
        }
      }
    }
    // white is the resting colour only: an idle drift is colourless, a real packet keeps
    // the colour of the boundary it is crossing (recall gold / reason violet / deliver green)
    const segColor = p.dim ? '#ffffff'
      : a.tint ? a.tint
      : (a.layer != null && PHASES[a.layer]) ? PHASES[a.layer].color : p.color;

    const dim = !!p.dim;
    /* An idle wanderer breathes in and out over its journey instead of appearing at full
       strength: sin() over the path means it is invisible at both ends, so nothing pops. */
    const env = dim ? Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, p.t))), 0.8) : 1;
    const gain = dim ? (p.gain || 1) * env : 1;
    if (dim && gain < 0.01) continue;
    const SEG = dim ? 12 : 9, step = dim ? 0.018 : 0.024, peak = (dim ? 0.30 : 0.62) * gain;
    ctx.lineCap = 'round';
    let prev = pos;
    // on a polyline the trail must cross corners, not pile up at them: walk back in distance
    const dStep = 0.0115;
    for (let i = 1; i <= SEG; i++) {
      const q = p.poly ? pulseAt(p, Math.max(0, p.t - i * dStep))
                       : ptOnBez(a, b, Math.max(0, lt - i * step));
      const k = 1 - i / SEG;
      ctx.globalAlpha = Math.pow(k, dim ? 2.1 : 1.6) * peak;
      ctx.strokeStyle = segColor;
      ctx.lineWidth = (dim ? 0.35 : 0.5) + (dim ? 1.7 : 3.8) * k;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      prev = q;
    }
    // head bloom
    if (!isFinite(pos.x) || !isFinite(pos.y)) continue;
    const rr = dim ? 4 : 8;
    const gr = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, rr);
    gr.addColorStop(0, rgba(segColor, (dim ? 0.30 : 0.7) * gain));
    gr.addColorStop(0.4, rgba(segColor, (dim ? 0.10 : 0.22) * gain));
    gr.addColorStop(1, rgba(segColor, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, rr, 0, 7); ctx.fill();
    if (!dim) {
      ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, 1.4, 0, 7); ctx.fill();
    } else {
      // a tiny core is what turns a smear into a firefly
      ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.55 * gain;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, 0.75, 0, 7); ctx.fill();
    }
  }
  ctx.restore();

  // labels are text, not light: never additive
  for (const p of pulses) {
    if (!p.label || !p.pos) continue;
    const segT = p.t * (p.pts.length - 1);
    const seg = Math.min(p.pts.length - 2, Math.max(0, Math.floor(segT)));
    const a = p.pts[seg];
    const col = a.tint || ((a.layer != null && PHASES[a.layer]) ? PHASES[a.layer].color : p.color);
    ctx.font = '600 10px ui-monospace,Consolas,monospace';
    ctx.fillStyle = p.dim ? '#ffffff' : col; ctx.globalAlpha = 0.92;
    ctx.textAlign = 'center';
    ctx.fillText(p.label, p.pos.x, p.pos.y - 12);
    ctx.globalAlpha = 1;
  }

  // DELIVERED — a 5x7 bitmap word, small and gold. Motion is continuous (an earlier version
  // stepped it to 8ths for an arcade feel; at one update per 325ms that just read as lag).
  if (POPS.length) {
    POPS = POPS.filter(p => now - p.t0 < 2600);
    ctx.save();
    const txt = 'DELIVERED';
    const { runs, cols } = wordRuns(txt);
    const ease = k => 1 - Math.pow(1 - k, 3);
    for (const p of POPS) {
      const t = now - p.t0;
      const k = Math.min(1, t / 2600);
      const grow = Math.min(1, t / 190);                       // tiny settle, smooth
      const px = (MOBILE ? 1.2 : 1.35) * (0.9 + 0.1 * ease(grow));
      const rise = 0;
      const alpha = k < 0.6 ? Math.min(1, t / 90) : Math.max(0, 1 - (k - 0.6) / 0.4);
      const w = cols * px;
      // data enters these nodes on their left face, so the word comes out of the RIGHT side.
      // If the node sits too close to the edge, mirror it to the left instead of overlapping.
      const rightSide = p.x + p.hw + 8 + w < innerWidth - 6;
      const x0 = rightSide ? p.x + p.hw + 8 + ease(Math.min(1, t / 900)) * 10
                           : Math.min(Math.max(p.x - p.hw - 8 - w - ease(Math.min(1, t / 900)) * 10, 6), innerWidth - w - 6);
      const y0 = Math.max(96, p.y - 3.5 * px);
      for (let pass = 0; pass < 2; pass++) {
        const ox = pass ? 0 : 1, oy = pass ? 0 : 1;
        for (const [r, ci, n] of runs) {
          ctx.fillStyle = pass
            ? (r === 0 ? `rgba(255,246,205,${alpha})` : r < 3 ? `rgba(255,214,90,${alpha})` : `rgba(238,166,36,${alpha})`)
            : `rgba(96,54,0,${(alpha * 0.85).toFixed(2)})`;
          ctx.fillRect(x0 + ci * px + ox, y0 + r * px + oy, Math.max(1, n * px - 0.5), Math.max(1, px - 0.5));
        }
      }
    }
    ctx.restore();
  }

  // receive rings — cosmetic: a hub being fed pushes a ring whose radius grows with each
  // arrival in the burst and whose hue steps every time, so sustained input reads as sonar
  if (PINGS.length) {
    PINGS = PINGS.filter(p => now - p.t0 < 1200);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of PINGS) {
      const k = (now - p.t0) / 1200;
      const ease = 1 - Math.pow(1 - k, 2);
      const grow = 1.28 + 0.26 * p.power;              // more arrivals → a wider ring
      const sc = 1 + ease * (grow - 1);
      const alpha = Math.pow(1 - k, 1.7) * (0.26 + 0.09 * p.power);
      const w = p.w * sc, h = p.h * sc;
      ctx.strokeStyle = `hsla(${p.hue},90%,64%,${alpha.toFixed(3)})`;
      ctx.lineWidth = Math.max(0.5, 2.8 * (1 - k));
      ctx.beginPath(); ctx.roundRect(p.x - w / 2, p.y - h / 2, w, h, p.r * sc); ctx.stroke();
    }
    ctx.restore();
  }

  // neurons — a chip per node, portrait on a phone and landscape on desktop
  for (const nr of NEURONS) {
    nr.glowT = Math.max(0, nr.glowT - dt * 1.7);   // spark: an event just passed through
    nr.liveT = (nr.liveT || 0) + ((nr.live ? 1 : 0) - (nr.liveT || 0)) * Math.min(1, dt * 7);
    const act = Math.min(1, nr.act);
    let wvN = 0;
    if (wave) { const d = wNorm(nr) - wave.x; wvN = Math.exp(-(d * d) / (IDLE_WAVE.sigma * IDLE_WAVE.sigma)) * wave.env; }
    const rainbow = nr.accent === 'rainbow';
    const acc = rainbow ? hslHex(now / 16) : nr.accent;
    const base = acc || (nr.layer === 1 ? C.gold : C.blue);
    const x = nr.x - nr.hw, y = nr.y - nr.hh;

    // halo = data is flowing through this node right now (sustained, breathing);
    // a brief spark on top when an event just crossed it.
    const breath = 0.82 + 0.18 * Math.sin(now / 320 + nr.y * 0.05);
    const halo = Math.max(nr.glowT * 0.34, nr.liveT * 0.42 * breath);
    if (halo > 0.02) {
      const HR = Math.max(nr.hw, nr.hh) * (MOBILE ? 2.2 : 2.0);
      const grd = ctx.createRadialGradient(nr.x, nr.y, 1, nr.x, nr.y, HR);
      grd.addColorStop(0, rgba(base, halo));
      grd.addColorStop(0.55, rgba(base, halo * 0.35));
      grd.addColorStop(1, rgba(base, 0));
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(nr.x, nr.y, HR, 0, 7); ctx.fill();
    }

    // a hub (5+ inlets) is framed instead of boxed: nested outlines plus one tick per
    // incoming wire along the input face, so "nine things land here" is legible as shape
    const deg = nr.deg || 0;
    const hub = HUB_IDS.has(nr.id);
    // body — stays flat and quiet at rest
    ctx.beginPath(); ctx.roundRect(x, y, nr.w, nr.h, MOBILE ? 6 : 7);
    ctx.fillStyle = '#080b12'; ctx.fill();
    if (rainbow) {
      // every colour at once, sweeping along the chip and drifting with time
      // sweep along the chip's long axis: on a phone the chip is portrait, so a
      // corner-to-corner gradient would only show a slice of the wheel
      const g = MOBILE ? ctx.createLinearGradient(x, y, x, y + nr.h)
                       : ctx.createLinearGradient(x, y, x + nr.w, y);
      for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, hslHex(now / 16 + i * 55));
      ctx.strokeStyle = g;
      ctx.lineWidth = nr.liveT > 0.15 || nr.glowT > 0.25 ? 2 : 1.5;
    } else {
      ctx.strokeStyle = nr.liveT > 0.15 ? base
        : hub ? rgba(base, 0.55)
        : acc ? rgba(acc, 0.30)
        : nr.layer === 1 ? rgba(C.gold, 0.26) : 'rgba(120,136,172,.22)';
      ctx.lineWidth = nr.liveT > 0.15 ? 1.8 : hub ? 1.4 : nr.glowT > 0.25 ? 1.6 : 1.1;
    }
    ctx.stroke();

    // a fresh arrival also lights the inside of the chip, in the same hue as its ring
    const rcv = RECV.get(nr.id);
    const rAge = rcv ? now - rcv.last : 1e9;
    if (rAge < 420) {
      const f = 1 - rAge / 420;
      ctx.fillStyle = `hsla(${rcv.hue},90%,62%,${(0.16 * f).toFixed(3)})`;
      ctx.beginPath(); ctx.roundRect(x, y, nr.w, nr.h, MOBILE ? 6 : 7); ctx.fill();
    }


    if (hub) {
      ctx.save();
      ctx.lineWidth = 1;
      if (!MOBILE) {
        // there is air between desktop columns, so the frames sit outside the chip
        const o1 = 5, o2 = 9;
        ctx.strokeStyle = rgba(base, 0.16);
        ctx.beginPath(); ctx.roundRect(x - o1, y - o1, nr.w + o1 * 2, nr.h + o1 * 2, 9); ctx.stroke();
        ctx.strokeStyle = rgba(base, 0.085);
        ctx.beginPath(); ctx.roundRect(x - o2, y - o2, nr.w + o2 * 2, nr.h + o2 * 2, 11); ctx.stroke();
        if (deg >= 3) {
          const span = nr.h * 0.72;
          ctx.fillStyle = rgba(base, 0.62);
          for (let i = 0; i < deg; i++) ctx.fillRect(x - o1 - 1.6, nr.y + (i / (deg - 1) - 0.5) * span - 0.9, 3.2, 1.8);
        }
      } else {
        // a phone band gives a node 42px, so a frame outside it would land on the neighbour:
        // the emphasis goes inside — tint, inset outline, and the comb along the input edge
        ctx.fillStyle = rgba(base, 0.07);
        ctx.beginPath(); ctx.roundRect(x, y, nr.w, nr.h, 6); ctx.fill();
        ctx.strokeStyle = rgba(base, 0.34);
        ctx.beginPath(); ctx.roundRect(x + 2, y + 2, nr.w - 4, nr.h - 4, 4.5); ctx.stroke();
        if (deg >= 3) {
          const span = (nr.w - 14) * 0.86;
          ctx.fillStyle = rgba(base, 0.70);
          for (let i = 0; i < deg; i++) ctx.fillRect(nr.x + (i / (deg - 1) - 0.5) * span - 0.8, y + 3.4, 1.6, 2.6);
        }
      }
      ctx.restore();
    }

    // the two ports: entry and exit sit on the flow axis so a line never leaves mid-face
    const pa = 0.22 + Math.max(nr.liveT, act) * 0.6;
    ctx.fillStyle = rgba(base, pa);
    if (MOBILE) {
      ctx.fillRect(nr.x - 2.5, y - 2, 5, 3.5);                 // in, top
      ctx.fillRect(nr.x - 2.5, y + nr.h - 1.5, 5, 3.5);        // out, bottom
    } else {
      ctx.fillRect(x - 2, nr.y - 2.5, 3.5, 5);                 // in, left
      ctx.fillRect(x + nr.w - 1.5, nr.y - 2.5, 3.5, 5);        // out, right
    }

    // inner fill carries sustained processing intensity; the idle wave only tints it
    const inner = Math.max(act * 0.16, nr.liveT * 0.34, wvN * 0.13);
    if (inner > 0.03) {
      ctx.fillStyle = rgba(wvN > 0.3 ? IDLE_COL : base, 0.05 + inner);
      ctx.beginPath(); ctx.roundRect(x + 3, y + 3, nr.w - 6, nr.h - 6, 5); ctx.fill();
    }
    // work in progress: the bevel of the box fills up (delegate tasks finishing).
    // No circles left in this design — a ring around a rectangle was the last one.
    const rx = x - 1.5, ry = y - 1.5, rw = nr.w + 3, rh = nr.h + 3, rr = MOBILE ? 7 : 8;
    // work in progress: a comet running around the bevel. A dash segment read as a cut
    // in the border; a head with a tail that thins and fades reads as something loading.
    if (nr.progress != null && nr.progress > 0) {
      const P = perim(rw, rh, rr);
      ctx.save();
      ctx.strokeStyle = rgba(base, 0.10); ctx.lineWidth = 1.2;
      rrPath(ctx, rx, ry, rw, rh, rr); ctx.stroke();      // the track it fills against
      bevelComet(ctx, rx, ry, rw, rh, rr, Math.min(1, nr.progress) * P, P * 0.26, base, 0.95, MOBILE ? 2.2 : 2.6);
      ctx.restore();
    }
    if (nr.run || nr.spin) {
      const P = perim(rw, rh, rr), tail = P * (MOBILE ? 0.24 : 0.18);
      const head = ((now / (nr.spin ? 1150 : 1500)) % 1) * P;
      ctx.save();
      // the loader wears the colour of the node it is loading, so the comet reads as part
      // of that box instead of a generic spinner
      bevelComet(ctx, rx, ry, rw, rh, rr, head, tail, base, 0.92, MOBILE ? 2.2 : 2.6);
      ctx.restore();
    }

    // labels — inside the chip; the value is the message, so it sits under the name
    // a flashed readout fades over its last 800ms, then flashNode clears it
    const vAlpha = nr.valueT0 == null ? 1 : Math.max(0, Math.min(1, (3000 - (now - nr.valueT0)) / 800));
    const showVal = nr.value && vAlpha > 0;
    if (MOBILE) {
      const maxW = nr.w - 7;
      ctx.textAlign = 'center';
      const fit = nodeLabel(ctx, nr.label, maxW, 6.6, 5.2);   // full caption, never elided
      ctx.font = '700 ' + fit.size + 'px Montserrat';
      ctx.fillStyle = nr === hoverN ? C.ink : nr.glowT > 0.2 ? '#dbc9a4' : '#a3aec4';
      const lh = fit.size * 1.16;
      const blockTop = nr.y + (showVal ? -4 : 0) - (fit.lines.length * lh) / 2;
      fit.lines.forEach((ln, i) => ctx.fillText(ln, nr.x, blockTop + lh * (i + 0.78)));
      if (showVal) {
        ctx.font = '700 6.6px ui-monospace,Consolas,monospace';
        ctx.fillStyle = rgba(base, 0.95 * vAlpha);      // the readout wears the node's colour
        ctx.fillText(fitText(ctx, nr.value, maxW), nr.x, nr.y + 10);
      }
    } else {
      const maxW = nr.w - 8;
      ctx.textAlign = 'center';
      const fit = nodeLabel(ctx, nr.label, maxW, 10, 8.5);    // full caption, never elided
      ctx.font = '700 ' + fit.size + 'px Montserrat';
      ctx.fillStyle = nr === hoverN ? C.ink : nr.glowT > 0.2 ? '#dbc9a4' : '#a4afc6';
      const lh = fit.size * 1.15;
      const blockTop = nr.y + (showVal ? -4 : 2) - (fit.lines.length * lh) / 2;
      fit.lines.forEach((ln, i) => ctx.fillText(ln, nr.x, blockTop + lh * (i + 0.78)));
      if (showVal) {
        ctx.font = '700 9px ui-monospace,Consolas,monospace';
        ctx.fillStyle = rgba(base, (nr === hoverN ? 1 : 0.95) * vAlpha);
        ctx.fillText(fitText(ctx, nr.value, maxW), nr.x, nr.y + 11);
      } else if (nr.desc) {
        ctx.font = '700 8.5px Montserrat';
        ctx.fillStyle = nr === hoverN ? '#98a2b6' : '#5a6480';
        ctx.fillText(fitText(ctx, nr.desc, 150), nr.x, nr.y + nr.hh + 13);
      }
    }
  }

  // helpers — each subagent is a small box docked to the delegate node's edge, not a
  // floating dot: the boxes read as "parts of this job", which is what they are
  const dn = neuronById['tool:delegate'];
  if (dn && USE && USE.delegates && USE.delegates.length) {
    const list = USE.delegates.slice(0, MOBILE ? 2 : 4);
    const cw = MOBILE ? 20 : 30, ch = MOBILE ? 8 : 13, gap = MOBILE ? 3 : 4;
    const total = list.length * ch + (list.length - 1) * gap;
    // a node at the bottom of its column has no room to stack downwards: keep the dock
    // on screen instead of letting it run under the ticker
    // BANDY describes the phone layout only; on desktop the dock just has to stay on screen
    const loT = safeTop() + 112, hiT = innerHeight - 80 - total;
    const yTop0 = MOBILE ? 0
      : Math.max(loT, Math.min(Math.max(loT, hiT), dn.y - total / 2));
    let lastBx = 0;
    list.forEach((d, i) => {
      const col = d.state === 'error' ? C.red : d.state === 'completed' ? C.green : C.violet;
      const bx = MOBILE ? dn.x - cw / 2 : dn.x - dn.hw - 7 - cw;
      const by = MOBILE ? dn.y + dn.hh + 5 + i * (ch + gap)
                        : yTop0 + i * (ch + gap);
      lastBx = bx;
      // the stub: the box is attached to the node, so the line is the attachment
      ctx.strokeStyle = rgba(col, 0.34); ctx.lineWidth = 0.9;
      ctx.beginPath();
      if (MOBILE) { ctx.moveTo(dn.x, dn.y + dn.hh); ctx.lineTo(dn.x, by); }
      else { ctx.moveTo(dn.x - dn.hw, by + ch / 2); ctx.lineTo(bx + cw, by + ch / 2); }
      ctx.stroke();
      // the box
      ctx.beginPath(); ctx.roundRect(bx, by, cw, ch, 2.5);
      ctx.fillStyle = rgba(col, 0.10); ctx.fill();
      ctx.strokeStyle = rgba(col, d.state === 'running' ? 0.75 : 0.5); ctx.lineWidth = 0.9; ctx.stroke();
      // a 1.6px floor bar carries the state: full = done, half = running, sliver = queued
      const f = d.state === 'completed' ? 1 : d.state === 'error' ? 1 : 0.45;
      ctx.fillStyle = rgba(col, 0.6);
      ctx.beginPath(); ctx.roundRect(bx + 1.5, by + ch - 3, (cw - 3) * f, 1.6, 0.8); ctx.fill();
      if (!MOBILE) {
        ctx.font = '500 6.5px ui-monospace,Consolas,monospace';
        ctx.fillStyle = rgba(col, 0.92); ctx.textAlign = 'center';
        ctx.fillText(d.dur ? d.dur + 's' : 'run', bx + cw / 2, by + ch / 2 - 0.5);
      }
    });
    if (!MOBILE) {
      ctx.font = '500 8px Montserrat'; ctx.fillStyle = '#4d5670'; ctx.textAlign = 'center';
      ctx.fillText((USE.delegates_today || list.length) + ' helpers', lastBx + cw / 2, yTop0 - 7);
    }
  }

  paintPeek();

  // hover tooltip
  if (hoverN) {
    ctx.textAlign = 'center';
    const l1 = hoverN.label, l2 = `layer ${hoverN.layer} · act ${(hoverN.act || 0).toFixed(2)}`;
    ctx.font = '500 10px Montserrat';
    const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 22;
    const tx = Math.max(w / 2 + 6, Math.min(DW - w / 2 - 6, hoverN.x));
    const ty = hoverN.y + 30;
    ctx.fillStyle = 'rgba(10,14,22,.96)'; ctx.strokeStyle = '#232c3d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(tx - w / 2, ty, w, 36, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.ink; ctx.fillText(l1, tx, ty + 15);
    ctx.fillStyle = C.dim; ctx.fillText(l2, tx, ty + 28);
  }
}

/* ---------------- interaction ---------------- */
function toLocal(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function pickNeuron(p, slack) {
  const pad = slack || (MOBILE ? 8 : 6);
  let best = null, bd = 1e9;
  for (const nr of NEURONS) {
    // distance to the box, not to its centre: -inf means the point is inside
    const dx = Math.abs(p.x - nr.x) - nr.hw, dy = Math.abs(p.y - nr.y) - nr.hh;
    const d = Math.max(dx, dy);
    if (d < pad && d < bd) { bd = d; best = nr; }
  }
  return best;
}
cv.addEventListener('pointermove', e => { hoverN = pickNeuron(toLocal(e)); });
cv.addEventListener('pointerdown', e => {
  const p = toLocal(e);
  if (MOBILE) {
    // phone: tap the band label on the left to open the whole stage
    if (p.x < 62) {
      let best = null, bd = 1e9;
      for (const b of BANDY) { const d = Math.abs(b.y - p.y); if (d < bd) { bd = d; best = b; } }
      if (best) { openColumn(best.layer); return; }
    }
    const nm = pickNeuron({ x: p.x, y: p.y + 6 }, 14);   // fingertip tolerance
    if (nm) { nm.click && nm.click(); return; }
    return;
  }
  // column captions are tap targets → explains every node in that column
  const capRef = neuronById[LAYERS[0].nodes[0] ? LAYERS[0].nodes[0].id : ''];
  const capY = capRef ? Math.max(96, capRef.y - 46) : 96;
  if (p.y > capY - 14 && p.y < capY + 24) {
    let best = null, bd = 72;
    for (const c of COLX) { const d = Math.abs(c.x - p.x); if (d < bd) { bd = d; best = c; } }
    if (best) { openColumn(best.layer); return; }
  }
  const n = pickNeuron(p); n?.click && n.click();
});

function fitCanvas() {
  const dpr = DP();
  cv.width = Math.round(innerWidth * dpr);
  cv.height = Math.round(innerHeight * dpr);
  cv.style.width = innerWidth + 'px';        // match the bitmap exactly — a 100vw canvas
  cv.style.height = innerHeight + 'px';      // wider than innerWidth is stretched and goes soft
  layout();
}
let layoutT = 0;
addEventListener('resize', fitCanvas);
addEventListener('resize', () => { clearTimeout(layoutT); layoutT = setTimeout(() => { layout(); buildWeights(); }, 140); });

/* ---------------- ticker ---------------- */
function renderTicker(evs) {
  $('#ticker').innerHTML = evs.map(e => {
    if (e.kind === 'think') return `<span class="tk gold"><b>◆ think</b> #${e.n} · ${e.tout} tok · ${e.latency}s</span>`;
    if (e.kind === 'act')   return `<span class="tk blue"><b>→ ${esc(e.tool)}</b> ${e.dur}s · ${e.chars}ch</span>`;
    if (e.kind === 'deliver') return `<span class="tk green"><b>✓ sent</b> ${esc(e.platform)} · ${e.chars}ch</span>`;
    if (e.kind === 'stream') return `<span class="tk green"><b>→</b> ${esc(e.platform)} · ${e.chars}ch</span>`;
    if (e.kind === 'err')   return `<span class="tk red"><b>! error</b> ${esc((e.text || '').slice(0, 40))}</span>`;
    return `<span class="tk">${esc((e.text || '').slice(0, 60))}</span>`;
  }).join('');
}

/* ---------------- mobile: the same brain, drawn as a vertical pipeline ---------------- */
const MCOL = ['#e8a13a', '#8b7cf6', '#3f6cff', '#3ddc97'];

function dominant(li) {
  let best = null, bv = -1;
  for (const nr of NEURONS) if (nr.layer === li && (nr.act || 0) > bv) { bv = nr.act || 0; best = nr; }
  return best;
}

function stageInfo(li) {
  const nr = dominant(li);
  let label = nr ? nr.label : '—', value = (nr && nr.value) || '';
  if (li === 1) value = mne ? mne.total.toLocaleString() : '';
  if (li === 2 && lastThink) {
    label = 'think #' + lastThink.n;
    value = (lastThink.tout || 0).toLocaleString() + ' tok';
  }
  if (li === 2) {
    label = lastAct ? shortTool(lastAct.tool) : (nr ? nr.label : 'idle');
    value = lastAct ? (+lastAct.dur).toFixed(2) + 's' : (nr ? nr.value : '') || 'idle';
  }
  if (li === 3) value = TURN.out.toLocaleString() + ' out';
  // one stage is "live" at a time — glow is a budget, not a status light
  const cur = brain.state === 'act' ? 2 : brain.state === 'think' ? 1 : brain.state === 'idle' ? -1 : 1;
  const justArrived = TURN.start && (Date.now() / 1000 - TURN.start) < 4;
  return { label, value, live: li === cur, hot: li === cur || (li === 0 && justArrived), nr };
}

function paintMobile() {
  const box = document.getElementById('mrows');
  if (!box || !MOBILE) return;
  const card = document.getElementById('now');
  if (card) {
    const top = Math.round(card.getBoundingClientRect().bottom + 4);
    document.documentElement.style.setProperty('--mflow-top', top + 'px');
  }
  if (box.children.length !== LAYERS.length) {
    box.innerHTML = LAYERS.map((L, li) =>
      `<div class="st tap" data-li="${li}" style="color:${MCOL[li]}">
         <span class="nm">${esc(L.label)}</span>
         <span class="dot"></span>
         <span class="lb"></span>
         <span class="vl"></span>
       </div>`).join('');
    box.onclick = ev => {
      const row = ev.target.closest('.st');
      if (row) openColumn(+row.dataset.li);
    };
  }
  LAYERS.forEach((L, li) => {
    const row = box.children[li];
    if (!row) return;
    const s = stageInfo(li);
    const lb = row.querySelector('.lb'), vl = row.querySelector('.vl');
    if (lb.textContent !== s.label) lb.textContent = s.label;
    if (vl.textContent !== s.value) vl.textContent = s.value;
    row.classList.toggle('hot', !!s.hot);
  });
}

/* The island strip: read it from CSS so canvas layout and DOM agree, and fall
   back to a sane value if an older iOS reports 0 while running installed. */
function safeTop() {
  let v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
  const installed = document.body.classList.contains('standalone') || navigator.standalone;
  if (installed && v < 1 && /iPhone|iPad|iPod/.test(navigator.userAgent)) v = 47;
  return v;
}

/* ---- app shell: installed icons get the whole screen, no browser chrome ---- */
if (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches
    || navigator.standalone) {
  document.body.classList.add('standalone');
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' ||
    ['127.0.0.1', 'localhost'].includes(location.hostname))) {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

/* ---------------- boot ---------------- */
fitCanvas(); buildWeights();
/* ?diag=1 — the phone reports dimensions I cannot see from here. When the footer or the card sits
   where the CSS says it should not, this panel answers it in one screenshot instead of a guess. */
if (location.search.includes('diag')) {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;bottom:0;height:0;padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const panel = document.createElement('pre');
  panel.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;z-index:99;margin:0;padding:8px;'
    + 'background:rgba(0,0,0,.88);color:#9fe8ff;font:10px/1.5 ui-monospace,Consolas,monospace;'
    + 'border:1px solid #1d3a52;border-radius:8px;white-space:pre-wrap;pointer-events:none';
  document.body.appendChild(panel);
  const tm = document.createElement('div');
  tm.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:100dvh;pointer-events:none;opacity:0';
  document.body.appendChild(tm);
  setInterval(() => {
    const tk = document.getElementById('ticker').getBoundingClientRect();
    const card = document.getElementById('now').getBoundingClientRect();
    const sab = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    panel.textContent = [
      'vh ' + innerHeight + '  dvh ' + Math.round(tm.getBoundingClientRect().height)
        + '  doc ' + document.documentElement.clientHeight + '  scr ' + screen.height,
      'visual ' + (window.visualViewport ? Math.round(visualViewport.height) + ' @' + Math.round(visualViewport.offsetTop) : '–'),
      'safe-area-bottom ' + sab + 'px',
      'ticker  top ' + Math.round(tk.top) + '  h ' + Math.round(tk.height) + '  gap-below ' + Math.round(innerHeight - tk.bottom),
      'card    top ' + Math.round(card.top) + '  bottom ' + Math.round(card.bottom),
      'graph   ' + Math.round(innerWidth) + '×' + Math.round(innerHeight) + (MOBILE ? '  mobile' : '  desktop')
    ].join('\n');
  }, 500);
}

requestAnimationFrame(render);          // animate before any await: a failed API must never freeze the brain
// the peek is independent of everything else: start it before the boot chain, because a
// single slow endpoint upstream would otherwise leave the code card blank for a whole turn
fetchPeek();
setTimeout(fetchPeek, 1500);
fetchThink();
setInterval(() => { if (brain.state !== 'idle') fetchThink(); }, 2000);
setInterval(() => { if (brain.state === 'idle') fetchThink(); }, 12000);
setInterval(fetchPeek, 5000);
(async () => {
  const step = async (fn, ...a) => { try { return await fn(...a); } catch (e) { console.warn('boot step failed:', fn.name, e); } };
  await step(fetchDelegates, true);      // subagent state drives the delegate node's progress
  await step(applyProfile);              // the install decides which nodes exist
  await step(fetchTools, true);
  fitCanvas(); buildWeights();
  pollLive(); setInterval(pollLive, 2500);

  // ?demo plays the full walk once; D replays it (ignore keys while typing in a field)
  if (new URLSearchParams(location.search).has('demo')) setTimeout(demoPlay, 1200);
  addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'd' || e.key === 'D') { e.preventDefault(); demoPlay(); }
    // Ctrl/Cmd+Shift+C: the multi-task showcase
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault(); showcase();
    }
  });
  setInterval(paintTurn, 1000);
  await step(wireClicks);
  await step(fetchMnemo); await step(fetchUsage);
  paintTurn(); paintUsage();
  fetchHealth().then(() => { paintHealth(); relayoutCard(); }).catch(() => {});
  setInterval(fetchMnemo, 30000);
  setInterval(fetchUsage, 30000);
  setInterval(fetchHealth, 45000);
})();
