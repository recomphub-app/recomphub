# Site do Black Flag

O site fica em `site/` (HTML, CSS e JS puros, sem build) e vai para o GitHub Pages pelo
workflow `.github/workflows/site.yml`.

Desde 26/10/2026 ele tem quatro abas (Visão geral, Recursos, Galeria, Sobre e próximos passos), com
o mesmo visual preto e dourado do programa. Os prints e vídeos e como gravar os que faltam estão em
`SITE-CAPTURAS.md`.

## O que se atualiza sozinho

- **Botão Baixar:** pega o `.exe` do último Release do GitHub (`releases/latest`). Sem Release,
  leva para a página de versões.
- **Ports:** vêm do `src-tauri/catalog.json`, copiado para o site na hora de publicar.
- **Páginas dos ports:** `tools/site-ports.mjs` gera `ports.html` e uma `port-<id>.html` para cada port do
  catálogo, com a ficha lida do GitHub do projeto (versão, tamanho, downloads, estrelas, problemas abertos,
  licença) e o que mudou nas últimas versões estáveis. Roda a cada publicação e todo dia às 6h17 (horário de
  Brasília), então os números se atualizam sozinhos. Sem arte de jogos: cada port tem um quadro com o nome.
  Para ver antes, rode `node tools/site-ports.mjs <cópia do site>` numa cópia com o `catalog.json`.
- **Novidades:** as 5 últimas versões, com as linhas "- …" das notas de cada Release.

## Para lançar uma versão

1. Subir a versão em `package.json`, `src-tauri/Cargo.toml` e `src-tauri/tauri.conf.json`.
2. Criar a tag: `git tag v0.19.0 && git push origin v0.19.0`.
3. O workflow Build gera o instalador e publica o Release com ele; o site e o aviso de versão
   nova dentro do Black Flag passam a apontar para ele.

## Doações

A seção "Apoie o projeto" lê `site/doacoes.json`: com `pix.chave` preenchida, ela aparece com o botão
de copiar; vazia, some. Mudar o arquivo e enviar ao GitHub já atualiza o site.

## Regras do conteúdo

- Prints só do próprio Black Flag, sem capas de jogos nem ícones de mods com personagens.
- Nenhum logo ou arte da Nintendo, Sony ou de outras empresas; créditos a cada port.
- Nada que indique onde baixar jogos.
