// Print the resolved permit level of every administrative key on the stick, and which of them may
// retract any message.
//
// Read-only. It parses E:\trust.json together with the key files beside it and resolves levels through
// src/permit.mjs, so what it prints is what the permit system actually believes -- not what
// trust.json's own text claims. That distinction is the reason to have the tool: a permit entry that
// looks authoritative in the file can still resolve to `observer` if it is revoked or if its root was.
//
// LIMIT, stated because it is load-bearing: the four paths below are hardcoded to E:\, so this runs
// only on the machine with the stick mounted there. It is a bench tool for the human admin, not
// something an agent arriving over the network can run.
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
