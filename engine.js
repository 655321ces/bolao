/* ============================================================
   Bolão Copa 2026 — Motor de pontuação e identidade
   Funções puras, sem DOM, sem storage. Reutilizado por app.js e admin.js.
   ============================================================ */

/** sinal(x): 1 se positivo, 0 se zero, -1 se negativo */
function sign(x) {
  return (x > 0) - (x < 0);
}

/**
 * Pontua uma aposta contra um resultado real, lendo as regras de config.
 * @param {[number,number]|null} bet  - aposta [home, away] ou null (não palpitou)
 * @param {[number,number]} result    - resultado real [home, away]
 * @param {object} config             - regras de config.json
 * @returns {{points:number, exact:boolean, breakdown:object}}
 */
function score(bet, result, config) {
  const breakdown = { exact: 0, winner: 0, goal_difference: 0, goal_bonus_home: 0, goal_bonus_away: 0 };
  if (bet == null) {
    return { points: 0, exact: false, breakdown };
  }
  const [ph, pa] = bet;
  const [rh, ra] = result;

  // 1) PLACAR EXATO é teto e NÃO acumula
  if (ph === rh && pa === ra) {
    breakdown.exact = config.exact;
    return { points: config.exact, exact: true, breakdown };
  }

  // 2) senão, soma de componentes
  let pts = 0;
  if (sign(ph - pa) === sign(rh - ra)) {        // acertou a DIREÇÃO
    pts += config.winner;
    breakdown.winner = config.winner;
    if (ph - pa === rh - ra) {                  // saldo exige direção certa
      pts += config.goal_difference;
      breakdown.goal_difference = config.goal_difference;
    }
  }
  if (ph === rh) {                              // bônus gol mandante: INDEPENDENTE
    pts += config.goal_bonus_home;
    breakdown.goal_bonus_home = config.goal_bonus_home;
  }
  if (pa === ra) {                              // bônus gol visitante: INDEPENDENTE
    pts += config.goal_bonus_away;
    breakdown.goal_bonus_away = config.goal_bonus_away;
  }

  pts = Math.max(config.floor, Math.min(config.ceiling, pts));
  return { points: pts, exact: false, breakdown };
}

/** Resolve um nome-de-tela para seu canônico via mapa de aliases. */
function canonical(name, aliases) {
  return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
}

/**
 * Resolve aliases em todo o bets.json (idempotente) e mescla nomes-de-tela
 * que apontam para o mesmo canônico no mesmo jogo.
 * Regras de merge:
 *   - null vs aposta  → vale a aposta
 *   - null vs null    → null
 *   - apostas iguais  → mantém
 *   - apostas difer.  → CONFLITO (registrado em conflicts, mantém a 1ª vista)
 * @returns {{bets:object, conflicts:Array}}
 */
function resolveBets(rawBets, aliases) {
  const out = {};
  const conflicts = [];

  for (const gameId of Object.keys(rawBets)) {
    const merged = {};        // canonical -> [h,a] | null
    const seenScreen = {};    // canonical -> nome-de-tela que definiu a aposta atual

    for (const screenName of Object.keys(rawBets[gameId])) {
      const canon = canonical(screenName, aliases);
      const bet = rawBets[gameId][screenName];

      if (!(canon in merged)) {
        merged[canon] = bet;
        seenScreen[canon] = screenName;
        continue;
      }

      const existing = merged[canon];
      if (existing == null) {
        // null nunca sobrescreve, mas aposta sobrescreve null
        if (bet != null) {
          merged[canon] = bet;
          seenScreen[canon] = screenName;
        }
      } else if (bet == null) {
        // mantém aposta existente
      } else if (existing[0] === bet[0] && existing[1] === bet[1]) {
        // iguais: ok
      } else {
        // CONFLITO: duas apostas diferentes para a mesma pessoa no mesmo jogo
        conflicts.push({
          gameId,
          canonical: canon,
          a: { name: seenScreen[canon], bet: existing },
          b: { name: screenName, bet }
        });
      }
    }
    out[gameId] = merged;
  }

  return { bets: out, conflicts };
}

/**
 * Calcula o ranking geral e os detalhes por participante/jogo.
 * @returns {{
 *   participants: string[],
 *   ranking: Array<{name,total,exacts}>,
 *   perGame: object,   // gameId -> name -> {bet,result,points,exact,breakdown}
 *   conflicts: Array
 * }}
 */
function computeStandings(data) {
  const { fixtures, config, aliases, results, bets: rawBets } = data;
  const { bets, conflicts } = resolveBets(rawBets, aliases);

  // conjunto de participantes derivado das chaves canônicas em bets
  const participantSet = new Set();
  for (const gameId of Object.keys(bets)) {
    for (const name of Object.keys(bets[gameId])) participantSet.add(name);
  }
  const participants = [...participantSet];

  const totals = {};   // name -> {total, exacts}
  for (const name of participants) totals[name] = { total: 0, exacts: 0 };

  const perGame = {};  // gameId -> name -> detail
  for (const gameId of Object.keys(bets)) {
    perGame[gameId] = {};
    const result = results[gameId] || null;
    for (const name of Object.keys(bets[gameId])) {
      const bet = bets[gameId][name];
      let detail;
      if (result == null) {
        detail = { bet, result: null, points: 0, exact: false, breakdown: null, pending: true };
      } else {
        const s = score(bet, result, config);
        detail = { bet, result, points: s.points, exact: s.exact, breakdown: s.breakdown, pending: false };
        totals[name].total += s.points;
        if (s.exact) totals[name].exacts += 1;
      }
      perGame[gameId][name] = detail;
    }
  }

  const ranking = participants
    .map(name => ({ name, total: totals[name].total, exacts: totals[name].exacts }))
    .sort((a, b) => b.total - a.total || b.exacts - a.exacts || a.name.localeCompare(b.name, 'pt'));

  return { participants, ranking, perGame, conflicts };
}

/* ---------------- Self-test ---------------- */

function runSelfTests() {
  const cfg = { exact: 10, winner: 5, goal_difference: 3, goal_bonus_home: 1, goal_bonus_away: 1, floor: 0, ceiling: 10 };
  const failures = [];
  const eq = (label, got, want) => { if (got !== want) failures.push(`${label}: esperado ${want}, obtido ${got}`); };

  // Testes unitários do motor
  eq('[2,0]vs[2,0]', score([2, 0], [2, 0], cfg).points, 10);
  eq('[2,0]vs[2,0] exato', score([2, 0], [2, 0], cfg).exact, true);
  eq('[1,0]vs[2,1]', score([1, 0], [2, 1], cfg).points, 8);
  eq('[2,0]vs[2,1]', score([2, 0], [2, 1], cfg).points, 6);
  eq('[1,1]vs[2,1]', score([1, 1], [2, 1], cfg).points, 1);
  eq('[1,2]vs[2,1]', score([1, 2], [2, 1], cfg).points, 0);
  eq('null', score(null, [2, 1], cfg).points, 0);
  eq('null exato', score(null, [2, 1], cfg).exact, false);

  return failures;
}

/**
 * Teste de integração: roda computeStandings sobre os dados carregados e
 * compara com o ranking esperado do critério de aceitação.
 */
function runIntegrationTest(data) {
  const expected = [
    ['Polvo Fernando', 18, 1], ['Camilo Thomas', 16, 1], ['Cesar Santos', 14, 0],
    ['Carolina Argento', 11, 1], ['David', 11, 1], ['Fabio Scaringella', 11, 1],
    ['Juliana ajaj', 11, 1], ['Drinho', 10, 1], ['Pepo Costa', 10, 1],
    ['Alexandre Nassif', 7, 0], ['Bruno Henrique', 7, 0], ['Igor Bammesberger', 7, 0],
    ['Joao Ajaj', 6, 0], ['Andres Vera', 0, 0], ['Gabriel Portella', 0, 0]
  ];
  const failures = [];
  const { ranking } = computeStandings(data);
  const byName = {};
  for (const r of ranking) byName[r.name] = r;

  if (ranking.length !== expected.length) {
    failures.push(`nº de participantes: esperado ${expected.length}, obtido ${ranking.length}`);
  }
  for (const [name, total, exacts] of expected) {
    const r = byName[name];
    if (!r) { failures.push(`${name}: ausente do ranking`); continue; }
    if (r.total !== total) failures.push(`${name} total: esperado ${total}, obtido ${r.total}`);
    if (r.exacts !== exacts) failures.push(`${name} exatos: esperado ${exacts}, obtido ${r.exacts}`);
  }
  return failures;
}

// Exporta para uso em browser (global) e em Node (module) para testes
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sign, score, canonical, resolveBets, computeStandings, runSelfTests, runIntegrationTest };
}
