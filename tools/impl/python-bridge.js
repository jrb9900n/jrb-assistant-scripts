// tools/impl/python-bridge.js — shared execFile+JSON-stdout contract for
// Node -> Python CLI bridge scripts (google_ads_bridge.py,
// external_flag_bridge.py). Extracted 2026-08-26 after the same ~20-line
// execFile/JSON-parse/ok-check block got copy-pasted a second time — see
// google-ads.js's and marketing-ads-flags.js's own headers for why each
// bridge script exists and what it's scoped to do.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileAsync = promisify(execFile);

const PYTHON_PATH = 'C:\\Users\\Assistant\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
export const PYTHON_EXE = existsSync(PYTHON_PATH) ? PYTHON_PATH : 'python';

// scriptPath must be an absolute path -- callers resolve it themselves
// (fileURLToPath for a co-located script, a hardcoded absolute path for a
// script that lives in a different repo/directory).
export async function runPythonBridge(scriptPath, command, args = {}, opts = {}) {
  const { timeout = 30_000, maxBuffer = 10 * 1024 * 1024, errorLabel = 'Python bridge' } = opts;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(PYTHON_EXE, [scriptPath, command, JSON.stringify(args)], { timeout, maxBuffer }));
  } catch (err) {
    // execFile rejects on non-zero exit, but the bridge still prints a JSON
    // error to stdout before exiting 1 -- prefer that structured message
    // over the generic "Command failed" error execFile throws.
    stdout = err.stdout;
    if (!stdout) throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${errorLabel} returned non-JSON output: ${stdout.slice(0, 500)}`);
  }
  if (!parsed.ok) throw new Error(parsed.error || `${errorLabel} failed with no error message`);
  return parsed.data;
}
