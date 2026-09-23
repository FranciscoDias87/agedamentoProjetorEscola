import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateSecurity, issueInvite, audit, transaction, saveBackup } from './security.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(root, 'data', 'agenda.sqlite'));
try {
  migrateSecurity(db);
  const [command, rawEmail] = process.argv.slice(2), email = rawEmail?.trim().toLowerCase();
  if (command === 'backup') console.log(await saveBackup(db, process.env.BACKUP_DIR || path.join(root, 'backups')));
  else if (command === 'invalidate-access') {
    transaction(db, () => { db.exec('DELETE FROM sessions; UPDATE invites SET used=1; UPDATE resets SET used=1;'); audit(db, null, 'access.invalidated', 'all'); });
    console.log('Sessões, convites e recuperações invalidados.');
  }
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw new Error('Informe um e-mail válido.');
  else if (command === 'invite') console.log(transaction(db, () => { const token = issueInvite(db, email); audit(db, null, 'invite.bootstrap', email); return token; }));
  else if (command === 'admin') {
    transaction(db, () => {
      const user = db.prepare('SELECT id FROM users WHERE email=? AND active=1').get(email);
      if (!user) throw new Error('Conta ativa não encontrada.');
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      audit(db, null, 'admin.granted', user.id);
    });
    console.log('Permissão concedida. Entre novamente.');
  } else throw new Error('Use: node manage.js invite email | admin email | backup | invalidate-access');
} finally { db.close(); }
