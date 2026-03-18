/* ====== 基礎工具 ====== */
const socket = io();
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => (
  {"&":"&amp;","<":"&lt;","&quot;":"&quot;","'":"&#39;"}[m]
));

let quizData = { name: "", questions: [] };
let studentCtx = null;

let correctAnswers = [];
let selectedCharacters = [];
let currentIdiom = "";
let hintLevel = 0;
let isFlashing = false;

/* 學生資訊初始化 */
(function initStudentInfo() {
  try {
    const raw = sessionStorage.getItem("studentCtx");
    const ctx = raw ? JSON.parse(raw) : {};
    studentCtx = ctx || {};

    const cls  = String(ctx?.className ?? "").trim();
    const no   = String(ctx?.number ?? "").trim();
    let name   = String(ctx?.name ?? "").trim();
    const room = new URLSearchParams(location.search).get("room") || "studentFind";

    const infoEl = $("#studentInfo");
    infoEl.textContent = `${cls ? cls + "班 " : ""}${no ? no + "號 " : ""}${name || ""}`;

    socket.emit("initStudentgames", cls, no, room);

    socket.on("initStudentgamesResult", (res) => {
      if (!res?.ok) return;
      if (res.name) {
        name = String(res.name).trim();
        const nextCtx = { ...ctx, name };
        sessionStorage.setItem("studentCtx", JSON.stringify(nextCtx));
        $("#studentInfo").innerHTML =
          `班級：<b>${esc(cls)}</b> ／ 座號：<b>${esc(no)}</b> ／ 姓名：<b>${esc(name)}</b>`;
      }
    });
  } catch {
    $("#studentInfo").textContent = "未登入 / 無學生資訊";
  }
})();

/* ============================================================
   模式判斷（與 puzzle.js 相同）
   ============================================================ */
const params = new URLSearchParams(location.search);
const mode = params.get("source") || localStorage.getItem("gameMode") || "teacher";
const selectedWeek =
  Number(params.get("week")) ||
  Number(localStorage.getItem("selectedTeacherWeek")) ||
  1;

localStorage.setItem("selectedTeacherWeek", selectedWeek);

/* 題庫載入 */
socket.on("connect", () => {
  socket.emit("idiomGameInit", {
    className: studentCtx?.className,
    number: studentCtx?.number,
    name: studentCtx?.name,
    gameMode: mode,
    space: "idiomFind",
  });

  if (mode === "teacher") {
    socket.emit("getWeekQuiz", { week: selectedWeek });
  } else {
    socket.emit("getFreeQuiz");
  }
});

// 教師題庫
socket.on("weekQuiz", (res) => {
  if (res?.success && Array.isArray(res.data) && res.data.length > 0) {
    quizData = {
      name: `第 ${selectedWeek} 週 教師指定題庫`,
      questions: res.data
        .filter(q => q.idiom && q.idiom.length === 4)
        .map(q => ({ idiom: q.idiom }))
    };
  } else {
    quizData = { name: "本週無題目", questions: [] };
  }
  startGame();
});

// 自由題庫
socket.on("freeQuiz", (res) => {
  if (res.success && res.data.length > 0) {
    quizData = {
      name: "自由練習題庫",
      questions: res.data
        .filter(q => q.idiom && q.idiom.length === 4)
        .map(q => ({ idiom: q.idiom }))
    };
  } else {
    quizData = { name: "自由題庫無資料", questions: [] };
  }
  startGame();
});

/* ============================================================
   遊戲啟動
   ============================================================ */
function startGame() {
  if (quizData.questions.length === 0) {
    $("#quizSource").innerHTML =
      `<div class="alert alert-warning">目前沒有題目可玩！</div>`;
    return;
  }

  $("#quizSource").innerHTML =
    `📘 題庫來源：<strong>${quizData.name}</strong> ${
      mode === "teacher" ? "(教師指定)" : "(自由練習)"
    }`;

  let allChars = [];
  correctAnswers = [];

  quizData.questions.forEach(q => {
    allChars.push(...q.idiom.split(""));
    correctAnswers.push(q.idiom);
  });

  allChars = shuffleArray(allChars);
  selectedCharacters = [];

  const grid = $("#characters");
  grid.innerHTML = "";
  allChars.forEach(char => {
    const div = document.createElement("div");
    div.className = "grid-item";
    div.textContent = char;
    div.onclick = () => selectCharacter(div, char);
    grid.appendChild(div);
  });

  $("#hint").textContent = "請點擊字元，組成一個成語！";
  $("#result").textContent = "";
  $("#meaning").textContent = "";
  $("#user-selection").textContent = "";

  loadNewQuestion(correctAnswers[0]);
}

/* ============================================================
   選字邏輯
   ============================================================ */
function selectCharacter(el, char) {
  if (el.classList.contains("selected")) {
    el.classList.remove("selected");
    selectedCharacters = selectedCharacters.filter(c => c !== char);
  } else {
    el.classList.add("selected");
    selectedCharacters.push(char);
  }
  $("#user-selection").textContent = selectedCharacters.join("");
}

/* ============================================================
   檢查答案
   ============================================================ */
function checkAnswer() {
  const userAnswer = selectedCharacters.join("");

  if (!correctAnswers.includes(userAnswer)) {
    $("#result").textContent = "❌ 錯誤！請再試一次";
    $("#meaning").textContent = "";
    resetSelection();
    return;
  }

  socket.emit("studentsearchChengyu", userAnswer);
  socket.once("studentsearchChengyuResult", (rows = []) => {
    const data = rows?.[0];

    $("#result").innerHTML =
      `✅ 答對了！<br><strong>${esc(userAnswer)}</strong>`;

    $("#meaning").innerHTML =
      `<p><strong>釋義：</strong> ${esc(data?.meaning || "（無資料）")} </p>`;

    document.querySelectorAll(".grid-item.selected").forEach(item => item.remove());

    correctAnswers = correctAnswers.filter(ans => ans !== userAnswer);

    resetSelection();
    resetHint();

    // 下一題
    if (correctAnswers.length > 0) {
      const nextIdiom =
        correctAnswers[Math.floor(Math.random() * correctAnswers.length)];
      loadNewQuestion(nextIdiom);
    } else {
      $("#hint").textContent = "🎉 所有成語都完成囉！";
      setTimeout(() => {
        alert("🎉 全部答對了！");
        window.location.reload();
      }, 500);
    }
  });
}

/* ============================================================
   換題 / 提示邏輯
   ============================================================ */
function loadNewQuestion(newIdiom) {
  currentIdiom = newIdiom;
  resetHint();
}

function resetSelection() {
  selectedCharacters = [];
  $("#user-selection").textContent = "";
  document.querySelectorAll(".grid-item").forEach(el => el.classList.remove("selected"));
}

function resetHint() {
  hintLevel = 0;
  isFlashing = false;
  $("#hint").textContent = "";
}

function showHint() {
  if (!currentIdiom) return;

  hintLevel = (hintLevel % 3) + 1;

  if (hintLevel === 1) {
    socket.emit("studentsearchChengyu", currentIdiom);
    socket.once("studentsearchChengyuResult", (rows = []) => {
      const meaning = rows?.[0]?.meaning || "這個成語表示某種情境。";
      $("#hint").textContent = `💡 提示（釋義）：${meaning}`;
    });
  } else if (hintLevel === 2) {
    $("#hint").textContent =
      `💡 提示（首字）：第一個字是「${currentIdiom[0]}」`;
  } else if (hintLevel === 3) {
    flashHintChar(currentIdiom);
  }
}

function flashHintChar(idiom) {
  if (isFlashing) return;
  const gridItems = document.querySelectorAll(".grid-item");
  const chars = idiom.split("");
  const target = chars[Math.floor(Math.random() * chars.length)];
  isFlashing = true;

  $("#hint").textContent = `💡 提示（閃爍）：找找「${target}」在哪裡？`;

  let flashOn = false;
  const timer = setInterval(() => {
    flashOn = !flashOn;
    gridItems.forEach(el => {
      if (el.textContent === target) {
        el.classList.toggle("hint-highlight", flashOn);
      }
    });
  }, 400);

  setTimeout(() => {
    clearInterval(timer);
    gridItems.forEach(el => el.classList.remove("hint-highlight"));
    isFlashing = false;
  }, 3000);
}

/* ===== 工具 ===== */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ===== 返回選單 ===== */
function backToStage() {
  window.location.href = "/student/games.html?returnTo=gameSelect";
}
