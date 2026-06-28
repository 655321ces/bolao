// ============================================================
// Bolão Copa 2026 — preview/sync dos fixtures de mata-mata (football-data.org)
// Detecta os confrontos de mata-mata JÁ DEFINIDOS e mostra o que entraria nos
// fixtures; com --write, grava em data/fixtures.json. Reusa a MESMA lógica pura
// do Worker (selectKnockoutFixtures), então o resultado bate com o automático.
//
// É um auxiliar manual: serve para (1) conferir a detecção e (2) popular já o
// primeiro lote (a galera palpitar) sem esperar o deploy do Worker. Depois o
// Worker (tools/scheduler/) faz isso sozinho a cada tick.
//
// Uso:
//   FOOTBALL_API_KEY=xxx node tools/fixtures/fetch.mjs            (dry-run: só mostra)
//   FOOTBALL_API_KEY=xxx node tools/fixtures/fetch.mjs --write    (grava data/fixtures.json)
// Variável opcional: COMPETITION (default WC).
// ============================================================

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { selectKnockoutFixtures, resolveTeam, norm, formatFixtures, STAGE_PHASE } from '../scheduler/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRITE = process.argv.includes('--write');
const COMP = process.env.COMPETITION || 'WC';
const KEY = process.env.FOOTBALL_API_KEY;

const readJSON = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf8'));

async function main() {
  if (!KEY) { console.error('Falta FOOTBALL_API_KEY.'); process.exit(1); }

  const [fixtures, aliases] = await Promise.all([
    readJSON('data/fixtures.json'),
    readJSON('tools/results/teams.aliases.json'),
  ]);

  // mesmo índice do Worker/fetch.mjs (todos os 48 times já estão nos grupos)
  const fixtureByNorm = {};
  for (const gid of Object.keys(fixtures)) {
    const f = fixtures[gid];
    fixtureByNorm[norm(f.home)] = f.home;
    fixtureByNorm[norm(f.away)] = f.away;
  }

  const url = `https://api.football-data.org/v4/competitions/${COMP}/matches`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': KEY } });
  if (res.status === 401 || res.status === 403) {
    console.error(`API ${res.status}: token inválido ou plano sem acesso à competição ${COMP}.`);
    process.exit(1);
  }
  if (!res.ok) { console.error(`API ${res.status} ao buscar ${COMP}.`); process.exit(1); }
  const data = await res.json();
  const matches = data.matches || [];

  const { added, updated } = selectKnockoutFixtures(matches, fixtures, aliases, fixtureByNorm);

  // diagnóstico: total de mata-mata na fonte e quais ainda estão "a definir"
  const ko = matches.filter((m) => m && STAGE_PHASE[m.stage]);
  const pending = [];
  for (const m of ko) {
    const hn = resolveTeam(m.homeTeam || {}, aliases, fixtureByNorm);
    const an = resolveTeam(m.awayTeam || {}, aliases, fixtureByNorm);
    if (!hn || !an) {
      pending.push(`${(m.homeTeam && m.homeTeam.name) || '?'} x ${(m.awayTeam && m.awayTeam.name) || '?'} (${STAGE_PHASE[m.stage]})`);
    }
  }

  console.log(`Mata-mata na fonte: ${ko.length} jogo(s) | novos a entrar: ${added.length} | remarcados: ${updated.length} | ainda a definir: ${pending.length}`);
  for (const c of added) console.log(`  + ${c.gid}: ${c.home} x ${c.away}  [${c.phase} · ${c.date}]`);
  for (const c of updated) console.log(`  ~ ${c.gid}: ${c.home} x ${c.away}  [${c.phase} · ${c.date}] (data nova)`);
  if (pending.length) {
    console.log('  ainda não definidos / não resolvidos (confira grafia em teams.aliases.json se for um time real):');
    for (const p of pending) console.log(`     · ${p}`);
  }

  if (!added.length && !updated.length) { console.log('Nada a gravar.'); return; }
  if (!WRITE) {
    console.log('\n[dry-run] nada gravado. Rode com --write para gravar em data/fixtures.json.');
    return;
  }

  const merged = { ...fixtures };
  for (const c of [...added, ...updated]) merged[c.gid] = { home: c.home, away: c.away, date: c.date, phase: c.phase };
  await writeFile(join(ROOT, 'data/fixtures.json'), formatFixtures(merged), 'utf8');
  console.log('\n✓ data/fixtures.json atualizado. Próximos passos para a galera palpitar:');
  console.log('  1) node tools/seed-games.mjs > supabase/seed-games.sql');
  console.log('  2) aplique supabase/seed-games.sql no SQL editor do Supabase (faz o jogo aparecer em palpites.html)');
  console.log('  3) git add data/fixtures.json supabase/seed-games.sql && git commit');
}

main().catch((e) => { console.error(e); process.exit(1); });
