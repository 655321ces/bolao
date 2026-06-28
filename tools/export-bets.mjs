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

import { readFile, writeFile } from 'node:fs/promises';
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
    rest('bets?select=user_id,game_id,home,away,advances&limit=100000'),
  ]);

  const now = Date.now();
  const locked = new Set(games.filter(g => now >= Date.parse(g.locks_at)).map(g => g.id));
  const nameById = Object.fromEntries(profiles.map(p => [p.id, p.display_name]));

  // monta só os jogos travados que TÊM palpite no Supabase
  const fromSupabase = {};
  for (const b of bets) {
    if (!locked.has(b.game_id)) continue;            // jogo aberto → ainda escondido
    const name = nameById[b.user_id];
    if (!name) { console.error(`AVISO: bet sem profile (user ${b.user_id}) — pulado.`); continue; }
    // empate de mata-mata guarda o lado que passa nos pênaltis no 3º elemento
    (fromSupabase[b.game_id] ||= {})[name] = b.advances ? [b.home, b.away, b.advances] : [b.home, b.away];
  }

  // MERGE: parte do bets.json atual e sobrepõe SÓ os jogos vindos do Supabase.
  // Preserva a história (fase de grupos do bolaogratis) que o Supabase não tem.
  let existing = {};
  try { existing = JSON.parse(await readFile(join(ROOT, 'data', 'bets.json'), 'utf8')); }
  catch { /* primeiro run / arquivo ausente → começa vazio */ }

  const merged = { ...existing };
  for (const gid of Object.keys(fromSupabase)) merged[gid] = fromSupabase[gid];

  // ordena jogos e nomes para saída estável (igual ao fluxo manual)
  const sorted = sortByGameId(merged);
  for (const gid of Object.keys(sorted)) sorted[gid] = sortByName(sorted[gid]);

  const json = JSON.stringify(sorted, null, 2) + '\n';
  const ov_n = Object.keys(fromSupabase).length;
  const bets_n = Object.values(fromSupabase).reduce((s, g) => s + Object.keys(g).length, 0);

  if (DRY) {
    console.log(`[dry-run] Supabase sobreporia ${ov_n} jogos (${bets_n} palpites) sobre ${Object.keys(existing).length} já no bets.json. Não escreveu.`);
    console.log(JSON.stringify(sortByGameId(fromSupabase), null, 2).slice(0, 600));
    return;
  }
  await writeFile(join(ROOT, 'data', 'bets.json'), json, 'utf8');
  console.log(`Escreveu data/bets.json: ${Object.keys(sorted).length} jogos no total; Supabase sobrepôs ${ov_n} (${bets_n} palpites).`);
}

main().catch(e => { console.error('erro:', e.message); process.exit(1); });
