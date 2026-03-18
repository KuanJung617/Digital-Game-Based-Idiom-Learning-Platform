const socket = io();

// ------------------ 題庫來源 ------------------
let quizData = { name: "自由練習題庫", questions: [] };

document.getElementById("hint").textContent = "請點擊字元，組成一個成語！";
document.getElementById("result").textContent = "";
document.getElementById("meaning").textContent = "";
document.getElementById("user-selection").textContent = "";

// ------------------ 初始化題庫 ------------------
socket.emit("getFreeQuiz"); // 向伺服器請求自由題庫

socket.once("freeQuiz", (res) => {
  if (res.success && res.data.length > 0) {
    // ✅ 只保留四字成語
    const filtered = res.data.filter(q => q.idiom && q.idiom.length === 4);

    if (filtered.length === 0) {
      alert("目前沒有符合的四字成語題目！");
      return;
    }

    // 建立題庫
    quizData.questions = filtered.map(q => ({
      idiom: q.idiom,
      chars: q.idiom
    }));

    initQuiz();
  } else {
    alert("無法載入自由練習題庫！");
  }
});

// ------------------ 題庫初始化 ------------------
let selectedCharacters = [];
let correctAnswers = [];

function initQuiz() {
  let allChars = [];
  correctAnswers = [];

  quizData.questions.forEach(q => {
    allChars.push(...q.chars.split(""));
    correctAnswers.push(q.idiom);
  });

  // 隨機化字元、去重
  allChars = shuffleArray(allChars);
  selectedCharacters = [];

  const grid = document.getElementById("characters");
  grid.innerHTML = "";
  allChars.forEach(char => {
    const div = document.createElement("div");
    div.classList.add("grid-item");
    div.textContent = char;
    div.onclick = () => selectCharacter(div, char);
    grid.appendChild(div);
  });
  loadNewQuestion(correctAnswers[0]); // 預設第一題
}

// ------------------ 點擊選字 ------------------
function selectCharacter(element, char) {
  if (!element.classList.contains("selected")) {
    element.classList.add("selected");
    selectedCharacters.push(char);
  } else {
    element.classList.remove("selected");
    selectedCharacters = selectedCharacters.filter(c => c !== char);
  }
  document.getElementById("user-selection").textContent = selectedCharacters.join("");
}

// ------------------ 檢查答案 ------------------
function checkAnswer() {
  const userAnswer = selectedCharacters.join("");

  if (!correctAnswers.includes(userAnswer)) {
    document.getElementById("result").textContent = "❌ 錯誤！請再試一次";
    document.getElementById("meaning").textContent = "";
    resetSelection();
    return;
  }

  // ✅ 查詢成語詳情
  socket.emit("chengyuWord", userAnswer);

  socket.once("chengyuWordResult", (data) => {
    if (!data) {
      document.getElementById("result").innerHTML = `✅ 答對了！<br>${userAnswer}`;
      document.getElementById("meaning").innerHTML = `<p><strong>釋義：</strong> 尚無資料</p>`;
    } else {
      document.getElementById("result").innerHTML = `✅ 答對了！<br><strong>${data.idiom}</strong>`;
      document.getElementById("meaning").innerHTML = `<p><strong>釋義：</strong> ${data.meaning || "無資料"}</p>`;
    }

    // 移除已答對的字元
    document.querySelectorAll(".grid-item.selected").forEach(item => item.remove());
    correctAnswers = correctAnswers.filter(ans => ans !== userAnswer);
    resetSelection();

    // ✅ 提示重置
    resetHint();

    // ✅ 換下一個題目（如果還有成語沒答）
    if (correctAnswers.length > 0) {
      const nextIdiom = correctAnswers[Math.floor(Math.random() * correctAnswers.length)];
      loadNewQuestion(nextIdiom);
    } else {
      document.getElementById("hint").textContent = "🎉 所有成語都完成囉！";
      setTimeout(() => {
        alert("🎉 全部答對了！太棒了！");
        window.location.reload();
      }, 500);
    }
  });
}

// ✅ 在載入新題目時呼叫
function loadNewQuestion(newIdiom) {
  currentIdiom = newIdiom; // 更新成語
  resetHint(); // 重置提示階段
  console.log(`🎯 新題目：${currentIdiom}`);
}


// ------------------ 重置選擇 ------------------
function resetSelection() {
  selectedCharacters = [];
  document.getElementById("user-selection").textContent = "";
  document.querySelectorAll(".grid-item").forEach(item => item.classList.remove("selected"));
}

// ------------------ 工具：打亂陣列 ------------------
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// ------------------ 返回遊戲選擇 ------------------
function backToStage() {
  window.location.href = "./../../guest_game.html";
}

// ========================================================
// 🧩 提示功能（修正版：依照題目重置 + 三階段提示）
// ========================================================

let hintLevel = 0; // 當前題目的提示階段（1~3循環）
let currentIdiom = ""; // 當前題目的正確成語
let isFlashing = false; // 避免重複閃爍

// ✅ 每當換題或答對時呼叫這個
function resetHint() {
  hintLevel = 0;
  isFlashing = false;
  document.getElementById("hint").textContent = "";
}

// ✅ 顯示提示
function showHint() {
  // 若當前題目不存在
  if (!currentIdiom) {
    document.getElementById("hint").textContent = "⚠️ 尚未載入題目！";
    return;
  }

  hintLevel = (hintLevel % 3) + 1; // 循環提示階段：1 → 2 → 3 → 1...

  if (hintLevel === 1) {
    // === 第一次提示：顯示釋義 ===
    socket.emit("chengyuWord", currentIdiom);
    socket.once("chengyuWordResult", data => {
      const meaning = data?.meaning || "這個成語表示某種情境。";
      document.getElementById("hint").textContent = `💡 提示（釋義）：${meaning}`;
    });

  } else if (hintLevel === 2) {
    // === 第二次提示：顯示首字 ===
    document.getElementById("hint").textContent = `💡 提示（首字）：第一個字是「${currentIdiom[0]}」`;

  } else if (hintLevel === 3) {
    // === 第三次提示：閃爍字元 ===
    flashHintChar(currentIdiom);
  }
}

// ✅ 閃爍提示字（預設隨機選一字）
function flashHintChar(idiom) {
  if (isFlashing) return; // 防止重複閃爍

  const hintEl = document.getElementById("hint");
  const chars = idiom.split("");
  const index = Math.floor(Math.random() * chars.length); // 隨機閃爍哪一個字
  const targetChar = chars[index];
  isFlashing = true;

  hintEl.textContent = `💡 提示（閃爍字）：看看「${targetChar}」在哪裡？`;

  const gridItems = document.querySelectorAll(".grid-item");
  let flashOn = false;
  const flashInterval = setInterval(() => {
    flashOn = !flashOn;
    gridItems.forEach(el => {
      if (el.textContent === targetChar) {
        el.classList.toggle("hint-highlight", flashOn);
      }
    });
  }, 400);

  // 3 秒後停止閃爍
  setTimeout(() => {
    clearInterval(flashInterval);
    gridItems.forEach(el => el.classList.remove("hint-highlight"));
    isFlashing = false;
  }, 3000);
}

