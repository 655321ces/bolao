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

## 3. Criar as tabelas e semear os jogos

No Supabase: **SQL Editor → New query**, e rode nesta ordem:
1. Cole e rode `supabase/schema.sql` (tabelas + RLS + trigger de perfil).
2. Cole e rode `supabase/seed-games.sql` (popula os 72 jogos; idempotente).

> Se o `fixtures.json` mudar, regenere o seed com `node tools/seed-games.mjs > supabase/seed-games.sql`
> (precisa de Node — roda em qualquer máquina com Node ou no CI) e rode de novo no SQL Editor.

## 4. Apontar o front para o seu projeto

No Supabase: **Project Settings → API**:
- copie **Project URL** e a chave **anon / public**.

Cole as duas em [`supabase-config.js`](../supabase-config.js) e commite. A anon key é
**pública por design** — quem protege os dados é o RLS, não o segredo da chave. **Nunca**
ponha a `service_role` aqui.

## 5. Testar (em paralelo, sem afetar nada)

1. Abra `palpites.html` pela URL do GitHub Pages (o login Google exige a redirect URL
   registrada; por isso teste pela URL real, não por `file://`).
2. Entre com Google → salve um palpite num jogo aberto → recarregue → deve persistir.
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

## O que pode ser aposentado depois (não agora)

`tools/userscript/` e a aba de apostas do `admin.html` (import do bolaogratis) ficam como
fallback durante o paralelo. A automação de **resultados** continua **igual** — não muda.
