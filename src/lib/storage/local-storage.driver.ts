import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageDriver, StoredObject } from './storage.types.js';

/** Files on the local disk below one root folder. A key can never point outside that folder. */
export class LocalStorageDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  /** Absolute path of a key; throws for anything that would escape the root (`../`, absolute paths). */
  resolve(key: string): string {
    const normalized = path.posix.normalize(key.replaceAll('\\', '/'));
    if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path.join(this.root, ...normalized.split('/'));
  }

  async put(key: string, data: Buffer | Readable): Promise<StoredObject> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(data instanceof Buffer ? Readable.from(data) : data, createWriteStream(target));
    return { key, size: (await stat(target)).size };
  }

  async get(key: string): Promise<Readable> {
    const target = this.resolve(key);
    await stat(target);
    return createReadStream(target);
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.resolve(key))).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
