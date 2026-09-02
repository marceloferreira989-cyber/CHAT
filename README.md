# Cantina Online

Versão adaptada da sua `cantina.html` para funcionar entre amigos pela internet usando **WebSocket + WebRTC**.

## Rodar no computador

1. Instale Node.js 18 ou mais recente.
2. Abra um terminal nesta pasta.
3. Rode `npm install`.
4. Rode `npm start`.
5. Abra `http://localhost:3000`.

Para testar localmente com duas pessoas, cada uma pode abrir o endereço no mesmo computador/rede. Para amigos em outras redes, publique esta pasta em um serviço que suporte Node.js e WebSocket, como Render, Railway ou outro host de Node. O endereço público precisa usar HTTPS para câmera, microfone e compartilhamento de tela.

## Como funciona

- O servidor mantém salas, participantes e chat.
- WebSocket faz a sinalização em tempo real.
- Áudio/vídeo/tela continuam usando WebRTC diretamente entre os navegadores.
- STUN do Google já está configurado no `cantina.html`.
- Em redes muito restritas, pode ser necessário adicionar um servidor TURN.

## Importante

Esta versão não usa mais `window.storage`. As salas ficam em memória no servidor e são apagadas quando o servidor reinicia.
