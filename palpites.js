/* ============================================================
   Bolão Copa 2026 — entrada de palpites (login Google + Supabase)
   ------------------------------------------------------------
   Camada NOVA e paralela. Não toca em index.html / app.js / data/bets.json.
   A trava de horário e a visibilidade são impostas pelo RLS (ver
   supabase/schema.sql); aqui o bloqueio dos campos é só conforto de UI.
   ============================================================ */

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

function banner(kind, ...content) {
  return el('div', { class: `banner ${kind}` }, ...content);
}

/* data UTC do Supabase → "dd/mm HH:MM" no fuso de Brasília */
function fmtBRT(iso) {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
}

const isOpen = game => Date.now() < new Date(game.locks_at).getTime();

/* ---------------- estado ---------------- */
let sb = null;       // cliente Supabase
let USER = null;     // usuário logado
let GAMES = [];      // jogos ordenados por kickoff
let MYBETS = {};     // game_id -> {home, away}

/* ---------------- config / cliente ---------------- */
function configMissing() {
  const c = window.SUPABASE_CONFIG;
  return !c || !c.url || !c.anonKey ||
    c.url.includes('SEU-PROJETO') || c.anonKey.includes('COLE_AQUI');
}

/* ---------------- auth ---------------- */
function renderAuth() {
  const box = $('#auth');
  box.innerHTML = '';
  if (USER) {
    const name = USER.user_metadata?.full_name || USER.user_metadata?.name || USER.email;
    box.append(el('div', { class: 'admin-row', style: 'justify-content:space-between;align-items:center' },
      el('span', { class: 'muted small' }, `Conectado como `, el('strong', {}, name)),
      el('button', { class: 'btn secondary', onclick: doLogout }, 'Sair')
    ));
  } else {
    box.append(
      el('button', { class: 'btn', onclick: doLogin }, 'Entrar com Google'),
      el('p', { class: 'small muted mt' }, 'Seu palpite fica salvo na sua conta. Editável até o apito de cada jogo.')
    );
  }
}

async function doLogin() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href.split('#')[0] },
  });
  if (error) showStatus('fail', 'Erro ao entrar: ' + error.message);
}

async function doLogout() {
  await sb.auth.signOut();
  USER = null;
  MYBETS = {};
  renderAuth();
  renderGames();
}

function showStatus(kind, msg) {
  const box = $('#status');
  box.innerHTML = '';
  if (msg) box.append(banner(kind, msg));
}

/* ---------------- dados ---------------- */
async function loadGames() {
  const { data, error } = await sb.from('games').select('*').order('kickoff', { ascending: true });
  if (error) throw error;
  GAMES = data || [];
}

async function loadMyBets() {
  MYBETS = {};
  if (!USER) return;
  const { data, error } = await sb.from('bets').select('game_id, home, away').eq('user_id', USER.id);
  if (error) throw error;
  for (const b of data || []) MYBETS[b.game_id] = { home: b.home, away: b.away };
}

async function saveBet(game, homeInput, awayInput, statusEl) {
  const h = homeInput.value.trim(), a = awayInput.value.trim();
  if (h === '' || a === '') { statusEl.textContent = 'preencha os dois placares'; statusEl.className = 'small'; return; }
  const home = parseInt(h, 10), away = parseInt(a, 10);
  if (!(home >= 0 && away >= 0)) { statusEl.textContent = 'placar inválido'; statusEl.className = 'small'; return; }

  statusEl.textContent = 'salvando…'; statusEl.className = 'small muted';
  const { error } = await sb.from('bets').upsert(
    { user_id: USER.id, game_id: game.id, home, away },
    { onConflict: 'user_id,game_id' }
  );
  if (error) {
    // RLS recusa se o jogo já travou (now() >= locks_at)
    statusEl.textContent = 'não salvou — jogo já fechado? (' + error.message + ')';
    statusEl.className = 'small'; statusEl.style.color = 'var(--bad)';
    return;
  }
  MYBETS[game.id] = { home, away };
  statusEl.textContent = '✓ salvo'; statusEl.className = 'small'; statusEl.style.color = 'var(--accent)';
}

/* ---------------- render ---------------- */
function gameLabel(g) { return `${g.home} x ${g.away}`; }

function openGameCard(g) {
  const mine = MYBETS[g.id];
  const card = el('div', { class: 'card' });
  card.append(
    el('h3', {}, gameLabel(g)),
    el('div', { class: 'meta' }, `Grupo ${g.grp} · Rodada ${g.round} · ${fmtBRT(g.kickoff)}`)
  );
  const inH = el('input', { type: 'number', min: '0', max: '99', inputmode: 'numeric',
    style: 'width:64px;text-align:center', value: mine ? String(mine.home) : '' });
  const inA = el('input', { type: 'number', min: '0', max: '99', inputmode: 'numeric',
    style: 'width:64px;text-align:center', value: mine ? String(mine.away) : '' });
  const status = el('span', { class: 'small muted' }, mine ? '✓ salvo' : '');
  const btn = el('button', { class: 'btn', onclick: () => saveBet(g, inH, inA, status) }, 'Salvar');

  card.append(el('div', { class: 'admin-row', style: 'align-items:center' },
    el('span', { class: 'small muted', style: 'min-width:62px' }, g.home),
    inH, el('span', { class: 'muted' }, '×'), inA,
    el('span', { class: 'small muted', style: 'min-width:62px' }, g.away),
    btn
  ));
  card.append(el('div', { style: 'margin-top:6px' }, status));
  return card;
}

function lockedRow(g) {
  const mine = MYBETS[g.id];
  return el('tr', {},
    el('td', {}, el('div', {}, gameLabel(g)),
      el('div', { class: 'breakdown' }, `${fmtBRT(g.kickoff)} · fechado`)),
    el('td', { class: 'num' }, mine ? `${mine.home}x${mine.away}` : '—')
  );
}

function renderGames() {
  const root = $('#app');
  root.innerHTML = '';
  if (!USER) {
    root.append(el('p', { class: 'center muted mt' }, 'Entre com o Google para palpitar.'));
    return;
  }
  const open = GAMES.filter(isOpen);
  const locked = GAMES.filter(g => !isOpen(g));

  root.append(el('h2', { style: 'font-size:1rem;margin:8px 0' }, `Abertos para palpite (${open.length})`));
  if (open.length === 0) root.append(el('p', { class: 'muted small' }, 'Nenhum jogo aberto agora.'));
  open.forEach(g => root.append(openGameCard(g)));

  if (locked.length) {
    root.append(el('h2', { style: 'font-size:1rem;margin:18px 0 8px' }, `Fechados (${locked.length})`));
    const table = el('table');
    table.append(el('thead', {}, el('tr', {}, el('th', {}, 'Jogo'), el('th', { class: 'num' }, 'Seu palpite'))));
    const tb = el('tbody');
    locked.forEach(g => tb.append(lockedRow(g)));
    table.append(tb);
    root.append(table);
  }
}

/* ---------------- init ---------------- */
async function refreshSession() {
  const { data } = await sb.auth.getSession();
  USER = data.session?.user || null;
}

async function init() {
  if (configMissing()) {
    $('#app').innerHTML = '';
    $('#auth').innerHTML = '';
    $('#app').append(banner('warn',
      el('strong', {}, 'Supabase não configurado. '),
      'Preencha url e anonKey em ', el('code', {}, 'supabase-config.js'),
      ' (veja ', el('code', {}, 'supabase/SETUP.md'), ').'));
    return;
  }
  sb = supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

  sb.auth.onAuthStateChange((_event, session) => {
    USER = session?.user || null;
    renderAuth();
  });

  try {
    await refreshSession();
    await loadGames();
    await loadMyBets();
    renderAuth();
    renderGames();
  } catch (err) {
    showStatus('fail', 'Erro ao carregar: ' + (err.message || err));
  }
}

document.addEventListener('DOMContentLoaded', init);
