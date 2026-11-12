import * as fs from 'fs';
import * as path from 'path';
import { isVendorId, VendorId } from '../shared/vendors';

/** The slice of Electron's safeStorage this needs (so tests can supply a fake). */
export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  /** 'basic_text' means the "encryption" is not real (Linux without a keyring); keys are refused then. */
  getSelectedStorageBackend?(): string;
}

/**
 * One encrypted file per vendor, outside the project folder. Anthropic keeps the file name it always had, so an existing
 * install keeps working. Keys are held in the main process only; the interface is told which vendors have one, never the key.
 */
export class KeyVault {
  private keys = new Map<VendorId, string>();

  constructor(private dir: string, private crypto: Crypto) {
    for (const v of ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'local', 'custom'] as VendorId[]) {
      try {
        const f = this.file(v);
        if (fs.existsSync(f) && crypto.isEncryptionAvailable()) this.keys.set(v, crypto.decryptString(fs.readFileSync(f)));
      } catch { /* unreadable: treated as no key */ }
    }
  }

  private file(v: VendorId) {
    if (!isVendorId(v)) throw new Error('Unknown vendor');
    return v === 'anthropic' ? path.join(this.dir, 'api-key.bin') : path.join(this.dir, 'keys', `${v}.bin`);
  }

  get(v: VendorId): string | undefined { return this.keys.get(v); }
  has(v: VendorId): boolean { return this.keys.has(v); }
  flags(): Partial<Record<VendorId, boolean>> {
    const out: Partial<Record<VendorId, boolean>> = {};
    for (const v of this.keys.keys()) out[v] = true;
    return out;
  }

  set(v: VendorId, key: string) {
    if (!key) throw new Error('Enter an API key');
    const weak = this.crypto.getSelectedStorageBackend?.() === 'basic_text';
    if (!this.crypto.isEncryptionAvailable() || weak) throw new Error('Secure storage is not available on this system, so the key was not saved');
    const f = this.file(v);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, this.crypto.encryptString(key));
    this.keys.set(v, key);
  }

  clear(v: VendorId) {
    try { fs.rmSync(this.file(v), { force: true }); } catch { /* ignore */ }
    this.keys.delete(v);
  }
}
