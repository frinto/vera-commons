import { readFileSync } from 'node:fs';
import { resolveTrust } from '../src/permit.mjs';

const trust = JSON.parse(readFileSync('E:\\trust.json', 'utf8'));
const user = JSON.parse(readFileSync('E:\\user-admin.json', 'utf8'));
const vera = JSON.parse(readFileSync('E:\\vera-admin.json', 'utf8'));
const root = JSON.parse(readFileSync('E:\\commons-root.json', 'utf8'));

const { levels, revoked } = resolveTrust(trust.permits ?? [], trust.roots ?? []);
const lvl = (id) => levels.get(id) ?? 'observer';
const s = (id) => String(id).slice(0, 10);

console.log('  USER key  ' + s(user.agentId) + '...  level = ' + lvl(user.agentId));
console.log('  VERA key  ' + s(vera.agentId) + '...  level = ' + lvl(vera.agentId));
console.log('  ROOT key  ' + s(root.agentId) + '...  level = ' + lvl(root.agentId));
console.log('  roots declared: ' + JSON.stringify((trust.roots ?? []).map(s)));
console.log('');
console.log('  user may retract ANY message : ' + (lvl(user.agentId) === 'admin'));
console.log('  Vera may retract ANY message : ' + (lvl(vera.agentId) === 'admin'));
console.log('  revoked keys                 : ' + revoked.size);
console.log('  total permitted keys         : ' + levels.size);
