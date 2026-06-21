// ============================================================
// Bolão Copa 2026 — gerador da agenda (cron) dos resultados
// Deriva os horários de TÉRMINO dos jogos do fixtures.json e reescreve o bloco
// `schedule:` do results.yml com entradas de cron precisas (em vez de varrer
// uma faixa de 12h). Sem dependências (Node 20).
//
// Uso:
//   node tools/results/gen-schedule.mjs            # reescreve o results.yml e imprime o bloco
//   node tools/results/gen-schedule.mjs --print    # só imprime (não grava) — útil em CI/dispatch
// ============================================================

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRINT_ONLY = process.argv.includes('--print');

const FIXTURE_YEAR = 2026;
const BRT_OFFSET_MIN = 180;            // BRT = UTC-3 → instante UTC = hora BRT + 3h
const FINISH_OFFSETS_MIN = [115, 140]; // apito (~90+15+10) + 1 retry; absorve atraso do cron/acréscimos

const START = '    # >>> agenda gerada (gen-schedule.mjs) — não edite à mão >>>';
const END = '    # <<< agenda gerada <<<';

/** Instante (ms UTC) do início do jogo a partir do "dd/mm HHh[MM]" (horário BRT). */
function kickoffMs(date) {
  const m = /^(\d{2})\/(\d{2})\s+(\d{1,2})h(\d{2})?$/.exec(date || '');
  if (!m) return NaN;
  return Date.UTC(FIXTURE_YEAR, +m[2] - 1, +m[1], +m[3], +m[4] || 0) + BRT_OFFSET_MIN * 60 * 1000;
}

async function main() {
  const fixtures = JSON.parse(await readFile(join(ROOT, 'data/fixtures.json'), 'utf8'));

  // coleta HH:MM (UTC) distintos dos disparos = início + cada offset
  const slots = new Set();
  for (const gid of Object.keys(fixtures)) {
    const ks = kickoffMs(fixtures[gid].date);
    if (isNaN(ks)) { console.warn(`fixture ${gid}: data não reconhecida "${fixtures[gid].date}"`); continue; }
    for (const off of FINISH_OFFSETS_MIN) {
      const d = new Date(ks + off * 60 * 1000);
      slots.add(d.getUTCHours() * 60 + d.getUTCMinutes());
    }
  }

  const lines = [...slots].sort((a, b) => a - b)
    .map((mins) => `    - cron: '${mins % 60} ${Math.floor(mins / 60)} * * *'`);

  const block = [
    START,
    `    # ${lines.length} disparos/dia nos términos (UTC) derivados do fixtures.json. Regerar: node tools/results/gen-schedule.mjs`,
    ...lines,
    END,
  ].join('\n');

  console.log(block);
  console.log(`\n# ${lines.length} entradas.`);

  if (PRINT_ONLY) return;

  const ymlPath = join(ROOT, '.github/workflows/results.yml');
  const yml = await readFile(ymlPath, 'utf8');
  // substitui tudo entre as sentinelas (consome a indentação inicial; o `block` já vem indentado)
  const re = /[ \t]*# >>> agenda gerada \(gen-schedule\.mjs\)[\s\S]*?# <<< agenda gerada <<</;
  if (!re.test(yml)) { console.error('Sentinelas não encontradas no results.yml — abortei.'); process.exit(1); }
  await writeFile(ymlPath, yml.replace(re, block));
  console.log('\nresults.yml atualizado.');
}

main().catch((e) => { console.error(e); process.exit(1); });
