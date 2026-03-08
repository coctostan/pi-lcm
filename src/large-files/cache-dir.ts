import { rmSync } from 'node:fs';
import { join } from 'node:path';

export function sessionLargeFileCacheDir(cacheRoot: string, sessionId: string): string {
  return join(cacheRoot, sessionId);
}

export function resetSessionLargeFileCache(cacheRoot: string, sessionId: string): void {
  rmSync(sessionLargeFileCacheDir(cacheRoot, sessionId), { recursive: true, force: true });
}
