const express = require('express');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Создаём/открываем базу SQLite встроенным модулем Node.js
const db = new DatabaseSync(path.join(__dirname, 'database.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');

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
const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (count === 0 && fs.existsSync(path.join(__dirname, 'backup.json'))) {
  const backup = JSON.parse(fs.readFileSync(path.join(__dirname, 'backup.json'), 'utf8'));
  const insUser = db.prepare('INSERT OR REPLACE INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insSec = db.prepare('INSERT OR REPLACE INTO db_sections VALUES (?, ?)');

  db.exec('BEGIN');
  try {
    for (const u of (backup.users || [])) {
      insUser.run(
        u.id,
        u.name,
        u.login,
        u.role || 'Пользователь',
        u.coins || 0,
        u.balance || 0,
        u.trust || 50,
        JSON.stringify(u)
      );
    }
    for (const [k, v] of Object.entries(backup)) {
      if (k !== 'users') insSec.run(k, JSON.stringify(v));
    }
    db.exec('COMMIT');
    console.log('✅ Данные из backup.json перенесены в database.sqlite!');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Ошибка миграции:', err);
  }
}

// API: Загрузить всю базу на сайт (подхватывает правки из колонок DB Browser!)
app.get('/api/db', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const usersRows = db.prepare('SELECT * FROM users').all();
  const secRows = db.prepare('SELECT key, value FROM db_sections').all();

  const result = {
    users: usersRows.map(r => {
      const u = JSON.parse(r.raw_data);
      // Синхронизируем значения из обычных столбцов таблицы SQLite поверх JSON
      u.name = r.name;
      u.login = r.login;
      u.role = r.role;
      u.coins = Number(r.coins) || 0;
      u.balance = Number(r.balance) || 0;
      u.trust = Number(r.trust) || 0;
      return u;
    })
  };

  for (const r of secRows) {
    result[r.key] = JSON.parse(r.value);
  }
  res.json(result);
});

// API: Сохранить обновлённую базу с сайта в SQLite
app.post('/api/db', (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.users)) {
    return res.status(400).json({ error: 'Некорректный формат данных' });
  }

  const delUsers = db.prepare('DELETE FROM users');
  const insUser = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insSec = db.prepare('INSERT OR REPLACE INTO db_sections VALUES (?, ?)');

  db.exec('BEGIN');
  try {
    delUsers.run();
    for (const u of data.users) {
      insUser.run(
        u.id,
        u.name,
        u.login,
        u.role || 'Пользователь',
        Number(u.coins) || 0,
        Number(u.balance) || 0,
        Number(u.trust) || 0,
        JSON.stringify(u)
      );
    }
    for (const [k, v] of Object.entries(data)) {
      if (k !== 'users') insSec.run(k, JSON.stringify(v));
    }
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.listen(8000, () => {
  console.log('🚀 Сайт и бэкенд запущены: http://localhost:8000');
});
