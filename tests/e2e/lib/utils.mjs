import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizedPath(candidate) {
  return path.resolve(candidate).toLocaleLowerCase('en-US');
}

export function isMissingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

export function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function retainFailure(currentFailure, checks, stage, error) {
  checks.cleanupErrors ??= [];
  checks.cleanupErrors.push({ stage, error: errorText(error) });
  return currentFailure ?? error;
}
