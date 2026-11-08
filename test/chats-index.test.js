import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../lib/store.mjs';

// What chatSummaries returned before the index existed: every chat file read in full.
async function direct(store, dir, pid) {
  const cdir = join(dir, 'projects', pid, 'chats'), out = [];
  for (const f of await readdir(cdir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    try { out.push(store.chatSummary(JSON.parse(await readFile(join(cdir, f), 'utf8')))); } catch {}
  }
  return JSON.parse(JSON.stringify(out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))));
}
const plain = x => JSON.parse(JSON.stringify(x));

test('chat index: same summaries as reading every chat, kept current through changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'margin-ci-'));
  let store = createStore(dir); await store.init();
  const [p] = await store.listProjects();
  const pid = p.id, paper = 'b'.repeat(64);
  const check = async (msg, s = store) => assert.deepEqual(plain(await s.chatSummaries(pid)), await direct(s, dir, pid), msg);

  const a = await store.newChat(pid, paper), b = await store.newChat(pid, null, 'project');
  await check('new chats');
  assert.equal((await store.listProjects())[0].chats, 2);
  assert.ok(JSON.parse(await readFile(join(dir, 'projects', pid, 'chats-index.json'), 'utf8')).files, 'index written next to the chats folder');

  a.messages.push({role: 'user', content: 'q'}, {role: 'assistant', content: 'a'}); a.updatedAt = new Date(Date.now() + 1000).toISOString(); a.title = 'Renamed';
  await store.saveChat(pid, a);
  await check('saved chat');
  assert.equal((await store.chatSummaries(pid))[0].count, 2);

  // Edited behind the store's back (another Margin version, a sync tool): picked up from size/mtime/inode.
  const fileA = join(dir, 'projects', pid, 'chats', `${a.id}.json`);
  await writeFile(fileA, JSON.stringify({...a, title: 'Edited outside'}, null, 1));
  await check('external edit');
  assert.equal((await store.chatSummaries(pid)).find(c => c.id === a.id).title, 'Edited outside');

  // Same size, only the mtime differs: still noticed.
  const t = JSON.stringify({...a, title: 'Edited outsidX'}, null, 1);
  await writeFile(fileA, t); await utimes(fileA, new Date(), new Date(Date.now() + 5000));
  await check('same-size edit');

  await writeFile(join(dir, 'projects', pid, 'chats', 'broken.json'), '{not json');
  await writeFile(join(dir, 'projects', pid, 'chats', 'notes.txt'), 'x');
  await check('unreadable and non-chat files are skipped');

  await store.deleteChat(pid, b.id);
  await check('deleted chat');

  // A new process: index from disk, then missing, then corrupt.
  store = createStore(dir);
  await check('fresh store with index on disk', store);
  await rm(join(dir, 'projects', pid, 'chats-index.json'));
  store = createStore(dir);
  await check('index missing: rebuilt', store);
  await writeFile(join(dir, 'projects', pid, 'chats-index.json'), '{"v":1,"files":{"x.json":{"s":1,"m":1,"i":1,"c":{"id":"bogus"}}}}garbage');
  store = createStore(dir);
  await check('index corrupt: rebuilt', store);
  // A stale index (entries for files that no longer exist, wrong stats) is corrected.
  await writeFile(join(dir, 'projects', pid, 'chats-index.json'), JSON.stringify({v: 1, files: {[`${a.id}.json`]: {s: 1, m: 1, i: 1, c: {id: a.id, title: 'stale', updatedAt: '2000'}}, 'gone.json': {s: 1, m: 1, i: 1, c: {id: 'gone', updatedAt: '2001'}}}}));
  store = createStore(dir);
  await check('stale index corrected', store);

  // Deleting the project leaves nothing behind.
  const other = await store.createProject('Other');
  await store.newChat(other.id, paper);
  await store.chatSummaries(other.id);
  await store.deleteProject(other.id);
  await store.chatSummaries(other.id);
  assert.deepEqual((await readdir(join(dir, 'projects'))).sort(), [pid]);
  await rm(dir, {recursive: true, force: true});
});
