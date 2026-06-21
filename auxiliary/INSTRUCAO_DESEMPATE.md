# Instrução COMPLEMENTAR — Critérios de Desempate do Bolão Copa 2026

> Esta é uma instrução **adicional** à instrução principal (`INSTRUCAO_CLAUDE_CODE.md`). NÃO substitui nada do que já foi definido. Apenas acrescenta a lógica de ordenação/desempate do ranking. O motor de pontuação, o modelo de dados, os aliases e as telas permanecem exatamente como na instrução principal.

## O que muda
Hoje o ranking ordena por **pontos** (desc) e apenas **exibe** o nº de placares exatos. Esta instrução define a **cascata de desempate** completa para ordenar participantes com a mesma pontuação.

## Cascata de ordenação do ranking
Ordene os participantes aplicando os critérios NESTA ordem, cada um só entra quando o anterior empata:

1. **Pontos totais** (desc) — como já é hoje.
2. **1º critério — Placares exatos (cheios)** (desc): nº de jogos em que o participante acertou o placar exato. (Já é contabilizado no app; agora vira critério de ordenação, não só coluna.)
3. **2º critério — Acertos de vencedor/empate (tendências)** (desc): nº de jogos em que o participante acertou a **direção** do resultado (mandante vence / empate / visitante vence), **independente do número de gols**. Conta inclusive empates acertados. Um placar exato também conta como tendência acertada (acertar o placar implica acertar a direção).
4. **3º critério — Acerto de gols do vencedor** (desc): nº de jogos **com vencedor definido** (NÃO empates) em que o participante acertou o número de gols de quem venceu.
   - Em jogos que terminaram empatados, NÃO há vencedor → esses jogos são **ignorados** neste critério (não somam, nem para nem contra).
   - "Gols do vencedor" = o placar do lado que venceu no resultado real. Ex.: resultado 3x1 (mandante vence com 3). Quem apostou `3x0` ou `3x2` acertou os gols do vencedor (3). Quem apostou `2x1` não.
5. **Empate residual:** se após os três critérios dois participantes continuarem idênticos, eles **permanecem empatados** — exibir ambos na **mesma posição** no ranking (ex.: dois "4º", e o próximo é "6º", pulando a posição). NÃO inventar 4º critério (ordem alfabética, data de entrada, etc.). O bolão não define desempate além destes três; empate real é exibido como empate.

## Definições precisas (para implementar sem ambiguidade)
Para cada participante, agregando sobre todos os jogos **que já têm resultado** em `results.json`:

- `exatos` (C1): contagem de jogos onde aposta `[ph,pa]` == resultado `[rh,ra]`. Apostas `null` (não palpitou) não contam.
- `tendencias` (C2): contagem de jogos onde `sinal(ph - pa) == sinal(rh - ra)`, com `sinal(x) = (x>0) - (x<0)`. Apostas `null` não contam.
- `gols_vencedor` (C3): contagem de jogos onde `rh != ra` (tem vencedor) E:
  - se `rh > ra` (vence mandante): `ph == rh`
  - se `ra > rh` (vence visitante): `pa == ra`
  Apostas `null` não contam. Jogos empatados (`rh == ra`) são pulados.

Chave de ordenação (do "melhor" para o "pior"):
```
ordenar por: ( pontos DESC, exatos DESC, tendencias DESC, gols_vencedor DESC )
sem critério adicional — empates remanescentes ficam na mesma posição
```

## Exibição no ranking
- Mostrar as colunas: **Posição**, **Nome**, **Pontos**, e idealmente as três métricas de desempate (**Exatos**, **Tendências**, **Gols Venc.**) para transparência — assim qualquer participante entende por que ficou à frente/atrás num empate de pontos.
- Posições empatadas (mesma tupla nos 4 valores) recebem o **mesmo número de posição**. A próxima posição pula de acordo com quantos empataram (padrão de ranking "1224").

## Critério de aceitação — TESTES SINTÉTICOS (permanentes, NÃO atrelados aos dados reais)

> Mesma regra da instrução principal: os testes da cascata devem usar **métricas inventadas fixas**, nunca os dados reais de `bets.json`/`results.json` (que mudam a cada jogo). Teste a **função de ordenação** diretamente, dando a ela tuplas de métricas prontas, e verifique a ordem resultante. Assim o teste vale o torneio inteiro.

Represente cada participante por uma tupla `(pontos, exatos, tendencias, gols_vencedor)`. A função de ordenação usa a chave `(-pontos, -exatos, -tendencias, -gols_vencedor, nome)`. Os testes abaixo devem todos passar:

1. **Pontos dominam tudo:** `X=(10,0,0,0)`, `Y=(9,9,9,9)` → ordem **[X, Y]**. (Mais pontos vence mesmo perdendo em todos os critérios de desempate.)
2. **Exatos desempatam pontos iguais:** `X=(20,1,0,0)`, `Y=(20,2,0,0)` → **[Y, X]**.
3. **Tendências desempatam (pontos+exatos iguais):** `X=(20,1,3,0)`, `Y=(20,1,2,5)` → **[X, Y]**. (X ganha por tendências apesar de Y ter mais gols_vencedor — a ordem dos critérios importa.)
4. **Gols do vencedor desempatam (pontos+exatos+tendências iguais):** `X=(20,1,2,1)`, `Y=(20,1,2,2)` → **[Y, X]**.
5. **Empate residual:** `A=(11,1,1,1)`, `B=(11,1,1,1)` → métricas idênticas; ambos recebem a **mesma posição** na exibição.

### Teste de atribuição de posições (padrão 1-2-2-4)
Dados `P1=(18,1,2,1)`, `P2a=(11,1,1,2)`, `P2b=(11,1,1,2)`, `P4=(10,1,1,1)`:
- P1 → posição **1**
- P2a e P2b → ambos posição **2** (empate real em todas as métricas)
- P4 → posição **4** (a posição 3 é pulada)

### Conferência de primeiro deploy (rodar UMA vez, depois descartar)
Apenas no primeiro deploy, com os 2 primeiros jogos, confirme que o ranking ordenado reproduz a tabela abaixo. **Obsoleta assim que o jogo 3 for lançado — não virar teste automatizado.**

| Pos | Participante | Pts | Exatos | Tendências | Gols Venc. |
|---|---|---|---|---|---|
| 1 | Polvo Fernando | 18 | 1 | 2 | 1 |
| 2 | Camilo Thomas | 16 | 1 | 2 | 2 |
| 3 | Cesar Santos | 14 | 0 | 2 | 1 |
| 4 | Carolina Argento | 11 | 1 | 1 | 2 |
| 4 | Fabio Scaringella | 11 | 1 | 1 | 2 |
| 6 | David | 11 | 1 | 1 | 1 |
| 6 | Juliana ajaj | 11 | 1 | 1 | 1 |
| 8 | Drinho | 10 | 1 | 1 | 1 |
| 8 | Pepo Costa | 10 | 1 | 1 | 1 |
| 10 | Bruno Henrique | 7 | 0 | 1 | 1 |
| 10 | Igor Bammesberger | 7 | 0 | 1 | 1 |
| 12 | Alexandre Nassif | 7 | 0 | 1 | 0 |
| 13 | Joao Ajaj | 6 | 0 | 1 | 1 |
| 14 | Andres Vera | 0 | 0 | 0 | 0 |
| 14 | Gabriel Portella | 0 | 0 | 0 | 0 |

Esta tabela ilustra a cascata funcionando (Carolina/Fabio à frente de David/Juliana por gols_vencedor; Alexandre atrás de Bruno/Igor pelo mesmo critério; empates residuais compartilhando posição). Mas é ilustração de um instante — com mais jogos lançados, os números mudam e isso é o esperado.
