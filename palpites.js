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
let ROSTER = [];     // [{canonical_name, claimed_by}]
let MYNAME = null;   // nome canônico já reivindicado por mim (ou null)
let HISTBETS = {};   // data/bets.json (histórico) — fallback dos jogos já fechados
let ALIASES = {};    // data/aliases.json — resolve nomes-de-tela para o canônico
let RESULTS = {};    // data/results.json — resultados reais (pontuação dos fechados)
let CONFIG = null;   // data/config.json — regras de pontuação (engine.score)

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
  ROSTER = [];
  MYNAME = null;
  renderAuth();
  renderMain();
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
  const { data, error } = await sb.from('bets').select('game_id, home, away, advances').eq('user_id', USER.id);
  if (error) throw error;
  for (const b of data || []) MYBETS[b.game_id] = { home: b.home, away: b.away, advances: b.advances || null };
}

// histórico estático (mesma fonte do ranking público): bets.json + aliases.json.
// Independe de login; serve de fallback para mostrar o palpite em jogos já fechados.
async function loadStatic() {
  try {
    const [b, a, r, c] = await Promise.all([
      fetch('data/bets.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}),
      fetch('data/aliases.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}),
      fetch('data/results.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}),
      fetch('data/config.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
    ]);
    HISTBETS = b || {}; ALIASES = a || {}; RESULTS = r || {}; CONFIG = c;
  } catch { HISTBETS = {}; ALIASES = {}; RESULTS = {}; CONFIG = null; }
}

// meu palpite para um jogo: Supabase tem prioridade; senão cai no histórico
// (casando MYNAME direto ou via alias de nome-de-tela). Em empate de mata-mata,
// carrega o 3º elemento (lado que passa).
function myBetFor(g) {
  const cur = MYBETS[g.id];
  if (cur) return cur.advances ? [cur.home, cur.away, cur.advances] : [cur.home, cur.away];
  const game = HISTBETS[g.id];
  if (game) {
    if (Array.isArray(game[MYNAME])) return game[MYNAME];
    for (const k of Object.keys(game)) {
      if ((ALIASES[k] || k) === MYNAME && Array.isArray(game[k])) return game[k];
    }
  }
  return null;
}

/* ---------------- pontuação dos jogos fechados ----------------
   fmtBet/breakdownText/criteriaList/gameDetail vêm do engine.js (fonte única).
   Aqui só o render em DOM dos selos de desempate (chips). */
function criteriaChips(d) {
  const wrap = el('span', { class: 'chips' });
  for (const c of criteriaList(d)) wrap.append(el('span', { class: `pill ${c.cls}`, title: c.title }, c.label));
  return wrap;
}

async function loadRoster() {
  ROSTER = []; MYNAME = null;
  if (!USER) return;
  const { data, error } = await sb.from('roster').select('canonical_name, claimed_by').order('canonical_name');
  if (error) throw error;
  ROSTER = data || [];
  const mine = ROSTER.find(r => r.claimed_by === USER.id);
  MYNAME = mine ? mine.canonical_name : null;
}

async function claimIdentity(name, statusEl) {
  statusEl.textContent = 'confirmando…'; statusEl.className = 'small muted'; statusEl.style.color = '';
  const { error } = await sb.rpc('claim_identity', { p_name: name });
  if (error) {
    statusEl.textContent = 'não deu: ' + error.message;
    statusEl.className = 'small'; statusEl.style.color = 'var(--bad)';
    return;
  }
  await loadRoster();
  renderMain();
}

async function saveBet(game, homeInput, awayInput, statusEl, advances = null) {
  const h = homeInput.value.trim(), a = awayInput.value.trim();
  if (h === '' || a === '') { statusEl.textContent = 'preencha os dois placares'; statusEl.className = 'small'; return; }
  const home = parseInt(h, 10), away = parseInt(a, 10);
  if (!(home >= 0 && away >= 0)) { statusEl.textContent = 'placar inválido'; statusEl.className = 'small'; return; }

  // empate de mata-mata exige escolher quem passa nos pênaltis
  const needAdv = isKnockout(game) && home === away;
  if (needAdv && !advances) { statusEl.textContent = 'escolha quem passa nos pênaltis'; statusEl.className = 'small'; statusEl.style.color = 'var(--bad)'; return; }
  const adv = needAdv ? advances : null;   // só guarda em empate de mata-mata

  statusEl.textContent = 'salvando…'; statusEl.className = 'small muted'; statusEl.style.color = '';
  const { error } = await sb.from('bets').upsert(
    { user_id: USER.id, game_id: game.id, home, away, advances: adv },
    { onConflict: 'user_id,game_id' }
  );
  if (error) {
    // RLS recusa se o jogo já travou (now() >= locks_at)
    statusEl.textContent = 'não salvou — jogo já fechado? (' + error.message + ')';
    statusEl.className = 'small'; statusEl.style.color = 'var(--bad)';
    return;
  }
  MYBETS[game.id] = { home, away, advances: adv };
  statusEl.textContent = '✓ salvo'; statusEl.className = 'small'; statusEl.style.color = 'var(--accent)';
}

/* ---------------- bandeiras (mapa FLAG vem do engine.js) ---------------- */
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

/* ---------------- render ---------------- */
function gameLabel(g) { return `${g.home} x ${g.away}`; }

/* Rótulo do estágio: fase do mata-mata, ou "Grupo X · Rodada Y" na fase de grupos.
   isKnockout/phaseName vêm do engine.js (a linha do Supabase traz `phase`). */
function stageLabel(g) { return isKnockout(g) ? phaseName(g.phase) : `Grupo ${g.grp} · Rodada ${g.round}`; }

function labelWithFlags(g) {
  return el('span', { style: 'display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap' },
    flagImg(g.home), el('span', {}, g.home),
    el('span', { class: 'muted' }, 'x'),
    el('span', {}, g.away), flagImg(g.away));
}

function openGameCard(g) {
  const mine = MYBETS[g.id];
  const knockout = isKnockout(g);
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'meta' }, `${stageLabel(g)} · ${fmtBRT(g.kickoff)}`));
  const numStyle = 'width:48px;text-align:center';
  const status = el('span', { class: 'small muted' }, mine ? '✓ salvo' : '');

  let advSide = mine ? (mine.advances || null) : null;   // lado escolhido p/ pênaltis (mata-mata)

  // empate em mata-mata? (precisa dos dois placares preenchidos e iguais)
  const isDraw = () => inH.value.trim() !== '' && inA.value.trim() !== '' && parseInt(inH.value, 10) === parseInt(inA.value, 10);

  // botões "quem passa" (só aparecem em empate de mata-mata)
  const advRow = el('div', { class: 'admin-row', style: 'align-items:center;gap:8px;margin-top:8px;display:none' });
  const advBtn = (side, team) => el('button', {
    class: 'btn secondary' + (advSide === side ? ' active' : ''),
    onclick: () => { advSide = side; syncAdv(); autoSave(); },
  }, flagImg(team), ' ', team);
  let btnHome, btnAway;
  function rebuildAdvBtns() {
    advRow.innerHTML = '';
    btnHome = advBtn('home', g.home);
    btnAway = advBtn('away', g.away);
    advRow.append(el('span', { class: 'small muted' }, 'Passa nos pênaltis:'), btnHome, btnAway);
  }
  function syncAdv() {
    const draw = knockout && isDraw();
    advRow.style.display = draw ? 'flex' : 'none';
    if (!draw) advSide = null;
    if (draw) rebuildAdvBtns();
  }

  // auto-salva quando os dois lados estão preenchidos (guarda contra salvar pela metade)
  const autoSave = () => {
    if (inH.value.trim() === '' || inA.value.trim() === '') return;
    if (knockout && isDraw() && !advSide) { status.textContent = 'escolha quem passa nos pênaltis'; status.className = 'small'; status.style.color = 'var(--bad)'; return; }
    saveBet(g, inH, inA, status, advSide);
  };
  const onScore = () => { syncAdv(); autoSave(); };
  const inH = el('input', { type: 'number', min: '0', max: '99', inputmode: 'numeric', class: 'score-input', style: numStyle, value: mine ? String(mine.home) : '', onchange: onScore });
  const inA = el('input', { type: 'number', min: '0', max: '99', inputmode: 'numeric', class: 'score-input', style: numStyle, value: mine ? String(mine.away) : '', onchange: onScore });
  const btn = el('button', { class: 'btn', onclick: autoSave }, 'Salvar');

  card.append(el('div', { style: 'display:flex;align-items:center;gap:6px' },
    el('span', { class: 'small', style: 'flex:1;display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0' },
      flagImg(g.home), g.home),
    inH, el('span', { class: 'muted' }, '×'), inA,
    el('span', { class: 'small', style: 'flex:1;display:flex;align-items:center;justify-content:flex-start;gap:6px;min-width:0' },
      g.away, flagImg(g.away))
  ));
  card.append(advRow);
  card.append(el('div', { class: 'admin-row', style: 'align-items:center;margin-top:8px' }, btn, status));
  syncAdv();   // estado inicial (revela os botões se já há empate salvo)
  return card;
}

function lockedRow(g) {
  const bet = myBetFor(g);
  const result = RESULTS[g.id] || null;
  const d = gameDetail(bet, result, CONFIG, g);
  const ptsCell = d.pending
    ? el('td', { class: 'num' }, el('span', { class: 'pill pending' }, '—'))
    : el('td', { class: 'num' }, el('span', { class: 'score-chip' + (d.points ? ' pts-strong' : ' muted') }, String(d.points)));
  return el('tr', {},
    el('td', {}, labelWithFlags(g),
      el('div', { class: 'breakdown' }, `${fmtBRT(g.kickoff)} · fechado`),
      d.pending ? null : el('div', { class: 'breakdown' }, breakdownText(d)),
      criteriaChips(d)),
    el('td', { class: 'num' }, fmtBet(bet)),
    el('td', { class: 'num' }, resultText(result)),
    ptsCell
  );
}

/* Resultado formatado "HxA", com "(passa: <lado>)" quando decidido nos pênaltis. */
function resultText(result) {
  if (!result) return '—';
  const adv = advancerLabel(advancerOf(result));
  return adv ? `${result[0]}x${result[1]} (passa: ${adv})` : `${result[0]}x${result[1]}`;
}

function renderClaim(root) {
  const free = ROSTER.filter(r => !r.claimed_by).map(r => r.canonical_name);
  const card = el('div', { class: 'card' });
  card.append(
    el('h3', {}, 'Quem é você?'),
    el('div', { class: 'meta' }, 'Escolha seu nome na lista do bolão. Isso liga sua conta Google ao seu histórico no ranking.')
  );
  if (!free.length) {
    card.append(el('p', { class: 'muted small' }, 'Todos os nomes já foram reivindicados. Se algum está errado, fale com o operador.'));
    root.append(card);
    return;
  }
  const sel = el('select');
  sel.append(el('option', { value: '' }, '— selecione —'));
  free.forEach(n => sel.append(el('option', { value: n }, n)));
  const status = el('span', { class: 'small muted' });
  const btn = el('button', { class: 'btn', onclick: () => {
    if (sel.value) claimIdentity(sel.value, status);
    else { status.textContent = 'escolha um nome'; status.style.color = ''; }
  } }, 'Confirmar');
  card.append(
    el('div', { class: 'controls' }, el('label', { class: 'field' }, 'Seu nome'), sel),
    el('div', { class: 'admin-row', style: 'align-items:center' }, btn, status)
  );
  root.append(card);
}

function renderMain() {
  const root = $('#app');
  root.innerHTML = '';
  if (!USER) {
    root.append(el('p', { class: 'center muted mt' }, 'Entre com o Google para palpitar.'));
    return;
  }
  if (!MYNAME) { renderClaim(root); return; }
  renderGames(root);
}

function renderGames(root) {
  root.append(el('p', { class: 'small muted', style: 'margin:4px 0 12px' }, 'Você é: ', el('strong', {}, MYNAME)));
  const open = GAMES.filter(isOpen);
  const locked = GAMES.filter(g => !isOpen(g));

  root.append(el('h2', { style: 'font-size:1rem;margin:8px 0' }, `Abertos para palpite (${open.length})`));
  if (open.length === 0) root.append(el('p', { class: 'muted small' }, 'Nenhum jogo aberto agora.'));
  open.forEach(g => root.append(openGameCard(g)));

  if (locked.length) {
    root.append(el('h2', { style: 'font-size:1rem;margin:18px 0 8px' }, `Fechados (${locked.length})`));
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Jogo'),
      el('th', { class: 'num' }, 'Palpite'),
      el('th', { class: 'num' }, 'Resultado'),
      el('th', { class: 'num' }, 'Pts')
    )));
    const tb = el('tbody');
    locked.forEach(g => tb.append(lockedRow(g)));
    table.append(tb);
    root.append(table);
    if (CONFIG) {
      root.append(el('p', { class: 'small muted mt' },
        `Pontuação: placar exato = ${CONFIG.exact}; direção +${CONFIG.winner}, saldo +${CONFIG.goal_difference}, `
        + `gol mandante/visitante +${CONFIG.goal_bonus_home} (teto ${CONFIG.ceiling}).`));
    }
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
    if (USER) await sb.rpc('ensure_profile'); // recria o profile se faltar (auto-cura)
    await loadStatic();
    await loadGames();
    await loadMyBets();
    await loadRoster();
    renderAuth();
    renderMain();
  } catch (err) {
    showStatus('fail', 'Erro ao carregar: ' + (err.message || err));
  }
}

document.addEventListener('DOMContentLoaded', init);
