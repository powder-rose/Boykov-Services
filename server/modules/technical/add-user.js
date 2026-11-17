import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { hashPassword } from '../../auth.js';
import { createTechnicalStore } from './store.js';

const [login, name, role = 'editor'] = process.argv.slice(2);
if (!login || !name || !['editor','admin'].includes(role)) {
  console.error('Использование: node server/modules/technical/add-user.js <login> "Имя Фамилия" [editor|admin]');
  process.exit(1);
}
const rl = createInterface({ input:process.stdin, output:process.stdout, terminal:!!process.stdin.isTTY });
// Hide password on a terminal. Never accept passwords in command-line arguments.
let masked = false;
if (process.stdin.isTTY) {
  rl._writeToOutput = function(text) { if (!masked) process.stdout.write(text); };
}
const password = await new Promise((resolve) => {
  masked = true;
  rl.question('Пароль сотрудника (минимум 12 символов): ', (answer) => { masked = false; resolve(answer); });
});
rl.close();
if (process.stdin.isTTY) process.stdout.write('\n');
if (password.length < 12 || password.length > 256) {
  console.error('Пароль должен содержать от 12 до 256 символов');
  process.exit(1);
}
const db = new DatabaseSync(join(resolve(process.env.DATA_DIR || 'data'), 'platform.sqlite'));
try {
  const store = createTechnicalStore(db);
  store.createUser(login.toLowerCase(), name, await hashPassword(password), role);
  console.log(`Учётная запись ${login} (${name}, ${role}) создана или обновлена.`);
} finally { db.close(); }
