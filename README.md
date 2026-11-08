# Margin — local paper study

A laptop web app with an OpenAI chat on the left and a PDF.js reader on the right. Wide windows show both panels; narrow windows stack them. Designed for *Robot Collisions: A Survey on Detection, Isolation, and Identification* and usable with other text-based PDFs.

## Start

Requires Node.js 22.12+ (Node 24 LTS recommended) and an OpenAI API key with access to your selected model.

```bash
git clone https://github.com/QuokeCola/margin.git
cd margin
npm ci
cp .env.example .env
chmod 600 .env
```

Then start the app and click **Settings** to paste your OpenAI API key. The key is checked with OpenAI, written to `.env` (mode 600) and applied immediately, with no restart. Pick the model from the **Model** menu in the header (it lists the text models your key can use) or type a model ID in Settings. You can still edit `.env` by hand; hand edits need a server restart. Never put your key into chat or frontend source.

```bash
npm run dev
```

Open http://127.0.0.1:4317 in a modern browser. If port 4317 is busy, change `PORT` in `.env`. Restart the server and reload the browser after changing settings. Stop the server with Ctrl+C.

For a built version:

```bash
npm run build
npm start
```

## Study workflow

1. Click **+ Add PDF** in the library and select a paper. A copy is stored in the library (`~/.local/share/margin/papers/<sha256>/`), so it reopens from the sidebar later; adding the same file again opens the existing entry.
   Each paper can have any number of chats. **+ New chat** starts one; click a chat to switch, double-click a paper or chat to rename it, and use × to delete. Chats are saved after every answer, with the model and time of each reply. ☰ hides the library.
2. Ask a question; Enter sends it, and Ctrl+Enter (or Shift+Enter) adds a line break. Chat is connected to the API model, not the original ChatGPT chat or its memory. A short topic summary from that chat is included in the tutor instructions, not its full transcript.
3. Citations are clickable where they appear: inline chips such as `Eq. (46) · p. 7`, plain mentions such as “Eq. (61)” or “p. 4” (dotted underline), and equations reproduced from the paper (outlined on the left, with a badge); click one to jump to its source. The chips are repeated at the bottom of each answer. Click an answer or a citation chip to navigate. With **Follow chat** enabled, scrolling to an older answer moves the PDF to its first reference. If an answer has several citations, select a specific chip. Turn following off to explore the PDF independently; explicit citation clicks still work.
4. Page citations outline the page. Equation citations highlight a horizontal band near the detected label. Missing equation coordinates fall back to a cited page; ambiguous locations without a page require correction.
5. In **Find a reference / correct an equation location**, enter an equation number and click **Find equation**. To correct it, enter the actual PDF page and position from the top, or click the page with this panel open, then **Save correction**. **Remove correction** returns to automatic detection.
6. **Zoom**: pinch the trackpad (or Ctrl + scroll) over the PDF to zoom around the cursor, or use − / % / +. Range 50–300%; the zoom level is remembered.

Page numbers always mean 1-based PDF positions, not printed journal page numbers. Example: `[[eq:61|p:11]]` or `[[p:11]]`. The parser also recognizes `Eq. (61)`, `Equation 61 on page 11`, `Eqs. 57–58`, and `p. 11`. Model citations and detected labels must be checked against the original.

## Privacy and security

- The server binds only to `127.0.0.1`, validates Host and Origin, and requires a random per-launch session token for every API call except status (settings, library, chats and model calls). No CORS access is enabled. It is a local tool, not a multi-user hosting service; do not expose it through a tunnel.
- Your API key stays in the server environment / ignored `.env`. It is never returned by the status endpoint, stored in the browser, or bundled into client JavaScript. Do not commit or share `.env`.
- PDF bytes are parsed in the browser. **Every submitted question sends the extracted text of the entire paper plus up to 29 recent chat messages to OpenAI**, through the local server. API usage may incur charges. This deliberate full-paper context avoids missing distant references but can cost more than retrieval and exceed a smaller model's context window.
- Responses use `store: false`; this is not a claim of zero retention by the API provider.
- Papers, chats and equation corrections are stored on this machine under `~/.local/share/margin/` (override with `MARGIN_DATA_DIR`). Corrections saved by the older version in browser storage are moved into the library the first time that PDF is opened. Delete a paper in the library to remove its PDF copy and chats.
- Markdown is sanitized before display. External answer images are removed. There is no analytics or application request-body logging.

## Limits and troubleshooting

Text extraction is not OCR. Scans need OCR before use. Mathematical symbols, split equation labels, multi-column text, and journal layouts may extract poorly. Equation detection uses isolated parenthesized number candidates, so prose or bibliography labels can be false positives. Highlighting is a band near the label, not a precise semantic equation bounding box. Manual corrections are authoritative.

Supported limits: 60 MB PDF, 300 pages, 600,000 extracted characters total, 30,000 characters per page. The model's own context limit can be lower. Large PDFs and high zoom levels can consume substantial browser memory. The API request has a 120-second timeout and one SDK retry. Quota, authentication, inaccessible-model and general request failures appear below the question box; the question is restored for retry.

If the key is missing, the reader and manual navigation still work. Configure the key and restart/reload to enable answers. This app does not silently substitute another model or generate fake answers.

## Validation and code map

```bash
npm test
npm run build
```

- `server.mjs`: loopback server, settings (`.env`), model list, paper/chat library storage, OpenAI Responses request.
- `lib/config.mjs`: `.env` updating, model filter, validation helpers.
- `src/zoom.js`: zoom limits and pinch/scroll step size.
- `src/main.js`: PDF extraction/rendering, chat, citations, synchronization, manual corrections.
- `src/references.js`: reference parsing and resolution.
- `test/references.test.js`: structured/natural references, ranges, override precedence, ambiguity, invalid pages.
- `test/config.test.js`: `.env` updates, model filter, key validation, names, zoom limits.

Verified during delivery: reference tests, production build, local page rendering, and server rejection paths. Live paid API responses and the actual survey's equation alignment were not verified because no API key or PDF attachment was available.

API implementation follows the official documentation: https://developers.openai.com/api/docs/guides/text
