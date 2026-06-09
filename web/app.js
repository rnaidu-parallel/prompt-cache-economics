/* prompt-cache-economics — interactive replay of a recorded benchmark. No live API. */

const RATES = {
  openai: { input: 2.5, cachedRead: 0.25, write: 0 },
  anthropic: { input: 3.0, cachedRead: 0.3, write: 3.75 },
};

const state = { provider: 'openai', variant: 'naive', step: 0, auto: null };
let DATA = null;

const $ = (s) => document.querySelector(s);
const usd = (n) => '$' + n.toFixed(6);
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

const STATIC_LAYERS = [
  { name: 'tools', desc: 'roll_dice · update_inventory · move_party', meta: '~250 tok' },
  { name: 'system · character + rules + output format', desc: 'who the DM is and how it must reply', meta: '~3.0k tok' },
  { name: 'world lore', desc: 'the realm, factions, bestiary, NPCs', meta: '~1.8k tok' },
  { name: 'session suffix · story-so-far + party', desc: 'stable for the whole session', meta: '~0.3k tok' },
];

init();

async function init() {
  DATA = await fetch('./data.json').then((r) => r.json());
  $('#run-meta').textContent = `recorded ${DATA.runAt.slice(0, 10)} · via ${DATA.via} · reasoning off`;

  document.querySelectorAll('[data-provider]').forEach((b) =>
    b.addEventListener('click', () => set('provider', b.dataset.provider)),
  );
  document.querySelectorAll('[data-variant]').forEach((b) =>
    b.addEventListener('click', () => set('variant', b.dataset.variant)),
  );
  $('#btn-step').addEventListener('click', step);
  $('#btn-reset').addEventListener('click', () => {
    stopAuto();
    state.step = 0;
    render();
  });
  $('#btn-auto').addEventListener('click', toggleAuto);
  render();
}

function set(key, val) {
  stopAuto();
  state[key] = val;
  document.querySelectorAll(`[data-${key}]`).forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset[key] === val)),
  );
  render();
}

function turns() {
  return DATA.providers[state.provider].turns[state.variant];
}

function step() {
  if (state.step >= turns().length) return;
  state.step++;
  render();
}

function toggleAuto() {
  if (state.auto) return stopAuto();
  if (state.step >= turns().length) state.step = 0;
  $('#btn-auto').textContent = 'pause';
  state.auto = setInterval(() => {
    if (state.step >= turns().length) return stopAuto();
    step();
  }, 1400);
}
function stopAuto() {
  if (state.auto) clearInterval(state.auto);
  state.auto = null;
  const b = $('#btn-auto');
  if (b) b.textContent = 'auto-play';
}

/* Cache state of the reusable prefix this turn, derived from the REAL usage numbers. */
function prefixState(usage) {
  if (usage.cacheWrite > usage.cachedRead && usage.cacheWrite > 0) return 'write';
  if (usage.cachedRead > 0) return 'cached';
  return 'miss';
}

function render() {
  const T = turns();
  const shown = state.step; // number of turns revealed
  const cur = shown > 0 ? T[shown - 1] : null;
  const stateClass = cur ? prefixState(cur.usage) : 'fresh';

  renderStack(stateClass, shown);
  renderTranscript(T, shown);
  renderTokbar(cur);
  renderBill(T, shown);
  renderBoundaryNote(stateClass);
  renderHeadline();

  $('#turn-counter').textContent = shown ? `turn ${shown} / ${T.length}` : '— press send —';
  $('#btn-step').disabled = shown >= T.length;
}

function renderStack(stateClass, shown) {
  const naive = state.variant === 'naive';
  const parts = [];

  // The troublemaker timestamp chip — at the very top for naive.
  if (naive) {
    parts.push(
      `<div class="tschip"><span>⏱</span><span class="clock">current time — changes every turn</span></div>`,
    );
  }

  const cls = shown > 0 ? stateClass : ''; // neutral until the first turn is played
  for (const l of STATIC_LAYERS) {
    parts.push(layerHTML(l, cls));
  }
  if (shown > 1) {
    parts.push(layerHTML({ name: 'message history', desc: `${shown - 1} prior turn(s)`, meta: 'grows' }, cls));
  }

  parts.push(`<div class="cache-boundary">— cache boundary —</div>`);

  // current user turn (fresh once playing); disciplined puts the timestamp here, in the tail
  const curCls = shown > 0 ? 'fresh' : '';
  const tail = state.variant === 'disciplined'
    ? `<div class="ldesc">player action <span class="tschip in-tail" style="display:inline-flex;padding:1px 6px;margin-left:6px">⏱ current time</span></div>`
    : `<div class="ldesc">player action</div>`;
  parts.push(`<div class="layer ${curCls}"><span class="lname">current turn</span><span class="lmeta">~30 tok</span>${tail}</div>`);

  $('#stack').innerHTML = parts.join('');
}

function layerHTML(l, cls) {
  return `<div class="layer ${cls}"><span class="lname">${l.name}</span><span class="lmeta">${l.meta}</span><div class="ldesc">${l.desc}</div></div>`;
}

function renderTranscript(T, shown) {
  const box = $('#transcript');
  if (!shown) {
    box.innerHTML = `<div class="empty">The party stands at the keep door. Press <b>send next turn</b> to play.</div>`;
    return;
  }
  const html = [];
  for (let i = 0; i < shown; i++) {
    const t = T[i];
    html.push(`<div class="msg player"><span class="who">player</span><span class="body">${esc(t.playerAction)}</span></div>`);
    html.push(`<div class="msg dm"><span class="who">dungeon master</span><span class="body">${esc(t.reply)}</span></div>`);
  }
  box.innerHTML = html.join('');
  box.scrollTop = box.scrollHeight;
}

function renderTokbar(cur) {
  const bar = $('#tokbar');
  if (!cur) {
    bar.querySelectorAll('.seg-fill').forEach((e) => e.remove());
    $('#tokbar-legend').textContent = '';
    return;
  }
  const u = cur.usage;
  const total = u.cachedRead + u.uncachedInput + u.cacheWrite || 1;
  const segs = [
    ['fill-cached', u.cachedRead],
    ['fill-write', u.cacheWrite],
    ['fill-uncached', u.uncachedInput],
  ];
  bar.querySelectorAll('.seg-fill').forEach((e) => e.remove());
  for (const [cls, n] of segs) {
    const d = document.createElement('div');
    d.className = `seg-fill ${cls}`;
    d.style.width = (n / total) * 100 + '%';
    bar.insertBefore(d, $('#tokbar-legend'));
  }
  const parts = [];
  if (u.cachedRead) parts.push(`${u.cachedRead} cached`);
  if (u.cacheWrite) parts.push(`${u.cacheWrite} written`);
  if (u.uncachedInput) parts.push(`${u.uncachedInput} full`);
  $('#tokbar-legend').textContent = parts.join(' · ');
}

function renderBill(T, shown) {
  const R = RATES[state.provider];
  let actual = 0, baseline = 0;
  for (let i = 0; i < shown; i++) {
    const u = T[i].usage;
    actual += (u.uncachedInput * R.input + u.cachedRead * R.cachedRead + u.cacheWrite * R.write) / 1e6;
    baseline += ((u.uncachedInput + u.cachedRead + u.cacheWrite) * R.input) / 1e6;
  }
  $('#bill-actual').textContent = usd(actual);
  $('#bill-baseline').textContent = usd(baseline);
  const vEl = $('#verdict-v');
  const kEl = $('#verdict-k');
  if (!shown) {
    vEl.textContent = '—';
    vEl.className = 'bill-v';
    kEl.textContent = 'vs no-cache';
    return;
  }
  const delta = (actual - baseline) / baseline;
  vEl.textContent = pct(delta);
  if (delta > 0.001) {
    vEl.className = 'bill-v cost';
    kEl.textContent = 'MORE than no-cache';
  } else if (delta < -0.001) {
    vEl.className = 'bill-v save';
    kEl.textContent = 'cheaper than no-cache';
  } else {
    vEl.className = 'bill-v muted';
    kEl.textContent = 'same as no-cache';
  }
}

function renderBoundaryNote(stateClass) {
  const naive = state.variant === 'naive';
  let html;
  if (naive) {
    html =
      stateClass === 'write'
        ? `The timestamp sits <b>above</b> the cache boundary, so the prefix changes every turn. Anthropic still <b>writes</b> the whole prefix to cache (you pay the 1.25× write premium) — then never reads it back. <b>Pure waste.</b>`
        : `The timestamp sits <b>above</b> the cache boundary, so the prefix differs every turn → <b>0% cache hit</b>. You pay full price for the entire prompt, every single turn.`;
  } else {
    html = `The timestamp rides in the <b>tail</b>, below the cache boundary. Everything above is byte-stable, so it's served from cache after the first (cold) turn. Only the tiny new turn is full price.`;
  }
  $('#boundary-note').innerHTML = html;
}

function renderHeadline() {
  const p = DATA.providers[state.provider];
  const a = p[state.variant];
  const isOpenAI = state.provider === 'openai';
  const hit = (p.disciplined.hitRate * 100).toFixed(0);
  let html;
  if (state.variant === 'naive') {
    html = isOpenAI
      ? `<b>Naive, OpenAI gpt-5.4:</b> a timestamp at the top → <span class="hot">0% cache hit</span>. Caching is on, but you collect <b>none</b> of it: <span class="hot">${pct(a.vsBaseline)}</span> vs not caching. The discount just… doesn't happen.`
      : `<b>Naive, Anthropic sonnet-4.6:</b> the worst case. You opt into caching, the prefix mutates, so you pay the <b>write premium every turn and read it back zero times</b> → <span class="hot">${pct(a.vsBaseline)} — more expensive than never caching at all.</span>`;
  } else {
    html = `<b>Disciplined, ${isOpenAI ? 'OpenAI gpt-5.4' : 'Anthropic sonnet-4.6'}:</b> move the timestamp to the tail and ~${hit}% of your input is served from cache → <span class="cool">${pct(a.vsBaseline)}</span> vs no cache, <span class="cool">${(p.disciplinedVsNaive * 100).toFixed(0)}% cheaper</span> than the naive version. Same prompt, same answer.`;
  }
  $('#headline').innerHTML = html;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
