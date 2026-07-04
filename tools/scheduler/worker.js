// ============================================================
// Bolão Copa 2026 — Cloudflare Worker (placares quase-realtime)
// A cada 1 min (Cron Trigger), durante a faixa dos jogos, lê fixtures.json +
// teams.aliases.json do repo, consulta a football-data.org (jogos AO VIVO e
// finalizados) e faz UPSERT direto na tabela `results` do Supabase. O site lê
// de lá — sem GitHub Action, sem commit, sem deploy no caminho quente.
//
// Além disso, espelha os jogos FINISHED de volta no data/results.json (backup
// versionado no Git) de forma EVENT-DRIVEN: só commita quando um placar novo/
// diferente entra (ex.: jogo passou de LIVE p/ FINISHED). Sem job periódico,
// sem gastar quota da API (reusa o que já buscou), ~1 commit por jogo finalizado.
//
// Deploy: painel da Cloudflare (Workers & Pages) — ver README.md desta pasta.
// Secrets necessários:
//   GH_PAT                      (fine-grained: repo bolao, Contents=READ-WRITE — lê fixtures/aliases e commita results.json)
//   FOOTBALL_API_KEY            (football-data.org)
//   SUPABASE_URL                (Project URL)
//   SUPABASE_SERVICE_ROLE_KEY   (chave service_role — ignora RLS para escrever)
// Cron Trigger: * * * * *
// ============================================================

const OWNER = '655321ces';
const REPO = 'bolao';
const COMP = 'WC';                         // competição na football-data.org
const ACTIVE_UTC_HOURS = [15, 23, 0, 7];   // gate barato: só consulta de 15:00–07:59 UTC (faixa dos jogos; 15 UTC = 12h BRT)
// Status que viram placar na tabela. ATENÇÃO: o plano free da football-data
// rotula jogo em andamento como 'LIVE' (não IN_PLAY/PAUSED granular). Filtramos
// no código (não no request) p/ não depender do que o filtro da API aceita.
const KEEP_STATUSES = new Set(['LIVE', 'IN_PLAY', 'PAUSED', 'FINISHED']);
const BRT_OFFSET_MIN = 180;   // BRT = UTC-3 (sem horário de verão)
// stage da football-data → código de fase do bolão (presença de phase = mata-mata)
const STAGE_PHASE = { LAST_32: 'R32', LAST_16: 'R16', QUARTER_FINALS: 'QF', SEMI_FINALS: 'SF', THIRD_PLACE: '3P', FINAL: 'F' };

function inActiveHours(d) {
  const h = d.getUTCHours();
  return (h >= ACTIVE_UTC_HOURS[0] && h <= ACTIVE_UTC_HOURS[1]) || (h >= ACTIVE_UTC_HOURS[2] && h <= ACTIVE_UTC_HOURS[3]);
}

// ---------- casamento de times (portado de tools/results/fetch.mjs) ----------
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

function resolveTeam(apiTeam, aliases, fixtureByNorm) {
  if (apiTeam.tla && aliases.byTla[apiTeam.tla]) return aliases.byTla[apiTeam.tla];
  for (const cand of [apiTeam.name, apiTeam.shortName]) {
    if (!cand) continue;
    const n = norm(cand);
    if (aliases.byName[n]) return aliases.byName[n];
    if (fixtureByNorm[n]) return fixtureByNorm[n]; // casa direto com o nome do fixture
  }
  return null;
}

// serializa fixtures preservando o formato compacto (1 jogo por linha) do arquivo
// original — evita reescrever as 72 linhas existentes a cada commit de mata-mata.
function formatFixtures(obj) {
  const ids = Object.keys(obj).sort((a, b) => +a - +b);
  const lines = ids.map((id) => {
    const inner = Object.entries(obj[id]).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ');
    return `  ${JSON.stringify(id)}: { ${inner} }`;
  });
  return '{\n' + lines.join(',\n') + '\n}\n';
}

// instante UTC (ISO) → string BRT "dd/mm HHh[MM]" (mesmo formato dos fixtures de grupo)
function toBrtDate(iso) {
  const d = new Date(new Date(iso).getTime() - BRT_OFFSET_MIN * 60000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = d.getUTCMinutes();
  return min ? `${dd}/${mm} ${hh}h${String(min).padStart(2, '0')}` : `${dd}/${mm} ${hh}h`;
}

// ---------- seleção de fixtures de mata-mata (pura; testável) ----------
// Varre os `matches`, fica só com os de mata-mata (STAGE_PHASE) e CONFRONTOS JÁ
// RESOLVIDOS (os dois times casam com algum fixture; placeholder → resolveTeam null).
// Idempotente por conjunto de times (não renumera); atualiza só se a data mudou.
// Aceita a ordem mandante×visitante da football-data (home = m.homeTeam).
// Retorna { added:[{gid,home,away,date,phase,utcDate}], updated:[...] } sem mutar fixtures.
function selectKnockoutFixtures(matches, fixtures, aliases, fixtureByNorm) {
  const bySet = {};   // "a|b" -> { gid, date } dos fixtures de mata-mata existentes
  let maxGid = 0;
  for (const gid of Object.keys(fixtures)) {
    maxGid = Math.max(maxGid, +gid);
    const f = fixtures[gid];
    if (f && f.phase) bySet[[norm(f.home), norm(f.away)].sort().join('|')] = { gid: +gid, date: f.date };
  }

  const ko = (matches || [])
    .filter((m) => m && STAGE_PHASE[m.stage])
    .slice()
    .sort((a, b) => String(a.utcDate || '').localeCompare(String(b.utcDate || '')) || ((a.id || 0) - (b.id || 0)));

  const added = [];
  const updated = [];
  let nextGid = maxGid + 1;
  for (const m of ko) {
    const hn = resolveTeam(m.homeTeam || {}, aliases, fixtureByNorm);
    const an = resolveTeam(m.awayTeam || {}, aliases, fixtureByNorm);
    if (!hn || !an) continue;   // confronto ainda não definido (placeholder não resolve)
    const key = [norm(hn), norm(an)].sort().join('|');
    const date = toBrtDate(m.utcDate);
    const phase = STAGE_PHASE[m.stage];
    const existing = bySet[key];
    if (!existing) {
      const gid = nextGid++;
      added.push({ gid, home: hn, away: an, date, phase, utcDate: m.utcDate });
      bySet[key] = { gid, date };
    } else if (existing.date !== date) {
      updated.push({ gid: existing.gid, home: hn, away: an, date, phase, utcDate: m.utcDate });
      bySet[key].date = date;
    }
  }
  return { added, updated };
}

// ---------- leitura/escrita do repo via API do GitHub (dados frescos) ----------
function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GH_PAT}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'bolao-scheduler',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// retorna { json, sha } — o sha é necessário para commitar (PUT) por cima
async function ghGetFile(path, env) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=main`, { headers: ghHeaders(env) });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  const meta = await r.json();
  const bin = atob(meta.content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return { json: JSON.parse(new TextDecoder().decode(bytes)), sha: meta.sha }; // decodifica UTF-8 (acentos)
}

async function ghContentsJSON(path, env) {
  return (await ghGetFile(path, env)).json;
}

// base64 de uma string UTF-8 (btoa só lida com latin1 → encode primeiro)
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function ghPutFile(path, contentStr, sha, message, env) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64Utf8(contentStr),
      sha,
      branch: 'main',
      committer: { name: 'bolao-bot', email: 'github-actions[bot]@users.noreply.github.com' },
    }),
  });
  if (!r.ok) throw new Error(`PUT ${path} -> ${r.status}: ${await r.text()}`);
}

// ---------- escrita no Supabase (upsert REST, mesmo padrão de export-bets.mjs) ----------
async function supaUpsert(rows, env) {
  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/rest/v1/results`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates', // upsert pela PK (game_id)
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`upsert -> ${r.status}: ${await r.text()}`);
}

// upsert na tabela `games` (mesma chave/serviço; usado p/ semear os jogos de mata-mata)
async function supaUpsertGames(rows, env) {
  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/rest/v1/games`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates', // upsert pela PK (id)
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`upsert games -> ${r.status}: ${await r.text()}`);
}

async function tick(env) {
  const now = new Date();
  if (!inActiveHours(now)) return { skipped: 'fora da faixa' };

  const [fixturesFile, aliases, resultsFile] = await Promise.all([
    ghGetFile('data/fixtures.json', env),   // { json, sha } — sha p/ commitar novos jogos de mata-mata
    ghContentsJSON('tools/results/teams.aliases.json', env),
    ghGetFile('data/results.json', env),    // { json, sha } — para o espelho event-driven
  ]);
  const fixtures = fixturesFile.json;

  // índices do fixture (mesma construção do fetch.mjs)
  const fixtureByNorm = {};
  const fixtureBySet = {};   // "a|b" (chaves ordenadas) -> gid
  for (const gid of Object.keys(fixtures)) {
    const f = fixtures[gid];
    fixtureByNorm[norm(f.home)] = f.home;
    fixtureByNorm[norm(f.away)] = f.away;
    fixtureBySet[[norm(f.home), norm(f.away)].sort().join('|')] = gid;
  }

  // todos os jogos da competição; filtramos por status no código (ver KEEP_STATUSES)
  const url = `https://api.football-data.org/v4/competitions/${COMP}/matches`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': env.FOOTBALL_API_KEY } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`football-data ${res.status}: token inválido ou plano sem acesso a ${COMP}`);
  }
  if (!res.ok) throw new Error(`football-data ${res.status}`);
  const data = await res.json();
  const matches = data.matches || [];

  const now2 = new Date().toISOString();
  const rows = [];
  const finished = {};   // gid -> [h,a] dos FINISHED (p/ espelhar no results.json)
  const unresolved = [];
  for (const m of matches) {
    if (!KEEP_STATUSES.has(m.status)) continue;  // pula TIMED/SCHEDULED/adiados/cancelados
    const sc = m.score || {};
    const ft = sc.fullTime;                      // durante o jogo, fullTime carrega o placar corrente
    if (!ft || ft.home == null || ft.away == null) continue;
    const hn = resolveTeam(m.homeTeam, aliases, fixtureByNorm);
    const an = resolveTeam(m.awayTeam, aliases, fixtureByNorm);
    if (!hn || !an) { unresolved.push(`${m.homeTeam && m.homeTeam.name} x ${m.awayTeam && m.awayTeam.name}`); continue; }
    const gid = fixtureBySet[[norm(hn), norm(an)].sort().join('|')];
    if (!gid) { unresolved.push(`sem fixture: ${hn} x ${an}`); continue; }

    const f = fixtures[gid];
    // placar base: em pênaltis (mata-mata), fullTime vem somado com a disputa SÓ
    // enquanto a API não processa o jogo — depois ela normaliza e fullTime volta a
    // ser o placar nivelado. Como o nivelado é EMPATADO por definição: fullTime
    // desempatado = somado (subtrai os pênaltis); empatado = já nivelado (usa direto).
    const pen = sc.duration === 'PENALTY_SHOOTOUT' || (sc.penalties && sc.penalties.home != null);
    let base = [ft.home, ft.away];
    if (pen && sc.penalties && sc.penalties.home != null && ft.home !== ft.away) base = [ft.home - sc.penalties.home, ft.away - sc.penalties.away];
    // reorienta para a ordem mandante×visitante do fixture
    const apiHomeIsFixtureHome = norm(f.home) === norm(hn);
    const score = apiHomeIsFixtureHome ? [base[0], base[1]] : [base[1], base[0]];
    // rede de segurança: placar fora do check (0-99) do banco não entra no batch —
    // uma linha inconsistente da API não pode derrubar o upsert dos demais jogos
    if (score[0] < 0 || score[0] > 99 || score[1] < 0 || score[1] > 99) {
      unresolved.push(`placar inconsistente: ${hn} x ${an} (${score.join('x')}, ft ${ft.home}x${ft.away}, pen ${sc.penalties && sc.penalties.home}x${sc.penalties && sc.penalties.away})`);
      continue;
    }
    // quem avança nos pênaltis: só mata-mata (f.phase), jogo finalizado e empatado
    let advances = null;
    if (f.phase && m.status === 'FINISHED' && pen && score[0] === score[1]) {
      const winnerSide = sc.winner === 'HOME_TEAM' ? 'home' : sc.winner === 'AWAY_TEAM' ? 'away' : null;
      if (winnerSide) advances = apiHomeIsFixtureHome ? winnerSide : (winnerSide === 'home' ? 'away' : 'home');
    }
    rows.push({
      game_id: +gid,
      home: score[0],
      away: score[1],
      status: m.status,
      minute: m.minute == null ? null : m.minute,
      advances,
      updated_at: now2,
    });
    if (m.status === 'FINISHED') finished[gid] = advances ? [score[0], score[1], advances] : [score[0], score[1]];
  }

  // caminho quente: Supabase (LIVE + FINISHED)
  let upserted = 0;
  if (rows.length) { await supaUpsert(rows, env); upserted = rows.length; }

  // espelho event-driven: só commita results.json quando um FINISHED entra/muda
  /** @type {false | number[] | string} */
  let committed = false;
  try {
    const merged = { ...resultsFile.json };
    const changed = [];
    for (const gid of Object.keys(finished)) {
      const s = finished[gid], prev = merged[gid];
      if (!prev || prev[0] !== s[0] || prev[1] !== s[1] || (prev[2] || null) !== (s[2] || null)) { merged[gid] = s; changed.push(+gid); }
    }
    if (changed.length) {
      const sorted = {};
      for (const gid of Object.keys(merged).sort((a, b) => +a - +b)) sorted[gid] = merged[gid];
      const text = JSON.stringify(sorted, null, 2) + '\n';
      changed.sort((a, b) => a - b);
      await ghPutFile('data/results.json', text, resultsFile.sha, `Resultados: jogo(s) ${changed.join(',')} (Cloudflare Worker)`, env);
      committed = changed;
    }
  } catch (e) {
    committed = 'erro: ' + e.message;   // não derruba o caminho quente (Supabase já foi)
  }

  // população event-driven dos fixtures de mata-mata: confrontos já resolvidos
  // entram em fixtures.json + tabela games. Isolado em try/catch (não derruba o resto).
  /** @type {false | { added: number[], updated: number[] } | string} */
  let fixturesOut = false;
  try {
    const { added, updated } = selectKnockoutFixtures(matches, fixtures, aliases, fixtureByNorm);
    const changes = [...added, ...updated];
    if (changes.length) {
      const merged = { ...fixtures };
      for (const c of changes) merged[c.gid] = { home: c.home, away: c.away, date: c.date, phase: c.phase };
      const text = formatFixtures(merged);
      const gids = changes.map((c) => c.gid).sort((a, b) => a - b);
      await ghPutFile('data/fixtures.json', text, fixturesFile.sha, `Fixtures: jogo(s) ${gids.join(',')} (mata-mata, Cloudflare Worker)`, env);
      // semeia em games (kickoff/locks_at = utcDate; round/grp nulos no mata-mata)
      const gameRows = changes.map((c) => ({ id: c.gid, home: c.home, away: c.away, kickoff: c.utcDate, locks_at: c.utcDate, round: null, grp: null, phase: c.phase }));
      await supaUpsertGames(gameRows, env);
      fixturesOut = { added: added.map((c) => c.gid), updated: updated.map((c) => c.gid) };
    }
  } catch (e) {
    fixturesOut = 'erro: ' + e.message;
  }

  return { upserted, games: rows.map((r) => r.game_id), unresolved, committed, fixtures: fixturesOut };
}

// exports nomeados p/ teste sintético / preview em Node (não afetam o Worker em produção)
export { toBrtDate, formatFixtures, selectKnockoutFixtures, resolveTeam, norm, STAGE_PHASE };

export default {
  // disparado pelo Cron Trigger (* * * * *)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).then((x) => console.log('tick', JSON.stringify(x))).catch((e) => console.log('erro', e.message)));
  },
  // GET no *.workers.dev p/ testar manualmente
  async fetch(request, env) {
    try {
      const out = await tick(env);
      return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response('erro: ' + e.message, { status: 500 });
    }
  },
};
