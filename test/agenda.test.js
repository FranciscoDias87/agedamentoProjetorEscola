import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

test('reservas compartilhadas, conflitos e permissões', async t => {
  const server = createApp({ inviteCode: 'codigo-escola-teste' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, method = 'GET', body, cookie) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  assert.equal((await request('/api/bookings?day=2099-01-10')).status, 401);
  const registration = { name: 'Ana', email: 'ana@escola.test', password: 'senha-teste-123', inviteCode: 'codigo-escola-teste' };
  assert.equal((await request('/api/register', 'POST', { ...registration, inviteCode: 'errado' })).status, 403);
  const ana = await request('/api/register', 'POST', registration);
  const bia = await request('/api/register', 'POST', { ...registration, name: 'Bia', email: 'bia@escola.test' });
  assert.equal(ana.status, 200);
  const slot = { classroom: '7º B', day: '2099-01-10', start: '09:00', end: '10:00' };
  const simultaneous = await Promise.all([request('/api/bookings', 'POST', slot, ana.cookie), request('/api/bookings', 'POST', slot, bia.cookie)]);
  assert.deepEqual(simultaneous.map(r => r.status).sort(), [201, 409]);
  const bookings = (await request('/api/bookings?day=2099-01-10', 'GET', null, ana.cookie)).data;
  assert.equal(bookings.length, 1); assert.equal(bookings[0].status, 'confirmed');
  const owner = bookings[0].user_id === ana.data.id ? ana : bia, other = owner === ana ? bia : ana;
  assert.equal((await request('/api/bookings/' + bookings[0].id, 'DELETE', {}, other.cookie)).status, 404);
  assert.equal((await request('/api/bookings/' + bookings[0].id, 'PATCH', slot, other.cookie)).status, 404);
  assert.equal((await request('/api/bookings', 'POST', { ...slot, start: '10:00', end: '11:00' }, other.cookie)).status, 201);
  assert.equal((await request('/api/bookings/' + bookings[0].id, 'PATCH', { ...slot, end: '10:30' }, owner.cookie)).status, 409);
  assert.equal((await request('/api/bookings', 'POST', { ...slot, day: '2099-02-30' }, ana.cookie)).status, 400);
  assert.equal((await request('/api/bookings', 'POST', { ...slot, day: '2000-01-01' }, ana.cookie)).status, 400);
  assert.equal((await request('/api/bookings/' + bookings[0].id, 'DELETE', {}, owner.cookie)).status, 200);
  assert.equal((await request('/api/bookings', 'POST', slot, other.cookie)).status, 201);
  await request('/api/logout', 'POST', {}, ana.cookie);
  assert.equal((await request('/api/me', 'GET', null, ana.cookie)).status, 401);
  assert.equal((await request('/api/login', 'POST', registration)).status, 200);
});

test('estrutura permite aprovação futura sem mudar reservas existentes', async t => {
  const server = createApp({ inviteCode: 'codigo-escola-teste', requireApproval: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana', email: 'ana@escola.test', password: 'senha-teste', inviteCode: 'codigo-escola-teste' }) });
  const headers = { 'Content-Type': 'application/json', Cookie: auth.headers.get('set-cookie').split(';')[0] };
  const booking = await fetch(base + '/api/bookings', { method: 'POST', headers, body: JSON.stringify({ classroom: 'A', day: '2099-01-10', start: '09:00', end: '10:00' }) });
  assert.equal(booking.status, 201);
  const list = await (await fetch(base + '/api/bookings?day=2099-01-10', { headers })).json();
  assert.equal(list[0].status, 'pending');
});
