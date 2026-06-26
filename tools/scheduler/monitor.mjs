// ============================================================
// Bolão — health-check do pipeline de placares (placares quase-realtime).
// Mostra o estado de cada ponto: hora/faixa, Supabase (heartbeat + jogos ao
// vivo), e opcionalmente o Worker e a própria football-data.
//
// Uso:
//   node tools/scheduler/monitor.mjs
//   node tools/scheduler/monitor.mjs --watch       (repete a cada 20s)
//
// Opcionais (env) para cobrir os pontos que exigem segredo/URL:
//   WORKER_URL=https://bolao-scheduler.SEU.workers.dev   → bate no Worker e mostra o tick
//   FOOTBALL_API_KEY=xxxxx                               → contagem por status na fonte
// No PowerShell:  $env:WORKER_URL="..."; node tools/scheduler/monitor.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMP = 'WC';
const ACTIVE_UTC_HOURS = [17, 23, 0, 7];   // mesma faixa do worker.js
const cfgSrc = readFileSync(fileURLToPath(new URL('../../supabase-config.js', import.meta.url)), 'utf8');
const SB_URL = cfgSrc.match(/url:\s*'([^']+)'/)[1].replace(/\/+$/, '');
const SB_KEY = cfgSrc.match(/anonKey:\s*'([^']+)'/)[1];
const WORKER_URL = process.env.WORKER_URL;
const API_KEY = process.env.FOOTBALL_API_KEY;

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const inActive = (h) => (h >= ACTIVE_UTC_HOURS[0] && h <= ACTIVE_UTC_HOURS[1]) || (h >= ACTIVE_UTC_HOURS[2] && h <= ACTIVE_UTC_HOURS[3]);
const ageStr = (ms) => ms < 90000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}min`;

async function checkTime() {
  const now = new Date();
  const h = now.getUTCHours();
  console.log(`[1] HORA       ${now.toISOString().slice(11, 19)} UTC — faixa ativa do Worker: ${inActive(h) ? 'SIM' : 'NÃO (dorme 08–16 UTC)'}`);
  return inActive(h);
}

async function checkSupabase(active) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/results?select=game_id,home,away,status,updated_at&order=updated_at.desc`, { headers: sbHeaders });
    if (!r.ok) { console.log(`[3] SUPABASE   ERRO HTTP ${r.status} (o site cairia no fallback results.json)`); return; }
    const rows = await r.json();
    const live = rows.filter((x) => x.status !== 'FINISHED');
    const last = rows[0] ? Date.now() - new Date(rows[0].updated_at).getTime() : Infinity;
    const stale = active && last > 150000;   // na faixa ativa, > 2,5 min sem update = suspeito
    console.log(`[3] SUPABASE   ${rows.length} linhas — último write há ${ageStr(last)}${stale ? '  ⚠ PARADO? (Worker deveria escrever a cada 1 min)' : ''}`);
    if (live.length) {
      console.log(`               AO VIVO (${live.length}): ` + live.map((x) => `jogo ${x.game_id} ${x.home}x${x.away} [${x.status}]`).join(' · '));
    } else {
      console.log('               nenhum jogo ao vivo agora (status != FINISHED = 0)');
    }
  } catch (e) {
    console.log(`[3] SUPABASE   falhou: ${e.message}`);
  }
}

async function checkWorker() {
  if (!WORKER_URL) { console.log('[2] WORKER     (defina WORKER_URL p/ checar — bate no *.workers.dev e roda um tick)'); return; }
  try {
    const r = await fetch(WORKER_URL, { headers: { 'cache-control': 'no-store' } });
    const body = await r.text();
    console.log(`[2] WORKER     HTTP ${r.status} → ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
  } catch (e) {
    console.log(`[2] WORKER     inacessível: ${e.message}`);
  }
}

async function checkApi() {
  if (!API_KEY) { console.log('[0] FONTE      (defina FOOTBALL_API_KEY p/ checar a contagem por status na football-data)'); return; }
  try {
    const r = await fetch(`https://api.football-data.org/v4/competitions/${COMP}/matches`, { headers: { 'X-Auth-Token': API_KEY } });
    if (!r.ok) { console.log(`[0] FONTE      HTTP ${r.status} (rate limit? token?)`); return; }
    const { matches = [] } = await r.json();
    const by = {};
    for (const m of matches) by[m.status] = (by[m.status] || 0) + 1;
    console.log('[0] FONTE      football-data por status: ' + Object.entries(by).map(([k, v]) => `${k}=${v}`).join(' '));
  } catch (e) {
    console.log(`[0] FONTE      falhou: ${e.message}`);
  }
}

async function run() {
  console.log('— health-check ' + new Date().toLocaleTimeString() + ' ' + '—'.repeat(20));
  await checkApi();
  await checkWorker();
  const active = await checkTime();
  await checkSupabase(active);
  console.log('');
}

if (process.argv.includes('--watch')) {
  await run();
  setInterval(run, 20000);
} else {
  await run();
}
