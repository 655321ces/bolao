// ============================================================
// Bolão — gera supabase/seed-games.sql a partir de data/fixtures.json
//
// Converte a data BRT do fixture ("dd/mm HHh" | "dd/mm HHhMM") para um instante
// UTC (timestamptz) usando a MESMA lógica de kickoffMs do worker.js. Por ora
// locks_at = kickoff (edita até o apito). Os UPSERTs são idempotentes: rodar de
// novo só atualiza o que mudou, sem duplicar.
//
// Uso:  node tools/seed-games.mjs > supabase/seed-games.sql
//       (sem redirecionar, imprime no stdout)
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_YEAR = 2026;
const BRT_OFFSET_MIN = 180; // BRT = UTC-3 → instante UTC = hora BRT + 3h

// instante UTC (ms) do apito, a partir da string BRT do fixture
function kickoffMs(date) {
  const m = /^(\d{2})\/(\d{2})\s+(\d{1,2})h(\d{2})?$/.exec(date || '');
  if (!m) return NaN;
  return Date.UTC(FIXTURE_YEAR, +m[2] - 1, +m[1], +m[3], +m[4] || 0) + BRT_OFFSET_MIN * 60000;
}

function isoUTC(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// escapa aspa simples para literal SQL
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const fixturesPath = fileURLToPath(new URL('../data/fixtures.json', import.meta.url));
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

const rows = [];
for (const id of Object.keys(fixtures).sort((a, b) => +a - +b)) {
  const f = fixtures[id];
  const ms = kickoffMs(f.date);
  if (isNaN(ms)) {
    console.error(`AVISO: data não reconhecida no jogo ${id} ("${f.date}") — pulado.`);
    continue;
  }
  const ts = q(isoUTC(ms));
  // locks_at = kickoff por enquanto; ajuste aqui se quiser antecedência
  rows.push(`  (${id}, ${q(f.home)}, ${q(f.away)}, ${ts}, ${ts}, ${f.round}, ${q(f.group)})`);
}

const sql = `-- Gerado por tools/seed-games.mjs a partir de data/fixtures.json — NÃO editar à mão.
-- Datas convertidas de BRT (UTC-3) para UTC. locks_at = kickoff.
insert into public.games (id, home, away, kickoff, locks_at, round, grp) values
${rows.join(',\n')}
on conflict (id) do update set
  home    = excluded.home,
  away    = excluded.away,
  kickoff = excluded.kickoff,
  locks_at = excluded.locks_at,
  round   = excluded.round,
  grp     = excluded.grp;
`;

process.stdout.write(sql);
