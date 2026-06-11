import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from '../config.js';
import { getDb, setDb } from '../db/db.js';
import {
  activateWorkspace,
  createWorkspace,
  listWorkspaces,
  lockWorkspace,
  unlockWorkspace,
} from './workspaces.js';

describe('matter workspaces (ethical walls)', () => {
  let dir: string;
  let originalDbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ws-'));
    originalDbPath = config.dbPath;
    (config as { dbPath: string }).dbPath = path.join(dir, 'forge.db');
    setDb(null);
  });

  afterEach(() => {
    setDb(null);
    (config as { dbPath: string }).dbPath = originalDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('isolates matters: a fund in workspace A is invisible from workspace B', () => {
    activateWorkspace('default');
    const a = createWorkspace('Client A — Fund I');
    const b = createWorkspace('Client B — Fund II');

    activateWorkspace(a.id);
    getDb()
      .prepare(`INSERT INTO funds (id, name, numeral, target_size_usd, status, vintage) VALUES ('f-a', 'Client A Secret Fund', 1, 1, 'forming', 2026)`)
      .run();
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM funds`).get()).toEqual({ n: 1 });

    activateWorkspace(b.id);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM funds`).get()).toEqual({ n: 0 });
    expect(getDb().prepare(`SELECT * FROM funds WHERE name LIKE '%Secret%'`).all()).toEqual([]);

    activateWorkspace(a.id);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM funds`).get()).toEqual({ n: 1 });
  });

  it('locks a workspace: file encrypted on disk, unreadable, then restored intact', () => {
    activateWorkspace('default');
    const ws = createWorkspace('Lockable Matter');
    activateWorkspace(ws.id);
    getDb()
      .prepare(`INSERT INTO funds (id, name, numeral, target_size_usd, status, vintage) VALUES ('f-l', 'Confidential LP Fund', 1, 1, 'forming', 2026)`)
      .run();

    lockWorkspace(ws.id, 'hunter22');
    expect(fs.existsSync(ws.file)).toBe(false);
    const blob = fs.readFileSync(`${ws.file}.locked`);
    expect(blob.subarray(0, 8).toString()).toBe('FORGEWS1');
    expect(blob.includes(Buffer.from('Confidential LP Fund'))).toBe(false); // ciphertext, not plaintext
    expect(listWorkspaces().workspaces.find((w) => w.id === ws.id)?.locked).toBe(true);
    // locked workspaces cannot be opened
    expect(() => activateWorkspace(ws.id)).toThrow(/locked/i);

    unlockWorkspace(ws.id, 'hunter22');
    activateWorkspace(ws.id);
    expect(getDb().prepare(`SELECT name FROM funds WHERE id = 'f-l'`).get()).toEqual({ name: 'Confidential LP Fund' });
  });

  it('rejects the wrong passphrase and leaves the file locked', () => {
    activateWorkspace('default');
    const ws = createWorkspace('Wrong-pass Matter');
    lockWorkspace(ws.id, 'correct-horse');
    expect(() => unlockWorkspace(ws.id, 'wrong-horse')).toThrow(/wrong passphrase/i);
    expect(fs.existsSync(`${ws.file}.locked`)).toBe(true);
    expect(fs.existsSync(ws.file)).toBe(false);
  });

  it('locking the active workspace closes it and falls back to the demo', () => {
    activateWorkspace('default');
    const ws = createWorkspace('Active Lock');
    activateWorkspace(ws.id);
    lockWorkspace(ws.id, 'shut-it-down');
    expect(listWorkspaces().activeId).toBe('default');
  });

  it('refuses to lock the demo workspace', () => {
    activateWorkspace('default');
    expect(() => lockWorkspace('default', 'whatever')).toThrow(/demo/i);
  });

  it('re-activating the active workspace is a no-op, not a handle churn (sweep #9)', () => {
    activateWorkspace('default');
    const ws = createWorkspace('Sticky Matter');
    activateWorkspace(ws.id);
    const handle = getDb();
    activateWorkspace(ws.id); // again — must not close/reopen
    expect(getDb()).toBe(handle);
    expect(() => handle.prepare('SELECT 1').get()).not.toThrow();
  });

  it('refuses to lock when the database file is missing instead of encrypting an empty one (sweep #10)', () => {
    activateWorkspace('default');
    const ws = createWorkspace('Ghost Matter');
    fs.rmSync(ws.file);
    expect(() => lockWorkspace(ws.id, 'passphrase')).toThrow(/missing/i);
  });

  it('an interrupted unlock leaves a stale .locked that relocking safely replaces (sweep #10)', () => {
    activateWorkspace('default');
    const ws = createWorkspace('Resilient Matter');
    activateWorkspace(ws.id);
    getDb()
      .prepare(`INSERT INTO funds (id, name, numeral, target_size_usd, status, vintage) VALUES ('f-r', 'Real Data', 1, 1, 'forming', 2026)`)
      .run();
    lockWorkspace(ws.id, 'first-pass');
    unlockWorkspace(ws.id, 'first-pass');
    // simulate the crash window: plaintext restored, registry unlocked, but
    // the old .locked never got removed
    fs.copyFileSync(ws.file, `${ws.file}.stale`);
    lockWorkspace(ws.id, 'second-pass'); // must replace, not refuse or lose data
    unlockWorkspace(ws.id, 'second-pass');
    activateWorkspace(ws.id);
    expect(getDb().prepare(`SELECT name FROM funds WHERE id = 'f-r'`).get()).toEqual({ name: 'Real Data' });
    fs.rmSync(`${ws.file}.stale`);
  });
});
