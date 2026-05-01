const socket = io();

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const previewCanvas = document.getElementById("previewCanvas");
const pctx = previewCanvas.getContext("2d");

const loadingScreen = document.getElementById("loadingScreen");
const loadingBar = document.getElementById("loadingBar");
const loadingTip = document.getElementById("loadingTip");

const nicknameInput = document.getElementById("nicknameInput");
const toCustomizeBtn = document.getElementById("toCustomizeBtn");
const toModeBtn = document.getElementById("toModeBtn");
const backToNicknameBtn = document.getElementById("backToNicknameBtn");
const backToCustomizeBtn = document.getElementById("backToCustomizeBtn");
const nicknameWarn = document.getElementById("nicknameWarn");
const colorWarn = document.getElementById("colorWarn");
const stepNickname = document.getElementById("stepNickname");
const stepCustomize = document.getElementById("stepCustomize");
const stepMode = document.getElementById("stepMode");
const createModeSelect = document.getElementById("createModeSelect");
const createRoomBtn = document.getElementById("createRoomBtn");
const refreshRoomsBtn = document.getElementById("refreshRoomsBtn");
const roomListBox = document.getElementById("roomListBox");
const lobbyChatBox = document.getElementById("lobbyChatBox");
const lobbyChatLog = document.getElementById("lobbyChatLog");
const lobbyChatInput = document.getElementById("lobbyChatInput");

const shapeSelect = document.getElementById("shapeSelect");
const mainColorPicker = document.getElementById("mainColorPicker");
const borderColorPicker = document.getElementById("borderColorPicker");
const mainPreset = document.getElementById("mainPreset");
const borderPreset = document.getElementById("borderPreset");
const sizeRange = document.getElementById("sizeRange");
const sizeText = document.getElementById("sizeText");
const iconSelect = document.getElementById("iconSelect");

const roomInfo = document.getElementById("roomInfo");
const statsEl = document.getElementById("myStats");
const playersEl = document.getElementById("playerList");
const scoreboardEl = document.getElementById("scoreboard");
const gameTimerEl = document.getElementById("gameTimer");
const itemToast = document.getElementById("itemToast");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const resultEl = document.getElementById("resultText");
const scoreEl = document.getElementById("teamScore");
const lobbyPanel = document.getElementById("lobbyPanel");
const waitingText = document.getElementById("waitingText");
const startSoloBtn = document.getElementById("startSoloBtn");
const roomModeSelect = document.getElementById("roomModeSelect");
const changeModeBtn = document.getElementById("changeModeBtn");
const readyBtn = document.getElementById("readyBtn");
const gamePanel = document.getElementById("gamePanel");
const backLobbyBtn = document.getElementById("backLobbyBtn");

const finalScoreOverlay = document.getElementById("finalScoreOverlay");
const finalScoreTable = document.getElementById("finalScoreTable");
const finalMvp = document.getElementById("finalMvp");
const finalActions = document.getElementById("finalActions");
const finalRestartBtn = document.getElementById("finalRestartBtn");
const finalLobbyBtn = document.getElementById("finalLobbyBtn");

const TILE_SIZE = 48;
const MAP_COLS = 15;
const MAP_ROWS = 13;

const LOADING_TIPS = [
  "💡 폭탄을 벽 근처에 설치하면 연쇄폭발!",
  "💡 아이템을 먹으면 더 강해져요!",
  "💡 물방울에 갇힌 적은 밟아서 처치!",
  "💡 팀원의 물방울을 터뜨려 부활시키세요!",
];
const PRESET_COLORS = [
  "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#5ac8fa", "#007aff",
  "#af52de", "#ff2d55", "#ffffff", "#8e8e93", "#000000", "#2dd4bf",
];

const keys = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false, Space: false };
let myId = null;
let gameState = null;
let overlayText = "";
let spaceConsumed = false;
let lastFrame = performance.now();
let previewTick = 0;
let isReady = false;
let gameStartMs = 0;
let scoreStats = {};
let prevPlayerById = {};
let prevMap = null;
let statFlashUntil = 0;
let toastUntil = 0;
let shakeUntil = 0;
let shakePower = 0;
const particles = [];
const flashes = [];
const debris = [];

const defaultCustomization = {
  shape: "circle",
  mainColor: "#2f80ed",
  borderColor: "#ffffff",
  size: 34,
  icon: "none",
};
let customization = { ...defaultCustomization };

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function luminance(hex) {
  const c = hex.replace("#", "");
  const n = parseInt(c, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isTooDark(color) {
  return luminance(color) < 45;
}

function showToast(text) {
  itemToast.textContent = text;
  itemToast.style.display = "block";
  toastUntil = performance.now() + 1000;
}

function loadCustomization() {
  const raw = localStorage.getItem("crazyCustomization");
  if (!raw) return;
  try {
    customization = { ...defaultCustomization, ...JSON.parse(raw) };
  } catch (_) {}
}

function saveCustomization() {
  localStorage.setItem("crazyCustomization", JSON.stringify(customization));
}

function applyCustomizationToControls() {
  shapeSelect.value = customization.shape;
  mainColorPicker.value = customization.mainColor;
  borderColorPicker.value = customization.borderColor;
  sizeRange.value = String(customization.size);
  sizeText.textContent = `${customization.size}px`;
  iconSelect.value = customization.icon;
}

function makePresetButtons(container, onPick) {
  container.innerHTML = "";
  PRESET_COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.width = "22px";
    b.style.height = "22px";
    b.style.margin = "2px";
    b.style.border = "1px solid #444";
    b.style.background = c;
    b.addEventListener("click", () => onPick(c));
    container.appendChild(b);
  });
}

function drawShape(context, shape, x, y, size, mainColor, borderColor) {
  const r = size / 2;
  context.beginPath();
  if (shape === "circle") {
    context.arc(x, y, r, 0, Math.PI * 2);
  } else if (shape === "square") {
    context.rect(x - r, y - r, size, size);
  } else if (shape === "triangle") {
    context.moveTo(x, y - r);
    context.lineTo(x + r, y + r);
    context.lineTo(x - r, y + r);
    context.closePath();
  } else if (shape === "diamond") {
    context.moveTo(x, y - r);
    context.lineTo(x + r, y);
    context.lineTo(x, y + r);
    context.lineTo(x - r, y);
    context.closePath();
  } else {
    const spikes = 5;
    const inner = r * 0.45;
    let rot = Math.PI / 2 * 3;
    const step = Math.PI / spikes;
    context.moveTo(x, y - r);
    for (let i = 0; i < spikes; i += 1) {
      context.lineTo(x + Math.cos(rot) * r, y + Math.sin(rot) * r);
      rot += step;
      context.lineTo(x + Math.cos(rot) * inner, y + Math.sin(rot) * inner);
      rot += step;
    }
    context.closePath();
  }
  context.fillStyle = mainColor;
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = borderColor;
  context.stroke();
}

function drawPreview() {
  previewTick += 0.04;
  pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  const x = 110 + Math.sin(previewTick) * 12;
  const y = 115;
  drawShape(pctx, customization.shape, x, y, customization.size, customization.mainColor, customization.borderColor);
  if (customization.icon !== "none") {
    pctx.font = "18px sans-serif";
    pctx.textAlign = "center";
    pctx.fillText(customization.icon, x, y - customization.size / 2 - 12);
  }
  requestAnimationFrame(drawPreview);
}

function teamTextColor(team) {
  if (team === "A") return "#2f80ed";
  if (team === "B") return "#eb5757";
  return "#222";
}

function drawMap(map) {
  for (let y = 0; y < MAP_ROWS; y += 1) {
    for (let x = 0; x < MAP_COLS; x += 1) {
      const t = map?.[y]?.[x] ?? 0;
      ctx.fillStyle = t === 0 ? "#c7f0b7" : t === 1 ? "#3f454d" : "#8c6239";
      ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }
}

function drawBombs(bombs) {
  (bombs || []).forEach((b) => {
    ctx.beginPath();
    ctx.fillStyle = "#111";
    ctx.arc(b.x, b.y, 11, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawExplosions(ex) {
  (ex || []).forEach((e) => {
    ctx.fillStyle = "rgba(255,140,0,0.8)";
    ctx.fillRect(e.x + 4, e.y + 4, TILE_SIZE - 8, TILE_SIZE - 8);
  });
}

function drawItems(items) {
  (items || []).forEach((i) => {
    const c = i.type === "bombUp" ? "#ffe066" : i.type === "rangeUp" ? "#ff7b7b" : "#7dd87d";
    drawShape(ctx, "star", i.x, i.y, 22, c, "#333");
  });
}

function drawPlayers(players) {
  (players || []).forEach((p) => {
    if (!p.alive) return;
    const c = p.customization || defaultCustomization;
    drawShape(ctx, c.shape, p.x, p.y, c.size, c.mainColor, c.borderColor);
    if (c.icon && c.icon !== "none") {
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(c.icon, p.x, p.y - c.size / 2 - 10);
    }
    if (p.isBubbled) {
      ctx.beginPath();
      ctx.fillStyle = "rgba(64,156,255,0.35)";
      ctx.arc(p.x, p.y, c.size * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = teamTextColor(p.team);
    ctx.fillText(p.nickname, p.x, p.y - c.size / 2 - 24);
  });
}

function drawEffects(now) {
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    const life = (p.endsAt - now) / p.life;
    if (life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    ctx.fillStyle = p.color;
    ctx.globalAlpha = life;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * life, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  for (let i = flashes.length - 1; i >= 0; i -= 1) {
    const f = flashes[i];
    const life = (f.endsAt - now) / f.life;
    if (life <= 0) {
      flashes.splice(i, 1);
      continue;
    }
    ctx.fillStyle = "rgba(255,165,0,0.45)";
    ctx.globalAlpha = life;
    ctx.fillRect(f.x + 2, f.y + 2, TILE_SIZE - 4, TILE_SIZE - 4);
    ctx.globalAlpha = 1;
  }
  for (let i = debris.length - 1; i >= 0; i -= 1) {
    const d = debris[i];
    d.x += d.vx;
    d.y += d.vy;
    const life = (d.endsAt - now) / d.life;
    if (life <= 0) {
      debris.splice(i, 1);
      continue;
    }
    ctx.fillStyle = "#8c6239";
    ctx.globalAlpha = life;
    ctx.fillRect(d.x, d.y, d.size * life, d.size * life);
    ctx.globalAlpha = 1;
  }
}

function spawnExplosionEffects(tiles) {
  const colors = ["#ff8a00", "#ff3d00", "#ffd54f"];
  tiles.forEach((t) => {
    flashes.push({ x: t.x, y: t.y, life: 300, endsAt: performance.now() + 300 });
    for (let i = 0; i < 20; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const s = 1 + Math.random() * 2.2;
      particles.push({
        x: t.x + TILE_SIZE / 2,
        y: t.y + TILE_SIZE / 2,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        size: 3 + Math.random() * 5,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 500,
        endsAt: performance.now() + 500,
      });
    }
  });
  shakeUntil = performance.now() + 200;
  shakePower = 3;
}

function detectBlockDebris(oldMap, newMap) {
  if (!oldMap || !newMap) return;
  for (let y = 0; y < MAP_ROWS; y += 1) {
    for (let x = 0; x < MAP_COLS; x += 1) {
      if (oldMap[y]?.[x] === 2 && newMap[y]?.[x] === 0) {
        for (let i = 0; i < 5; i += 1) {
          const a = Math.random() * Math.PI * 2;
          const s = 0.5 + Math.random() * 1.7;
          debris.push({
            x: x * TILE_SIZE + TILE_SIZE / 2,
            y: y * TILE_SIZE + TILE_SIZE / 2,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s,
            size: 4 + Math.random() * 4,
            life: 400,
            endsAt: performance.now() + 400,
          });
        }
      }
    }
  }
}

function drawOverlay() {
  if (!overlayText) return;
  ctx.fillStyle = "rgba(0,0,0,0.56)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.font = "bold 42px sans-serif";
  ctx.fillText(overlayText, canvas.width / 2, canvas.height / 2 - 10);
  ctx.font = "20px sans-serif";
  ctx.fillText("R키를 눌러 재시작", canvas.width / 2, canvas.height / 2 + 30);
}

function pressedDir() {
  if (keys.ArrowUp) return "up";
  if (keys.ArrowDown) return "down";
  if (keys.ArrowLeft) return "left";
  if (keys.ArrowRight) return "right";
  return null;
}

function ensureScoreRows(players) {
  (players || []).forEach((p) => {
    if (!scoreStats[p.id]) scoreStats[p.id] = { nickname: p.nickname, kills: 0, deaths: 0, items: 0, team: p.team };
    scoreStats[p.id].nickname = p.nickname;
    scoreStats[p.id].team = p.team;
  });
}

function updateStatsDiff(players) {
  const nowById = {};
  (players || []).forEach((p) => {
    nowById[p.id] = p;
    const prev = prevPlayerById[p.id];
    if (prev && prev.alive && !p.alive) scoreStats[p.id].deaths += 1;
    if (prev) {
      const prevBombMax = Number(prev.bombMax || 0);
      const nowBombMax = Number(p.bombMax || 0);
      const prevSum = prevBombMax + prev.bombRange + prev.speed;
      const nowSum = nowBombMax + p.bombRange + p.speed;
      if (nowSum > prevSum) {
        scoreStats[p.id].items += 1;
        if (p.id === myId) {
          if (nowBombMax > prevBombMax) showToast("💣 폭탄 업!");
          else if (p.bombRange > prev.bombRange) showToast("🔥 사거리 업!");
          else if (p.speed > prev.speed) showToast("⚡ 속도 업!");
          statFlashUntil = performance.now() + 500;
        }
      }
    }
  });
  prevPlayerById = nowById;
}

function renderScoreboard(players) {
  const rows = Object.values(scoreStats)
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .map((s) => `${s.nickname} K:${s.kills} D:${s.deaths} I:${s.items}`);
  scoreboardEl.innerHTML = rows.join("<br>") || "-";
}

function updateTimer() {
  if (!gameState?.started) {
    gameTimerEl.textContent = "⏱ 00:00";
    return;
  }
  const sec = Math.max(0, Math.floor((Date.now() - gameStartMs) / 1000));
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  gameTimerEl.textContent = `⏱ ${m}:${s}`;
}

function updateUi() {
  if (!gameState) return;
  const me = gameState.players?.find((p) => p.id === myId);
  if (me) {
    statsEl.textContent = `💣 ${me.bombCount} | 🔥 ${me.bombRange} | ⚡ ${me.speed}`;
    if (performance.now() < statFlashUntil) statsEl.style.filter = "brightness(1.4)";
    else statsEl.style.filter = "none";
  }
  playersEl.innerHTML = (gameState.players || []).map((p) => `${p.alive ? "●" : "○"} ${p.nickname}`).join("<br>");
  const a = gameState.matchScore?.A ?? 0;
  const b = gameState.matchScore?.B ?? 0;
  scoreEl.textContent = `A ${a} : ${b} B`;
  ensureScoreRows(gameState.players);
  updateStatsDiff(gameState.players);
  renderScoreboard(gameState.players);
  updateTimer();
}

function toSpeedScale(size) {
  const t = (size - 24) / (41 - 24);
  return 1.1 - t * 0.2;
}

function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const isTyping = document.activeElement === chatInput || document.activeElement === lobbyChatInput;

  if (gameState?.started && myId && !overlayText && !isTyping) {
    const d = pressedDir();
    if (d) socket.emit("move", { dir: d, dt });
    if (keys.Space && !spaceConsumed) {
      socket.emit("placeBomb");
      spaceConsumed = true;
    }
    if (!keys.Space) spaceConsumed = false;
  }

  let sx = 0;
  let sy = 0;
  if (performance.now() < shakeUntil) {
    sx = (Math.random() - 0.5) * shakePower * 2;
    sy = (Math.random() - 0.5) * shakePower * 2;
  }

  ctx.save();
  ctx.translate(sx, sy);
  ctx.clearRect(-4, -4, canvas.width + 8, canvas.height + 8);
  if (!gameState?.started) {
    ctx.fillStyle = "#222";
    ctx.font = "20px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(waitingText.textContent || "대기 중...", canvas.width / 2, canvas.height / 2);
  } else {
    drawMap(gameState.map);
    drawBombs(gameState.bombs);
    drawExplosions(gameState.explosions);
    drawItems(gameState.items);
    drawPlayers(gameState.players);
    drawEffects(performance.now());
    drawOverlay();
  }
  ctx.restore();

  if (toastUntil > 0 && performance.now() > toastUntil) itemToast.style.display = "none";
  const me = gameState?.players?.find((p) => p.id === myId);
  if (me?.isBubbled && Math.floor(performance.now() / 150) % 2 === 0) {
    canvas.style.boxShadow = "0 0 0 4px rgba(70,130,255,0.8)";
  } else {
    canvas.style.boxShadow = "none";
  }

  requestAnimationFrame(loop);
}

function enterLobby() {
  lobbyPanel.style.display = "block";
  gamePanel.style.display = "none";
  stepNickname.style.display = "block";
  stepCustomize.style.display = "none";
  stepMode.style.display = "none";
  if (lobbyChatBox) lobbyChatBox.style.display = "none";
}

function enterRoomSelectLobby() {
  lobbyPanel.style.display = "block";
  gamePanel.style.display = "none";
  stepNickname.style.display = "none";
  stepCustomize.style.display = "none";
  stepMode.style.display = "block";
  if (lobbyChatBox) lobbyChatBox.style.display = "block";
  socket.emit("requestRoomList");
}

function enterGame() {
  lobbyPanel.style.display = "none";
  gamePanel.style.display = "block";
}

function buildJoinPayload(mode) {
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    stepMode.style.display = "none";
    stepNickname.style.display = "block";
    nicknameWarn.textContent = "닉네임을 입력해야 합니다.";
    return null;
  }
  return {
    nickname,
    mode,
    customization: {
      ...customization,
      size: clamp(customization.size, 24, 41),
      speedScale: toSpeedScale(clamp(customization.size, 24, 41)),
    },
  };
}

toCustomizeBtn.addEventListener("click", () => {
  if (!nicknameInput.value.trim()) {
    nicknameWarn.textContent = "닉네임을 입력해야 합니다.";
    return;
  }
  nicknameWarn.textContent = "";
  stepNickname.style.display = "none";
  stepCustomize.style.display = "block";
  if (lobbyChatBox) lobbyChatBox.style.display = "none";
});
backToNicknameBtn?.addEventListener("click", () => {
  stepCustomize.style.display = "none";
  stepNickname.style.display = "block";
  if (lobbyChatBox) lobbyChatBox.style.display = "none";
});

toModeBtn.addEventListener("click", () => {
  if (isTooDark(customization.mainColor) || isTooDark(customization.borderColor)) {
    colorWarn.textContent = "너무 어두운 색상은 사용할 수 없습니다.";
    return;
  }
  colorWarn.textContent = "";
  saveCustomization();
  stepCustomize.style.display = "none";
  stepMode.style.display = "block";
  if (lobbyChatBox) lobbyChatBox.style.display = "block";
  socket.emit("requestRoomList");
});
backToCustomizeBtn?.addEventListener("click", () => {
  stepMode.style.display = "none";
  stepCustomize.style.display = "block";
  if (lobbyChatBox) lobbyChatBox.style.display = "none";
});

shapeSelect.addEventListener("change", () => { customization.shape = shapeSelect.value; saveCustomization(); });
mainColorPicker.addEventListener("input", () => { customization.mainColor = mainColorPicker.value; saveCustomization(); });
borderColorPicker.addEventListener("input", () => { customization.borderColor = borderColorPicker.value; saveCustomization(); });
sizeRange.addEventListener("input", () => {
  customization.size = clamp(Number(sizeRange.value), 24, 41);
  sizeText.textContent = `${customization.size}px`;
  saveCustomization();
});
iconSelect.addEventListener("change", () => { customization.icon = iconSelect.value; saveCustomization(); });

makePresetButtons(mainPreset, (c) => { mainColorPicker.value = c; customization.mainColor = c; saveCustomization(); });
makePresetButtons(borderPreset, (c) => { borderColorPicker.value = c; customization.borderColor = c; saveCustomization(); });

createRoomBtn.addEventListener("click", () => {
  const payload = buildJoinPayload(createModeSelect.value);
  if (!payload) return;
  socket.emit("createGameRoom", payload);
});

refreshRoomsBtn.addEventListener("click", () => socket.emit("requestRoomList"));

backLobbyBtn.addEventListener("click", () => {
  socket.emit("backToLobby");
  enterRoomSelectLobby();
});
startSoloBtn.addEventListener("click", () => {
  socket.emit("startSoloGame");
  startSoloBtn.style.display = "none";
});
changeModeBtn.addEventListener("click", () => {
  socket.emit("changeRoomMode", { mode: roomModeSelect.value });
  isReady = false;
  readyBtn.textContent = "레디";
});
readyBtn.addEventListener("click", () => {
  isReady = !isReady;
  socket.emit("setReady", { ready: isReady });
  readyBtn.textContent = isReady ? "레디 취소" : "레디";
});

finalRestartBtn.addEventListener("click", () => socket.emit("restart"));
finalLobbyBtn.addEventListener("click", () => {
  socket.emit("backToLobby");
  finalScoreOverlay.style.display = "none";
  enterRoomSelectLobby();
});

document.addEventListener("keydown", (e) => {
  const t = e.target;
  const isInputTarget = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (isInputTarget) return;
  const isTyping = document.activeElement === chatInput || document.activeElement === lobbyChatInput;
  if (isTyping) return;
  if (e.code === "KeyR" && overlayText) {
    socket.emit("restart");
    overlayText = "";
    resultEl.textContent = "";
    e.preventDefault();
    return;
  }
  if (e.code in keys) {
    keys[e.code] = true;
    e.preventDefault();
  }
});
document.addEventListener("keyup", (e) => {
  const t = e.target;
  const isInputTarget = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (isInputTarget) return;
  if (e.code in keys) {
    keys[e.code] = false;
    e.preventDefault();
  }
});

chatInput.addEventListener("keydown", (e) => {
  if (e.code in keys) e.stopPropagation();
  if (e.key !== "Enter") return;
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  socket.emit("roomChat", { message });
  chatInput.value = "";
});
lobbyChatInput?.addEventListener("keydown", (e) => {
  if (e.code in keys) e.stopPropagation();
  if (e.key !== "Enter") return;
  e.preventDefault();
  const message = lobbyChatInput.value.trim();
  if (!message) return;
  socket.emit("lobbyChat", { message, nickname: nicknameInput.value.trim() || "Player" });
  lobbyChatInput.value = "";
});
function clearGameKeys() {
  Object.keys(keys).forEach((k) => { keys[k] = false; });
}
chatInput.addEventListener("focus", clearGameKeys);
lobbyChatInput?.addEventListener("focus", clearGameKeys);

socket.on("joinedLobby", ({ roomId }) => {
  roomInfo.textContent = `Room: ${roomId}`;
  enterGame();
  isReady = false;
  readyBtn.textContent = "레디";
});

socket.on("roomList", ({ rooms }) => {
  roomListBox.innerHTML = "";
  if (!rooms || rooms.length === 0) {
    roomListBox.textContent = "참가 가능한 방이 없습니다.";
    return;
  }
  rooms.forEach((r) => {
    const row = document.createElement("div");
    row.style.margin = "6px 0";
    const label = document.createElement("span");
    const maxHumans = Number(r.maxHumans) || 4;
    label.textContent = `[${r.roomId}] ${r.mode} (${r.connected}/${maxHumans})`;
    const btn = document.createElement("button");
    btn.textContent = "입장";
    btn.style.marginLeft = "8px";
    btn.addEventListener("click", () => {
      const payload = buildJoinPayload(r.mode);
      if (!payload) return;
      socket.emit("joinGameRoom", { roomId: r.roomId, nickname: payload.nickname, customization: payload.customization });
    });
    row.appendChild(label);
    row.appendChild(btn);
    roomListBox.appendChild(row);
  });
});

socket.on("lobbyState", ({ message, canStart, mode, ready, countdown }) => {
  waitingText.textContent = countdown > 0 ? `${countdown}` : message;
  if (mode) roomModeSelect.value = mode;
  startSoloBtn.style.display = canStart ? "inline-block" : "none";
  if (Array.isArray(ready)) {
    playersEl.innerHTML = ready.map((r) => `${r.ready ? "✅" : "⬜"} ${r.nickname}`).join("<br>");
    const meReady = ready.find((r) => r.id === myId)?.ready;
    isReady = Boolean(meReady);
    readyBtn.textContent = isReady ? "레디 취소" : "레디";
  }
});

socket.on("gameStarted", () => {
  waitingText.textContent = "";
  startSoloBtn.style.display = "none";
  isReady = false;
  readyBtn.textContent = "레디";
  overlayText = "";
  resultEl.textContent = "";
  gameStartMs = Date.now();
  scoreStats = {};
  prevPlayerById = {};
  prevMap = null;
  finalScoreOverlay.style.display = "none";
  finalActions.style.display = "none";
});

socket.on("roundResult", ({ winnerTeam, round, matchScore, matchOver }) => {
  if (!matchOver) {
    waitingText.textContent = winnerTeam ? `Round ${round} - 팀${winnerTeam} 승리` : `Round ${round} - 무승부`;
  }
  if (matchScore) {
    scoreEl.textContent = `A ${matchScore.A} : ${matchScore.B} B`;
  }
});

socket.on("explosion", ({ tiles }) => {
  if (Array.isArray(tiles)) spawnExplosionEffects(tiles);
});

socket.on("gameState", (state) => {
  detectBlockDebris(prevMap, state.map);
  prevMap = state.map ? state.map.map((r) => [...r]) : null;
  gameState = state;
  updateUi();
});

socket.on("dead", () => {
  overlayText = "You Died! 👻";
  resultEl.textContent = overlayText;
});

socket.on("gameOver", ({ result, winnerId, winnerTeam }) => {
  if (result === "draw") overlayText = "Draw! 🤝";
  else if (winnerId) overlayText = winnerId === myId ? "Victory! 🏆" : "You Died! 👻";
  else if (winnerTeam) {
    const me = gameState?.players?.find((p) => p.id === myId);
    overlayText = me?.team === winnerTeam ? "Victory! 🏆" : "You Died! 👻";
  } else overlayText = "Draw! 🤝";
  resultEl.textContent = overlayText;

  const sorted = Object.values(scoreStats).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  finalScoreTable.innerHTML = sorted.map((s, i) => `${i + 1}. ${s.nickname} | K:${s.kills} D:${s.deaths} I:${s.items}`).join("<br>");
  const mvp = sorted[0];
  finalMvp.textContent = mvp ? `MVP: ${mvp.nickname} (${mvp.kills} Kills)` : "";
  finalScoreOverlay.style.display = "flex";
  setTimeout(() => {
    finalActions.style.display = "block";
  }, 3000);
});

socket.on("roomChat", ({ nickname, message }) => {
  const line = document.createElement("div");
  line.textContent = `[${nickname}] ${message}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
});

socket.on("roomChatHistory", ({ messages }) => {
  chatLog.innerHTML = "";
  (messages || []).forEach((m) => {
    const line = document.createElement("div");
    line.textContent = `[${m.nickname}] ${m.message}`;
    chatLog.appendChild(line);
  });
  chatLog.scrollTop = chatLog.scrollHeight;
});

socket.on("lobbyChat", ({ nickname, message }) => {
  if (!lobbyChatLog) return;
  const line = document.createElement("div");
  line.textContent = `[${nickname}] ${message}`;
  lobbyChatLog.appendChild(line);
  lobbyChatLog.scrollTop = lobbyChatLog.scrollHeight;
});

socket.on("lobbyChatHistory", ({ messages }) => {
  if (!lobbyChatLog) return;
  lobbyChatLog.innerHTML = "";
  (messages || []).forEach((m) => {
    const line = document.createElement("div");
    line.textContent = `[${m.nickname}] ${m.message}`;
    lobbyChatLog.appendChild(line);
  });
  lobbyChatLog.scrollTop = lobbyChatLog.scrollHeight;
});

socket.on("connect", () => {
  myId = socket.id;
});

function runLoadingSequence() {
  let p = 0;
  loadingTip.textContent = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];
  const tipTimer = setInterval(() => {
    loadingTip.textContent = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];
  }, 900);
  const timer = setInterval(() => {
    p += 4 + Math.random() * 8;
    if (p >= 100) p = 100;
    loadingBar.style.width = `${p}%`;
    if (p >= 100) {
      clearInterval(timer);
      clearInterval(tipTimer);
      loadingScreen.style.transition = "opacity 450ms ease";
      loadingScreen.style.opacity = "0";
      setTimeout(() => {
        loadingScreen.style.display = "none";
        lobbyPanel.style.opacity = "0";
        lobbyPanel.style.transition = "opacity 450ms ease";
        setTimeout(() => {
          lobbyPanel.style.opacity = "1";
        }, 20);
      }, 460);
    }
  }, 90);
}

loadCustomization();
applyCustomizationToControls();
drawPreview();
enterLobby();
runLoadingSequence();
requestAnimationFrame(loop);
