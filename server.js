/* ==========================================================
   THARU EDUCATION  -  Server
   Powered by LYNKO TECH 2026 ©
   ========================================================== */
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const { GridFSBucket, ObjectId } = mongoose.mongo;

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';
const TZ = 'Asia/Colombo';

for (const [k, v] of Object.entries({ MONGODB_URI, ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET })) {
  if (!v) {
    console.error(`❌ Missing .env value: ${k}  (copy .env.example to .env first)`);
    process.exit(1);
  }
}

/* ------------------------- Models ------------------------- */
const paperSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 3000 },
    disclaimer: { type: String, default: '', trim: true, maxlength: 2000 },
    category: { type: String, enum: ['paper', 'note'], default: 'paper', index: true },
    subject: { type: String, default: '', trim: true, maxlength: 100, index: true },
    year: { type: String, default: '', trim: true, maxlength: 20 },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    fileName: String,
    fileSize: Number,
    downloads: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
  },
  { timestamps: true }
);
const Paper = mongoose.model('Paper', paperSchema);

const downloadLog = new mongoose.Schema({
  paperId: { type: mongoose.Schema.Types.ObjectId, index: true },
  title: String,
  at: { type: Date, default: Date.now, index: true },
});
const DownloadLog = mongoose.model('DownloadLog', downloadLog);

const errorLogSchema = new mongoose.Schema({
  message: String,
  stack: String,
  method: String,
  url: String,
  at: { type: Date, default: Date.now, index: true },
});
const ErrorLog = mongoose.model('ErrorLog', errorLogSchema);

/* ------------------------- Helpers ------------------------- */
let bucket;
const startedAt = Date.now();
const counters = { requests: 0, apiRequests: 0 };

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function logError(err, req) {
  try {
    await ErrorLog.create({
      message: String(err && err.message ? err.message : err).slice(0, 500),
      stack: String(err && err.stack ? err.stack : '').slice(0, 2000),
      method: req && req.method,
      url: req && req.originalUrl,
    });
  } catch (_) {
    /* never crash while logging */
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });

function uploadToGridFS(file) {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(file.originalname, { contentType: 'application/pdf' });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    stream.end(file.buffer);
  });
}

async function removeFile(id) {
  try {
    await bucket.delete(new ObjectId(id));
  } catch (_) {
    /* file may already be gone */
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error('PDF files only'), ok);
  },
});

function cleanBody(b) {
  return {
    title: (b.title || '').trim(),
    description: (b.description || '').trim(),
    disclaimer: (b.disclaimer || '').trim(),
    category: b.category === 'note' ? 'note' : 'paper',
    subject: (b.subject || '').trim(),
    year: (b.year || '').trim(),
  };
}

/* ------------------------- App ------------------------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  counters.requests++;
  if (req.path.startsWith('/api') || req.path.startsWith('/admin/api')) counters.apiRequests++;
  next();
});

/* ---- Pages (only these files are public, .env & server.js are never exposed) ---- */
const sendFile = (name) => (req, res) => res.sendFile(path.join(__dirname, name));
app.get('/', sendFile('index.html'));
app.get('/style.css', sendFile('style.css'));
app.get(['/admin', '/admin/'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/health', (req, res) => res.json({ ok: true }));

/* ------------------------- Public API ------------------------- */
app.get(
  '/api/summary',
  wrap(async (req, res) => {
    const [papers, notes, agg] = await Promise.all([
      Paper.countDocuments({ category: 'paper' }),
      Paper.countDocuments({ category: 'note' }),
      Paper.aggregate([{ $group: { _id: null, d: { $sum: '$downloads' } } }]),
    ]);
    res.json({ papers, notes, downloads: agg[0] ? agg[0].d : 0 });
  })
);

app.get(
  '/api/subjects',
  wrap(async (req, res) => {
    const subjects = await Paper.distinct('subject', { subject: { $ne: '' } });
    res.json(subjects.sort((a, b) => a.localeCompare(b)));
  })
);

async function listPapers(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 12));
  const q = (req.query.q || '').trim().slice(0, 100);
  const filter = {};
  if (['paper', 'note'].includes(req.query.category)) filter.category = req.query.category;
  if (req.query.subject) filter.subject = String(req.query.subject);
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ title: rx }, { subject: rx }, { description: rx }, { year: rx }];
  }
  const sorts = { new: { createdAt: -1 }, popular: { downloads: -1 }, az: { title: 1 } };
  const sort = sorts[req.query.sort] || sorts.new;

  const [items, total] = await Promise.all([
    Paper.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).select('-fileId').lean(),
    Paper.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit) });
}
app.get('/api/papers', wrap(listPapers));

app.get(
  '/api/papers/:id/file',
  wrap(async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).send('Not found');
    const inline = req.query.inline === '1';
    const paper = await Paper.findByIdAndUpdate(
      req.params.id,
      { $inc: inline ? { views: 1 } : { downloads: 1 } },
      { new: true }
    );
    if (!paper) return res.status(404).send('Not found');

    if (!inline) DownloadLog.create({ paperId: paper._id, title: paper.title }).catch(() => {});

    const safeName = (paper.title || 'document').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'document';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}.pdf"`);
    if (paper.fileSize) res.setHeader('Content-Length', paper.fileSize);

    const stream = bucket.openDownloadStream(paper.fileId);
    stream.on('error', async (err) => {
      await logError(err, req);
      if (!res.headersSent) res.status(404).send('File missing');
      else res.end();
    });
    stream.pipe(res);
  })
);

/* ------------------------- Admin API ------------------------- */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

function requireAdmin(req, res, next) {
  try {
    const t = req.cookies.tharu_admin;
    if (!t) throw new Error('no token');
    req.admin = jwt.verify(t, JWT_SECRET);
    next();
  } catch (_) {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

app.post('/admin/api/login', loginLimiter, (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const ok = safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ u: ADMIN_USERNAME }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('tharu_admin', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post('/admin/api/logout', (req, res) => {
  res.clearCookie('tharu_admin');
  res.json({ ok: true });
});

app.get('/admin/api/me', requireAdmin, (req, res) => res.json({ user: req.admin.u }));

app.get(
  '/admin/api/status',
  requireAdmin,
  wrap(async (req, res) => {
    let dbOk = false;
    let dbPing = null;
    try {
      const t = Date.now();
      await mongoose.connection.db.admin().ping();
      dbPing = Date.now() - t;
      dbOk = true;
    } catch (_) {}
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const errors24h = await ErrorLog.countDocuments({ at: { $gte: since } });
    const mem = process.memoryUsage();
    res.json({
      server: 'online',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      db: dbOk ? 'connected' : 'disconnected',
      dbPing,
      memoryMB: Math.round(mem.rss / 1048576),
      node: process.version,
      requests: counters.requests,
      apiRequests: counters.apiRequests,
      errors24h,
      time: new Date().toISOString(),
    });
  })
);

app.get(
  '/admin/api/overview',
  requireAdmin,
  wrap(async (req, res) => {
    const days = 7;
    const from = new Date(Date.now() - (days + 1) * 24 * 3600 * 1000);

    const [papers, notes, sums, top, recent, daily] = await Promise.all([
      Paper.countDocuments({ category: 'paper' }),
      Paper.countDocuments({ category: 'note' }),
      Paper.aggregate([{ $group: { _id: null, d: { $sum: '$downloads' }, v: { $sum: '$views' } } }]),
      Paper.find().sort({ downloads: -1 }).limit(5).select('title downloads views category').lean(),
      DownloadLog.find().sort({ at: -1 }).limit(10).lean(),
      DownloadLog.aggregate([
        { $match: { at: { $gte: from } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: TZ } }, c: { $sum: 1 } } },
      ]),
    ]);

    const map = Object.fromEntries(daily.map((d) => [d._id, d.c]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(Date.now() - i * 24 * 3600 * 1000);
      series.push({ day: k, count: map[k] || 0 });
    }

    res.json({
      stats: {
        papers,
        notes,
        total: papers + notes,
        downloads: sums[0] ? sums[0].d : 0,
        views: sums[0] ? sums[0].v : 0,
      },
      series,
      top,
      recent,
    });
  })
);

app.get(
  '/admin/api/papers',
  requireAdmin,
  wrap(async (req, res) => {
    const q = (req.query.q || '').trim();
    const filter = q ? { title: new RegExp(escapeRegex(q), 'i') } : {};
    const items = await Paper.find(filter).sort({ createdAt: -1 }).limit(300).select('-fileId').lean();
    res.json(items);
  })
);

app.post(
  '/admin/api/papers',
  requireAdmin,
  upload.single('file'),
  wrap(async (req, res) => {
    const data = cleanBody(req.body);
    if (!data.title) return res.status(400).json({ error: 'Title is required' });
    if (!req.file) return res.status(400).json({ error: 'Please choose a PDF file' });
    const fileId = await uploadToGridFS(req.file);
    const paper = await Paper.create({
      ...data,
      fileId,
      fileName: req.file.originalname,
      fileSize: req.file.size,
    });
    res.json({ ok: true, id: paper._id });
  })
);

app.put(
  '/admin/api/papers/:id',
  requireAdmin,
  upload.single('file'),
  wrap(async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const paper = await Paper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Not found' });
    const data = cleanBody(req.body);
    if (!data.title) return res.status(400).json({ error: 'Title is required' });
    Object.assign(paper, data);
    if (req.file) {
      const oldId = paper.fileId;
      paper.fileId = await uploadToGridFS(req.file);
      paper.fileName = req.file.originalname;
      paper.fileSize = req.file.size;
      await paper.save();
      await removeFile(oldId);
    } else {
      await paper.save();
    }
    res.json({ ok: true });
  })
);

app.delete(
  '/admin/api/papers/:id',
  requireAdmin,
  wrap(async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const paper = await Paper.findByIdAndDelete(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Not found' });
    await removeFile(paper.fileId);
    res.json({ ok: true });
  })
);

app.get(
  '/admin/api/errors',
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await ErrorLog.find().sort({ at: -1 }).limit(100).lean());
  })
);

app.delete(
  '/admin/api/errors',
  requireAdmin,
  wrap(async (req, res) => {
    await ErrorLog.deleteMany({});
    res.json({ ok: true });
  })
);

/* ------------------------- Errors ------------------------- */
app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/admin/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).redirect('/');
});

app.use(async (err, req, res, _next) => {
  const isUpload = err instanceof multer.MulterError || err.message === 'PDF files only';
  if (!isUpload) await logError(err, req);
  const msg =
    err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 15MB)' : isUpload ? err.message : 'Something went wrong';
  res.status(isUpload ? 400 : 500).json({ error: msg });
});

process.on('unhandledRejection', (e) => logError(e, null));
process.on('uncaughtException', (e) => {
  console.error(e);
  logError(e, null);
});

/* ------------------------- Start ------------------------- */
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'pdfs' });
    app.listen(PORT, () => {
      console.log(`✅ Tharu Education running → http://localhost:${PORT}`);
      console.log(`🔐 Admin panel          → http://localhost:${PORT}/admin`);
    });
  })
  .catch((e) => {
    console.error('❌ MongoDB connection failed:', e.message);
    process.exit(1);
  });
