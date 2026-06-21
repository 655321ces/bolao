// ============================================================
// Bolão Copa 2026 — busca de resultados (football-data.org)
// Casa cada jogo encerrado com o fixture por times, reorienta o placar para a
// ordem mandante×visitante do fixture e atualiza data/results.json.
// Sem dependências: usa fetch nativo (Node 20+). Roda na GitHub Action.
//
// Uso:
//   FOOTBALL_API_KEY=xxx node tools/results/fetch.mjs            (escreve)
//   FOOTBALL_API_KEY=xxx node tools/results/fetch.mjs --dry-run  (só mostra)
// Variáveis opcionais: COMPETITION (default WC), SEASON.
// ============================================================

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRY = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const COMP = process.env.COMPETITION || 'WC';
const KEY = process.env.FOOTBALL_API_KEY;
const FORCE = process.env.FORCE_FETCH === '1';   // ignora a guarda de horário (disparo manual)

const FIXTURE_YEAR = 2026;
const BRT_OFFSET_MIN = 180;   // BRT = UTC-3 (sem horário de verão) → instante UTC = hora BRT + 3h
const MIN_AGE_MIN = 95;       // só busca um jogo a partir de ~95 min após o início (perto do apito)

/** Instante (ms UTC) do início do jogo a partir do "dd/mm HHh[MM]" do fixture (horário BRT). */
function kickoffMs(date) {
  const m = /^(\d{2})\/(\d{2})\s+(\d{1,2})h(\d{2})?$/.exec(date || '');
  if (!m) return NaN;
  return Date.UTC(FIXTURE_YEAR, +m[2] - 1, +m[1], +m[3], +m[4] || 0) + BRT_OFFSET_MIN * 60 * 1000;
}

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

async function readJSON(rel) { return JSON.parse(await readFile(join(ROOT, rel), 'utf8')); }
const sortByGameId = (o) => Object.keys(o).sort((a, b) => +a - +b)
  .reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});

async function main() {
  if (!KEY) { console.error('Falta FOOTBALL_API_KEY.'); process.exit(1); }

  const [fixtures, results, aliases] = await Promise.all([
    readJSON('data/fixtures.json'),
    readJSON('data/results.json'),
    readJSON('tools/results/teams.aliases.json'),
  ]);

  // guarda de horário: só vale a pena buscar se algum jogo já encerrado ainda não tem placar
  if (!FORCE) {
    const now = Date.now();
    const pendente = Object.keys(fixtures).some((gid) => {
      const ks = kickoffMs(fixtures[gid].date);
      return !isNaN(ks) && (now - ks) >= MIN_AGE_MIN * 60 * 1000 && !results[gid];
    });
    if (!pendente) { console.log('Nenhum jogo encerrado pendente; nada a fazer.'); return; }
  }

  // índices do fixture
  const fixtureByNorm = {};
  const fixtureBySet = {};   // "a|b" (chaves ordenadas) -> gid
  for (const gid of Object.keys(fixtures)) {
    const f = fixtures[gid];
    fixtureByNorm[norm(f.home)] = f.home;
    fixtureByNorm[norm(f.away)] = f.away;
    fixtureBySet[[norm(f.home), norm(f.away)].sort().join('|')] = gid;
  }

  // busca os jogos encerrados
  const url = `https://api.football-data.org/v4/competitions/${COMP}/matches?status=FINISHED`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': KEY } });
  if (res.status === 401 || res.status === 403) {
    console.error(`API ${res.status}: token inválido ou plano sem acesso à competição ${COMP} (Copa 2026 pode exigir outro plano).`);
    process.exit(1);
  }
  if (!res.ok) { console.error(`API ${res.status} ao buscar ${COMP}.`); process.exit(1); }
  const data = await res.json();
  const matches = data.matches || [];
  console.log(`Fonte retornou ${matches.length} jogo(s) encerrado(s) em ${COMP}.`);

  const updated = { ...results };
  const changes = [];
  const unresolved = [];

  for (const m of matches) {
    const ft = m.score && m.score.fullTime;
    if (!ft || ft.home == null || ft.away == null) continue;
    const hn = resolveTeam(m.homeTeam, aliases, fixtureByNorm);
    const an = resolveTeam(m.awayTeam, aliases, fixtureByNorm);
    if (!hn || !an) {
      unresolved.push(`time não mapeado: "${m.homeTeam.name}" (${m.homeTeam.tla}) x "${m.awayTeam.name}" (${m.awayTeam.tla})`);
      continue;
    }
    const gid = fixtureBySet[[norm(hn), norm(an)].sort().join('|')];
    if (!gid) { unresolved.push(`sem fixture para ${hn} x ${an}`); continue; }

    const f = fixtures[gid];
    // reorienta para a ordem do fixture
    const score = norm(f.home) === norm(hn) ? [ft.home, ft.away] : [ft.away, ft.home];

    const prev = updated[gid];
    if (!prev || prev[0] !== score[0] || prev[1] !== score[1]) {
      changes.push(`jogo ${gid} (${f.home} x ${f.away}): ${prev ? prev.join('x') + ' → ' : ''}${score.join('x')}`);
      updated[gid] = score;
    }
  }

  if (unresolved.length) console.warn('AVISOS (pulei):\n  ' + unresolved.join('\n  '));

  if (!changes.length) { console.log('Nada novo. results.json inalterado.'); return; }
  console.log('Mudanças:\n  ' + changes.join('\n  '));

  if (DRY) { console.log('[dry-run] não escrevi.'); return; }
  await writeFile(join(ROOT, 'data/results.json'), JSON.stringify(sortByGameId(updated), null, 2) + '\n');
  console.log('data/results.json atualizado.');
}

main().catch((e) => { console.error(e); process.exit(1); });
