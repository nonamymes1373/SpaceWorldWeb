const express = require("express");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");

const app = express();

const isProd = process.env.NODE_ENV === "production";
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/[\r\n\s]+/g, "").replace(/\/+$/, "");
const ACCESS_SECRET = process.env.ACCESS_SECRET || "dev_access_secret_change_in_railway";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "dev_refresh_secret_change_in_railway";

app.set("trust proxy", 1);
app.use(cookieParser());

const _rateBuckets = new Map();
function checkIpRate(req, bucket, maxReq, windowMs) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",").trim();
  const key = ip + ":" + bucket;
  const now = Date.now();
  let rec = _rateBuckets.get(key);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + windowMs };
  rec.count++;
  _rateBuckets.set(key, rec);
  return rec.count <= maxReq;
}

let _lastAutoBackupHour = "";
function runAutoSqliteBackup(dbInstance, sqlitePath) {
  try {
    const hourKey = new Date().toISOString().slice(0, 13).replace("T", "_");
    if (hourKey === _lastAutoBackupHour) return;
    _lastAutoBackupHour = hourKey;
    const bDir = path.join(path.dirname(sqlitePath), "backups");
    if (!fs.existsSync(bDir)) fs.mkdirSync(bDir, { recursive: true });
    dbInstance.exec("PRAGMA wal_checkpoint(PASSIVE);");
    const dest = path.join(bDir, "database_" + hourKey + ".sqlite");
    fs.copyFileSync(sqlitePath, dest);
    const files = fs.readdirSync(bDir).filter(f => f.startsWith("database_")).sort();
    while (files.length > 12) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(bDir, old)); } catch (_) {}
    }
  } catch (e) {
    console.warn("Auto-backup skip:", e.message);
  }
}

app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", FRONTEND_URL],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  })
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === FRONTEND_URL || !isProd) {
    res.header("Access-Control-Allow-Origin", origin || FRONTEND_URL);
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.post("/api/upload-db", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
  if (!checkIpRate(req, "db_key", 5, 15 * 60000)) {
    return res.status(429).json({ error: "Too many attempts. Wait 15 minutes." });
  }
  const secret = process.env.DB_DOWNLOAD_KEY || "moy_parol_123";
  if (req.query.key !== secret) {
    return res.status(403).json({ error: "Access denied: wrong password" });
  }
  if (!req.body || req.body.length < 100 || req.body.subarray(0, 15).toString() !== "SQLite format 3") {
    return res.status(400).json({ error: "Invalid SQLite database file" });
  }
  try {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
    fs.writeFileSync(dbPath, req.body);
    res.json({ ok: true, message: "Database uploaded! Restarting server..." });
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    res.status(500).json({ error: "Write error: " + err.message });
  }
});

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const dbPath = process.env.DB_PATH || path.join(__dirname, "database.sqlite");
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users_clean (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    login TEXT NOT NULL,
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

const oldUsersTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
if (oldUsersTable) {
  db.exec(`
    INSERT OR IGNORE INTO users_clean (id, name, login, role, coins, balance, trust, raw_data)
    SELECT id, name, login, role, coins, balance, trust, raw_data FROM users;
    DROP TABLE users;
  `);
}
db.exec("ALTER TABLE users_clean RENAME TO users;");

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
    const backupUsers = Array.isArray(backup.users) ? backup.users : new Array();
    for (const u of backupUsers) {
      insUser.run(
        String(u.id || Date.now() + Math.random()),
        u.name || "User",
        u.login || "",
        u.role || "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c",
        Number(u.coins) || 0,
        Number(u.balance) || 0,
        Number(u.trust) || 50,
        JSON.stringify(u),
      );
    }
    for (const [k, v] of Object.entries(backup)) {
      if (k !== "users") insSec.run(k, JSON.stringify(v));
    }
    db.exec("COMMIT");
    console.log("Migration from backup.json completed!");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("Migration error:", err);
  }
}

function setAuthCookies(res, userId) {
  const accessToken = jwt.sign({ userId }, ACCESS_SECRET, { expiresIn: "15m" });
  const refreshToken = jwt.sign({ userId }, REFRESH_SECRET, { expiresIn: "7d" });

  const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
  };

  res.cookie("access_token", accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60 * 1000,
    path: "/",
  });

  res.cookie("refresh_token", refreshToken, {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/api/auth/refresh",
  });
}

function authMiddleware(req, res, next) {
  const token = req.cookies.access_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, ACCESS_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Token expired" });
  }
}

app.post("/api/auth/login", (req, res) => {
  if (!checkIpRate(req, "login", 10, 15 * 60000)) {
    return res.status(429).json({ error: "Too many login attempts. Wait 15 minutes." });
  }
  const { userId, login, password } = req.body || {};
  if (!userId && !login) {
    return res.status(400).json({ error: "User not specified" });
  }

  let matchedUser = null;
  if (userId) {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(String(userId));
    if (row) matchedUser = JSON.parse(row.raw_data);
  } else {
    const rows = db.prepare("SELECT * FROM users WHERE LOWER(login) = LOWER(?)").all(String(login).trim());
    for (const r of rows) {
      const u = JSON.parse(r.raw_data);
      if (!password || String(u.pass || u.password || "") === String(password)) {
        matchedUser = u;
        break;
      }
    }
  }

  if (!matchedUser) {
    return res.status(401).json({ error: "User not found" });
  }
  if (matchedUser.frozen) {
    return res.status(403).json({ error: "Account frozen" });
  }

  setAuthCookies(res, matchedUser.id);
  const safeUser = Object.assign({}, matchedUser);
  delete safeUser.pass;
  delete safeUser.password;
  delete safeUser.salt;
  res.json({ ok: true, user: safeUser });
});

app.post("/api/auth/refresh", (req, res) => {
  const refreshToken = req.cookies.refresh_token;
  if (!refreshToken) return res.status(401).json({ error: "No refresh token" });
  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET);
    setAuthCookies(res, payload.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: "Invalid refresh token" });
  }
});

app.get("/api/profile", authMiddleware, (req, res) => {
  const row = db
    .prepare("SELECT raw_data FROM users WHERE id = ?")
    .get(String(req.user.userId));
  if (!row) return res.status(404).json({ error: "User not found" });
  const u = JSON.parse(row.raw_data);
  delete u.pass;
  delete u.password;
  delete u.salt;
  res.json({ ok: true, user: u });
});

app.post("/api/auth/logout", (req, res) => {
  const clearOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
  };
  res.clearCookie("access_token", { ...clearOptions, path: "/" });
  res.clearCookie("refresh_token", { ...clearOptions, path: "/api/auth/refresh" });
  res.json({ ok: true });
});

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
      if (!Array.isArray(u.balanceHistory)) u.balanceHistory = new Array();
      u.balanceHistory.push({
        time: nowIso,
        by: "Database",
        amount: newBalance - oldBalance,
        after: newBalance,
        reason: "Direct DB update",
      });
      if (u.balanceHistory.length > 500) u.balanceHistory.shift();
      userChanged = true;
    }

    if (newCoins !== oldCoins) {
      if (!Array.isArray(u.coinsHistory)) u.coinsHistory = new Array();
      u.coinsHistory.push({
        time: nowIso,
        by: "Database",
        amount: newCoins - oldCoins,
        after: newCoins,
        reason: "Direct DB update",
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
  }

  const result = { users };
  for (const r of secRows) {
    result[r.key] = JSON.parse(r.value);
  }
  res.json(result);
});

app.post("/api/db", (req, res) => {
  if (!checkIpRate(req, "db_write", 90, 60000)) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }
  const data = req.body;
  if (!data || !Array.isArray(data.users)) {
    return res.status(400).json({ error: "Invalid data format" });
  }

  const prevCount = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  if (prevCount >= 2 && data.users.length === 0) {
    return res.status(403).json({ error: "Blocked: empty users wipe rejected" });
  }

  let actorId = null;
  try {
    if (req.cookies && req.cookies.access_token) {
      actorId = jwt.verify(req.cookies.access_token, ACCESS_SECRET).userId;
    }
  } catch (e) {}

  if (isProd && !actorId) {
    return res.status(401).json({ error: "Auth required to save DB" });
  }

  const OWNER_ROLE = "\u0412\u043b\u0430\u0434\u0435\u043b\u0435\u0446";

  if (actorId) {
    if (Array.isArray(data.hrRequests)) {
      const oldHrSec = db
        .prepare("SELECT value FROM db_sections WHERE key = 'hrRequests'")
        .get();
      const oldHrReqs = oldHrSec ? JSON.parse(oldHrSec.value) : new Array();
      for (const newR of data.hrRequests) {
        const oldR = oldHrReqs.find((x) => x.id === newR.id);
        if (
          oldR &&
          oldR.type === "promotion" &&
          oldR.status === "pending" &&
          newR.status !== "pending" &&
          String(newR.userId) === String(actorId)
        ) {
          return res.status(403).json({
            error: "Cannot approve or reject your own promotion request",
          });
        }
      }
    }

    if (Array.isArray(data.promotionRequests)) {
      const oldSec = db
        .prepare("SELECT value FROM db_sections WHERE key = 'promotionRequests'")
        .get();
      const oldReqs = oldSec ? JSON.parse(oldSec.value) : new Array();
      for (const newR of data.promotionRequests) {
        const oldR = oldReqs.find((x) => x.id === newR.id);
        if (
          oldR &&
          oldR.status === "pending" &&
          newR.status !== "pending" &&
          String(newR.userId) === String(actorId)
        ) {
          return res.status(403).json({
            error: "Cannot approve or reject your own promotion request",
          });
        }
      }
    }

    const oldActorRow = db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(String(actorId));
    const newActor = data.users.find((u) => String(u.id) === String(actorId));
    if (
      oldActorRow &&
      newActor &&
      oldActorRow.role !== OWNER_ROLE &&
      oldActorRow.role !== newActor.role
    ) {
      return res.status(403).json({
        error: "Cannot change your own role",
      });
    }

    if (oldActorRow && oldActorRow.role !== OWNER_ROLE) {
      const prevOwners = db
        .prepare("SELECT id FROM users WHERE role = ?")
        .all(OWNER_ROLE)
        .map((r) => String(r.id));
      const unauthorizedOwner = data.users.find(
        (u) => u && u.role === OWNER_ROLE && !prevOwners.includes(String(u.id))
      );
      if (unauthorizedOwner) {
        return res.status(403).json({ error: "Only Owner can assign Owner role" });
      }
    }
  }

  const delUsers = db.prepare("DELETE FROM users");
  const insUser = db.prepare(
    "INSERT OR REPLACE INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insSec = db.prepare("INSERT OR REPLACE INTO db_sections VALUES (?, ?)");

  db.exec("BEGIN");
  try {
    delUsers.run();
    for (const u of data.users) {
      insUser.run(
        String(u.id || Date.now() + Math.random()),
        u.name || "User",
        u.login || "",
        u.role || "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c",
        Math.max(0, Number(u.coins) || 0),
        Math.max(0, Number(u.balance) || 0),
        Number(u.trust) || 0,
        JSON.stringify(u),
      );
    }
    for (const [k, v] of Object.entries(data)) {
      if (k !== "users") insSec.run(k, JSON.stringify(v));
    }
    db.exec("COMMIT");
    runAutoSqliteBackup(db, dbPath);
    res.json({ ok: true });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download-db", (req, res) => {
  if (!checkIpRate(req, "db_key", 5, 15 * 60000)) {
    return res.status(429).send("Too many attempts. Wait 15 minutes.");
  }
  const secret = process.env.DB_DOWNLOAD_KEY || "moy_parol_123";
  if (req.query.key !== secret) {
    return res.status(403).send("Access denied: wrong password");
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  res.download(dbPath, "database.sqlite");
});

app.post("/api/reset-db", (req, res) => {
  if (!checkIpRate(req, "db_key", 5, 15 * 60000)) {
    return res.status(429).json({ error: "Too many attempts. Wait 15 minutes." });
  }
  const secret = process.env.DB_DOWNLOAD_KEY || "moy_parol_123";
  if (req.query.key !== secret) {
    return res.status(403).json({ error: "Access denied: wrong password" });
  }
  db.exec("DELETE FROM users; DELETE FROM db_sections;");
  res.json({ ok: true, message: "Database cleared" });
});

app.get("/api/db-admin", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SQLite Admin</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0d131a;color:#e6edf3;max-width:520px;margin:40px auto;padding:20px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:16px}
    h2{margin-top:0}
    input[type="password"],input[type="file"]{width:100%;box-sizing:border-box;padding:10px;margin:8px 0 16px;border-radius:8px;border:1px solid #30363d;background:#0d131a;color:#fff}
    button{width:100%;padding:12px;border:none;border-radius:8px;font-weight:700;cursor:pointer;margin-bottom:8px;font-size:14px}
    .btn-dl{background:#238636;color:#fff}
    .btn-up{background:#1f6feb;color:#fff}
    .btn-rst{background:#da3633;color:#fff}
    #msg{margin-top:12px;font-weight:600;white-space:pre-wrap}
  </style></head><body>
  <div class="card">
    <h2>SQLite Database Admin</h2>
    <label>Access Key (DB_DOWNLOAD_KEY):</label>
    <input type="password" id="key" placeholder="Password...">
    <button class="btn-dl" onclick="dl()">Download database.sqlite</button>
    <hr style="border-color:#30363d;margin:16px 0">
    <label>Upload database.sqlite:</label>
    <input type="file" id="file" accept=".sqlite,.db">
    <button class="btn-up" onclick="up()">Upload & Restart</button>
    <hr style="border-color:#30363d;margin:16px 0">
    <button class="btn-rst" onclick="rst()">Reset Database</button>
    <div id="msg"></div>
  </div>
  <script>
    const msg = document.getElementById('msg');
    function dl() {
      const k = document.getElementById('key').value;
      window.location.href = '/api/download-db?key=' + encodeURIComponent(k);
    }
    async function up() {
      const k = document.getElementById('key').value;
      const f = document.getElementById('file').files.item(0);
      if (!f) return msg.textContent = 'Select .sqlite file';
      msg.textContent = 'Uploading...';
      const res = await fetch('/api/upload-db?key=' + encodeURIComponent(k), { method: 'POST', body: f });
      const data = await res.json();
      msg.textContent = data.message || data.error;
    }
    async function rst() {
      if (!confirm('Delete all data from database?')) return;
      const k = document.getElementById('key').value;
      const res = await fetch('/api/reset-db?key=' + encodeURIComponent(k), { method: 'POST' });
      const data = await res.json();
      msg.textContent = data.message || data.error;
    }
  </script></body></html>`);
});

app.get("/", (req, res) => {
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.json({ ok: true, service: "SpaceWorld Staff API" });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("SpaceWorld Staff server listening on port " + PORT);
});
