import { createHash, randomBytes } from 'node:crypto';
import { backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function migrateSecurity(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!columns.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'teacher'");
  if (!columns.includes('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  db.exec(`CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor INTEGER, action TEXT NOT NULL, target TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS security_meta (key TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS resets (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  if (!db.prepare("SELECT 1 FROM security_meta WHERE key='hashed_sessions'").get()) {
    db.exec("DELETE FROM sessions; INSERT INTO security_meta VALUES('hashed_sessions')");
  }
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function audit(db, actor, action, target) { db.prepare('INSERT INTO audit(actor,action,target) VALUES(?,?,?)').run(actor, action, String(target)); }
export function issueInvite(db, email, hours = 48) {
  const token = randomBytes(32).toString('hex');
  db.prepare('UPDATE invites SET used=1 WHERE email=? AND used=0').run(email);
  db.prepare('INSERT INTO invites(hash,email,expires) VALUES(?,?,?)').run(digest(token), email, Date.now() + hours * 3600000);
  return token;
}
export async function saveBackup(db, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `agenda-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.sqlite`);
  await backup(db, destination);
  return destination;
}
