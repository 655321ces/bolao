# Bolão Copa 2026

Bolão privado entre amigos da Copa 2026, com **regra de pontuação própria**. Duas camadas:

- **Ranking público** (`index.html`): 100% estático (HTML + CSS + JS puro, sem build, sem dependências), roda no **GitHub Pages**. Calcula e exibe o ranking a partir dos JSON em `data/`.
- **Entrada de palpites** (`palpites.html`): login com **Google** e gravação no **Supabase**, com trava de horário pelo relógio do servidor (RLS). Roda **em paralelo** ao fluxo antigo e só vira a fonte oficial no go-live — decisão do operador (ver `supabase/SETUP.md`).

O motor de pontuação e identidade vive em `engine.js` (puro, sem DOM), reusado pelas duas telas.

## Estrutura

```
index.html          Ranking público (4 telas: ranking, participante, jogo, rodada)
app.js              UI do ranking (lê data/*.json)
palpites.html       Entrada de palpites (login Google + Supabase)
palpites.js         UI da entrada de palpites
engine.js           Motor: pontuação (score/gameDetail), cascata de desempate, helpers
                    de exibição e mapa de bandeiras (FLAG). Sem DOM; fonte única.
style.css           Estilos (mobile-first)
supabase-config.js  URL + anon key do Supabase (públicos; quem protege é o RLS)

data/               fixtures.json, config.json, aliases.json, results.json, bets.json
supabase/           schema.sql, seed-games.sql, seed-roster.sql + SETUP.md (passo a passo do operador)

tools/serve.ps1          Servidor estático local (dev)
tools/seed-games.mjs     Gera supabase/seed-games.sql a partir de fixtures.json
tools/export-bets.mjs    Ponte Supabase → data/bets.json (jogos travados); roda no Actions
tools/results/           Automação de resultados (football-data.org)
tools/scheduler/         Cloudflare Worker que dispara a busca de resultados
tools/userscript/        Import de palpites do bolaogratis (fallback)
.github/workflows/       results.yml (resultados), gen-schedule.yml, export-bets.yml (ponte; desligada até o go-live)
```

## Como rodar localmente

`fetch()` dos JSON exige `http://` (não funciona via `file://`). Sem Node/Python à mão? Há um servidor mínimo em PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tools/serve.ps1 8123
# abra http://localhost:8123/
```

O ranking (`index.html`) roda assim direto. A `palpites.html` precisa do projeto Supabase preenchido em `supabase-config.js` e do login Google testado pela **URL real** do GitHub Pages (a redirect URL tem que estar registrada) — ver `supabase/SETUP.md`.

## Regras de pontuação

Lidas de `data/config.json` (não hardcoded) e aplicadas em `engine.js`. Para cada aposta `[ph,pa]` vs resultado `[rh,ra]`:

- **Placar exato** = 10, é teto e **não acumula** mais nada.
- Senão, soma componentes (teto 10, piso 0):
  - **Direção** (mandante/empate/visitante) certa: +5
  - **Saldo** de gols igual (só conta se a direção estiver certa): +3
  - **Bônus gol mandante** (`ph==rh`): +1 — independente
  - **Bônus gol visitante** (`pa==ra`): +1 — independente
- **Bônus Classificado (mata-mata)** = +2: acertou **quem se classifica**. Duas
  vias: (a) **palpitou empate** e acertou **quem passou nos pênaltis**; ou (b)
  acertou a **direção do vencedor** (vitória, cravada ou não — quem vence avança).
  Soma **por cima do teto** (cravar a vitória = 12; cravar 1x1 + acertar o
  classificado = 12). Detalhes na seção Mata-mata.
- `null` = não palpitou = 0 pontos, não conta como exato.

**Desempate do ranking** (cascata, cada critério só desempata o anterior): pontos → placares exatos → tendências (acertou a direção) → gols do vencedor. Empate em tudo compartilha a posição (padrão "1-2-2-4").

## Mata-mata (32-avos em diante)

A partir do mata-mata não há empate: se o jogo termina igual no tempo
normal/prorrogação, os **pênaltis** decidem quem avança. No bolão:

- **Bônus Classificado (+2) por acertar quem se classifica**, em duas vias:
  - **Empate:** ao digitar um placar de empate num jogo de mata-mata em
    `palpites.html`, aparece o seletor **"Passa nos pênaltis: mandante /
    visitante"**. Acertar quem passou rende o +2 — palpitar empate **não** tira
    pontos; é a forma de disputar esse bônus.
  - **Vitória:** acertar a **direção do vencedor** (cravada ou não) também rende
    o +2, pois quem vence avança (em campo/prorrogação). Assim, **vitória cravada
    no mata-mata = 12** (10 do exato + 2).
- **Formato dos dados:** um **3º elemento** opcional nos arrays de placar marca o
  lado que passa (`"home"`/`"away"`), só em empate de mata-mata:
  - palpite: `bets.json` → `[1, 1, "home"]`
  - resultado nos pênaltis: `results.json` → `[1, 1, "home"]`
  - fixture de mata-mata: campo **`phase`** (`R32`/`R16`/`QF`/`SF`/`3P`/`F`); a
    presença de `phase` é o sinal de "é mata-mata" (jogos de grupo seguem com
    `group`+`round`). Arrays de 2 elementos continuam válidos sem migração.

### Runbook por fase (operador)

1. **Fixtures:** **automático.** O Cloudflare Worker (`tools/scheduler/`) detecta
   cada confronto de mata-mata assim que ele é definido (lê o `stage` da
   football-data.org), e sozinho commita o jogo em `data/fixtures.json` (ids
   `73+`, campo `phase`, ordem mandante×visitante da football-data) **e** faz
   upsert na tabela `games` do Supabase — o jogo já aparece em `palpites.html`.
   *Fallback manual* (remarcação exótica ou time que não resolveu — aparece em
   `unresolved` no retorno do Worker; complete `tools/results/teams.aliases.json`):
   editar `data/fixtures.json` à mão e rodar
   `node tools/seed-games.mjs > supabase/seed-games.sql` no Supabase.
2. **Palpites:** as pessoas palpitam em `palpites.html`; em empate escolhem quem
   passa. A ponte `tools/export-bets.mjs` leva para `data/bets.json`.
3. **Resultados:** o Cloudflare Worker preenche sozinho, inclusive o "quem
   passou" nos pênaltis (lê `score.winner`/`duration` da football-data.org);
   fallback manual via `tools/results/fetch.mjs`.

## Identidade

- **Atual (Supabase):** 1 login Google = 1 pessoa. No 1º acesso a pessoa reivindica seu nome canônico em **"Quem é você?"** (tabela `roster`, RPC `claim_identity`), ligando a conta ao seu histórico no ranking.
- **Legado (`data/aliases.json`):** mapeia `nome-de-tela → nome-canônico` para o histórico importado do bolaogratis e o userscript. Resolvido antes do cálculo; se dois nomes-de-tela da mesma pessoa apostarem **diferente no mesmo jogo**, o app mostra **CONFLITO** e não escolhe sozinho.

## Self-tests

Ao abrir `index.html`, um banner verde confirma que os testes sintéticos do `engine.js` conferem: **pontuação**, **cascata de desempate** e **parse/merge** de palpites. Banner vermelho = algo divergiu.

## Fluxo de dados (quem lança o quê)

- **Palpites** → `data/bets.json`: da `palpites.html` (Supabase, exportado pela ponte `tools/export-bets.mjs`) **ou** do userscript de import do bolaogratis (`tools/userscript/`). O ranking lê o `bets.json`.
- **Resultados** → `data/results.json`: automação `tools/results/fetch.mjs` (football-data.org), disparada pelo Cloudflare Worker (`tools/scheduler/`) via GitHub Actions.
- **Correção manual**: editar o `data/*.json` correspondente e dar commit.

> A ponte de export (`export-bets.yml`) fica **desligada** até o go-live; até lá o `bets.json` vem do fluxo antigo e nada do que está no ar muda. Detalhes e go-live em `supabase/SETUP.md`.
