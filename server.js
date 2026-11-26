const express = require("express");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const app = express();

// 1. НАСТРОЙКА CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const envOrigin = (process.env.FRONTEND_URL || "").trim().replace(/\/+$/, "");

  if (origin === "https://netlify.app" || (envOrigin && origin === envOrigin)) {
    res.header("Access-Control-Allow-Origin", origin);
  } else {
    res.header("Access-Control-Allow-Origin", envOrigin || "*");
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
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

// 3. ПОРТ ИЗ RAILWAY ИЛИ 8000 ПО УМОЛЧАНИЮ
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Бэкенд запущен на порту ${PORT}`);
});
