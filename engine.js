/* ============================================================
   Bolão Copa 2026 — Motor de pontuação e identidade
   Funções puras, sem DOM, sem storage. Reutilizado por app.js e palpites.js.
   ============================================================ */

/** sinal(x): 1 se positivo, 0 se zero, -1 se negativo */
function sign(x) {
  return (x > 0) - (x < 0);
}

/** É jogo de mata-mata? Sinal = ter o campo `phase` no fixture. */
function isKnockout(fixture) {
  return !!(fixture && fixture.phase);
}

/** Lado que avança nos pênaltis num array de placar [h,a,side]; só vale em empate. */
function advancerOf(arr) {
  return arr && arr.length > 2 ? arr[2] : null;
}

/**
 * Pontua uma aposta contra um resultado real, lendo as regras de config.
 * @param {[number,number]|[number,number,string]|null} bet  - aposta [home, away] (e, em empate de mata-mata, o lado que passa) ou null
 * @param {[number,number]|[number,number,string]} result    - resultado real [home, away] (e, se decidido nos pênaltis, o lado que avançou)
 * @param {object} config             - regras de config.json
 * @param {{knockout?:boolean}} opts   - contexto do jogo (mata-mata habilita o bônus "Classificado": empate acertando os pênaltis OU vitória de direção certa)
 * @returns {{points:number, exact:boolean, breakdown:object}}
 */
function score(bet, result, config, opts = {}) {
  const breakdown = { exact: 0, winner: 0, goal_difference: 0, goal_bonus_home: 0, goal_bonus_away: 0, classified: 0 };
  if (bet == null) {
    return { points: 0, exact: false, breakdown };
  }
  const [ph, pa] = bet;
  const [rh, ra] = result;

  let pts, exact;

  // 1) PLACAR EXATO é teto e NÃO acumula (mas o bônus de classificado ainda soma por cima)
  if (ph === rh && pa === ra) {
    breakdown.exact = config.exact;
    pts = config.exact;
    exact = true;
  } else {
    // 2) senão, soma de componentes
    pts = 0;
    exact = false;
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
  }

  // 3) bônus CLASSIFICADO (mata-mata): acertou quem se classifica. Soma POR CIMA do teto.
  //    - Empate: palpitou empate e cravou quem passou nos pênaltis.
  //    - Vitória: acertou a direção do vencedor (que avança em campo/prorrogação).
  if (opts.knockout) {
    const drawHit = ph === pa && rh === ra && advancerOf(result) && advancerOf(bet) === advancerOf(result);
    const winHit = rh !== ra && sign(ph - pa) === sign(rh - ra);
    if (drawHit || winHit) {
      pts += config.classified_bonus;
      breakdown.classified = config.classified_bonus;
    }
  }

  return { points: pts, exact, breakdown };
}

/**
 * Detalhe de pontuação de um palpite num jogo: pontos + flags de desempate
 * (exato/tendência/gols do vencedor). FONTE ÚNICA usada por computeStandings e
 * pelas UIs (app.js, palpites.js). Pendente se não há resultado ou config.
 * @param {[number,number]|null} bet
 * @param {[number,number]|null} result
 * @param {object|null} config
 * @param {object|null} fixture  - jogo (para saber se é mata-mata; habilita o bônus "Classificado")
 */
function gameDetail(bet, result, config, fixture) {
  if (result == null || config == null) {
    return { bet, result: null, points: 0, exact: false, tendencia: false, golsVencedor: false, classified: false, breakdown: null, pending: true };
  }
  const s = score(bet, result, config, { knockout: isKnockout(fixture) });
  let tendencia = false, golsVencedor = false;
  if (bet != null) {
    const [ph, pa] = bet, [rh, ra] = result;
    tendencia = sign(ph - pa) === sign(rh - ra);                                    // inclui empates; exato implica direção
    golsVencedor = rh !== ra && ((rh > ra && ph === rh) || (ra > rh && pa === ra)); // acertou os gols de quem venceu
  }
  return { bet, result, points: s.points, exact: s.exact, tendencia, golsVencedor, classified: !!s.breakdown.classified, breakdown: s.breakdown, pending: false };
}

/**
 * Agrega os palpites de UM jogo (recebe perGame[gid] = { nome: detail }):
 * distribuição por resultado (mandante/empate/visitante) e por placar.
 * Considera só quem palpitou (bet != null). Puro — reusado pela UI "por jogo".
 * @returns {{
 *   total:number,
 *   outcome:{ home:{count,pct}, draw:{count,pct}, away:{count,pct} },
 *   scores: Array<{score:string, h:number, a:number, count:number, pct:number, outcome:'home'|'draw'|'away'}>
 * }}
 */
function gameAggregates(perGameEntry) {
  const bets = Object.values(perGameEntry || {}).map(d => d.bet).filter(b => b != null);
  const total = bets.length;
  const pct = n => total ? Math.round((n / total) * 100) : 0;

  let home = 0, draw = 0, away = 0;
  const byScore = {};
  for (const [h, a] of bets) {
    if (h > a) home++; else if (h < a) away++; else draw++;
    const k = `${h}x${a}`;
    byScore[k] = (byScore[k] || 0) + 1;
  }

  const scores = Object.entries(byScore)
    .map(([k, count]) => {
      const [h, a] = k.split('x').map(Number);
      return { score: k, h, a, count, pct: pct(count), outcome: h > a ? 'home' : (h < a ? 'away' : 'draw') };
    })
    .sort((x, y) => y.count - x.count || x.score.localeCompare(y.score));

  return {
    total,
    outcome: {
      home: { count: home, pct: pct(home) },
      draw: { count: draw, pct: pct(draw) },
      away: { count: away, pct: pct(away) },
    },
    scores,
  };
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
  const { fixtures, config, aliases, results, bets: rawBets, liveStatus } = data;
  const { bets, conflicts } = resolveBets(rawBets, aliases);
  const live = liveStatus || {};   // gameId -> status != FINISHED (ranking provisório ao vivo)

  // conjunto de participantes derivado das chaves canônicas em bets
  const participantSet = new Set();
  for (const gameId of Object.keys(bets)) {
    for (const name of Object.keys(bets[gameId])) participantSet.add(name);
  }
  const participants = [...participantSet];

  const totals = {};   // name -> {total, exacts, tendencias, golsVencedor, live}
  for (const name of participants) totals[name] = { total: 0, exacts: 0, tendencias: 0, golsVencedor: 0, live: false };

  let hasLive = false;
  const perGame = {};  // gameId -> name -> detail
  for (const gameId of Object.keys(bets)) {
    perGame[gameId] = {};
    const result = results[gameId] || null;
    const fixture = fixtures[gameId] || null;
    const isLive = !!(live[gameId] && live[gameId] !== 'FINISHED');
    for (const name of Object.keys(bets[gameId])) {
      const bet = bets[gameId][name];
      const detail = gameDetail(bet, result, config, fixture);   // mesma fonte de verdade da UI
      detail.live = !detail.pending && isLive;          // jogo em andamento → pontos parciais
      if (!detail.pending) {
        const t = totals[name];
        t.total += detail.points;
        if (detail.live) { t.live = true; hasLive = true; } // contribuiu com pontos provisórios
        if (bet != null) {
          if (detail.exact) t.exacts += 1;           // C1
          if (detail.tendencia) t.tendencias += 1;   // C2
          if (detail.golsVencedor) t.golsVencedor += 1; // C3
        }
      }
      perGame[gameId][name] = detail;
    }
  }

  const ranking = participants
    .map(name => ({ name, total: totals[name].total, exacts: totals[name].exacts, tendencias: totals[name].tendencias, golsVencedor: totals[name].golsVencedor, live: totals[name].live }))
    .sort(rankCompare);
  assignPositions(ranking);

  return { participants, ranking, perGame, conflicts, hasLive };
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

/* ---------------- Linha do tempo da "corrida" (puro, sem DOM) ----------------
   Série temporal da disputa: pontos ACUMULADOS de cada participante a cada jogo
   finalizado, em ordem cronológica. Derivada (não armazenada) dos mesmos dados
   do ranking, reusando gameDetail (fonte única de pontuação). */

/* Converte a data do fixture ("dd/mm HHh" ou "dd/mm HHhMM") em timestamp (ms).
   Sem ano no fixture; assume FIXTURE_YEAR (horário local do navegador). NaN se
   não casar (vai pro fim na ordenação). Jogos após a meia-noite (ex.: "1h")
   ficam no dia/hora corretos, então a ordem cronológica sai certa. */
const FIXTURE_YEAR = 2026;
function parseFixtureDate(dateStr) {
  const m = /^(\d{2})\/(\d{2})\s+(\d{1,2})h(\d{2})?$/.exec(dateStr || '');
  if (!m) return NaN;
  return new Date(FIXTURE_YEAR, +m[2] - 1, +m[1], +m[3], +m[4] || 0).getTime();
}

/**
 * Constrói a linha do tempo da corrida: para cada jogo já com resultado (em
 * ordem cronológica), o total ACUMULADO de pontos de cada participante.
 * @param {object} data - { fixtures, config, aliases, results, bets }
 * @returns {{
 *   participants: string[],                 // todos (chaves canônicas), ordenados por nome
 *   steps: Array<{ gameId, date, home, away, totals: {[name]:number} }>,
 *   maxTotal: number                        // maior acumulado (escala do eixo Y)
 * }}
 */
function buildRaceTimeline(data) {
  const { fixtures, config, aliases, results, bets: rawBets } = data;
  const { bets } = resolveBets(rawBets, aliases);

  // participantes = todas as chaves canônicas que aparecem em bets
  const participantSet = new Set();
  for (const gid of Object.keys(bets))
    for (const name of Object.keys(bets[gid])) participantSet.add(name);
  const participants = [...participantSet].sort((a, b) => a.localeCompare(b, 'pt'));

  // jogos com resultado (não pendentes), em ordem cronológica; id desempata
  const finishedIds = Object.keys(bets).filter(gid => results[gid] != null && config != null);
  finishedIds.sort((a, b) => {
    const ta = parseFixtureDate(fixtures[a] && fixtures[a].date);
    const tb = parseFixtureDate(fixtures[b] && fixtures[b].date);
    const na = isNaN(ta), nb = isNaN(tb);
    if (na && nb) return Number(a) - Number(b);
    if (na) return 1;                 // sem data → fim
    if (nb) return -1;
    return ta - tb || Number(a) - Number(b);
  });

  const running = {};
  for (const name of participants) running[name] = 0;

  const steps = [];
  let maxTotal = 0;
  for (const gid of finishedIds) {
    const fixture = fixtures[gid] || null;
    const result = results[gid];
    for (const name of Object.keys(bets[gid])) {
      const detail = gameDetail(bets[gid][name], result, config, fixture);
      if (!detail.pending) running[name] += detail.points;   // imutável: só soma
    }
    const totals = {};
    for (const name of participants) {
      totals[name] = running[name];
      if (running[name] > maxTotal) maxTotal = running[name];
    }
    steps.push({
      gameId: gid,
      date: (fixture && fixture.date) || '',
      home: fixture && fixture.home,
      away: fixture && fixture.away,
      totals,
    });
  }
  return { participants, steps, maxTotal };
}

/* ---------------- Apresentação (puro, sem DOM) ----------------
   Strings, decisões e dados reutilizados por app.js e palpites.js. A
   renderização em DOM (chips, bandeiras) fica em cada UI; aqui só a regra. */

/** Lado que passa: nome do time quando `fixture` é dado, senão "mandante"/"visitante".
 *  Devolve null se `side` não for 'home'/'away'. */
function advancerLabel(side, fixture) {
  if (side !== 'home' && side !== 'away') return null;
  if (fixture) return side === 'home' ? fixture.home : fixture.away;
  return side === 'home' ? 'mandante' : 'visitante';
}

/** Código de fase do mata-mata → nome amigável. Devolve o próprio código se desconhecido. */
const PHASE_NAMES = { R32: '32-avos', R16: 'Oitavas', QF: 'Quartas', SF: 'Semifinal', '3P': '3º lugar', F: 'Final' };
function phaseName(phase) {
  return PHASE_NAMES[phase] || phase || '';
}

/** Palpite formatado: "HxA" ou "—" (não palpitou). Em empate de mata-mata com
 *  classificado escolhido, anexa "(passa: <lado>)" — nome do time se `fixture` é dado. */
function fmtBet(bet, fixture) {
  if (bet == null) return '—';
  const base = `${bet[0]}x${bet[1]}`;
  const adv = advancerLabel(advancerOf(bet), fixture);
  return adv ? `${base} (passa: ${adv})` : base;
}

/** Texto explicativo da pontuação de um detalhe (saída de gameDetail). */
function breakdownText(d) {
  if (d.bet == null) return 'não palpitou';
  const b = d.breakdown;
  const tail = b.classified ? ` · classificado +${b.classified}` : '';
  if (d.exact) return 'placar exato' + tail;
  const parts = [];
  if (b.winner) parts.push(`direção +${b.winner}`);
  if (b.goal_difference) parts.push(`saldo +${b.goal_difference}`);
  if (b.goal_bonus_home) parts.push(`gol mandante +${b.goal_bonus_home}`);
  if (b.goal_bonus_away) parts.push(`gol visitante +${b.goal_bonus_away}`);
  if (b.classified) parts.push(`classificado +${b.classified}`);
  return parts.length ? parts.join(' · ') : 'sem acerto';
}

/**
 * Selos de desempate a exibir para um detalhe (decisão pura; cada UI
 * renderiza com seu próprio DOM). Exato implica os outros → mostra só "Exato".
 * @returns {Array<{cls:string, label:string, title:string}>}
 */
function criteriaList(d) {
  if (d.pending || d.bet == null) return [];
  const classif = d.classified ? [{ cls: 'classif', label: 'Classificado', title: 'Acertou quem se classifica' }] : [];
  if (d.exact) return [{ cls: 'exact', label: 'Exato', title: 'Cravou o placar' }, ...classif];
  const out = [];
  if (d.tendencia) out.push({ cls: 'tend', label: 'Tendência', title: 'Acertou a direção (vitória/empate)' });
  if (d.golsVencedor) out.push({ cls: 'gv', label: 'Gols venc.', title: 'Acertou os gols de quem venceu' });
  return [...out, ...classif];
}

/** Nome do time (fixture) → código ISO 3166-1 (flagcdn). Inglaterra/Escócia: subdivisão. */
const FLAG = {
  'México': 'mx', 'África do Sul': 'za', 'Coreia do Sul': 'kr', 'Rep. Tcheca': 'cz',
  'Canadá': 'ca', 'Bósnia': 'ba', 'EUA': 'us', 'Paraguai': 'py', 'Catar': 'qa',
  'Suíça': 'ch', 'Brasil': 'br', 'Marrocos': 'ma', 'Haiti': 'ht', 'Escócia': 'gb-sct',
  'Austrália': 'au', 'Turquia': 'tr', 'Alemanha': 'de', 'Curaçao': 'cw', 'Holanda': 'nl',
  'Japão': 'jp', 'Costa do Marfim': 'ci', 'Equador': 'ec', 'Suécia': 'se', 'Tunísia': 'tn',
  'Espanha': 'es', 'Cabo Verde': 'cv', 'Bélgica': 'be', 'Egito': 'eg', 'Arábia Saudita': 'sa',
  'Uruguai': 'uy', 'Irã': 'ir', 'Nova Zelândia': 'nz', 'Argentina': 'ar', 'Argélia': 'dz',
  'França': 'fr', 'Senegal': 'sn', 'Iraque': 'iq', 'Noruega': 'no', 'Áustria': 'at',
  'Jordânia': 'jo', 'Portugal': 'pt', 'RD Congo': 'cd', 'Inglaterra': 'gb-eng',
  'Croácia': 'hr', 'Gana': 'gh', 'Panamá': 'pa', 'Uzbequistão': 'uz', 'Colômbia': 'co',
};

/* ---------------- Self-test (SINTÉTICO e permanente) ----------------
   Entradas fixas inventadas, independentes de bets.json/results.json.
   Vale o torneio inteiro — não quebra quando um jogo novo é lançado. */

/** Testes unitários do motor de pontuação (config padrão). */
function runSelfTests() {
  const cfg = { exact: 10, winner: 5, goal_difference: 3, goal_bonus_home: 1, goal_bonus_away: 1, floor: 0, ceiling: 10, classified_bonus: 2 };
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

  // --- bônus CLASSIFICADO (mata-mata): só com opts.knockout=true ---
  // [aposta, resultado, opts, pontos esperados, exato esperado, classificado esperado]
  const ko = { knockout: true };
  const koCases = [
    // empate (não exato) com classificado certo: direção +5, saldo +3 (8) + bônus 2 = 10
    [[1, 1, 'home'], [0, 0, 'home'], ko, 10, false, true],
    // classificado ERRADO (empate não exato): só os 8 do empate, sem bônus
    [[1, 1, 'home'], [0, 0, 'away'], ko, 8, false, false],
    // resultado SEM pênaltis (decisivo): empate erra direção → 0, sem bônus
    [[1, 1, 'home'], [2, 0], ko, 0, false, false],
    // palpite DECISIVO num jogo de pênaltis: erra direção → 0, sem bônus (só draw-bettor ganha)
    [[2, 0], [1, 1, 'home'], ko, 0, false, false],
    // mesmo empate certo, mas FORA do mata-mata (sem opts): sem bônus
    [[1, 1, 'home'], [0, 0, 'home'], {}, 8, false, false],
    // VITÓRIA cravada no mata-mata: exato 10 + bônus 2 = 12 (acertou quem se classifica)
    [[2, 1], [2, 1], ko, 12, true, true],
    // VITÓRIA não cravada com direção certa: direção +5, gol visitante +1 (6) + bônus 2 = 8
    [[2, 1], [3, 1], ko, 8, false, true],
    // VITÓRIA com direção ERRADA: sem bônus (e sem acerto de componentes) = 0
    [[0, 2], [2, 1], ko, 0, false, false],
    // VITÓRIA cravada FORA do mata-mata (sem opts): sem bônus, segue 10
    [[2, 1], [2, 1], {}, 10, true, false],
  ];
  for (const [bet, res, opts, pts, exact, classif] of koCases) {
    const s = score(bet, res, cfg, opts);
    const label = `${JSON.stringify(bet)}vs${JSON.stringify(res)}@${JSON.stringify(opts)}`;
    if (s.points !== pts) failures.push(`${label}: pts esperado ${pts}, obtido ${s.points}`);
    if (s.exact !== exact) failures.push(`${label}: exato esperado ${exact}, obtido ${s.exact}`);
    if (!!s.breakdown.classified !== classif) failures.push(`${label}: classificado esperado ${classif}, obtido ${!!s.breakdown.classified}`);
  }
  // EXATO de empate + classificado certo = 12 (bônus empilha acima do teto de 10)
  const exDraw = score([0, 0, 'away'], [0, 0, 'away'], cfg, ko);
  if (exDraw.points !== 12) failures.push(`exato-empate+classificado: pts esperado 12, obtido ${exDraw.points}`);
  if (!exDraw.exact) failures.push('exato-empate+classificado: exato esperado true');

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

  // (corrida testada à parte em runRaceTests)

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

/**
 * Testes SINTÉTICOS da linha do tempo da corrida (buildRaceTimeline): ordenação
 * cronológica por data (não por id) e acumulação correta de pontos passo a passo.
 * Entradas fixas inventadas, independentes de bets.json/results.json.
 */
function runRaceTests() {
  const failures = [];
  const cfg = { exact: 10, winner: 5, goal_difference: 3, goal_bonus_home: 1, goal_bonus_away: 1, floor: 0, ceiling: 10, classified_bonus: 2 };
  const data = {
    config: cfg,
    aliases: {},
    fixtures: {
      '1': { home: 'A', away: 'B', date: '12/06 16h' },
      '2': { home: 'C', away: 'D', date: '11/06 16h' },   // mais cedo que o 1 → vem ANTES
      '3': { home: 'E', away: 'F', date: '13/06 16h' },
    },
    results: { '1': [2, 1], '2': [0, 0], '3': [1, 0] },
    bets: {
      '1': { Ana: [2, 1], Beto: [1, 0] },   // Ana exato=10 ; Beto direção+saldo=8
      '2': { Ana: [0, 0], Beto: [1, 1] },   // Ana exato=10 ; Beto empate(dir+saldo)=8
      '3': { Ana: [0, 0], Beto: [1, 0] },   // Ana gols-fora=1 ; Beto exato=10
    },
  };
  const tl = buildRaceTimeline(data);

  const order = tl.steps.map(s => s.gameId).join(',');
  if (order !== '2,1,3') failures.push(`ordem cronológica: esperado 2,1,3, obtido ${order}`);

  const s0 = tl.steps[0].totals;                          // após jogo 2
  if (s0.Ana !== 10 || s0.Beto !== 8) failures.push(`passo 1: esperado Ana10/Beto8, obtido Ana${s0.Ana}/Beto${s0.Beto}`);

  const last = tl.steps[tl.steps.length - 1].totals;       // acumulado final
  if (last.Ana !== 21) failures.push(`Ana total: esperado 21, obtido ${last.Ana}`);
  if (last.Beto !== 26) failures.push(`Beto total: esperado 26, obtido ${last.Beto}`);

  if (tl.maxTotal !== 26) failures.push(`maxTotal: esperado 26, obtido ${tl.maxTotal}`);

  return failures;
}

// Exporta para uso em browser (global) e em Node (module) para testes
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sign, isKnockout, advancerOf, score, gameDetail, gameAggregates, canonical, resolveBets, computeStandings, rankCompare, assignPositions,
    parseFixtureDate, buildRaceTimeline,
    parseLine, sortByName, sortByGameId, mergeGameBets,
    fmtBet, advancerLabel, phaseName, PHASE_NAMES, breakdownText, criteriaList, FLAG,
    runSelfTests, runTiebreakTests, runParseMergeTests, runRaceTests
  };
}
