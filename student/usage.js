// usage.js
const socket = io({
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});

// 取得學生資訊
const currentStudent = JSON.parse(localStorage.getItem("studentInfo"));
if (!currentStudent) window.location.href = "login.html";

// 記錄登入開始時間（每次頁面載入都從 local 計）
const startTime = Date.now();
sessionStorage.setItem('isLoggedIn', 'true');

// 換頁前：標記要換頁（讓伺服器可以標 isSwitching）
window.addEventListener('beforeunload', () => {
  socket.emit('pageSwitch', { className: currentStudent.class, number: currentStudent.number });
  // 也儲存一個短暫 flag（備援）
  sessionStorage.setItem('pageSwitchPending', 'true');
});

// 真正離站時：pagehide（可在手機/桌機上觸發）
window.addEventListener('pagehide', () => {
  if (sessionStorage.getItem('isLoggedIn') !== 'true') return;
  const duration = Math.floor((Date.now() - startTime) / 1000);
  socket.emit('studentLogout', { className: currentStudent.class, number: currentStudent.number, duration });
  sessionStorage.setItem('isLoggedIn', 'false');
});

// 當 socket 連上時：主動告訴伺服器我是誰（reconnect 或第一次）
socket.on('connect', () => {
  console.log('✅ socket connect', socket.id);
  // 優先用 reconnect 事件，若 server 端找不到 session 會回 false
  socket.emit('studentReconnect', { className: currentStudent.class, number: currentStudent.number });
});

// 伺服器有回應 reconnectResult 的情況可以在 client logs 診斷是否成功
socket.on('reconnectResult', (res) => {
  if (res && res.success) {
    console.log('✅ reconnect 成功:', res.key);
    // 若前一頁有 pageSwitchPending flag，移除
    sessionStorage.removeItem('pageSwitchPending');
  } else {
    console.warn('⚠️ reconnect 失敗，需要重新登入');
    // 如果要強制重新登入，可取消 localStorage
    // localStorage.removeItem('studentInfo');
    // window.location.href = 'login.html';
  }
});

socket.on('disconnect', () => console.log('⚠️ socket disconnect'));
