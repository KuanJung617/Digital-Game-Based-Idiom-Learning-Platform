// 讀取 .env
require('dotenv').config();

// 套件
const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const axios = require('axios');
const {
    Server
} = require('socket.io');

const app = express();

/* 1) 環境變數 */
const PORT = Number(process.env.PORT || 3000);
const DB_PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306;

/* 2) MySQL 連線池（promise 介面） */
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
}).promise();

/* 3) 中介軟體 */
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({
    extended: true
}));
app.use(express.static(path.join(__dirname, 'public')));

/* 4) 郵件設定（目前未用到，保留） */
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465, // 465 使用 TLS
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

/* 5) 路由 */
app.get('/testweb', (_req, res) => res.json({
    ok: true
}));

// 首頁
app.get('/', (_req, res) => {
    // 確保 public/home.html 存在
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});


/* 6) HTTPS 憑證 */
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, 'privkey.pem');
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, 'cert.pem');
const SSL_CA_PATH = process.env.SSL_CA_PATH || path.join(__dirname, 'chain.pem');

const credentials = {
    key: fs.readFileSync(SSL_KEY_PATH, 'utf8'),
    cert: fs.readFileSync(SSL_CERT_PATH, 'utf8'),
    ca: fs.readFileSync(SSL_CA_PATH, 'utf8'),
};

/* 7) 建立 HTTPS Server + 綁定 Socket.IO */
const server = https.createServer(credentials, app);

const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
    },
});

/* ===================================================
   🎲 雙人擲骰子對戰遊戲邏輯
   =================================================== */
let waitingPlayer = null;   // 等待配對的玩家
let rooms = {};             // roomId -> { players: [], turn: 0, scores: {}, currentQuestion: null }

io.on('connection', (socket) => {
    console.log('✅ 用戶已連線:', socket.id);
    // 直接查詢並回傳全部結果
    socket.on('searchChengyuOpen', async () => {
        try {
            // 若需要固定順序可加 ORDER BY id
            const [rows] = await db.query('SELECT * FROM idioms');
            socket.emit('searchResultInit', rows); // 直接把結果丟回去
        } catch (err) {
            console.error('searchChengyuOpen error:', err);
            // 保持你的介面：錯誤時回傳 null（或你也可改成 []）
            socket.emit('searchResultInit', null);
            // 可選：另外補一個錯誤事件
            socket.emit('searchResultError', {
                message: err?.message || 'Unknown error'
            });
        }
    });
	//成語個別查詢
	socket.on('chengyuWord', async (word = '') => {
	  try {
		const q = word.trim();
		if (!q) return socket.emit('chengyuWordResult', null);

		const [rows] = await db.execute(
		  `SELECT id, idiom, zhuyin, meaning, usage_category, usage_example,usage_semantics, near_synonyms, opposite_idioms
		   FROM idioms WHERE idiom = ? LIMIT 1`,
		  [q]
		);
		socket.emit('chengyuWordResult', rows[0] || null);
	  } catch (err) {
		console.error('chengyuWord error:', err);
		socket.emit('chengyuWordResult', null);
	  }
	});
	//語音撥放功能
	socket.on('ttsWord', async (word = '') => {
	  try {
		if (!word.trim()) return socket.emit('ttsWordError', '空字串');

		const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=zh-TW&client=tw-ob&q=${encodeURIComponent(word)}`;
		const resp = await axios.get(url, { responseType: 'arraybuffer' });
		const base64 = Buffer.from(resp.data).toString('base64');

		socket.emit('ttsWordResult', { data: base64, mime: 'audio/mpeg' });
	  } catch (err) {
		console.error('TTS 錯誤:', err?.message || err);
		socket.emit('ttsWordError', 'TTS 產生失敗');
	  }
	});
	//加入教學任務功能
	socket.on('addToTeachingTask', async (word = '') => {
	  const idiom = String(word || '').trim();
	  if (!idiom) return socket.emit('addToTeachingTaskResult', { ok: false, message: 'empty word' });

	  try {
		// 若未建立唯一索引，可先查一次避免重複
		const [exist] = await db.execute('SELECT id FROM TeachingTask WHERE idiom = ? LIMIT 1', [idiom]);
		if (exist.length) {
		  return socket.emit('addToTeachingTaskResult', { ok: true, duplicate: true, id: exist[0].id, idiom });
		}

		const [res] = await db.execute(
		  'INSERT INTO TeachingTask (idiom, status) VALUES (?, ?)',
		  [idiom, 1] // status: 0=未處理（可依你系統定義）
		);
		socket.emit('addToTeachingTaskResult', { ok: true, id: res.insertId, idiom });
	  } catch (err) {
		// 若有唯一索引，重複會拋 ER_DUP_ENTRY
		if (err?.code === 'ER_DUP_ENTRY') {
		  return socket.emit('addToTeachingTaskResult', { ok: true, duplicate: true, idiom });
		}
		console.error('addToTeachingTask error:', err);
		socket.emit('addToTeachingTaskResult', { ok: false, message: err?.message || 'DB error' });
	  }
	});
	socket.on("stroke_count",async (stroke_count)=>{
		try {
            // 若需要固定順序可加 ORDER BY id
			if(stroke_count == ""){
				const [rows] = await db.query('SELECT * FROM idioms');
				socket.emit('stroke_count_Result', rows); // 直接把結果丟回去
			}
			else{
				const [rows] = await db.query('SELECT * FROM idioms WHERE stroke_count=?',[stroke_count]);
				socket.emit('stroke_count_Result', rows); // 直接把結果丟回去
			}
        } catch (err) {
            console.error('stroke_count_Result error:', err);
            // 保持你的介面：錯誤時回傳 null（或你也可改成 []）
            socket.emit('stroke_count_Result', []);
        }
		
	});
	socket.on('searchChengyu', async ({ word } = {}) => {
      try {
        if (!word) {
          socket.emit('searchResult', { word, meaning: null });
          return;
        }
        const [rows] = await db.execute(
          'SELECT meaning, zhuyin, source_title, usage_example FROM idioms WHERE idiom = ? LIMIT 1',
          [word]
        );
        const row = rows?.[0];
        socket.emit('searchResult', {
          word,
          meaning: row?.meaning || null,
          zhuyin: row?.zhuyin || null,
          source_title: row?.source_title || null,
          usage_example: row?.usage_example || null
        });
      } catch (err) {
        console.error('searchChengyu error:', err);
        socket.emit('searchResult', { word, meaning: null });
      }
    });
	socket.on("taskPageInit", async ()=>{
		try {
            // 若需要固定順序可加 ORDER BY id
            const [rows] = await db.execute('SELECT * FROM TeachingTask WHERE status =1 and week is null');
            socket.emit('taskPageInitResult', rows); 
        } catch (err) {
            console.error('taskPageInitResult error:', err);
            // 保持你的介面：錯誤時回傳 null（或你也可改成 []）
            socket.emit('taskPageInitResult', []);
        }
		
	});
	// payload = { week, ids, idioms, unsetIds, unsetIdioms }
socket.on('saveTask', async (payload = {}) => {
  let {
    week = 0,
    ids = [],
    idioms = [],
    unsetIds = [],
    unsetIdioms = []
  } = payload;

  // 驗證與清洗
  if (!Number.isInteger(week) || week <= 0) {
    return socket.emit('saveTaskResult', { ok: false, message: '週次不合法' });
  }

  const _ids         = Array.isArray(ids)        ? ids.map(Number).filter(Number.isFinite) : [];
  const _idioms      = Array.isArray(idioms)     ? idioms.map(String).filter(Boolean)      : [];
  let _unsetIds      = Array.isArray(unsetIds)   ? unsetIds.map(Number).filter(Number.isFinite) : [];
  let _unsetIdioms   = Array.isArray(unsetIdioms)? unsetIdioms.map(String).filter(Boolean)      : [];

  // 若同一筆同時出現在「設週次」與「還原 null」，優先以「設週次」為主，從 unset 中移除
  if (_ids.length)      _unsetIds    = _unsetIds.filter(x => !_ids.includes(x));
  if (_idioms.length)   _unsetIdioms = _unsetIdioms.filter(s => !_idioms.includes(s));

  if (_ids.length === 0 && _idioms.length === 0 && _unsetIds.length === 0 && _unsetIdioms.length === 0) {
    return socket.emit('saveTaskResult', { ok: false, message: '沒有可更新的項目' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    let updated = 0; // 設為指定 week 的筆數
    let unset   = 0; // 設回 NULL 的筆數

    // 工具：動態產生 ?,?,?,...
    const marks = (n) => Array.from({ length: n }, () => '?').join(',');

    // 1) 以 id 設定 week
    if (_ids.length) {
      const sql = `UPDATE TeachingTask SET week = ? WHERE id IN (${marks(_ids.length)})`;
      const params = [week, ..._ids];
      const [ret] = await conn.execute(sql, params);
      updated += ret.affectedRows || 0;
    }

    // 2) 以 idiom 設定 week
    if (_idioms.length) {
      const sql = `UPDATE TeachingTask SET week = ? WHERE idiom IN (${marks(_idioms.length)})`;
      const params = [week, ..._idioms];
      const [ret] = await conn.execute(sql, params);
      updated += ret.affectedRows || 0;
    }

    // 3) 被刪除：以 id 設為 NULL
    if (_unsetIds.length) {
      const sql = `UPDATE TeachingTask SET week = NULL WHERE id IN (${marks(_unsetIds.length)})`;
      const params = [..._unsetIds];
      const [ret] = await conn.execute(sql, params);
      unset += ret.affectedRows || 0;
    }

    // 4) 被刪除：以 idiom 設為 NULL
    if (_unsetIdioms.length) {
      const sql = `UPDATE TeachingTask SET week = NULL WHERE idiom IN (${marks(_unsetIdioms.length)})`;
      const params = [..._unsetIdioms];
      const [ret] = await conn.execute(sql, params);
      unset += ret.affectedRows || 0;
    }

    await conn.commit();
    return socket.emit('saveTaskResult', { ok: true, updated, unset, week });
  } catch (err) {
    await conn.rollback();
    console.error('saveTaskResult error:', err);
    return socket.emit('saveTaskResult', { ok: false, message: err?.message || 'DB error' });
  } finally {
    conn.release();
  }
});

socket.on("taskPageSeearch",async (week)=>{
	try{
		const [rows] = await db.query('SELECT * FROM TeachingTask WHERE week = ?',[week]);
        socket.emit('taskPageInitResult', rows); 

	}catch(err){
		console.error('taskPageInitResult error:', err);
        // 保持你的介面：錯誤時回傳 null（或你也可改成 []）
        socket.emit('taskPageInitResult', []);
	}
	
});
socket.on("quizInit", async () => {
  try {
    const [rows] = await db.query(`
      SELECT
        tk.week,
        i.idiom,
        i.meaning,
        qg.id AS group_id,
        mcq.title   AS mcq_title,
        mcq.options_json AS mcq_options_json,
        mcq.answer  AS mcq_answer,
        tf.title    AS tf_title,
        tf.answer   AS tf_answer,
        op.title    AS open_title
      FROM TeachingTask AS tk
      INNER JOIN idioms AS i
        ON i.idiom COLLATE utf8mb4_unicode_ci = tk.idiom COLLATE utf8mb4_unicode_ci
      LEFT JOIN QuizGroup AS qg
        ON qg.week COLLATE utf8mb4_unicode_ci = tk.week COLLATE utf8mb4_unicode_ci
           AND qg.idiom COLLATE utf8mb4_unicode_ci = tk.idiom COLLATE utf8mb4_unicode_ci
      LEFT JOIN QuizMCQ AS mcq
        ON mcq.group_id = qg.id
      LEFT JOIN QuizTF AS tf
        ON tf.group_id = qg.id
      LEFT JOIN QuizOpen AS op
        ON op.group_id = qg.id
      WHERE tk.status = 1
        AND tk.week IS NOT NULL
      ORDER BY tk.week, tk.id;
    `);

    socket.emit('quizInitResult', rows);
  } catch (err) {
    console.error('quizInitResult error:', err);
    socket.emit('quizInitResult', []);
  }
});

function normalizeOptions(opts) {
  if (Array.isArray(opts)) return opts.map(s => String(s).trim()).filter(Boolean);
  return String(opts ?? '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

socket.on('quizSave', async (payload = {}) => {
  const { week, items } = payload || {};
  if (!Number.isInteger(week) || week <= 0) {
    return socket.emit('quizSaveResult', { ok: false, message: '週次不合法' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return socket.emit('quizSaveResult', { ok: false, message: '沒有可儲存的題組' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    let saved = 0;

    for (const raw of items) {
      const idiom = String(raw?.idiom || '').trim();
      if (!idiom) continue;

      // 1) 取得／建立題組 id（同週＋同成語唯一）
      const [ins] = await conn.execute(
        `INSERT INTO QuizGroup (week, idiom)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
           id = LAST_INSERT_ID(id), updated_at = CURRENT_TIMESTAMP`,
        [week, idiom]
      );
      const groupId = ins.insertId;
      if (!groupId) continue;

      // 2) 先清空子表（最簡單安全）
      await conn.execute(`DELETE FROM QuizMCQ WHERE group_id = ?`, [groupId]);
      await conn.execute(`DELETE FROM QuizTF  WHERE group_id = ?`, [groupId]);
      await conn.execute(`DELETE FROM QuizOpen WHERE group_id = ?`, [groupId]);

      // 3) 寫入 MCQ
      const mcqTitle   = String(raw?.mcq?.title || '');
      const mcqOptions = normalizeOptions(raw?.mcq?.options);
      const mcqAnswer  = String(raw?.mcq?.answer || '');
      await conn.execute(
        `INSERT INTO QuizMCQ (group_id, title, options_json, answer)
         VALUES (?, ?, ?, ?)`,
        [groupId, mcqTitle, JSON.stringify(mcqOptions), mcqAnswer]
      );

      // 4) 寫入 TF（answer 允許空：預覽不互動）
      const tfTitle  = String(raw?.tf?.title || '');
      const tfAnswer = (typeof raw?.tf?.answer === 'boolean') ? (raw.tf.answer ? 1 : 0) : null;
      await conn.execute(
        `INSERT INTO QuizTF (group_id, title, answer) VALUES (?, ?, ?)`,
        [groupId, tfTitle, tfAnswer]
      );

      // 5) 寫入 Open
      const openTitle = String(raw?.open?.title || '');
      await conn.execute(
        `INSERT INTO QuizOpen (group_id, title) VALUES (?, ?)`,
        [groupId, openTitle]
      );

      saved++;
    }

    await conn.commit();
    socket.emit('quizSaveResult', { ok: true, week, saved });
  } catch (err) {
    await conn.rollback();
    console.error('quizSave error:', err);
    socket.emit('quizSaveResult', { ok: false, message: err?.message || 'DB error' });
  } finally {
    conn.release();
  }
});
socket.on('quizSubmit', async (data) => {
  const { student, week, results, correctCount } = data;
  const { className, number, name } = student;

  try {
    // --- 1️⃣ 檢查是否已經繳交過 ---
    const [exist] = await db.query(
      'SELECT id FROM QuizSubmit WHERE className=? AND number=? AND week=?',
      [className, number, week]
    );

    if (exist.length > 0) {
      socket.emit('quizSubmitResult', {
        success: false,
        message: '⚠️ 您已繳交過該週的答案，不能重複提交。'
      });
      return;
    }

    // --- 2️⃣ 準備動態欄位與值 ---
    const cols = ['className', 'number', 'name', 'week', 'score'];
    const vals = [className, number, name, week, correctCount];

    // 因為你一週固定 21 題
    for (let i = 0; i < 21; i++) {
      const q = results[i];
      cols.push(`Q${i + 1}`, `Ans${i + 1}`, `RightWrong${i + 1}`, `Type${i + 1}`);

      if (q) {
        const isCorrect = q.answer && q.answer === String(q.correctAns) ? 1 : 0;
        vals.push(q.title || '', q.answer || '', isCorrect, q.type || 'mcq');
      } else {
        vals.push('', '', 0, 'mcq');
      }
    }


    // --- 3️⃣ 寫入資料庫 ---
    const sql = `
      INSERT INTO QuizSubmit (${cols.join(', ')})
      VALUES (${cols.map(() => '?').join(', ')});
    `;
    await db.query(sql, vals);

    console.log(`✅ ${className}-${number} 第${week}週 答案已寫入資料庫`);
    socket.emit('quizSubmitResult', {
      success: true,
      message: '✅ 答案已成功繳交！'
    });

  } catch (err) {
    console.error('❌ quizSubmit error:', err);
    socket.emit('quizSubmitResult', {
      success: false,
      message: '⚠️ 系統錯誤，請稍後再試。'
    });
  }
});

  // 1️⃣ 取得全部有作答紀錄的班級清單
  socket.on('getClassList', async () => {
    try {
      const [rows] = await db.query(`
        SELECT DISTINCT className FROM QuizSubmit ORDER BY className
      `);

      socket.emit('classList', {
        success: true,
        data: rows.map(r => r.className)
      });
    } catch (err) {
      console.error('getClassList error:', err);
      socket.emit('classList', { success: false });
    }
  });

  // 2️⃣ 取得整個班級所有學生的每周分數（畫圖 & 表格用）
  socket.on('getClassStats', async (className) => {
    try {
      const [rows] = await db.query(`
        SELECT className, number, name, week, score
        FROM QuizSubmit
        WHERE className = ?
        ORDER BY number, week
      `, [className]);

      socket.emit('classStats', {
        success: true,
        data: rows
      });
    } catch (err) {
      console.error('getClassStats error:', err);
      socket.emit('classStats', { success: false });
    }
  });

  // 3️⃣ 取得某學生有哪些週次（前端用來顯示下拉選單）
  socket.on('getStudentDetail', async ({ className, number }) => {
    try {
      const [rows] = await db.query(`
        SELECT week, score
        FROM QuizSubmit
        WHERE className=? AND number=?
        ORDER BY week
      `, [className, number]);

      socket.emit('studentDetail', {
        success: true,
        data: rows
      });
    } catch (err) {
      console.error('getStudentDetail error:', err);
      socket.emit('studentDetail', { success: false });
    }
  });

  // 4️⃣ 取得某週次詳細題目（21 題全部）
  socket.on('getStudentWeekDetail', async ({ className, number, week }) => {
    try {
      const [rows] = await db.query(`
        SELECT * FROM QuizSubmit
        WHERE className=? AND number=? AND week=?
        LIMIT 1
      `, [className, number, week]);

      if (rows.length === 0) {
        socket.emit('studentWeekDetail', { success: true, data: null });
        return;
      }

      const row = rows[0];

      // 打包成前端可用格式
      const meta = {
        className: row.className,
        number: row.number,
        name: row.name,
        week: row.week,
        score: row.score
      };

      const items = [];
      for (let i = 1; i <= 21; i++) {
        items.push({
          question: row[`Q${i}`] || '',
          studentAnswer: row[`Ans${i}`] || '',
          correctAnswer: row[`Type${i}`] === 'mcq'
            ? row[`correctAns${i}`] || ''
            : row[`correctAns${i}`] || '',
          correct: row[`RightWrong${i}`] === 1
        });
      }

      socket.emit('studentWeekDetail', {
        success: true,
        data: { meta, items }
      });

    } catch (err) {
      console.error('getStudentWeekDetail error:', err);
      socket.emit('studentWeekDetail', { success: false });
    }
  });

// ✅ 取得學生作答紀錄（每週一筆）
socket.on('getStudentRecords', async ({ className, number }) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM QuizSubmit 
       WHERE className = ? AND number = ?
       ORDER BY week ASC`,
      [className, number]
    );

    // 整理成簡潔格式給前端
    const formatted = rows.map(r => {
      const detail = [];
      for (let i = 1; i <= 21; i++) {
        detail.push({
          Q: r[`Q${i}`] || '',
          Ans: r[`Ans${i}`] || '',
          RightWrong: r[`RightWrong${i}`] ?? 0,
          type: r[`Type${i}`] || 'mcq'  // 帶出題型
        });
      }
      return {
        week: r.week,
        score: r.score || 0,
        submit_time: r.submit_time,
        detail
      };
    });


    socket.emit('studentRecordsResult', formatted);

  } catch (err) {
    console.error('❌ getStudentRecords error:', err);
    socket.emit('studentRecordsResult', []);
  }
});
socket.on('getFreeQuiz', async () => {
  try {
    const [rows] = await db.execute(
      `SELECT idiom, meaning FROM idioms ORDER BY RAND() LIMIT 10`
    );

    socket.emit('freeQuiz', {
      success: true,
      data: rows.map(row => ({
        idiom: row.idiom,
        chars: row.idiom,
        meaning: row.meaning || ''
      }))
    });
  } catch (err) {
    console.error('getFreeQuiz error:', err);
    socket.emit('freeQuiz', {
      success: false,
      message: '資料庫錯誤'
    });
  }
});
//學生登入功能
 socket.on('studentLogin', async (payload = {}) => {
    const { className, number } = payload; // 不做驗證，直接寫入
    try {
		const [rows] = await db.query('select * from students where class =? and number = ?',
		[className, number]);
		if(rows.length  >=1){
			await db.execute(
        'INSERT INTO loginDB (className, number) VALUES (?, ?)',
        [className, number]
      );
      socket.emit('studentLoginResult', true);   // ✅ 成功
		}else{
			console.error('studentLogin insert error:', err);
			socket.emit('studentLoginResult', false);  // ❌ 失敗
		}
      
    } catch (err) {
      console.error('studentLogin insert error:', err);
      socket.emit('studentLoginResult', false);  // ❌ 失敗
    }
  });
  socket.on('presence:mark', async ({ room } = {}) => {
  try {
    // 從登入時你存的 socket.data.student 取 class/number
    const cls = socket.data?.student?.className;
    const no  = socket.data?.student?.number;
    if (!cls || !no) return; // 尚未登入就忽略
    await logPresence(db, { className: cls, number: no, room: room ?? null });
    // 可選：回覆成功與否
    // socket.emit('presence:mark:ok');
  } catch (e) {
    console.error('presence:mark error:', e);
  }
});
 socket.on('studentHomeInit', async ({ className, number, room } = {}) => {
  try {
    // upsert 存在狀態
    await db.execute(
      `INSERT INTO student_presence (className, number, space_code)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         space_code = VALUES(space_code),
         last_seen  = CURRENT_TIMESTAMP`,
      [className, number, room || null]
    );

    // 取學生姓名（若有）
    const [rows] = await db.execute(
      'SELECT `name` FROM `students` WHERE `class` = ? AND `number` = ? LIMIT 1',
      [className, number]
    );
    const name = rows?.[0]?.name ?? null;

    // 存在 socket 供 disconnect/其他事件使用
    socket.data.student = { className, number, name };
    await logPresence(db, { className, number, room: room || 'studentHome' }); // ← 寫入足跡

    // 回傳給前端，前端會更新抬頭與 sessionStorage
    socket.emit('studentHomeInitResult', { ok: true, name });
  } catch (err) {
    console.error('studentHomeInit error:', err);
    socket.emit('studentHomeInitResult', { ok: false, message: 'DB error' });
  }
});
 // 單題作答結果
  socket.on('idiomGameAnswer', async (payload = {}) => {
      try {
        const stu = payload.student || socket.data.student || {};
        const { index, idiom, userAnswer, correct } = payload;

        await db.execute(
          `INSERT INTO idiom_game_answers
           (className, number, name, question_index, idiom, user_answer, is_correct)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            stu.className || null,
            stu.number || null,
            stu.name || null,
            index || null,
            idiom || null,
            userAnswer || null,
            correct ? 1 : 0
          ]
        );

        await logFootprint(db, {
          className: stu.className,
          number: stu.number,
          name: stu.name,
          action: correct ? 'answer_correct' : 'answer_wrong',
          detail: { index, idiom, userAnswer }
        });

        socket.emit('idiomGameAnswerSaved', {
          ok: true,
          index,
          correct: !!correct
        });
      } catch (err) {
        console.error('idiomGameAnswer error:', err);
        socket.emit('idiomGameAnswerSaved', { ok: false });
      }
    });

  // 全部結束的總結 (可選)
    socket.on('idiomGameSummary', async (payload = {}) => {
      try {
        const stu = payload.student || socket.data.student || {};
        const stats = payload.stats || {};

        await db.execute(
          `INSERT INTO idiom_game_summary
           (className, number, name, correct_count, total_count, wrong_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            stu.className || null,
            stu.number || null,
            stu.name || null,
            stats.correct ?? 0,
            stats.total ?? 0,
            JSON.stringify(stats.wrong || [])
          ]
        );

        await logFootprint(db, {
          className: stu.className,
          number: stu.number,
          name: stu.name,
          action: 'game_finished',
          detail: stats
        });
      } catch (err) {
        console.error('idiomGameSummary error:', err);
      }
    });

 socket.on('idiomGameInit', async ({ className, number, name, room, gameMode, space } = {}) => {
      try {
        // upsert presence
        await db.execute(
          `INSERT INTO student_presence (className, number, space_code)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE
             space_code = VALUES(space_code),
             last_seen  = CURRENT_TIMESTAMP`,
          [className || null, number || null, space || 'idiomPuzzle']
        );

        // 沒帶名字就補
        let finalName = name;
        if (!finalName) {
          finalName = await getStudentName(db, className, number);
        }

        // 存 socket.data
        socket.data.student = {
          className: className || null,
          number: number || null,
          name: finalName || null,
          room: room || null,
          gameMode: gameMode || null
        };

        // 寫入足跡
        await logFootprint(db, {
          className,
          number,
          name: finalName,
          action: 'enter_idiom_game',
          detail: { room: room || null, gameMode: gameMode || null }
        });

        socket.emit('idiomGameInitResult', { ok: true, name: finalName });
      } catch (err) {
        console.error('idiomGameInit error:', err);
        socket.emit('idiomGameInitResult', { ok: false, message: 'DB error' });
      }
    });
	 socket.on('getWeekQuiz', async ({ week } = {}) => {
      try {
        if (!week) {
          socket.emit('weekQuiz', {
            success: false,
            message: '週次未指定',
            data: []
          });
          return;
        }

        // 先抓 TeachingTask
        const [tasks] = await db.execute(
          'SELECT idiom FROM TeachingTask WHERE status = 1 AND week = ?',
          [week]
        );

        if (!tasks.length) {
          socket.emit('weekQuiz', {
            success: true,
            data: [], // 沒題目也回成功，前端自己顯示
            message: '此週沒有啟動的成語'
          });
          return;
        }

        // 把成語字串取出
        const idiomList = tasks
          .map(r => String(r.idiom || '').trim())
          .filter(x => x.length > 0);

        // 去 idioms 表撈詳細資料（一次撈）
        // NOTE: idioms.idiom 是 text，所以用 IN 會有點醜，要改成 varchar 比較好
        // 這裡示範用 OR 方式動態拼
        let idiomsDetailMap = {};
        if (idiomList.length) {
          const placeholders = idiomList.map(() => '?').join(',');
          const [rows] = await db.execute(
            `SELECT idiom, meaning, zhuyin, difficulty
             FROM idioms
             WHERE idiom IN (${placeholders})`,
            idiomList
          );
          // 做成 map
          rows.forEach(row => {
            idiomsDetailMap[row.idiom] = row;
          });
        }

        // 組回前端要的格式
        const data = idiomList.map(idm => {
          const detail = idiomsDetailMap[idm] || {};
          return {
            idiom: idm,
            chars: idm.split(''),
            meaning: detail.meaning || null,
            zhuyin: detail.zhuyin || null,
            difficulty: detail.difficulty || null
          };
        });

        socket.emit('weekQuiz', {
          success: true,
          data
        });
      } catch (err) {
        console.error('getWeekQuiz error:', err);
        socket.emit('weekQuiz', { success: false, data: [] });
      }
    });
  // 成語遊戲的細部足跡
  socket.on('idiomGameFootprint', async (payload = {}) => {
      try {
        const stu = payload.student || socket.data.student || {};
        await logFootprint(db, {
          className: stu.className,
          number: stu.number,
          name: stu.name,
          action: payload.action || 'unknown',
          detail: {
            ...payload.detail,
            index: payload.index,
            room: stu.room || null
          }
        });
      } catch (err) {
        console.error('idiomGameFootprint error:', err);
      }
    });
socket.on('studentsearchChengyu', async (word = '') => {

  try {
	 const [rows] = await db.execute('SELECT * FROM idioms WHERE idiom LIKE ?', [`%${word}%`]);
     socket.emit('studentsearchChengyuResult', rows); 
	console.log(rows.length);
    socket.emit('studentsearchChengyuResult', rows);
  } catch (err) {
    console.error('studentsearchChengyuResult error:', err);
    socket.emit('studentsearchChengyuResult', []);
  }
});
  socket.on('studentttsWord', async (word = '') => {
    const text = String(word || '').trim();
    if (!text) return socket.emit('ttsWordResult', null);

    const ttsURL = `https://translate.google.com/translate_tts?ie=UTF-8&tl=zh-TW&client=tw-ob&q=${encodeURIComponent(text)}`;
    try {
      const { data } = await axios.get(ttsURL, { responseType: 'arraybuffer' });
      socket.emit('studentttsWordResult', data);       // 回傳 audio/mpeg 位元組
    } catch (err) {
      console.error('TTS error:', err);
      socket.emit('studentttsWordResult', null);
    }
  });
  socket.on('studentTeachingInit', async () => {
  try {
    const [rows] = await db.execute(`
      SELECT
        t.id AS task_id, t.week,
        i.idiom, i.zhuyin, i.meaning, i.usage_category, i.usage_example,
        i.near_synonyms, i.opposite_idioms
      FROM TeachingTask t
      JOIN idioms i ON i.idiom = t.idiom
      WHERE t.status = 1 AND t.week IS NOT NULL
      ORDER BY t.week, t.id
    `);
    socket.emit('studentTeachingInitResult', rows);
  } catch (err) {
    console.error('studentTeachingInitResult error:', err);
    socket.emit('studentTeachingInitResult', []);
  }
});
socket.on('studentTeachingWeeks', async () => {
  try {
    const [rows] = await db.execute(
      `SELECT DISTINCT week FROM TeachingTask WHERE status=1 AND week IS NOT NULL ORDER BY week`
    );
    socket.emit('studentTeachingWeeksResult', rows.map(r => Number(r.week)).filter(Boolean));
  } catch (e) {
    console.error('studentTeachingWeeks error:', e);
    socket.emit('studentTeachingWeeksResult', []);
  }
});
socket.on('initStudentrom',async (cls,no,room)=>{
	console.log(cls,no,room);
	try {
    // upsert 存在狀態
    await db.execute(
      `INSERT INTO student_presence (className, number, space_code)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         space_code = VALUES(space_code),
         last_seen  = CURRENT_TIMESTAMP`,
      [cls, no, room || null]
    );

    // 取學生姓名（若有）
    const [rows] = await db.execute(
      'SELECT `name` FROM `students` WHERE `class` = ? AND `number` = ? LIMIT 1',
      [cls, no]
    );
    const name = rows?.[0]?.name ?? null;

    // 存在 socket 供 disconnect/其他事件使用
    socket.data.student = { cls, no, name };
    await logPresence(db, { className: cls, number: no, room: room ?? null });

    // 回傳給前端，前端會更新抬頭與 sessionStorage
    socket.emit('initStudentromResult', { ok: true, name });
  } catch (err) {
    console.error('studentHomeInit error:', err);
    socket.emit('initStudentromResult', { ok: false, message: 'DB error' });
  }
});
socket.on('initStudentgames',async (cls,no,room)=>{

	try {
    // upsert 存在狀態
    await db.execute(
      `INSERT INTO student_presence (className, number, space_code)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         space_code = VALUES(space_code),
         last_seen  = CURRENT_TIMESTAMP`,
      [cls, no, room || null]
    );

    // 取學生姓名（若有）
    const [rows] = await db.execute(
      'SELECT `name` FROM `students` WHERE `class` = ? AND `number` = ? LIMIT 1',
      [cls, no]
    );
    const name = rows?.[0]?.name ?? null;

    // 存在 socket 供 disconnect/其他事件使用
    socket.data.student = { cls, no, name };
    await logPresence(db, { className: cls, number: no, room: room ?? null });

    // 回傳給前端，前端會更新抬頭與 sessionStorage
    socket.emit('initStudentgamesResult', { ok: true, name });
  } catch (err) {
    console.error('initStudentgamesResult error:', err);
    socket.emit('initStudentgamesResult', { ok: false, message: 'DB error' });
  }
});
// 請求教師指定的題庫資料
  socket.on('studentTeachingInit', async () => {
    try {
      const [rows] = await db.execute(
        `SELECT * FROM TeachingTask t
         INNER JOIN idioms i ON t.idiom = i.idiom
         WHERE t.status = 1 AND t.week IS NOT NULL`
      );
      socket.emit('studentTeachingInitResult', rows);  // 返回題庫資料給前端
    } catch (err) {
      console.error('Error fetching teacher-specific tasks:', err);
      socket.emit('studentTeachingInitResult', []);
    }
  });

  // 請求學生選擇的週次資料
  socket.on('getTeachingTasksByWeek', async (week) => {
    try {
      const [rows] = await db.execute(
        `SELECT * FROM TeachingTask t
         INNER JOIN idioms i ON t.idiom = i.idiom
         WHERE t.status = 1 AND t.week = ?`, [week]
      );
      socket.emit('teachingTasksByWeekResult', rows);
    } catch (err) {
      console.error('Error fetching tasks by week:', err);
      socket.emit('teachingTasksByWeekResult', []);
    }
  });


/* ===================================================
   🎲 雙人擲骰子對戰遊戲邏輯
   =================================================== */
/* ====== 加入配對佇列 ====== */
socket.on("joinQueue", ({ playerName }) => {
  if (!waitingPlayer) {
    waitingPlayer = { id: socket.id, name: playerName };
    socket.emit("waiting", "等待另一位玩家加入...");
  } else {
    // ✅ 成功配對
    const roomId = `room-${waitingPlayer.id}-${socket.id}`;
    const players = [waitingPlayer, { id: socket.id, name: playerName }];

    rooms[roomId] = {
      players,
      turn: 0,
      scores: { [players[0].id]: 0, [players[1].id]: 0 },
      currentQuestion: null
    };

    players.forEach(p => io.to(p.id).socketsJoin(roomId));
    io.to(roomId).emit("matchSuccess", roomId, players);

    // 🟢 初始回合通知
    updateTurn(roomId);

    waitingPlayer = null;
    console.log(`✅ 配對完成: ${players[0].name} vs ${players[1].name}`);
  }
});

socket.on("rollDice", async () => {
  const roomId = findRoomByPlayer(socket.id);
  if (!roomId) return;
  const room = rooms[roomId];

  // ✅ 確認輪到自己
  if (room.players[room.turn].id !== socket.id) {
    socket.emit("notYourTurn");
    return;
  }

  // ✅ 防止重複擲骰
  if (room.isRolling) return;
  room.isRolling = true;

  try {
    // 🎲 擲骰決定題型
    const diceNum = Math.floor(Math.random() * 3) + 1;
    const type = diceNum === 1 ? "image" : diceNum === 2 ? "choice" : "text";

    const q = await makeQuestion(type);
    if (!q) {
      io.to(roomId).emit("showQuestion", { question: "⚠️ 題庫讀取失敗，請稍後再試。" });
      return;
    }

    room.currentQuestion = q;
    io.to(roomId).emit("showQuestion", { ...q, diceType: type });
  } catch (err) {
    console.error("rollDice error:", err);
    socket.emit("showQuestion", { question: "⚠️ 題目生成錯誤！" });
  } finally {
    room.isRolling = false;
  }
});



/* ====== 搶答 ====== */
socket.on("buzzIn", () => {
  const roomId = findRoomByPlayer(socket.id);
  if (!roomId) return;
  io.to(roomId).emit("playerBuzzed", { playerId: socket.id });
});

/* ====== 提交答案 ====== */
socket.on("submitAnswer", ({ answer }) => {
  const roomId = findRoomByPlayer(socket.id);
  if (!roomId) return;
  const room = rooms[roomId];
  if (!room.currentQuestion) return;

  const correct = String(answer).trim() === String(room.currentQuestion.answer).trim();
  if (correct) room.scores[socket.id] += 1;

  io.to(roomId).emit("answerResult", {
    playerId: socket.id,
    correct,
    scores: room.scores
  });

  // 🟢 換回合並通知
  room.turn = (room.turn + 1) % 2;
  room.currentQuestion = null;
  updateTurn(roomId);
});
  // 當學生選擇了某個遊戲時，根據選擇的遊戲載入不同頁面
  socket.on('studentGameSelect', (gameType) => {
    console.log(`Student selected game type: ${gameType}`);
    // 根據遊戲類型執行對應的邏輯，可以發送不同的資料或啟動不同的遊戲
    socket.emit('gameSelectionResult', { game: gameType });
  });
  socket.on('disconnect', () => {
    console.log('socket disconnected:', socket.id);
    console.log("❌ 玩家離線:", socket.id);
    const roomId = findRoomByPlayer(socket.id);
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
      return;
    }
    if (roomId) {
      const room = rooms[roomId];
      io.to(roomId).emit("gameOver", "對手已離開，遊戲結束。");
      delete rooms[roomId];
    }
  });
  
});

/* ====== 工具：找出玩家所屬房間 ====== */
function findRoomByPlayer(id) {
  return Object.keys(rooms).find(r => rooms[r].players.some(p => p.id === id));
}

/* ====== 更新回合狀態 ====== */
function updateTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const currentPlayer = room.players[room.turn];
  io.to(roomId).emit("updateTurn", { turnId: currentPlayer.id });
}

/* ====== 題目產生器 ====== */
async function makeQuestion(type) {
  try {
    // ------------------ 選擇題 ------------------
    if (type === "choice") {
      // 只抽有 usage_semantics 的成語
      const [rows] = await db.query(`
        SELECT idiom, usage_semantics 
        FROM idioms 
        WHERE usage_semantics IS NOT NULL AND usage_semantics != ''
        ORDER BY RAND() 
        LIMIT 1
      `);
      if (!rows.length) return null;

      const idiomObj = rows[0];
      const correct = idiomObj.usage_semantics;

      // 抽取三個其他不同意思的選項（同樣只選有意思的）
      const [others] = await db.query(`
        SELECT usage_semantics 
        FROM idioms 
        WHERE usage_semantics IS NOT NULL 
          AND usage_semantics != '' 
          AND usage_semantics != ?
        GROUP BY usage_semantics
        ORDER BY RAND()
        LIMIT 3
      `, [correct]);

      // 組合並隨機排列
      const allOptions = [correct, ...others.map(o => o.usage_semantics)];
      const options = allOptions.sort(() => Math.random() - 0.5);

      return {
        type: "choice",
        question: `成語「${idiomObj.idiom}」的意思是？`,
        options,
        answer: correct
      };
    }

    // ------------------ 填空題 ------------------
    if (type === "text") {
      const [rows] = await db.query(`
        SELECT idiom, usage_category 
        FROM idioms 
        WHERE usage_category IS NOT NULL AND usage_category != ''
        ORDER BY RAND() 
        LIMIT 1
      `);
      if (!rows.length) return null;
      const q = rows[0];
      return {
        type: "text",
        question: q.usage_category || "請寫出符合這個描述的成語",
        answer: q.idiom
      };
    }

    // ------------------ 圖片題 ------------------
    if (type === "image") {
      const imgs = [
        { src: "/student/games/guessIdiom/image/img1.png", a: "小時了了" },
        { src: "/student/games/guessIdiom/image/img2.png", a: "胸有成竹" },
        { src: "/student/games/guessIdiom/image/img3.png", a: "世外桃源" },
        { src: "/student/games/guessIdiom/image/img4.png", a: "愚公移山" },
        { src: "/student/games/guessIdiom/image/img5.png", a: "孺子可教" },
        { src: "/student/games/guessIdiom/image/img6.png", a: "入木三分" },
        { src: "/student/games/guessIdiom/image/img7.png", a: "揚眉吐氣" },
        { src: "/student/games/guessIdiom/image/img8.png", a: "三顧茅廬" },
        { src: "/student/games/guessIdiom/image/img9.png", a: "守株待兔" },
        { src: "/student/games/guessIdiom/image/img10.png", a: "自相矛盾" },
        { src: "/student/games/guessIdiom/image/img11.png", a: "河東獅吼" },
        { src: "/student/games/guessIdiom/image/img12.png", a: "江郎才盡" },
        { src: "/student/games/guessIdiom/image/img13.png", a: "杞人憂天" },
        { src: "/student/games/guessIdiom/image/img14.png", a: "伯樂相馬" },
        { src: "/student/games/guessIdiom/image/img15.png", a: "不求甚解" },
        { src: "/student/games/guessIdiom/image/img16.png", a: "東施效顰" },
        { src: "/student/games/guessIdiom/image/img17.png", a: "如魚得水" },
        { src: "/student/games/guessIdiom/image/img18.png", a: "瞻前顧後" },
        { src: "/student/games/guessIdiom/image/img19.png", a: "井底之蛙" },
        { src: "/student/games/guessIdiom/image/img20.png", a: "揠苗助長" },
        { src: "/student/games/guessIdiom/image/img21.png", a: "舉一反三" }
      ];

      const pick = imgs[Math.floor(Math.random() * imgs.length)];
      return {
        type: "image",
        question: `<img src="${pick.src}" alt="成語圖片" class="img-fluid" style="max-width:200px">`,
        answer: pick.a
      };
    }

  } catch (err) {
    console.error('makeQuestion error:', err);
    return null;
  }
}

async function logPresence(db, { className, number, room }) {
  try {
    await db.execute(
      'INSERT INTO student_presence_log (className, number, room) VALUES (?, ?, ?)',
      [String(className||'').trim(), String(number||'').trim(), room ?? null]
    );
  } catch (e) {
    console.error('logPresence error:', e);
  }
}
async function logFootprint(db, { className, number, name, action, detail }) {
  // detail 存 JSON
  await db.execute(
    `INSERT INTO student_footprints (className, number, name, action, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      className || null,
      number || null,
      name || null,
      action || null,
      JSON.stringify(detail || {})
    ]
  );
}
/* 8) 啟動服務器 */
server.listen(PORT, () => {
    console.log(`✅ 伺服器已啟動（HTTPS），埠號：${PORT}`);
});