# Situação do Black Flag

## Marcos

- [x] **v0.1** Biblioteca, instalação pelo GitHub do projeto, conferência de arquivos, botão Jogar, tempo de jogo, aviso de versão nova
- [x] **v0.2** Monitor de processos (tempo de jogo por fora), Fechar jogo, atalhos, pasta de saves, espaço em disco
- [x] **v0.3** "Como obter seus arquivos", Outros jogos de PC, etiquetas, abas
- [x] **v0.4** Capas no estilo do PCSX2
- [x] **v0.5** Fase 1: catálogo aberto (`catalog.json`) com verificação genérica, aba Descobrir, 5 ports
- [x] **v0.6** Fase 2: escolher versão, aviso por port, desinstalar guardando saves, backup em .zip, zerar tempo
- [x] **v0.7** Fase 3: opções de inicialização, favoritos e ocultos, bandeja, Modo TV, aviso de versão do Black Flag
- [x] **v0.8** Fase 4: decisões de arquitetura, este arquivo, mais testes automáticos
- [x] **v0.9** Aba Comunidade: ports da lista awesome-unofficial-pc-ports e dos tópicos do GitHub, instalação experimental com aviso, escolha do programa, atualização e desinstalação
- [x] **v0.10** Arrastar e soltar a ROM ou a pasta do dump na página do jogo, botão "Procurar na pasta Downloads"
- [x] **v0.11** Capa, banner e descrição da SteamGridDB e da IGDB com a chave do jogador, guardados no PC (busca uma vez por jogo)
- [x] **v0.12** Perfis e Conquistas, fase 1: histórico de sessões, estado do jogo, vezes jogado, anotações, página Estatísticas
- [x] **v0.13** Fase 2: backup automático ao fechar o jogo (só quando mudou), limite por jogo, travar, restaurar com segurança, vigia da pasta de saves, Ludusavi para jogos de PC
- [x] **v0.14** Fase 3: perfis (progresso, histórico e anotações por jogador, "Quem vai jogar?" com mouse, teclado ou controle, saves separados por perfil jogo a jogo)
- [x] **v0.15** Fase 4: conquistas do Black Flag (gerais por tempo e sessões; Banjo-Kazooie pelo save), aviso por cima do jogo com som, 100%, aviso de teste
- [x] **v0.16** Fase 5: RetroAchievements só leitura, por perfil, jogo achado pelo MD5 da ROM
- [x] **v0.17** Jogos que exigem administrador abrem pelo pedido de permissão do Windows (UAC); opção "Abrir como administrador" por jogo
- [x] **v0.18** Central de Mods (Thunderstore) para Majora's Mask e Banjo: instalar com dependências, ligar e desligar, atualizar, desinstalar, mods por perfil, coleções
- [x] **v0.19** Token do GitHub (5.000 consultas por hora), Adicionar à Steam (jogo não Steam com capa), "Pular esta versão", limite de tamanho nos pacotes de mods
- [x] **v0.20** Visual novo do programa, no estilo de manual do site (tema escuro, um vermelho, linhas finas, Archivo nos títulos)
- [x] **v0.21** Seu PC: aviso de compatibilidade por port (processador, vídeo, driver, Windows, Visual C++), placa de vídeo e API gráfica por jogo, antivírus explicado; variáveis de ambiente também no modo administrador
- [x] **v0.22** Contador de FPS por cima do jogo (PresentMon da Intel, permissão de administrador uma única vez)
- [x] **v0.23** God of War III no SpartanPort (nome novo, instalações antigas mantidas, exigência de CPU corrigida para só AVX) e cache de shaders na página do jogo
- [x] **v0.24** Comunidade: .7z e .exe portátil, instaladores explicados, nome do jogo nos cartões (inFAMOUS, The Last Guardian…), tópicos native-port, xenonrecomp e ps3recomp
- [x] **v0.25** Fotos na aba Comunidade (capa da SteamGridDB/IGDB ou imagem do README do projeto)
- [x] **v0.26** "O jogo fechou com erro": código de saída, registro de erros do Windows, crash dumps e log do port viram uma explicação com botões (driver, Visual C++, Vulkan, cache de shaders) e um relatório para colar numa issue; visual mais enxuto (menus Mais e Adicionar, página do jogo e Configurações em abas) e tutorial de boas-vindas com a chave da SteamGridDB; biblioteca com contagem nas abas e filtros em menus; Comunidade com filtro de console e ordem (Recomendados, Em alta, Mais estrelas, Atualizados há pouco, Nome)
- [x] **v0.27** Antes de jogar: DLLs que faltam (lidas do programa e das DLLs da pasta), arquivos só na nuvem do OneDrive, caminhos longos e pasta sem permissão, com Visual C++ e DirectX instalados com 1 clique (só da Microsoft, hash e assinatura conferidos, um pedido de administrador); "Mostrar o jogo" quando já está aberto; arquivo em uso diz qual programa o segura. O programa inteiro com controle: navegação por todas as telas, botões do controle em uso (✕ ○ ou A B), LB/RB nas abas, Menu abre o Modo TV, e segurar o botão Xbox/PS (ou View + Menu) traz o Black Flag de volta de dentro do jogo. Modo TV novo, com ideias do PS4 e do Xbox 360: fileira de jogos com o escolhido maior e a arte dele no fundo, seções Jogos, Descobrir, Conquistas e Sistema no LB/RB, barra com o que cada botão faz, Guia no Menu/Options, som e vibração que dá para desligar
- [x] **v0.28** Jogos da Steam, Epic e GOG na biblioteca (fase 1 do launcher geral) e o nome novo: Black Flag
- [x] **v0.29** Perfil do seu jeito: foto, capa, qualquer cor (também no lugar do vermelho), aparência (tamanho das capas, letras, lista, abas, aba inicial, animações, sons, abrir no Modo TV), capas e fundo de cada jogo só do perfil com várias versões e legenda, exportar e importar o perfil; "Onde eu parei": recado ao fechar o jogo, mostrado quando você volta
- [x] **v0.30** Perfis como na Netflix ("Quem vai jogar?" com fotos grandes, Adicionar e Gerenciar perfis), capa do perfil com a parte que aparece e a arte de um jogo, capa no alto da biblioteca com "Continuar jogando", fundo do jogo também na página do jogo
- [x] **v0.31** Layout centralizado, aba Descobrir trocada por Adicionar > Instalar um port, tutorial novo com as capas num passo especial e espera de 6 segundos em Próximo e Pular
- [x] **v0.32** Capas buscadas sozinhas em segundo plano, arte desfocada atrás das páginas (escolhida no perfil), aviso da Comunidade em destaque, link do token do GitHub (e de outras páginas de ajuda) funcionando
- [x] **v0.33** Fechar a janela encerra o programa, controle só age com o Black Flag na frente, Comunidade com mais tópicos e forks conhecidos (SpartanPort)
- [x] **v0.34** Pasta do jogo abaixo do Jogar (Abrir a pasta, Copiar caminho), em destaque logo depois de instalar
- [x] **v0.35** Desinstalar apaga a pasta inteira do port com aviso (pasta, arquivos, tamanho; OK depois de 2 s), abas Steam, Epic e GOG na biblioteca
- [x] **v0.42** Visual novo de console: preto e dourado, seções no alto (Biblioteca, Emuladores, Instalar ports, Comunidade, Estatísticas) trocadas com LB/RB, abas da biblioteca em pílulas, capas arredondadas que crescem e brilham ao escolher, relógio e perfil no canto, "Continuar jogando" mesmo sem capa de perfil; tutorial com os passos das seções e dos emuladores, Próximo/Pular depois de 2 s
- [x] **v0.43** Conquistas do RetroAchievements no PCSX2: o jogo de PS2 é achado pelo mesmo hash do PCSX2 (ou pelo log dele, para .chd), cada conquista desbloqueada aparece na hora no aviso por cima do jogo com o emblema, a lista fica na página do jogo e o cartão do PCSX2 mostra se as conquistas estão ligadas e com qual conta
- [x] **v0.44** Conquistas lidas do save de mais dois ports: Majora's Mask (13: os quatro chefes, máscaras, canções, corações, Skulltulas, Deus Feroz) e Harvest Moon 64 (14: colheitas, leite, ovos, peixes, dinheiro, cavalo, estufa, frutas do poder, casamento, bebê, segundo ano). Donkey Kong 64 fica para depois: o save dele é um fluxo de bits que a decompilação ainda não nomeou
- [x] **v0.45** Conquistas da Steam no Black Flag: a página de cada jogo da Steam mostra as conquistas (em português quando o jogo tem, com ícone, data e as secretas escondidas), lidas dos arquivos que a própria Steam guarda no PC; durante o jogo, cada conquista nova aparece no aviso por cima do jogo
- [x] **v0.46** Capas e conquistas num passo à parte: ao terminar ou pular o tutorial, abre a tela com a chave da SteamGridDB e a conta do RetroAchievements (Salvar e testar em cada uma); a biblioteca mostra um aviso enquanto faltar alguma (Agora não esconde por 3 dias); Mais > Capas e conquistas abre de novo; ao salvar a chave, todas as capas que faltam são buscadas na hora
- [x] **v0.47** Acabamento e movimento: o fundo da biblioteca troca para a arte do jogo em foco (com o mouse ou o controle), a capa do jogo "viaja" da grade até a página dele e volta, menus, diálogos e avisos com entradas curtas, ícones desenhados no lugar de símbolos, rótulos sem maiúsculas monoespaçadas, avisos sem faixas grossas na lateral, seleção de texto, cursor e barra de rolagem nas cores do programa, e menos movimento quando o Windows ou o perfil pedem
- [x] **v0.48** Logo novo: a bandeira dourada com o corte em V (a mesma marca que já ficava ao lado do nome), com uma caveira recortada nela cujos olhos são o direcional e os quatro botões de um controle; uma cor só, em vetor (`docs/logo/`), no ícone do programa, do instalador e da bandeja
- [x] **v0.49** Estado do controle: aviso por cima do jogo quando o controle cai, volta ou fica com a bateria fraca (controles vistos pelo XInput), e a tela Testar controle (Mais > Testar controle), com o controle desenhado acendendo cada botÃ£o, analÃ³gicos com a distÃ¢ncia do centro, gatilhos que fazem vibrar e a bateria de cada controle. Na 0.49.1: jogo da Steam desinstalado sai da biblioteca mesmo quando a Steam deixa arquivos na pasta (vale o appmanifest), e as capas da Comunidade tiradas do README sÃ£o buscadas de novo na SteamGridDB/IGDB assim que a chave Ã© posta
- [x] **v0.50** Atualizar o Black Flag pelo prÃ³prio programa: a faixa de versÃ£o nova (vista ao abrir e a cada 6 horas) tem Atualizar agora, que baixa o instalador da release no GitHub, confere o sha256, fecha, instala sem perguntas e abre de novo; com um jogo aberto, espera
- [x] **v0.51** Instalar ports vira vitrine: destaque que passa sozinho pelos ports verificados, atalhos por console e prateleiras (verificados, mais populares, recomendados, atualizados hÃ¡ pouco); a pÃ¡gina de cada port ganha a ficha do GitHub ao lado (versÃ£o, tamanho, downloads, estrelas, problemas abertos, licenÃ§a, VocÃª fornece) e O que mudou com as notas das Ãºltimas versÃµes
- [x] Repositório público (MIT) na organização `recomphub-app`, com site no GitHub Pages; a situação atual está em `HANDOFF.md`
- [ ] Mais ports no catálogo (cada um com dados conferidos no código-fonte)

## Rumo novo: launcher de jogos geral (decidido em 24/10/2026)

O Gustavo decidiu que o programa deixa de ser só de ports nativos e vira um launcher que
reconhece jogos de vários lugares e configura tudo pelo próprio programa, e passa a se chamar Black Flag. Fases, cada uma testada antes da próxima:

- [x] **Fase 1: jogos das lojas** (v0.28, Steam, Epic e GOG). Achar os jogos instalados da Steam, da Epic e da GOG, só
  lendo os arquivos e o registro de cada loja (sem login). Abrir pela loja, contar o tempo
  pela pasta do jogo e importar sozinho ao abrir o programa. Um jogo removido não volta.
  Depois: Xbox/Microsoft Store, EA, Ubisoft, Amazon e itch.
- [x] **Fase 2: emuladores** (v0.40, desenhada com o Codex: `Desktop\calude\emuladores-consenso.md`). 16 emuladores para 24 consoles, instalados das páginas oficiais em modo portable e preparados no primeiro uso; BIOS e firmware conferidos; jogos achados pelo cabeçalho; aba Emulados. Reconhecer os emuladores instalados (PCSX2, DuckStation, RPCS3,
  Dolphin, Cemu, Ryujinx/Ryubing, Xenia Canary, xemu, PPSSPP, RetroArch) e instalar os que
  faltam pela página oficial no GitHub, como os ports. Pastas de jogos por console, abrir o
  jogo pela linha de comando de cada emulador (`clay/emuladores/emuladores-cli.json`), conferir
  BIOS e firmware antes de jogar (só abrir a pasta certa; nunca baixar BIOS, firmware nem jogos).
- [ ] **Fase 3: configurar pelo programa.** Para cada emulador, as opções mais usadas
  (resolução, tela cheia, API gráfica, limite de FPS, controle) escritas na configuração dele,
  com cópia antes de mudar e volta automática se o jogo não abrir; ajustes por jogo e perfis
  prontos (Desempenho, Qualidade). Base: `clay/toggles` e o padrão "Generator" do RetroBat.
- [ ] **Fase 4: extras.** Conquistas do RetroAchievements nos emuladores, saves dos emuladores
  no backup, correções com um clique (`clay/auto-cura`) e medição de desempenho
  (`clay/auto-tuning`).

## Testes automáticos

Rodam no GitHub Actions antes de gerar o instalador (`cargo test --lib`):

| Área | O que garantem |
| --- | --- |
| Catálogo | O `catalog.json` embutido é válido; caminhos não saem da pasta do port; modelos de caminho só usam pastas conhecidas |
| ROM de N64 | `.v64` e `.n64` viram `.z64`; ROM de outra região é identificada na mensagem; a busca numa pasta só acha a ROM exata, até um nível abaixo |
| Dump de PS4 | `param.sfo` é lido (`TITLE_ID`, `APP_VER`) e arquivo estranho é recusado |
| Saves | Saves sobrevivem a desinstalar/reinstalar; o backup .zip tem uma pasta por jogo |
| Capas | `${serial}` e `${title}` são montados e codificados; só `https`; imagem reconhecida pelos bytes |
| SteamGridDB e IGDB | Nome igual tem preferência sobre o primeiro resultado; só imagens dos servidores dos dois sites; a busca da IGDB não deixa o nome escapar da consulta; jogo encontrado fica guardado e jogo não encontrado é tentado de novo depois de uma semana |
| Histórico | Sessões curtas não entram; a semana começa na segunda no fuso do jogador; totais por jogo, dia, semana, maior sessão e dias seguidos |
| Backups automáticos | Saves iguais não geram backup novo; só os N mais recentes ficam, os travados sempre; restaurar devolve a pasta inteira e recusa backup de outro jogo ou nome inválido; resposta JSON do Ludusavi |
| Perfis | Cada perfil guarda o próprio progresso e a instalação é a mesma; nomes e ids de perfil; histórico e estatísticas só do perfil em uso |
| Conquistas | `achievements.json` embutido é válido; contador inventado é recusado; o save do Banjo conta Jiggies e notas do melhor arquivo; cada conquista desbloqueia uma vez só e guarda a data |
| RetroAchievements | Jogo achado pelo hash da ROM; progresso lido na ordem de exibição; nome de ícone não sai da pasta |
| Central de Mods | Lista da Thunderstore só com downloads da Thunderstore; dependências antes e ciclos param; só .nrm/.rtz saem do pacote; id e jogo lidos do .nrm; mods.json preserva o que o port escreveu; dependências órfãs |
| Instalação | A pasta única no topo do .zip é removida; zip plano fica como está |
| Limites dos mods | Pacote no limite passa; arquivo ou pacote acima é recusado e a pasta temporária some |
| Token do GitHub | Formato do token; o token só vai para api.github.com, nunca para downloads ou endereços parecidos |
| Seu PC | Placas de vídeo lidas do PowerShell; processador sem MOVBE/BMI1/LZCNT bloqueia o gow3; driver antigo e adaptador básico avisados; valores do GpuPreference |
| FPS | Quadros por segundo a partir do CSV do PresentMon; SID e nome do programa do PresentMon validados |
| Steam | CRC igual ao padrão; atalhos existentes regravados byte a byte; clicar de novo atualiza sem duplicar e mantém o id; arquivo quebrado ou com dados sobrando é recusado |
| Antes de jogar | Tabelas de importação de programas de 32 e 64 bits (normais e de carga atrasada); arquivo danificado não é lido além do fim; DLLs separadas em Visual C++, Visual C++ antigo, DirectX, Vulkan e arquivo do jogo; OneDrive pelos atributos; teste de escrita apaga o arquivo; downloads só de endereços da Microsoft, SHA-256 do endereço e assinatura `O=Microsoft Corporation`; códigos de saída do instalador |
| Controle | Botões que chamam o Black Flag (Xbox, View + Menu); dispara uma vez por toque longo, depois de 0,7 s |
| Lojas | Formato de texto da Steam (aspas, chaves, comentários, os dois formatos do `libraryfolders.vdf`); só jogos instalados de verdade, sem ferramentas nem Proton; manifestos da Epic sem DLC, plugin ou instalação pela metade; programa da GOG dentro da pasta; o jogador mantém nome, tempo e favorito; jogo removido não volta e o desinstalado sai guardando o tempo; só endereços `steam://` e `com.epicgames.launcher://` abrem |
| Perfis do seu jeito | Aparência só com valores conhecidos (a aba "Todos" nunca some); perfil antigo ganha a aparência padrão; cores só `#rrggbb`; nomes de imagem sem pasta nem `..`; versão de capa escolhida que não existe mais não aparece; o recado é de cada perfil |
| Outros | Argumentos com aspas, nomes de variáveis, nomes de atalho, datas, comparação de versões |

## Regras de trabalho

- Toda mudança passa pelo ciclo: código → GitHub Actions (testes + instalador) → teste do
  Gustavo no Windows → correção.
- Uma decisão de `ARCHITECTURE_DECISIONS.md` só muda com o motivo escrito lá primeiro.
- Port novo no catálogo: dados tirados do código-fonte do port, `revision` aumentado, e
  `cargo test` passando. Veja `CATALOG.md`.
- Campos novos na biblioteca ou nas configurações sempre com valor padrão, para não quebrar
  bibliotecas antigas.
- Textos para o usuário em português do Brasil, explicando o que fazer, não só o erro.
