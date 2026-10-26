# Decisões de arquitetura

Decisões já tomadas, no estilo do `ARCHITECTURE_DECISIONS.md` do goldenballoon: cada uma diz
o que foi escolhido e por quê. Mudar uma delas pede um motivo novo, escrito aqui antes do código.

## Princípios que viram código

1. **Nenhum arquivo de jogo passa pelo Black Flag.** O launcher baixa só o *port* (código do
   projeto, do GitHub oficial). ROMs e dumps vêm da cópia do usuário e só são lidos para
   conferência; a ROM conferida é copiada para onde o port espera (`files::n64`), nunca enviada.
2. **Catálogo fechado e validado.** Ports são dados (`src-tauri/catalog.json`), não código.
   Cada entrada passa por `catalog::validate` antes de ser usada: links `https`, caminhos
   relativos que não saem da pasta do port, `repo` no formato `dono/nome`, modelos de caminho
   só com `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%` e `{install}`. Não há "fontes de
   terceiros" configuráveis. Um catálogo baixado só substitui o embutido com `revision` maior.
3. **Links abertos só do catálogo.** `open_link` recusa qualquer endereço que não esteja numa
   entrada do catálogo; o aviso de versão do Black Flag só abre a página de releases do projeto.

## Plataforma

4. **Tauri 2 (Rust + página web), só Windows por enquanto.** Instalador NSIS por usuário,
   sem administrador. O build acontece no GitHub Actions: o PC de desenvolvimento não precisa
   de Rust nem de Node. Antes do instalador, `cargo test --lib` precisa passar.
5. **Interface sem framework.** `ui/` é HTML, CSS e um `app.js` sem dependências, carregado
   com `withGlobalTauri`. A página nunca recebe caminhos para abrir por conta própria: tudo
   que mexe em arquivos ou abre programas é um comando Rust.
6. **Diálogos de arquivo bloqueiam** (`blocking_pick_*`) e por isso só rodam dentro de comandos
   `async`, nunca na thread principal.

## Dados do jogador

7. **Biblioteca em um JSON** (`%APPDATA%\io.github.recomphub\library.json`), gravada por
   arquivo temporário + `rename`. Campos novos sempre com `#[serde(default)]`, para que uma
   biblioteca antiga continue abrindo. Remover um jogo guarda o tempo de jogo em `removed`.
8. **Tempo de jogo por pasta, não por processo filho.** Um monitor (como o do Hydra) olha a cada
   3 s os programas que rodam de dentro da pasta de cada jogo; conta mesmo quando o jogo é
   aberto por fora. Salva a cada 30 s; intervalos maiores que 30 s (PC dormindo) não contam.
   Por isso pastas amplas demais (raiz do disco, Área de Trabalho, Downloads) são recusadas para
   "Outros jogos de PC".
9. **O Black Flag só apaga o que instalou.** "Desinstalar" exige que o port tenha sido instalado
   pelo Black Flag *e* que a pasta esteja dentro de `%LOCALAPPDATA%\io.github.recomphub\games`.
   Antes de apagar, os arquivos do jogador (`keep_on_update` e saves dentro do port) vão para
   `saves-pendentes\<id>` e voltam na próxima instalação.
10. **Atualizar nunca sobrescreve o que é do jogador.** A extração pula os caminhos de
    `keep_on_update` que já existem. Downloads com `.sha256` publicado são conferidos.

## Verificação de arquivos

11. **Dados de verificação vêm do código-fonte do port**, não de listas de terceiros: o XXH3, o
    `game_id` e o `program_id` dos ports N64: Recompiled saem do `src/main/main.cpp` de cada
    projeto. Assim o Black Flag aceita exatamente o que o port aceita.
12. **Explicar, não só recusar.** Uma ROM errada é identificada pelo cabeçalho (jogo, região,
    revisão) e a mensagem diz o que é e o que falta.

## Aba Comunidade

14. **Duas camadas: verificado e comunidade.** O catálogo (`catalog.json`) continua sendo a
    única fonte com conferência de arquivos. A aba Comunidade mostra ports puxados ao vivo da
    lista `Sebastrion/awesome-unofficial-pc-ports` (MIT) e dos tópicos `pc-port` e `n64recomp`
    do GitHub, sempre com o aviso "não verificado". Um port que já está no catálogo aparece
    marcado e leva à versão verificada.
15. **Cache de 12 horas.** Sem login, o GitHub permite 10 buscas por minuto e 60 chamadas por
    hora; a lista fica em `community.json` e só as páginas de release são consultadas na hora,
    uma por port aberto.
16. **Instalação experimental só da página de releases do projeto.** O endereço do .zip é
    buscado de novo no GitHub (nunca vem da página) e precisa começar com
    `https://github.com/<repo>/releases/download/`. Só repositórios que estão na lista da
    Comunidade (ou já instalados por ela) são aceitos. Só `.zip` de Windows; se o projeto não
    tem um, a página manda para o README. O Black Flag nunca procura nem baixa arquivos de jogos.
17. **Programa escolhido pelo jogador.** Depois de instalar, os `.exe` da pasta são listados; com
    um só, ele vira o botão Jogar; com vários, o jogador escolhe ("Escolher programa").

## Arquivos do jogador

18. **Arrastar e soltar e procurar nos Downloads usam a mesma conferência.** O arquivo solto na
    janela ou achado na pasta Downloads passa pelo mesmo caminho do botão "Escolher a ROM"
    (XXH3-64 tirado do código-fonte do port). Não usamos MD5: seria um segundo valor, sem
    garantia de bater com o que o port aceita.
19. **Procurar nos Downloads só quando o jogador clica.** Só arquivos .z64/.n64/.v64 de até
    64 MB, na pasta e nas pastas logo abaixo dela, no máximo 100 arquivos; só o que bater
    exatamente é mostrado, e o jogador confirma antes de ser entregue ao port. Nada sai do PC.
20. **Sem extrator ou patcher em segundo plano.** Os ports do catálogo leem os arquivos do
    jogador quando abrem; não há passo de extração. Se um port precisar disso, o passo entra no
    `catalog.json` como dado conferido e roda com progresso visível, nunca escondido. Programas
    de ports da Comunidade nunca são rodados pelo Black Flag além do botão Jogar.

## Histórico e estado

23. **Uma linha por sessão em `history.json`, separado da biblioteca.** Cada sessão guarda início,
    fim e o tempo que contou (sem o tempo com o PC dormindo). Sessões com menos de 10 segundos
    não entram; o arquivo guarda no máximo 20 mil sessões. Ao fechar o Black Flag com um jogo
    aberto, a sessão é registrada até ali.
24. **Estado do jogo como no Playnite.** Não jogado, Na fila, Jogando, Pausado, Zerado, Completo
    e Abandonado. Enquanto o jogador não escolhe, o estado vem do tempo de jogo; a primeira sessão
    marca "Jogando". Dias e semanas das estatísticas começam à meia-noite do fuso do PC; a
    semana começa na segunda.

## Saves automáticos

25. **Backup ao fechar o jogo, como o `wrap` do Ludusavi, mas só quando algo mudou.** Cada
    backup é um .zip em `Backups de saves/automaticos/<id>/` com `recomphub-backup.json`
    (jogo, pastas de origem, número de arquivos e uma impressão SHA-256 dos arquivos). Se a
    impressão for igual à do último backup, nenhum backup novo é feito. Ficam os N mais recentes
    (10 por padrão); um backup travado (`<arquivo>.lock`) nunca é apagado nem conta no limite.
26. **Restaurar nunca deixa uma pasta pela metade.** Antes, os saves atuais viram um backup
    "antes de restaurar" (sem apagar nenhum antigo até o fim). O .zip inteiro é lido e conferido
    contra a lista dele; a pasta nova é escrita ao lado da atual e as duas são trocadas por
    renomeação. Com o jogo aberto, restaurar é recusado.
27. **Vigia de saves por consulta, não por eventos do Windows.** As pastas de saves são pequenas
    e o Black Flag já olha os processos a cada 3 segundos; a cada 15 segundos ele olha o arquivo
    mais novo da pasta do jogo aberto e avisa a página ("save-changed"). As conquistas vão usar
    esse mesmo aviso.
28. **Ludusavi para os Outros jogos de PC, só se o jogador tiver.** O Black Flag procura o
    `ludusavi.exe` (escolhido pelo jogador, winget, scoop ou PATH), nunca baixa nem instala. Usa
    a linha de comando JSON dele (`find --api` e `backup --force --api`), e o backup fica na
    pasta configurada no próprio Ludusavi. Só um arquivo chamado `ludusavi.exe` é executado.

## Perfis

29. **O perfil ativo mora na biblioteca.** O que é de cada jogador (tempo, última sessão,
    favoritos, ocultos, estado, vezes jogado, anotações) fica no `library.json` para o perfil em
    uso; trocar de perfil guarda isso em `profiles/<id>.json` e carrega o do outro. Assim o resto
    do Black Flag não precisa saber de perfis. O que está instalado e onde é o mesmo para todos.
    As sessões do histórico levam o perfil; as antigas são do perfil "Principal".
30. **Trocar de perfil só com tudo fechado.** Com um jogo aberto ou uma instalação em andamento,
    a troca é recusada, para o tempo de jogo nunca ir para o perfil errado.
31. **Saves separados por perfil, ligados jogo a jogo.** Ao trocar de perfil: backup dos saves
    ("antes de trocar para o perfil X"), o conteúdo da pasta de saves vai para
    `profiles/saves/<perfil>/<jogo>/` e o do outro perfil volta. A pasta em si fica no lugar,
    para o port continuar achando. Ao ligar, os saves atuais ficam com o perfil em uso.

## Conquistas

32. **Conquistas próprias, nunca do RetroAchievements.** Os ports não avisam conquistas, e o
    RetroAchievements só aceita desbloqueios dos emuladores aprovados por ele; ler a memória do
    jogo para isso iria contra as regras deles. As conquistas do Black Flag têm o formato das do
    RetroAchievements (título, descrição, pontos, tipo, ícone, oculta) e ficam em
    `achievements.json`, conferido como o catálogo (ids, pontos de 1 a 100, contadores conhecidos).
33. **Gatilhos só com o que o Black Flag já lê.** Gerais (todo jogo): sessões, tempo total, maior
    sessão e dias jogados, do perfil em uso. Por jogo: o progresso lido do save, só leitura, com o
    formato tirado da decompilação pública do jogo (Banjo-Kazooie: `n64decomp/banjo-kazooie`, CC0;
    vale o melhor dos três saves). Um jogo novo ganha leitor só com o formato conferido e testado.
34. **Conferidas ao fechar o jogo e quando o save muda.** O vigia de saves (decisão 27) e o fim da
    sessão disparam a conferência; abrir a página do jogo também, sem aviso por cima. Os
    desbloqueios ficam em `achievements/<perfil>.json`.
35. **Aviso por cima do jogo, como o Steam Achievement Notifier.** Uma janela pequena, sem bordas,
    transparente, sempre no topo, que não rouba o foco e deixa os cliques passarem; some sozinha.
    O som é gerado na hora (Web Audio), sem arquivo de terceiros. Só aparece sobre jogos em janela
    ou tela cheia sem bordas; em tela cheia exclusiva a conquista fica registrada sem aviso. O
    Steam Achievement Notifier não tem licença: dele vieram só ideias, nenhum código.

## RetroAchievements

36. **Só leitura, por perfil, com a conta do próprio jogador.** Cada perfil pode ter usuário e
    Web API Key do RetroAchievements (a chave nunca volta para a página). A página de um port de
    N64 mostra o que o jogador ganhou no jogo ORIGINAL em emuladores; nada é enviado nem
    desbloqueado lá (decisão 32).
37. **O jogo é achado pela ROM, não por um id escrito à mão.** O RetroAchievements identifica
    jogos de N64 pelo MD5 da ROM em .z64, que é como os ports guardam a ROM do jogador. A lista de
    jogos do console (com os hashes) fica em cache por uma semana, o progresso de cada jogo por 6
    horas (ou "Atualizar agora") e os ícones das conquistas para sempre. Uma ROM que o
    RetroAchievements não conhece mostra só um aviso.

## Jogos que pedem administrador

38. **Pedir a permissão do Windows em vez de falhar.** Um programa cujo manifesto exige
    administrador não abre por CreateProcess (erro 740) e o Windows não mostra o UAC sozinho.
    Nesse caso o Black Flag abre o jogo com ShellExecuteEx "runas", que mostra o pedido de
    permissão, e marca o jogo para abrir assim das próximas vezes (o jogador pode desligar). O
    Black Flag em si continua sem administrador. Como um jogo com administrador pode esconder o
    caminho do programa, o vigia de sessões também o reconhece pelo nome do programa; e "Fechar
    jogo" avisa que o Windows não deixa fechá-lo de fora.
    Um programa aberto por "runas" não herda as variáveis de ambiente do Black Flag. Quando o
    jogo tem variáveis (Opções de inicialização), o pedido de permissão é para uma cópia do
    Black Flag com `--abrir-jogo-como-admin` e o pedido (programa, pasta, argumentos e
    variáveis) em base64 na linha de comando, não num arquivo, para nada mudar entre o UAC e a
    abertura. Essa cópia abre o jogo já como administrador e termina antes de abrir janela. Sem
    variáveis, o jogo é aberto direto, como antes (v0.20.1).

## Central de Mods

39. **Só a Thunderstore, só a comunidade do jogo.** O catálogo diz, por port, a comunidade da
    Thunderstore e o `game_id` dos mods (`"mods": { "thunderstore": ..., "game_id": ... }`). A
    lista vem da API pública (a mesma do r2modman), em cache por 6 horas; pacotes marcados como
    adultos não aparecem e os descontinuados só aparecem se já estiverem instalados. Os downloads
    só são aceitos de `thunderstore.io` e seus subdomínios, em https. Autor e página sempre à vista.
40. **Instalar do jeito que o port lê.** O N64ModernRuntime carrega os `.nrm` (e `.rtz`) de
    `<dados>/mods` e liga os mods listados em `<dados>/mods.json`. O Black Flag copia só esses
    arquivos (achatados, nomes conferidos, extração em streaming para pacotes de vários GB), lê o
    `mod.json` de cada `.nrm` para saber o id e recusa mod de outro jogo. Um arquivo de outro
    pacote nunca é sobrescrito; dependências vêm antes, e as que ninguém mais usa saem junto ao
    desinstalar. Mods que o jogador pôs à mão não são tocados.
41. **Mods por perfil e coleções.** Cada perfil guarda os pacotes que ligou
    (`mods/perfis/<perfil>/<jogo>.json`); antes de o jogo abrir, o `mods.json` fica igual à escolha
    do perfil em uso. Coleções são conjuntos com nome. Tudo isso só com o jogo fechado, porque o
    jogo reescreve o `mods.json`. Antes de instalar ou ligar um mod, backup dos saves.
42. **Limite de tamanho nos pacotes.** Um arquivo de mod pode ter até 512 MB e um pacote até
    2 GB. Os bytes copiados são contados (o tamanho escrito no .zip pode mentir), e um pacote
    acima do limite é recusado e o que já foi copiado é apagado, para nada pela metade parecer
    um mod inteiro. Ideia da revisão pelo Codex.

## GitHub e Steam (v0.19, ideias do GithubLauncher)

43. **Token do GitHub opcional, só para a API.** Sem login o GitHub responde 60 consultas por
    hora por PC; com um token pessoal sem permissões, 5.000. O token é testado antes de ser
    guardado, fica no `settings.json` deste PC, nunca volta para a página e só é enviado para
    `https://api.github.com/`, nunca para os endereços de download nem para outros sites.
44. **Pular uma versão, não todas.** "Pular esta versão" guarda a tag da versão nova; o aviso
    volta quando sair outra. Instalar limpa a escolha. "Avisar sobre versões novas: desligado"
    (decisão antiga) continua para quem não quer aviso nenhum.
45. **Adicionar à Steam como jogo não Steam.** O Black Flag edita o `shortcuts.vdf` da conta que
    usou a Steam por último. O atalho abre `recomphub.exe --play <id>`, então o tempo continua
    sendo contado, e a Steam dá Big Picture e a configuração de controle. Regras: só com a Steam
    fechada (ela regrava o arquivo ao sair); um arquivo que o Black Flag não entende por inteiro
    não é tocado; os outros atalhos são regravados byte a byte; clicar de novo atualiza o mesmo
    atalho (mesmo programa e mesmo `--play <id>`) e mantém o id dele; uma cópia do arquivo
    original fica em `shortcuts.vdf.recomphub-backup`. O id é o que a própria Steam calcularia,
    e capa e banner viram a arte do atalho na pasta `grid`.

## Seu PC (v0.21, dos issues dos ports)

46. **Avisar antes, com o que o próprio PC diz.** As causas mais comuns de "o port não abre"
    nos issues dos projetos são do PC: processador sem as instruções que o código do jogo usa
    (gow3_pc com Sandy/Ivy Bridge e Xeons antigos, erro 0xc000001d), driver de vídeo antigo ou
    ausente, Windows desatualizado e Visual C++ faltando. O Black Flag lê isso sem administrador
    (CPUID, com o XGETBV para as instruções AVX; Win32_VideoController pelo PowerShell, uma vez
    por execução; registro do Windows; DLLs do System32) e mostra na página do jogo. Instruções
    exigidas vêm do catálogo (`cpu_features`) e só entram com confirmação do projeto. O aviso
    não impede o jogador de tentar.
47. **Placa de vídeo e API gráfica por jogo.** A placa usa a mesma opção das Configurações do
    Windows (`HKCUSoftwareMicrosoftDirectXUserGpuPreferences`, por caminho do programa). Nos
    ports N64, só o `api_option` do `graphics.json` do port muda (Auto, D3D12, Vulkan), com o jogo
    fechado, porque trocar para Vulkan resolveu notebooks que renderizavam na placa integrada.
48. **Antivírus explicado, não contornado.** Os erros 225/226 do Windows e o programa do port
    sumido de uma pasta que ainda existe viram uma explicação com o caminho até o Histórico de
    proteção. O Black Flag nunca cria exclusões nem desliga o antivírus, e diz para só restaurar
    arquivos de ports vindos da página oficial.

## Contador de FPS (v0.22)

49. **PresentMon, não engenharia reversa.** O FPS vem do PresentMon da Intel (MIT), que lê os
    quadros pelo ETW do Windows, sem injetar nada no jogo, em DirectX e Vulkan. O HWMonitor foi
    descartado: não mede FPS e é um programa fechado. O PresentMon não vem no instalador: é
    baixado só quando o jogador pede, da release oficial da Intel no GitHub, e só é usado com
    assinatura digital válida da Intel. A leitura exige o grupo "Performance Log Users" (SID
    S-1-5-32-559): por escolha do jogador, uma cópia elevada do Black Flag coloca a conta nele uma
    única vez (NetLocalGroupAddMembers, pelo SID, para funcionar em qualquer idioma do Windows),
    e vale a partir do próximo login. O número aparece numa janela transparente, sem foco e que
    ignora cliques, no canto de cima; em tela cheia exclusiva o Windows a esconde. A medição
    começa quando o vigia vê o jogo aberto e termina com ele.

## Ports que mudam de nome e cache de shaders (v0.23)

50. **Mudança de nome sem perder ninguém.** O gow3_pc virou SpartanPort (repositório, arquivo do
    release, programa e lugar das configurações). O catálogo usa os nomes novos e guarda o
    programa antigo (`legacy_exe`), para uma instalação antiga continuar jogável até a atualização.
    Os marcadores são `run.py` e `scripts/prepare.py`, presentes em todas as versões de Windows,
    da gow3_pc 2.0 à SpartanPort 2.6.0, então até versões antigas do Black Flag reconhecem as duas
    (`legacy_markers` existe para quando não houver arquivos em comum). O caminho antigo das configurações fica em `settings_file`, que as
    versões antigas do Black Flag entendem, e o novo em `portable_settings_file`; assim quem ainda
    não atualizou o Black Flag continua vendo o jogo e já recebe o download certo. Os dados vêm do
    código do projeto (`legacy.py`, `USER_FILES` do launcher), não de suposição.
51. **Shaders: o port compila, o Black Flag cuida do cache.** Um launcher não consegue compilar
    os shaders pelo port (só o jogo sabe quais vai usar), e os ports já compilam em segundo plano.
    O Black Flag mostra o tamanho do cache, avisa na primeira vez que travadinhas são normais,
    lembra o driver de vídeo com que o cache foi feito e avisa quando ele mudou (cache de outro
    driver pode fechar o jogo ao abrir). "Limpar" move a pasta para `.recomphub-anterior` e
    "Desfazer" a devolve; nada é apagado sem uma cópia. Compartilhar cache entre jogadores fica de
    fora: depende da placa e do driver, e contém shaders do próprio jogo.

## Comunidade maior (v0.24)

52. **Mais formatos, nenhum instalador.** Ports da Comunidade podem vir em .zip, .7z ou como um
    .exe portátil. No .7z, cada nome é conferido antes de gravar (nada fora da pasta, nenhum nome
    de dispositivo do Windows, links ignorados) e o pacote é recusado inteiro se um falhar.
    Instaladores (Setup .exe, .msi) nunca são rodados pelo Black Flag: a página explica e leva à
    página de versões do projeto; depois o jogador adiciona o jogo como jogo de PC. A página
    também separa "o projeto ainda não publicou versão" de "só há arquivos para outros sistemas".
53. **O nome do jogo, não o do repositório.** Resultados por tópico do GitHub não dizem o jogo, e
    um cartão "iss_pc" não é reconhecido como inFAMOUS Second Son. O nome sai da descrição
    ("port of X", "X native PC port"), com regras testadas nas descrições reais da lista; quando
    a descrição não diz, fica o nome do repositório. Entraram os tópicos `native-port`,
    `xenonrecomp` e `ps3recomp`, e ports para outras máquinas (3DS, Vita, Switch) ficam de fora.

54. **Fotos na Comunidade sem servidor nosso.** Cada port ganha uma miniatura: a capa da
    SteamGridDB ou da IGDB (com a chave do jogador, pelo nome tirado da descrição) ou a primeira
    imagem do README do projeto. Do README só valem servidores do GitHub e o Imgur, sem selos nem
    botões de doação, até 8 MB, com limite de pixels e de memória antes de abrir a imagem. As
    miniaturas (360×360, JPEG) ficam em `comunidade-imagens/` e chegam aos poucos, em segundo
    plano; um port sem imagem é tentado de novo depois de uma semana.
55. **Diagnóstico de erro só com o que o PC já guarda.** Quando uma sessão termina, o Black Flag
    junta quatro fontes: o código de saída do programa que ele abriu (uma DLL faltando nunca
    chega ao registro do Windows), o evento 1000 "Application Error" do Windows (código e
    módulo, vale também para jogos abertos como administrador ou por fora), os crash dumps de
    `%LOCALAPPDATA%\CrashDumps` e o fim dos logs do port (campo `logs` do catálogo). Só aparece
    aviso com sinal concreto: código de falha (NTSTATUS ou exceção C++), evento, dump ou sessão
    de menos de 15 segundos; "Fechar jogo" nunca conta como erro, e o código de um launcher que
    sai normalmente é ignorado. A explicação vem de regras fixas (instrução ilegal → processador,
    DLL → Visual C++, módulo do driver → driver e Vulkan, sobreposições conhecidas), nunca de
    IA. O relatório esconde o nome da pasta do usuário e só sai do PC quando o jogador cola. O
    driver só é lembrado depois de uma sessão que terminou bem, para "o driver mudou desde a
    última vez que funcionou" continuar valendo depois de um fechamento com erro.
56. **Página do jogo em abas.** No alto ficam só Jogar e o que exige ação agora (versão nova,
    erro ao fechar, PC que não roda o port, arquivos faltando). O resto vai para abas: Visão geral,
    Mods, Saves, Conquistas e Ajustes; as Configurações seguem o mesmo modelo. O topo tem dois
    menus (Mais e Adicionar) em vez de oito botões. Na primeira abertura, um tutorial de seis
    passos explica o programa e ajuda a colar a chave da SteamGridDB; ele volta em Mais > Tutorial.
    Telas virtuais (Parsec, Spacedesk, monitores IDD) não contam como placa de vídeo.
57. **Antes de jogar: conferir sem mudar nada, corrigir só com um clique.** Ao abrir a página de
    um jogo instalado (port, comunidade ou jogo de PC), o Black Flag lê as tabelas de importação
    do programa (normais e de carga atrasada) e das DLLs da própria pasta, um nível por vez, e
    procura cada DLL na pasta do jogo, no System32 (SysWOW64 para programas de 32 bits), no
    Windows e no PATH. Também acusa arquivos só na nuvem do OneDrive (lidos pelos atributos,
    sem baixar), caminhos com 260 letras ou mais e pasta sem permissão de escrita (só para
    jogos que guardam saves na própria pasta). Um programa que está só na nuvem não é lido,
    para não ser baixado sem o jogador pedir.
58. **Pacotes da Microsoft só da Microsoft.** "Instalar Visual C++" (x64 ou x86) e "Instalar
    DirectX" baixam de endereços fixos no código (`aka.ms` e `download.microsoft.com`), seguem
    redirecionamentos só para `*.microsoft.com`, conferem o SHA-256 quando o endereço final o
    traz (Visual C++) e a assinatura Authenticode com `O=Microsoft Corporation` antes de abrir.
    O instalador roda em modo silencioso com um único pedido de administrador e o Black Flag
    espera o código de saída (3010 = reiniciar). Visual C++ antigo (2005 a 2013) só ganha o link
    da página da Microsoft. "Jogar" com o jogo já aberto traz a janela dele para a frente, e
    um arquivo que não pôde ser gravado diz qual programa o está usando (Restart Manager).
59. **O programa inteiro com controle.** A página lê o controle pela Gamepad API e move o foco
    para o item mais próximo na direção apertada (navegação espacial), em qualquer tela; LB/RB
    trocam as abas, Menu/Options abre o Modo TV, e uma barra embaixo mostra os botões do
    controle em uso (✕ ○ no PlayStation, A B no Xbox; na Nintendo o A, à direita, confirma). A
    barra some quando o mouse mexe. Com o Black Flag atrás de um jogo, a página não recebe o
    controle, então um processo nativo lê o XInput (`XInputGetStateEx`, que inclui o botão
    Xbox): segurar o botão Xbox/PS ou View + Menu por 0,7 s traz a janela de volta. Segurar,
    não apertar, porque o toque curto é da Xbox Game Bar. Controles PlayStation só são vistos
    assim através da Steam ou do DS4Windows.
60. **Modo TV com ideias de console, desenho do Black Flag.** Do PS4 vem a fileira única de jogos
    em que o escolhido cresce e fica na borda esquerda, com a arte dele (banner da SteamGridDB,
    senão a capa) no fundo, escurecida por uma camada lisa. Do Xbox 360 vêm as seções trocadas
    com LB/RB (Jogos, Descobrir, Conquistas, Sistema), a barra que diz o que cada botão faz agora
    e o Guia no Menu/Options. Nada dos dois projetos é copiado: o PS4-UI é MIT, mas a fonte, os
    sons e as imagens dele são da Sony; o xbox_dashboard não tem licença. Os sons são gerados
    pelo próprio programa (Web Audio) e, com a vibração, são desligados em Sistema; a escolha
    fica no navegador do app (`localStorage`), por ser só uma preferência deste PC.

61. **De launcher de ports a launcher geral.** Pedido do Gustavo em 24/10/2026: reconhecer jogos
    de vários lugares e configurá-los pelo programa (fases em `STATUS.md`). O princípio 1 continua
    valendo: nenhum jogo, BIOS ou firmware passa pelo programa. Lojas são lidas só nos arquivos e
    no registro delas, sem login nem senha; emuladores só vêm da página oficial de cada um.
62. **Jogos das lojas.** Steam (`libraryfolders.vdf` e `appmanifest_*.acf`, só `StateFlags` com o
    bit 4, sem redistribuíveis nem ferramentas), Epic (`ProgramData\Epic\...\Manifests\*.item`,
    sem instalação incompleta nem DLC) e GOG (registro `GOG.com\Games`). Cada jogo vira um "Jogo
    de PC" com id `loja-idDaLoja`. Steam e Epic abrem pelo endereço da própria loja (assim o
    DRM, a nuvem e as atualizações continuam com ela); a GOG abre o programa direto. O tempo
    conta pelos processos dentro da pasta do jogo, inclusive quando o jogo é aberto pela loja.
    A busca só atualiza pasta, programa e endereço: nome, capa, etiquetas e favorito são do
    jogador. Um jogo de loja removido pelo jogador vai para `excluded` e não volta sozinho; um
    jogo desinstalado na loja sai da biblioteca guardando o tempo de jogo. A capa da Steam vem
    do cache local dela (`appcache\librarycache`).

63. **O nome passa a ser Black Flag** (escolha do Gustavo em 24/10/2026, avisado de que é também
    o subtítulo de Assassin's Creed IV e o nome de uma banda). Muda o que o jogador vê: nome do
    programa, janela, instalador, ícone (bandeira vermelha no quadrado preto), site e textos.
    Ficam iguais, de propósito, os nomes internos: o identificador `io.github.recomphub` (é
    a pasta dos dados: biblioteca, saves, perfis), o programa `recomphub.exe` (atalhos e jogos
    na Steam apontam para ele) e os nomes de arquivos temporários e de backup. Como o
    instalador usa o nome do produto, o Black Flag instala numa pasta nova e o RecompHUB
    antigo deve ser desinstalado à mão (os dados ficam). A organização e o repositório no
    GitHub só mudam de nome depois de uma versão publicada que aceite os dois endereços, para
    quem usa uma versão antiga continuar recebendo o aviso de atualização.

64. **Cada perfil do seu jeito.** Decidido com o Codex (cada um propôs sem ver o outro, depois
    um avaliou o outro; ficou só o consenso). O perfil ganha foto e capa (imagem do PC ou a capa
    de um jogo), qualquer cor (`#rrggbb`), a opção de usar essa cor no lugar do vermelho e uma
    aparência (tamanho das capas, letras maiores, lista, aba inicial, abas visíveis, animações,
    sons e abrir no Modo TV). As capas de um jogo podem ser só do perfil, com várias versões e
    legenda, e um fundo próprio no Modo TV; os outros perfis continuam vendo a capa da
    biblioteca. As imagens ficam em `profiles/arte/<perfil>/`, com nomes dados pelo programa e
    conferidas pelos primeiros bytes, até 10 MB. "Exportar" gera um .zip com o perfil (sem a
    chave do RetroAchievements), o progresso e as imagens; "Importar" sempre cria um perfil
    novo e descarta referências a imagens que não vieram no arquivo.
65. **Onde eu parei.** Ao fim de uma sessão de 2 minutos ou mais, o programa pergunta onde o
    jogador parou (atalhos prontos ou texto, até 140 letras, pelo controle também). O recado é
    do perfil e aparece acima do Jogar e no Modo TV; depois de 3 dias ele ganha destaque.
    Ficaram de fora, por falta de consenso: vitrine de jogos e bio, "troca de sofá" e
    retrospectiva. Descartadas pelos dois: comparar requisitos da Steam com o PC e trocar de
    perfil pelo controle.

66. **Perfis como na Netflix.** "Quem vai jogar?" mostra fotos quadradas grandes com o nome
    embaixo, moldura clara no escolhido, "Adicionar perfil" no fim e "Gerenciar perfis" abaixo
    (setas, controle e mouse); o botão do perfil no topo abre essa tela para trocar a qualquer
    hora, e Esc/B volta sem trocar (menos ao abrir o programa, quando alguém precisa ser
    escolhido). "Gerenciar perfis" usa os mesmos quadrados com um lápis; clicar abre a edição.
    A capa do perfil ganhou a parte que aparece (de cima, do meio, de baixo), pode vir da arte de
    um jogo (o banner baixado, senão a capa) e, se o jogador quiser, fica no alto da biblioteca
    com um "Continuar jogando" do último jogo e o recado dele. O fundo próprio de um jogo
    também aparece no alto da página do jogo, não só no Modo TV.
67. **Tudo centralizado, sem a aba Descobrir, tutorial que espera.** As páginas ficam no meio
    da janela (biblioteca até 1360 px, página do jogo até 1180 px, Configurações e perfis até
    820 px) e a grade de jogos centraliza as colunas que tem, em vez de deixar a direita vazia.
    A aba Descobrir saiu da biblioteca e do Modo TV: com o launcher geral, a lista de ports
    virou uma página aberta por Adicionar > Instalar um port, com "← Biblioteca" no alto; um
    perfil que abria nela passa a abrir em Todos. O tutorial foi refeito para o launcher geral
    (lojas, perfis, controle), as capas viraram um passo especial (mais largo, com um jogo do
    próprio jogador sem e com capa) e Próximo e Pular só funcionam depois de 6 segundos em cada
    passo novo (Esc e B também), para o passo ser lido; um passo já visto abre sem espera.
68. **Capas em segundo plano, fundo do programa e páginas de ajuda.** Com uma chave, a
    biblioteca busca sozinha, um jogo por vez, as capas que faltam (o mesmo `game_meta` da
    página do jogo, que usa o que já está guardado), troca só o cartão que chegou e mostra
    "Buscando capas… faltam N"; cada jogo é pedido uma vez por execução. Atrás de todas as
    páginas fica uma arte desfocada e escura: a do jogo na página dele, e no resto o que o
    perfil escolheu (capa do perfil, último jogo jogado ou nada). O aviso da Comunidade virou
    um quadro amarelo. `open_link` passou a aceitar uma lista fixa de páginas de ajuda (criar
    token do GitHub, console da Twitch, Visual C++, drivers), que antes davam "Link fora do
    catálogo".
69. **Fechar é sair, e a Comunidade busca mais.** O X da janela encerra o Black Flag (com o ícone
    da bandeja e a thread do controle); a opção "Fechar para a bandeja" saiu, porque a janela
    escondida seguia recebendo o controle. O controle também só mexe no Black Flag quando a
    janela dele está na frente. A Comunidade busca 10 tópicos (o `pc-port` em 2 páginas de 100)
    e aceita forks com 20 estrelas ou mais (o SpartanPort é um fork do shadPS4); se o GitHub
    limitar as buscas, as seguintes não são tentadas e mantêm o que já havia. Uma lista salva
    por um conjunto antigo de buscas é refeita na hora.
70. **A pasta do jogo à vista.** Toda página de jogo mostra, logo abaixo do Jogar, o caminho da
    pasta com "Abrir a pasta" e "Copiar caminho" (antes ficava no fim de Ajustes). Logo depois
    de instalar (catálogo, Comunidade ou reinstalação) a linha vira um quadro verde
    "Instalado nesta pasta", até o jogador sair da página.
71. **Desinstalar apaga a pasta inteira do port, depois de um aviso.** O aviso mostra a pasta, o
    número de arquivos e o tamanho, e o botão só funciona depois de 2 segundos; os saves e
    configurações podem ser guardados para a próxima instalação (marcado por padrão). Vale
    também para ports adicionados de uma pasta do jogador, mas nunca para uma pasta rasa
    (menos de dois níveis), o Windows, a pasta do usuário ou as pastas conhecidas dele
    (Área de Trabalho, Documentos, Downloads, AppData...), nem uma pasta acima delas ou da
    pasta de jogos do Black Flag. Jogos das lojas e de PC não se desinstalam por aqui.
72. **Uma aba por loja.** Steam, Epic e GOG têm abas próprias (escondidas quando a loja não
    tem jogo neste PC); "Jogos de PC" fica só com os adicionados à mão.
73. **Emuladores (fase 2), desenhados com o Codex.** Cada um desenhou sozinho e depois
    debatemos (`Desktop\calude\emuladores-consenso.md`). Dois níveis: completo (DuckStation,
    PCSX2, Dolphin, PPSSPP, mGBA, RMG, RPCS3, xemu: instalados, preparados e conferidos) e
    básico (melonDS, Cemu, Xenia Canary, Azahar, Flycast, shadPS4, ares: instalados ou achados,
    abertos e explicados); Ryujinx só se o jogador já tiver. Download só das páginas oficiais
    (GitHub de cada projeto; o Dolphin pelo serviço de atualização dele), na pasta
    `Black Flag\Emuladores\<id>`, com o modo portable de cada um ligado; a atualização mantém os
    dados do jogador que ficam dentro da pasta. A configuração inicial (pasta da BIOS, controle
    no jogador 1 com os nomes que cada emulador usa no código, assistente marcado como concluído
    com a chave que ele mesmo grava) só vale para o que o Black Flag instalou e só com o
    portable ligado; emulador do jogador nunca é escrito. Jogo emulado é um tipo do Entry
    (`emulated`, com console e emulador escolhido); remover nunca apaga o arquivo do jogo. A
    sessão segue o processo do emulador que o Black Flag abriu (e os filhos dele), porque
    vários jogos usam a mesma pasta. Os jogos são achados pela pasta do console, pela extensão
    e, nos casos ambíguos, pelo cabeçalho (GameCube, Wii, Xbox/360, ISO9660 com
    PSP_GAME/PS3_GAME/SYSTEM.CNF, CHD por tipo de mídia, PBP de PS1); o que fica em dúvida vai
    para uma lista em que o jogador escolhe. BIOS e firmware: só presença, tamanho e formato,
    sem hash; nada é baixado.

## Capas

13. **Ordem fixa:** capa escolhida pelo jogador → imagem dos arquivos do próprio jogo → capa
    baixada (fontes curadas do catálogo, depois modelos do jogador com `${serial}`/`${title}`)
    → capa da SteamGridDB ou da IGDB (decisão 21) → ícone do programa (jogos de PC). Imagens só
    são guardadas se os primeiros bytes forem de PNG, JPG ou WEBP, até 10 MB.
21. **SteamGridDB e IGDB com a chave do próprio jogador.** As duas exigem chave (a IGDB, um
    Client ID e um Client Secret de um aplicativo da Twitch), e um segredo embutido no
    instalador deixaria de ser segredo. As chaves ficam no `settings.json` deste PC, nunca
    voltam para a página e só vão para os próprios sites (o segredo da IGDB no corpo do pedido,
    não no endereço). Sem chave, nada muda.
22. **Cada jogo é buscado uma vez.** O resultado fica em `meta/<id>.json` e as imagens em
    `meta/<id>/`. Um jogo encontrado só é buscado de novo quando o jogador pede ("Buscar de
    novo" ou "Buscar com outro nome"); um jogo não encontrado é tentado de novo depois de uma
    semana. O token da Twitch é reaproveitado até vencer. Só imagens dos servidores das duas
    (`*.steamgriddb.com`, `images.igdb.com`) são baixadas. Com as duas chaves, capa e banner
    vêm primeiro da SteamGridDB; descrição, ano e gêneros, da IGDB (em inglês). As fontes
    aparecem na página do jogo.
74. **Capas de PS1/PS2 pelo serial, pastas vigiadas, Ports e Emulados no Modo TV.** O serial do
    disco sai do SYSTEM.CNF (`BOOT2 = cdrom0:\SLUS_209.46;1` vira `SLUS-20946`) e a capa vem das
    coleções do xlenore no GitHub (`ps2-covers`, `psx-covers`, o mesmo endereço do baixador de
    capas do PCSX2), sem chave; só o serial sai do PC. As pastas de jogos ficam vigiadas: a cada
    10 segundos o Black Flag olha as horas de mudança das pastas (até três níveis) e, se algo
    mudou, procura de novo; o jogo novo aparece sozinho e a capa vem depois. No Modo TV, quando
    a biblioteca tem ports e jogos emulados, cada grupo ganha uma seção (LB/RB).

75. **Visual de console, preto e dourado.** Pedido do Gustavo em 25/10/2026, com o PS4-UI e o
    xbox_dashboard como referência (de novo só ideias, nada copiado; decisão 60). O que muda é a
    organização: as seções principais ficam no alto, no meio e grandes, como os pivôs do painel
    do Xbox (Biblioteca, Emuladores, Instalar ports, Comunidade, Estatísticas), e LB/RB trocam de
    seção onde a página não tem abas. Emuladores e Comunidade saem de menus e abas e viram seção;
    a barra fina de cima guarda o + Adicionar (dourado), o Modo TV, o Mais, o relógio e o perfil à
    direita, como num console. O dourado é o destaque (`--red` continua sendo o nome da cor de
    destaque, para a cor própria do perfil continuar valendo); avisos ficam em laranja para não
    se confundirem com ele. Os jogos viram blocos arredondados que crescem e brilham ao serem
    escolhidos (mouse, teclado ou controle). O tutorial espera 2 s por passo, não 6.

76. **Conquistas do RetroAchievements no PCSX2, lidas do log.** Pedido do Gustavo em
    25/10/2026. Quem desbloqueia é o PCSX2 (rcheevos, com o login feito nele; a senha e o token
    nunca passam pelo Black Flag). O Black Flag abre o PCSX2 com `-logfile` apontando para um
    arquivo dele (PCSX2 grava linha a linha, com `fflush`) e lê o que entra a cada segundo:
    `Achievements: Achievement <título> (<id>) for game <jogo> unlocked` vira o aviso por cima do
    jogo, com o emblema, na hora; `Hash for '<ELF>' (...): <md5>` acha o jogo na lista de PS2 do
    RetroAchievements. Antes de jogar, o jogo é achado pelo mesmo hash que o PCSX2 calcula
    (`Achievements::GetGameHash`: MD5 do nome do programa do BOOT2 seguido do programa, até 64 MB),
    lido da .iso/.bin; um .chd espera a primeira partida. A lista na página usa o usuário e a
    chave de API do perfil (decisão 32, só leitura). Polling da API foi descartado: atraso de até
    um minuto e consultas à toa. "Ligar as conquistas" só escreve no PCSX2 que o Black Flag
    instalou (decisão 73); no do jogador, o cartão explica onde ligar.

77. **Conquistas de Majora's Mask e Harvest Moon 64 lidas do save.** Pedido do Gustavo em
    26/10/2026. Mesmo caminho do Banjo (decisão 33): só leitura, layout tirado das
    decompilações públicas e conferido em teste. Majora's Mask: a flash de 128 KB (zeldaret/mm,
    `z64save.h` e `z_sram_NES.c`), 2 arquivos com cópia e save da coruja, valendo o melhor de
    todos; o ciclo de 3 dias apaga rúpias e munição, então só entram coisas que ficam (restos dos
    chefes, máscaras, canções, corações, caderno, Skulltulas). Harvest Moon 64: a SRAM
    (harvestwhisperer/hm64-decomp, `sramBuffer.h`), um diário a cada 0x1000 bytes com a
    assinatura "PACKINSOFT FARM2". Donkey Kong 64 ficou de fora: o save é um fluxo de bits com
    tabelas ainda sem nome na decompilação; ler errado daria conquistas falsas.

78. **Conquistas da Steam lidas dos arquivos do cliente.** Pedido do Gustavo em 26/10/2026. A
    Steam guarda em `appcache/stats` o esquema de cada jogo (`UserGameStatsSchema_<app>.bin`:
    nome e descrição em cada idioma, ícone) e o progresso da conta
    (`UserGameStats_<conta>_<app>.bin`: um bit por conquista e a data de cada uma), os dois em
    KeyValues binário, o formato do `shortcuts.vdf` que o Black Flag já lia. Nada de chave da Web
    API nem login: o Black Flag só lê esses arquivos (a conta é a última que usou a Steam no PC)
    e baixa o ícone uma vez do servidor de imagens da Steam. Durante uma sessão de um jogo da
    Steam, o arquivo de progresso é olhado a cada 2 segundos e o que aparecer de novo vira o aviso
    por cima do jogo. Limite conhecido: o aviso depende de quando a Steam regrava esse arquivo;
    o registro dela (`logs/stats_log.txt`) mostra a gravação, mas não o nome da conquista.

79. **As chaves num passo à parte, depois do tutorial.** Pedido do Gustavo em 26/10/2026: quem
    pulava o tutorial nunca via o passo das capas. Agora o tutorial só explica o programa e, ao
    terminar ou ser pulado, abre "Capas e conquistas" enquanto faltar a chave da SteamGridDB ou a
    conta do RetroAchievements (cada uma com Salvar e testar e com o passo a passo para conseguir
    a chave). "Fazer depois" fecha; a biblioteca continua com um aviso até as duas estarem
    postas, e o "Agora não" do aviso o esconde por 3 dias (no `localStorage`, por ser só uma
    preferência deste PC). Ao salvar a chave da SteamGridDB, todos os jogos sem capa são
    buscados de novo na hora.

80. **Movimento e acabamento, com as skills de design.** Pedido do Gustavo em 26/10/2026, com
    as skills frontend-design, impeccable e taste-skill como régua. O mundo preto e dourado da
    decisão 75 fica; muda o acabamento. Um único momento autoral: o jogo em foco na biblioteca
    (mouse ou controle) enche o fundo com a própria arte, em duas camadas que se cruzam. A troca
    de página usa View Transitions: a capa do jogo aberto viaja da grade até a página dele e
    volta, e o resto troca rápido (160–260 ms, `cubic-bezier(.16,1,.3,1)`, saída mais rápida que
    a entrada). Menus, diálogos e avisos têm entradas curtas, e só na abertura (o tutorial não
    se anima a cada passo). Saem os "tiques" que as três skills apontam: faixas coloridas grossas
    na lateral dos avisos (viram borda fina com um tom da cor), rótulos em maiúsculas
    monoespaçadas acima dos títulos, símbolos Unicode e emoji como ícones (viram SVG desenhados,
    traço 1.75). Seleção de texto, cursor e barra de rolagem seguem a paleta; números em tempos e
    contagens ficam alinhados. Com "reduzir movimento" do Windows ou "sem animações" do perfil,
    some o deslocamento e ficam só as trocas de cor e opacidade.

81. **Logo: a bandeira do programa com a caveira de controle.** Pedido do Gustavo em 26/10/2026:
    uma caveira dentro da bandeira, com o direcional num olho e os quatro botões no outro. A
    OpenArt (pelo conector MCP dela) gerou ideias; a escolhida foi redesenhada em vetor e, a pedido
    dele, sem a "cara de IA" (dourado em degradê, bandeira de clip-art com mastro, caveira redonda
    de desenho). A forma vem da marca que o programa já tinha: a bandeira dourada com o corte em V
    na ponta. Uma cor só (`#d9b45a`); a caveira é um vazio recortado na bandeira, então funciona em
    fundo escuro e claro; o crânio é facetado; os olhos são os controles, como ficam num controle
    (direcional à esquerda de quem olha, botões à direita), sem letras nem símbolos de console. O
    desenho sai de `docs/logo/logo-gen.js`; o `app-icon.png` (1024 px, transparente) gera os
    ícones no CI.

82. **Estado do controle: avisos por cima do jogo e a tela "Testar controle".** Pedido do Gustavo
    em 26/10/2026, a ideia que ficou em 1º na rodada de ideias com o Codex. A mesma linha que já
    lia o controle pelo XInput para trazer o programa de volta (`pad.rs`) passa a lembrar o estado
    de cada controle e a pedir a bateria a cada 30 s (`XInputGetBatteryInformation`). Avisa só
    mudanças: controle que caiu, "conectado de novo" (só depois de ter caído; um controle ligado
    pela primeira vez não avisa), e bateria fraca e acabando, uma vez por nível que desce (volta a
    avisar depois de carregar). O aviso vai para a janelinha por cima do jogo (a mesma das
    conquistas, em laranja, com um controle desenhado no lugar do troféu) só enquanto um jogo
    aberto pelo Black Flag está rodando; com o programa na frente, vira um aviso comum. Desliga em
    "Testar controle". Limite assumido: o XInput só vê controles de Xbox e os de PlayStation que
    passam pelo Steam ou pelo DS4Windows; um DualSense ligado direto não informa bateria nem queda,
    e a tela diz isso. A tela "Testar controle" (Mais > Testar controle) lê pela Gamepad API, que
    vê todos: um controle desenhado aqui (sem arte de fabricante) acende o que é apertado, os
    analógicos mostram a distância do centro (parado acima de 10% é folga), os gatilhos enchem e
    fazem vibrar, e a lista mostra cada controle do XInput com fio ou a bateria. Como cada botão
    ali é um teste, a navegação pelo controle fica parada; sai segurando Voltar (B ou ○) por 1,5 s,
    com uma barra que enche, ou com Fechar e Esc.

83. **Atualizar o Black Flag pelo próprio programa.** Pedido do Gustavo em 26/10/2026: a versão
    nova deve chegar sozinha ao programa instalado. Ele já perguntava ao GitHub na abertura, mas a
    faixa só abria a página da release. Agora pergunta também a cada 6 horas (o Modo TV fica aberto
    dias) e a faixa tem "Atualizar agora": o programa baixa o instalador `_x64-setup.exe` da última
    release do repositório do projeto (só de `github.com` e dos servidores de arquivos do GitHub),
    confere o sha256 que o GitHub dá para cada arquivo, fecha, roda o instalador em modo passivo
    (`/P`, só a barra de progresso; `/R`, abre o programa no fim) e abre de novo. Biblioteca, saves
    e perfis ficam no AppData, então nada se perde. Com um jogo aberto, não atualiza. Não usa o
    plugin de atualização do Tauri: ele pede uma chave de assinatura e um `latest.json` em cada
    release, e o instalador da release já é o que o site oferece. Instalar nunca começa sem o
    clique: o programa não fecha sozinho no meio de uma partida. Vale a partir da 0.50.0; quem tem
    uma versão anterior atualiza uma vez pela página, como antes.

84. **Instalar ports como vitrine, e a ficha do port.** Pedido do Gustavo em 26/10/2026, depois de
    estudar o recomplauncher.com. A tela deixa de ser uma grade e vira uma vitrine: um destaque que
    passa sozinho a cada 7 s pelos ports verificados (para quando o mouse ou o controle está nele, e
    não passa com "reduzir movimento"), atalhos por console com a contagem da Comunidade, e
    prateleiras: Verificados pelo Black Flag, Mais populares na Comunidade (numerada, pelas
    estrelas), Recomendados pela lista e Atualizados há pouco. O catálogo verificado tem poucos ports,
    então a Comunidade preenche as prateleiras, sempre marcada como não verificada. Buscar volta à
    grade de antes. A página de cada port (do catálogo e da Comunidade) ganha ao lado a ficha do
    GitHub do projeto (facts.rs): versão, quando saiu, tamanho do arquivo para Windows, downloads de
    todas as versões, estrelas, quantas versões, a primeira, problemas abertos e licença, com "Você
    fornece" no topo para quem ainda não instalou, e "O que mudou" com as notas das últimas 8
    versões (Markdown mostrado como texto: o HTML do projeto nunca entra na página). São duas
    consultas ao GitHub por projeto, guardadas por 6 horas; sem resposta, fica a última ficha. Do
    site deles não veio a aparência (azul e vidro) nem as capas oficiais; ficam o preto e dourado.

85. **Catálogo de ports no site, uma página por port.** Pedido do Gustavo em 26/10/2026, a segunda
    parte do estudo do recomplauncher.com. As páginas são HTML pronto, geradas na publicação por
    `tools/site-ports.mjs` a partir do mesmo `catalog.json` do programa, e não montadas no navegador:
    assim o Google lê cada port e o visitante não esbarra no limite de consultas do GitHub. A
    publicação roda também todo dia, para os números não envelhecerem. Cada página tem o que o
    port pede (Você fornece), como jogar em três passos, o "Bom saber" do catálogo, o que mudou nas
    últimas versões estáveis (as de teste ficam de fora quando há estáveis, no site e no programa) e
    a ficha ao lado, a mesma do programa, com Baixar o Black Flag no topo. Entram só os ports
    verificados; os 400 da Comunidade continuam só dentro do programa, com o aviso deles, porque uma
    página no nosso site pareceria uma recomendação. Sem arte de jogos (regra do site): um quadro
    com o console e o nome do jogo no lugar da capa.

86. **Capas e banners da SteamGridDB nas páginas de ports do site.** Pedido do Gustavo em 26/10/2026,
    para o site ficar como o recomplauncher.com, que faz o mesmo. Muda a regra de não ter arte de
    jogos no site, só para estas páginas, e por escolha dele, sabendo do risco: muitas imagens da
    SteamGridDB são a arte oficial dos jogos, e um pedido de remoção da Nintendo ou da Sony ao GitHub
    pode tirar o site do ar até ser resolvido. Para reduzir: as imagens vêm da comunidade da
    SteamGridDB (capa quadrada, artes de fãs antes de capas escaneadas), cada página credita quem
    enviou, o rodapé diz que qualquer imagem sai a pedido do dono (abrindo um pedido no GitHub), e
    `SKIP_ART` no script tira as de um port sem mexer no resto. A busca usa uma chave da SteamGridDB
    guardada como segredo do repositório (`SGDB_KEY`), posta pelo próprio Gustavo; sem ela, ficam os
    quadros com o nome. As imagens são as versões menores da SteamGridDB (as originais chegam a 4 MB),
    baixadas na publicação, e não entram no git.
