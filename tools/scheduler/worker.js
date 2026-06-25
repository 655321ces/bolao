// ============================================================
// Bolão Copa 2026 — Cloudflare Worker (placares quase-realtime)
// A cada 1 min (Cron Trigger), durante a faixa dos jogos, lê fixtures.json +
// teams.aliases.json do repo, consulta a football-data.org (jogos AO VIVO e
// finalizados) e faz UPSERT direto na tabela `results` do Supabase. O site lê
// de lá — sem GitHub Action, sem commit, sem deploy no caminho quente.
//
// Deploy: painel da Cloudflare (Workers & Pages) — ver README.md desta pasta.
// Secrets necessários:
//   GH_PAT                      (fine-grained: repo bolao, Contents=RO — lê fixtures/aliases)
//   FOOTBALL_API_KEY            (football-data.org)
//   SUPABASE_URL                (Project URL)
//   SUPABASE_SERVICE_ROLE_KEY   (chave service_role — ignora RLS para escrever)
// Cron Trigger: * * * * *
// ============================================================

const OWNER = '655321ces';
const REPO = 'bolao';
const COMP = 'WC';                         // competição na football-data.org
const ACTIVE_UTC_HOURS = [17, 23, 0, 7];   // gate barato: só consulta de 17:00–07:59 UTC (faixa dos jogos)
// Status que viram placar na tabela. ATENÇÃO: o plano free da football-data
// rotula jogo em andamento como 'LIVE' (não IN_PLAY/PAUSED granular). Filtramos
// no código (não no request) p/ não depender do que o filtro da API aceita.
const KEEP_STATUSES = new Set(['LIVE', 'IN_PLAY', 'PAUSED', 'FINISHED']);

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

// ---------- leitura do repo via API do GitHub (dados frescos) ----------
function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GH_PAT}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'bolao-scheduler',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghContentsJSON(path, env) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=main`, { headers: ghHeaders(env) });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  const meta = await r.json();
  const bin = atob(meta.content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)); // decodifica UTF-8 (acentos)
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

async function tick(env) {
  const now = new Date();
  if (!inActiveHours(now)) return { skipped: 'fora da faixa' };

  const [fixtures, aliases] = await Promise.all([
    ghContentsJSON('data/fixtures.json', env),
    ghContentsJSON('tools/results/teams.aliases.json', env),
  ]);

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
  const unresolved = [];
  for (const m of matches) {
    if (!KEEP_STATUSES.has(m.status)) continue;  // pula TIMED/SCHEDULED/adiados/cancelados
    const ft = m.score && m.score.fullTime;      // durante o jogo, fullTime carrega o placar corrente
    if (!ft || ft.home == null || ft.away == null) continue;
    const hn = resolveTeam(m.homeTeam, aliases, fixtureByNorm);
    const an = resolveTeam(m.awayTeam, aliases, fixtureByNorm);
    if (!hn || !an) { unresolved.push(`${m.homeTeam && m.homeTeam.name} x ${m.awayTeam && m.awayTeam.name}`); continue; }
    const gid = fixtureBySet[[norm(hn), norm(an)].sort().join('|')];
    if (!gid) { unresolved.push(`sem fixture: ${hn} x ${an}`); continue; }

    const f = fixtures[gid];
    // reorienta para a ordem mandante×visitante do fixture
    const score = norm(f.home) === norm(hn) ? [ft.home, ft.away] : [ft.away, ft.home];
    rows.push({
      game_id: +gid,
      home: score[0],
      away: score[1],
      status: m.status,
      minute: m.minute == null ? null : m.minute,
      updated_at: now2,
    });
  }

  if (!rows.length) return { upserted: 0, unresolved };
  await supaUpsert(rows, env);
  return { upserted: rows.length, games: rows.map((r) => r.game_id), unresolved };
}

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
