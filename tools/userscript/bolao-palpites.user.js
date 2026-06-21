// ==UserScript==
// @name         Bolão — Capturar palpites
// @namespace    https://github.com/655321ces/bolao
// @version      0.1.0
// @description  Lê os palpites da página "Palpites de todos" e commita data/bets.json no GitHub — sem OCR, sem git na mão.
// @author       Cesar
// @match        https://bolaogratis.com.br/pool/bolao-maravilhoso-e-eterno/palpites-de-todos*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @require      https://raw.githubusercontent.com/655321ces/bolao/main/engine.js
// ==/UserScript==

/* Reusa do engine.js (via @require): canonical(), mergeGameBets(), sortByGameId().
   IMPORTANTE: o @require é cacheado pelo gerenciador. Se o engine.js mudar,
   reinstale/atualize este userscript para pegar a versão nova. */

(function () {
  'use strict';

  // ---------------- Config do repositório ----------------
  const OWNER = '655321ces';
  const REPO = 'bolao';
  const BRANCH = 'main';
  const BETS_PATH = 'data/bets.json';
  const RAW = (p) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${p}?t=${Date.now()}`;
  const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;
  const TOKEN_KEY = 'bolao_github_pat';

  // Times com grafia diferente no site vs fixtures.json (chave/valor já normalizados).
  const TEAM_ALIASES = {
    'tchequia': 'rep. tcheca',
    'estados unidos': 'eua',
    'bosnia e herzegovina': 'bosnia',
  };

  // ---------------- util ----------------
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase().replace(/\s+/g, ' ').trim();
  const teamKey = (s) => { const n = norm(s); return TEAM_ALIASES[n] || n; };

  function gm(method, url, { headers = {}, data = null } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data,
        onload: (r) => resolve(r),
        onerror: () => reject(new Error('Falha de rede: ' + url)),
        ontimeout: () => reject(new Error('Timeout: ' + url)),
      });
    });
  }
  async function fetchJSON(url) {
    const r = await gm('GET', url);
    if (r.status < 200 || r.status >= 300) throw new Error(`GET ${url} → ${r.status}`);
    return JSON.parse(r.responseText);
  }
  // base64 <-> UTF-8 (nomes têm acentos)
  const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
  const b64decode = (b64) => decodeURIComponent(escape(atob(b64.replace(/\s/g, ''))));

  // ---------------- extração do DOM (calibrado ao site Livewire) ----------------
  /**
   * Lê o jogo atualmente exibido na página de palpites.
   * @returns {{home:string, away:string, dateDDMM:string|null,
   *            entries:Array<{name:string, bet:[number,number]|null}>}}
   */
  function extractPalpites() {
    const ul = document.querySelector('ul.divide-y');
    if (!ul) throw new Error('Lista de palpites não encontrada. O jogo já encerrou o prazo de apostas?');
    const card = ul.closest('.rounded-2xl') || ul.parentElement;
    const header = card.querySelector('div.border-b') || card;

    const teamSpans = [...header.querySelectorAll('span.font-semibold')];
    if (teamSpans.length < 2) throw new Error('Não consegui ler os dois times no cabeçalho do jogo.');
    const home = teamSpans[0].textContent.trim();
    const away = teamSpans[1].textContent.trim();
    const dateEl = header.querySelector('.text-xs');
    const dm = dateEl && dateEl.textContent.match(/(\d{2})\/(\d{2})/);
    const dateDDMM = dm ? `${dm[1]}/${dm[2]}` : null;

    const entries = [];
    for (const li of ul.querySelectorAll(':scope > li')) {
      const nameEl = li.querySelector('.min-w-0 span') || li.querySelector('span.truncate');
      if (!nameEl) continue;
      const name = nameEl.textContent.trim();
      if (!name) continue;
      const scoreEl = li.querySelector('span.tabular-nums');
      let bet = null;
      if (scoreEl) {
        const m = scoreEl.textContent.match(/(\d+)\s*[×xX]\s*(\d+)/);
        if (m) bet = [parseInt(m[1], 10), parseInt(m[2], 10)];
      }
      // sem tabular-nums => "não palpitou" (span.italic) => bet permanece null
      entries.push({ name, bet });
    }
    if (!entries.length) throw new Error('Nenhum participante lido na lista.');
    return { home, away, dateDDMM, entries };
  }

  // ---------------- casamento com o fixture ----------------
  /**
   * Acha o id do fixture pelo CONJUNTO de times (e confere a data, se houver).
   * Retorna {gid, reversed} — reversed=true quando a ordem do site é o inverso
   * da ordem mandante×visitante do fixture.
   */
  function matchFixture(home, away, dateDDMM, fixtures) {
    const hk = teamKey(home), ak = teamKey(away);
    const dateOf = (f) => { const m = (f.date || '').match(/(\d{2})\/(\d{2})/); return m ? `${m[1]}/${m[2]}` : null; };
    const candidates = [];
    for (const gid of Object.keys(fixtures)) {
      const f = fixtures[gid];
      const fh = teamKey(f.home), fa = teamKey(f.away);
      if (fh === hk && fa === ak) candidates.push({ gid, reversed: false, f });
      else if (fh === ak && fa === hk) candidates.push({ gid, reversed: true, f });
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1 && dateDDMM) {
      const byDate = candidates.filter((c) => dateOf(c.f) === dateDDMM);
      if (byDate.length === 1) return byDate[0];
    }
    return candidates.length ? candidates[0] : null; // null = não casou
  }

  // ---------------- montagem do bets para o jogo ----------------
  function buildGameBets(extracted, fixtures, aliases, currentBets) {
    const match = matchFixture(extracted.home, extracted.away, extracted.dateDDMM, fixtures);
    if (!match) {
      return { error: `Jogo "${extracted.home} x ${extracted.away}" não casou com nenhum fixture. Confira a grafia dos times / TEAM_ALIASES.` };
    }
    const { gid, reversed, f } = match;

    // reorienta cada aposta para a ordem mandante×visitante DO FIXTURE
    const oriented = extracted.entries.map((e) => ({
      name: e.name,
      bet: e.bet == null ? null : (reversed ? [e.bet[1], e.bet[0]] : [e.bet[0], e.bet[1]]),
    }));

    const { gameBets, conflicts } = mergeGameBets(oriented, aliases, gid);

    // nomes não reconhecidos (novos participantes / grafia)
    const known = new Set();
    for (const g of Object.keys(currentBets)) for (const n of Object.keys(currentBets[g])) known.add(n);
    Object.values(aliases).forEach((c) => known.add(c));
    const unknown = Object.keys(gameBets).filter((n) => !known.has(n));

    return { gid, fixture: f, reversed, gameBets, conflicts, unknown };
  }

  // ---------------- GitHub: ler + commitar ----------------
  function getToken() { return GM_getValue(TOKEN_KEY, ''); }
  function setToken() {
    const cur = getToken();
    const t = prompt('Cole seu GitHub Personal Access Token (fine-grained, repo ' + OWNER + '/' + REPO + ', permissão Contents: Read and write):', cur || '');
    if (t != null) { GM_setValue(TOKEN_KEY, t.trim()); }
    return getToken();
  }

  async function commitBets(gid, fixture, gameBets) {
    const token = getToken() || setToken();
    if (!token) throw new Error('Sem token — commit cancelado.');
    const authHeaders = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };

    // 1) GET arquivo atual (conteúdo autoritativo + sha)
    const getRes = await gm('GET', `${API}/${BETS_PATH}?ref=${BRANCH}`, { headers: authHeaders });
    if (getRes.status === 401) throw new Error('Token inválido ou sem permissão (401).');
    if (getRes.status !== 200) throw new Error(`GET bets.json → ${getRes.status}`);
    const meta = JSON.parse(getRes.responseText);
    const current = JSON.parse(b64decode(meta.content));

    // 2) substitui o jogo e reordena
    current[gid] = gameBets;
    const json = JSON.stringify(sortByGameId(current), null, 2) + '\n';

    // 3) PUT
    const body = {
      message: `Jogo ${gid} (${fixture.home} x ${fixture.away}): palpites`,
      content: b64encode(json),
      sha: meta.sha,
      branch: BRANCH,
    };
    const putRes = await gm('PUT', `${API}/${BETS_PATH}`, { headers: authHeaders, data: JSON.stringify(body) });
    if (putRes.status < 200 || putRes.status >= 300) throw new Error(`PUT bets.json → ${putRes.status}: ${putRes.responseText.slice(0, 200)}`);
    return JSON.parse(putRes.responseText);
  }

  // ---------------- UI ----------------
  let REPO_DATA = null;   // {fixtures, aliases, bets}
  let PREVIEW = null;     // resultado de buildGameBets pronto pra commitar

  const css = `
    #bolao-panel{position:fixed;right:12px;bottom:12px;z-index:99999;width:330px;max-width:calc(100vw - 24px);
      font:13px/1.45 system-ui,sans-serif;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:14px;
      box-shadow:0 10px 30px rgba(0,0,0,.18);overflow:hidden}
    #bolao-panel .bp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:#059669;color:#fff;font-weight:600}
    #bolao-panel .bp-body{padding:12px;max-height:50vh;overflow:auto}
    #bolao-panel button{cursor:pointer;border:0;border-radius:9px;padding:8px 12px;font-weight:600;font-size:13px}
    #bolao-panel .bp-primary{background:#059669;color:#fff;width:100%}
    #bolao-panel .bp-secondary{background:#f1f5f9;color:#0f172a}
    #bolao-panel .bp-primary:disabled{background:#94a3b8;cursor:not-allowed}
    #bolao-panel .bp-row{display:flex;gap:8px;margin-top:8px}
    #bolao-panel .bp-msg{margin-top:8px;padding:8px;border-radius:9px;font-size:12px;white-space:pre-wrap}
    #bolao-panel .ok{background:#ecfdf5;color:#065f46}
    #bolao-panel .warn{background:#fffbeb;color:#92400e}
    #bolao-panel .err{background:#fef2f2;color:#991b1b}
    #bolao-panel .bp-icon{background:transparent;color:#fff;padding:2px 6px}
    #bolao-panel .bp-mut{color:#64748b;font-size:11px}
  `;

  function msg(el, kind, text) { el.className = 'bp-msg ' + kind; el.textContent = text; }

  function buildPanel() {
    if (document.getElementById('bolao-panel')) return;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'bolao-panel';
    panel.innerHTML = `
      <div class="bp-head"><span>⚽ Bolão — palpites</span>
        <button class="bp-icon" id="bp-token" title="Configurar token">⚙</button></div>
      <div class="bp-body">
        <div class="bp-mut">Selecione o jogo no site, depois pré-visualize.</div>
        <button class="bp-primary" id="bp-preview" style="margin-top:8px">Pré-visualizar</button>
        <button class="bp-primary" id="bp-commit" style="margin-top:8px" disabled>Commitar palpites</button>
        <div class="bp-msg" id="bp-out" style="display:none"></div>
      </div>`;
    document.body.appendChild(panel);

    const out = panel.querySelector('#bp-out');
    const btnPreview = panel.querySelector('#bp-preview');
    const btnCommit = panel.querySelector('#bp-commit');

    panel.querySelector('#bp-token').addEventListener('click', () => {
      setToken();
      out.style.display = 'block';
      msg(out, getToken() ? 'ok' : 'warn', getToken() ? 'Token salvo neste dispositivo.' : 'Nenhum token salvo.');
    });

    btnPreview.addEventListener('click', async () => {
      out.style.display = 'block';
      btnCommit.disabled = true; PREVIEW = null;
      try {
        if (!REPO_DATA) {
          msg(out, 'warn', 'Carregando dados do repositório…');
          const [fixtures, aliases, bets] = await Promise.all([
            fetchJSON(RAW('data/fixtures.json')),
            fetchJSON(RAW('data/aliases.json')),
            fetchJSON(RAW('data/bets.json')),
          ]);
          REPO_DATA = { fixtures, aliases, bets };
        }
        const search = document.querySelector('#rp-busca');
        const searchWarn = search && search.value.trim() ? '⚠ Há uma busca ativa — limpe o campo "Buscar membro" para capturar todos.\n\n' : '';

        const extracted = extractPalpites();
        const res = buildGameBets(extracted, REPO_DATA.fixtures, REPO_DATA.aliases, REPO_DATA.bets);
        if (res.error) { msg(out, 'err', res.error); return; }

        PREVIEW = res;
        const n = Object.keys(res.gameBets).length;
        const naoPalpitou = Object.values(res.gameBets).filter((b) => b == null).length;
        const lines = [];
        lines.push(`Jogo ${res.gid}: ${res.fixture.home} x ${res.fixture.away}`);
        if (res.reversed) lines.push('↻ ordem invertida em relação ao site — placares reorientados.');
        lines.push(`${n} participantes (${naoPalpitou} não palpitou).`);
        if (res.unknown.length) lines.push(`⚠ Nomes não reconhecidos: ${res.unknown.join(', ')}`);
        if (res.conflicts.length) {
          for (const c of res.conflicts) lines.push(`⚠ CONFLITO ${c.canonical}: ${c.a.bet[0]}x${c.a.bet[1]} vs ${c.b.bet[0]}x${c.b.bet[1]}`);
        }

        const kind = (res.conflicts.length || res.unknown.length || searchWarn) ? 'warn' : 'ok';
        msg(out, kind, searchWarn + lines.join('\n'));
        btnCommit.disabled = false;
      } catch (e) {
        msg(out, 'err', String(e.message || e));
      }
    });

    btnCommit.addEventListener('click', async () => {
      if (!PREVIEW) return;
      out.style.display = 'block';
      btnCommit.disabled = true;
      msg(out, 'warn', 'Commitando…');
      try {
        const r = await commitBets(PREVIEW.gid, PREVIEW.fixture, PREVIEW.gameBets);
        const sha = (r.commit && r.commit.sha || '').slice(0, 7);
        msg(out, 'ok', `✓ Commit ${sha} — jogo ${PREVIEW.gid} (${PREVIEW.fixture.home} x ${PREVIEW.fixture.away}) gravado.`);
        REPO_DATA = null; // força recarregar bets atualizados na próxima preview
        PREVIEW = null;
      } catch (e) {
        msg(out, 'err', String(e.message || e));
        btnCommit.disabled = false;
      }
    });
  }

  // Expõe funções puras para auto-teste fora do site (inofensivo em produção).
  if (location.hostname.indexOf('bolaogratis') === -1) {
    window.__bolaoTest = { norm, teamKey, extractPalpites, matchFixture, buildGameBets };
  }

  // injeta e re-injeta caso o Livewire troque a página
  buildPanel();
  setInterval(buildPanel, 2000);
})();
