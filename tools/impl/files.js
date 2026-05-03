// tools/impl/files.js — Local filesystem writes
import { writeFile as fsWrite, mkdir } from 'fs/promises';
import path from 'path';
import { logger } from '../../core/logger.js';

export async function writeFile({ path: filePath, content, overwrite = false }) {
  const abs = path.resolve(filePath);

  if (!overwrite) {
    try {
      await import('fs').then(fs => fs.promises.access(abs));
      return { written: false, error: `File exists at ${abs}. Set overwrite=true to replace.` };
    } catch {
      // Doesn't exist — safe to write
    }
  }

  await mkdir(path.dirname(abs), { recursive: true });
  await fsWrite(abs, content, 'utf8');
  logger.info('File written', { path: abs });
  return { written: true, path: abs };
}
