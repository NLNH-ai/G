'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PARTICIPANTS = 3;
const MAX_WS_MESSAGE_BYTES = 2 * 1024 * 1024;

const rooms = new Map();

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(client, payload) {
  if (!client || !client.socket || client.socket.destroyed) {
    return;
  }

  const text = JSON.stringify(payload);
  const frame = encodeFrame(Buffer.from(text), 0x1);
  client.socket.write(frame);
}

function encodeFrame(payload, opcode) {
  const isBuffer = Buffer.isBuffer(payload);
  const data = isBuffer ? payload : Buffer.from(String(payload));
  const length = data.length;

  if (length < 126) {
    const header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
    return Buffer.concat([header, data]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, data]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, data]);
}

function resetFragmentState(client) {
  client.fragmentOpcode = null;
  client.fragmentParts = [];
  client.fragmentBytes = 0;
}

function routeFrame(client, fin, opcode, payload) {
  // Control frames must not be fragmented.
  if (opcode >= 0x8) {
    if (!fin) {
      closeClient(client);
      return;
    }
    handleFrame(client, opcode, payload);
    return;
  }

  // Continuation frame.
  if (opcode === 0x0) {
    if (!client.fragmentOpcode) {
      closeClient(client);
      return;
    }

    client.fragmentParts.push(payload);
    client.fragmentBytes += payload.length;
    if (client.fragmentBytes > MAX_WS_MESSAGE_BYTES) {
      closeClient(client);
      return;
    }

    if (!fin) {
      return;
    }

    const fullPayload = Buffer.concat(client.fragmentParts, client.fragmentBytes);
    const assembledOpcode = client.fragmentOpcode;
    resetFragmentState(client);
    handleFrame(client, assembledOpcode, fullPayload);
    return;
  }

  // New data frame while previous fragmented message is unfinished.
  if (client.fragmentOpcode) {
    closeClient(client);
    return;
  }

  if (payload.length > MAX_WS_MESSAGE_BYTES) {
    closeClient(client);
    return;
  }

  if (!fin) {
    client.fragmentOpcode = opcode;
    client.fragmentParts = [payload];
    client.fragmentBytes = payload.length;
    return;
  }

  handleFrame(client, opcode, payload);
}

function decodeFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const isMasked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (client.buffer.length < offset + 2) {
        return;
      }
      payloadLength = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (client.buffer.length < offset + 8) {
        return;
      }
      const lengthBig = client.buffer.readBigUInt64BE(offset);
      if (lengthBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        closeClient(client);
        return;
      }
      payloadLength = Number(lengthBig);
      offset += 8;
    }

    if (payloadLength > MAX_WS_MESSAGE_BYTES) {
      closeClient(client);
      return;
    }

    const maskOffset = isMasked ? 4 : 0;
    const fullLength = offset + maskOffset + payloadLength;

    if (client.buffer.length < fullLength) {
      return;
    }

    let payload = client.buffer.subarray(offset + maskOffset, fullLength);

    if (isMasked) {
      const mask = client.buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    client.buffer = client.buffer.subarray(fullLength);
    routeFrame(client, fin, opcode, payload);
  }
}

function sanitizeRoom(raw) {
  if (typeof raw !== 'string') {
    return 'office-3';
  }

  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cleaned) {
    return 'office-3';
  }

  return cleaned.slice(0, 32);
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') {
    return '참석자';
  }

  const cleaned = raw.trim();
  if (!cleaned) {
    return '참석자';
  }

  return cleaned.slice(0, 24);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function roomParticipants(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return [];
  }
  return Array.from(room.values()).map((client) => ({ id: client.id, name: client.name }));
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const participants = roomParticipants(roomId);
  const payload = {
    type: 'room-state',
    participants,
    count: participants.length,
    maxParticipants: MAX_PARTICIPANTS,
  };

  for (const member of room.values()) {
    sendJson(member, payload);
  }
}

function broadcast(roomId, payload, exceptId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  for (const member of room.values()) {
    if (exceptId && member.id === exceptId) {
      continue;
    }
    sendJson(member, payload);
  }
}

function onJoin(client, message) {
  if (client.id) {
    sendJson(client, { type: 'error', reason: 'already-joined' });
    return;
  }

  const roomId = sanitizeRoom(message.roomId);
  const name = sanitizeName(message.name);
  const room = getRoom(roomId);

  if (room.size >= MAX_PARTICIPANTS) {
    sendJson(client, { type: 'room-full', maxParticipants: MAX_PARTICIPANTS });
    return;
  }

  const id = crypto.randomUUID().slice(0, 12);
  const peers = Array.from(room.values()).map((member) => ({
    id: member.id,
    name: member.name,
  }));

  client.id = id;
  client.name = name;
  client.roomId = roomId;

  room.set(id, client);

  sendJson(client, {
    type: 'joined',
    selfId: id,
    roomId,
    peers,
    maxParticipants: MAX_PARTICIPANTS,
  });

  broadcast(
    roomId,
    {
      type: 'peer-joined',
      peer: { id, name },
    },
    id,
  );

  broadcastRoomState(roomId);
}

function onSignal(client, message) {
  if (!client.id || !client.roomId) {
    sendJson(client, { type: 'error', reason: 'not-joined' });
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    return;
  }

  const targetId = typeof message.to === 'string' ? message.to : '';
  if (!targetId) {
    return;
  }

  const target = room.get(targetId);
  if (!target) {
    return;
  }

  sendJson(target, {
    type: 'signal',
    from: client.id,
    signal: message.signal || null,
  });
}

function removeClientFromRoom(client) {
  if (!client.roomId || !client.id) {
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    client.id = null;
    client.roomId = null;
    return;
  }

  room.delete(client.id);

  broadcast(client.roomId, { type: 'peer-left', peerId: client.id }, null);

  if (room.size === 0) {
    rooms.delete(client.roomId);
  } else {
    broadcastRoomState(client.roomId);
  }

  client.id = null;
  client.roomId = null;
}

function closeClient(client) {
  if (!client || client.closed) {
    return;
  }
  client.closed = true;
  resetFragmentState(client);
  removeClientFromRoom(client);

  if (client.socket && !client.socket.destroyed) {
    try {
      client.socket.end(encodeFrame(Buffer.alloc(0), 0x8));
    } catch (_error) {
      client.socket.destroy();
    }
  }
}

function handleFrame(client, opcode, payload) {
  if (opcode === 0x8) {
    closeClient(client);
    return;
  }

  if (opcode === 0x9) {
    if (!client.socket.destroyed) {
      client.socket.write(encodeFrame(payload, 0xA));
    }
    return;
  }

  if (opcode !== 0x1) {
    return;
  }

  let message;
  try {
    message = JSON.parse(payload.toString('utf8'));
  } catch (_error) {
    sendJson(client, { type: 'error', reason: 'bad-json' });
    return;
  }

  if (!message || typeof message.type !== 'string') {
    sendJson(client, { type: 'error', reason: 'bad-message' });
    return;
  }

  if (message.type === 'join') {
    onJoin(client, message);
    return;
  }

  if (message.type === 'signal') {
    onSignal(client, message);
    return;
  }

  if (message.type === 'leave') {
    closeClient(client);
    return;
  }
}

function serveStatic(req, res) {
  let requestPath = '/';
  try {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    requestPath = decodeURIComponent(parsed.pathname || '/');
  } catch (_error) {
    requestPath = '/';
  }

  if (requestPath === '/') {
    requestPath = '/index.html';
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': type,
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/signal') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );

  const client = {
    buffer: Buffer.alloc(0),
    closed: false,
    fragmentBytes: 0,
    fragmentOpcode: null,
    fragmentParts: [],
    id: null,
    name: null,
    roomId: null,
    socket,
  };

  socket.on('data', (chunk) => {
    if (!client.closed) {
      decodeFrames(client, chunk);
    }
  });

  socket.on('close', () => {
    if (!client.closed) {
      removeClientFromRoom(client);
      client.closed = true;
    }
  });

  socket.on('error', () => {
    if (!client.closed) {
      removeClientFromRoom(client);
      client.closed = true;
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SeatCast server running on http://${HOST}:${PORT}`);
});
