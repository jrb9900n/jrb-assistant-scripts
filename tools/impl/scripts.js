// tools/impl/scripts.js — Run local scripts on this machine
import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../core/logger.js';

/**
 * Run a script and return stdout/stderr.
 * Supports .js (Node) and .py (Python) files.
 * Enforces a timeout to prevent runaway processes.
 */
export async function runScript({ script_path, args = [], timeout_ms = 30_000 }) {
  const abs = path.resolve(script_path);
  const ext = path.extname(abs).toLowerCase();

  const interpreter = ext === '.py' ? 'python3' : 'node';
  const cmd = [interpreter, abs, ...args];

  logger.info('Running script', { cmd: cmd.join(' ') });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn(cmd[0], cmd.slice(1), {
      env: { ...process.env },
      cwd: path.dirname(abs),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout_ms);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ success: false, error: `Script timed out after ${timeout_ms}ms`, stdout, stderr });
      } else {
        resolve({ success: code === 0, exit_code: code, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000) });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}
