const express = require('express');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const Database = require('better-sqlite3');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Database Setup ──────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'attendance.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_number TEXT NOT NULL,
    name TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  )
`);

// ─── Middleware ──────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'noproxy-attendance-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 } // 1 hour
}));

// Serve static files
app.use(express.static(__dirname));

// Serve uploaded files
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// ─── File Upload Config ─────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `permission-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF and image files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// ─── Admin Auth ─────────────────────────────────────────────────
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please log in as admin.' });
}

// ─── API Routes ─────────────────────────────────────────────────

// Student: Submit permission letter
app.post('/api/submit', upload.single('permissionFile'), (req, res) => {
  try {
    const { rollNumber, name, reason } = req.body;

    if (!rollNumber || !req.file) {
      return res.status(400).json({ error: 'Roll number and permission file are required.' });
    }

    const stmt = db.prepare(`
      INSERT INTO submissions (roll_number, name, reason, filename, original_name)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      rollNumber.trim(),
      (name || '').trim(),
      (reason || '').trim(),
      req.file.filename,
      req.file.originalname
    );

    res.json({ success: true, message: 'Permission letter submitted successfully!' });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to submit. Please try again.' });
  }
});

// Admin: Login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    res.json({ success: true, message: 'Login successful!' });
  } else {
    res.status(401).json({ error: 'Invalid credentials.' });
  }
});

// Admin: Logout
app.get('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Logged out.' });
});

// Admin: Check auth
app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// Admin: Get submissions (with search & filter)
app.get('/api/submissions', requireAdmin, (req, res) => {
  try {
    const { search, dateFrom, dateTo } = req.query;
    let query = 'SELECT * FROM submissions WHERE 1=1';
    const params = [];

    if (search) {
      query += ' AND roll_number LIKE ?';
      params.push(`%${search}%`);
    }

    if (dateFrom) {
      query += ' AND date(created_at) >= date(?)';
      params.push(dateFrom);
    }

    if (dateTo) {
      query += ' AND date(created_at) <= date(?)';
      params.push(dateTo);
    }

    query += ' ORDER BY roll_number ASC';

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch submissions.' });
  }
});

// Admin: Download CSV
app.get('/api/submissions/csv', requireAdmin, async (req, res) => {
  try {
    const { search, dateFrom, dateTo } = req.query;
    let query = 'SELECT * FROM submissions WHERE 1=1';
    const params = [];

    if (search) {
      query += ' AND roll_number LIKE ?';
      params.push(`%${search}%`);
    }
    if (dateFrom) {
      query += ' AND date(created_at) >= date(?)';
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ' AND date(created_at) <= date(?)';
      params.push(dateTo);
    }

    query += ' ORDER BY roll_number ASC';
    const rows = db.prepare(query).all(...params);

    const csvPath = path.join(__dirname, 'temp-export.csv');
    const csvWriter = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: 'roll_number', title: 'Roll Number' },
        { id: 'name', title: 'Name' },
        { id: 'reason', title: 'Reason' },
        { id: 'original_name', title: 'File Name' },
        { id: 'created_at', title: 'Date & Time' }
      ]
    });

    await csvWriter.writeRecords(rows);
    res.download(csvPath, 'submissions.csv', () => {
      fs.unlinkSync(csvPath);
    });
  } catch (err) {
    console.error('CSV error:', err);
    res.status(500).json({ error: 'Failed to export CSV.' });
  }
});

// Admin: Delete all submissions
app.delete('/api/submissions', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare('SELECT filename FROM submissions').all();
    for (const row of rows) {
      const filePath = path.join(uploadsDir, row.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    db.prepare('DELETE FROM submissions').run();
    res.json({ success: true, message: 'All submissions deleted.' });
  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).json({ error: 'Failed to delete all submissions.' });
  }
});

// Admin: Delete single submission
app.delete('/api/submissions/:id', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT filename FROM submissions WHERE id = ?').get(req.params.id);
    if (row) {
      const filePath = path.join(uploadsDir, row.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      db.prepare('DELETE FROM submissions WHERE id = ?').run(req.params.id);
      res.json({ success: true, message: 'Submission deleted.' });
    } else {
      res.status(404).json({ error: 'Submission not found.' });
    }
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete submission.' });
  }
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ─── Start Server ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   No Proxy Attendance Portal                 ║`);
  console.log(`  ║   Server running on http://localhost:${PORT}     ║`);
  console.log(`  ║   Admin: admin / admin123                    ║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);
});
