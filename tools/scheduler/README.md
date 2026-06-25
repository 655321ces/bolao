# Placares quase-realtime — Cloudflare Worker

Este Worker é o **gatilho principal** dos resultados. A cada 1 min, dentro da
faixa dos jogos, ele consulta a football-data.org (jogos **ao vivo** e
finalizados) e faz **upsert** direto na tabela `results` do Supabase. O site
(`index.html`) lê de lá — sem GitHub Action, sem commit, sem deploy no caminho
quente. O placar entra no Supabase em ~1 min do gol.

A football-data.org **não tem webhook** (é polling puro), então pollar rápido +
escrever direto no banco é o mais perto de realtime que dá.

> A GitHub Action `results.yml` continua rodando em **baixa frequência** (3 crons/dia)
> só como **snapshot de backup** do `data/results.json` (FINISHED) versionado no Git.
> Não está mais no caminho quente.

Tudo é feito pelo **painel web da Cloudflare** — não precisa de ferramenta local.

## 1. Criar o token do GitHub (fine-grained)

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
- **Repository access:** Only select repositories → `bolao`.
- **Permissions:**
  - **Contents:** Read-only  (para ler `fixtures.json` e `teams.aliases.json`)
- Gere e copie o token (`github_pat_…`).

> Não precisa mais de **Actions: Read and write** — o Worker não dispara mais workflow.

## 2. Criar o Worker

[dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**:
1. Dê um nome (ex.: `bolao-scheduler`) → **Deploy** (cria o "hello world").
2. **Edit code** → apague tudo e cole o conteúdo de [`worker.js`](worker.js) → **Deploy**.

## 3. Secrets + Cron Trigger

No Worker → **Settings → Variables and Secrets**, adicione (tipo **Secret**):
- **`GH_PAT`** = o token do passo 1.
- **`FOOTBALL_API_KEY`** = sua chave da football-data.org.
- **`SUPABASE_URL`** = Project URL do Supabase.
- **`SUPABASE_SERVICE_ROLE_KEY`** = chave **service_role** (Project Settings → API).
  É a chave que ignora o RLS para escrever — **nunca** vai pro front-end.

No Worker → **Settings → Triggers → Cron Triggers** → **Add** → expressão
**`* * * * *`** (1 min) → Save.

## 4. Pré-requisito: a tabela `results`

Rode o `supabase/schema.sql` atualizado no SQL Editor (cria a tabela `results`
com SELECT liberado para `anon`). Ver `supabase/SETUP.md`.

## 5. Testar

- Abra a URL `https://bolao-scheduler.<seu-subdominio>.workers.dev`: roda um "tick"
  na hora e retorna um JSON.
  - Fora do horário de jogo: `{"skipped":"fora da faixa"}`.
  - Sem jogo ao vivo/finalizado novo: `{"upserted":0,...}`.
  - Com jogos: `{"upserted":N,"games":[...]}` e as linhas aparecem na tabela
    `results` do Supabase. Valide a reorientação do placar (mandante×visitante)
    contra um jogo conhecido.

## Parâmetros (no `worker.js`)
- `ACTIVE_UTC_HOURS` — gate barato pra nem consultar fora da faixa dos jogos
  (17:00–07:59 UTC). 1 req/min só dentro dessa faixa (football-data free = 10 req/min).
- `LIVE_STATUSES` — `IN_PLAY,PAUSED,FINISHED` (o que é buscado e gravado).
- `COMP` — competição na football-data (`WC`).
- Cadência (1 min) = o Cron Trigger `* * * * *`. Para mudar, edite o trigger.

## Observações
- **Live depende do plano:** confirme que sua `FOOTBALL_API_KEY` retorna scores de
  jogos `IN_PLAY` para a competição `WC`. Se o plano só der `FINISHED`, tudo segue
  funcionando — só não há "ao vivo" (placar final entra mais rápido que o antigo
  commit-pra-deploy).
- O upsert é **idempotente** (PK = `game_id`): re-gravar o mesmo placar é inofensivo.
- Custo: free tier da Cloudflare (cron + ~1440 ticks/dia, a maioria saindo no gate
  de horário sem chamar nada externo).
- **Mata-mata:** tudo deriva do `fixtures.json` — ao adicionar os jogos das
  eliminatórias o Worker já cobre os novos horários, sem mexer no Worker.
