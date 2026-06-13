/* ============================================================
   Bolão Copa 2026 — Admin (lançamento jogo a jogo)
   Gera JSON atualizado para copiar/commitar. Nada é gravado em disco.
   ============================================================ */

const DATA_FILES = ['fixtures', 'config', 'aliases', 'results', 'bets'];
let DATA = null;
let mode = 'bets';

const $ = sel => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const k in props) {
    if (k === 'class') n.className = props[k];
    else if (k === 'html') n.innerHTML = props[k];
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), props[k]);
    else n.setAttribute(k, props[k]);
  }
  for (const kid of kids) { if (kid == null) continue; n.append(kid.nodeType ? kid : document.createTextNode(kid)); }
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

function matchOption(gid) {
  const f = DATA.fixtures[gid];
  return `Jogo ${gid} — ${f.home} x ${f.away} (${f.date})`;
}

function gameSelect(id) {
  const sel = el('select', { id });
  Object.keys(DATA.fixtures).sort((a, b) => +a - +b).forEach(gid =>
    sel.append(el('option', { value: gid }, matchOption(gid))));
  return sel;
}

/** Conhece um nome canônico? (apareceu em bets já resolvido ou é destino de alias) */
function knownCanonicals() {
  const set = new Set();
  const { bets } = resolveBets(DATA.bets, DATA.aliases);
  Object.keys(bets).forEach(g => Object.keys(bets[g]).forEach(n => set.add(n)));
  Object.values(DATA.aliases).forEach(c => set.add(c));
  return set;
}

/** Faz parse de "Nome 2 x 1" / "Nome 2x1" / "Nome 2 X 1" / "Nome 2×1" / "Nome" */
function parseLine(line) {
  const raw = line.trim();
  if (!raw) return null; // linha vazia ignorada
  // captura placar no fim: dígitos sep dígitos
  const m = raw.match(/^(.*?)[\s]+(\d+)\s*[x×X]\s*(\d+)\s*$/);
  if (m) {
    return { name: m[1].trim(), bet: [parseInt(m[2], 10), parseInt(m[3], 10)] };
  }
  // sem placar reconhecido: pode ser só nome (null) OU placar malformado
  // heurística: se tem dígito no fim mas não casou o padrão → malformado
  if (/\d/.test(raw.replace(/^[^\d]*/, ''))) {
    return { name: raw, bet: undefined, malformed: true };
  }
  return { name: raw, bet: null };
}

/* ---------------- Modo: apostas ---------------- */
function renderBetsMode(root) {
  const sel = gameSelect('game');
  const ta = el('textarea', { id: 'input', class: '', placeholder: 'Alexandre Nassif 1x1\nAndres Vera 1x2\nCamilo Thomas' });
  const out = el('div', { id: 'out' });

  root.append(
    el('div', { class: 'controls' }, el('label', { class: 'field' }, 'Jogo'), sel),
    el('div', { class: 'controls' }, el('label', { class: 'field' }, 'Cole uma linha por pessoa: "Nome H x A". Só o nome = não palpitou.'), ta),
    el('div', { class: 'admin-row' },
      el('button', { class: 'btn', onclick: () => processBets() }, 'Gerar JSON'),
      el('button', { class: 'btn secondary', onclick: () => { ta.value = ''; out.innerHTML = ''; } }, 'Limpar')),
    out
  );
}

function processBets() {
  const gid = $('#game').value;
  const lines = $('#input').value.split('\n');
  const known = knownCanonicals();
  const out = $('#out');
  out.innerHTML = '';

  const gameBets = {};        // canonical -> [h,a] | null
  const issues = [];          // {type, msg}
  const seenScreen = {};      // canonical -> nome original que definiu a aposta

  lines.forEach((line, i) => {
    const p = parseLine(line);
    if (p == null) return;
    if (p.malformed) { issues.push({ type: 'bad', msg: `Linha ${i + 1}: placar malformado em "${line.trim()}"` }); return; }
    const canon = canonical(p.name, DATA.aliases);
    if (!known.has(canon)) issues.push({ type: 'warn', msg: `Linha ${i + 1}: nome não reconhecido "${p.name}"${canon !== p.name ? ` → ${canon}` : ''} (novo participante? confira a grafia)` });

    if (!(canon in gameBets)) { gameBets[canon] = p.bet; seenScreen[canon] = p.name; return; }
    const existing = gameBets[canon];
    if (existing == null) { if (p.bet != null) { gameBets[canon] = p.bet; seenScreen[canon] = p.name; } }
    else if (p.bet == null) { /* mantém */ }
    else if (existing[0] === p.bet[0] && existing[1] === p.bet[1]) { /* igual */ }
    else issues.push({ type: 'conflict', msg: `CONFLITO: ${canon} no jogo ${gid} — "${seenScreen[canon]}" ${existing[0]}x${existing[1]} vs "${p.name}" ${p.bet[0]}x${p.bet[1]}` });
  });

  // monta bets.json completo atualizado
  const updated = JSON.parse(JSON.stringify(DATA.bets));
  updated[gid] = sortObj(gameBets);
  const json = JSON.stringify(sortGames(updated), null, 2);

  renderIssues(out, issues);
  const nNomes = Object.keys(gameBets).length;
  out.append(el('p', { class: 'small muted' }, `${nNomes} participante(s) neste jogo. Substitua TODO o conteúdo de data/bets.json pelo texto abaixo.`));
  out.append(jsonOutput(json));
}

/* ---------------- Modo: resultado ---------------- */
function renderResultMode(root) {
  const sel = gameSelect('game');
  const home = el('input', { type: 'text', id: 'rh', inputmode: 'numeric', placeholder: 'gols mandante' });
  const away = el('input', { type: 'text', id: 'ra', inputmode: 'numeric', placeholder: 'gols visitante' });
  const out = el('div', { id: 'out' });

  const labelWrap = el('div', { id: 'rlabel', class: 'small muted' });
  sel.addEventListener('change', () => updateResultLabel());

  root.append(
    el('div', { class: 'controls' }, el('label', { class: 'field' }, 'Jogo'), sel),
    labelWrap,
    el('div', { class: 'admin-row mt' },
      el('div', { style: 'flex:1' }, el('label', { class: 'field' }, 'Gols mandante'), home),
      el('div', { style: 'flex:1' }, el('label', { class: 'field' }, 'Gols visitante'), away)),
    el('div', { class: 'admin-row mt' },
      el('button', { class: 'btn', onclick: () => processResult() }, 'Gerar JSON')),
    out
  );
  updateResultLabel();
}

function updateResultLabel() {
  const gid = $('#game').value;
  const f = DATA.fixtures[gid];
  const existing = DATA.results[gid];
  $('#rlabel').textContent = `${f.home} (mandante) x ${f.away} (visitante)`
    + (existing ? ` · já lançado: ${existing[0]}x${existing[1]}` : ' · ainda sem resultado');
}

function processResult() {
  const gid = $('#game').value;
  const out = $('#out');
  out.innerHTML = '';
  const rhRaw = $('#rh').value.trim(), raRaw = $('#ra').value.trim();
  const issues = [];
  if (!/^\d+$/.test(rhRaw) || !/^\d+$/.test(raRaw)) {
    issues.push({ type: 'bad', msg: 'Placar inválido: informe dois números inteiros (gols mandante e visitante).' });
    renderIssues(out, issues);
    return;
  }
  const updated = JSON.parse(JSON.stringify(DATA.results));
  updated[gid] = [parseInt(rhRaw, 10), parseInt(raRaw, 10)];
  const json = JSON.stringify(sortGames(updated), null, 2);
  const f = DATA.fixtures[gid];
  out.append(el('p', { class: 'small muted' }, `${f.home} ${updated[gid][0]}x${updated[gid][1]} ${f.away}. Substitua TODO o conteúdo de data/results.json pelo texto abaixo.`));
  out.append(jsonOutput(json));
}

/* ---------------- helpers de saída ---------------- */
function sortObj(obj) {
  const o = {};
  Object.keys(obj).sort((a, b) => a.localeCompare(b, 'pt')).forEach(k => o[k] = obj[k]);
  return o;
}
function sortGames(obj) {
  const o = {};
  Object.keys(obj).sort((a, b) => +a - +b).forEach(k => o[k] = obj[k]);
  return o;
}

function renderIssues(out, issues) {
  if (!issues.length) {
    out.append(el('div', { class: 'banner ok' }, '✓ Sem problemas detectados.'));
    return;
  }
  const hard = issues.filter(i => i.type === 'bad' || i.type === 'conflict');
  const soft = issues.filter(i => i.type === 'warn');
  if (hard.length) {
    const ul = el('ul'); hard.forEach(i => ul.append(el('li', {}, i.msg)));
    out.append(el('div', { class: 'banner fail' }, el('strong', {}, 'Problemas que exigem atenção:'), ul));
  }
  if (soft.length) {
    const ul = el('ul'); soft.forEach(i => ul.append(el('li', {}, i.msg)));
    out.append(el('div', { class: 'banner warn' }, el('strong', {}, 'Avisos:'), ul));
  }
}

function jsonOutput(json) {
  const ta = el('textarea', { class: 'code', readonly: 'readonly' });
  ta.value = json;
  const btn = el('button', { class: 'btn mt', onclick: () => copy(json, btn) }, 'Copiar JSON');
  return el('div', {}, ta, el('div', { class: 'spacer' }), btn);
}

function copy(text, btn) {
  const done = () => { const o = btn.textContent; btn.textContent = '✓ Copiado'; setTimeout(() => btn.textContent = o, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const t = document.createElement('textarea');
  t.value = text; document.body.append(t); t.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
  t.remove();
}

/* ---------------- router ---------------- */
function setMode(m) {
  mode = m;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  const root = $('#admin'); root.innerHTML = '';
  (m === 'bets' ? renderBetsMode : renderResultMode)(root);
}

async function init() {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => setMode(b.dataset.mode)));
  try {
    DATA = await loadData();
    setMode('bets');
  } catch (err) {
    $('#admin').innerHTML = '';
    $('#admin').append(el('div', { class: 'banner fail' },
      el('strong', {}, 'Erro ao carregar dados: '), String(err.message || err),
      el('p', { class: 'small' }, 'Use um servidor local (http) — o fetch dos JSON não funciona via file://.')));
  }
}

document.addEventListener('DOMContentLoaded', init);
