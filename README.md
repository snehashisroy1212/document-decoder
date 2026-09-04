# Decoder

Paste or upload a confusing document — a lease, an insurance explanation of benefits, terms of service, an offer letter — and get it explained clause by clause in plain English. No legal jargon, no guessing.

## What it does

- **Sign up / log in** — session-based authentication gates access to the decoder
- **Paste text or upload a file** — supports direct paste, or upload a PDF/DOCX and the text is extracted automatically
- **Clause-by-clause breakdown** — every clause is explained in plain English and flagged as:
  - 🔴 **Red flag** — unusual, one-sided, costly, or risky
  - 🟠 **Worth a closer look** — not alarming, but worth understanding
  - 🟢 **Standard** — normal, nothing to worry about
- **Plain-English summary** of the whole document
- **Specific questions to ask** before signing or agreeing, tailored to the actual document
- **Pushback message drafting** — auto-generates a polite, firm email asking to revisit any flagged clauses
- **My Documents dashboard** — every decoded document is saved to your account, so you can come back and review past results anytime without re-uploading

## Tech stack

- **Backend:** Node.js, Express
- **AI analysis:** Google Gemini API
- **Auth:** express-session with a lightweight file-based user store (scrypt password hashing)
- **File upload & extraction:** multer, pdf-parse (PDF), mammoth (DOCX)
- **Persistence:** lightweight file-based document store (`data/documents.json`), scoped per user
- **Frontend:** vanilla HTML/CSS/JS, no framework — scroll-driven intro animation, custom design system

## Running locally

1. Clone the repo and install dependencies:
   ```
   npm install
   ```

2. Create a `.env` file in the project root:
   ```
   GEMINI_API_KEY=your_gemini_api_key_here
   SESSION_SECRET=some_random_string
   ```

3. Start the server:
   ```
   npm start
   ```

4. The app opens automatically at `http://localhost:3000`. Sign up for an account, then paste a document or upload a PDF/DOCX to try it out. Decoded documents show up under "My Documents" in the top navigation.

## Notes

- User accounts are stored locally in `data/users.json` (passwords are hashed, never stored in plain text) — this is a lightweight file-based store suitable for a demo, not a production database.
- Decoded document results are stored locally in `data/documents.json`, scoped to each user's account.
- Uploaded files themselves are processed in memory only and are never saved to disk — only the extracted text and analysis result are stored.