import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ database = ':memory:', inviteCode, requireApproval = false, secureCookie = false } = {}) {
  if (!inviteCode || inviteCode.length < 12) throw new Error('Defina SCHOOL_INVITE_CODE com pelo menos 12 caracteres.');
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
  const attempts = new Map();
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
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail('Origem inválida.', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) fail('Formato inválido.', 415);
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) fail('Pedido muito grande.', 413); }
        try { body = JSON.parse(raw || '{}'); } catch { fail('Pedido inválido.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Pedido inválido.');
      }
      const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const user = token && db.prepare('SELECT users.id, name FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?').get(token, Date.now());
      if (req.method === 'POST' && ['/api/login', '/api/register'].includes(url.pathname)) {
        const key = req.socket.remoteAddress;
        const entry = attempts.get(key);
        const rate = entry && entry.until > Date.now() ? entry : { count: 0, until: Date.now() + 900000 };
        if (attempts.size > 10000) for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
        attempts.set(key, rate); if (++rate.count > 30) fail('Muitas tentativas. Aguarde 15 minutos.', 429);
        const email = text(body.email, 200).toLowerCase(), password = typeof body.password === 'string' ? body.password : '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) fail('Informe e-mail e senha de 8 a 128 caracteres.');
        let account;
        if (url.pathname === '/api/register') {
          if (body.inviteCode !== inviteCode) fail('Código da escola inválido.', 403);
          const name = text(body.name, 100); if (!name) fail('Informe seu nome.');
          const salt = randomBytes(16).toString('hex'), hash = scryptSync(password, salt, 64).toString('hex');
          try { const result = db.prepare('INSERT INTO users(name,email,salt,hash) VALUES(?,?,?,?)').run(name, email, salt, hash); account = { id: Number(result.lastInsertRowid), name }; }
          catch (err) { if (err.message.includes('UNIQUE')) fail('Este e-mail já está cadastrado.', 409); throw err; }
        } else {
          account = db.prepare('SELECT * FROM users WHERE email=?').get(email);
          const hash = scryptSync(password, account?.salt || 'missing-account', 64);
          if (!account || !timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) fail('E-mail ou senha incorretos.', 401);
        }
        db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
        const session = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(session, account.id, Date.now() + 604800000);
        res.setHeader('Set-Cookie', `session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie ? '; Secure' : ''}`);
        send(200, { id: account.id, name: account.name }); return;
      }
      if (!user) fail('Entre para acessar a agenda.', 401);
      if (req.method === 'GET' && url.pathname === '/api/me') { send(200, { ...user, requireApproval }); return; }
      if (req.method === 'POST' && url.pathname === '/api/logout') { db.prepare('DELETE FROM sessions WHERE token=?').run(token); res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); send(200, {}); return; }
      if (req.method === 'GET' && url.pathname === '/api/bookings') {
        send(200, db.prepare("SELECT b.id,user_id,classroom,day,start,end,status,u.name FROM bookings b JOIN users u ON b.user_id=u.id WHERE day=? AND status IN ('confirmed','pending') ORDER BY start").all(url.searchParams.get('day') || '')); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/bookings') {
        const s = slot(body); db.prepare('INSERT INTO bookings(user_id,classroom,day,start,end,status) VALUES(?,?,?,?,?,?)').run(user.id, s.classroom, s.day, s.start, s.end, requireApproval ? 'pending' : 'confirmed'); send(201, { message: requireApproval ? 'Pedido enviado.' : 'Reserva confirmada!' }); return;
      }
      const match = /^\/api\/bookings\/(\d+)$/.exec(url.pathname);
      if (match && ['PATCH', 'DELETE'].includes(req.method)) {
        const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(match[1]));
        if (!booking || booking.user_id !== user.id) fail('Reserva não encontrada.', 404);
        if (!['pending','confirmed'].includes(booking.status)) fail('Esta reserva não está ativa.', 409);
        if (req.method === 'DELETE') db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(booking.id);
        else { const s = slot(body); db.prepare('UPDATE bookings SET classroom=?,day=?,start=?,end=?,status=? WHERE id=?').run(s.classroom, s.day, s.start, s.end, requireApproval ? 'pending' : 'confirmed', booking.id); }
        send(200, {}); return;
      }
      fail('Página não encontrada.', 404);
    } catch (err) {
      if (err.message.includes('overlap')) send(409, { error: 'O projetor já está reservado nesse horário. Escolha outro intervalo.' });
      else { if (!err.status) console.error(err); send(err.status || 500, { error: err.status ? err.message : 'Não foi possível concluir. Tente novamente.' }); }
    }
  });
  server.on('close', () => db.close());
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const server = createApp({ database: path.join(root, 'data', 'agenda.sqlite'), inviteCode: process.env.SCHOOL_INVITE_CODE, secureCookie: process.env.COOKIE_SECURE === 'true' });
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('Agenda disponível na porta ' + (process.env.PORT || 3000)));
}
