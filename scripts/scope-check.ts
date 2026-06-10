import { getDb } from '../src/db/db.js';
import { sanitizeOutbound } from '../src/ai/gateway.js';

const db = getDb();
const rows = db.prepare(`SELECT i.name FROM investors i JOIN commitments c ON c.investor_id = i.id WHERE c.fund_id = ?`).all('fund-2');
console.log('scoped investors for fund-2:', rows.length);

const r = await sanitizeOutbound('owed to: Norrland Pension AB re Vulcan Industrial Partners II, L.P.', undefined, 'fund-2');
console.log('sanitized:', r.sanitized);
console.log('mappings:', r.mappings.map(m => `${m.placeholder}=${m.original}`));
