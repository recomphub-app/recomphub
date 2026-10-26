# Capturas do site

O site novo (`site/`) usa prints e clipes do próprio Black Flag. Todos seguem as regras de
`SITE.md`: nada de capa de jogo, logo ou arte de outras empresas.

## O que já está gravado

Feitos numa biblioteca de demonstração: dez jogos fictícios ("Maré Negra", "Coroa de Ferro",
"O Faroleiro"...) com arte abstrata desenhada para isso, rodando a interface real do programa
em 1600×1000.

| Arquivo | Onde aparece no site | O que mostra |
|---|---|---|
| `img/biblioteca.jpg` | capa do vídeo da Visão geral, Recursos > Biblioteca, imagem de compartilhamento | A biblioteca com "Continuar jogando" |
| `video/foco.webm` | Visão geral (topo), Galeria | O cursor passando pelos jogos e o fundo mudando para a arte de cada um |
| `video/abrir-jogo.webm` | Recursos > Biblioteca, Galeria | Clicar num jogo: a capa vai até a página dele e volta |
| `video/modo-tv.webm` | Visão geral ("Do sofá"), Galeria | O Modo TV andando pelas setas e trocando de seção |
| `img/modo-tv.jpg` | Recursos > Modo TV, Galeria | O Modo TV parado |
| `img/jogo.jpg` | Recursos > Saves, Galeria | Página de um jogo com o recado de onde parou |
| `img/antes-de-jogar.jpg` | Visão geral, Recursos > Antes de jogar, Galeria | O aviso de Visual C++ e OneDrive com os botões |
| `img/emuladores.jpg` | Recursos > Emuladores, Galeria | Os cartões dos consoles |
| `img/perfis.jpg` | Recursos > Perfis, Galeria | "Quem vai jogar?" com três perfis |
| `img/conquista.png` | Recursos > Conquistas, Galeria | O aviso de conquista dourado |

## O que só dá para gravar com o programa de verdade

Estas mostram o Black Flag junto do mundo real (um jogo rodando, o controle na mão). Têm lugar
reservado na Galeria (comentário no fim dela em `index.html`).

1. **`video/jogo-com-conquista.webm`**: um jogo rodando e o aviso dourado de conquista subindo
   no canto. Use um jogo grátis e de código aberto (por exemplo SuperTuxKart, adicionado como Jogo
   de PC) ou um port com as conquistas do próprio Black Flag. Evite jogos de grandes empresas,
   porque a imagem do jogo é deles. Para forçar o aviso sem jogar até a conquista: Configurações >
   Conquistas > Testar aviso.
2. **`video/controle-na-mao.webm`**: filmado com o celular, de lado e um pouco por cima, a TV ou o
   monitor com o Modo TV e as mãos no controle trocando de jogo. Luz baixa no quarto e a tela clara
   ficam bonitas; deixe a tela ocupar dois terços da imagem.
3. **`video/instalar-emulador.webm`**: em Emuladores, clicar em "Instalar o DuckStation" e ver a
   barra até "pronto". Corte a espera do meio se passar de 10 segundos.
4. **`video/voltar-do-jogo.webm`** (opcional): dentro de um jogo, segurar o botão Xbox/PS e o
   Black Flag voltar para a frente.

## Como gravar

- **Janela:** o Black Flag maximizado numa tela de 1920×1080, com a escala do Windows em 100%. Para
  os prints, 1600×1000 também serve. Feche o resto, esconda os ícones da área de trabalho.
- **Programa:** OBS Studio (grátis) em 60 quadros por segundo, ou a Xbox Game Bar (Win + Alt + R).
  O site aceita WebM (melhor) ou MP4. Sem som.
- **Tamanho:** de 5 a 10 segundos, até uns 6 MB cada. Comece e termine na mesma tela, para o vídeo
  dar a volta sem pular.
- **Privacidade:** use um perfil de teste. Nada de nome de usuário em caminhos de pasta, conta da
  Steam, e-mail ou chave de API na imagem.
- **Prints:** PNG para imagens pequenas com texto (como o aviso de conquista), JPG de qualidade 85
  a 90 para telas inteiras.

Depois de gravar, coloque o arquivo em `site/video/` (ou `site/img/`) e adicione o botão na
Galeria seguindo os que já estão lá: `data-full` é o arquivo que abre ampliado.
