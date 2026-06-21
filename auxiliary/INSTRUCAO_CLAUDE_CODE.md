# Instrução para o Claude Code — Calculadora do Bolão Copa 2026

## Objetivo
Criar uma aplicação web **estática** (roda no GitHub Pages, sem backend) que calcula e exibe a pontuação de um bolão da Copa do Mundo 2026. Eu (o operador) lanço as apostas e os resultados; os participantes apenas visualizam o ranking.

## Princípios de arquitetura (NÃO desviar disto)
- **100% estático.** Apenas HTML + CSS + JavaScript puro (vanilla). Sem React, sem build step, sem bundler, sem dependências externas, sem CDN. Tudo num único `index.html` é o ideal; se separar em `app.js`/`style.css` tudo bem, mas nada de framework.
- **PROIBIDO usar `localStorage`, `sessionStorage` ou qualquer storage de navegador.** Os dados vivem em arquivos `.json` no repositório.
- **Sem servidor, sem banco de dados, sem API externa.** Nada de fetch para serviços de terceiros. Os dados são carregados via `fetch()` dos arquivos JSON locais do próprio repo.
- O estado gravável é o repositório Git. Eu edito os JSON (pela interface web do GitHub ou localmente) e dou commit. O GitHub Pages publica. Os participantes só leem.

## Modelo de dados (5 arquivos JSON na raiz ou em `/data`)

### `fixtures.json` — os 72 jogos (FIXO, não muda)
Cada jogo tem um ID string ("1".."72"), com `home`, `away`, `date`, `group`, `round`. A ordem `home`/`away` é canônica (mandante x visitante) e os placares SEMPRE seguem essa ordem.

### `config.json` — regras de pontuação (parametrizado de propósito)
As regras NÃO devem ser hardcoded no JS. Leia tudo de `config.json`. Isso permite ajustar a pontuação sem mexer no código.

### `aliases.json` — mapa de identidade
`{ "nome-de-tela": "nome-canônico" }`. A mesma pessoa pode aparecer com nomes diferentes em prints diferentes (contas duplicadas). Antes de qualquer cálculo, todo nome deve ser resolvido para seu canônico via este mapa. Nomes que não estão no mapa são seus próprios canônicos.

### `results.json` — placares finais reais
`{ "id_do_jogo": [gols_home, gols_away] }`. Só contém jogos já encerrados. Cresce ao longo do torneio.

### `bets.json` — apostas
`{ "id_do_jogo": { "nome_canônico": [h,a] | null } }`. `null` = "não palpitou". Já vem com os nomes canônicos resolvidos (mas o app deve resolver de novo por segurança ao carregar — idempotente).

## Motor de pontuação (replicar EXATAMENTE — já validado contra o site real)

Para cada aposta `[ph, pa]` contra resultado real `[rh, ra]`, lendo valores de `config.json`:

```
função pontuar(aposta, resultado, config):
    se aposta == null:  retornar 0, exato=false   // não palpitou
    ph, pa = aposta;  rh, ra = resultado
    // 1) PLACAR EXATO é teto e NÃO acumula
    se ph==rh E pa==ra:  retornar config.exact (10), exato=true
    // 2) senão, soma de componentes
    pts = 0
    sinal(x) = (x>0) - (x<0)   // 1 / 0 / -1
    se sinal(ph-pa) == sinal(rh-ra):        // acertou a DIREÇÃO (mandante/empate/visitante)
        pts += config.winner (5)
        se (ph-pa) == (rh-ra):              // saldo exige direção certa
            pts += config.goal_difference (3)
    se ph == rh:  pts += config.goal_bonus_home (1)   // bônus gol mandante: INDEPENDENTE
    se pa == ra:  pts += config.goal_bonus_away (1)   // bônus gol visitante: INDEPENDENTE
    pts = max(config.floor (0), min(config.ceiling (10), pts))
    retornar pts, exato=false
```

**Pontos críticos que NÃO podem ser alterados:**
- Placar exato = 10 fixo, encerra o cálculo, não soma mais nada.
- Saldo (+3) só conta se a direção estiver certa.
- Os dois bônus de gols (+1 cada) são **independentes**: contam mesmo se a pessoa errou quem ganhou. (Ex.: apostou 1x1, resultado 2x1 → 0 de direção/saldo, mas +1 pelo gol do visitante = 1 ponto.)
- Teto 10, piso 0 sempre.
- "não palpitou" (null) = 0 pontos e **não conta** como placar exato.

## Regra de merge de aliases (caso de borda OBRIGATÓRIO)
Ao resolver dois nomes-de-tela para o mesmo canônico no MESMO jogo:
- Se um é `null` (não palpitou) e o outro tem aposta → vale a **aposta** (null nunca sobrescreve aposta real).
- Se ambos são `null` → `null`.
- Se ambos têm aposta IGUAL → ok, mantém.
- Se ambos têm aposta DIFERENTE → **CONFLITO**: o app deve exibir um aviso visível listando jogo + pessoa + as duas apostas, e NÃO escolher sozinho. (Hoje não há nenhum conflito nos dados, mas a regra precisa existir.)

## Telas (todas read-only para o público)
1. **Ranking geral** — lista de participantes ordenada por pontos (desc). Mostrar pontos e nº de placares exatos. **Não implementar critério de desempate** além de exibir o nº de exatos como coluna — empates ficam empatados por enquanto (vou definir o desempate depois).
2. **Detalhe por participante** — todos os jogos que a pessoa palpitou, o que apostou, o resultado real, e quantos pontos fez em cada um (com a quebra: exato / direção / saldo / bônus).
3. **Detalhe por jogo** — dado um jogo, mostrar o que cada participante apostou e quanto pontuou.
4. **Por rodada** — pontos de cada participante agregados por rodada (1ª/2ª/3ª).

Jogos sem resultado em `results.json` aparecem como "aguardando resultado" e não pontuam.

## Participantes dinâmicos
NÃO chumbar a lista de participantes. O conjunto de pessoas é derivado das chaves que aparecem em `bets.json` (após resolver aliases). Novos participantes podem entrar a qualquer momento: quem não tem aposta num jogo simplesmente faz 0 ali. Hoje são 15, mas o código não pode assumir 15.

## Ferramenta de lançamento (admin) — pode ser uma página separada `admin.html`
Preciso de um jeito prático de lançar as apostas **jogo a jogo** (é assim que recebo: um print por jogo, com todos os participantes daquele jogo). Fluxo:
1. Seleciono o jogo (dropdown vindo de `fixtures.json`, mostra "Coreia do Sul x Tchéquia").
2. Colo um texto no formato, uma linha por pessoa:
   ```
   Alexandre Nassif 1x1
   Andres Vera 1x2
   Camilo Thomas
   ```
   - `Nome H x A` (aceitar separadores `x`, `X`, `×`, espaços flexíveis).
   - Linha só com nome (sem placar) = "não palpitou" (null).
3. O app resolve aliases, monta o objeto daquele jogo e **gera o JSON atualizado para eu copiar e commitar** (o app é estático, então ele NÃO escreve em disco — ele mostra o JSON pronto numa textarea com botão "copiar"). Mesma coisa para lançar resultado de um jogo.
4. Validar e avisar: nomes não reconhecidos, conflitos de alias, placares malformados.

(O admin é só pra mim; não precisa de autenticação — o GitHub já controla quem dá push. Se quiser, esconda o link.)

## Critério de aceitação — TESTES SINTÉTICOS (permanentes, NÃO atrelados aos dados reais)

> IMPORTANTE: os testes do motor devem usar **entradas fixas inventadas**, com resultado esperado fixo. Eles NÃO podem depender de `bets.json` nem de `results.json`, porque esses arquivos mudam a cada jogo lançado. Um teste que lê os dados reais "passa hoje e falha amanhã" sem nada estar quebrado. Implemente como um bloco de self-test que roda no console (ou numa página `tests.html`) e que continua válido durante todo o torneio.

### Testes do motor de pontuação (config padrão) — todos devem passar:
| aposta | resultado | pontos | exato |
|---|---|---|---|
| [2,0] | [2,0] | 10 | sim |
| [1,0] | [2,1] | 8 | não |
| [2,0] | [2,1] | 6 | não |
| [1,1] | [2,1] | 1 | não |
| [1,2] | [2,1] | 0 | não |
| null | [3,3] | 0 | não |
| [0,0] | [0,0] | 10 | sim |
| [1,1] | [2,2] | 8 | não |
| [3,0] | [1,0] | 6 | não |
| [5,0] | [5,0] | 10 | sim |
| [0,2] | [3,2] | 1 | não |

Casos que cada linha protege (não remover sem entender):
- `[1,1]` vs `[2,2]` = **8**, não 5: num empate, acertar a direção já garante o saldo (saldo do empate é sempre 0). Empate certo ⇒ +5 direção +3 saldo.
- `[0,2]` vs `[3,2]` = **1**: direção errada, mas o bônus de gol do visitante (+1) é independente da direção.
- `[5,0]` vs `[5,0]` = **10**: placar exato trava em 10 e encerra; nunca acumula além disso.
- `null` = 0 e exato=false sempre.

### Conferência de primeiro deploy (rodar UMA vez, depois descartar — NÃO é teste permanente)
Apenas no primeiro deploy, com somente os 2 primeiros jogos lançados (J1 México 2x0, J2 Coreia 2x1), confira manualmente que o ranking reproduz a tabela abaixo. Isto serve para validar que o código replica o cálculo conferido contra o site real. **Assim que o jogo 3 for lançado, esta tabela fica obsoleta e deve ser ignorada — não a transforme em teste automatizado.**

| Participante | Total | Exatos |
|---|---|---|
| Polvo Fernando | 18 | 1 |
| Camilo Thomas | 16 | 1 |
| Cesar Santos | 14 | 0 |
| Carolina Argento | 11 | 1 |
| David | 11 | 1 |
| Fabio Scaringella | 11 | 1 |
| Juliana ajaj | 11 | 1 |
| Drinho | 10 | 1 |
| Pepo Costa | 10 | 1 |
| Alexandre Nassif | 7 | 0 |
| Bruno Henrique | 7 | 0 |
| Igor Bammesberger | 7 | 0 |
| Joao Ajaj | 6 | 0 |
| Andres Vera | 0 | 0 |
| Gabriel Portella | 0 | 0 |

(Camilo Thomas = 16 e Alexandre Nassif = 7 validam o merge de alias "uma conta palpitou, a outra não". Se você já lançou mais jogos, os totais serão outros — isso é esperado, não é erro.)

## Estética
Simples, limpo, mobile-first (vou abrir no celular). Pódio/destaque para o top 3 é bem-vindo. Sem firulas.

---

## ARQUIVOS DE DADOS INICIAIS (criar exatamente com este conteúdo)

### `fixtures.json`
```json
{
  "1": {
    "home": "México",
    "away": "África do Sul",
    "date": "11/06 16h",
    "group": "A",
    "round": 1
  },
  "2": {
    "home": "Coreia do Sul",
    "away": "Rep. Tcheca",
    "date": "11/06 23h",
    "group": "A",
    "round": 1
  },
  "3": {
    "home": "Canadá",
    "away": "Bósnia",
    "date": "12/06 16h",
    "group": "B",
    "round": 1
  },
  "4": {
    "home": "EUA",
    "away": "Paraguai",
    "date": "12/06 22h",
    "group": "D",
    "round": 1
  },
  "5": {
    "home": "Catar",
    "away": "Suíça",
    "date": "13/06 16h",
    "group": "B",
    "round": 1
  },
  "6": {
    "home": "Brasil",
    "away": "Marrocos",
    "date": "13/06 19h",
    "group": "C",
    "round": 1
  },
  "7": {
    "home": "Haiti",
    "away": "Escócia",
    "date": "13/06 22h",
    "group": "C",
    "round": 1
  },
  "8": {
    "home": "Austrália",
    "away": "Turquia",
    "date": "14/06 1h",
    "group": "D",
    "round": 1
  },
  "9": {
    "home": "Alemanha",
    "away": "Curaçao",
    "date": "14/06 14h",
    "group": "E",
    "round": 1
  },
  "10": {
    "home": "Holanda",
    "away": "Japão",
    "date": "14/06 17h",
    "group": "F",
    "round": 1
  },
  "11": {
    "home": "Costa do Marfim",
    "away": "Equador",
    "date": "14/06 20h",
    "group": "E",
    "round": 1
  },
  "12": {
    "home": "Suécia",
    "away": "Tunísia",
    "date": "14/06 23h",
    "group": "F",
    "round": 1
  },
  "13": {
    "home": "Espanha",
    "away": "Cabo Verde",
    "date": "15/06 13h",
    "group": "H",
    "round": 1
  },
  "14": {
    "home": "Bélgica",
    "away": "Egito",
    "date": "15/06 16h",
    "group": "G",
    "round": 1
  },
  "15": {
    "home": "Arábia Saudita",
    "away": "Uruguai",
    "date": "15/06 19h",
    "group": "H",
    "round": 1
  },
  "16": {
    "home": "Irã",
    "away": "Nova Zelândia",
    "date": "15/06 22h",
    "group": "G",
    "round": 1
  },
  "17": {
    "home": "Argentina",
    "away": "Argélia",
    "date": "16/06 14h",
    "group": "J",
    "round": 1
  },
  "18": {
    "home": "França",
    "away": "Senegal",
    "date": "16/06 16h",
    "group": "I",
    "round": 1
  },
  "19": {
    "home": "Iraque",
    "away": "Noruega",
    "date": "16/06 19h",
    "group": "I",
    "round": 1
  },
  "20": {
    "home": "Áustria",
    "away": "Jordânia",
    "date": "17/06 1h",
    "group": "J",
    "round": 1
  },
  "21": {
    "home": "Portugal",
    "away": "RD Congo",
    "date": "17/06 14h",
    "group": "K",
    "round": 1
  },
  "22": {
    "home": "Inglaterra",
    "away": "Croácia",
    "date": "17/06 17h",
    "group": "L",
    "round": 1
  },
  "23": {
    "home": "Gana",
    "away": "Panamá",
    "date": "17/06 20h",
    "group": "L",
    "round": 1
  },
  "24": {
    "home": "Uzbequistão",
    "away": "Colômbia",
    "date": "17/06 23h",
    "group": "K",
    "round": 1
  },
  "25": {
    "home": "Rep. Tcheca",
    "away": "África do Sul",
    "date": "18/06 13h",
    "group": "A",
    "round": 2
  },
  "26": {
    "home": "Suíça",
    "away": "Bósnia",
    "date": "18/06 16h",
    "group": "B",
    "round": 2
  },
  "27": {
    "home": "Canadá",
    "away": "Catar",
    "date": "18/06 19h",
    "group": "B",
    "round": 2
  },
  "28": {
    "home": "México",
    "away": "Coreia do Sul",
    "date": "18/06 22h",
    "group": "A",
    "round": 2
  },
  "29": {
    "home": "Turquia",
    "away": "Paraguai",
    "date": "19/06 1h",
    "group": "D",
    "round": 2
  },
  "30": {
    "home": "EUA",
    "away": "Austrália",
    "date": "19/06 16h",
    "group": "D",
    "round": 2
  },
  "31": {
    "home": "Escócia",
    "away": "Marrocos",
    "date": "19/06 19h",
    "group": "C",
    "round": 2
  },
  "32": {
    "home": "Brasil",
    "away": "Haiti",
    "date": "19/06 22h",
    "group": "C",
    "round": 2
  },
  "33": {
    "home": "Holanda",
    "away": "Suécia",
    "date": "20/06 14h",
    "group": "F",
    "round": 2
  },
  "34": {
    "home": "Alemanha",
    "away": "Costa do Marfim",
    "date": "20/06 17h",
    "group": "E",
    "round": 2
  },
  "35": {
    "home": "Equador",
    "away": "Curaçao",
    "date": "20/06 21h",
    "group": "E",
    "round": 2
  },
  "36": {
    "home": "Tunísia",
    "away": "Japão",
    "date": "21/06 1h",
    "group": "F",
    "round": 2
  },
  "37": {
    "home": "Espanha",
    "away": "Arábia Saudita",
    "date": "21/06 13h",
    "group": "H",
    "round": 2
  },
  "38": {
    "home": "Bélgica",
    "away": "Irã",
    "date": "21/06 16h",
    "group": "G",
    "round": 2
  },
  "39": {
    "home": "Uruguai",
    "away": "Cabo Verde",
    "date": "21/06 19h",
    "group": "H",
    "round": 2
  },
  "40": {
    "home": "Nova Zelândia",
    "away": "Egito",
    "date": "21/06 22h",
    "group": "G",
    "round": 2
  },
  "41": {
    "home": "Argentina",
    "away": "Áustria",
    "date": "22/06 14h",
    "group": "J",
    "round": 2
  },
  "42": {
    "home": "França",
    "away": "Iraque",
    "date": "22/06 18h",
    "group": "I",
    "round": 2
  },
  "43": {
    "home": "Noruega",
    "away": "Senegal",
    "date": "22/06 21h",
    "group": "I",
    "round": 2
  },
  "44": {
    "home": "Jordânia",
    "away": "Argélia",
    "date": "23/06 0h",
    "group": "J",
    "round": 2
  },
  "45": {
    "home": "Portugal",
    "away": "Uzbequistão",
    "date": "23/06 14h",
    "group": "K",
    "round": 2
  },
  "46": {
    "home": "Inglaterra",
    "away": "Gana",
    "date": "23/06 17h",
    "group": "L",
    "round": 2
  },
  "47": {
    "home": "Panamá",
    "away": "Croácia",
    "date": "23/06 20h",
    "group": "L",
    "round": 2
  },
  "48": {
    "home": "Colômbia",
    "away": "RD Congo",
    "date": "23/06 23h",
    "group": "K",
    "round": 2
  },
  "49": {
    "home": "Suíça",
    "away": "Canadá",
    "date": "24/06 16h",
    "group": "B",
    "round": 3
  },
  "50": {
    "home": "Bósnia",
    "away": "Catar",
    "date": "24/06 16h",
    "group": "B",
    "round": 3
  },
  "51": {
    "home": "Escócia",
    "away": "Brasil",
    "date": "24/06 19h",
    "group": "C",
    "round": 3
  },
  "52": {
    "home": "Marrocos",
    "away": "Haiti",
    "date": "24/06 19h",
    "group": "C",
    "round": 3
  },
  "53": {
    "home": "Rep. Tcheca",
    "away": "México",
    "date": "24/06 22h",
    "group": "A",
    "round": 3
  },
  "54": {
    "home": "África do Sul",
    "away": "Coreia do Sul",
    "date": "24/06 22h",
    "group": "A",
    "round": 3
  },
  "55": {
    "home": "Equador",
    "away": "Alemanha",
    "date": "25/06 17h",
    "group": "E",
    "round": 3
  },
  "56": {
    "home": "Curaçao",
    "away": "Costa do Marfim",
    "date": "25/06 17h",
    "group": "E",
    "round": 3
  },
  "57": {
    "home": "Japão",
    "away": "Suécia",
    "date": "25/06 20h",
    "group": "F",
    "round": 3
  },
  "58": {
    "home": "Tunísia",
    "away": "Holanda",
    "date": "25/06 20h",
    "group": "F",
    "round": 3
  },
  "59": {
    "home": "Turquia",
    "away": "EUA",
    "date": "25/06 23h",
    "group": "D",
    "round": 3
  },
  "60": {
    "home": "Paraguai",
    "away": "Austrália",
    "date": "25/06 23h",
    "group": "D",
    "round": 3
  },
  "61": {
    "home": "Noruega",
    "away": "França",
    "date": "26/06 16h",
    "group": "I",
    "round": 3
  },
  "62": {
    "home": "Senegal",
    "away": "Iraque",
    "date": "26/06 16h",
    "group": "I",
    "round": 3
  },
  "63": {
    "home": "Cabo Verde",
    "away": "Arábia Saudita",
    "date": "26/06 21h",
    "group": "H",
    "round": 3
  },
  "64": {
    "home": "Uruguai",
    "away": "Espanha",
    "date": "26/06 21h",
    "group": "H",
    "round": 3
  },
  "65": {
    "home": "Egito",
    "away": "Irã",
    "date": "27/06 0h",
    "group": "G",
    "round": 3
  },
  "66": {
    "home": "Nova Zelândia",
    "away": "Bélgica",
    "date": "27/06 0h",
    "group": "G",
    "round": 3
  },
  "67": {
    "home": "Panamá",
    "away": "Inglaterra",
    "date": "27/06 18h",
    "group": "L",
    "round": 3
  },
  "68": {
    "home": "Croácia",
    "away": "Gana",
    "date": "27/06 18h",
    "group": "L",
    "round": 3
  },
  "69": {
    "home": "Colômbia",
    "away": "Portugal",
    "date": "27/06 20h30",
    "group": "K",
    "round": 3
  },
  "70": {
    "home": "RD Congo",
    "away": "Uzbequistão",
    "date": "27/06 20h30",
    "group": "K",
    "round": 3
  },
  "71": {
    "home": "Argélia",
    "away": "Áustria",
    "date": "27/06 23h",
    "group": "J",
    "round": 3
  },
  "72": {
    "home": "Jordânia",
    "away": "Argentina",
    "date": "27/06 23h",
    "group": "J",
    "round": 3
  }
}
```

### `config.json`
```json
{
  "exact": 10,
  "winner": 5,
  "goal_difference": 3,
  "goal_bonus_home": 1,
  "goal_bonus_away": 1,
  "floor": 0,
  "ceiling": 10
}
```

### `aliases.json`
```json
{
  "Xandó Acústico": "Alexandre Nassif",
  "Camilo Eiras Thomas": "Camilo Thomas"
}
```

### `results.json`
```json
{
  "1": [
    2,
    0
  ],
  "2": [
    2,
    1
  ]
}
```

### `bets.json`
```json
{
  "1": {
    "Alexandre Nassif": [
      1,
      0
    ],
    "Andres Vera": [
      1,
      1
    ],
    "Bruno Henrique": [
      2,
      1
    ],
    "Camilo Thomas": [
      2,
      0
    ],
    "Carolina Argento": [
      2,
      0
    ],
    "Cesar Santos": [
      2,
      1
    ],
    "David": [
      2,
      0
    ],
    "Drinho": [
      2,
      0
    ],
    "Fabio Scaringella": [
      2,
      0
    ],
    "Igor Bammesberger": [
      2,
      1
    ],
    "Joao Ajaj": [
      2,
      1
    ],
    "Juliana ajaj": [
      2,
      0
    ],
    "Pepo Costa": [
      2,
      0
    ],
    "Polvo Fernando": [
      2,
      0
    ]
  },
  "2": {
    "Alexandre Nassif": [
      1,
      1
    ],
    "Andres Vera": [
      1,
      2
    ],
    "Bruno Henrique": [
      1,
      1
    ],
    "Camilo Thomas": [
      2,
      0
    ],
    "Carolina Argento": [
      2,
      3
    ],
    "Cesar Santos": [
      1,
      0
    ],
    "David": [
      1,
      1
    ],
    "Drinho": [
      1,
      2
    ],
    "Fabio Scaringella": [
      2,
      2
    ],
    "Gabriel Portella": [
      1,
      2
    ],
    "Igor Bammesberger": [
      1,
      1
    ],
    "Joao Ajaj": [
      1,
      2
    ],
    "Juliana ajaj": [
      1,
      1
    ],
    "Pepo Costa": [
      1,
      2
    ],
    "Polvo Fernando": [
      1,
      0
    ]
  }
}
```
