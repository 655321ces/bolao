# Placares quase-realtime — Cloudflare Worker

Este Worker é o **gatilho principal** dos resultados. A cada 1 min, dentro da
faixa dos jogos, ele consulta a football-data.org (jogos **ao vivo** e
finalizados) e faz **upsert** direto na tabela `results` do Supabase. O site
(`index.html`) lê de lá. O placar entra no Supabase em ~1 min do gol.

A football-data.org **não tem webhook** (é polling puro), então pollar rápido +
escrever direto no banco é o mais perto de realtime que dá.

Ele também **espelha os jogos FINISHED no `data/results.json`** (backup versionado
no Git) de forma **event-driven**: a cada tick compara os finalizados com o arquivo
e só faz **1 commit quando um placar novo/diferente entra** (jogo virou FINISHED).
Sem job periódico, sem gastar quota da API (reusa o que já buscou), ~1 commit por
jogo finalizado. O `results.json` é o **fallback** do site se o Supabase cair.

> A GitHub Action `results.yml` não roda mais em schedule — ficou só como rede de
> segurança **manual** (`workflow_dispatch`), caso o Worker fique fora do ar.

Tudo é feito pelo **painel web da Cloudflare** — não precisa de ferramenta local.

## 1. Criar o token do GitHub (fine-grained)

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
- **Repository access:** Only select repositories → `bolao`.
- **Permissions:**
  - **Contents:** **Read and write**  (lê `fixtures.json`/`teams.aliases.json` e **commita** `results.json`)
- Gere e copie o token (`github_pat_…`).

> A escrita (Contents RW) é o que permite o Worker espelhar os FINISHED no
> `results.json`. Se já tinha um token antigo com Contents=Read-only, **gere um novo**
> (ou ajuste a permissão) e atualize o secret `GH_PAT` no Worker — senão o commit
> falha com 403 (e o `committed` no tick aparece como `erro: PUT ... -> 403`).
> Não precisa de **Actions** (o Worker não dispara mais workflow).

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
  - Com jogos: `{"upserted":N,"games":[...],"committed":...}` e as linhas aparecem
    na tabela `results` do Supabase. Valide a reorientação do placar
    (mandante×visitante) contra um jogo conhecido.
  - **`committed`**: `false` (nada novo a espelhar), uma lista de game_ids
    (commitou esses no `results.json`) ou `erro: ...` (ex.: PAT sem Contents RW).

## Parâmetros (no `worker.js`)
- `ACTIVE_UTC_HOURS` — gate barato pra nem consultar fora da faixa dos jogos
  (17:00–07:59 UTC). 1 req/min só dentro dessa faixa (football-data free = 10 req/min).
- `KEEP_STATUSES` — `LIVE, IN_PLAY, PAUSED, FINISHED` (o que vira placar na tabela).
  O plano free rotula jogo em andamento como **`LIVE`** (não IN_PLAY) — por isso ele
  está na lista e o filtro é feito no código, não no request.
- `COMP` — competição na football-data (`WC`).
- Cadência (1 min) = o Cron Trigger `* * * * *`. Para mudar, edite o trigger.

## Observações
- **Live depende do plano:** o plano free retorna jogo em andamento com status
  `LIVE` (com placar corrente) — já tratado em `KEEP_STATUSES`. Se algum dia o plano
  só der `FINISHED`, tudo segue funcionando — só não há "ao vivo".
- O upsert é **idempotente** (PK = `game_id`): re-gravar o mesmo placar é inofensivo.
- Custo: free tier da Cloudflare (cron + ~1440 ticks/dia, a maioria saindo no gate
  de horário sem chamar nada externo).
- **Mata-mata:** tudo deriva do `fixtures.json` — ao adicionar os jogos das
  eliminatórias o Worker já cobre os novos horários, sem mexer no Worker.
