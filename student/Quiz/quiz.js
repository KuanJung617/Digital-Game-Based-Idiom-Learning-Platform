const socket = io();
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
}[m]));

/* ===== 學生登入確認 ===== */
(function initStudentInfo(){
  const raw = sessionStorage.getItem('studentCtx');
  if (!raw) { location.href = '/student/login.html'; return; }
  let ctx;
  try { ctx = JSON.parse(raw); } catch { sessionStorage.removeItem('studentCtx'); location.href='/student/login.html'; return; }
  const cls = ctx.className?.trim();
  const no  = ctx.number?.trim();
  const name= ctx.name?.trim() || '同學';
  if (!cls || !no) { sessionStorage.removeItem('studentCtx'); location.href='/student/login.html'; return; }
  $('#studentInfo').innerHTML = `班級：<b>${esc(cls)}</b> ／ 座號：<b>${esc(no)}</b> ／ 姓名：<b>${esc(name)}</b>`;
  socket.emit('initStudentrom', cls, no, 'studentstudy');
})();

/* ===== 顯示題目區 ===== */
const quizContainer = $('#studentQuizContainer');
const weekSelectContainer = $('#studentWeekSelectContainer');

let quizDataByWeek = {};
let currentWeek = null;

/* ===== 初始化：要求伺服器發題目 ===== */
socket.emit('quizInit');

socket.on('quizInitResult', rows => {
  if (!rows || rows.length === 0) {
    quizContainer.innerHTML = `<div class="alert alert-warning">⚠️ 尚未有任何題目。</div>`;
    return;
  }

  // === 按週次分組 ===
  quizDataByWeek = {};
  rows.forEach(r => {
    const week = r.week || 0;
    if (!quizDataByWeek[week]) quizDataByWeek[week] = [];

    // --- 拆解成單一題 ---
    if (r.mcq_title) {
      quizDataByWeek[week].push({
        type: 'mcq',
        idiom: r.idiom,
        title: r.mcq_title,
        options: parseOptions(r.mcq_options_json),
        answer: r.mcq_answer
      });
    }
    if (r.tf_title) {
      quizDataByWeek[week].push({
        type: 'tf',
        idiom: r.idiom,
        title: r.tf_title,
        answer: String(r.tf_answer)
      });
    }
    if (r.open_title) {
      quizDataByWeek[week].push({
        type: 'open',
        idiom: r.idiom,
        title: r.open_title
      });
    }
  });

  renderWeekSelect();
});


/* ===== 週次選單 ===== */
function renderWeekSelect() {
  weekSelectContainer.innerHTML = '';
  const select = document.createElement('select');
  select.className = 'form-select w-auto d-inline-block';
  select.id = 'weekSelect';

  Object.keys(quizDataByWeek).sort((a,b)=>a-b).forEach(week=>{
    const opt = document.createElement('option');
    opt.value = week;
    opt.textContent = `第 ${week} 週`;
    select.appendChild(opt);
  });

  select.onchange = e => {
    currentWeek = e.target.value;
    renderQuiz(currentWeek);
  };

  weekSelectContainer.appendChild(select);

  // 預設顯示第一週
  currentWeek = Object.keys(quizDataByWeek)[0];
  renderQuiz(currentWeek);
}

/* ===== 顯示該週題目 ===== */
function renderQuiz(week) {
  let list = quizDataByWeek[week];
  if (!list || list.length === 0) {
    quizContainer.innerHTML = `<div class="alert alert-info">此週尚無題目。</div>`;
    return;
  }

  // === 打亂順序 ===
  list = shuffleArray(list);

  quizContainer.innerHTML = '';

  list.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'card mb-3 shadow-sm';
    let inner = `<div class="card-body">
      <h6 class="card-subtitle mb-2 text-muted">第 ${idx + 1} 題</h6>
      <p class="fw-bold">${esc(q.title)}</p>`;

    // === 各題型 ===
    if (q.type === 'mcq') {
      q.options.forEach(opt => {
        inner += `
          <div class="form-check">
            <input class="form-check-input" type="radio" name="q${idx}" value="${esc(opt)}">
            <label class="form-check-label">${esc(opt)}</label>
          </div>`;
      });
    }

    if (q.type === 'tf') {
      inner += `
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" name="q${idx}" value="1">
          <label class="form-check-label">✅ 對</label>
        </div>
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" name="q${idx}" value="0">
          <label class="form-check-label">❌ 錯</label>
        </div>`;
    }

    if (q.type === 'open') {
      inner += `<textarea class="form-control" name="q${idx}" rows="3" placeholder="請輸入答案..."></textarea>`;
    }

    inner += `<div class="feedback mt-2"></div></div>`;
    card.innerHTML = inner;
    quizContainer.appendChild(card);
  });

  // === 送出按鈕 ===
  const btn = document.createElement('button');
  btn.className = 'btn btn-success mt-3';
  btn.textContent = '送出答案';
  btn.onclick = () => submitQuiz(list);
  quizContainer.appendChild(btn);
}


/* ===== 送出答案 ===== */
function submitQuiz(list) {
  const student = JSON.parse(sessionStorage.getItem('studentCtx'));
  if (!student) return alert('學生資料錯誤，請重新登入。');

  let correctCount = 0;
  const results = [];

  list.forEach((q, i) => {
    let ans = '';
    if (q.type === 'mcq' || q.type === 'tf') {
      const sel = document.querySelector(`input[name="q${i}"]:checked`);
      ans = sel?.value || '';
    } else if (q.type === 'open') {
      const txt = document.querySelector(`textarea[name="q${i}"]`);
      ans = txt?.value.trim() || '';
    }

    const feedback = document.getElementsByClassName('feedback')[i];
    if (!ans) {
      feedback.innerHTML = `<span class="text-warning">⚠️ 未作答</span>`;
    } else if (q.type === 'open') {
      feedback.innerHTML = `<span class="text-info">✏️ 已作答（開放題不計分）</span>`;
    } else if (ans === String(q.answer)) {
      feedback.innerHTML = `<span class="text-success">✅ 答對</span>`;
      correctCount++;
    } else {
      feedback.innerHTML = `<span class="text-danger">❌ 答錯（正確答案：${esc(q.answer)}）</span>`;
    }

    results.push({
      title: q.title,
      type: q.type,
      answer: ans,
      correctAns: q.answer
    });
  });

  alert(`✅ 已送出答案！答對 ${correctCount} / ${list.length} 題`);

  socket.emit('quizSubmit', { student, week: currentWeek, results, correctCount: correctCount });

  socket.on('quizSubmitResult', res => {
    alert(res.message);
    if (res.success) {
      document.querySelector('button.btn-success').disabled = true;
    }
  });
}



/* ===== 工具 ===== */
function parseOptions(json) {
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr.filter(Boolean);
  } catch {}
  return [];
}

function shuffleArray(arr) {
  return arr
    .map(a => ({ sort: Math.random(), value: a }))
    .sort((a, b) => a.sort - b.sort)
    .map(a => a.value);
}
