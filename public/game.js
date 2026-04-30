console.log("[boot] game.js loaded");
console.log("[boot] socket.io client exists:", typeof io !== "undefined");
const socket = io();
console.log("[socket] io() called");

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const nicknameInput = document.getElementById("nicknameInput");
const joinBtn = document.getElementById("joinBtn");
const roomInfo = document.getElementById("roomInfo");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");

const TILE_SIZE = 40;
const MAP_COLS = 15;
const MAP_ROWS = 13;
const MAP_OFFSET_X = (canvas.width - MAP_COLS * TILE_SIZE) / 2;
const MAP_OFFSET_Y = (canvas.height - MAP_ROWS * TILE_SIZE) / 2;

let myId = null;
let joined = false;
let gameState = null;
let currentDirection = null;

const playerColors = ["#2f7bff", "#4ad14a", "#9b59ff", "#ff9f40"];

function appendChat(line) {
  const div = document.createElement("div");
  div.className = "chat-line";
  div.textContent = line;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function emitDirection(dir) {
  if (!joined) return;
  if (currentDirection === dir) return;
  currentDirection = dir;
  socket.emit("move", { direction: dir });
}

function keyToDirection(key) {
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  return null;
}

window.addEventListener("keydown", (event) => {
  if (!joined) return;
  const dir = keyToDirection(event.key);
  if (dir) {
    emitDirection(dir);
    return;
  }
  if (event.key === " ") {
    event.preventDefault();
    socket.emit("placeBomb");
  }
});

window.addEventListener("keyup", (event) => {
  const dir = keyToDirection(event.key);
  if (!dir) return;
  if (currentDirection === dir) {
    emitDirection(null);
  }
});

joinBtn.addEventListener("click", () => {
  const nickname = nicknameInput.value.trim() || "Player";
  console.log("[join] button click, emit join", { nickname });
  socket.emit("join", { nickname });
  joined = true;
  nicknameInput.disabled = true;
  joinBtn.disabled = true;
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const message = chatInput.value.trim();
  if (!message) return;
  socket.emit("chat", { message });
  chatInput.value = "";
});

socket.on("connect", () => {
  myId = socket.id;
  console.log("[socket] connected", myId);
});

socket.on("connect_error", (err) => {
  console.log("[socket] connect_error", err?.message || err);
});

socket.on("joined", (payload) => {
  console.log("[join] joined ack", payload);
});

socket.on("chat", ({ nickname, message }) => {
  appendChat(`${nickname}: ${message}`);
});

socket.on("playerDead", ({ id }) => {
  appendChat(`💥 ${id} 사망`);
});

socket.on("gameOver", ({ winnerId }) => {
  const text = winnerId ? `게임 종료 - 승자: ${winnerId}` : "게임 종료";
  appendChat(text);
});

socket.on("stageOver", ({ message }) => {
  appendChat(`✅ ${message || "Stage Over"}`);
});

socket.on("gameState", (state) => {
  console.log("[client] gameState 수신", {
    roomId: state?.roomId,
    hasMap: Array.isArray(state?.map),
    players: state?.players?.length ?? 0,
    bombs: state?.bombs?.length ?? 0,
    items: state?.items?.length ?? 0,
  });
  gameState = state;
  roomInfo.textContent = `${state.roomCount}/4명`;
  if (!window.__firstStateLogged) {
    console.log("[state] first gameState received", state.roomId, state.roomCount);
    window.__firstStateLogged = true;
  }
});

function drawMap(map) {
  for (let row = 0; row < MAP_ROWS; row += 1) {
    for (let col = 0; col < MAP_COLS; col += 1) {
      const tile = map[row][col];
      const x = MAP_OFFSET_X + col * TILE_SIZE;
      const y = MAP_OFFSET_Y + row * TILE_SIZE;
      if (tile === 0) ctx.fillStyle = "#cfeec5";
      else if (tile === 1) ctx.fillStyle = "#3f444d";
      else ctx.fillStyle = "#8b5a2b";
      ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
      ctx.strokeStyle = "#202020";
      ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
    }
  }
}

function drawBombs(bombs) {
  for (const bomb of bombs) {
    const cx = MAP_OFFSET_X + bomb.col * TILE_SIZE + TILE_SIZE / 2;
    const cy = MAP_OFFSET_Y + bomb.row * TILE_SIZE + TILE_SIZE / 2;
    ctx.beginPath();
    ctx.fillStyle = "#ffdc3a";
    ctx.arc(cx, cy, TILE_SIZE * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawExplosions(explosions) {
  ctx.fillStyle = "rgba(45, 155, 255, 0.85)";
  for (const ex of explosions) {
    for (const c of ex.cells) {
      ctx.fillRect(
        MAP_OFFSET_X + c.col * TILE_SIZE,
        MAP_OFFSET_Y + c.row * TILE_SIZE,
        TILE_SIZE,
        TILE_SIZE,
      );
    }
  }
}

function drawItems(items) {
  for (const item of items) {
    const cx = MAP_OFFSET_X + item.col * TILE_SIZE + TILE_SIZE / 2;
    const cy = MAP_OFFSET_Y + item.row * TILE_SIZE + TILE_SIZE / 2;
    ctx.beginPath();
    if (item.type === "bomb") ctx.fillStyle = "#ffd642";
    else if (item.type === "range") ctx.fillStyle = "#ff4a4a";
    else ctx.fillStyle = "#f5f5f5";
    ctx.arc(cx, cy, TILE_SIZE * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawEntities(players, aiBots) {
  const sorted = [...players].sort((a, b) => a.id.localeCompare(b.id));
  const colorMap = {};
  let otherIdx = 1;
  for (const p of sorted) {
    if (p.id === myId) colorMap[p.id] = playerColors[0];
    else {
      colorMap[p.id] = playerColors[Math.min(otherIdx, playerColors.length - 1)];
      otherIdx += 1;
    }
  }

  for (const p of players) {
    ctx.fillStyle = p.alive ? colorMap[p.id] || "#2f7bff" : "#8f8f8f";
    ctx.fillRect(p.x, p.y, p.width, p.height);
    if (p.isBubbled) {
      ctx.strokeStyle = "#89d2ff";
      ctx.lineWidth = 3;
      ctx.strokeRect(p.x - 2, p.y - 2, p.width + 4, p.height + 4);
      ctx.lineWidth = 1;
    }
  }

  for (const ai of aiBots) {
    ctx.fillStyle = ai.alive ? "#ff5d5d" : "#8f8f8f";
    ctx.fillRect(ai.x, ai.y, ai.width, ai.height);
    if (ai.isBubbled) {
      ctx.strokeStyle = "#89d2ff";
      ctx.lineWidth = 3;
      ctx.strokeRect(ai.x - 2, ai.y - 2, ai.width + 4, ai.height + 4);
      ctx.lineWidth = 1;
    }
  }
}

function drawHud(state) {
  const me = state.players.find((p) => p.id === myId);
  ctx.fillStyle = "#fff";
  ctx.font = "18px Arial";
  if (me) {
    ctx.fillText(`💣 ${me.maxBombs}`, 18, 28);
    ctx.fillText(`🔥 ${me.bombRange}`, 18, 52);
    ctx.fillText(`⚡ ${me.speedLevel}`, 18, 76);
  }
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!gameState) return;
  drawMap(gameState.map);
  drawExplosions(gameState.explosions);
  drawBombs(gameState.bombs);
  drawItems(gameState.items);
  drawEntities(gameState.players, gameState.aiBots || []);
  drawHud(gameState);
}

function loop() {
  render();
  requestAnimationFrame(loop);
}

loop();
