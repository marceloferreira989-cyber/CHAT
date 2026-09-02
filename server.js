const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();

function cleanCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
function cleanName(value) {
  return String(value || '').trim().slice(0, 20) || 'Visitante';
}
function randomId() {
  return Math.random().toString(36).slice(2, 10);
}
function roomFor(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { clients: new Map(), chat: [] };
    rooms.set(code, room);
  }
  return room;
}
function snapshot(room) {
  return {
    members: [...room.clients.values()].map(c => c.member),
    chat: room.chat.slice(-200)
  };
}
function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data, except) {
  for (const client of room.clients.values()) {
    if (client.ws !== except) send(client.ws, data);
  }
}
function broadcastState(room) {
  const data = { type: 'room-state', state: snapshot(room) };
  for (const client of room.clients.values()) send(client.ws, data);
}
function removeClient(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const client = room.clients.get(ws.clientId);
  if (client) {
    room.clients.delete(ws.clientId);
    room.chat.push({ id: randomId(), system: true, text: `${client.member.name} saiu da sala.`, ts: Date.now() });
    room.chat = room.chat.slice(-200);
    broadcast(room, { type: 'signal', signal: { id: randomId(), from: client.member.id, to: '*', kind: 'leave', payload: {}, ts: Date.now() } });
    broadcastState(room);
  }
  ws.roomCode = null;
  if (room.clients.size === 0) rooms.delete(code);
}

const server = http.createServer((req, res) => {
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/cantina.html';
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path:'/ws' });
wss.on('connection', ws => {
  ws.clientId = randomId();
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'join') {
      const code = cleanCode(msg.room);
      const id = String(msg.id || '').slice(0, 32);
      const name = cleanName(msg.name);
      if (!code || code.length < 3 || !id) return send(ws, { type:'error', message:'Sala ou usuário inválido.' });
      if (ws.roomCode) removeClient(ws);
      const room = roomFor(code);
      // Se a aba reconectar com o mesmo ID, substitui a conexão antiga.
      const old = room.clients.get(id);
      if (old && old.ws !== ws) {
        try { old.ws.close(); } catch {}
        room.clients.delete(id);
      }
      ws.roomCode = code;
      ws.clientId = id;
      room.clients.set(id, {
        ws,
        member: { id, name, joinedAt: Date.now(), inCall:false, joinedCallAt:0, micOn:true, videoMode:null }
      });
      room.chat.push({ id:randomId(), system:true, text:`${name} entrou na sala.`, ts:Date.now() });
      room.chat = room.chat.slice(-200);
      send(ws, { type:'room-state', state:snapshot(room) });
      broadcastState(room);
      return;
    }
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    const me = room && room.clients.get(ws.clientId);
    if (!room || !me) return;

    if (msg.type === 'heartbeat') {
      me.member.lastSeen = Date.now();
      return;
    }
    if (msg.type === 'member-update') {
      const changes = msg.changes || {};
      for (const key of ['inCall','joinedCallAt','micOn','videoMode']) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) me.member[key] = changes[key];
      }
      broadcastState(room);
      return;
    }
    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 500);
      if (!text) return;
      const message = { id:randomId(), from:me.member.id, name:me.member.name, text, ts:Date.now() };
      room.chat.push(message);
      room.chat = room.chat.slice(-200);
      broadcast(room, { type:'chat', message });
      send(ws, { type:'chat', message });
      return;
    }
    if (msg.type === 'signal') {
      const to = String(msg.to || '');
      const target = room.clients.get(to);
      if (!target) return;
      const allowed = ['offer','answer','candidate','leave'];
      if (!allowed.includes(msg.kind)) return;
      const signal = { id:randomId(), from:me.member.id, to, kind:msg.kind, payload:msg.payload, ts:Date.now() };
      send(target.ws, { type:'signal', signal });
      return;
    }
    if (msg.type === 'leave') {
      try { ws.close(); } catch {}
    }
  });
  ws.on('close', () => removeClient(ws));
});

// Limpeza simples de salas/conexões que ficaram abandonadas.
const interval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const [id, client] of room.clients) {
      if (now - (client.member.lastSeen || now) > 35000 && client.ws.readyState !== 1) {
        room.clients.delete(id);
      }
    }
    if (room.clients.size === 0) rooms.delete(code);
  }
}, 15000);
interval.unref();

server.listen(PORT, HOST, () => console.log(`Cantina online em http://localhost:${PORT}`));
