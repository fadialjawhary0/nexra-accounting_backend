import { Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { AppConfigService } from '../config/app-config.service.js';
import { LocalStorageDriver } from './local-storage.driver.js';
import type { StorageDriver, StoredObject } from './storage.types.js';

/** File storage for the whole app (documents, generated Word / PDF files, imports). Feature code only talks to this. */
@Injectable()
export class StorageService implements StorageDriver {
  private readonly driver: StorageDriver;

  constructor(config: AppConfigService) {
    this.driver = new LocalStorageDriver(config.storageDir);
  }

  put(key: string, data: Buffer | Readable): Promise<StoredObject> {
    return this.driver.put(key, data);
  }

  get(key: string): Promise<Readable> {
    return this.driver.get(key);
  }

  exists(key: string): Promise<boolean> {
    return this.driver.exists(key);
  }

  delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }
}
