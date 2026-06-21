# Gatilho dos resultados — Cloudflare Worker

O `schedule` do GitHub Actions é "melhor esforço" e, neste repo, dispara poucas
vezes ao dia em horários imprevisíveis (perdeu vários términos de jogo). Este
Worker é o gatilho **confiável**: roda a cada 2 min, e quando um jogo está na
janela de término **sem placar**, dispara a Action (`workflow_dispatch`). Para
sozinho quando o placar entra. A Action (`fetch.mjs`) não muda.

Tudo é feito pelo **painel web da Cloudflare** — não precisa de ferramenta local.

## 1. Criar o token do GitHub (fine-grained)

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
- **Repository access:** Only select repositories → `bolao`.
- **Permissions:**
  - **Actions:** Read and write  (para disparar o workflow)
  - **Contents:** Read-only       (para ler fixtures.json/results.json)
- Gere e copie o token (`github_pat_…`).

## 2. Criar o Worker

[dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**:
1. Dê um nome (ex.: `bolao-scheduler`) → **Deploy** (cria o "hello world").
2. **Edit code** → apague tudo e cole o conteúdo de [`worker.js`](worker.js) → **Deploy**.

## 3. Secret + Cron Trigger

No Worker → **Settings**:
- **Variables and Secrets** → Add → tipo **Secret**, nome **`GH_PAT`**, valor = o token do passo 1 → Save.
- **Triggers → Cron Triggers** → **Add Cron Trigger** → expressão **`*/2 * * * *`** → Save.

## 4. Testar

- Abra a URL `https://bolao-scheduler.<seu-subdominio>.workers.dev` no navegador: ele roda um "tick" na hora e retorna um JSON.
  - Fora do horário de jogo: `{"skipped":"fora da faixa"}` ou `{"dispatched":false}`.
  - Com um jogo na janela sem placar: `{"dispatched":true,"pendentes":["NN"]}` e a Action roda em seguida (veja em Actions no GitHub).

## Parâmetros (no `worker.js`)
- `WINDOW_MIN = [105, 210]` — começa ~5 min antes do apito (~110 min) e segue até cobrir prorrogação/pênaltis + lag da fonte. Ajuste se quiser.
- `ACTIVE_UTC_HOURS` — gate barato pra nem consultar o GitHub fora da faixa dos jogos (17:00–07:59 UTC).
- Cadência (2 min) = o Cron Trigger `*/2`. Para mudar, edite o trigger.

## Observações
- O `schedule` do GitHub no `results.yml` fica como **rede de segurança** (dispara de vez em quando; a guarda no `fetch.mjs` evita trabalho à toa).
- O Worker lê os dados **frescos** via API do GitHub (sem cache), então para de disparar ~2 min após o placar ser commitado.
- Custo: free tier da Cloudflare (cron + ~720 ticks/dia, a maioria saindo no gate de horário sem nem chamar o GitHub).
- **Mata-mata:** como tudo deriva do `fixtures.json`, ao adicionar os jogos das eliminatórias o Worker já cobre os novos horários — sem mexer no Worker.
