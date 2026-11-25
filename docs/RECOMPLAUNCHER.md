# O que o RecompLauncher ensina (estudo de 25/11/2026)

[RecompLauncher](https://github.com/elripalda/RecompLauncher), de Ripalda: launcher de recomps
para Windows, Linux e Mac, feito em Tauri 2 + Rust com a janela em HTML e JS puro, como o Black
Flag. Criado em 29/10/2026, tinha 2.400 estrelas e 105 forks um mês depois. Licença GPL-3.0:
lemos só a documentação pública; nenhum código dele entrou no Black Flag (que é MIT).

## Por que deu certo

Não foi a interface. Foi um **padrão que os ports adotaram**: o `recomplauncher.json`, um
arquivo que o autor do port põe no zip da release dizendo como abrir o jogo, que cópia o jogador
tem de dar, onde ficam os saves, que ajustes existem e o que cada código de saída quer dizer. O
formato é público, tem schema e um guia escrito até para agentes de IA aplicarem nos repositórios
(ADD-SUPPORT.md). Em um mês, dezenas de ports passaram a anunciar "RecompLauncher support". Cada
port que adota o arquivo deixa o launcher melhor sem que o launcher mude.

Outras coisas que eles fazem bem:

- **Easy Setup:** o jogador solta a imagem do disco, o launcher confere (serial, ID do título,
  CRC dos dumps conhecidos do Redump) e o Jogar já abre com ela.
- **Ajustes do port na página do jogo:** resolução, FPS, controles, lidos e escritos direto no
  TOML/INI/JSON do port.
- **Relatos de jogadores** antes de instalar ("como roda para os outros").
- **Em breve:** ports que estão para sair, com aviso quando saem.
- **Versões lado a lado** quando um jogo tem mais de um port.
- **Variáveis para o jogo:** `RECOMPLAUNCHER_MODE=bigpicture` faz o port abrir em tela cheia no
  modo TV; `RECOMPLAUNCHER_PAD` mostra os botões certos desde o primeiro quadro.
- **22 idiomas**, Flatpak, Arch, Nix, Mac.
- **Conta com nuvem** (saves e biblioteca), selo de desenvolvedor verificado.

## O que entrou no Black Flag (v0.61)

- **Lemos o `recomplauncher.json`** dos ports da comunidade e dos jogos de PC (manifest.rs, código
  nosso). Ler um formato público de arquivo é interoperabilidade: não incorporamos o schema nem os
  exemplos deles.
- **Sua cópia do jogo:** quando o port pede, a página mostra o que ele pede (com o texto do autor),
  com Escolher arquivo/pasta. Conferimos tipo, extensão e o arquivo obrigatório de uma pasta. Não
  lemos o disco (serial, ID, CRC) e dizemos isso na tela.
- **Jogar abre do jeito do port:** o programa e os argumentos do arquivo, com a cópia escolhida, e
  as variáveis do protocolo (`RECOMPLAUNCHER=1`, `_MODE`, `_PAD`, `_DATA`) só para ports que trazem
  o arquivo. `RECOMPLAUNCHER_VERSION` não é passada: seria a versão de outro programa.
- **Saves:** as pastas que o port declara entram no backup automático e na sincronização entre PCs
  (v0.60). Por segurança, nunca a pasta inteira do jogo nem pastas-base do Windows.
- **Códigos de saída:** a mensagem do próprio autor aparece no diagnóstico; "ok" não é erro.
- **Instalação:** o programa que o arquivo indica vira o do Jogar, sem perguntar.
- **Download:** além do `.sha256` do projeto, conferimos a soma que o próprio GitHub guarda para
  cada arquivo (campo `digest` da API), quando existe.
- **Restaurar mais seguro (vale para tudo):** o Black Flag não troca uma pasta de saves que tenha
  um arquivo grande demais para o backup, porque ele se perderia.

## O que fica para depois, em ordem

1. **Ajustes do port na página** (`config` e `settings`): editar TOML/INI/JSON preservando
   comentários. Grande ganho, trabalho médio.
2. **Passo de preparo** (`prepare`): rodar o preparo do port sem janela, com as linhas de progresso.
3. **Conferir a cópia** pelo serial/ID e pelos dumps conhecidos (`dumps`), com o selo "verificada".
4. **Achar a cópia sozinho** nas pastas de jogos que o Black Flag já conhece (emuladores).
5. **Relatos de jogadores** e **Em breve**: pedem um serviço na internet; hoje o Black Flag não tem
   servidor, e isso é escolha (decisão 96).
6. **Idiomas:** o Black Flag é só em português; abrir para inglês e espanhol amplia muito o público.

O que não vamos copiar: conta e servidor próprios (o Black Flag segue sem conta) e efeitos de
tela com ReShade (pedem injetar código no jogo).
