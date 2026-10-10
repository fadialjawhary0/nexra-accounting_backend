import type { Readable } from 'node:stream';

export interface StoredObject {
  key: string;
  size: number;
}

/**
 * Where uploaded files live. Today: a folder on disk (LocalStorageDriver). Later an S3 driver can implement the same
 * interface — nothing outside src/lib/storage changes.
 * Keys are relative paths with forward slashes, e.g. `clients/1042/documents/kvk-extract.pdf`.
 */
export interface StorageDriver {
  put(key: string, data: Buffer | Readable): Promise<StoredObject>;
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
