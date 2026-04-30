const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TICK_RATE = 1000 / 60;
const MAX_PLAYERS_PER_ROOM = 4;
const TILE_SIZE = 40;
const MAP_COLS = 15;
const MAP_ROWS = 13;
const MAP_OFFSET_X = (800 - MAP_COLS * TILE_SIZE) / 2;
const MAP_OFFSET_Y = (640 - MAP_ROWS * TILE_SIZE) / 2;
const ENTITY_SIZE = TILE_SIZE * 0.72;
const BOMB_FUSE_MS = 2500;
const EXPLOSION_DURATION_MS = 200;
const BUBBLE_AUTO_DEATH_MS = 5000;
const BOMB_OWNER_PASS_MS = 2000;
const ITEM_DROP_CHANCE = 0.3;
const SPEED_BY_LEVEL = { 1: 3, 2: 3.5, 3: 4 };

const INITIAL_MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 2, 2, 2, 2, 0, 2, 2, 2, 2, 0, 0, 1],
  [1, 0, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 0, 1],
  [1, 2, 2, 2, 2, 0, 2, 2, 2, 0, 2, 2, 2, 2, 1],
  [1, 2, 1, 2, 1, 2, 1, 0, 1, 2, 1, 2, 1, 2, 1],
  [1, 2, 2, 0, 2, 2, 2, 0, 2, 2, 2, 0, 2, 2, 1],
  [1, 2, 1, 2, 1, 2, 1, 0, 1, 2, 1, 2, 1, 2, 1],
  [1, 2, 2, 0, 2, 2, 2, 0, 2, 2, 2, 0, 2, 2, 1],
  [1, 2, 1, 2, 1, 2, 1, 0, 1, 2, 1, 2, 1, 2, 1],
  [1, 2, 2, 2, 2, 0, 2, 2, 2, 0, 2, 2, 2, 2, 1],
  [1, 0, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 0, 1],
  [1, 0, 0, 2, 2, 2, 2, 0, 2, 2, 2, 2, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const rooms = new Map();
const socketToRoom = new Map();
let roomCounter = 1;

function cloneMap() {
  return INITIAL_MAP.map((row) => [...row]);
}

function findBottomRightEmptyTile(map) {
  for (let row = MAP_ROWS - 2; row >= 1; row -= 1) {
    for (let col = MAP_COLS - 2; col >= 1; col -= 1) {
      if (map[row][col] === 0 && !(col === 1 && row === 1)) {
        return { col, row };
      }
    }
  }
  return { col: 13, row: 11 };
}

function tileToWorld(col, row) {
  return {
    x: MAP_OFFSET_X + col * TILE_SIZE + (TILE_SIZE - ENTITY_SIZE) / 2,
    y: MAP_OFFSET_Y + row * TILE_SIZE + (TILE_SIZE - ENTITY_SIZE) / 2,
  };
}

function worldToTile(x, y) {
  return {
    col: Math.floor((x - MAP_OFFSET_X) / TILE_SIZE),
    row: Math.floor((y - MAP_OFFSET_Y) / TILE_SIZE),
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getEntityTile(entity) {
  const cx = entity.x + entity.width / 2;
  const cy = entity.y + entity.height / 2;
  const t = worldToTile(cx, cy);
  return {
    col: clamp(t.col, 0, MAP_COLS - 1),
    row: clamp(t.row, 0, MAP_ROWS - 1),
  };
}

function rectOverlapsTile(rect, col, row) {
  const tileRect = {
    x: MAP_OFFSET_X + col * TILE_SIZE,
    y: MAP_OFFSET_Y + row * TILE_SIZE,
    w: TILE_SIZE,
    h: TILE_SIZE,
  };
  return (
    rect.x < tileRect.x + tileRect.w &&
    rect.x + rect.w > tileRect.x &&
    rect.y < tileRect.y + tileRect.h &&
    rect.y + rect.h > tileRect.y
  );
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function spawnPlayer(room, socketId, nickname) {
  const openSpawns = [
    { col: 1, row: 1 },
    { col: 13, row: 1 },
    { col: 1, row: 11 },
    { col: 13, row: 11 },
  ];
  const used = new Set(Object.values(room.players).map((p) => `${p.spawn.col},${p.spawn.row}`));
  const spawn = openSpawns.find((s) => !used.has(`${s.col},${s.row}`)) || openSpawns[0];
  const world = tileToWorld(spawn.col, spawn.row);
  room.players[socketId] = {
    id: socketId,
    nickname: (nickname || "Player").slice(0, 16),
    team: "A",
    x: world.x,
    y: world.y,
    width: ENTITY_SIZE,
    height: ENTITY_SIZE,
    speedLevel: 1,
    maxBombs: 1,
    availableBombs: 1,
    bombRange: 1,
    alive: true,
    isBubbled: false,
    bubbleEndsAt: 0,
    spawn,
    inputDir: null,
  };
}

function createRoom() {
  const id = `room-${roomCounter++}`;
  const room = {
    id,
    map: cloneMap(),
    players: {},
    bombs: [],
    explosions: [],
    items: [],
    aiBots: [],
    gameOver: false,
    winner: null,
    lastTick: Date.now(),
    stateDirty: true,
  };
  const aiSpawnTile = findBottomRightEmptyTile(room.map);
  const aiSpawn = tileToWorld(aiSpawnTile.col, aiSpawnTile.row);
  room.aiBots.push({
    id: "ai-1",
    nickname: "AI",
    x: aiSpawn.x,
    y: aiSpawn.y,
    width: ENTITY_SIZE,
    height: ENTITY_SIZE,
    speedLevel: 1,
    maxBombs: 1,
    availableBombs: 1,
    bombRange: 1,
    alive: true,
    isBubbled: false,
    bubbleEndsAt: 0,
    inputDir: null,
  });
  rooms.set(id, room);
  return room;
}

function findOrCreateRoom() {
  for (const room of rooms.values()) {
    if (Object.keys(room.players).length < MAX_PLAYERS_PER_ROOM && !room.gameOver) {
      return room;
    }
  }
  return createRoom();
}

function getBombAt(room, col, row) {
  return room.bombs.find((b) => b.col === col && b.row === row);
}

function isSolid(room, col, row) {
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return true;
  return room.map[row][col] === 1 || room.map[row][col] === 2;
}

function moveEntity(room, entity, dt) {
  if (!entity.alive || entity.isBubbled || !entity.inputDir) return;
  const speed = SPEED_BY_LEVEL[entity.speedLevel] * TILE_SIZE;
  const step = speed * dt;
  let dx = 0;
  let dy = 0;
  if (entity.inputDir === "up") dy = -step;
  if (entity.inputDir === "down") dy = step;
  if (entity.inputDir === "left") dx = -step;
  if (entity.inputDir === "right") dx = step;

  const tryRectX = { x: entity.x + dx, y: entity.y, w: entity.width, h: entity.height };
  const tryRectY = { x: entity.x, y: entity.y + dy, w: entity.width, h: entity.height };

  const hitX = rectHitsWorld(room, entity, tryRectX);
  const hitY = rectHitsWorld(room, entity, tryRectY);
  let moved = false;
  if (!hitX) {
    entity.x += dx;
    moved = moved || dx !== 0;
  }
  if (!hitY) {
    entity.y += dy;
    moved = moved || dy !== 0;
  }
  if (moved) {
    room.stateDirty = true;
  }
}

function rectHitsWorld(room, entity, rect) {
  const now = Date.now();
  const minCol = Math.floor((rect.x - MAP_OFFSET_X) / TILE_SIZE);
  const maxCol = Math.floor((rect.x + rect.w - 1 - MAP_OFFSET_X) / TILE_SIZE);
  const minRow = Math.floor((rect.y - MAP_OFFSET_Y) / TILE_SIZE);
  const maxRow = Math.floor((rect.y + rect.h - 1 - MAP_OFFSET_Y) / TILE_SIZE);
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      if (isSolid(room, col, row)) {
        console.log("[move] 막힘 이유:", "wall_or_block", {
          entityId: entity.id,
          col,
          row,
        });
        return true;
      }
      const bomb = getBombAt(room, col, row);
      if (bomb && rectOverlapsTile(rect, col, row)) {
        // Owner can pass through only their own bomb for 3s.
        if (bomb.ownerId === entity.id && now < bomb.ownerPassUntil) {
          continue;
        }
        console.log("[move] 막힘 이유:", "bomb_collision", {
          entityId: entity.id,
          bombOwnerId: bomb.ownerId,
          bombCol: bomb.col,
          bombRow: bomb.row,
          now,
          ownerPassUntil: bomb.ownerPassUntil,
        });
        return true;
      }
    }
  }
  return false;
}

function maybeDropItem(room, col, row) {
  if (Math.random() >= ITEM_DROP_CHANCE) return;
  if (room.items.some((i) => i.col === col && i.row === row)) return;
  const roll = Math.random();
  const type = roll < 1 / 3 ? "bomb" : roll < 2 / 3 ? "range" : "speed";
  room.items.push({ col, row, type });
}

function applyItem(entity, item) {
  if (item.type === "bomb") {
    entity.maxBombs = Math.min(5, entity.maxBombs + 1);
    entity.availableBombs = Math.min(entity.maxBombs, entity.availableBombs + 1);
  } else if (item.type === "range") {
    entity.bombRange = Math.min(6, entity.bombRange + 1);
  } else if (item.type === "speed") {
    entity.speedLevel = Math.min(3, entity.speedLevel + 1);
  }
}

function placeBomb(room, owner) {
  if (!owner || !owner.alive || owner.isBubbled) return;
  if (owner.availableBombs <= 0) return;
  const tile = getEntityTile(owner);
  if (getBombAt(room, tile.col, tile.row)) return;
  room.bombs.push({
    col: tile.col,
    row: tile.row,
    ownerId: owner.id,
    ownerIsAi: owner.id.startsWith("ai-"),
    range: owner.bombRange,
    ownerPassUntil: Date.now() + BOMB_OWNER_PASS_MS,
    explodeAt: Date.now() + BOMB_FUSE_MS,
  });
  owner.availableBombs -= 1;
  room.stateDirty = true;
  console.log("[bomb] 설치 후 플레이어 상태", {
    ownerId: owner.id,
    x: owner.x,
    y: owner.y,
    inputDir: owner.inputDir,
    alive: owner.alive,
    isBubbled: owner.isBubbled,
    availableBombs: owner.availableBombs,
    maxBombs: owner.maxBombs,
  });
}

function explodeBomb(room, bomb) {
  room.bombs = room.bombs.filter((b) => b !== bomb);
  const owner = room.players[bomb.ownerId] || room.aiBots.find((a) => a.id === bomb.ownerId);
  if (owner) owner.availableBombs = Math.min(owner.maxBombs, owner.availableBombs + 1);

  const cells = [{ col: bomb.col, row: bomb.row }];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dc, dr] of dirs) {
    for (let s = 1; s <= bomb.range; s += 1) {
      const col = bomb.col + dc * s;
      const row = bomb.row + dr * s;
      if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) break;
      if (room.map[row][col] === 1) break;
      cells.push({ col, row });
      if (room.map[row][col] === 2) {
        room.map[row][col] = 0;
        maybeDropItem(room, col, row);
        break;
      }
    }
  }
  room.explosions.push({ cells, endsAt: Date.now() + EXPLOSION_DURATION_MS });
  io.to(room.id).emit("explosion", { cells });
  room.stateDirty = true;

  for (const c of cells) {
    const chained = getBombAt(room, c.col, c.row);
    if (chained) explodeBomb(room, chained);
  }
}

function bubbleEntity(entity) {
  if (!entity.alive || entity.isBubbled) return;
  entity.isBubbled = true;
  entity.bubbleEndsAt = Date.now() + BUBBLE_AUTO_DEATH_MS;
}

function checkRoundOutcome(room) {
  if (room.gameOver) return;
  const alivePlayers = Object.values(room.players).filter((p) => p.alive);
  if (alivePlayers.length === 1) {
    room.gameOver = true;
    room.winner = alivePlayers[0].id;
    io.to(room.winner).emit("winner", { winnerId: room.winner });
    io.to(room.id).emit("gameOver", { winnerId: room.winner });
  } else if (alivePlayers.length === 0 && Object.keys(room.players).length > 0) {
    room.gameOver = true;
    room.winner = null;
    io.to(room.id).emit("draw", { message: "모두 사망했습니다." });
    io.to(room.id).emit("gameOver", { winnerId: null });
  }
}

function killEntity(room, entity) {
  entity.alive = false;
  entity.isBubbled = false;
  entity.bubbleEndsAt = 0;
  io.to(room.id).emit("playerDead", { id: entity.id });
  room.stateDirty = true;
  if (!entity.id.startsWith("ai-")) {
    checkRoundOutcome(room);
  }
}

function handleHits(room) {
  const allEntities = [...Object.values(room.players), ...room.aiBots];
  for (const ex of room.explosions) {
    for (const entity of allEntities) {
      if (!entity.alive) continue;
      const rect = { x: entity.x, y: entity.y, w: entity.width, h: entity.height };
      if (ex.cells.some((c) => rectOverlapsTile(rect, c.col, c.row))) {
        if (!entity.isBubbled) {
          room.stateDirty = true;
        }
        bubbleEntity(entity);
      }
    }
  }
}

function handleBubbleTouches(room) {
  const entities = [...Object.values(room.players), ...room.aiBots].filter((e) => e.alive);
  for (let i = 0; i < entities.length; i += 1) {
    for (let j = i + 1; j < entities.length; j += 1) {
      const a = entities[i];
      const b = entities[j];
      const ra = { x: a.x, y: a.y, w: a.width, h: a.height };
      const rb = { x: b.x, y: b.y, w: b.width, h: b.height };
      if (!rectsOverlap(ra, rb)) continue;
      if (a.isBubbled && !b.isBubbled) killEntity(room, a);
      if (b.isBubbled && !a.isBubbled) killEntity(room, b);
    }
  }
}

function handleBubbleTimeouts(room) {
  const now = Date.now();
  for (const entity of [...Object.values(room.players), ...room.aiBots]) {
    if (entity.alive && entity.isBubbled && now >= entity.bubbleEndsAt) {
      killEntity(room, entity);
    }
  }
}

function handleItemPickup(room) {
  const entities = [...Object.values(room.players), ...room.aiBots].filter((e) => e.alive);
  for (const entity of entities) {
    const tile = getEntityTile(entity);
    const idx = room.items.findIndex((it) => it.col === tile.col && it.row === tile.row);
    if (idx !== -1) {
      const [item] = room.items.splice(idx, 1);
      applyItem(entity, item);
      room.stateDirty = true;
    }
  }
}

function updateAiDirection(room) {
  const dirs = ["up", "down", "left", "right"];
  for (const ai of room.aiBots) {
    if (!ai.alive || ai.isBubbled) {
      ai.inputDir = null;
      continue;
    }
    const shuffled = [...dirs].sort(() => Math.random() - 0.5);
    let chosen = null;
    for (const dir of shuffled) {
      const trial = { ...ai };
      trial.inputDir = dir;
      const step = SPEED_BY_LEVEL[trial.speedLevel] * TILE_SIZE * 0.1;
      if (dir === "up") trial.y -= step;
      if (dir === "down") trial.y += step;
      if (dir === "left") trial.x -= step;
      if (dir === "right") trial.x += step;
      if (
        !rectHitsWorld(
          room,
          ai,
          { x: trial.x, y: trial.y, w: trial.width, h: trial.height },
        )
      ) {
        chosen = dir;
        break;
      }
    }
    if (ai.inputDir !== chosen) {
      ai.inputDir = chosen;
      room.stateDirty = true;
    }
    if (Math.random() < 0.12) {
      placeBomb(room, ai);
    }
  }
}

function serializeRoom(room) {
  return {
    roomId: room.id,
    roomCount: Object.keys(room.players).length,
    map: room.map,
    players: Object.values(room.players).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      team: p.team,
      x: p.x,
      y: p.y,
      alive: p.alive,
      bombCount: p.maxBombs,
      bombRange: p.bombRange,
      speed: SPEED_BY_LEVEL[p.speedLevel],
    })),
    aiBots: room.aiBots.map((a) => ({
      id: a.id,
      nickname: a.nickname,
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
      alive: a.alive,
      isBubbled: a.isBubbled,
    })),
    bombs: room.bombs.map((b) => ({
      x: MAP_OFFSET_X + b.col * TILE_SIZE + TILE_SIZE / 2,
      y: MAP_OFFSET_Y + b.row * TILE_SIZE + TILE_SIZE / 2,
      ownerId: b.ownerId,
      timer: Math.max(0, b.explodeAt - Date.now()),
    })),
    explosions: room.explosions,
    items: room.items.map((it) => ({
      x: MAP_OFFSET_X + it.col * TILE_SIZE + TILE_SIZE / 2,
      y: MAP_OFFSET_Y + it.row * TILE_SIZE + TILE_SIZE / 2,
      type: it.type,
    })),
    gameOver: room.gameOver,
    winner: room.winner,
  };
}

function tickRoom(room) {
  const now = Date.now();
  const dt = Math.min(0.05, (now - room.lastTick) / 1000);
  room.lastTick = now;

  for (const p of Object.values(room.players)) moveEntity(room, p, dt);
  for (const a of room.aiBots) moveEntity(room, a, dt);

  for (const bomb of [...room.bombs]) {
    if (now >= bomb.explodeAt) explodeBomb(room, bomb);
  }

  const prevExplosionLen = room.explosions.length;
  room.explosions = room.explosions.filter((e) => e.endsAt > now);
  if (room.explosions.length !== prevExplosionLen) {
    room.stateDirty = true;
  }
  handleHits(room);
  handleBubbleTouches(room);
  handleBubbleTimeouts(room);
  handleItemPickup(room);

  checkRoundOutcome(room);
  if (!room.gameOver && room.aiBots.every((a) => !a.alive)) {
    io.to(room.id).emit("stageOver", { message: "AI defeated" });
  }

  if (room.stateDirty) {
    io.to(room.id).emit("gameState", serializeRoom(room));
    room.stateDirty = false;
  }
}

function resetRoomRound(room) {
  room.map = cloneMap();
  room.bombs = [];
  room.explosions = [];
  room.items = [];
  room.gameOver = false;
  room.winner = null;
  room.lastTick = Date.now();
  room.stateDirty = true;
  for (const player of Object.values(room.players)) {
    const world = tileToWorld(player.spawn.col, player.spawn.row);
    player.x = world.x;
    player.y = world.y;
    player.speedLevel = 1;
    player.maxBombs = 1;
    player.availableBombs = 1;
    player.bombRange = 1;
    player.alive = true;
    player.isBubbled = false;
    player.bubbleEndsAt = 0;
    player.inputDir = null;
  }
  for (const ai of room.aiBots) {
    const world = tileToWorld(7, 6);
    ai.x = world.x;
    ai.y = world.y;
    ai.speedLevel = 1;
    ai.maxBombs = 1;
    ai.availableBombs = 1;
    ai.bombRange = 1;
    ai.alive = true;
    ai.isBubbled = false;
    ai.bubbleEndsAt = 0;
    ai.inputDir = null;
  }
}

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room);
}, TICK_RATE);

setInterval(() => {
  for (const room of rooms.values()) {
    updateAiDirection(room);
  }
}, 500);

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  console.log("[socket] connected:", socket.id);

  const handleJoin = (data = {}) => {
    console.log("[server] join 받음", data);
    const { nickname } = data;
    console.log("[join] request:", socket.id, nickname);
    const room = findOrCreateRoom();
    socket.join(room.id);
    socketToRoom.set(socket.id, room.id);
    spawnPlayer(room, socket.id, nickname);
    const gameState = serializeRoom(room);
    console.log("[server] gameState 구성 확인", {
      roomId: gameState.roomId,
      hasMap: Array.isArray(gameState.map),
      players: gameState.players.length,
      bombs: gameState.bombs.length,
      items: gameState.items.length,
    });
    socket.emit("joined", { roomId: room.id, socketId: socket.id });
    socket.emit("gameState", gameState);
    console.log("[server] 초기 gameState 전송 완료 (to self)", socket.id);
    console.log("[join] assigned:", socket.id, "->", room.id);
    io.to(room.id).emit("gameState", gameState);
    console.log("[server] room gameState 브로드캐스트 완료", room.id);
  };

  socket.on("join", handleJoin);
  socket.on("joinGame", handleJoin);

  socket.on("move", ({ direction }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;
    console.log("[move] 받음", { direction }, "플레이어위치", player.x, player.y);
    player.inputDir = direction || null;
    room.stateDirty = true;
  });

  socket.on("placeBomb", () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    placeBomb(room, room.players[socket.id]);
  });

  socket.on("chat", ({ message }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    io.to(room.id).emit("chat", {
      nickname: player.nickname,
      message: String(message || "").slice(0, 120),
    });
  });

  socket.on("restartRequest", () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    resetRoomRound(room);
    io.to(room.id).emit("gameState", serializeRoom(room));
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected:", socket.id);
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    socketToRoom.delete(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      rooms.delete(room.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
