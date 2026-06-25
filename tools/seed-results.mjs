// ============================================================
// Bolão — gera supabase/seed-results.sql a partir de data/results.json
//
// Backfill inicial da tabela `results`: popula os placares já FINISHED que hoje
// vivem só no results.json, para o ranking (que agora lê do Supabase) não ficar
// com buraco antes do Worker repopular. Todos entram como status='FINISHED'.
// UPSERT idempotente: rodar de novo (ou o Worker por cima) só atualiza, sem duplicar.
//
// Uso:  node tools/seed-results.mjs > supabase/seed-results.sql
//       (sem redirecionar, imprime no stdout)
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const resultsPath = fileURLToPath(new URL('../data/results.json', import.meta.url));
const results = JSON.parse(readFileSync(resultsPath, 'utf8'));

const rows = [];
for (const id of Object.keys(results).sort((a, b) => +a - +b)) {
  const r = results[id];
  if (!Array.isArray(r) || r.length !== 2 || r[0] == null || r[1] == null) {
    console.error(`AVISO: resultado inválido no jogo ${id} (${JSON.stringify(r)}) — pulado.`);
    continue;
  }
  rows.push(`  (${id}, ${r[0]}, ${r[1]}, 'FINISHED')`);
}

const sql = `-- Gerado por tools/seed-results.mjs a partir de data/results.json — NÃO editar à mão.
-- Backfill inicial dos placares FINISHED. O Worker faz upsert por cima depois.
insert into public.results (game_id, home, away, status) values
${rows.join(',\n')}
on conflict (game_id) do update set
  home       = excluded.home,
  away       = excluded.away,
  status     = excluded.status,
  updated_at = now();
`;

process.stdout.write(sql);
