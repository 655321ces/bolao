# Resumo para planejamento do app de bolão

## Contexto inicial
O objetivo é criar um aplicativo de bolão para uso privado entre amigos, sem intenção de comercialização. Já existe boa parte do engine de cálculo dos valores e também a interface de exibição, e as principais dúvidas estão concentradas em login, interface de inserção dos palpites com trava de horário e na necessidade — ou não — de ter servidor, em vez de depender apenas de GitHub Pages.[cite:16][cite:29]

## Perguntas e dúvidas levantadas
As perguntas centrais da conversa foram:

- Como planejar o login dos usuários.
- Como estruturar a interface de inserção de palpites.
- Como implementar a trava de horário para impedir alterações após o início do jogo.
- Se seria necessário um servidor, ou se GitHub Pages seria suficiente.[cite:16][cite:29]

## Primeira direção técnica discutida
A avaliação foi que GitHub Pages, sozinho, funciona bem para hospedar a interface estática, mas não resolve autenticação real nem lógica confiável de gravação e bloqueio de palpites, porque não executa backend por conta própria.[cite:16][cite:29]

A recomendação inicial foi separar responsabilidades:

- Frontend estático para telas, ranking, exibição de jogos e formulários.
- Backend ou BaaS para login, persistência dos palpites, registro de horário de submissão e bloqueio de alterações após o prazo.[cite:12][cite:16][cite:29]

Também foi destacado que tudo que depende de confiança — como login, controle de edição e trava por horário — idealmente deve ficar fora do navegador, já que regras apenas no cliente podem ser alteradas pelo usuário.[cite:12][cite:29]

## Arquiteturas consideradas
Foram discutidas quatro direções principais:

| Opção | Papel no projeto | Avaliação na conversa |
|---|---|---|
| GitHub Pages puro | Hospedar apenas front estático | Insuficiente para login e gravação protegida de palpites.[cite:16][cite:29] |
| GitHub Pages + Supabase | Front estático com auth e banco | Melhor equilíbrio entre simplicidade e proteção.[cite:12][cite:22] |
| Cloudflare Pages + Functions | Front estático com lógica edge | Boa opção se houver interesse em mais controle de middleware.[cite:18] |
| Servidor próprio | Backend completo sob medida | Flexível, mas desnecessariamente trabalhoso para o contexto atual. |

## Modelo sugerido para o MVP
A sugestão mais forte foi construir um MVP com:

1. Frontend hospedado em GitHub Pages.[cite:16]
2. Autenticação e banco no Supabase ou Firebase, aproveitando planos gratuitos e serviços prontos de login.[cite:12][cite:22][cite:32]
3. Regra de fechamento feita no backend, usando a hora do servidor para aceitar ou rejeitar alterações nos palpites.[cite:12]
4. Sem servidor próprio, sem VPS e sem uma camada de infraestrutura mais pesada no início.

Esse modelo foi tratado como suficiente para um aplicativo pequeno entre amigos, com custo muito baixo ou nulo na fase inicial.[cite:12][cite:22][cite:32]

## Consideração adicional trazida depois
Na sequência, foi acrescentada uma consideração importante: o grupo é percebido como honesto, e portanto o controle poderia ser mais leniente se isso significasse menor custo e menor complexidade.[cite:29][cite:31]

Essa consideração mudou o foco da arquitetura: em vez de buscar segurança forte contra fraude deliberada, a meta passou a ser evitar erros acidentais, confusão operacional e edições indevidas por engano, com o mínimo de esforço técnico.[cite:29][cite:31]

## Simplificações aceitas nesse cenário
Com essa premissa de confiança entre os participantes, a conversa convergiu para as seguintes simplificações:

- Login simples, preferencialmente por magic link ou Google, sem fluxo sofisticado de cadastro.[cite:12][cite:32]
- Persistência de palpites em um backend pronto, sem criar servidor próprio.[cite:12][cite:22]
- Trava de horário simples no backend, sem trilha de auditoria avançada.[cite:12]
- Ausência, no MVP, de recursos mais complexos como antifraude, logs extensivos, papéis administrativos detalhados ou múltiplas camadas de validação.[cite:12][cite:29]

Também foi observado que uma solução ainda mais leve, sem login formal e baseada apenas em links individuais, poderia até existir, mas tenderia a gerar problemas de uso e organização, como perda do link, duplicidade de aposta e manutenção confusa.[cite:29][cite:31]

## Recomendação final consolidada
Até a última pergunta da conversa, a recomendação consolidada ficou assim:

- Hospedar a interface no GitHub Pages.[cite:16]
- Usar Supabase free como primeira opção para autenticação e banco de dados, por oferecer um conjunto simples e integrado para um app pequeno.[cite:12][cite:22]
- Considerar Firebase como alternativa viável, caso a integração faça mais sentido com a stack já existente.[cite:26][cite:32]
- Implementar a trava de horário no backend, usando o horário do servidor em vez do relógio local do navegador.[cite:12]
- Assumir uma arquitetura “boa o bastante”, orientada a custo zero ou muito baixo, já que o grupo é pequeno e de confiança.[cite:22][cite:29][cite:31]

## Último follow-up proposto
A última pergunta feita foi se valeria montar uma versão mínima viável da arquitetura, com tabelas e fluxo de telas, já pensada para custo zero.[cite:22][cite:29]

## Perguntas que ainda fazem sentido para o planejamento
Antes de desenvolver, ainda vale fechar internamente com o grupo:

- Todo mundo concorda em usar login simples por e-mail ou Google?
- Todo mundo aceita que a trava exista mais para evitar bagunça do que para garantir segurança absoluta?
- O grupo prefere custo zero com algumas limitações, ou topa um pequeno custo futuro se o uso crescer?
- Haverá alguém responsável por cadastrar jogos, resultados e eventuais correções?
- O grupo quer permitir edição até o horário exato do jogo ou prefere uma antecedência fixa, como 5 ou 15 minutos antes?

## Mensagem informal para mandar no grupo
Pessoal, estou começando a desenhar o app do bolão e queria alinhar com vocês uma decisão importante de arquitetura.

Como o grupo é pequeno e, em princípio, todo mundo joga de boa-fé, dá para fazer uma solução mais simples e praticamente sem custo, em vez de montar algo mais “pesado” para controle total. A ideia seria ter login simples, salvar os palpites num backend pronto e colocar uma trava de horário básica para evitar mudança depois do jogo começar.

Antes de seguir, queria sentir se todo mundo concorda com esse nível de leniência. As perguntas que eu queria fechar com vocês são:

- Está ok para vocês usar um login simples, tipo e-mail ou Google?
- Faz sentido assumir que o sistema precisa mais evitar bagunça do que impedir fraude sofisticada?
- Todo mundo concorda que, se alguém tiver acesso técnico para burlar algo, isso já fugiria do espírito do bolão e não vale a pena encarecer o projeto por causa disso?
- Preferem custo zero/quase zero mesmo que a solução seja mais simples?
- Está ok travar os palpites pelo horário do servidor e considerar isso como regra final?
- Querem que a edição fique liberada até o início exato do jogo, ou preferem travar um pouco antes?
- Faz sentido ter uma ou duas pessoas responsáveis por cadastrar jogos e resultados, em vez de abrir isso para todos?

Se o grupo topar essa linha, dá para começar mais rápido, com menos custo e menos manutenção.
