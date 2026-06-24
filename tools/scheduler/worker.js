// ============================================================
// Bolão Copa 2026 — Cloudflare Worker (gatilho confiável dos resultados)
// A cada 2 min (Cron Trigger), lê fixtures.json + results.json do repo e, se
// algum jogo está na JANELA de término sem placar, dispara a Action
// (workflow_dispatch). Para sozinho quando o placar entra. Sem desperdício.
//
// Deploy: painel da Cloudflare (Workers & Pages) — ver README.md desta pasta.
// Secrets necessários: GH_PAT (fine-grained: repo bolao, Actions=RW, Contents=RO).
// Cron Trigger: */2 * * * *
// ============================================================

const OWNER = '655321ces';
const REPO = 'bolao';
const FIXTURE_YEAR = 2026;
const BRT_OFFSET_MIN = 180;        // BRT = UTC-3 → instante UTC = hora BRT + 3h
const WINDOW_MIN = [105, 420];     // de ~5 min antes do apito (~110) até +7h: cobre prorrogação/pênaltis + atraso em jogo (parada climática etc.)
const ACTIVE_UTC_HOURS = [17, 23, 0, 7]; // gate barato: só checa de 17:00–07:59 UTC (faixa dos jogos)

function kickoffMs(date) {
  const m = /^(\d{2})\/(\d{2})\s+(\d{1,2})h(\d{2})?$/.exec(date || '');
  if (!m) return NaN;
  return Date.UTC(FIXTURE_YEAR, +m[2] - 1, +m[1], +m[3], +m[4] || 0) + BRT_OFFSET_MIN * 60000;
}

function inActiveHours(d) {
  const h = d.getUTCHours();
  return (h >= ACTIVE_UTC_HOURS[0] && h <= ACTIVE_UTC_HOURS[1]) || (h >= ACTIVE_UTC_HOURS[2] && h <= ACTIVE_UTC_HOURS[3]);
}

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

async function tick(env) {
  const now = new Date();
  if (!inActiveHours(now)) return { skipped: 'fora da faixa' };

  const [fixtures, results] = await Promise.all([
    ghContentsJSON('data/fixtures.json', env),
    ghContentsJSON('data/results.json', env),
  ]);

  const t = now.getTime();
  const pendentes = Object.keys(fixtures).filter((gid) => {
    if (results[gid]) return false;
    const ks = kickoffMs(fixtures[gid].date);
    if (isNaN(ks)) return false;
    const ageMin = (t - ks) / 60000;
    return ageMin >= WINDOW_MIN[0] && ageMin <= WINDOW_MIN[1];
  });

  if (!pendentes.length) return { dispatched: false };

  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/results.yml/dispatches`,
    { method: 'POST', headers: ghHeaders(env), body: JSON.stringify({ ref: 'main', inputs: { dry_run: 'false' } }) },
  );
  if (!r.ok) throw new Error(`dispatch -> ${r.status}: ${await r.text()}`);
  return { dispatched: true, pendentes };
}

export default {
  // disparado pelo Cron Trigger (*/2 * * * *)
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
