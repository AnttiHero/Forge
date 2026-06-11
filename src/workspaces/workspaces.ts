/**
 * Matter workspaces — ethical walls, done structurally.
 *
 * Each workspace is its own SQLite file under data/matters/. One workspace
 * is active at a time (like having one case file open on your desk); every
 * engine, every retrieval, and the privacy gateway's defined-terms list all
 * read the active database, so cross-matter contamination is impossible by
 * construction — there is no query that could span two matters.
 *
 * Inactive workspaces can be locked: the database file is encrypted at
 * rest with AES-256-GCM under a passphrase-derived key (scrypt). Locking
 * is for closed files; the active workspace is plaintext while open.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config.js';
import { genId, isDbBusy, openDb, setDb } from '../db/db.js';

export interface WorkspaceMeta {
  id: string;
  name: string;
  file: string;
  locked: boolean;
  createdAt: string;
}

interface Registry {
  activeId: string;
  workspaces: WorkspaceMeta[];
}

const MAGIC = Buffer.from('FORGEWS1');

function registryPath(): string {
  return path.join(path.dirname(path.resolve(config.dbPath)), 'workspaces.json');
}

function mattersDir(): string {
  return path.join(path.dirname(path.resolve(config.dbPath)), 'matters');
}

function readRegistry(): Registry {
  const p = registryPath();
  if (!fs.existsSync(p)) {
    const registry: Registry = {
      activeId: 'default',
      workspaces: [
        {
          id: 'default',
          name: 'Demo — Vulcan Industrial Partners',
          file: path.resolve(config.dbPath),
          locked: false,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    writeRegistry(registry);
    return registry;
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Registry;
}

function writeRegistry(registry: Registry): void {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, p);
}

function find(registry: Registry, id: string): WorkspaceMeta {
  const ws = registry.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`Unknown workspace: ${id}`);
  return ws;
}

export function listWorkspaces(): { activeId: string; workspaces: WorkspaceMeta[] } {
  const r = readRegistry();
  return { activeId: r.activeId, workspaces: r.workspaces };
}

export function getActiveWorkspace(): WorkspaceMeta {
  const r = readRegistry();
  return find(r, r.activeId);
}

export function createWorkspace(name: string): WorkspaceMeta {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Workspace name is required');
  const r = readRegistry();
  const id = genId('ws');
  const file = path.join(mattersDir(), `${id}.db`);
  fs.mkdirSync(mattersDir(), { recursive: true });
  openDb(file).close(); // initialize schema
  const ws: WorkspaceMeta = { id, name: trimmed, file, locked: false, createdAt: new Date().toISOString() };
  r.workspaces.push(ws);
  writeRegistry(r);
  return ws;
}

export function activateWorkspace(id: string): WorkspaceMeta {
  const r = readRegistry();
  const ws = find(r, id);
  if (ws.locked) throw new Error('Workspace is locked — unlock it with its passphrase first.');
  // already active: a no-op, NOT a reopen — setDb would close the live
  // handle out from under any in-flight operation
  if (id === r.activeId) return ws;
  if (isDbBusy()) {
    throw new Error('An operation is still running in the current matter — wait for it to finish before switching.');
  }
  setDb(openDb(ws.file));
  r.activeId = id;
  writeRegistry(r);
  return ws;
}

/** Boot helper: open whatever the registry says is active. */
export function activateOnBoot(): WorkspaceMeta {
  const r = readRegistry();
  let ws = find(r, r.activeId);
  if (ws.locked) {
    // never boot into a locked file — fall back to the default workspace
    ws = find(r, 'default');
    r.activeId = 'default';
    writeRegistry(r);
  }
  setDb(openDb(ws.file));
  return ws;
}

// ── Encryption at rest ───────────────────────────────────────────────────

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // N=2^15, r=8 needs 32 MiB — above Node's default scrypt maxmem, so raise it
  return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

export function lockWorkspace(id: string, passphrase: string): WorkspaceMeta {
  if (passphrase.length < 6) throw new Error('Use a passphrase of at least 6 characters.');
  const r = readRegistry();
  const ws = find(r, id);
  if (ws.id === 'default') throw new Error('The demo workspace cannot be locked.');
  if (ws.locked) throw new Error('Workspace is already locked.');
  if (isDbBusy()) {
    throw new Error('An operation is still running — wait for it to finish before locking.');
  }
  // never lock a file that doesn't exist — openDb would create a fresh
  // EMPTY database and we'd encrypt nothing over the real data
  if (!fs.existsSync(ws.file)) {
    throw new Error('Workspace database file is missing — cannot lock.');
  }
  // a .locked alongside a live plaintext is a stale leftover from an
  // interrupted unlock and is safe to replace; a .locked WITHOUT plaintext
  // would be the only copy of the matter — replacing it loses everything
  // (and we'd only get here in that state after a crash mid-lock)

  if (r.activeId === id) {
    // close the case file before locking it — switch back to the demo
    setDb(openDb(find(r, 'default').file));
    r.activeId = 'default';
  }

  // checkpoint the WAL so the .db file is complete, then drop sidecars
  const db = openDb(ws.file);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(ws.file + ext)) fs.rmSync(ws.file + ext);
  }

  const plaintext = fs.readFileSync(ws.file);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Order matters for crash safety: write the encrypted copy, record the
  // locked state, and only THEN remove the plaintext. A crash at any point
  // leaves at least one complete copy of the matter on disk.
  fs.writeFileSync(`${ws.file}.locked`, Buffer.concat([MAGIC, salt, iv, tag, ciphertext]));
  ws.locked = true;
  writeRegistry(r);
  fs.rmSync(ws.file);
  return ws;
}

export function unlockWorkspace(id: string, passphrase: string): WorkspaceMeta {
  const r = readRegistry();
  const ws = find(r, id);
  if (!ws.locked) throw new Error('Workspace is not locked.');

  const blob = fs.readFileSync(`${ws.file}.locked`);
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Locked file is corrupt or not a Forge workspace.');
  const salt = blob.subarray(8, 24);
  const iv = blob.subarray(24, 36);
  const tag = blob.subarray(36, 52);
  const ciphertext = blob.subarray(52);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase.');
  }

  // Same crash-safety order as locking: restore the plaintext, record the
  // unlocked state, then drop the encrypted copy. An interrupted unlock
  // leaves a stale .locked next to the live file, which lockWorkspace
  // safely replaces.
  fs.writeFileSync(ws.file, plaintext);
  ws.locked = false;
  writeRegistry(r);
  fs.rmSync(`${ws.file}.locked`);
  return ws;
}
