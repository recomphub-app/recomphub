# Auditoria de design e desempenho (09/11/2026)

Revisão do programa inteiro feita na v0.56, com o Codex como segunda opinião. Cada item diz o que
foi visto no código, o que fazer e quanto custa. Nada aqui foi medido num PC de verdade: a UI roda
no CI e numa prévia de navegador com dados de exemplo, então os números são contas, não medições.

## O que já entrou na v0.56

- Caixa de verdade: frente, verso, lombada e a outra lateral; dobradiça nas caixas de plástico;
  faixa de luz que cruza a capa do jogo escolhido; luz dourada atrás dele.
- A caixa vira na própria estante (botão no canto, tecla F, Y do controle). O verso traz tempo de
  jogo, vezes jogado, última vez, estado, ano de lançamento, gênero e versão; na página do jogo,
  também o resumo.
- Embaixo da caixa ficou só o nome e uma linha curta (tempo jogado, ou o que pede atenção:
  jogando, atualização, falta arquivo). Os selos saíram: o console já está na faixa da caixa.
- Busca do jogo de cada card numa passada só (era uma busca na lista inteira por card).

## Desempenho

| # | O que foi visto | O que fazer | Ganho | Esforço |
|---|---|---|---|---|
| 1 | Toda capa vai para a tela como texto base64 do arquivo inteiro (`data_url`, lib.rs). `get_library` lê e codifica todas a cada chamada, e a tela pede a lista em 6 lugares, mais o `check_updates`. Com 300 jogos de 300 KB, são perto de 120 MB por pedido. | Servir as capas por endereço (protocolo `asset` do Tauri) e guardar miniaturas de 400 px em cache; a capa grande só na página do jogo. | Alto: abertura, memória e troca de aba | Médio |
| 2 | `get_library` é um comando comum (não `async`), então esse trabalho de disco roda na linha principal e a janela pode travar enquanto isso. | Depois do item 1, medir; o que continuar lento vai para `spawn_blocking`. Não marcar tudo como `async` às cegas. | Médio | Médio |
| 3 | A grade inteira é refeita a cada `render()` (`innerHTML`), e quase todo evento chama `render()`. | Refazer só quando a lista muda (comparar uma chave: ids + estado + capa); um ouvinte só na grade em vez de três por card. | Médio em bibliotecas grandes | Médio |
| 4 | Três laços que leem o controle a cada quadro (`padPoll`, `whoPoll`, `tvPoll`), mesmo sem controle ligado. Já param de agir quando a janela não está na frente. | Começar o laço no evento `gamepadconnected` (e conferir uma vez ao abrir) e parar com a janela escondida. | Baixo a médio (bateria, CPU parada) | Baixo |
| 5 | Com centenas de caixas, tudo é desenhado mesmo fora da tela. | `content-visibility: auto` nas fileiras fora da vista. Pede cuidado: corta a sombra e a prateleira que saem do card. | Médio com 300+ jogos | Baixo a médio |
| 6 | Capas grandes demais para o tamanho na tela (600×900 num card de 230 px). | Resolve junto com as miniaturas do item 1. | Médio | já contado |

O Codex concordou com o item 1 como o primeiro a fazer e discordou de tratar as caixas 3D como
problema de desempenho sem medir. Por isso a v0.56 mantém a frente plana em repouso e só cria as
outras faces na caixa escolhida ou virada.

## Design e uso

| # | O que foi visto | O que fazer | Esforço |
|---|---|---|---|
| 1 | O Modo TV é uma fileira com a escolhida maior; o Boxshelf usa as vizinhas inclinadas e mais escuras. | Fileira em "coverflow" no Modo TV e Y para virar a caixa lá também. | Médio |
| 2 | Sobram rótulos em letra de máquina e maiúsculas no Modo TV (`.tv-fam`, `.tv-meta .k`), fora do padrão da decisão 80. | Trocar pela letra normal, em caixa baixa. | Baixo |
| 3 | A mesma regra de `.card` aparece em cinco pontos do CSS, uma por decisão antiga. | Juntar numa só; dá menos surpresa a cada mudança de visual. | Médio |
| 4 | Os cards são `div` com foco; um leitor de tela não sabe que são botões nem o nome do jogo. | `role="button"` e `aria-label` com o nome e o estado; espaço abre, como o Enter. | Baixo |
| 5 | Página do jogo comprida; "Jogar" divide a atenção com a pasta, o emulador e as abas. | Subir "Jogar" para junto do título e recolher "Pasta do jogo" em Ajustes. | Médio |
| 6 | `app.js` tem 6.800 linhas num arquivo só. | Dividir em módulos por página (biblioteca, jogo, TV, emuladores, perfil). É manutenção, não velocidade. | Alto |

## Ideias novas

Em ordem do que parece render mais pelo trabalho:

1. **Verso real da caixa.** Quando existir uma imagem do verso (o banco do LaunchBox tem; o do
   libretro não), mostrar a foto e deixar os dados num segundo toque. Sem imagem, o verso de hoje.
2. **Busca geral (Ctrl+K).** Um campo que acha jogo, emulador, ajuste e port da comunidade.
3. **Prateleiras do jogador.** Coleções com nome ("Para zerar", "Com os amigos") que viram abas.
4. **Relatório de problema em zip.** Um botão que junta o log, o diagnóstico e os dados do PC,
   sem chaves nem nome de usuário, para anexar numa issue. Mostrar o conteúdo antes de salvar.
5. **Som ao virar e ao escolher a caixa**, ligado à opção de sons que já existe no perfil.
6. **Manual do jogo** (PDF do Internet Archive) aberto da página do jogo.
7. **Retrospectiva do ano** em Estatísticas: os mais jogados, o mês mais ativo, a maior sessão.
8. **Ordenar por "Mais baixados"** na Comunidade para quem pôs o token do GitHub.

Deixados de lado, em acordo com o Codex: Museu 3D, prévias em vídeo e o disco saindo da caixa.

## Ordem sugerida

1. Capas por endereço e miniaturas (desempenho 1 e 6).
2. Controle só quando há controle; grade refeita só quando muda (desempenho 3 e 4).
3. Modo TV com as vizinhas inclinadas e Y para virar (design 1 e 2).
4. Acessibilidade dos cards (design 4).
5. Busca geral e prateleiras do jogador.
