/* ============================================================
   Bolão Copa 2026 — app público (read-only)
   ============================================================ */

const DATA_FILES = ['fixtures', 'config', 'aliases', 'bets'];
let DATA = null;
let STANDINGS = null;
let currentView = 'ranking';

const $ = sel => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const k in props) {
    if (k === 'class') n.className = props[k];
    else if (k === 'html') n.innerHTML = props[k];
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), props[k]);
    else n.setAttribute(k, props[k]);
  }
  for (const kid of kids) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
};

/* Resultados ao vivo direto do Supabase (tabela `results`, SELECT anon). Devolve
   { results: {gid:[h,a]}, liveStatus: {gid:status≠FINISHED} }. */
async function loadResultsFromSupabase() {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey) throw new Error('sem SUPABASE_CONFIG');
  const url = `${cfg.url.replace(/\/+$/, '')}/rest/v1/results?select=game_id,home,away,status,advances`;
  const res = await fetch(url, { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Supabase results ${res.status}`);
  const rows = await res.json();
  const results = {}, liveStatus = {};
  for (const r of rows) {
    const gid = String(r.game_id);
    results[gid] = r.advances ? [r.home, r.away, r.advances] : [r.home, r.away];
    if (r.status && r.status !== 'FINISHED') liveStatus[gid] = r.status;
  }
  return { results, liveStatus };
}

/* Fallback: o snapshot versionado no Git (só FINISHED, sem ao vivo). */
async function loadResultsFromStatic() {
  const res = await fetch('data/results.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Falha ao carregar data/results.json (${res.status})`);
  return { results: await res.json(), liveStatus: {} };
}

/* Supabase é a fonte primária (ao vivo); cai para results.json se ele falhar. */
async function loadResults() {
  try { return await loadResultsFromSupabase(); }
  catch (err) {
    console.warn('Supabase indisponível, usando data/results.json:', err.message || err);
    return await loadResultsFromStatic();
  }
}

/* Palpites de jogos JÁ TRAVADOS, ao vivo do Supabase (view public_bets, SELECT
   anon). A view só expõe jogo travado (anti-cópia, relógio do servidor). Paginado:
   o PostgREST corta em ~1000 linhas/req e limit grande não fura o teto.
   Devolve { gid: { nome: [h,a] | [h,a,adv] } } — mesmo formato do bets.json. */
async function loadPublicBetsFromSupabase() {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey) throw new Error('sem SUPABASE_CONFIG');
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/public_bets?select=game_id,display_name,home,away,advances`;
  const headers = { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` };
  const PAGE = 1000;
  const bets = {};
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${base}&limit=${PAGE}&offset=${offset}`, { headers, cache: 'no-store' });
    if (!res.ok) throw new Error(`Supabase public_bets ${res.status}`);
    const rows = await res.json();
    for (const r of rows) {
      const gid = String(r.game_id);
      (bets[gid] ||= {})[r.display_name] = r.advances ? [r.home, r.away, r.advances] : [r.home, r.away];
    }
    if (rows.length < PAGE) break;
  }
  return bets;
}

/* Mescla palpites por (jogo, nome): parte do bets.json (base/fallback) e sobrepõe
   os do Supabase (verdade ao vivo dos jogos travados). Não muta os originais.
   Palpite travado não pode mudar/sumir, então sobrepor é seguro e idempotente. */
function mergeBets(base, overlay) {
  const out = {};
  for (const gid of new Set([...Object.keys(base), ...Object.keys(overlay)]))
    out[gid] = { ...(base[gid] || {}), ...(overlay[gid] || {}) };
  return out;
}

async function loadData() {
  const entries = await Promise.all(DATA_FILES.map(async name => {
    const res = await fetch(`data/${name}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Falha ao carregar data/${name}.json (${res.status})`);
    return [name, await res.json()];
  }));
  const data = Object.fromEntries(entries);
  // palpites ao vivo dos jogos travados (Supabase) por cima do bets.json (base/fallback)
  try { data.bets = mergeBets(data.bets, await loadPublicBetsFromSupabase()); }
  catch (err) { console.warn('public_bets indisponível, usando bets.json:', err.message || err); }
  const { results, liveStatus } = await loadResults();
  data.results = results;
  data.liveStatus = liveStatus;
  return data;
}

function matchLabel(gameId) {
  const f = DATA.fixtures[gameId];
  return `${f.home} x ${f.away}`;
}

/* Rótulo do estágio do jogo: fase do mata-mata ou "Grupo X · Rodada Y".
   isKnockout/phaseName vêm do engine.js. */
function stageMeta(f) {
  return isKnockout(f) ? phaseName(f.phase) : `Grupo ${f.group} · Rodada ${f.round}`;
}

/* Resultado "HxA", com "(passa: <time> nos pênaltis)" quando decidido nos pênaltis. */
function resultText(f, result) {
  const base = `${result[0]}x${result[1]}`;
  const side = advancerOf(result);
  if (!side) return base;
  const team = side === 'home' ? f.home : f.away;
  return `${base} (passa: ${team} nos pênaltis)`;
}

/** Bandeira (flagcdn) do time; usa o mapa FLAG do engine. null se desconhecido. */
function flagImg(name) {
  const code = FLAG[name];
  if (!code) return null;
  return el('img', {
    src: `https://flagcdn.com/24x18/${code}.png`,
    srcset: `https://flagcdn.com/48x36/${code}.png 2x`,
    alt: name, width: '24', height: '18', loading: 'lazy',
    style: 'border-radius:2px;flex:none',
  });
}

/** Matchup com bandeiras: 🇦 Home x Away 🇧. */
function flaggedMatch(home, away) {
  return el('span', { style: 'display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap' },
    flagImg(home), el('span', {}, home), el('span', { class: 'muted' }, 'x'), el('span', {}, away), flagImg(away));
}

/* Converte a data do fixture ("dd/mm HHh" ou "dd/mm HHhMM") em timestamp (ms).
   Sem ano no fixture; assume FIXTURE_YEAR (horário de Brasília / local do navegador). */
const FIXTURE_YEAR = 2026;
function fixtureStart(f) {
  const m = /^(\d{2})\/(\d{2})\s+(\d{1,2})h(\d{2})?$/.exec((f && f.date) || '');
  if (!m) return NaN;
  return new Date(FIXTURE_YEAR, +m[2] - 1, +m[1], +m[3], +m[4] || 0).getTime();
}

/* Último jogo já iniciado (maior horário <= agora); empates pegam o maior id.
   Antes do 1º jogo, cai no primeiro da lista. */
function lastStartedGameId(gameIds) {
  const now = Date.now();
  let best = null, bestT = -Infinity;
  for (const gid of gameIds) {
    const t = fixtureStart(DATA.fixtures[gid]);
    if (!isNaN(t) && t <= now && t >= bestT) { bestT = t; best = gid; }
  }
  return best || gameIds[0];
}

/* fmtBet/breakdownText/criteriaList vêm do engine.js (fonte única). Aqui fica só
   o render em DOM dos selos de desempate (chips). */
function criteriaChips(d) {
  const wrap = el('span', { class: 'chips' });
  for (const c of criteriaList(d)) wrap.append(el('span', { class: `pill ${c.cls}`, title: c.title }, c.label));
  return wrap;
}

/* ---------------- Self-test banner ---------------- */
function renderSelfTest() {
  const unit = runSelfTests();
  const tie = runTiebreakTests();
  const pm = runParseMergeTests();
  const box = $('#selftest');
  if (unit.length === 0 && tie.length === 0 && pm.length === 0) {
    box.innerHTML = '';
    box.append(el('div', { class: 'banner ok' }, '✓ Self-test: motor de pontuação, cascata de desempate e parse/merge conferem (testes sintéticos).'));
    return true;
  }
  const ul = el('ul');
  [...unit, ...tie, ...pm].forEach(f => ul.append(el('li', {}, f)));
  box.innerHTML = '';
  box.append(el('div', { class: 'banner fail' },
    el('strong', {}, '✗ Self-test FALHOU — o ranking pode estar incorreto:'), ul));
  return false;
}

function renderConflicts() {
  const box = $('#conflicts');
  box.innerHTML = '';
  const cs = STANDINGS.conflicts;
  if (!cs.length) return;
  const ul = el('ul');
  cs.forEach(c => {
    ul.append(el('li', {}, `${matchLabel(c.gameId)} (jogo ${c.gameId}) — ${c.canonical}: `
      + `"${c.a.name}" ${fmtBet(c.a.bet, DATA.fixtures[c.gameId])} vs "${c.b.name}" ${fmtBet(c.b.bet, DATA.fixtures[c.gameId])}`));
  });
  box.append(el('div', { class: 'banner warn' },
    el('strong', {}, '⚠ Conflito de aliases (resolva nos dados):'), ul));
}

/* ---------------- View: Ranking ---------------- */
function viewRanking(root) {
  const r = STANDINGS.ranking;
  if (STANDINGS.hasLive) {
    root.append(el('div', { class: 'banner live-banner' },
      el('span', { class: 'pill live' }, 'AO VIVO'),
      ' Ranking parcial — há jogo em andamento; os pontos se firmam quando o jogo encerra.'));
  }
  const top3 = r.slice(0, 3);
  if (top3.length === 3) {
    const order = [top3[1], top3[0], top3[2]]; // 2º, 1º, 3º
    const medals = { 0: '🥇', 1: '🥈', 2: '🥉' };
    const posByName = {};
    top3.forEach((p, i) => posByName[p.name] = i);
    const podium = el('div', { class: 'podium' });
    order.forEach(p => {
      const pos = posByName[p.name];
      podium.append(el('div', { class: `slot p${pos + 1}` },
        el('div', { class: 'medal' }, medals[pos]),
        el('div', { class: 'pname' }, p.name),
        el('div', { class: 'ppts' }, String(p.total)),
        el('div', { class: 'pex' }, `${p.exacts} exato${p.exacts === 1 ? '' : 's'}`)
      ));
    });
    root.append(podium);
  }

  const table = el('table');
  table.append(el('thead', {}, el('tr', {},
    el('th', { class: 'rank-pos' }, '#'),
    el('th', {}, 'Participante'),
    el('th', { class: 'num' }, 'Pts'),
    el('th', { class: 'num', title: 'Placares exatos (1º desempate)' }, 'Ex'),
    el('th', { class: 'num', title: 'Acertos de direção: vitória/empate (2º desempate)' }, 'Tend'),
    el('th', { class: 'num', title: 'Acerto dos gols de quem venceu, jogos decididos (3º desempate)' }, 'GV')
  )));
  const tbody = el('tbody');
  r.forEach(p => {
    tbody.append(el('tr', { class: 'clickable', onclick: () => goParticipant(p.name) },
      el('td', { class: 'rank-pos' }, String(p.pos)),
      el('td', {}, p.name, p.live ? el('span', { class: 'pill live mini' }, 'ao vivo') : null),
      el('td', { class: 'num pts-strong' }, String(p.total)),
      el('td', { class: 'num' }, String(p.exacts)),
      el('td', { class: 'num muted' }, String(p.tendencias)),
      el('td', { class: 'num muted' }, String(p.golsVencedor))
    ));
  });
  table.append(tbody);
  root.append(table);
  root.append(el('p', { class: 'small muted mt' },
    'Desempate: Pts → Exatos → Tendências (acertou vitória/empate) → Gols do vencedor. '
    + 'Empate em tudo fica na mesma posição. Toque num nome para ver os detalhes.'));
}

/* ---------------- View: por participante ---------------- */
let selectedParticipant = null;
function goParticipant(name) { selectedParticipant = name; setView('participant'); }

function viewParticipant(root) {
  const names = [...STANDINGS.participants].sort((a, b) => a.localeCompare(b, 'pt'));
  if (!selectedParticipant || !names.includes(selectedParticipant)) selectedParticipant = names[0];

  const sel = el('select', { onchange: e => { selectedParticipant = e.target.value; render(); } });
  names.forEach(n => sel.append(el('option', n === selectedParticipant ? { value: n, selected: 'selected' } : { value: n }, n)));
  root.append(el('div', { class: 'controls' }, el('label', { class: 'field' }, 'Participante'), sel));

  const rankRow = STANDINGS.ranking.find(x => x.name === selectedParticipant);
  root.append(el('div', { class: 'card' },
    el('h3', {}, selectedParticipant),
    el('div', { class: 'meta' },
      `Total: ${rankRow.total} pts · `,
      `${rankRow.exacts} exato(s) · `,
      `${rankRow.tendencias} tendência(s) · `,
      `${rankRow.golsVencedor} gol(s) do vencedor`)
  ));

  const table = el('table');
  table.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Jogo'),
    el('th', { class: 'num' }, 'Aposta'),
    el('th', { class: 'num' }, 'Resultado'),
    el('th', { class: 'num' }, 'Pts')
  )));
  const tbody = el('tbody');
  const gameIds = Object.keys(DATA.fixtures).sort((a, b) => +a - +b);
  let any = false;
  gameIds.forEach(gid => {
    const d = STANDINGS.perGame[gid] && STANDINGS.perGame[gid][selectedParticipant];
    if (!d) return; // não participou desse jogo
    any = true;
    const ptsCell = d.pending
      ? el('td', { class: 'num' }, el('span', { class: 'pill pending' }, '—'))
      : el('td', { class: 'num' }, el('span', { class: 'score-chip' + (d.points ? ' pts-strong' : ' muted') }, String(d.points)));
    tbody.append(el('tr', { class: 'clickable', onclick: () => goGame(gid) },
      el('td', {},
        flaggedMatch(DATA.fixtures[gid].home, DATA.fixtures[gid].away),
        el('div', { class: 'breakdown' }, d.pending ? 'aguardando resultado' : breakdownText(d)),
        criteriaChips(d)),
      el('td', { class: 'num' }, fmtBet(d.bet, DATA.fixtures[gid])),
      el('td', { class: 'num' },
        d.result ? `${d.result[0]}x${d.result[1]}` : '—',
        d.live ? el('span', { class: 'pill live mini' }, 'ao vivo') : null),
      ptsCell
    ));
  });
  table.append(tbody);
  if (any) root.append(table);
  else root.append(el('p', { class: 'muted center mt' }, 'Sem apostas registradas.'));
}

/* ---------------- View: por jogo ---------------- */
let selectedGame = null;
function goGame(gid) { selectedGame = gid; setView('game'); }

/* Bloco "Palpites do grupo": barra empilhada + colunas mandante/empate/visitante. */
function outcomeBlock(f, agg) {
  const o = agg.outcome;
  const stacked = el('div', { class: 'distbar' },
    el('i', { class: 'fill-home', style: `width:${o.home.pct}%` }),
    el('i', { class: 'fill-draw', style: `width:${o.draw.pct}%` }),
    el('i', { class: 'fill-away', style: `width:${o.away.pct}%` }));

  const col = (head, count, pct, cls) => el('div', {},
    el('div', { style: 'height:24px;display:flex;align-items:center;justify-content:center' }, head),
    el('div', { class: 'ocount' }, String(count)),
    el('div', { class: 'olabel' }, 'pessoas'),
    el('div', { class: `opct ${cls}` }, `${pct}%`));

  return el('div', { class: 'card' },
    el('div', { class: 'block-head' },
      el('strong', {}, 'Palpites do grupo'),
      el('span', { class: 'pill' }, `${agg.total} palpite${agg.total === 1 ? '' : 's'}`)),
    stacked,
    el('div', { class: 'outcome-grid' },
      col(flagImg(f.home) || el('span', { class: 'out-home' }, 'Mandante'), o.home.count, o.home.pct, 'out-home'),
      col(el('span', { class: 'pill out-draw' }, '='), o.draw.count, o.draw.pct, 'out-draw'),
      col(flagImg(f.away) || el('span', { class: 'out-away' }, 'Visitante'), o.away.count, o.away.pct, 'out-away')),
    el('div', { class: 'small muted center mt' }, 'Os preferidos deste grupo'));
}

/* Bloco "Detalhamento por placar": cada placar com bandeira do vencedor, barra, % e contagem. */
function scoreBlock(f, agg) {
  const card = el('div', { class: 'card' },
    el('div', { class: 'block-head' }, el('strong', {}, 'Detalhamento por placar')));
  agg.scores.forEach(s => {
    const winFlag = s.outcome === 'home' ? flagImg(f.home)
      : s.outcome === 'away' ? flagImg(f.away)
      : el('span', { class: 'pill out-draw' }, '=');
    const fillClass = s.outcome === 'home' ? 'fill-home' : s.outcome === 'away' ? 'fill-away' : 'fill-draw';
    card.append(el('div', { class: 'scorerow' },
      el('span', { class: `pill out-${s.outcome}` }, `${s.h}-${s.a}`),
      winFlag,
      el('div', { class: 'track' }, el('i', { class: fillClass, style: `width:${s.pct}%` })),
      el('span', { class: 'spct' }, `${s.pct}%`),
      el('span', { class: 'scount' }, String(s.count))
    ));
  });
  return card;
}

function viewGame(root) {
  // ordena por horário real (os ids da FIFA não são cronológicos); empate/sem data cai no id
  const gameIds = Object.keys(DATA.fixtures).sort((a, b) => {
    const ta = fixtureStart(DATA.fixtures[a]), tb = fixtureStart(DATA.fixtures[b]);
    if (isNaN(ta) || isNaN(tb) || ta === tb) return +a - +b;
    return ta - tb;
  });
  if (!selectedGame || !gameIds.includes(selectedGame)) selectedGame = lastStartedGameId(gameIds);

  const sel = el('select', { onchange: e => { selectedGame = e.target.value; render(); } });
  gameIds.forEach(gid => {
    const f = DATA.fixtures[gid];
    const txt = `Jogo ${gid} — ${f.home} x ${f.away} (${f.date})`;
    sel.append(el('option', gid === selectedGame ? { value: gid, selected: 'selected' } : { value: gid }, txt));
  });
  root.append(el('div', { class: 'controls' }, el('label', { class: 'field' }, 'Jogo'), sel));

  const f = DATA.fixtures[selectedGame];
  const result = DATA.results[selectedGame] || null;
  const isLive = !!(DATA.liveStatus && DATA.liveStatus[selectedGame]);
  root.append(el('div', { class: 'card' },
    el('h3', {}, flaggedMatch(f.home, f.away)),
    el('div', { class: 'meta' }, `${stageMeta(f)} · ${f.date}`),
    result
      ? el('div', {},
          isLive ? el('span', { class: 'pill live' }, 'AO VIVO') : null,
          isLive ? ' Parcial: ' : 'Resultado: ',
          el('strong', { class: 'pts-strong' }, resultText(f, result)))
      : el('span', { class: 'pill pending' }, 'aguardando resultado')
  ));

  const game = STANDINGS.perGame[selectedGame] || {};

  // Distribuição dos palpites do grupo (agregação pura no engine)
  const agg = gameAggregates(game);
  if (agg.total) {
    root.append(outcomeBlock(f, agg));
    root.append(scoreBlock(f, agg));
  }

  const rows = Object.keys(game).map(name => ({ name, ...game[name] }));
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'pt'));

  const table = el('table');
  table.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Participante'),
    el('th', { class: 'num' }, 'Aposta'),
    el('th', { class: 'num' }, 'Pts')
  )));
  const tbody = el('tbody');
  rows.forEach(d => {
    const ptsCell = d.pending
      ? el('td', { class: 'num' }, el('span', { class: 'pill pending' }, '—'))
      : el('td', { class: 'num' }, el('span', { class: 'score-chip' + (d.points ? ' pts-strong' : ' muted') }, String(d.points)));
    tbody.append(el('tr', { class: 'clickable', onclick: () => goParticipant(d.name) },
      el('td', {}, el('div', {}, d.name),
        d.pending ? null : el('div', { class: 'breakdown' }, breakdownText(d)),
        criteriaChips(d)),
      el('td', { class: 'num' }, fmtBet(d.bet, f)),
      ptsCell
    ));
  });
  table.append(tbody);
  root.append(table);
}

/* ---------------- View: por rodada ---------------- */
/* Chave de estágio: rodada de grupo ("1".."3") ou código de fase ("R32"...). */
const STAGE_SEQ = ['1', '2', '3', 'R32', 'R16', 'QF', 'SF', '3P', 'F'];
const stageKey = f => isKnockout(f) ? f.phase : String(f.round);
const stageHead = key => /^\d+$/.test(key) ? 'R' + key : key;   // grupos → R1..R3; fases → código

function viewRound(root) {
  // estágios presentes nos fixtures, na ordem do torneio
  const present = new Set(Object.values(DATA.fixtures).map(stageKey));
  const stages = STAGE_SEQ.filter(k => present.has(k));
  const participants = [...STANDINGS.participants];

  // matriz nome -> estágio -> pontos
  const byStage = {};
  participants.forEach(n => { byStage[n] = {}; stages.forEach(s => byStage[n][s] = 0); });
  Object.keys(STANDINGS.perGame).forEach(gid => {
    const s = stageKey(DATA.fixtures[gid]);
    const game = STANDINGS.perGame[gid];
    Object.keys(game).forEach(name => {
      if (!game[name].pending) byStage[name][s] += game[name].points;
    });
  });

  const ranked = participants
    .map(n => ({ name: n, total: STANDINGS.ranking.find(x => x.name === n).total, stages: byStage[n] }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt'));

  const table = el('table');
  const headCells = [el('th', {}, 'Participante')];
  stages.forEach(s => headCells.push(el('th', { class: 'num', title: /^\d+$/.test(s) ? `Rodada ${s} (grupos)` : phaseName(s) }, stageHead(s))));
  headCells.push(el('th', { class: 'num' }, 'Total'));
  table.append(el('thead', {}, el('tr', {}, ...headCells)));

  const tbody = el('tbody');
  ranked.forEach(p => {
    const cells = [el('td', { class: 'clickable', onclick: () => goParticipant(p.name) }, p.name)];
    stages.forEach(s => cells.push(el('td', { class: 'num' + (p.stages[s] ? '' : ' muted') }, String(p.stages[s]))));
    cells.push(el('td', { class: 'num pts-strong' }, String(p.total)));
    tbody.append(el('tr', {}, ...cells));
  });
  table.append(tbody);
  root.append(table);
  root.append(el('p', { class: 'small muted mt' }, 'Pontos somados por estágio (rodadas de grupos R1–R3 e fases do mata-mata). Apenas jogos já encerrados contam.'));
}

/* ---------------- Router ---------------- */
const VIEWS = { ranking: viewRanking, participant: viewParticipant, game: viewGame, round: viewRound };

function setView(v) { currentView = v; render(); }

function render({ keepScroll = false } = {}) {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === currentView));
  const root = $('#app');
  root.innerHTML = '';
  VIEWS[currentView](root);
  if (!keepScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* Auto-refresh: re-busca resultados E palpites (Supabase) a cada 30s e re-renderiza
   se algo mudou — sem pular o scroll. Re-buscar os palpites faz um jogo que acabou
   de travar aparecer pontuado ao vivo sem o usuário recarregar a página. */
const REFRESH_MS = 30000;
let lastSig = '';

function dataSig(results, liveStatus, bets) {
  return JSON.stringify(results) + '|' + JSON.stringify(liveStatus) + '|' + JSON.stringify(bets);
}

async function refreshLive() {
  try {
    const { results, liveStatus } = await loadResults();
    let bets = DATA.bets;   // se o public_bets cair, mantém o que já temos
    try { bets = mergeBets(DATA.bets, await loadPublicBetsFromSupabase()); }
    catch (err) { console.warn('public_bets indisponível no refresh:', err.message || err); }
    const sig = dataSig(results, liveStatus, bets);
    if (sig === lastSig) return;            // nada novo: não re-renderiza
    lastSig = sig;
    DATA.results = results;
    DATA.liveStatus = liveStatus;
    DATA.bets = bets;
    STANDINGS = computeStandings(DATA);
    render({ keepScroll: true });
  } catch (err) {
    console.warn('refresh falhou:', err.message || err); // silencioso na UI
  }
}

async function init() {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => setView(b.dataset.view)));
  try {
    DATA = await loadData();
    lastSig = dataSig(DATA.results, DATA.liveStatus, DATA.bets);
    STANDINGS = computeStandings(DATA);
    renderSelfTest();
    renderConflicts();
    render();
    setInterval(refreshLive, REFRESH_MS);
  } catch (err) {
    $('#app').innerHTML = '';
    $('#app').append(el('div', { class: 'banner fail' },
      el('strong', {}, 'Erro ao carregar dados: '), String(err.message || err),
      el('p', { class: 'small' }, 'Se você abriu o arquivo direto (file://), use um servidor local — o fetch dos JSON exige http. No GitHub Pages funciona normalmente.')));
  }
}

document.addEventListener('DOMContentLoaded', init);
