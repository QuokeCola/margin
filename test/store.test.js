import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readdir, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../lib/store.mjs';
import {cleanDoi, titleSimilarity, fromOpenAlex} from '../lib/metadata.mjs';

const pdf = s => Buffer.from(`%PDF-1.4\n% ${s}\n`);

test('1.x library migrates into a default project; old chats are copied, not moved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'margin-'));
  const id = 'a'.repeat(64), old = join(dir, 'papers', id);
  await mkdir(join(old, 'chats'), {recursive: true});
  await writeFile(join(old, 'paper.json'), JSON.stringify({id, name: 'Old paper', addedAt: '2026-01-01T00:00:00Z', openedAt: '2026-01-01T00:00:00Z', overrides: {}}));
  await writeFile(join(old, 'chats', '0123456789abcdef.json'), JSON.stringify({id: '0123456789abcdef', title: 'Q', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', messages: [{role: 'user', content: 'hi'}]}));
  const store = createStore(dir);
  await store.init();
  const [p] = await store.listProjects();
  assert.equal(p.name, 'My papers'); assert.equal(p.papers, 1); assert.equal(p.chats, 1);
  const [c] = await store.chatSummaries(p.id);
  assert.equal(c.paperId, id);
  assert.ok(await stat(join(old, 'chats', '0123456789abcdef.json')), 'old chat file is kept');
  await store.init(); // second start: no second project
  assert.equal((await store.listProjects()).length, 1);
  await rm(dir, {recursive: true, force: true});
});

test('papers are shared across projects and removed only when no project uses them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'margin-'));
  const store = createStore(dir); await store.init();
  const [a] = await store.listProjects(), b = await store.createProject('Second');
  const paper = await store.addPaper(pdf('x'), 'x.pdf');
  await store.addToProject(a.id, paper.id); await store.addToProject(b.id, paper.id);
  await store.newChat(a.id, paper.id);
  const whole = await store.newChat(a.id, paper.id, 'project');
  assert.equal(whole.paperId, null); assert.equal(whole.scope, 'project');
  await store.removeFromProject(a.id, paper.id);
  assert.deepEqual((await store.chatSummaries(a.id)).map(c => [c.id, c.scope]), [[whole.id, 'project']], 'chats about the paper go with it; project chats stay');
  assert.ok(await store.loadPaper(paper.id), 'still used by the second project');
  await store.deleteProject(b.id);
  assert.equal(await store.loadPaper(paper.id), null, 'orphaned paper is removed');
  assert.deepEqual(await readdir(join(dir, 'papers')), []);
  await rm(dir, {recursive: true, force: true});
});

test('metadata helpers', () => {
  assert.equal(cleanDoi('https://doi.org/10.1109/TRO.2017.2723903.'), '10.1109/tro.2017.2723903');
  assert.equal(cleanDoi('doi: 10.1016/j.cirp.2016.04.112)'), '10.1016/j.cirp.2016.04.112');
  assert.equal(cleanDoi('no doi here'), null);
  assert.ok(titleSimilarity('Robot Collisions: A Survey on Detection, Isolation, and Identification', 'Robot collisions: a survey on detection, isolation and identification') > 0.95);
  assert.ok(titleSimilarity('Robot Collisions survey', 'Ball screw nut design') < 0.2);
  const m = fromOpenAlex({id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/ABC', title: 'T', authorships: [{author: {display_name: 'A B'}}], publication_year: 2020, abstract_inverted_index: {world: [1], hello: [0]}, referenced_works: ['https://openalex.org/W2']});
  assert.deepEqual([m.openalexId, m.doi, m.abstract, m.references[0]], ['W1', '10.1234/abc', 'hello world', 'W2']);
});
