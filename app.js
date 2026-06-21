/* ============================================================
   Bolão Copa 2026 — app público (read-only)
   ============================================================ */

const DATA_FILES = ['fixtures', 'config', 'aliases', 'results', 'bets'];
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

async function loadData() {
  const entries = await Promise.all(DATA_FILES.map(async name => {
    const res = await fetch(`data/${name}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Falha ao carregar data/${name}.json (${res.status})`);
    return [name, await res.json()];
  }));
  return Object.fromEntries(entries);
}

function matchLabel(gameId) {
  const f = DATA.fixtures[gameId];
  return `${f.home} x ${f.away}`;
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

function fmtBet(bet) {
  return bet == null ? '—' : `${bet[0]}x${bet[1]}`;
}

function breakdownText(d) {
  if (d.bet == null) return 'não palpitou';
  if (d.exact) return 'placar exato';
  const parts = [];
  const b = d.breakdown;
  if (b.winner) parts.push(`direção +${b.winner}`);
  if (b.goal_difference) parts.push(`saldo +${b.goal_difference}`);
  if (b.goal_bonus_home) parts.push(`gol mandante +${b.goal_bonus_home}`);
  if (b.goal_bonus_away) parts.push(`gol visitante +${b.goal_bonus_away}`);
  return parts.length ? parts.join(' · ') : 'sem acerto';
}

/**
 * Selos dos critérios de desempate para um jogo: Exato / Tendência / Gols venc.
 * Exato já implica os outros, então mostra só "Exato". Caso contrário, mostra
 * os que foram acertados. Retorna um <span> (vazio se nada).
 */
function criteriaChips(d) {
  const wrap = el('span', { class: 'chips' });
  if (d.pending || d.bet == null) return wrap;
  if (d.exact) {
    wrap.append(el('span', { class: 'pill exact', title: 'Cravou o placar' }, 'Exato'));
    return wrap;
  }
  if (d.tendencia) wrap.append(el('span', { class: 'pill tend', title: 'Acertou a direção (vitória/empate)' }, 'Tendência'));
  if (d.golsVencedor) wrap.append(el('span', { class: 'pill gv', title: 'Acertou os gols de quem venceu' }, 'Gols venc.'));
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
      + `"${c.a.name}" ${fmtBet(c.a.bet)} vs "${c.b.name}" ${fmtBet(c.b.bet)}`));
  });
  box.append(el('div', { class: 'banner warn' },
    el('strong', {}, '⚠ Conflito de aliases (resolva nos dados):'), ul));
}

/* ---------------- View: Ranking ---------------- */
function viewRanking(root) {
  const r = STANDINGS.ranking;
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
      el('td', {}, p.name),
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
        el('div', {}, matchLabel(gid)),
        el('div', { class: 'breakdown' }, d.pending ? 'aguardando resultado' : breakdownText(d)),
        criteriaChips(d)),
      el('td', { class: 'num' }, fmtBet(d.bet)),
      el('td', { class: 'num' }, d.result ? `${d.result[0]}x${d.result[1]}` : '—'),
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
  root.append(el('div', { class: 'card' },
    el('h3', {}, `${f.home} x ${f.away}`),
    el('div', { class: 'meta' }, `Grupo ${f.group} · Rodada ${f.round} · ${f.date}`),
    result
      ? el('div', {}, 'Resultado: ', el('strong', { class: 'pts-strong' }, `${result[0]}x${result[1]}`))
      : el('span', { class: 'pill pending' }, 'aguardando resultado')
  ));

  const game = STANDINGS.perGame[selectedGame] || {};
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
      el('td', { class: 'num' }, fmtBet(d.bet)),
      ptsCell
    ));
  });
  table.append(tbody);
  root.append(table);
}

/* ---------------- View: por rodada ---------------- */
function viewRound(root) {
  const rounds = [...new Set(Object.values(DATA.fixtures).map(f => f.round))].sort((a, b) => a - b);
  const participants = [...STANDINGS.participants];

  // matriz nome -> round -> pontos
  const byRound = {};
  participants.forEach(n => { byRound[n] = {}; rounds.forEach(r => byRound[n][r] = 0); });
  Object.keys(STANDINGS.perGame).forEach(gid => {
    const r = DATA.fixtures[gid].round;
    const game = STANDINGS.perGame[gid];
    Object.keys(game).forEach(name => {
      if (!game[name].pending) byRound[name][r] += game[name].points;
    });
  });

  const ranked = participants
    .map(n => ({ name: n, total: STANDINGS.ranking.find(x => x.name === n).total, rounds: byRound[n] }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt'));

  const table = el('table');
  const headCells = [el('th', {}, 'Participante')];
  rounds.forEach(r => headCells.push(el('th', { class: 'num' }, `R${r}`)));
  headCells.push(el('th', { class: 'num' }, 'Total'));
  table.append(el('thead', {}, el('tr', {}, ...headCells)));

  const tbody = el('tbody');
  ranked.forEach(p => {
    const cells = [el('td', { class: 'clickable', onclick: () => goParticipant(p.name) }, p.name)];
    rounds.forEach(r => cells.push(el('td', { class: 'num' + (p.rounds[r] ? '' : ' muted') }, String(p.rounds[r]))));
    cells.push(el('td', { class: 'num pts-strong' }, String(p.total)));
    tbody.append(el('tr', {}, ...cells));
  });
  table.append(tbody);
  root.append(table);
  root.append(el('p', { class: 'small muted mt' }, 'Pontos somados por rodada (1ª/2ª/3ª fase de grupos). Apenas jogos já encerrados contam.'));
}

/* ---------------- Router ---------------- */
const VIEWS = { ranking: viewRanking, participant: viewParticipant, game: viewGame, round: viewRound };

function setView(v) { currentView = v; render(); }

function render() {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === currentView));
  const root = $('#app');
  root.innerHTML = '';
  VIEWS[currentView](root);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function init() {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => setView(b.dataset.view)));
  try {
    DATA = await loadData();
    STANDINGS = computeStandings(DATA);
    renderSelfTest();
    renderConflicts();
    render();
  } catch (err) {
    $('#app').innerHTML = '';
    $('#app').append(el('div', { class: 'banner fail' },
      el('strong', {}, 'Erro ao carregar dados: '), String(err.message || err),
      el('p', { class: 'small' }, 'Se você abriu o arquivo direto (file://), use um servidor local — o fetch dos JSON exige http. No GitHub Pages funciona normalmente.')));
  }
}

document.addEventListener('DOMContentLoaded', init);
