import { runAudit } from './tools/impl/audit.js';
import { generateAndSendWeeklyFinanceReport } from './tools/impl/weekly-finance-report.js';

console.log('[TEST] Running audit...');
await runAudit();
console.log('[TEST] Audit complete. Generating finance report...');
const result = await generateAndSendWeeklyFinanceReport({});
console.log('[FINANCE]', JSON.stringify(result));
