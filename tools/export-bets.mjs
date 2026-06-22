// ============================================================
// Bolão — ponte Supabase → data/bets.json
// ------------------------------------------------------------
// Lê os palpites de jogos JÁ TRAVADOS (now >= locks_at) do Supabase e reescreve
// data/bets.json no formato do engine: { "gameId": { "Nome": [h,a] } }. Só jogos
// travados — palpite de jogo aberto continua escondido (mesma regra do RLS).
//
// Mantém o ranking estático vivo mesmo se o Supabase cair, e preserva o histórico
// no git. Roda na GitHub Action (Node 20+, sem dependências: fetch nativo).
// Usa a service_role key (ignora RLS) — NUNCA expor no front.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node tools/export-bets.mjs
//   ... --dry-run   (imprime, não escreve)
// ============================================================

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('Falta SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

async function rest(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const sortByGameId = (o) => Object.keys(o).sort((a, b) => +a - +b)
  .reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});
const sortByName = (o) => Object.keys(o).sort((a, b) => a.localeCompare(b, 'pt'))
  .reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});

async function main() {
  const [games, profiles, bets] = await Promise.all([
    rest('games?select=id,locks_at&limit=100000'),
    rest('profiles?select=id,display_name&limit=100000'),
    rest('bets?select=user_id,game_id,home,away&limit=100000'),
  ]);

  const now = Date.now();
  const locked = new Set(games.filter(g => now >= Date.parse(g.locks_at)).map(g => g.id));
  const nameById = Object.fromEntries(profiles.map(p => [p.id, p.display_name]));

  const out = {};
  for (const b of bets) {
    if (!locked.has(b.game_id)) continue;            // jogo aberto → ainda escondido
    const name = nameById[b.user_id];
    if (!name) { console.error(`AVISO: bet sem profile (user ${b.user_id}) — pulado.`); continue; }
    (out[b.game_id] ||= {})[name] = [b.home, b.away];
  }

  // ordena jogos e nomes para saída estável (igual ao fluxo manual)
  const sorted = sortByGameId(out);
  for (const gid of Object.keys(sorted)) sorted[gid] = sortByName(sorted[gid]);

  const json = JSON.stringify(sorted, null, 2) + '\n';
  const games_n = Object.keys(sorted).length;
  const bets_n = Object.values(sorted).reduce((s, g) => s + Object.keys(g).length, 0);

  if (DRY) {
    console.log(`[dry-run] ${games_n} jogos travados, ${bets_n} palpites. Não escreveu.`);
    console.log(json.slice(0, 600) + (json.length > 600 ? '\n…' : ''));
    return;
  }
  await writeFile(join(ROOT, 'data', 'bets.json'), json, 'utf8');
  console.log(`Escreveu data/bets.json: ${games_n} jogos, ${bets_n} palpites.`);
}

main().catch(e => { console.error('erro:', e.message); process.exit(1); });
