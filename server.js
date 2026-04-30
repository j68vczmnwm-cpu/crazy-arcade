const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TILE_SIZE = 48;
const MAP_COLS = 15;
const MAP_ROWS = 13;
const BOMB_FUSE_MS = 3000;
const OWNER_PASS_MS = 2000;
const BUBBLE_MS = 3000;
const BLOCK_FILL_RATIO = 0.7;
const WALL_MIN = 0.15;
const WALL_MAX = 0.2;
const SPEED_LEVELS = [144, 168, 192];
const AI_TICK_MS = 16;
const BROADCAST_MS = 50;
const BOMB_GAP_BLOCK_RADIUS = 22;
const AI_DIR_LOCK_MS = 280;
const AI_EVADE_LOCK_MS = 1400;
const EXPLOSION_HITBOX_SCALE = 0.9;

const SPAWNS = {
  P1: { tileX: 1, tileY: 1 },
  P2: { tileX: 13, tileY: 1 },
  P3: { tileX: 1, tileY: 11 },
  P4: { tileX: 13, tileY: 11 },
};

const MODE = {
  DUEL: "duel",
  AI_BATTLE: "ai_battle",
  COOP_DUO: "coop_duo",
};

const rooms = new Map();
const socketToRoom = new Map();
let roomSeq = 1;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function tileCenter(tileX, tileY) {
  return { x: tileX * TILE_SIZE + TILE_SIZE / 2, y: tileY * TILE_SIZE + TILE_SIZE / 2 };
}

function toTile(x, y) {
  return {
    tileX: clamp(Math.floor(x / TILE_SIZE), 0, MAP_COLS - 1),
    tileY: clamp(Math.floor(y / TILE_SIZE), 0, MAP_ROWS - 1),
  };
}

function isNearSpawn(x, y, r) {
  return Object.values(SPAWNS).some((s) => Math.abs(s.tileX - x) <= r && Math.abs(s.tileY - y) <= r);
}

function emptyConnected(map) {
  const walkable = [];
  for (let y = 1; y < MAP_ROWS - 1; y += 1) {
    for (let x = 1; x < MAP_COLS - 1; x += 1) {
      if (map[y][x] !== 1) walkable.push({ x, y });
    }
  }
  if (walkable.length <= 1) return true;
  const q = [walkable[0]];
  const seen = new Set([`${walkable[0].x},${walkable[0].y}`]);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i < q.length; i += 1) {
    const c = q[i];
    for (const [dx, dy] of dirs) {
      const nx = c.x + dx;
      const ny = c.y + dy;
      const k = `${nx},${ny}`;
      if (nx < 0 || nx >= MAP_COLS || ny < 0 || ny >= MAP_ROWS) continue;
      if (seen.has(k) || map[ny][nx] === 1) continue;
      seen.add(k);
      q.push({ x: nx, y: ny });
    }
  }
  return seen.size === walkable.length;
}

function makeMap() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const map = Array.from({ length: MAP_ROWS }, (_, y) =>
      Array.from({ length: MAP_COLS }, (_, x) => {
        if (x === 0 || y === 0 || x === MAP_COLS - 1 || y === MAP_ROWS - 1) return 1;
        return 0;
      }),
    );
    const cands = [];
    for (let y = 1; y < MAP_ROWS - 1; y += 1) {
      for (let x = 1; x < MAP_COLS - 1; x += 1) {
        if (isNearSpawn(x, y, 3)) continue;
        cands.push({ x, y });
      }
    }
    for (let i = cands.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    const wallRatio = WALL_MIN + Math.random() * (WALL_MAX - WALL_MIN);
    const wallCount = Math.floor(cands.length * wallRatio);
    for (let i = 0; i < wallCount; i += 1) map[cands[i].y][cands[i].x] = 1;

    for (let y = 1; y < MAP_ROWS - 1; y += 1) {
      for (let x = 1; x < MAP_COLS - 1; x += 1) {
        if (map[y][x] !== 0 || isNearSpawn(x, y, 2)) continue;
        if (Math.random() < BLOCK_FILL_RATIO) map[y][x] = 2;
      }
    }
    for (const s of Object.values(SPAWNS)) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const tx = s.tileX + dx;
          const ty = s.tileY + dy;
          if (tx <= 0 || tx >= MAP_COLS - 1 || ty <= 0 || ty >= MAP_ROWS - 1) continue;
          if (map[ty][tx] !== 1) map[ty][tx] = 0;
        }
      }
    }
    if (emptyConnected(map)) return map;
  }
  return Array.from({ length: MAP_ROWS }, (_, y) =>
    Array.from({ length: MAP_COLS }, (_, x) => (x === 0 || y === 0 || x === MAP_COLS - 1 || y === MAP_ROWS - 1 ? 1 : 0)),
  );
}

function createRoom(mode) {
  const id = `room-${roomSeq++}`;
  const room = {
    id,
    mode,
    map: makeMap(),
    players: {},
    bombs: [],
    items: [],
    explosions: [],
    started: false,
    gameOver: false,
    humans: [],
    aiIds: [],
    lastBroadcastAt: 0,
    readyByHumanId: {},
    countdownValue: 0,
    countdownTimer: null,
    matchScore: { A: 0, B: 0 },
    round: 1,
  };
  rooms.set(id, room);
  return room;
}

function clearCountdown(room) {
  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
  }
  room.countdownValue = 0;
}

function findOrCreateRoom(mode) {
  for (const room of rooms.values()) {
    if (room.mode === mode && !room.started && room.humans.length < 2) return room;
  }
  return createRoom(mode);
}

function listJoinableRooms() {
  const list = [];
  for (const room of rooms.values()) {
    if (!room.started && room.humans.length < 2) {
      list.push({
        roomId: room.id,
        mode: room.mode,
        connected: room.humans.length,
      });
    }
  }
  return list;
}

function getBombAt(room, tileX, tileY) {
  return room.bombs.find((b) => b.tileX === tileX && b.tileY === tileY);
}

function isBlockedTile(room, tileX, tileY) {
  if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return true;
  return room.map[tileY][tileX] === 1 || room.map[tileY][tileX] === 2;
}

function isAtCenter(e, threshold = 2) {
  const c = tileCenter(e.tileX, e.tileY);
  return Math.abs(e.x - c.x) <= threshold && Math.abs(e.y - c.y) <= threshold;
}

function canStand(room, e, x, y) {
  if (e.isBubbled) return false;
  const t = toTile(x, y);
  if (isBlockedTile(room, t.tileX, t.tileY)) return false;

  // Bomb tiles are passable, but prevent squeezing through tight gaps
  // by blocking positions that overlap with multiple enlarged bomb hit areas.
  let overlapBombs = 0;
  for (const bomb of room.bombs) {
    const bx = bomb.tileX * TILE_SIZE + TILE_SIZE / 2;
    const by = bomb.tileY * TILE_SIZE + TILE_SIZE / 2;
    const dx = x - bx;
    const dy = y - by;
    if (dx * dx + dy * dy <= BOMB_GAP_BLOCK_RADIUS * BOMB_GAP_BLOCK_RADIUS) {
      overlapBombs += 1;
      if (overlapBombs >= 2) return false;
    }
  }
  return true;
}

function moveEntity(room, e, dir, dt) {
  const dist = e.speed * dt;
  let nx = e.x;
  let ny = e.y;
  if (dir === "up") ny -= dist;
  if (dir === "down") ny += dist;
  if (dir === "left") nx -= dist;
  if (dir === "right") nx += dist;
  if (canStand(room, e, nx, e.y)) e.x = nx;
  if (canStand(room, e, e.x, ny)) e.y = ny;
  const t = toTile(e.x, e.y);
  e.tileX = t.tileX;
  e.tileY = t.tileY;
}

function maybeDropItem(room, tileX, tileY) {
  if (Math.random() >= 0.3) return;
  if (room.items.some((i) => i.tileX === tileX && i.tileY === tileY)) return;
  const r = Math.random();
  room.items.push({ tileX, tileY, type: r < 1 / 3 ? "bombUp" : r < 2 / 3 ? "rangeUp" : "speedUp" });
}

function applyItem(p, type) {
  if (type === "bombUp") {
    p.bombMax += 1;
    p.bombCount += 1;
  } else if (type === "rangeUp") {
    p.bombRange += 1;
  } else {
    const idx = SPEED_LEVELS.findIndex((s) => s === p.speed);
    p.speed = SPEED_LEVELS[Math.min(idx + 1, SPEED_LEVELS.length - 1)];
  }
}

function sameTeam(a, b) {
  return a.team !== null && b.team !== null && a.team === b.team;
}

function killEntity(room, e) {
  if (!e.alive) return false;
  e.alive = false;
  e.isBubbled = false;
  e.bubbleEndsAt = 0;
  io.to(room.id).emit("playerDead", { id: e.id });
  if (!e.isAi) io.to(e.id).emit("dead");
  return true;
}

function resolveBubbleTouches(room) {
  const living = Object.values(room.players).filter((p) => p.alive);
  let changed = false;
  for (const bubbled of living) {
    if (!bubbled.isBubbled) continue;
    for (const other of living) {
      if (other.id === bubbled.id || other.isBubbled) continue;
      if (other.tileX !== bubbled.tileX || other.tileY !== bubbled.tileY) continue;
      if (sameTeam(other, bubbled)) {
        bubbled.isBubbled = false;
        bubbled.bubbleEndsAt = 0;
        changed = true;
      } else {
        changed = killEntity(room, bubbled) || changed;
      }
      break;
    }
  }
  return changed;
}

function checkWinner(room) {
  if (!room.started || room.gameOver) return;
  const alive = Object.values(room.players).filter((p) => p.alive);
  const aliveA = alive.filter((p) => p.team === "A").length;
  const aliveB = alive.filter((p) => p.team === "B").length;
  if (aliveA > 0 && aliveB > 0) return;

  room.gameOver = true;
  const winnerTeam = aliveA > 0 ? "A" : aliveB > 0 ? "B" : null;
  if (winnerTeam) room.matchScore[winnerTeam] += 1;
  const matchOver = room.matchScore.A >= 3 || room.matchScore.B >= 3;

  io.to(room.id).emit("roundResult", {
    winnerTeam,
    round: room.round,
    matchScore: room.matchScore,
    matchOver,
  });

  if (matchOver) {
    io.to(room.id).emit("gameOver", {
      mode: room.mode,
      result: winnerTeam ? "victory" : "draw",
      winnerTeam,
      matchOver: true,
      matchScore: room.matchScore,
      bestOf: 5,
      winNeed: 3,
    });
    return;
  }

  room.round += 1;
  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    resetGame(room);
  }, 1800);
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function playerRect(p) {
  const size = clamp(Number(p.customization?.size) || 34, 24, 41);
  return { x: p.x - size / 2, y: p.y - size / 2, w: size, h: size };
}

function explosionTileRect(tileX, tileY) {
  const inset = (1 - EXPLOSION_HITBOX_SCALE) * TILE_SIZE * 0.5;
  return {
    x: tileX * TILE_SIZE + inset,
    y: tileY * TILE_SIZE + inset,
    w: TILE_SIZE - inset * 2,
    h: TILE_SIZE - inset * 2,
  };
}

function explodeBomb(room, bomb) {
  room.bombs = room.bombs.filter((b) => b.id !== bomb.id);
  const owner = room.players[bomb.ownerId];
  if (owner) owner.bombCount = Math.min(owner.bombMax, owner.bombCount + 1);
  const hit = [{ tileX: bomb.tileX, tileY: bomb.tileY }];
  const dirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
  for (const d of dirs) {
    for (let s = 1; s <= bomb.range; s += 1) {
      const tx = bomb.tileX + d.dx * s;
      const ty = bomb.tileY + d.dy * s;
      if (tx < 0 || tx >= MAP_COLS || ty < 0 || ty >= MAP_ROWS) break;
      if (room.map[ty][tx] === 1) break;
      hit.push({ tileX: tx, tileY: ty });
      const chained = getBombAt(room, tx, ty);
      if (chained) {
        explodeBomb(room, chained);
        break;
      }
      if (room.map[ty][tx] === 2) {
        room.map[ty][tx] = 0;
        maybeDropItem(room, tx, ty);
        break;
      }
    }
  }
  room.explosions = hit.map((t) => ({ x: t.tileX * TILE_SIZE, y: t.tileY * TILE_SIZE, tileX: t.tileX, tileY: t.tileY }));
  for (const p of Object.values(room.players)) {
    if (!p.alive) continue;
    const prect = playerRect(p);
    const gotHit = hit.some((t) => rectsOverlap(prect, explosionTileRect(t.tileX, t.tileY)));
    if (!gotHit) continue;
    if (p.isBubbled) killEntity(room, p);
    else {
      p.isBubbled = true;
      p.bubbleEndsAt = Date.now() + BUBBLE_MS;
    }
  }
  io.to(room.id).emit("explosion", { tiles: room.explosions });
  setTimeout(() => {
    room.explosions = [];
    if (!room.gameOver) broadcastState(room);
  }, 180);
}

function placeBomb(room, p) {
  if (!p || !p.alive || p.isBubbled || p.bombCount <= 0) return false;
  if (getBombAt(room, p.tileX, p.tileY)) return false;
  const bomb = {
    id: `${p.id}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    ownerId: p.id,
    tileX: p.tileX,
    tileY: p.tileY,
    range: p.bombRange,
    ownerPassUntil: Date.now() + OWNER_PASS_MS,
    explodeAt: Date.now() + BOMB_FUSE_MS,
  };
  room.bombs.push(bomb);
  p.bombCount -= 1;
  setTimeout(() => {
    const live = room.bombs.find((b) => b.id === bomb.id);
    if (!live || room.gameOver) return;
    explodeBomb(room, live);
    checkWinner(room);
    broadcastState(room);
  }, BOMB_FUSE_MS);
  return true;
}

function mkEntity({ id, nickname, isAi, team, spawn, partnerId = null, customization = null }) {
  const c = tileCenter(spawn.tileX, spawn.tileY);
  const aiDefault =
    isAi && team === "B"
      ? { shape: "circle", mainColor: "#eb5757", borderColor: "#7f1d1d", size: 34, icon: "none", speedScale: 1 }
      : { shape: "circle", mainColor: "#2f80ed", borderColor: "#ffffff", size: 34, icon: "none", speedScale: 1 };
  const appliedCustomization = customization || aiDefault;
  const speedScale = typeof appliedCustomization.speedScale === "number" ? appliedCustomization.speedScale : 1;
  return {
    id,
    nickname,
    isAi,
    team,
    tileX: spawn.tileX,
    tileY: spawn.tileY,
    x: c.x,
    y: c.y,
    alive: true,
    isBubbled: false,
    bubbleEndsAt: 0,
    bombMax: 1,
    bombCount: 1,
    bombRange: 1,
    speed: isAi ? SPEED_LEVELS[0] : Math.round(SPEED_LEVELS[0] * speedScale),
    currentDir: null,
    aiState: "IDLE",
    dirLockUntil: 0,
    evadeUntil: 0,
    partnerId,
    customization: appliedCustomization,
  };
}

function setupModeEntities(room) {
  room.players = {};
  room.aiIds = [];
  const h1 = room.humans[0];
  const h2 = room.humans[1];
  if (room.mode === MODE.DUEL) {
    room.players[h1.id] = mkEntity({ id: h1.id, nickname: h1.nickname, isAi: false, team: "A", spawn: SPAWNS.P1, customization: h1.customization });
    if (h2) {
      room.players[h2.id] = mkEntity({ id: h2.id, nickname: h2.nickname, isAi: false, team: "B", spawn: SPAWNS.P2, customization: h2.customization });
    } else {
      const ai = mkEntity({ id: `ai-${room.id}-solo`, nickname: "AI", isAi: true, team: "B", spawn: SPAWNS.P2 });
      room.players[ai.id] = ai;
      room.aiIds.push(ai.id);
    }
  } else if (room.mode === MODE.AI_BATTLE) {
    room.players[h1.id] = mkEntity({ id: h1.id, nickname: h1.nickname, isAi: false, team: "A", spawn: SPAWNS.P1, customization: h1.customization });
    if (h2) {
      room.players[h2.id] = mkEntity({ id: h2.id, nickname: h2.nickname, isAi: false, team: "A", spawn: SPAWNS.P3, customization: h2.customization });
    } else {
      const allyAi = mkEntity({ id: `ai-${room.id}-ally`, nickname: "AI-A", isAi: true, team: "A", spawn: SPAWNS.P3 });
      room.players[allyAi.id] = allyAi;
      room.aiIds.push(allyAi.id);
    }
    const ai1 = mkEntity({ id: `ai-${room.id}-1`, nickname: "AI-B1", isAi: true, team: "B", spawn: SPAWNS.P2 });
    const ai2 = mkEntity({ id: `ai-${room.id}-2`, nickname: "AI-B2", isAi: true, team: "B", spawn: SPAWNS.P4 });
    room.players[ai1.id] = ai1;
    room.players[ai2.id] = ai2;
    room.aiIds.push(ai1.id, ai2.id);
  } else {
    room.players[h1.id] = mkEntity({ id: h1.id, nickname: h1.nickname, isAi: false, team: "A", spawn: SPAWNS.P1, customization: h1.customization });
    if (h2) {
      room.players[h2.id] = mkEntity({ id: h2.id, nickname: h2.nickname, isAi: false, team: "B", spawn: SPAWNS.P2, customization: h2.customization });
    } else {
      const enemyPlayerAi = mkEntity({ id: `ai-${room.id}-enemy-player`, nickname: "AI-B-Player", isAi: true, team: "B", spawn: SPAWNS.P2 });
      room.players[enemyPlayerAi.id] = enemyPlayerAi;
      room.aiIds.push(enemyPlayerAi.id);
    }
    const aiA = mkEntity({ id: `ai-${room.id}-A`, nickname: "AI-A", isAi: true, team: "A", spawn: SPAWNS.P3, partnerId: h1.id });
    const aiB = mkEntity({ id: `ai-${room.id}-B`, nickname: "AI-B", isAi: true, team: "B", spawn: SPAWNS.P4, partnerId: h2 ? h2.id : null });
    room.players[aiA.id] = aiA;
    room.players[aiB.id] = aiB;
    room.aiIds.push(aiA.id, aiB.id);
  }
}

function startGame(room) {
  clearCountdown(room);
  room.matchScore = { A: 0, B: 0 };
  room.round = 1;
  room.map = makeMap();
  room.bombs = [];
  room.items = [];
  room.explosions = [];
  room.gameOver = false;
  room.started = true;
  setupModeEntities(room);
  io.to(room.id).emit("gameStarted", { mode: room.mode });
  broadcastState(room);
}

function resetGame(room) {
  clearCountdown(room);
  room.map = makeMap();
  room.bombs = [];
  room.items = [];
  room.explosions = [];
  room.gameOver = false;
  room.started = true;
  setupModeEntities(room);
  io.to(room.id).emit("gameStarted", { mode: room.mode, round: room.round, matchScore: room.matchScore });
  broadcastState(room);
}

function broadcastLobby(room) {
  const ready = room.humans.map((h) => ({
    id: h.id,
    nickname: h.nickname,
    ready: Boolean(room.readyByHumanId[h.id]),
  }));
  io.to(room.id).emit("lobbyState", {
    mode: room.mode,
    connected: room.humans.length,
    required: 2,
    canStart: room.humans.length === 1 && !room.started,
    countdown: room.countdownValue,
    ready,
    message:
      room.countdownValue > 0
        ? `게임 시작 ${room.countdownValue}...`
        : `상대방 기다리는 중... (${room.humans.length}/2명)`,
  });
}

function beginReadyCountdown(room) {
  if (room.started || room.countdownTimer) return;
  room.countdownValue = 3;
  broadcastLobby(room);
  room.countdownTimer = setInterval(() => {
    room.countdownValue -= 1;
    if (room.countdownValue <= 0) {
      clearCountdown(room);
      startGame(room);
      return;
    }
    broadcastLobby(room);
  }, 1000);
}

function maybeStartCountdown(room) {
  if (room.started || room.humans.length !== 2) {
    clearCountdown(room);
    return;
  }
  const allReady = room.humans.every((h) => Boolean(room.readyByHumanId[h.id]));
  if (allReady) beginReadyCountdown(room);
  else clearCountdown(room);
}

function serializeState(room) {
  const players = Object.values(room.players).map((p) => ({
    id: p.id,
    nickname: p.nickname,
    x: p.x,
    y: p.y,
    tileX: p.tileX,
    tileY: p.tileY,
    alive: p.alive,
    isAi: p.isAi,
    isBubbled: p.isBubbled,
    bombCount: p.bombCount,
    bombMax: p.bombMax,
    bombRange: p.bombRange,
    speed: p.speed,
    team: p.team,
    customization: p.customization,
  }));
  const aliveA = players.filter((p) => p.alive && p.team === "A").length;
  const aliveB = players.filter((p) => p.alive && p.team === "B").length;
  return {
    mode: room.mode,
    map: room.map,
    players,
    bombs: room.bombs.map((b) => ({ x: b.tileX * TILE_SIZE + TILE_SIZE / 2, y: b.tileY * TILE_SIZE + TILE_SIZE / 2, ownerId: b.ownerId })),
    items: room.items.map((i) => ({ x: i.tileX * TILE_SIZE + TILE_SIZE / 2, y: i.tileY * TILE_SIZE + TILE_SIZE / 2, type: i.type })),
    explosions: room.explosions,
    started: room.started,
    score: { A: aliveA, B: aliveB },
    matchScore: room.matchScore,
    round: room.round,
    bestOf: 5,
    winNeed: 3,
  };
}

function broadcastState(room) {
  io.to(room.id).emit("gameState", serializeState(room));
}

function bfsNext(room, start, isGoal) {
  const q = [{ x: start.tileX, y: start.tileY, first: null }];
  const seen = new Set([`${start.tileX},${start.tileY}`]);
  const dirs = [
    { d: "up", dx: 0, dy: -1 },
    { d: "down", dx: 0, dy: 1 },
    { d: "left", dx: -1, dy: 0 },
    { d: "right", dx: 1, dy: 0 },
  ];
  for (let i = 0; i < q.length; i += 1) {
    const c = q[i];
    if (isGoal(c.x, c.y)) return c.first;
    for (const dir of dirs) {
      const nx = c.x + dir.dx;
      const ny = c.y + dir.dy;
      const key = `${nx},${ny}`;
      if (seen.has(key) || nx < 0 || nx >= MAP_COLS || ny < 0 || ny >= MAP_ROWS) continue;
      if (isBlockedTile(room, nx, ny)) continue;
      if (getBombAt(room, nx, ny)) continue;
      seen.add(key);
      q.push({ x: nx, y: ny, first: c.first || dir.d });
    }
  }
  return null;
}

function forecastDanger(room) {
  const danger = new Set();
  for (const bomb of room.bombs) {
    danger.add(`${bomb.tileX},${bomb.tileY}`);
    for (const d of [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }]) {
      for (let s = 1; s <= bomb.range; s += 1) {
        const tx = bomb.tileX + d.dx * s;
        const ty = bomb.tileY + d.dy * s;
        if (tx < 0 || tx >= MAP_COLS || ty < 0 || ty >= MAP_ROWS) break;
        if (room.map[ty][tx] === 1) break;
        danger.add(`${tx},${ty}`);
        if (room.map[ty][tx] === 2) break;
      }
    }
  }
  return danger;
}

function nearestTarget(room, me, pred) {
  const arr = Object.values(room.players).filter((p) => p.alive && p.id !== me.id && pred(p));
  let best = null;
  let bestD = Infinity;
  for (const p of arr) {
    const d = Math.abs(p.tileX - me.tileX) + Math.abs(p.tileY - me.tileY);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function nearestBlock(room, me, maxDist = 6) {
  let best = null;
  let bestDist = Infinity;
  for (let y = 1; y < MAP_ROWS - 1; y += 1) {
    for (let x = 1; x < MAP_COLS - 1; x += 1) {
      if (room.map[y][x] !== 2) continue;
      const d = Math.abs(x - me.tileX) + Math.abs(y - me.tileY);
      if (d <= maxDist && d < bestDist) {
        bestDist = d;
        best = { tileX: x, tileY: y };
      }
    }
  }
  return best;
}

function hasAdjacentBlock(room, me) {
  const around = [
    { x: me.tileX + 1, y: me.tileY },
    { x: me.tileX - 1, y: me.tileY },
    { x: me.tileX, y: me.tileY + 1 },
    { x: me.tileX, y: me.tileY - 1 },
  ];
  return around.some((t) => room.map[t.y]?.[t.x] === 2);
}

function hasSafeEscapeDir(room, ai, danger) {
  // Must be able to move to another safe tile (not current tile).
  const dir = bfsNext(
    room,
    ai,
    (x, y) => (x !== ai.tileX || y !== ai.tileY) && !danger.has(`${x},${y}`),
  );
  return Boolean(dir);
}

function updateAi(room) {
  if (!room.started || room.gameOver) return false;
  const danger = forecastDanger(room);
  const now = Date.now();
  let changed = false;
  for (const id of room.aiIds) {
    const ai = room.players[id];
    if (!ai || !ai.alive || ai.isBubbled) continue;
    if (!isAtCenter(ai)) {
      if (ai.currentDir) {
        const px = ai.x;
        const py = ai.y;
        moveEntity(room, ai, ai.currentDir, AI_TICK_MS / 1000);
        if (ai.x !== px || ai.y !== py) changed = true;
      }
      continue;
    }
    ai.x = tileCenter(ai.tileX, ai.tileY).x;
    ai.y = tileCenter(ai.tileX, ai.tileY).y;
    let dir = ai.currentDir;
    const hereDanger = danger.has(`${ai.tileX},${ai.tileY}`);
    if (hereDanger) {
      ai.evadeUntil = Math.max(ai.evadeUntil || 0, now + AI_EVADE_LOCK_MS);
    }

    if (hereDanger || now < (ai.evadeUntil || 0)) {
      ai.aiState = "EVADING";
      dir = bfsNext(room, ai, (x, y) => !danger.has(`${x},${y}`));
      ai.dirLockUntil = 0;
    } else {
      if (now < (ai.dirLockUntil || 0) && dir) {
        // Hold previous direction briefly to reduce jitter.
      } else {
        dir = null;
      }
      const mate = ai.partnerId ? room.players[ai.partnerId] : null;
      const allyBubbled = nearestTarget(room, ai, (p) => sameTeam(p, ai) && p.isBubbled);
      if (allyBubbled) {
        ai.aiState = "CHASING";
        dir = bfsNext(room, ai, (x, y) => x === allyBubbled.tileX && y === allyBubbled.tileY);
      }
      if (!dir) {
        const block = nearestBlock(room, ai, 6);
        if (block) {
          ai.aiState = "FARMING";
          if (hasAdjacentBlock(room, ai) && ai.bombCount > 0 && hasSafeEscapeDir(room, ai, danger)) {
            placeBomb(room, ai);
            ai.evadeUntil = now + AI_EVADE_LOCK_MS;
            ai.dirLockUntil = 0;
            dir = bfsNext(room, ai, (x, y) => !danger.has(`${x},${y}`));
          } else {
            dir = bfsNext(room, ai, (x, y) => Math.abs(x - block.tileX) + Math.abs(y - block.tileY) <= 1);
            // If route to farming block is blocked, roam for another block chance.
            if (!dir) {
              const options = ["up", "down", "left", "right"].filter((d) => {
                const n =
                  d === "up"
                    ? { x: ai.tileX, y: ai.tileY - 1 }
                    : d === "down"
                      ? { x: ai.tileX, y: ai.tileY + 1 }
                      : d === "left"
                        ? { x: ai.tileX - 1, y: ai.tileY }
                        : { x: ai.tileX + 1, y: ai.tileY };
                return !isBlockedTile(room, n.x, n.y);
              });
              dir = options[Math.floor(Math.random() * options.length)] || null;
            }
          }
        }
      }
      if (!dir && mate && ai.team === "A") {
        ai.aiState = "CHASING";
        dir = bfsNext(room, ai, (x, y) => Math.abs(x - mate.tileX) + Math.abs(y - mate.tileY) <= 2);
      }
      if (!dir) {
        const itemDir = room.items.length ? bfsNext(room, ai, (x, y) => room.items.some((i) => i.tileX === x && i.tileY === y)) : null;
        if (itemDir) {
          ai.aiState = "FARMING";
          dir = itemDir;
        }
      }
      if (!dir) {
        const enemy = nearestTarget(room, ai, (p) => !sameTeam(p, ai));
        if (enemy) {
          ai.aiState = "ATTACKING";
          const dist = Math.abs(enemy.tileX - ai.tileX) + Math.abs(enemy.tileY - ai.tileY);
          if (dist <= 4 && ai.bombCount > 0 && hasSafeEscapeDir(room, ai, danger)) {
            placeBomb(room, ai);
            ai.evadeUntil = now + AI_EVADE_LOCK_MS;
            ai.dirLockUntil = 0;
          }
          dir = bfsNext(room, ai, (x, y) => Math.abs(x - enemy.tileX) + Math.abs(y - enemy.tileY) <= 1);
        }
      }
      if (!dir) {
        ai.aiState = "IDLE";
        const options = ["up", "down", "left", "right"].filter((d) => {
          const n = d === "up" ? { x: ai.tileX, y: ai.tileY - 1 } : d === "down" ? { x: ai.tileX, y: ai.tileY + 1 } : d === "left" ? { x: ai.tileX - 1, y: ai.tileY } : { x: ai.tileX + 1, y: ai.tileY };
          return !isBlockedTile(room, n.x, n.y);
        });
        dir = options[Math.floor(Math.random() * options.length)] || null;
      }
    }
    if (dir !== ai.currentDir) {
      ai.currentDir = dir;
      ai.dirLockUntil = now + AI_DIR_LOCK_MS;
    }
    if (dir) {
      const px = ai.x;
      const py = ai.y;
      moveEntity(room, ai, dir, AI_TICK_MS / 1000);
      if (ai.x !== px || ai.y !== py) changed = true;
    }
    const itemIdx = room.items.findIndex((i) => i.tileX === ai.tileX && i.tileY === ai.tileY);
    if (itemIdx !== -1) {
      const [item] = room.items.splice(itemIdx, 1);
      applyItem(ai, item.type);
      changed = true;
    }
  }
  return changed;
}

function removeFromRoom(socketId) {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  socketToRoom.delete(socketId);
  if (!room) return;
  room.humans = room.humans.filter((h) => h.id !== socketId);
  delete room.readyByHumanId[socketId];
  if (room.players[socketId]) delete room.players[socketId];
  if (room.humans.length === 0) {
    rooms.delete(room.id);
    return;
  }
  room.started = false;
  room.gameOver = false;
  room.players = {};
  room.aiIds = [];
  clearCountdown(room);
  broadcastLobby(room);
}

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  socket.on("requestRoomList", () => {
    socket.emit("roomList", { rooms: listJoinableRooms() });
  });

  socket.on("createGameRoom", ({ nickname, mode, customization }) => {
    if (!Object.values(MODE).includes(mode)) return;
    const room = createRoom(mode);
    socket.join(room.id);
    socketToRoom.set(socket.id, room.id);
    room.humans.push({
      id: socket.id,
      nickname: (nickname || "Player").slice(0, 16),
      customization: customization || null,
    });
    room.readyByHumanId[socket.id] = false;
    socket.emit("joinedLobby", { roomId: room.id, mode });
    broadcastLobby(room);
  });

  socket.on("joinGameRoom", ({ roomId, nickname, customization }) => {
    const room = rooms.get(roomId);
    if (!room || room.started || room.humans.length >= 2) {
      socket.emit("roomList", { rooms: listJoinableRooms() });
      return;
    }
    socket.join(room.id);
    socketToRoom.set(socket.id, room.id);
    room.humans.push({
      id: socket.id,
      nickname: (nickname || "Player").slice(0, 16),
      customization: customization || null,
    });
    room.readyByHumanId[socket.id] = false;
    socket.emit("joinedLobby", { roomId: room.id, mode: room.mode });
    broadcastLobby(room);
  });

  socket.on("joinMode", ({ nickname, mode, customization }) => {
    if (!Object.values(MODE).includes(mode)) return;
    const room = findOrCreateRoom(mode);
    socket.join(room.id);
    socketToRoom.set(socket.id, room.id);
    room.humans.push({
      id: socket.id,
      nickname: (nickname || "Player").slice(0, 16),
      customization: customization || null,
    });
    room.readyByHumanId[socket.id] = false;
    socket.emit("joinedLobby", { roomId: room.id, mode });
    if (room.humans.length < 2) {
      broadcastLobby(room);
      return;
    }
    broadcastLobby(room);
  });

  socket.on("changeRoomMode", ({ mode }) => {
    if (!Object.values(MODE).includes(mode)) return;
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.started) return;
    const hostId = room.humans[0]?.id;
    if (hostId !== socket.id) return;
    room.mode = mode;
    room.readyByHumanId = {};
    room.humans.forEach((h) => {
      room.readyByHumanId[h.id] = false;
    });
    clearCountdown(room);
    broadcastLobby(room);
  });

  socket.on("setReady", ({ ready }) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.started) return;
    if (!room.humans.some((h) => h.id === socket.id)) return;
    room.readyByHumanId[socket.id] = Boolean(ready);
    maybeStartCountdown(room);
    broadcastLobby(room);
  });

  socket.on("startSoloGame", () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.started || room.humans.length !== 1) return;
    if (room.humans[0].id !== socket.id) return;
    startGame(room);
  });

  socket.on("move", ({ dir, dt }) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || !room.started || room.gameOver) return;
    const p = room.players[socket.id];
    if (!p || !p.alive || p.isBubbled) return;
    moveEntity(room, p, dir, clamp(Number(dt) || 0, 0, 0.05));
    const itemIdx = room.items.findIndex((i) => i.tileX === p.tileX && i.tileY === p.tileY);
    if (itemIdx !== -1) {
      const [item] = room.items.splice(itemIdx, 1);
      applyItem(p, item.type);
    }
    resolveBubbleTouches(room);
    checkWinner(room);
    broadcastState(room);
  });

  socket.on("placeBomb", () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || !room.started || room.gameOver) return;
    const p = room.players[socket.id];
    if (!p) return;
    if (placeBomb(room, p)) broadcastState(room);
  });

  socket.on("restart", () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || !room.started) return;
    if ((room.matchScore?.A || 0) >= 3 || (room.matchScore?.B || 0) >= 3) {
      startGame(room);
    } else {
      resetGame(room);
    }
  });

  socket.on("backToLobby", () => {
    removeFromRoom(socket.id);
  });

  socket.on("chat", ({ message }) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room) return;
    const sender = room.humans.find((h) => h.id === socket.id);
    if (!sender) return;
    io.to(room.id).emit("chat", { nickname: sender.nickname, message: String(message || "").slice(0, 120) });
  });

  socket.on("disconnect", () => removeFromRoom(socket.id));
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started || room.gameOver) continue;
    let changed = false;
    changed = updateAi(room) || changed;
    changed = resolveBubbleTouches(room) || changed;
    for (const p of Object.values(room.players)) {
      if (p.alive && p.isBubbled && now >= p.bubbleEndsAt) changed = killEntity(room, p) || changed;
    }
    if (changed) {
      checkWinner(room);
      if (now - room.lastBroadcastAt >= BROADCAST_MS) {
        room.lastBroadcastAt = now;
        broadcastState(room);
      }
    }
  }
}, AI_TICK_MS);

server.listen(PORT);
