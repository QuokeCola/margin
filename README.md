# Margin

**Read a research paper beside an AI tutor whose citations jump to the exact page and equation.**

Margin puts a chat on the left and the PDF on the right. Answers cite pages, equations and quoted sentences, and every citation is clickable: equations get a tight frame in the PDF, quotes are highlighted word for word. Select text or click an equation in the PDF to ask about it. Papers and their chats are kept in a local library. It runs on your computer with your own OpenAI API key.

![Margin demo: asking a question, following equation and quote citations, zooming, and asking about an equation](docs/images/demo.gif)

## Download

Get the latest build from **[Releases](https://github.com/QuokeCola/margin/releases/latest)**:

| System | File | Notes |
|---|---|---|
| Linux | `Margin-<version>-linux-x86_64.AppImage` | `chmod +x Margin-*.AppImage`, then run it. |
| Debian / Ubuntu | `Margin-<version>-linux-amd64.deb` | `sudo apt install ./Margin-*.deb` |
| Windows | `Margin-<version>-win-x64.exe` | Installer. The app is not code-signed, so SmartScreen may warn: **More info → Run anyway**. |
| macOS (Apple silicon / Intel) | `Margin-<version>-mac-arm64.dmg` / `-mac-x64.dmg` | Not notarized. First launch: right-click the app → **Open**, or **System Settings → Privacy & Security → Open Anyway**. |

### Set up your OpenAI key

1. Create a key at **[platform.openai.com/api-keys](https://platform.openai.com/api-keys)** (**Create new secret key**). Add credit under [Billing](https://platform.openai.com/settings/organization/billing/overview) if your account has none; answers are billed per use.
2. In Margin, click **Settings**, paste the key and click **Save**. It is checked with OpenAI and stored only on your computer (desktop app: `~/.config/Margin`, `%APPDATA%\Margin` or `~/Library/Application Support/Margin`).
3. Pick a model from the **Model** menu in the header.

## Screenshots

| Equations in answers link to a frame in the PDF | Quotes are highlighted word for word |
|---|---|
| ![Answer with linked equations and the cited equation framed in the PDF](docs/images/answer-equation.png) | ![A quoted sentence highlighted in the PDF](docs/images/answer-quote.png) |
| **Click an equation in the PDF to ask about it** | **The equation is attached as an image** |
| ![Ask AI button over an equation in the PDF](docs/images/ask-equation.png) | ![Equation image attached to the question](docs/images/equation-attached.png) |

![Settings with API key setup steps and model choice](docs/images/settings.png)

The screenshots use an original demo paper (`docs/demo/paper.html`).

## Run from source

Requires Node.js 22.12+ (Node 24 LTS recommended).

```bash
git clone https://github.com/QuokeCola/margin.git
cd margin
npm ci
npm run app          # desktop window (Electron)
# or, in a browser:
npm run dev          # then open http://127.0.0.1:4317
```

In browser mode the key is saved to `.env` in the project folder (mode 600); `PORT` in `.env` changes the port. Hand edits to `.env` need a server restart. `npm run build && npm start` serves the built version.

Build installers with `npm run dist:linux`, `npm run dist:win` (works on Linux with Wine) or `npm run dist:mac` (macOS only). Pushing a tag such as `v1.0.1` runs `.github/workflows/release.yml`, which builds all four on Linux, Windows and macOS runners and publishes a GitHub Release.

## Study workflow

1. Click **+ Add PDF** in the library and select a paper. A copy is stored in the library (`~/.local/share/margin/papers/<sha256>/`), so it reopens from the sidebar later; adding the same file again opens the existing entry.
   Each paper can have any number of chats. **+ New chat** starts one; click a chat to switch, double-click a paper or chat to rename it, and use × to delete. Chats are saved after every answer, with the model and time of each reply. ☰ hides the library.
2. Ask a question; Enter sends it, and Ctrl+Enter (or Shift+Enter) adds a line break. Each question sends the paper text, the last 28 messages of the current chat and the tutor instructions; the model has no memory beyond that, and other chats are not shared.
3. Citations are clickable where they appear: inline chips such as `Eq. (46) · p. 7`, plain mentions such as “Eq. (61)” or “p. 4” (dotted underline), and equations reproduced from the paper (outlined on the left, with a badge); click one to jump to its source. The chips are repeated at the bottom of each answer. Click an answer or a citation chip to navigate. With **Follow chat** enabled, scrolling to an older answer moves the PDF to its first reference. If an answer has several citations, select a specific chip. Turn following off to explore the PDF independently; explicit citation clicks still work.
4. Page citations outline the page. Equation citations draw a frame around the detected equation (its number plus the neighbouring lines that look like math, within the column). Quotes in answers (`[[quote:7|exact words]]`, shown in italics) highlight those exact words in the PDF; matching ignores spacing, hyphenation and punctuation, and falls back to the cited page.
   **Ask about the PDF:** select text on a page and click **Ask AI about this ↗** to attach the passage to your next question; or hover an equation (dashed outline) and click it, then **Ask AI about Eq. (n) ↗** to attach a cropped image of it (the model reads the image, because extracted text garbles math). Press Enter with an empty box to have the passage or equation explained. Equation detection only accepts numbers like “(12)” at the right edge of a column. Manual corrections use a horizontal band. Missing equation coordinates fall back to a cited page; ambiguous locations without a page require correction.
5. In **Find a reference / correct an equation location**, enter an equation number and click **Find equation**. To correct it, enter the actual PDF page and position from the top, or click the page with this panel open, then **Save correction**. **Remove correction** returns to automatic detection.
6. **Zoom**: pinch the trackpad (or Ctrl + scroll) over the PDF to zoom around the cursor, or use − / % / +. Range 50–300%; the zoom level is remembered.

Page numbers always mean 1-based PDF positions, not printed journal page numbers. Example: `[[eq:61|p:11]]` or `[[p:11]]`. The parser also recognizes `Eq. (61)`, `Equation 61 on page 11`, `Eqs. 57–58`, and `p. 11`. Model citations and detected labels must be checked against the original.

## Privacy and security

- The server binds only to `127.0.0.1`, validates Host and Origin, and requires a random per-launch session token for every API call except status (settings, library, chats and model calls). No CORS access is enabled. It is a local tool, not a multi-user hosting service; do not expose it through a tunnel.
- Your API key stays in the server environment / ignored `.env` (desktop app: `settings.env` in the app's config folder). It is never returned by the status endpoint, stored in the browser, or bundled into client JavaScript. Do not commit or share `.env`.
- PDF bytes are parsed in the browser. **Every submitted question sends the extracted text of the entire paper plus up to 28 recent chat messages to OpenAI**, through the local server. API usage may incur charges. This deliberate full-paper context avoids missing distant references but can cost more than retrieval and exceed a smaller model's context window.
- Responses use `store: false`; this is not a claim of zero retention by the API provider.
- Papers, chats and equation corrections are stored on this machine under `~/.local/share/margin/` (Linux, both browser and desktop app) or in `library` inside the desktop app's config folder on Windows and macOS. `MARGIN_DATA_DIR` overrides the location. Corrections saved by the older version in browser storage are moved into the library the first time that PDF is opened. Delete a paper in the library to remove its PDF copy and chats.
- Markdown is sanitized before display. External answer images are removed. There is no analytics or application request-body logging.

## Limits and troubleshooting

Text extraction is not OCR. Scans need OCR before use. Mathematical symbols, split equation labels, multi-column text, and journal layouts may extract poorly. Equation detection accepts “(12)”-style numbers at the right edge of a text column; frames are built from text positions, so unusual layouts can still be framed loosely. Manual corrections are authoritative.

Supported limits: 60 MB PDF, 300 pages, 600,000 extracted characters total, 30,000 characters per page. The model's own context limit can be lower. Large PDFs and high zoom levels can consume substantial browser memory. The API request has a 120-second timeout and one SDK retry. Quota, authentication, inaccessible-model and general request failures appear below the question box; the question is restored for retry.

If the key is missing, the reader and manual navigation still work. Add the key in Settings to enable answers. This app does not silently substitute another model or generate fake answers.

## Validation and code map

```bash
npm test
npm run build
```

- `electron/main.mjs`: desktop shell; starts the server on a free local port and opens the window.
- `server.mjs`: loopback server, settings (`.env`), model list, paper/chat library storage, OpenAI Responses request.
- `lib/config.mjs`: `.env` updating, model filter, validation helpers.
- `src/zoom.js`: zoom limits and pinch/scroll step size.
- `src/layout.js`: equation-number filter, equation frames and quote matching from pdf.js text-item geometry.
- `src/main.js`: PDF extraction/rendering, chat, citations, synchronization, manual corrections.
- `src/references.js`: reference parsing and resolution.
- `test/references.test.js`: structured/natural references, ranges, override precedence, ambiguity, invalid pages.
- `test/config.test.js`: `.env` updates, model filter, key validation, names, zoom limits.

API implementation follows the official documentation: https://developers.openai.com/api/docs/guides/text
