const express = require("express");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const app = express();

// 1. НАСТРОЙКА CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Важно: роут загрузки бинарного файла БД ставим ДО express.json(), чтобы тело запроса не перехватывалось как JSON
app.post("/api/upload-db", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
  const secret = process.env.DB_DOWNLOAD_KEY || "moy_parol_123";
  if (req.query.key !== secret) {
    return res.status(403).json({ error: "Доступ запрещён: неверный пароль" });
  }
  if (!req.body || req.body.length < 100 || req.body.subarray(0, 15).toString() !== "SQLite format 3") {
    return res.status(400).json({ error: "Файл не является корректной базой SQLite" });
  }
  try {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
    fs.writeFileSync(dbPath, req.body);
    res.json({ ok: true, message: "✅ База загружена! Сервер перезапускается (подождите 5 сек)..." });
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    res.status(500).json({ error: "Ошибка записи файла: " + err.message });
  }
});

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 2. ПУТЬ К БАЗЕ SQLITE (поддерживает Volume на Railway через DB_PATH)
const dbPath = process.env.DB_PATH || path.join(__dirname, "database.sqlite");
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    login TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL,
    coins REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    trust REAL DEFAULT 50,
    raw_data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS db_sections (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Автоматический перенос данных из backup.json при первом запуске (если таблица пустая)
const count = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
if (count === 0 && fs.existsSync(path.join(__dirname, "backup.json"))) {
  const backup = JSON.parse(
    fs.readFileSync(path.join(__dirname, "backup.json"), "utf8"),
  );
  const insUser = db.prepare(
    "INSERT OR REPLACE INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insSec = db.prepare("INSERT OR REPLACE INTO db_sections VALUES (?, ?)");

  db.exec("BEGIN");
  try {
    for (const u of backup.users || []) {
      insUser.run(
        u.id,
        u.name,
        u.login,
        u.role || "Пользователь",
        u.coins || 0,
        u.balance || 0,
        u.trust || 50,
        JSON.stringify(u),
      );
    }
    for (const [k, v] of Object.entries(backup)) {
      if (k !== "users") insSec.run(k, JSON.stringify(v));
    }
    db.exec("COMMIT");
    console.log("✅ Данные из backup.json перенесены в database.sqlite!");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("Ошибка миграции:", err);
  }
}

// API: Загрузить всю базу на сайт
app.get("/api/db", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  const usersRows = db.prepare("SELECT * FROM users").all();
  const secRows = db.prepare("SELECT key, value FROM db_sections").all();
  const updateRaw = db.prepare("UPDATE users SET raw_data = ? WHERE id = ?");

  let hasDbEdits = false;
  const nowIso = new Date().toISOString();

  const users = usersRows.map((r) => {
    const u = JSON.parse(r.raw_data);

    const oldCoins = Number(u.coins) || 0;
    const newCoins = Number(r.coins) || 0;
    const oldBalance = Number(u.balance) || 0;
    const newBalance = Number(r.balance) || 0;

    let userChanged = false;

    if (newBalance !== oldBalance) {
      if (!Array.isArray(u.balanceHistory)) u.balanceHistory = [];
      u.balanceHistory.push({
        time: nowIso,
        by: "База данных",
        amount: newBalance - oldBalance,
        after: newBalance,
        reason: "Изменение напрямую в базе данных",
      });
      if (u.balanceHistory.length > 500) u.balanceHistory.shift();
      userChanged = true;
    }

    if (newCoins !== oldCoins) {
      if (!Array.isArray(u.coinsHistory)) u.coinsHistory = [];
      u.coinsHistory.push({
        time: nowIso,
        by: "База данных",
        amount: newCoins - oldCoins,
        after: newCoins,
        reason: "Изменение напрямую в базе данных",
      });
      if (u.coinsHistory.length > 500) u.coinsHistory.shift();
      userChanged = true;
    }

    u.name = r.name;
    u.login = r.login;
    u.role = r.role;
    u.coins = newCoins;
    u.balance = newBalance;
    u.trust = Number(r.trust) || 0;

    if (userChanged) {
      if (!hasDbEdits) {
        db.exec("BEGIN");
        hasDbEdits = true;
      }
      updateRaw.run(JSON.stringify(u), r.id);
    }

    return u;
  });

  if (hasDbEdits) {
    db.exec("COMMIT");
    console.log(
      "📝 Ручные изменения баланса/коинов из SQLite записаны в историю!",
    );
  }

  const result = { users };
  for (const r of secRows) {
    result[r.key] = JSON.parse(r.value);
  }
  res.json(result);
});

// API: Сохранить обновлённую базу с сайта в SQLite
app.post("/api/db", (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.users)) {
    return res.status(400).json({ error: "Некорректный формат данных" });
  }

  const delUsers = db.prepare("DELETE FROM users");
  const insUser = db.prepare(
    "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insSec = db.prepare("INSERT OR REPLACE INTO db_sections VALUES (?, ?)");

  db.exec("BEGIN");
  try {
    delUsers.run();
    for (const u of data.users) {
      insUser.run(
        u.id,
        u.name,
        u.login,
        u.role || "Пользователь",
        Number(u.coins) || 0,
        Number(u.balance) || 0,
        Number(u.trust) || 0,
        JSON.stringify(u),
      );
    }
    for (const [k, v] of Object.entries(data)) {
      if (k !== "users") insSec.run(k, JSON.stringify(v));
    }
    db.exec("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

// API: Скачать актуальный файл database.sqlite
app.get("/api/download-db", (req, res) => {
  const secret = process.env.DB_DOWNLOAD_KEY || "moy_parol_123";
  if (req.query.key !== secret) {
    return res.status(403).send("Доступ запрещён: неверный пароль");
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  res.download(dbPath, "database.sqlite");
});

// API: Полный сброс базы данных (очистка всех таблиц)
app.post("/api/reset-db", (req, res) => {
  const secret = process.env.DB_DOWNLOAD_KEY || "moy_parol_123";
  if (req.query.key !== secret) {
    return res.status(403).json({ error: "Доступ запрещён: неверный пароль" });
  }
  db.exec("DELETE FROM users; DELETE FROM db_sections;");
  res.json({ ok: true, message: "✅ База данных полностью очищена" });
});

// Веб-админка для управления базой прямо в браузере
app.get("/api/db-admin", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Управление БД</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:460px;margin:40px auto;padding:20px;background:#0f172a;color:#f8fafc}
    .card{background:#1e293b;padding:24px;border-radius:12px;border:1px solid #334155}
    input,button{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #475569;box-sizing:border-box;font-size:14px}
    input{background:#0f172a;color:#fff}
    button{background:#6366f1;color:#fff;font-weight:600;cursor:pointer;border:none;transition:0.2s}
    button:hover{background:#4f46e5}
    button.danger{background:#dc2626}
    button.danger:hover{background:#b91c1c}
    hr{border:none;border-top:1px solid #334155;margin:20px 0}
    #msg{margin-top:12px;font-size:14px;min-height:20px}
  </style></head><body>
  <div class="card">
    <h2 style="margin-top:0">🗄️ Управление SQLite базой</h2>
    <input id="key" type="password" placeholder="Пароль (из DB_DOWNLOAD_KEY)">
    <button onclick="dl()">📥 Скачать database.sqlite</button>
    <hr>
    <input id="file" type="file" accept=".sqlite,.db">
    <button onclick="ul()">📤 Загрузить изменённый database.sqlite</button>
    <hr>
    <button class="danger" onclick="rst()">🗑️ Сбросить (очистить) всю базу</button>
    <div id="msg"></div>
  </div>
  <script>
    const base = location.origin + "/api";
    const msg = document.getElementById("msg");
    const k = () => encodeURIComponent(document.getElementById("key").value);
    function dl() {
      if (!document.getElementById("key").value) return alert("Введите пароль");
      location.href = base + "/download-db?key=" + k();
    }
    async function ul() {
      const f = document.getElementById("file").files[0];
      if (!f) return alert("Выберите файл database.sqlite");
      msg.style.color = "#94a3b8";
      msg.textContent = "⏳ Загрузка файла...";
      const r = await fetch(base + "/upload-db?key=" + k(), { method: "POST", body: f });
      const d = await r.json();
      msg.style.color = r.ok ? "#4ade80" : "#f87171";
      msg.textContent = d.message || d.error;
    }
    async function rst() {
      if (!confirm("Точно удалить ВСЕ данные из базы?")) return;
      const r = await fetch(base + "/reset-db?key=" + k(), { method: "POST" });
      const d = await r.json();
      msg.style.color = r.ok ? "#4ade80" : "#f87171";
      msg.textContent = d.message || d.error;
    }
  </script></body></html>`);
});

// 3. ПОРТ ИЗ RAILWAY ИЛИ 8080 ПО УМОЛЧАНИЮ
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Бэкенд запущен на порту ${PORT}`);
});
