import { getDb } from '../src/db/db.js';
import { sanitizeOutbound } from '../src/ai/gateway.js';

getDb();
const t0 = Date.now();
const r = await sanitizeOutbound(
  'Reminder: notice to Norrland before closing. Hokuriku asked about Vulcan III exposure. Also loop in Brightwater Advisors LLC on the Khalij allocation.',
);
console.log('nerUsed:', r.nerUsed, 'in', Date.now() - t0, 'ms');
console.log('SANITIZED:', r.sanitized);
for (const name of ['Norrland', 'Hokuriku', 'Vulcan', 'Khalij']) {
  console.log(name, 'leaked:', r.sanitized.includes(name));
}
