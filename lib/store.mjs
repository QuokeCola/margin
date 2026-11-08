// On-disk library: a shared paper store plus projects that group papers and hold chats.
//   papers/<sha256>/paper.json, paper.pdf       (one copy per PDF, shared by projects)
//   projects/<id>/project.json                   ({id, name, papers: [paperId…], …})
//   projects/<id>/chats/<chatId>.json            ({id, title, scope, paperId, messages, …}); scope 'paper' (paperId set) or 'project'
//   projects/<id>/chats-index.json               chat summaries keyed by file name, with each file's size/mtime/inode
//                                                (a cache: rebuilt from the chat files when missing, stale or unreadable)
//   papers/<id>/text.json, chunks.json, vectors.f32  search index for project chats (lib/project-index.mjs)
import {randomBytes, createHash} from 'node:crypto';
import {join, dirname} from 'node:path';
import {mkdir, readFile, writeFile, rename, readdir, rm, stat} from 'node:fs/promises';
import {PAPER_ID, CHAT_ID, cleanName} from './config.mjs';

export const PROJECT_ID = /^[0-9a-f]{12}$/;
const CHAT_INDEX_V = 1;
const now = () => new Date().toISOString();
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function writeAtomic(file, data, mode = 0o600) {
  await mkdir(dirname(file), {recursive: true});
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, {mode});
  await rename(tmp, file);
}

export function createStore(dataDir) {
  const PAPERS = join(dataDir, 'papers'), PROJECTS = join(dataDir, 'projects');
  const paperDir = id => join(PAPERS, id), projectDir = pid => join(PROJECTS, pid);
  const chatFile = (pid, cid) => join(projectDir(pid), 'chats', `${cid}.json`);

  // ---- papers (shared store) ----
  const loadPaper = id => PAPER_ID.test(id) ? readJson(join(paperDir(id), 'paper.json')).catch(() => null) : Promise.resolve(null);
  const savePaper = p => writeAtomic(join(paperDir(p.id), 'paper.json'), JSON.stringify(p, null, 1));
  async function addPaper(buf, filename) {
    const id = createHash('sha256').update(buf).digest('hex');
    let p = await loadPaper(id);
    if (!p) {
      p = {id, name: cleanName(String(filename || '').replace(/\.pdf$/i, '')), addedAt: now(), openedAt: now(), overrides: {}};
      await writeAtomic(join(paperDir(id), 'paper.pdf'), buf);
      await savePaper(p);
    }
    return p;
  }
  const pdfPath = id => ({root: paperDir(id), file: 'paper.pdf'});
  const paperSummary = p => ({id: p.id, name: p.name, addedAt: p.addedAt, openedAt: p.openedAt,
    meta: p.meta ? {title: p.meta.title, authors: (p.meta.authors || []).slice(0, 3), authorCount: (p.meta.authors || []).length, year: p.meta.year, venue: p.meta.venue, doi: p.meta.doi, openalexId: p.meta.openalexId} : null});

  // ---- projects ----
  const loadProject = pid => PROJECT_ID.test(pid) ? readJson(join(projectDir(pid), 'project.json')).catch(() => null) : Promise.resolve(null);
  const saveProject = p => writeAtomic(join(projectDir(p.id), 'project.json'), JSON.stringify(p, null, 1));
  async function createProject(name) {
    const p = {id: randomBytes(6).toString('hex'), name: cleanName(name, 'Untitled project').slice(0, 100), createdAt: now(), updatedAt: now(), papers: []};
    await saveProject(p);
    return p;
  }
  async function listProjects() {
    const ids = (await readdir(PROJECTS).catch(() => [])).filter(id => PROJECT_ID.test(id));
    const out = [];
    for (const id of ids) {
      const p = await loadProject(id);
      if (p) out.push({id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, papers: p.papers.length, chats: (await chatSummaries(id)).length});
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  // Papers no project refers to any more are removed from the store.
  async function dropOrphans(ids) {
    const projects = await Promise.all((await readdir(PROJECTS).catch(() => [])).filter(id => PROJECT_ID.test(id)).map(loadProject));
    const used = new Set(projects.filter(Boolean).flatMap(p => p.papers));
    for (const id of ids) if (PAPER_ID.test(id) && !used.has(id)) await rm(paperDir(id), {recursive: true, force: true});
  }
  async function deleteProject(pid) {
    const p = await loadProject(pid); if (!p) return;
    chatIndex.delete(pid);
    await rm(projectDir(pid), {recursive: true, force: true});
    await dropOrphans(p.papers);
  }
  async function addToProject(pid, paperId) {
    const p = await loadProject(pid); if (!p) return null;
    if (!p.papers.includes(paperId)) { p.papers.push(paperId); p.updatedAt = now(); await saveProject(p); }
    return p;
  }
  // Removing a paper from a project also removes the project's chats about it.
  async function removeFromProject(pid, paperId) {
    const p = await loadProject(pid); if (!p) return null;
    p.papers = p.papers.filter(id => id !== paperId); p.updatedAt = now(); await saveProject(p);
    for (const c of await chatSummaries(pid)) if (c.scope === 'paper' && c.paperId === paperId) await rm(chatFile(pid, c.id), {force: true});
    await dropOrphans([paperId]);
    return p;
  }

  // ---- chats (per project; about one paper or the whole project) ----
  // Summaries come from chats-index.json: an entry is reused while its chat file has the same size,
  // mtime and inode, so only new or changed chat files are read (chats can be megabytes with images).
  // The index is only a cache; results are the same as reading every chat file.
  const chatIndex = new Map(); // pid -> Map(file name -> {s, m, i, c: summary | null})
  const indexFile = pid => join(projectDir(pid), 'chats-index.json');
  async function loadChatIndex(pid) {
    if (chatIndex.has(pid)) return chatIndex.get(pid);
    const raw = await readJson(indexFile(pid)).catch(() => null);
    const idx = new Map(raw?.v === CHAT_INDEX_V && raw.files && typeof raw.files === 'object' ? Object.entries(raw.files) : []);
    chatIndex.set(pid, idx);
    return idx;
  }
  async function chatSummaries(pid) {
    const dir = join(projectDir(pid), 'chats');
    const files = await readdir(dir).catch(() => null);
    if (!files) return [];
    const idx = await loadChatIndex(pid), next = new Map();
    let changed = false;
    const entries = await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => {
      const st = await stat(join(dir, f)).catch(() => null);
      if (!st?.isFile()) return null;
      const old = idx.get(f);
      if (old && old.s === st.size && old.m === st.mtimeMs && old.i === st.ino) return [f, old];
      let c = null;
      try { c = chatSummary(await readJson(join(dir, f))); } catch {}
      changed = true;
      return [f, {s: st.size, m: st.mtimeMs, i: st.ino, c}];
    }));
    const chats = [];
    for (const e of entries) if (e) { next.set(e[0], e[1]); if (e[1].c) chats.push(e[1].c); }
    if (changed || next.size !== idx.size) {
      chatIndex.set(pid, next);
      await writeAtomic(indexFile(pid), JSON.stringify({v: CHAT_INDEX_V, files: Object.fromEntries(next)})).catch(() => {});
    }
    return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const chatSummary = c => ({id: c.id, title: c.title, scope: c.scope === 'project' ? 'project' : 'paper', paperId: c.paperId ?? null, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length});
  const loadChat = (pid, cid) => PROJECT_ID.test(pid) && CHAT_ID.test(cid) ? readJson(chatFile(pid, cid)).catch(() => null) : Promise.resolve(null);
  const saveChat = (pid, c) => writeAtomic(chatFile(pid, c.id), JSON.stringify(c, null, 1));
  const deleteChat = (pid, cid) => rm(chatFile(pid, cid), {force: true});
  // A chat is about one paper (scope 'paper') or about all papers of the project (scope 'project').
  async function newChat(pid, paperId, scope = 'paper') {
    const c = {id: randomBytes(8).toString('hex'), title: 'New chat', scope: scope === 'project' ? 'project' : 'paper', paperId: scope === 'project' ? null : paperId ?? null, createdAt: now(), updatedAt: now(), messages: []};
    await saveChat(pid, c);
    return c;
  }

  // ---- startup and one-time migration from the 1.x layout (papers/<id>/chats/) ----
  // Old chats are copied, never moved or deleted, so a failed migration cannot lose anything.
  async function init() {
    await mkdir(PAPERS, {recursive: true}); await mkdir(PROJECTS, {recursive: true});
    const marker = join(dataDir, '.migrated-v2');
    if (await stat(marker).catch(() => null)) return;
    const existing = await listProjects();
    if (!existing.length) {
      const project = await createProject('My papers');
      const papers = (await Promise.all((await readdir(PAPERS).catch(() => [])).filter(id => PAPER_ID.test(id)).map(loadPaper))).filter(Boolean)
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
      project.papers = papers.map(p => p.id);
      await saveProject(project);
      for (const p of papers) {
        const dir = join(paperDir(p.id), 'chats');
        for (const f of await readdir(dir).catch(() => [])) {
          if (!f.endsWith('.json')) continue;
          try {
            const c = await readJson(join(dir, f));
            if (CHAT_ID.test(c.id)) await saveChat(project.id, {...c, paperId: p.id});
          } catch {}
        }
      }
    }
    await writeFile(marker, now() + '\n', {mode: 0o600});
  }

  return {init, loadPaper, savePaper, addPaper, pdfPath, paperSummary,
    loadProject, saveProject, createProject, listProjects, deleteProject, addToProject, removeFromProject,
    chatSummaries, chatSummary, loadChat, saveChat, deleteChat, newChat};
}
