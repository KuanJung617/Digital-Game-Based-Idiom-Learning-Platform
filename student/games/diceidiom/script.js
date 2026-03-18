const socket = io();

let playerName = "";
let roomId = "";
let isMyTurn = false;

document.getElementById("startGameBtn").onclick = () => {
  playerName = document.getElementById("player1").value.trim();
  roomId = "room1"; // 先固定房間，未來可讓使用者自選

  if (!playerName) return alert("請輸入名稱！");
  socket.emit("joinGame", { playerName, roomId });
};

socket.on("roomFull", () => {
  alert("房間已滿，請稍後再試！");
});

socket.on("playerList", (data) => {
  const list = data.players.map(p => `${p.name} (${p.score}分)`).join("，");
  document.getElementById("leaderboard").innerHTML = `<li>${list}</li>`;
});

socket.on("gameStart", ({ currentPlayer }) => {
  document.getElementById("setup").style.display = "none";
  document.getElementById("gameArea").style.display = "block";
  isMyTurn = socket.id === currentPlayer;
  document.getElementById("currentPlayer").textContent = isMyTurn ? "你的回合" : "對手回合";
});

document.getElementById("rollDiceBtn").onclick = () => {
  if (!isMyTurn) return alert("還沒輪到你！");
  socket.emit("rollDice");
};

socket.on("newQuestion", ({ type }) => {
  document.getElementById("questionType").textContent = type;
  generateQuestion(type);
});

document.getElementById("submitAnswerBtn").onclick = () => {
  const answer = document.getElementById("answerInput").value.trim();
  const correct = document.getElementById("answerInput").dataset.correct;
  const result = document.getElementById("result");

  const correctBool = answer === correct;
  result.textContent = correctBool ? "✅ 正確！" : `❌ 錯誤！答案：${correct}`;
  socket.emit("answer", correctBool);
};

socket.on("updateScores", ({ scores, currentPlayer }) => {
  const board = Object.entries(scores)
    .map(([id, score]) => {
      const name = socket.id === id ? playerName : "對手";
      return `${name}: ${score}分`;
    })
    .join("<br>");
  document.getElementById("leaderboard").innerHTML = `<li>${board}</li>`;

  isMyTurn = socket.id === currentPlayer;
  document.getElementById("currentPlayer").textContent = isMyTurn ? "你的回合" : "對手回合";
});

socket.on("playerLeft", (name) => {
  alert(`${name} 離開遊戲`);
});
