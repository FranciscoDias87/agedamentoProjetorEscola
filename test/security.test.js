import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { issueInvite, digest, saveBackup } from '../security.js';

test('convites, coordenação, recuperação, sessões, origem e backup restaurável', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agenda-security-'));
  const database = path.join(dir, 'agenda.sqlite');
  const server = createApp({ database });
  const db = new DatabaseSync(database);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, body, cookie, headers = {}) {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const adminEmail = 'coord@escola.test', teacherEmail = 'prof@escola.test', password = 'uma-senha-longa-123';
  const admin = await call('/api/register', { name: 'Coordenação', email: adminEmail, password, inviteCode: issueInvite(db, adminEmail) });
  db.prepare("UPDATE users SET role='admin' WHERE email=?").run(adminEmail);
  const invite = await call('/api/admin/invites', { email: teacherEmail }, admin.cookie);
  assert.equal(invite.status, 201);
  assert.equal((await call('/api/register', { name: 'Outra', email: 'outra@escola.test', password, inviteCode: invite.data.invite })).status, 403);
  const expired = issueInvite(db, 'expired@escola.test'); db.prepare('UPDATE invites SET expires=0 WHERE hash=?').run(digest(expired));
  assert.equal((await call('/api/register', { name: 'Expirada', email: 'expired@escola.test', password, inviteCode: expired })).status, 403);
  const teacherBody = { name: 'Professor', email: teacherEmail, password, inviteCode: invite.data.invite, role: 'admin' };
  const teacher = await call('/api/register', teacherBody); assert.equal(teacher.status, 200);
  assert.equal((await call('/api/register', teacherBody)).status, 403);
  assert.equal((await call('/api/me', null, teacher.cookie)).data.role, 'teacher');
  assert.equal((await call('/api/admin/users', null, teacher.cookie)).status, 403);
  assert.equal((await call('/api/admin/invites', { email: 'no@escola.test' }, teacher.cookie)).status, 403);
  assert.equal((await call('/api/logout', {}, teacher.cookie, { Origin: 'https://evil.example' })).status, 403);
  const rawToken = teacher.cookie.split('=')[1];
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token=?').get(rawToken), undefined);
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token=?').get(digest(rawToken)));
  const recovery = await call(`/api/admin/users/${teacher.data.id}/recovery`, {}, admin.cookie);
  assert.equal(recovery.status, 201);
  db.prepare('UPDATE resets SET expires=0 WHERE hash=?').run(digest(recovery.data.code));
  assert.equal((await call('/api/reset', { email: teacherEmail, password, resetCode: recovery.data.code })).status, 403);
  const renewedRecovery = await call(`/api/admin/users/${teacher.data.id}/recovery`, {}, admin.cookie);
  const newPassword = 'outra-senha-longa-456';
  const resetBody = { email: teacherEmail, password: newPassword, resetCode: renewedRecovery.data.code };
  assert.equal((await call('/api/reset', resetBody)).status, 200);
  assert.equal((await call('/api/reset', resetBody)).status, 403);
  assert.equal((await call('/api/me', null, teacher.cookie)).status, 401);
  assert.equal((await call('/api/login', { email: teacherEmail, password })).status, 401);
  const nextSession = await call('/api/login', { email: teacherEmail, password: newPassword }); assert.equal(nextSession.status, 200);
  const disable = await fetch(base + '/api/admin/users/' + teacher.data.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: JSON.stringify({ active: false }) });
  assert.equal(disable.status, 200);
  assert.equal((await call('/api/me', null, nextSession.cookie)).status, 401);
  assert.equal((await call('/api/login', { email: teacherEmail, password: newPassword })).status, 401);
  const audit = await call('/api/admin/audit', null, admin.cookie);
  assert.ok(audit.data.some(row => row.action === 'account.disabled'));
  assert.ok(!JSON.stringify(audit.data).includes(recovery.data.code));
  const backupFile = await saveBackup(db, path.join(dir, 'backups'));
  const restored = new DatabaseSync(backupFile); assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n, 2); restored.close();
  for (let i = 0; i < 10; i++) await call('/api/login', { email: 'invalid@escola.test', password });
  assert.equal((await call('/api/login', { email: 'invalid@escola.test', password })).status, 429);
});

test('HTTPS obrigatório ao habilitar cookies seguros', () => {
  assert.throws(() => createApp({ secureCookie: true }), /HTTPS/);
  assert.throws(() => createApp({ secureCookie: true, publicOrigin: 'http://escola.test' }), /HTTPS/);
});

test('migração preserva contas e reservas e encerra sessões antigas', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agenda-migration-'));
  const database = path.join(dir, 'agenda.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE,salt TEXT,hash TEXT);
    INSERT INTO users VALUES(1,'Professor','prof@escola.test','salt','hash');
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER);
    INSERT INTO sessions VALUES('old-token',1,9999999999999);
    CREATE TABLE bookings(id INTEGER PRIMARY KEY,user_id INTEGER,classroom TEXT,day TEXT,start TEXT,end TEXT,status TEXT);
    INSERT INTO bookings VALUES(1,1,'2 ANO','2099-01-10','09:00','10:00','confirmed');`);
  legacy.close();
  const server = createApp({ database });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const db = new DatabaseSync(database);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT role FROM users WHERE id=1').get().role, 'teacher');
  assert.equal(db.prepare('SELECT classroom FROM bookings WHERE id=1').get().classroom, '2 ANO');
});
