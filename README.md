# Bolão Copa 2026 — Calculadora estática

App 100% estático (HTML + CSS + JS puro, sem build, sem dependências) que calcula e exibe o ranking de um bolão da Copa 2026. Pensado para rodar no **GitHub Pages**. Os participantes só leem; o operador lança apostas e resultados editando os JSON em `data/` e dando commit.

## Estrutura

```
index.html      Ranking público (4 telas: ranking, participante, jogo, rodada)
admin.html      Lançamento jogo a jogo (gera JSON para copiar/commitar)
engine.js       Motor de pontuação + identidade (aliases) + self-tests. Sem DOM.
app.js          UI pública
admin.js        UI do admin
style.css       Estilos (mobile-first)
data/           fixtures.json, config.json, aliases.json, results.json, bets.json
tools/serve.ps1 Servidor estático local só para desenvolvimento (não usado em produção)
```

## Como rodar localmente

`fetch()` dos JSON exige `http://` (não funciona via `file://`). Use qualquer servidor estático. Sem Node/Python à mão? Há um servidor mínimo em PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tools/serve.ps1 8123
# abra http://localhost:8123/
```

No GitHub Pages funciona direto, sem servidor local.

## Regras de pontuação

Lidas de `data/config.json` (não hardcoded). Para cada aposta `[ph,pa]` vs resultado `[rh,ra]`:

- **Placar exato** = 10, é teto e **não acumula** mais nada.
- Senão, soma componentes (teto 10, piso 0):
  - **Direção** (mandante/empate/visitante) certa: +5
  - **Saldo** de gols igual (só conta se a direção estiver certa): +3
  - **Bônus gol mandante** (`ph==rh`): +1 — independente
  - **Bônus gol visitante** (`pa==ra`): +1 — independente
- `null` = não palpitou = 0 pontos, não conta como exato.

## Identidade / aliases

`data/aliases.json` mapeia `nome-de-tela → nome-canônico`. Tudo é resolvido antes do cálculo. Se dois nomes-de-tela da mesma pessoa apostarem **diferente no mesmo jogo**, o app exibe um aviso de **CONFLITO** e não escolhe sozinho.

## Self-tests

Ao abrir `index.html`, um banner verde confirma que os 6 testes unitários do motor e o ranking de referência (15 participantes) conferem. Banner vermelho = algo divergiu.

## Lançar dados (operador)

Em `admin.html`:
- **Apostas**: escolha o jogo, cole uma linha por pessoa (`Nome H x A`; só o nome = não palpitou). Aceita separadores `x`, `X`, `×`. O app resolve aliases, valida e gera o `bets.json` completo para copiar.
- **Resultado**: escolha o jogo, informe os gols, copie o `results.json` gerado.

Cole o JSON gerado por cima do arquivo correspondente em `data/` e dê commit.
