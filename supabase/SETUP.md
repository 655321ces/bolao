# Setup do bolão próprio (Supabase + login Google)

Camada **nova e paralela**. Enquanto você não fizer o go-live, **nada do que está no
ar muda**: o ranking (`index.html`) continua lendo `data/bets.json`, e o import pelo
bolaogratis e a automação de resultados seguem funcionando. Esta parte só passa a valer
quando você quiser.

A ordem abaixo é o que **só você (operador)** precisa fazer — o código já está pronto.

## 1. Criar o projeto no Supabase

1. https://supabase.com → criar projeto (plano free). Escolha região próxima (ex.: São Paulo).
2. Guarde a senha do banco (não é usada no app, mas é útil).

## 2. Login com Google (OAuth)

**No Google Cloud Console** (https://console.cloud.google.com):
1. Crie/escolha um projeto → **APIs & Services → OAuth consent screen**: tipo *External*,
   preencha nome do app e e-mail. Em *Test users*, adicione os e-mails do grupo (enquanto
   o app estiver em "Testing") — ou publique o app.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID** → tipo
   *Web application*. Em **Authorized redirect URIs**, cole:
   ```
   https://SEU-PROJETO.supabase.co/auth/v1/callback
   ```
   (troque pelo seu Project URL). Guarde o **Client ID** e **Client Secret**.

**No Supabase**:
3. **Authentication → Providers → Google**: ative e cole Client ID + Secret.
4. **Authentication → URL Configuration**:
   - **Site URL**: a URL do GitHub Pages, ex. `https://655321ces.github.io/bolao/`
   - **Redirect URLs**: adicione `https://655321ces.github.io/bolao/palpites.html`
     (e, para testar local, `http://localhost:8123/palpites.html`).

## 3. Criar as tabelas e semear os dados

No Supabase: **SQL Editor → New query**, e rode nesta ordem:
1. Cole e rode `supabase/schema.sql` (tabelas + RLS + trigger de perfil + roster/claim +
   a tabela **`results`** dos placares — ver "Placares quase-realtime" abaixo).
2. Cole e rode `supabase/seed-games.sql` (popula os 72 jogos; idempotente).
3. Cole e rode `supabase/seed-roster.sql` (popula os 15 participantes para a
   auto-reivindicação de identidade; idempotente).

> Se o `fixtures.json` mudar, regenere o seed dos jogos com
> `node tools/seed-games.mjs > supabase/seed-games.sql` (precisa de Node — roda em
> qualquer máquina com Node ou no CI). Se entrar gente nova no bolão, acrescente o
> nome em `seed-roster.sql` e rode de novo.

## 4. Apontar o front para o seu projeto

No Supabase: **Project Settings → API**:
- copie **Project URL** e a chave **anon / public**.

Cole as duas em [`supabase-config.js`](../supabase-config.js) e commite. A anon key é
**pública por design** — quem protege os dados é o RLS, não o segredo da chave. **Nunca**
ponha a `service_role` aqui.

## 5. Testar (em paralelo, sem afetar nada)

1. Abra `palpites.html` pela URL do GitHub Pages (o login Google exige a redirect URL
   registrada; por isso teste pela URL real, não por `file://`).
2. Entre com Google → na 1ª vez aparece **"Quem é você?"**: escolha seu nome na lista
   (isso liga sua conta ao seu histórico). Depois → salve um palpite num jogo aberto →
   recarregue → deve persistir.
3. Confira a trava: num jogo já iniciado os campos não aparecem (fica em "Fechados") e o
   RLS recusa qualquer tentativa de gravar.
4. Validação opcional do RLS: no SQL Editor, force `locks_at` de um jogo para o passado e
   confirme que o palpite some para os outros vira visível, e que não dá mais para editar.

## 6. Go-live (só quando VOCÊ decidir)

Até aqui o ranking continua vindo do `data/bets.json` (import do bolaogratis). Para virar
a chave e passar a usar os palpites do Supabase:

1. **GitHub → Settings → Secrets and variables → Actions**, crie:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = chave **service_role** (Project Settings → API). Secret,
     nunca commitada.
2. Rode o workflow **"Exportar palpites"** manualmente com `dry_run = true` e confira o log.
3. Quando confiar, rode com `dry_run = false` (gera o `data/bets.json` a partir do Supabase)
   e descomente o bloco `schedule` em `.github/workflows/export-bets.yml` (ex.: a cada 15 min).
4. (Opcional) Adicione um link para `palpites.html` no `index.html`.

A partir daí: as pessoas palpitam em `palpites.html`, a ponte exporta os jogos travados
para `data/bets.json`, e o ranking estático segue funcionando — inclusive se o Supabase
cair, ele lê o último export.

## Placares quase-realtime (Supabase como fonte dos resultados)

O ranking público lê os placares **direto da tabela `results` do Supabase** (SELECT
liberado para `anon` — placar é informação pública). Quem escreve é o **Cloudflare
Worker** (`tools/scheduler/worker.js`): a cada 1 min, durante a faixa dos jogos, ele
consulta a football-data.org (jogos **ao vivo** e finalizados) e faz upsert na tabela.
Sem GitHub Action, sem commit, sem deploy no caminho quente — o placar entra em ~1 min.

Para ativar:
1. A tabela `results` já é criada pelo `supabase/schema.sql` (passo 3 acima). Confirme
   que um `GET {url}/rest/v1/results?select=*` com a **anon key** retorna `200` (policy
   `anon` ok) — mesmo vazio.
2. Configure o Worker com os secrets `GH_PAT`, `FOOTBALL_API_KEY`, `SUPABASE_URL` e
   `SUPABASE_SERVICE_ROLE_KEY` e o Cron `* * * * *` — ver `tools/scheduler/README.md`.
3. **Live depende do plano** da football-data: confirme que sua chave retorna scores de
   jogos `IN_PLAY` para a competição `WC`. Se só der `FINISHED`, tudo funciona — só não
   há "ao vivo" (o placar final entra mais rápido que o antigo commit-pra-deploy).

O front é **resiliente**: se o Supabase estiver fora (ou a tabela ainda não existir), o
ranking cai automaticamente para `data/results.json` (o snapshot versionado no Git).
Esse snapshot continua sendo mantido pela GitHub Action `results.yml` rodando em baixa
frequência (3 crons/dia, só FINISHED) — agora apenas como **backup**, não no caminho quente.

O **ranking ao vivo é provisório**: jogos `IN_PLAY` somam pontos parciais com selo
"AO VIVO", e os pontos se firmam quando o jogo vira `FINISHED`.

## O que pode ser aposentado depois (não agora)

O userscript de import do bolaogratis (`tools/userscript/`) fica como fallback durante o
paralelo.
