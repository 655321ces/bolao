# Userscript — Capturar palpites

Lê os palpites da página **"Palpites de todos"** do bolaogratis e **commita** `data/bets.json`
no GitHub direto do navegador — sem print, sem OCR, sem git na mão. Funciona no
**Firefox (Android e desktop)** e no **Chrome desktop**. (Chrome no Android não roda userscripts.)

## 1. Instalar o Violentmonkey

- **Firefox (Android ou desktop):** instale a extensão **Violentmonkey** da loja de add-ons.
- **Chrome desktop:** instale **Violentmonkey** (ou Tampermonkey) da Chrome Web Store.

## 2. Instalar o script

Abra esta URL no navegador com o Violentmonkey instalado — ele oferece instalar:

```
https://raw.githubusercontent.com/655321ces/bolao/main/tools/userscript/bolao-palpites.user.js
```

Para **atualizar** depois de mudanças no script (ou no `engine.js`, que vem por `@require` e fica
em cache): reinstale pela mesma URL, ou no painel do Violentmonkey force a atualização do script.

## 3. Criar o token do GitHub (uma vez)

O commit precisa de um token com permissão de escrita **só neste repositório**:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** `655321ces` · **Repository access:** *Only select repositories* → `bolao`.
3. **Permissions → Repository permissions → Contents:** **Read and write**.
4. Gere, copie o token (`github_pat_…`).
5. Na página de palpites, clique no **⚙** do painel do script e cole o token. Fica salvo neste
   dispositivo (no armazenamento do Violentmonkey), **nunca** vai para o repositório.

> Token é como senha: não compartilhe nem commite. Se vazar, revogue no GitHub e gere outro.

## 4. Usar

1. Abra **Palpites de todos** logado: `https://bolaogratis.com.br/pool/bolao-maravilhoso-e-eterno/palpites-de-todos`
2. Selecione o jogo no seletor do site (os palpites só aparecem depois do prazo de apostas encerrar).
3. **Limpe o campo "Buscar membro"** (se houver busca ativa, a lista fica filtrada).
4. No painel (canto inferior direito), clique **Pré-visualizar**. Confira:
   - jogo casado e se a ordem foi invertida em relação ao site (os placares são reorientados para a ordem mandante × visitante do fixture);
   - nº de participantes / "não palpitou";
   - avisos de **nome não reconhecido** (novo participante? confira a grafia / `aliases.json`) e de **CONFLITO**.
5. Clique **Commitar palpites**. Ele lê o `bets.json` atual, substitui o jogo, ordena e dá commit
   (`Jogo N (Home x Away): palpites`). O GitHub Pages republica sozinho.

## Observações

- **Times com grafia diferente do site** já estão mapeados no script (`TEAM_ALIASES`): *Tchéquia → Rep. Tcheca*,
  *Estados Unidos → EUA*, *Bósnia e Herzegovina → Bósnia*. Se aparecer um time novo que não casa, adicione ali.
- A lógica de merge/alias/conflito é a mesma do `engine.js`/`admin.html` (reusada via `@require`), então a saída
  é idêntica ao fluxo manual.
- `_selftest.html` (nesta pasta) valida o extrator contra um trecho do HTML real — ferramenta de desenvolvimento, não usada em produção.
