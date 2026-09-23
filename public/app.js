const $ = id => document.getElementById(id);
let user, register = false, editId = null, refreshSequence = 0;
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
$('day').value = $('booking-day').value = today();
$('booking-day').min = today();
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = false; }
async function api(url, method = 'GET', body) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (response.status === 401 && user) {
    user = null; refreshSequence++; $('workspace').hidden = $('identity').hidden = $('admin').hidden = true; $('auth').hidden = false; $('admin-secret').textContent = ''; $('users-list').replaceChildren(); $('audit-list').replaceChildren();
  }
  if (!response.ok) throw new Error(data.error || 'Não foi possível acessar a agenda.');
  return data;
}
function element(tag, content, className) { const node = document.createElement(tag); node.textContent = content; if (className) node.className = className; return node; }
function resetEdit() { editId = null; $('booking-title').textContent = 'Reservar projetor'; $('booking-submit').textContent = 'Confirmar reserva'; $('cancel-edit').hidden = true; $('booking-form').reset(); $('booking-day').value = $('day').value; }
async function refresh() {
  const sequence = ++refreshSequence;
  const bookings = await api('/api/bookings?day=' + encodeURIComponent($('day').value));
  if (sequence !== refreshSequence) return;
  const list = $('bookings'); list.replaceChildren();
  if (!bookings.length) { const empty = element('div', '', 'empty'); empty.append(element('strong', 'A agenda está livre por aqui'), element('p', 'Escolha um horário e prepare sua próxima aula.')); list.append(empty); }
  for (const booking of bookings) {
    const item = element('article', '', 'reservation');
    item.append(element('strong', `${booking.start} — ${booking.end}`), element('p', `${booking.classroom} · ${booking.name}`), element('span', booking.status === 'pending' ? 'Aguardando aprovação' : booking.user_id === user.id ? 'Sua reserva' : 'Reservado', 'badge'));
    if (booking.user_id === user.id) {
      const actions = element('div', '', 'actions'), edit = element('button', 'Editar', 'secondary'), cancel = element('button', 'Cancelar reserva', 'secondary');
      edit.onclick = () => { editId = booking.id; $('classroom').value = booking.classroom; $('booking-day').value = booking.day; $('start').value = booking.start; $('end').value = booking.end; $('booking-title').textContent = 'Editar reserva'; $('booking-submit').textContent = 'Salvar alterações'; $('cancel-edit').hidden = false; $('classroom').focus(); };
      cancel.onclick = async () => { if (!confirm('Cancelar esta reserva e liberar o horário?')) return; cancel.disabled = true; try { await api('/api/bookings/' + booking.id, 'DELETE', {}); if (editId === booking.id) resetEdit(); notice('Reserva cancelada. Horário liberado!'); await refresh(); } catch (err) { notice(err.message, true); } finally { cancel.disabled = false; } };
      actions.append(edit, cancel); item.append(actions);
    }
    list.append(item);
  }
}
async function enter() { user = await api('/api/me'); $('auth').hidden = true; $('workspace').hidden = $('identity').hidden = false; $('username').textContent = user.name; await refresh(); if (user.role === 'admin') { $('admin').hidden = false; await loadAdmin(); } }
$('auth-toggle').onclick = () => { register = !register; $('password').minLength = register ? 12 : 8; $('name-field').hidden = $('invite-field').hidden = !register; $('name').required = $('invite').required = register; $('password').autocomplete = register ? 'new-password' : 'current-password'; $('auth-title').textContent = register ? 'Crie seu acesso' : 'Acesse a agenda'; $('auth-submit').textContent = register ? 'Criar conta' : 'Entrar'; $('auth-toggle').textContent = register ? 'Já tenho conta. Entrar' : 'Primeiro acesso? Criar conta'; };
$('auth-form').onsubmit = async event => { event.preventDefault(); $('auth-submit').disabled = true; try { await api(register ? '/api/register' : '/api/login', 'POST', { name: $('name').value, email: $('email').value, password: $('password').value, inviteCode: $('invite').value }); $('password').value = $('invite').value = ''; $('notice').hidden = true; await enter(); } catch (err) { notice(err.message, true); } finally { $('auth-submit').disabled = false; } };
$('logout').onclick = async () => { try { await api('/api/logout', 'POST', {}); location.reload(); } catch (err) { notice(err.message, true); } };
$('booking-form').onsubmit = async event => { event.preventDefault(); $('booking-submit').disabled = true; try { const day = $('booking-day').value; await api(editId ? '/api/bookings/' + editId : '/api/bookings', editId ? 'PATCH' : 'POST', { classroom: $('classroom').value, day, start: $('start').value, end: $('end').value }); $('day').value = day; resetEdit(); notice('Reserva confirmada! O projetor estará reservado para sua aula.'); await refresh(); } catch (err) { notice(err.message, true); } finally { $('booking-submit').disabled = false; } };
$('cancel-edit').onclick = resetEdit;
$('day').onchange = () => { if (!editId) $('booking-day').value = $('day').value; refresh().catch(err => notice(err.message, true)); };
for (const [id, direction] of [['previous', -1], ['next', 1]]) $(id).onclick = () => { const date = new Date($('day').value + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + direction); $('day').value = date.toISOString().slice(0, 10); $('day').onchange(); };
setInterval(() => { if (user && !document.hidden) refresh().catch(err => notice(err.message, true)); }, 30000);
enter().catch(err => { if (err.message !== 'Entre para acessar a agenda.') notice(err.message, true); });

function showSecret(message) { $('admin-secret').textContent = message; $('admin-secret').hidden = false; }
async function loadAdmin() {
  const accounts = await api('/api/admin/users'); $('users-list').replaceChildren();
  for (const account of accounts) {
    const row = element('div', '', 'reservation');
    row.append(element('strong', account.name), element('p', `${account.email} · ${account.role === 'admin' ? 'Coordenação' : 'Professor'} · ${account.active ? 'Ativo' : 'Desativado'}`));
    const actions = element('div', '', 'actions');
    if (account.id !== user.id) {
      const button = element('button', account.active ? 'Desativar acesso' : 'Reativar acesso', 'secondary');
      button.onclick = async () => { if (!confirm(`${account.active ? 'Desativar' : 'Reativar'} o acesso de ${account.name}?`)) return; button.disabled = true; try { await api('/api/admin/users/' + account.id, 'PATCH', { active: !account.active }); await loadAdmin(); } catch (err) { notice(err.message, true); button.disabled = false; } };
      actions.append(button);
    }
    if (account.active) {
      const recover = element('button', 'Gerar recuperação', 'secondary');
      recover.onclick = async () => { recover.disabled = true; try { const result = await api(`/api/admin/users/${account.id}/recovery`, 'POST', {}); showSecret(`Recuperação para ${account.email} (30 minutos, uso único): ${result.code}`); await loadAudit(); } catch (err) { notice(err.message, true); } finally { recover.disabled = false; } };
      actions.append(recover);
    }
    row.append(actions); $('users-list').append(row);
  }
  await loadAudit();
}
async function loadAudit() {
  const labels = { 'account.created': 'Conta criada', 'account.disabled': 'Acesso desativado', 'account.activated': 'Acesso reativado', 'invite.created': 'Convite emitido', 'invite.bootstrap': 'Convite inicial emitido', 'admin.granted': 'Permissão de coordenação concedida', 'booking.created': 'Reserva criada', 'booking.updated': 'Reserva alterada', 'booking.cancelled': 'Reserva cancelada', 'password.reset': 'Senha redefinida', 'recovery.issued': 'Recuperação emitida' };
  const entries = await api('/api/admin/audit'); $('audit-list').replaceChildren();
  for (const entry of entries) {
    let target = entry.target;
    if (target.startsWith('{')) { try { target = 'Reserva ' + JSON.parse(target).id; } catch {} }
    const time = new Date(entry.created.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    $('audit-list').append(element('p', `${time} · ${entry.name || 'Responsável pela instalação'} · ${labels[entry.action] || entry.action} · ${target}`));
  }
}
$('invite-form').onsubmit = async event => { event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; try { const result = await api('/api/admin/invites', 'POST', { email: $('invite-email').value }); showSecret(`Convite para ${result.email} (48 horas, uso único): ${result.invite}`); await loadAudit(); } catch (err) { notice(err.message, true); } finally { button.disabled = false; } };
$('audit-refresh').onclick = () => loadAudit().catch(err => notice(err.message, true));
$('reset-toggle').onclick = () => { $('reset-form').hidden = !$('reset-form').hidden; };
$('reset-form').onsubmit = async event => { event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; try { await api('/api/reset', 'POST', { email: $('reset-email').value, password: $('reset-password').value, resetCode: $('reset-code').value }); event.target.reset(); event.target.hidden = true; notice('Senha alterada. Entre com a nova senha.'); } catch (err) { notice(err.message, true); } finally { button.disabled = false; } };
