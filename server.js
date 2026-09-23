import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { digest, migrateSecurity, transaction, audit, issueInvite, saveBackup } from './security.js';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ database = ':memory:', requireApproval = false, secureCookie = false, publicOrigin, backupDirectory } = {}) {
  if (secureCookie && (!publicOrigin || new URL(publicOrigin).protocol !== 'https:')) throw new Error('Configure PUBLIC_ORIGIN com a origem HTTPS.');
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), classroom TEXT NOT NULL, day TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('confirmed','pending','cancelled','rejected')));
    CREATE TRIGGER IF NOT EXISTS prevent_overlap BEFORE INSERT ON bookings WHEN NEW.status IN ('confirmed','pending') BEGIN
      SELECT RAISE(ABORT, 'overlap') WHERE EXISTS (SELECT 1 FROM bookings WHERE day=NEW.day AND status IN ('confirmed','pending') AND start<NEW.end AND end>NEW.start);
    END;
    CREATE TRIGGER IF NOT EXISTS prevent_overlap_update BEFORE UPDATE ON bookings WHEN NEW.status IN ('confirmed','pending') BEGIN
      SELECT RAISE(ABORT, 'overlap') WHERE EXISTS (SELECT 1 FROM bookings WHERE id<>NEW.id AND day=NEW.day AND status IN ('confirmed','pending') AND start<NEW.end AND end>NEW.start);
    END;`);
  migrateSecurity(db);
  let backupTask;
  const runBackup = () => {
    if (!backupTask) backupTask = saveBackup(db, backupDirectory).catch(err => console.error('Falha no backup:', err.message)).finally(() => { backupTask = null; });
    return backupTask;
  };
  const backupTimer = backupDirectory ? setInterval(runBackup, 86400000) : null;
  backupTimer?.unref();
  if (backupDirectory) runBackup();
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  const text = (v, max) => typeof v === 'string' && v.trim().length <= max ? v.trim() : '';
  function slot(body) {
    const { day, start, end } = body;
    const classroom = text(body.classroom, 80);
    if (!classroom || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) fail('Informe turma, data e um intervalo válido.');
    const parsed = new Date(day + 'T12:00:00Z');
    if (isNaN(parsed) || parsed.toISOString().slice(0, 10) !== day) fail('Data inválida.');
    const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    if (`${day} ${start}` < now) fail('Escolha um horário futuro.');
    return { day, start, end, classroom };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript' });
        res.end(readFileSync(path.join(root, 'public', file))); return;
      }
      let body = {};
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.headers['sec-fetch-site'] === 'cross-site') fail('Origem inválida.', 403);
        if (req.headers.origin && req.headers.origin !== (publicOrigin || `http://${req.headers.host}`)) fail('Origem inválida.', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) fail('Formato inválido.', 415);
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) fail('Pedido muito grande.', 413); }
        try { body = JSON.parse(raw || '{}'); } catch { fail('Pedido inválido.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Pedido inválido.');
      }
      const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const user = token && db.prepare('SELECT users.id, name, role FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND active=1').get(digest(token), Date.now());
      if (req.method === 'POST' && ['/api/login', '/api/register', '/api/reset'].includes(url.pathname)) {
        const email = text(body.email, 200).toLowerCase(), password = typeof body.password === 'string' ? body.password : '';
        db.prepare('DELETE FROM auth_limits WHERE expires<?').run(Date.now());
        for (const [key, limit] of [[digest('email:' + email), 10], [digest('ip:' + req.socket.remoteAddress), 100]]) {
          db.prepare('INSERT INTO auth_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, Date.now() + 900000);
          if (db.prepare('SELECT count FROM auth_limits WHERE key=?').get(key).count > limit) { res.setHeader('Retry-After', '900'); fail('Muitas tentativas. Aguarde 15 minutos.', 429); }
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) fail('Informe e-mail e senha de 8 a 128 caracteres.');
        let account;
        if (url.pathname === '/api/reset') {
          if (password.length < 12) fail('Crie uma senha com pelo menos 12 caracteres.');
          const resetHash = digest(text(body.resetCode, 128));
          transaction(db, () => {
            const reset = db.prepare('SELECT r.user_id FROM resets r JOIN users u ON u.id=r.user_id WHERE r.hash=? AND r.used=0 AND r.expires>? AND u.email=? AND u.active=1').get(resetHash, Date.now(), email);
            if (!reset) fail('Código de recuperação inválido ou expirado.', 403);
            const salt = randomBytes(16).toString('hex');
            db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt, scryptSync(password, salt, 64).toString('hex'), reset.user_id);
            db.prepare('UPDATE resets SET used=1 WHERE user_id=?').run(reset.user_id);
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(reset.user_id);
            audit(db, reset.user_id, 'password.reset', reset.user_id);
          });
          send(200, { message: 'Senha alterada. Entre novamente.' }); return;
        }
        if (url.pathname === '/api/register') {
          if (password.length < 12) fail('Crie uma senha com pelo menos 12 caracteres.');
          const inviteHash = digest(text(body.inviteCode, 128));
          const invite = db.prepare('SELECT * FROM invites WHERE hash=? AND email=? AND used=0 AND expires>?').get(inviteHash, email, Date.now());
          if (!invite) fail('Convite inválido, expirado ou já utilizado.', 403);
          const name = text(body.name, 100); if (!name) fail('Informe seu nome.');
          const salt = randomBytes(16).toString('hex'), hash = scryptSync(password, salt, 64).toString('hex');
          try { account = transaction(db, () => {
            const consumed = db.prepare('UPDATE invites SET used=1 WHERE hash=? AND used=0 AND expires>?').run(inviteHash, Date.now());
            if (consumed.changes !== 1) fail('Convite indisponível.', 403);
            const result = db.prepare('INSERT INTO users(name,email,salt,hash) VALUES(?,?,?,?)').run(name, email, salt, hash);
            const id = Number(result.lastInsertRowid); audit(db, id, 'account.created', id); return { id, name };
          }); }
          catch (err) { if (err.message.includes('UNIQUE')) fail('Este e-mail já está cadastrado.', 409); throw err; }
        } else {
          account = db.prepare('SELECT * FROM users WHERE email=?').get(email);
          const hash = scryptSync(password, account?.salt || 'missing-account', 64);
          if (!account || !timingSafeEqual(hash, Buffer.from(account.hash, 'hex')) || !account.active) fail('E-mail ou senha incorretos.', 401);
        }
        db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
        const session = randomBytes(32).toString('hex');
        if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(session), account.id, Date.now() + 28800000);
        db.prepare('DELETE FROM auth_limits WHERE key=?').run(digest('email:' + email));
        res.setHeader('Set-Cookie', `session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie ? '; Secure' : ''}`);
        send(200, { id: account.id, name: account.name }); return;
      }
      if (!user) fail('Entre para acessar a agenda.', 401);
      if (req.method === 'GET' && url.pathname === '/api/me') { send(200, { ...user, requireApproval }); return; }
      if (req.method === 'POST' && url.pathname === '/api/logout') { db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token)); res.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`); send(200, {}); return; }
      if (url.pathname.startsWith('/api/admin/')) {
        if (user.role !== 'admin') fail('Acesso exclusivo da coordenação.', 403);
        if (url.pathname === '/api/admin/users' && req.method === 'GET') { send(200, db.prepare('SELECT id,name,email,role,active FROM users ORDER BY name').all()); return; }
        if (url.pathname === '/api/admin/audit' && req.method === 'GET') { send(200, db.prepare('SELECT a.*,u.name FROM audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 100').all()); return; }
        if (url.pathname === '/api/admin/invites' && req.method === 'POST') {
          const email = text(body.email, 200).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Informe um e-mail válido.');
          if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail('Esta conta já existe.', 409);
          const invite = transaction(db, () => { const value = issueInvite(db, email); audit(db, user.id, 'invite.created', email); return value; });
          send(201, { invite, email, expiresInHours: 48 }); return;
        }
        const target = /^\/api\/admin\/users\/(\d+)$/.exec(url.pathname);
        const recovery = /^\/api\/admin\/users\/(\d+)\/recovery$/.exec(url.pathname);
        if (recovery && req.method === 'POST') {
          const id = Number(recovery[1]);
          if (!db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(id)) fail('Conta ativa não encontrada.', 404);
          const code = randomBytes(32).toString('hex');
          transaction(db, () => {
            db.prepare('UPDATE resets SET used=1 WHERE user_id=?').run(id);
            db.prepare('INSERT INTO resets(hash,user_id,expires) VALUES(?,?,?)').run(digest(code), id, Date.now() + 1800000);
            audit(db, user.id, 'recovery.issued', id);
          });
          send(201, { code }); return;
        }
        if (target && req.method === 'PATCH') {
          const id = Number(target[1]);
          if (id === user.id) fail('Você não pode desativar sua própria conta.');
          if (typeof body.active !== 'boolean') fail('Estado inválido.');
          if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail('Conta não encontrada.', 404);
          transaction(db, () => { db.prepare('UPDATE users SET active=? WHERE id=?').run(Number(body.active), id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); audit(db, user.id, body.active ? 'account.activated' : 'account.disabled', id); });
          send(200, {}); return;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/bookings') {
        send(200, db.prepare("SELECT b.id,user_id,classroom,day,start,end,status,u.name FROM bookings b JOIN users u ON b.user_id=u.id WHERE day=? AND status IN ('confirmed','pending') ORDER BY start").all(url.searchParams.get('day') || '')); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/bookings') {
        const s = slot(body); transaction(db, () => { const result = db.prepare('INSERT INTO bookings(user_id,classroom,day,start,end,status) VALUES(?,?,?,?,?,?)').run(user.id, s.classroom, s.day, s.start, s.end, requireApproval ? 'pending' : 'confirmed'); audit(db, user.id, 'booking.created', result.lastInsertRowid); }); send(201, { message: requireApproval ? 'Pedido enviado.' : 'Reserva confirmada!' }); return;
      }
      const match = /^\/api\/bookings\/(\d+)$/.exec(url.pathname);
      if (match && ['PATCH', 'DELETE'].includes(req.method)) {
        const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(match[1]));
        if (!booking || booking.user_id !== user.id) fail('Reserva não encontrada.', 404);
        if (!['pending','confirmed'].includes(booking.status)) fail('Esta reserva não está ativa.', 409);
        transaction(db, () => {
          if (req.method === 'DELETE') db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(booking.id);
          else { const s = slot(body); db.prepare('UPDATE bookings SET classroom=?,day=?,start=?,end=?,status=? WHERE id=?').run(s.classroom, s.day, s.start, s.end, requireApproval ? 'pending' : 'confirmed', booking.id); }
          audit(db, user.id, req.method === 'DELETE' ? 'booking.cancelled' : 'booking.updated', JSON.stringify({ id: booking.id, before: booking, after: req.method === 'DELETE' ? null : slot(body) }));
        });
        send(200, {}); return;
      }
      fail('Página não encontrada.', 404);
    } catch (err) {
      if (err.message.includes('overlap')) send(409, { error: 'O projetor já está reservado nesse horário. Escolha outro intervalo.' });
      else { if (!err.status) console.error(err); send(err.status || 500, { error: err.status ? err.message : 'Não foi possível concluir. Tente novamente.' }); }
    }
  });
  server.on('close', () => { clearInterval(backupTimer); if (backupTask) backupTask.finally(() => db.close()); else db.close(); });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const production = process.env.NODE_ENV === 'production';
  const server = createApp({ database: path.join(root, 'data', 'agenda.sqlite'), secureCookie: production || process.env.COOKIE_SECURE === 'true', publicOrigin: process.env.PUBLIC_ORIGIN, backupDirectory: process.env.BACKUP_DIR || path.join(root, 'backups') });
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('Agenda disponível na porta ' + (process.env.PORT || 3000)));
}
