// server.js
// This is your backend. It keeps your Gemini API key secret on the server,
// safely forwards requests from your webpage to Google's Gemini API,
// and handles account sign-up / login so only signed-in users reach the decoder.

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Tiny file-based user store (no database needed).
// Good enough for an assessment/demo. Swap for a real DB before real users.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DOCUMENTS_FILE = path.join(DATA_DIR, 'documents.json');

function ensureUsersFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

function loadUsers() {
  ensureUsersFile();
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  ensureUsersFile();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function ensureDocumentsFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DOCUMENTS_FILE)) fs.writeFileSync(DOCUMENTS_FILE, '[]', 'utf8');
}

function loadDocuments() {
  ensureDocumentsFile();
  try {
    return JSON.parse(fs.readFileSync(DOCUMENTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveDocuments(documents) {
  ensureDocumentsFile();
  fs.writeFileSync(DOCUMENTS_FILE, JSON.stringify(documents, null, 2), 'utf8');
}

function countClauseLevels(clauses) {
  const counts = { red: 0, ochre: 0, moss: 0 };
  (clauses || []).forEach((c) => {
    if (counts[c.level] !== undefined) counts[c.level]++;
  });
  return counts;
}

// Trimmed view of a document for list endpoints — leaves out clauses/questions
// so the dashboard list stays light even with many saved documents.
function documentSummaryView(doc) {
  return {
    id: doc.id,
    filename: doc.filename,
    createdAt: doc.createdAt,
    summary: doc.summary,
    counts: doc.counts,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      sameSite: 'lax',
    },
  })
);
app.use(express.static('public')); // serves index.html from /public

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Please sign in to use the decoder.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// File upload (PDF / DOCX) — extracts plain text, does not save the file
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const okTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    ];
    if (okTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF or DOCX files are supported.'));
    }
  },
});

app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large (15MB max).'
          : err.message || 'Could not read that file.';
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded.' });
    }

    try {
      let text = '';

      if (req.file.mimetype === 'application/pdf') {
        const parsed = await pdfParse(req.file.buffer);
        text = parsed.text || '';
      } else {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        text = result.value || '';
      }

      text = text.trim();

      if (!text) {
        return res.status(422).json({
          error:
            'Could not find readable text in that file — it may be a scanned image rather than a text document.',
        });
      }

      res.json({ text, filename: req.file.originalname });
    } catch (e) {
      console.error('File extraction error:', e);
      res.status(500).json({ error: 'Something went wrong reading that file.' });
    }
  });
});

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Enter your name.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const users = loadUsers();
  const normalizedEmail = email.trim().toLowerCase();

  if (users.some((u) => u.email === normalizedEmail)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: normalizedEmail,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  saveUsers(users);

  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }

  const users = loadUsers();
  const normalizedEmail = email.trim().toLowerCase();
  const user = users.find((u) => u.email === normalizedEmail);

  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ authenticated: false });
  }
  const users = loadUsers();
  const user = users.find((u) => u.id === req.session.userId);
  if (!user) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------
const GEMINI_MODEL = 'gemini-3.5-flash'; // free-tier model as of Sept 2026

async function callGemini(prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('Gemini API error:', errText);
    throw new Error('Gemini API failed');
  }

  const data = await response.json();
  const rawText =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '';
  return rawText.replace(/```json/g, '').replace(/```/g, '').trim();
}

// Existing endpoint: analyze a document clause by clause (now requires sign-in)
app.post('/api/decode', requireAuth, async (req, res) => {
  const { text, filename } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No document text provided.' });
  }

  const prompt = `You are a sharp, plain-spoken document reviewer helping an ordinary person (not a lawyer) understand something they're about to sign or agree to. You are direct and specific, never vague, never hedgy legal-speak.

Analyze the following document text. Break it into its distinct clauses or provisions (2 to 7 of them — merge trivial adjacent points, split out anything genuinely separate). For each one:
- give a short excerpt (under 20 words) quoting or closely paraphrasing the key part
- explain in one or two plain sentences what it actually means for the person, in everyday language, no legal jargon
- classify it as "red" (a real red flag — unusual, one-sided, costly, or risky), "ochre" (worth a closer look but not alarming), or "moss" (standard, fine, nothing to worry about)

Then write:
- a 2-3 sentence plain-English summary of the overall document and the biggest thing to know
- 3 to 5 sharp, specific questions the person should ask before agreeing, based on THIS document (not generic questions)

Respond with ONLY raw JSON, no markdown fences, no preamble, in exactly this shape:
{
  "summary": "string",
  "clauses": [
    {"excerpt": "string", "note": "string", "level": "red|ochre|moss"}
  ],
  "questions": ["string", ...]
}

Document text:
"""
${text}
"""`;

  try {
    const cleaned = await callGemini(prompt);
    const parsed = JSON.parse(cleaned);

    // Save this result so it shows up in the user's document history.
    try {
      const documents = loadDocuments();
      documents.push({
        id: crypto.randomUUID(),
        userId: req.session.userId,
        filename: (filename && filename.trim()) || 'Pasted document',
        createdAt: new Date().toISOString(),
        summary: parsed.summary || '',
        clauses: parsed.clauses || [],
        questions: parsed.questions || [],
        counts: countClauseLevels(parsed.clauses),
      });
      saveDocuments(documents);
    } catch (saveErr) {
      // Don't fail the request just because saving history failed —
      // the user still gets their analysis either way.
      console.error('Could not save document history:', saveErr);
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong reading that document.' });
  }
});

// My Documents dashboard — list of this user's past decode results
app.get('/api/documents', requireAuth, (req, res) => {
  const documents = loadDocuments()
    .filter((d) => d.userId === req.session.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(documentSummaryView);
  res.json({ documents });
});

// Fetch one saved document in full (used when clicking into a past result)
app.get('/api/documents/:id', requireAuth, (req, res) => {
  const documents = loadDocuments();
  const doc = documents.find(
    (d) => d.id === req.params.id && d.userId === req.session.userId
  );
  if (!doc) {
    return res.status(404).json({ error: 'Document not found.' });
  }
  res.json({
    id: doc.id,
    filename: doc.filename,
    createdAt: doc.createdAt,
    summary: doc.summary,
    clauses: doc.clauses,
    questions: doc.questions,
  });
});

// New endpoint: draft a pushback message about the red/ochre flagged clauses (requires sign-in)
app.post('/api/pushback', requireAuth, async (req, res) => {
  const { clauses, documentContext } = req.body;

  if (!clauses || !Array.isArray(clauses) || clauses.length === 0) {
    return res.status(400).json({ error: 'No flagged clauses provided.' });
  }

  const flaggedText = clauses
    .map((c, i) => `${i + 1}. [${c.level.toUpperCase()}] "${c.excerpt}" — ${c.note}`)
    .join('\n');

  const prompt = `You are helping an ordinary person push back on a document before they sign it. They are not a lawyer and don't want to sound like one — they want to sound reasonable, firm, and specific.

Here is brief context on the document: ${documentContext || 'a document they were asked to sign'}

Here are the specific clauses they are concerned about:
${flaggedText}

Write a short, polite but firm message (email style, 120-180 words) they could send to the other party (landlord, employer, vendor, company, etc.) asking to revisit or clarify these specific clauses. Reference the actual clauses concretely — don't be vague or generic. Sound like a reasonable person protecting their own interests, not a lawyer sending a legal threat. End with a clear, low-friction ask (e.g. "could we adjust X" or "can you clarify Y before I sign").

Respond with ONLY raw JSON, no markdown fences, no preamble, in exactly this shape:
{
  "subject": "string (short email subject line)",
  "message": "string (the full message body)"
}`;

  try {
    const cleaned = await callGemini(prompt);
    const parsed = JSON.parse(cleaned);
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not draft a message right now.' });
  }
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Decoder running at ${url}`);

  // Auto-open the default browser
  const { exec } = require('child_process');
  const platform = process.platform;
  const openCmd =
    platform === 'win32' ? `start ${url}` :
    platform === 'darwin' ? `open ${url}` :
    `xdg-open ${url}`;
  exec(openCmd, (err) => {
    if (err) console.log('Could not auto-open browser — just open the URL above manually.');
  });
});
