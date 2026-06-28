// ============================================================
// Bolão — ponte data/bets.json → Supabase (one-shot de go-live)
// ------------------------------------------------------------
// O INVERSO do export-bets.mjs. Sobe os palpites LEGADO da fase de grupos
// (data/bets.json, a verdade vouchada do bolaogratis) para a tabela `bets`,
// para que o Supabase deixe de divergir de quem palpitou nos dois sites.
//
// Mapeia nome canônico -> user_id via roster.claimed_by (aplicando aliases.json).
// Usa a service_role key: ignora o RLS (que recusaria escrever jogo já travado).
// NUNCA expor a service_role no front.
//
// Só mexe em jogos de FASE DE GRUPOS (phase IS NULL). Mata-mata é a verdade viva
// do Supabase e não é tocado. Por padrão SOBRESCREVE (bets.json manda); use
// --only-missing para apenas preencher o que falta.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node tools/import-bets.mjs --dry-run
//   ...                                            node tools/import-bets.mjs
//   ... --only-missing   (não sobrescreve palpite que já existe e difere)
//   ... --delete-extras  (apaga palpite de grupo no Supabase sem par no bets.json)
// ============================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const ONLY_MISSING = process.argv.includes('--only-missing');
const DELETE_EXTRAS = process.argv.includes('--delete-extras');
const URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('Falta SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function get(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...H, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// PostgREST limita as linhas por requisição (~1000 no Supabase); `limit=N` grande
// não fura o teto. Pagina por offset até a página vir incompleta.
async function getAll(path, pageSize = 1000) {
  const sep = path.includes('?') ? '&' : '?';
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await get(`${path}${sep}limit=${pageSize}&offset=${offset}`);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

async function upsert(rows) {
  // PK (user_id, game_id) → merge-duplicates faz o upsert
  const res = await fetch(`${URL}/rest/v1/bets`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`UPSERT → ${res.status}: ${await res.text()}`);
}

async function del(user_id, game_id) {
  const res = await fetch(`${URL}/rest/v1/bets?user_id=eq.${user_id}&game_id=eq.${game_id}`, {
    method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' },
  });
  if (!res.ok) throw new Error(`DELETE (${user_id},${game_id}) → ${res.status}: ${await res.text()}`);
}

const canonical = (name, aliases) =>
  Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;

const sameBet = (b, h, a, adv) => b && b.home === h && b.away === a && (b.advances || null) === (adv || null);

async function main() {
  const betsJson = JSON.parse(await readFile(join(ROOT, 'data', 'bets.json'), 'utf8'));
  let aliases = {};
  try { aliases = JSON.parse(await readFile(join(ROOT, 'data', 'aliases.json'), 'utf8')); } catch {}

  const [games, roster, existing] = await Promise.all([
    getAll('games?select=id,phase'),
    getAll('roster?select=canonical_name,claimed_by'),
    getAll('bets?select=user_id,game_id,home,away,advances'),
  ]);

  const groupIds = new Set(games.filter(g => g.phase == null).map(g => g.id));
  const knownIds = new Set(games.map(g => g.id));
  const uuidByName = Object.fromEntries(
    roster.filter(r => r.claimed_by).map(r => [r.canonical_name, r.claimed_by]));
  const nameByUuid = Object.fromEntries(
    roster.filter(r => r.claimed_by).map(r => [r.claimed_by, r.canonical_name]));
  // índice dos palpites já no Supabase: "uuid|gid" -> linha
  const existingIdx = new Map(existing.map(b => [`${b.user_id}|${b.game_id}`, b]));

  const rows = [];                 // a fazer upsert
  const unclaimed = new Set();     // nome do bets.json sem dono no roster
  const skippedGame = new Set();   // gid do bets.json que não é de grupo / não existe
  const diffs = [];                // divergências (Supabase tinha outro palpite)
  const news = [];                 // não existia no Supabase
  let same = 0;                    // já idêntico

  for (const gid of Object.keys(betsJson)) {
    const idn = Number(gid);
    if (!knownIds.has(idn)) { skippedGame.add(gid + ' (inexistente)'); continue; }
    if (!groupIds.has(idn)) { skippedGame.add(gid + ' (mata-mata)'); continue; }
    for (const [rawName, bet] of Object.entries(betsJson[gid])) {
      if (!Array.isArray(bet)) continue;
      const name = canonical(rawName, aliases);
      const uuid = uuidByName[name];
      if (!uuid) { unclaimed.add(name); continue; }
      const [h, a, adv = null] = bet;
      const prev = existingIdx.get(`${uuid}|${idn}`);
      if (sameBet(prev, h, a, adv)) { same++; continue; }
      if (prev) {
        if (ONLY_MISSING) { diffs.push({ name, gid, prev, now: [h, a, adv] }); continue; }
        diffs.push({ name, gid, prev, now: [h, a, adv] });
      } else {
        news.push({ name, gid });
      }
      rows.push({ user_id: uuid, game_id: idn, home: h, away: a, advances: adv });
    }
  }

  // extras: palpite de jogo de grupo no Supabase que não tem par no bets.json
  const extras = [];
  for (const b of existing) {
    if (!groupIds.has(b.game_id)) continue;
    const name = nameByUuid[b.user_id];
    const inJson = name && betsJson[b.game_id] && Array.isArray(
      (betsJson[b.game_id][name] !== undefined
        ? betsJson[b.game_id][name]
        : Object.entries(betsJson[b.game_id]).find(([k]) => canonical(k, aliases) === name)?.[1]));
    if (!inJson) extras.push({ name: name || `(uuid ${b.user_id})`, gid: b.game_id, bet: [b.home, b.away] });
  }

  // ---------- relatório ----------
  console.log(`\n== Importação bets.json → Supabase ${DRY ? '(DRY-RUN)' : ''} ==`);
  console.log(`Jogos de grupo no Supabase: ${groupIds.size} | participantes com dono: ${Object.keys(uuidByName).length}`);
  console.log(`A escrever: ${rows.length}  (novos: ${news.length}, sobrescreve divergentes: ${ONLY_MISSING ? 0 : diffs.length}) | já idênticos: ${same}`);

  if (unclaimed.size) {
    console.error(`\n❌ ABORTADO: ${unclaimed.size} nome(s) do bets.json sem dono no roster — ninguém reivindicou:`);
    for (const n of [...unclaimed].sort()) console.error(`   - ${n}`);
    console.error('Resolva o claim dessas pessoas (ou ajuste aliases.json) antes de importar. Nada foi escrito.');
    process.exit(1);
  }

  if (diffs.length) {
    console.log(`\n⚠ Divergências (Supabase tinha outro palpite — ${ONLY_MISSING ? 'NÃO' : 'SERÁ'} sobrescrito):`);
    for (const d of diffs.slice(0, 200))
      console.log(`   jogo ${d.gid} · ${d.name}: Supabase [${d.prev.home},${d.prev.away}${d.prev.advances ? ',' + d.prev.advances : ''}] → bets.json [${d.now.filter(x => x != null).join(',')}]`);
    if (diffs.length > 200) console.log(`   … +${diffs.length - 200}`);
  }
  if (skippedGame.size) console.log(`\nℹ Jogos pulados (não-grupo/inexistentes): ${[...skippedGame].join(', ')}`);
  if (extras.length) {
    console.log(`\nℹ Extras no Supabase sem par no bets.json (${extras.length})${DELETE_EXTRAS ? ' — SERÃO APAGADOS' : ' — mantidos (use --delete-extras p/ remover)'}:`);
    for (const e of extras.slice(0, 100)) console.log(`   jogo ${e.gid} · ${e.name}: [${e.bet.join(',')}]`);
    if (extras.length > 100) console.log(`   … +${extras.length - 100}`);
  }

  if (DRY) { console.log('\n[dry-run] nada escrito.'); return; }

  // ---------- escrita ----------
  for (let i = 0; i < rows.length; i += 500) await upsert(rows.slice(i, i + 500));
  console.log(`\n✓ Upsert de ${rows.length} palpite(s).`);
  if (DELETE_EXTRAS && extras.length) {
    for (const e of extras) {
      const uuid = uuidByName[e.name];
      if (uuid) await del(uuid, e.gid);
    }
    console.log(`✓ Apagados ${extras.length} extra(s).`);
  }
  console.log('Pronto. Rode `node tools/export-bets.mjs --dry-run` p/ confirmar o round-trip.');
}

main().catch(e => { console.error('erro:', e.message); process.exit(1); });
