// --- stats.js (使用 socket.io) ---
// 假設頁面已經載入 socket.io client 並有全域 socket 變數：const socket = io();

let statsChart = null;
let currentClassName = null;
let currentClassRawRows = []; // raw rows from server => [{className, number, name, week, score}, ...]

// 初始化入口（呼叫一次）
function initStatsModule() {
  const container = document.querySelector('#stats');
  if (!container) {
    console.warn('#stats not found');
    return;
  }

  // 請求班級清單
  socket.emit('getClassList');

  // 清理舊 listener 再綁新的（避免多次綁定）
  socket.off('classList');
  socket.on('classList', (res) => {
    if (!res.success) {
      container.innerHTML = `<div class="alert alert-danger">讀取班級清單失敗</div>`;
      return;
    }
    renderClassSelector(res.data || []);
  });

  // 當前頁面若要自動更新，也可以在這兒每隔一段時間重新 emit getClassList
}

// 渲染班級下拉按鈕列
function renderClassSelector(classList) {
  const container = document.querySelector('#stats');
  if (!classList || classList.length === 0) {
    container.innerHTML = `
      <div class="module">
        <h2>📊 學習成果統計分析</h2>
        <div class="alert alert-info">目前尚無學生作答紀錄。</div>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="module">
      <h2>📊 學習成果統計分析</h2>
      <div id="classButtons" class="mb-3"></div>
      <div id="classStats"></div>
    </div>
  `;

  const btnBox = document.getElementById('classButtons');
  btnBox.innerHTML = classList.map(c => `<button class="btn btn-outline-primary btn-sm me-1" data-class="${c}">${c} 班</button>`).join('');

  btnBox.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const className = btn.getAttribute('data-class');
      currentClassName = className;
      // 取得該班級所有資料
      socket.emit('getClassStats', className);

      socket.off('classStats');
      socket.on('classStats', (res) => {
        if (!res.success) {
          document.getElementById('classStats').innerHTML = `<div class="alert alert-danger">無法取得 ${className} 統計</div>`;
          return;
        }
        currentClassRawRows = res.data || [];
        renderClassStatsFromRows(className, currentClassRawRows);
      });
    });
  });

  // 預設自動點選第一班
  const first = btnBox.querySelector('button');
  if (first) first.click();
}

// 將 DB rows 轉成你原本 localStorage 的 classStudents 結構，然後調用原本繪圖/表格邏輯
function renderClassStatsFromRows(className, rows) {
  // rows: [{ className, number, name, week, score }, ...]
  // 目標： group by studentKey = `${className}-${number}-${name}` -> { studentKey: { week: [ items? ] } }
  // 但後端 getClassStats 目前只回 week+score，若要題目詳情請呼 getStudentWeekDetail

  // 先轉成每位學生每週分數的結構（用於畫圖與表格）
  const byStudent = {}; // { studentKey: { number, name, weeks: { week: score } } }
  rows.forEach(r => {
    const key = `${r.className}-${r.number}-${r.name}`;
    if (!byStudent[key]) byStudent[key] = { className: r.className, number: r.number, name: r.name, weeks: {} };
    byStudent[key].weeks[String(r.week)] = (r.score == null) ? null : Number(r.score);
  });

  // 取得所有週次排序
  const allWeeks = [...new Set(rows.map(r => r.week))].sort((a,b)=>Number(a)-Number(b));

  // 轉為原本所需資料結構（studentDatas）：
  // studentDatas[studentKey] = [每週正確率或分數]
  const studentKeys = Object.keys(byStudent).sort((a,b) => {
    // 按座號排序（number）
    return Number(byStudent[a].number) - Number(byStudent[b].number);
  });

  const studentDatas = {};
  studentKeys.forEach(key => {
    studentDatas[key] = allWeeks.map(w => {
      const v = byStudent[key].weeks[String(w)];
      // 假設 score 為分數（0~21 或 0~100），我們直接使用 score；若你需要正確率，請後端回傳百分比或算分/題數
      return v == null ? null : v;
    });
  });

  // 班級平均：把每週所有學生有值的分數平均（忽略 null）
  const classAverage = allWeeks.map((w, idx) => {
    const arr = studentKeys.map(k => studentDatas[k][idx]).filter(v => v != null && !isNaN(v));
    if (arr.length === 0) return 0;
    const sum = arr.reduce((a,b)=>a+b,0);
    return (sum / arr.length);
  });

  // ---------- 畫圖 ----------
  const container = document.getElementById('classStats');
  container.innerHTML = `
    <canvas id="statsChart" width="900" height="450"></canvas>
    <div id="recordsTable" class="mt-4"></div>
  `;
  const ctx = document.getElementById('statsChart').getContext('2d');

  if (statsChart) {
    try { statsChart.destroy(); } catch(e){/*ignore*/ }
    statsChart = null;
  }

  function generateColor(i, opacity = 0.6) {
    const hue = (i * 60) % 360;
    return `hsla(${hue}, 70%, 60%, ${opacity})`;
  }

  const studentDatasets = studentKeys.map((studentKey, index) => {
    const info = byStudent[studentKey];
    return {
      label: `${info.number}號 ${info.name}`,
      type: 'bar',
      data: studentDatas[studentKey],
      backgroundColor: generateColor(index, 0.6),
      borderColor: generateColor(index, 1),
      borderWidth: 1
    };
  });

  studentDatasets.push({
    label: '📈 班級平均',
    type: 'line',
    data: classAverage,
    borderColor: 'rgba(255, 99, 132, 1)',
    backgroundColor: 'rgba(255, 99, 132, 0.3)',
    borderWidth: 3,
    tension: 0.3,
    fill: false,
  });

  statsChart = new Chart(ctx, {
    data: {
      labels: allWeeks.map(w => `第${w}週`),
      datasets: studentDatasets
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: { display: true, text: `${className} 班 各週成績`, font: { size: 18 } },
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.formattedValue}` } }
      },
      scales: {
        y: { beginAtZero: true }
      }
    }
  });

  // ---------- 表格（座號/姓名/每週/平均/查看詳情按鈕） ----------
  let tableHTML = `
    <h4 class="mt-4">📋 ${className} 班學生成績</h4>
    <table class="table table-bordered table-striped">
      <thead>
        <tr>
          <th>座號</th>
          <th>姓名</th>
          ${allWeeks.map(w => `<th>第${w}週</th>`).join('')}
          <th>平均</th>
          <th>操作</th>
        </tr>
      </thead><tbody>
  `;

  studentKeys.forEach(studentKey => {
    const info = byStudent[studentKey];
    const arr = studentDatas[studentKey];
    let total = 0, cnt=0;
    tableHTML += `<tr><td>${info.number}</td><td>${info.name}</td>`;
    arr.forEach(v => {
      if (v != null && !isNaN(v)) { total += v; cnt++; tableHTML += `<td>${v}</td>`; }
      else tableHTML += `<td>-</td>`;
    });
    const avg = cnt>0 ? (total/cnt).toFixed(1) : '-';
    tableHTML += `<td>${avg}</td>`;
    // button 帶 studentKey 與 className
    tableHTML += `<td><button class="btn btn-outline-primary btn-sm" onclick="requestStudentDetail('${className}', ${info.number}, '${info.name.replace(/'/g,"\\'")}')">查看詳情</button></td>`;
    tableHTML += `</tr>`;
  });

  tableHTML += `</tbody></table>`;
  document.getElementById('recordsTable').innerHTML = tableHTML;
}

// 前端請求學生概況（週次列表）
function requestStudentDetail(className, number, name) {
  // 先向 server 要該學生各週分數
  socket.emit('getStudentDetail', { className, number });

  socket.off('studentDetail');
  socket.on('studentDetail', (res) => {
    if (!res.success) {
      document.getElementById('classStats').innerHTML = `<div class="alert alert-danger">讀取學生週次失敗</div>`;
      return;
    }
    // res.data => [{week, score}, ...]
    renderStudentDetailSelector(className, number, name, res.data);
  });
}

// 呈現學生各週清單並可點選某週查看詳題
function renderStudentDetailSelector(className, number, name, weeksArray) {
  const container = document.getElementById('classStats');
  const weeks = (weeksArray || []).map(r => r.week).sort((a,b)=>Number(a)-Number(b));
  let html = `
    <h4 class="mb-3">👩‍🎓 ${className}班 ${number}號 ${name} ｜ 作答詳情</h4>
    <div class="mb-3">
      <button class="btn btn-secondary btn-sm" onclick="renderClassStatsFromRows('${className}', currentClassRawRows)">返回班級統計</button>
    </div>
  `;
  if (!weeks.length) {
    html += `<div class="alert alert-warning">尚未作答任何題目。</div>`;
    container.innerHTML = html;
    return;
  }

  html += `
    <div class="mb-3">
      <label><strong>選擇週次：</strong></label>
      <select id="studentWeekSelect" class="form-select" onchange="requestStudentWeekDetail('${className}', ${number}, '${name.replace(/'/g,"\\'")}', this.value)">
        <option value="">請選擇週次</option>
        ${weeks.map(w => `<option value="${w}">第 ${w} 週</option>`).join('')}
      </select>
    </div>
    <div id="studentWeekDetail"></div>
  `;
  container.innerHTML = html;
}

// 請求某學生某週的完整題目紀錄
function requestStudentWeekDetail(className, number, name, week) {
  if (!week) {
    document.getElementById('studentWeekDetail').innerHTML = '';
    return;
  }

  socket.emit('getStudentWeekDetail', { className, number, week });

  socket.off('studentWeekDetail');
  socket.on('studentWeekDetail', (res) => {
    if (!res.success) {
      document.getElementById('studentWeekDetail').innerHTML = `<div class="alert alert-danger">讀取此週資料失敗</div>`;
      return;
    }
    if (!res.data) {
      document.getElementById('studentWeekDetail').innerHTML = `<div class="alert alert-info">尚無此週作答資料。</div>`;
      return;
    }

    // res.data.meta + res.data.items (items array of 21 objects)
    renderStudentWeekDetail(res.data.meta, res.data.items);
  });
}

function renderStudentWeekDetail(meta, items) {
  const detailDiv = document.getElementById('studentWeekDetail');
  const correctCount = items.filter(i => i.correct).length;
  let html = `
    <div class="card mb-3 shadow-sm">
      <div class="card-body">
        <h5 class="card-title">第 ${meta.week} 週（${correctCount}/${items.length} 題正確） — 分數：${meta.score ?? '-'}</h5>
  `;
  html += items.map((q, i) => `
    <div class="border rounded p-2 mb-2">
      <strong>第 ${i+1} 題：</strong> ${q.question || '(題目未儲存)'}<br>
      學生答案：${q.studentAnswer ? q.studentAnswer : "<span class='text-muted'>未作答</span>"}<br>
      ${q.correct ? "<span class='text-success'>✅ 正確</span>" : "<span class='text-danger'>❌ 錯誤</span>"}
    </div>
  `).join('');
  html += `</div></div>`;
  detailDiv.innerHTML = html;
}
