const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const rooms = new Map();

/* =========================
   FUNÇÕES AUXILIARES
========================= */

function cleanCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function cleanName(value) {
  return String(value || '')
    .trim()
    .slice(0, 20) || 'Visitante';
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function roomFor(code) {
  let room = rooms.get(code);

  if (!room) {
    room = {
      clients: new Map(),
      chat: []
    };

    rooms.set(code, room);
  }

  return room;
}

function snapshot(room) {
  return {
    members: [...room.clients.values()].map(client => client.member),
    chat: room.chat.slice(-200)
  };
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data, except) {
  for (const client of room.clients.values()) {
    if (client.ws !== except) {
      send(client.ws, data);
    }
  }
}

function broadcastState(room) {
  const data = {
    type: 'room-state',
    state: snapshot(room)
  };

  for (const client of room.clients.values()) {
    send(client.ws, data);
  }
}

/* =========================
   REMOVER USUÁRIO
========================= */

function removeClient(ws) {
  const code = ws.roomCode;

  if (!code) {
    return;
  }

  const room = rooms.get(code);

  if (!room) {
    return;
  }

  const client = room.clients.get(ws.clientId);

  if (client) {
    room.clients.delete(ws.clientId);

    room.chat.push({
      id: randomId(),
      system: true,
      text: `${client.member.name} saiu da sala.`,
      ts: Date.now()
    });

    room.chat = room.chat.slice(-200);

    broadcast(room, {
      type: 'signal',
      signal: {
        id: randomId(),
        from: client.member.id,
        to: '*',
        kind: 'leave',
        payload: {},
        ts: Date.now()
      }
    });

    broadcastState(room);
  }

  ws.roomCode = null;

  if (room.clients.size === 0) {
    rooms.delete(code);
  }
}

/* =========================
   SERVIDOR HTTP
   ARQUIVOS NA RAIZ
========================= */

const server = http.createServer((req, res) => {
  try {
    let urlPath = (req.url || '/').split('?')[0];

    // Página inicial
    if (urlPath === '/') {
      urlPath = '/cantina.html';
    }

    // Decodifica caracteres especiais da URL
    try {
      urlPath = decodeURIComponent(urlPath);
    } catch {
      res.writeHead(400);
      return res.end('Bad Request');
    }

    // Remove barras iniciais
    const relativePath = urlPath.replace(/^\/+/, '');

    // Caminho absoluto do arquivo
    const file = path.resolve(__dirname, relativePath);

    // Segurança: não permite sair da pasta do projeto
    const root = path.resolve(__dirname);

    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        console.log('Arquivo não encontrado:', file);

        if (err.code === 'ENOENT') {
          res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8'
          });

          return res.end('Not Found');
        }

        console.error(err);

        res.writeHead(500, {
          'Content-Type': 'text/plain; charset=utf-8'
        });

        return res.end('Internal Server Error');
      }

      const ext = path.extname(file).toLowerCase();

      const types = {
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',

        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',

        '.css': 'text/css; charset=utf-8',

        '.json': 'application/json; charset=utf-8',

        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',

        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',

        '.mp4': 'video/mp4',
        '.webm': 'video/webm'
      };

      const contentType =
        types[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
      });

      res.end(data);
    });

  } catch (error) {
    console.error('Erro no servidor HTTP:', error);

    res.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8'
    });

    res.end('Internal Server Error');
  }
});

/* =========================
   WEBSOCKET
========================= */

const wss = new WebSocketServer({
  server,
  path: '/ws'
});

wss.on('connection', ws => {
  ws.clientId = randomId();

  console.log('WebSocket conectado:', ws.clientId);

  ws.on('message', raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /* =========================
       ENTRAR NA SALA
    ========================= */

    if (msg.type === 'join') {
      const code = cleanCode(msg.room);
      const id = String(msg.id || '').slice(0, 32);
      const name = cleanName(msg.name);

      if (!code || code.length < 3 || !id) {
        return send(ws, {
          type: 'error',
          message: 'Sala ou usuário inválido.'
        });
      }

      // Se já estiver em outra sala
      if (ws.roomCode) {
        removeClient(ws);
      }

      const room = roomFor(code);

      // Se a mesma aba reconectar com o mesmo ID,
      // substitui a conexão antiga.
      const old = room.clients.get(id);

      if (old && old.ws !== ws) {
        try {
          old.ws.close();
        } catch {}

        room.clients.delete(id);
      }

      ws.roomCode = code;
      ws.clientId = id;

      room.clients.set(id, {
        ws,

        member: {
          id,
          name,
          joinedAt: Date.now(),
          inCall: false,
          joinedCallAt: 0,
          micOn: true,
          videoMode: null,
          lastSeen: Date.now()
        }
      });

      room.chat.push({
        id: randomId(),
        system: true,
        text: `${name} entrou na sala.`,
        ts: Date.now()
      });

      room.chat = room.chat.slice(-200);

      send(ws, {
        type: 'room-state',
        state: snapshot(room)
      });

      broadcastState(room);

      console.log(
        `${name} entrou na sala ${code}`
      );

      return;
    }

    /* =========================
       VERIFICA SALA
    ========================= */

    if (!ws.roomCode) {
      return;
    }

    const room = rooms.get(ws.roomCode);

    const me =
      room &&
      room.clients.get(ws.clientId);

    if (!room || !me) {
      return;
    }

    /* =========================
       HEARTBEAT
    ========================= */

    if (msg.type === 'heartbeat') {
      me.member.lastSeen = Date.now();
      return;
    }

    /* =========================
       ATUALIZAR MEMBRO
    ========================= */

    if (msg.type === 'member-update') {
      const changes = msg.changes || {};

      const allowedKeys = [
        'inCall',
        'joinedCallAt',
        'micOn',
        'videoMode'
      ];

      for (const key of allowedKeys) {
        if (
          Object.prototype.hasOwnProperty.call(
            changes,
            key
          )
        ) {
          me.member[key] = changes[key];
        }
      }

      me.member.lastSeen = Date.now();

      broadcastState(room);

      return;
    }

    /* =========================
       CHAT
    ========================= */

    if (msg.type === 'chat') {
      const text = String(msg.text || '')
        .trim()
        .slice(0, 500);

      if (!text) {
        return;
      }

      const message = {
        id: randomId(),
        from: me.member.id,
        name: me.member.name,
        text,
        ts: Date.now()
      };

      room.chat.push(message);

      room.chat = room.chat.slice(-200);

      // Envia para os outros usuários
      broadcast(room, {
        type: 'chat',
        message
      }, ws);

      // Envia também para quem escreveu
      send(ws, {
        type: 'chat',
        message
      });

      return;
    }

    /* =========================
       WEBRTC SIGNALING
    ========================= */

    if (msg.type === 'signal') {
      const to = String(msg.to || '');

      const target = room.clients.get(to);

      if (!target) {
        return;
      }

      const allowed = [
        'offer',
        'answer',
        'candidate',
        'leave'
      ];

      if (!allowed.includes(msg.kind)) {
        return;
      }

      const signal = {
        id: randomId(),
        from: me.member.id,
        to,
        kind: msg.kind,
        payload: msg.payload,
        ts: Date.now()
      };

      send(target.ws, {
        type: 'signal',
        signal
      });

      return;
    }

    /* =========================
       SAIR
    ========================= */

    if (msg.type === 'leave') {
      try {
        ws.close();
      } catch {}

      return;
    }
  });

  /* =========================
     WEBSOCKET FECHADO
  ========================= */

  ws.on('close', () => {
    console.log(
      'WebSocket desconectado:',
      ws.clientId
    );

    removeClient(ws);
  });

  /* =========================
     ERRO WEBSOCKET
  ========================= */

  ws.on('error', error => {
    console.error(
      'Erro WebSocket:',
      error.message
    );
  });
});

/* =========================
   LIMPEZA DE CONEXÕES
========================= */

const interval = setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms) {
    for (const [id, client] of room.clients) {
      const inactive =
        now - (client.member.lastSeen || now) >
        35000;

      const socketClosed =
        client.ws.readyState !== 1;

      if (inactive && socketClosed) {
        room.clients.delete(id);
      }
    }

    if (room.clients.size === 0) {
      rooms.delete(code);
    }
  }
}, 15000);

interval.unref();

/* =========================
   INICIAR SERVIDOR
========================= */

server.listen(PORT, HOST, () => {
  console.log(
    `Cantina online em http://${HOST}:${PORT}`
  );

  console.log(
    `Porta utilizada: ${PORT}`
  );

  console.log(
    `Diretório dos arquivos: ${__dirname}`
  );
});

/* =========================
   ERRO DO SERVIDOR
========================= */

server.on('error', error => {
  console.error(
    'Erro no servidor:',
    error
  );
});