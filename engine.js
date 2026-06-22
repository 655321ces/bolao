/* ============================================================
   Bolão Copa 2026 — Motor de pontuação e identidade
   Funções puras, sem DOM, sem storage. Reutilizado por app.js e palpites.js.
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

/* ---------------- Lançamento de apostas (parse + merge) ----------------
   Puro, sem DOM. Reutilizado pelo userscript de palpites (a partir de dados
   estruturados extraídos do HTML do bolaogratis), garantindo saída idêntica
   ao fluxo manual. */

/** Faz parse de "Nome 2 x 1" / "Nome 2x1" / "Nome 2 X 1" / "Nome 2×1" / "Nome".
 *  Retorna {name, bet:[h,a]} | {name, bet:null} | {name, malformed:true} | null (linha vazia). */
function parseLine(line) {
  const raw = String(line).trim();
  if (!raw) return null; // linha vazia ignorada
  // captura placar no fim: dígitos sep dígitos
  const m = raw.match(/^(.*?)[\s]+(\d+)\s*[x×X]\s*(\d+)\s*$/);
  if (m) {
    return { name: m[1].trim(), bet: [parseInt(m[2], 10), parseInt(m[3], 10)] };
  }
  // sem placar reconhecido: pode ser só nome (null) OU placar malformado.
  // heurística: se sobra dígito após remover o prefixo não-numérico → malformado
  if (/\d/.test(raw.replace(/^[^\d]*/, ''))) {
    return { name: raw, bet: undefined, malformed: true };
  }
  return { name: raw, bet: null };
}

/** Ordena as chaves de um objeto por nome (locale pt) — para saída estável. */
function sortByName(obj) {
  const o = {};
  Object.keys(obj).sort((a, b) => a.localeCompare(b, 'pt')).forEach(k => o[k] = obj[k]);
  return o;
}

/** Ordena as chaves de um objeto por id numérico de jogo ("1".."72"). */
function sortByGameId(obj) {
  const o = {};
  Object.keys(obj).sort((a, b) => +a - +b).forEach(k => o[k] = obj[k]);
  return o;
}

/**
 * Mescla as entradas de UM jogo num objeto canônico ordenado, com a MESMA
 * semântica de resolveBets (null vs aposta → aposta; iguais → ok; diferentes
 * → CONFLITO, mantém a 1ª vista). Processa a lista em ordem (canonical-keyed),
 * preservando a precedência mesmo com nomes-de-tela repetidos.
 * @param {Array<{name:string, bet:[number,number]|null}>} entries
 * @param {object} aliases
 * @param {string} gameId  - usado só para rotular conflitos
 * @returns {{gameBets:object, conflicts:Array}}
 */
function mergeGameBets(entries, aliases, gameId = '_') {
  const gameBets = {};     // canonical -> [h,a] | null
  const seenScreen = {};   // canonical -> nome-de-tela que definiu a aposta atual
  const conflicts = [];

  for (const entry of entries) {
    const name = entry.name;
    const bet = entry.bet == null ? null : entry.bet;
    const canon = canonical(name, aliases);

    if (!(canon in gameBets)) { gameBets[canon] = bet; seenScreen[canon] = name; continue; }
    const existing = gameBets[canon];
    if (existing == null) {
      if (bet != null) { gameBets[canon] = bet; seenScreen[canon] = name; }
    } else if (bet == null) {
      // mantém aposta existente
    } else if (existing[0] === bet[0] && existing[1] === bet[1]) {
      // iguais: ok
    } else {
      conflicts.push({ gameId, canonical: canon, a: { name: seenScreen[canon], bet: existing }, b: { name, bet } });
    }
  }

  return { gameBets: sortByName(gameBets), conflicts };
}

/**
 * Calcula o ranking geral e os detalhes por participante/jogo.
 *
 * Cascata de ordenação (cada critério só desempata o anterior):
 *   1. pontos (total) DESC
 *   2. exatos (placar cravado) DESC
 *   3. tendencias (acertou direção: mandante/empate/visitante) DESC
 *   4. golsVencedor (acertou nº de gols de quem venceu; empates ignorados) DESC
 * Sem 5º critério: empate remanescente fica na mesma posição (padrão "1224").
 * (A ordem alfabética abaixo é só estabilidade de EXIBIÇÃO, não desempate de posição.)
 *
 * @returns {{
 *   participants: string[],
 *   ranking: Array<{name,total,exacts,tendencias,golsVencedor,pos}>,
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

  const totals = {};   // name -> {total, exacts, tendencias, golsVencedor}
  for (const name of participants) totals[name] = { total: 0, exacts: 0, tendencias: 0, golsVencedor: 0 };

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
        // critérios de desempate por jogo (booleans; usados também na UI)
        let tendencia = false, golsVencedor = false;
        if (bet != null) {
          const [ph, pa] = bet, [rh, ra] = result;
          tendencia = sign(ph - pa) === sign(rh - ra);                                          // C2 (inclui empates; exato implica direção)
          golsVencedor = rh !== ra && ((rh > ra && ph === rh) || (ra > rh && pa === ra));        // C3
        }
        detail = { bet, result, points: s.points, exact: s.exact, tendencia, golsVencedor, breakdown: s.breakdown, pending: false };
        const t = totals[name];
        t.total += s.points;
        if (bet != null) {
          if (s.exact) t.exacts += 1;        // C1
          if (tendencia) t.tendencias += 1;  // C2
          if (golsVencedor) t.golsVencedor += 1; // C3
        }
      }
      perGame[gameId][name] = detail;
    }
  }

  const ranking = participants
    .map(name => ({ name, total: totals[name].total, exacts: totals[name].exacts, tendencias: totals[name].tendencias, golsVencedor: totals[name].golsVencedor }))
    .sort(rankCompare);
  assignPositions(ranking);

  return { participants, ranking, perGame, conflicts };
}

/**
 * Comparador da cascata de desempate: pontos → exatos → tendências →
 * gols do vencedor (todos DESC). O nome entra POR ÚLTIMO apenas como
 * estabilidade de exibição (não é critério de desempate de posição).
 */
function rankCompare(a, b) {
  return b.total - a.total ||
    b.exacts - a.exacts ||
    b.tendencias - a.tendencias ||
    b.golsVencedor - a.golsVencedor ||
    a.name.localeCompare(b.name, 'pt');
}

/**
 * Atribui r.pos a uma lista JÁ ORDENADA, no padrão "1-2-2-4": empate na
 * tupla (pontos,exatos,tendencias,golsVencedor) compartilha posição e a
 * próxima posição pula de acordo. Retorna a própria lista.
 */
function assignPositions(ranking) {
  let pos = 0, shown = 0, prev = null;
  for (const r of ranking) {
    shown++;
    if (!prev || prev.total !== r.total || prev.exacts !== r.exacts ||
        prev.tendencias !== r.tendencias || prev.golsVencedor !== r.golsVencedor) {
      pos = shown;
    }
    r.pos = pos;
    prev = r;
  }
  return ranking;
}

/* ---------------- Self-test (SINTÉTICO e permanente) ----------------
   Entradas fixas inventadas, independentes de bets.json/results.json.
   Vale o torneio inteiro — não quebra quando um jogo novo é lançado. */

/** Testes unitários do motor de pontuação (config padrão). */
function runSelfTests() {
  const cfg = { exact: 10, winner: 5, goal_difference: 3, goal_bonus_home: 1, goal_bonus_away: 1, floor: 0, ceiling: 10 };
  const failures = [];
  // [aposta, resultado, pontos esperados, exato esperado]
  const cases = [
    [[2, 0], [2, 0], 10, true],
    [[1, 0], [2, 1], 8, false],
    [[2, 0], [2, 1], 6, false],
    [[1, 1], [2, 1], 1, false],
    [[1, 2], [2, 1], 0, false],
    [null, [3, 3], 0, false],
    [[0, 0], [0, 0], 10, true],
    [[1, 1], [2, 2], 8, false],
    [[3, 0], [1, 0], 6, false],
    [[5, 0], [5, 0], 10, true],
    [[0, 2], [3, 2], 1, false]
  ];
  for (const [bet, res, pts, exact] of cases) {
    const s = score(bet, res, cfg);
    const label = `${JSON.stringify(bet)}vs${JSON.stringify(res)}`;
    if (s.points !== pts) failures.push(`${label}: pts esperado ${pts}, obtido ${s.points}`);
    if (s.exact !== exact) failures.push(`${label}: exato esperado ${exact}, obtido ${s.exact}`);
  }
  return failures;
}

/** Helper de teste: participante a partir da tupla de métricas. */
function mkTie(name, total, exacts, tendencias, golsVencedor) {
  return { name, total, exacts, tendencias, golsVencedor };
}

/**
 * Testes SINTÉTICOS da cascata de desempate: exercita rankCompare e
 * assignPositions com tuplas inventadas (pontos, exatos, tendências,
 * gols_vencedor). Não depende de nenhum dado real.
 */
function runTiebreakTests() {
  const failures = [];
  const orderOf = arr => [...arr].sort(rankCompare).map(p => p.name);
  const expectOrder = (label, arr, want) => {
    const got = orderOf(arr);
    if (got.join(',') !== want.join(',')) failures.push(`${label}: esperado [${want}], obtido [${got}]`);
  };

  // 1. Pontos dominam tudo
  expectOrder('pontos dominam', [mkTie('X', 10, 0, 0, 0), mkTie('Y', 9, 9, 9, 9)], ['X', 'Y']);
  // 2. Exatos desempatam pontos iguais
  expectOrder('exatos', [mkTie('X', 20, 1, 0, 0), mkTie('Y', 20, 2, 0, 0)], ['Y', 'X']);
  // 3. Tendências desempatam (pontos+exatos iguais)
  expectOrder('tendencias', [mkTie('X', 20, 1, 3, 0), mkTie('Y', 20, 1, 2, 5)], ['X', 'Y']);
  // 4. Gols do vencedor desempatam (pontos+exatos+tendências iguais)
  expectOrder('gols vencedor', [mkTie('X', 20, 1, 2, 1), mkTie('Y', 20, 1, 2, 2)], ['Y', 'X']);

  // 5. Empate residual: métricas idênticas → mesma posição
  const tie = assignPositions([mkTie('A', 11, 1, 1, 1), mkTie('B', 11, 1, 1, 1)].sort(rankCompare));
  if (!(tie[0].pos === 1 && tie[1].pos === 1)) {
    failures.push(`empate residual: esperado posições [1,1], obtido [${tie.map(t => t.pos)}]`);
  }

  // Atribuição de posições padrão 1-2-2-4
  const pos = assignPositions([
    mkTie('P1', 18, 1, 2, 1), mkTie('P2a', 11, 1, 1, 2),
    mkTie('P2b', 11, 1, 1, 2), mkTie('P4', 10, 1, 1, 1)
  ].sort(rankCompare));
  const gotPos = pos.map(p => p.pos).join(',');
  if (gotPos !== '1,2,2,4') failures.push(`posições 1-2-2-4: esperado [1,2,2,4], obtido [${gotPos}]`);

  return failures;
}

/**
 * Testes SINTÉTICOS de parseLine + mergeGameBets (entradas fixas inventadas,
 * independentes de bets.json). Protegem o caminho de lançamento usado tanto
 * pelo admin (texto colado) quanto pelo userscript (DOM estruturado).
 */
function runParseMergeTests() {
  const failures = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // --- parseLine ---
  const pcases = [
    ['Alexandre Nassif 1x1', { name: 'Alexandre Nassif', bet: [1, 1] }],
    ['Andres Vera 1 x 2', { name: 'Andres Vera', bet: [1, 2] }],
    ['Foo 2X3', { name: 'Foo', bet: [2, 3] }],
    ['Bar 0×4', { name: 'Bar', bet: [0, 4] }],            // separador unicode ×
    ['Camilo Thomas', { name: 'Camilo Thomas', bet: null }],
    ['', null],                                           // linha vazia
  ];
  for (const [input, want] of pcases) {
    const got = parseLine(input);
    if (!eq(got, want)) failures.push(`parseLine(${JSON.stringify(input)}): esperado ${JSON.stringify(want)}, obtido ${JSON.stringify(got)}`);
  }
  // malformados (têm dígito mas não casam o padrão "H x A")
  for (const bad of ['Baz 1x', 'Maria 12', 'Fulano 3 x']) {
    const got = parseLine(bad);
    if (!(got && got.malformed)) failures.push(`parseLine(${JSON.stringify(bad)}): esperado malformed, obtido ${JSON.stringify(got)}`);
  }

  // --- mergeGameBets (com aliases) ---
  const aliases = { 'Xandó Acústico': 'Alexandre Nassif' };
  // 1) null vs aposta → vale a aposta (uma conta palpitou, a outra não)
  let r = mergeGameBets([{ name: 'Xandó Acústico', bet: null }, { name: 'Alexandre Nassif', bet: [2, 1] }], aliases, '1');
  if (!eq(r.gameBets, { 'Alexandre Nassif': [2, 1] }) || r.conflicts.length) failures.push(`merge null-vs-aposta: ${JSON.stringify(r)}`);
  // 2) apostas iguais → mantém, sem conflito
  r = mergeGameBets([{ name: 'Alexandre Nassif', bet: [2, 1] }, { name: 'Xandó Acústico', bet: [2, 1] }], aliases, '1');
  if (!eq(r.gameBets, { 'Alexandre Nassif': [2, 1] }) || r.conflicts.length) failures.push(`merge iguais: ${JSON.stringify(r)}`);
  // 3) apostas diferentes → CONFLITO (mantém a 1ª)
  r = mergeGameBets([{ name: 'Alexandre Nassif', bet: [2, 1] }, { name: 'Xandó Acústico', bet: [1, 1] }], aliases, '7');
  if (!eq(r.gameBets, { 'Alexandre Nassif': [2, 1] }) || r.conflicts.length !== 1 || r.conflicts[0].gameId !== '7') failures.push(`merge conflito: ${JSON.stringify(r)}`);
  // 4) ordenação por nome (locale pt)
  r = mergeGameBets([{ name: 'Bruno', bet: [1, 0] }, { name: 'Ana', bet: [0, 0] }], {}, '1');
  if (Object.keys(r.gameBets).join(',') !== 'Ana,Bruno') failures.push(`merge ordenação: ${JSON.stringify(Object.keys(r.gameBets))}`);

  return failures;
}

// Exporta para uso em browser (global) e em Node (module) para testes
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sign, score, canonical, resolveBets, computeStandings, rankCompare, assignPositions,
    parseLine, sortByName, sortByGameId, mergeGameBets,
    runSelfTests, runTiebreakTests, runParseMergeTests
  };
}
