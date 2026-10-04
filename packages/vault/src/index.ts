import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type VaultErrorCode = "locked" | "bad_passphrase" | "exists" | "missing" | "weak_passphrase" | "corrupt" | "throttled" | "bad_name";

/** Messages never contain a secret or a passphrase. */
export class VaultError extends Error {
  constructor(public code: VaultErrorCode, message: string) {
    super(message);
  }
}

export interface VaultOptions {
  /** Lock after this long without use. Default 30 minutes. */
  idleMs?: number;
  /** scrypt cost as a power of two. Default 17 (about 128 MB). Tests lower it. */
  logN?: number;
}

export interface SecretInfo {
  name: string;
  updatedAt: string;
}

export interface Vault {
  exists(): boolean;
  isUnlocked(): boolean;
  /** Names only, and only while unlocked (names live inside the encrypted file). */
  status(): { exists: boolean; unlocked: boolean; secrets: SecretInfo[] | null };
  create(passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  lock(): void;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Hands the secret to a callback and returns only what the callback returns. There is deliberately no get. */
  use<T>(name: string, fn: (value: string) => T | Promise<T>): Promise<T>;
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void>;
}

// File layout: magic(4) version(1) logN(1) r(1) p(1) salt(16) nonce(12) tag(16) ciphertext.
// Everything up to and including the salt is authenticated, so changing the cost settings is detected.
const MAGIC = Buffer.from("JHV1");
const VERSION = 1;
const AAD_LEN = 4 + 1 + 3 + 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MIN_PASSPHRASE = 12;
const NAME = /^[A-Za-z0-9._:@-]{1,100}$/;
const MAX_VALUE = 10_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

interface Params { logN: number; r: number; p: number }
interface Secrets { [name: string]: { value: string; updatedAt: string } }
interface Unlocked { key: Buffer; salt: Buffer; params: Params; data: Secrets }

function derive(passphrase: string, salt: Buffer, params: Params): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      Buffer.from(passphrase.normalize("NFKC"), "utf8"),
      salt,
      32,
      { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: 512 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

function header(params: Params, salt: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([VERSION, params.logN, params.r, params.p]), salt]);
}

function seal(state: Unlocked): Buffer {
  const head = header(state.params, state.salt);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", state.key, nonce);
  cipher.setAAD(head);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(state.data), "utf8")), cipher.final()]);
  return Buffer.concat([head, nonce, cipher.getAuthTag(), ct]);
}

function open(file: Buffer, key: Buffer): Secrets {
  const head = file.subarray(0, AAD_LEN);
  const nonce = file.subarray(AAD_LEN, AAD_LEN + NONCE_LEN);
  const tag = file.subarray(AAD_LEN + NONCE_LEN, AAD_LEN + NONCE_LEN + TAG_LEN);
  const ct = file.subarray(AAD_LEN + NONCE_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(head);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
  } catch {
    throw new VaultError("bad_passphrase", "Wrong passphrase, or the vault file was changed");
  }
}

function parseHeader(file: Buffer): { params: Params; salt: Buffer } {
  if (file.length < AAD_LEN + NONCE_LEN + TAG_LEN || !file.subarray(0, 4).equals(MAGIC) || file[4] !== VERSION) {
    throw new VaultError("corrupt", "The vault file is not recognised");
  }
  const params = { logN: file[5]!, r: file[6]!, p: file[7]! };
  if (params.logN < 8 || params.logN > 22 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 8) {
    throw new VaultError("corrupt", "The vault file has unusable settings");
  }
  return { params, salt: Buffer.from(file.subarray(8, AAD_LEN)) };
}

function checkPassphrase(p: string) {
  if ([...p].length < MIN_PASSPHRASE) throw new VaultError("weak_passphrase", `Use at least ${MIN_PASSPHRASE} characters`);
  if (new Set([...p]).size < 4) throw new VaultError("weak_passphrase", "That passphrase is too repetitive");
}

export function createVault(dir: string, opts: VaultOptions = {}): Vault {
  const file = join(dir, "vault.enc");
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const logN = opts.logN ?? 17;
  let state: Unlocked | null = null;
  let timer: NodeJS.Timeout | undefined;
  let failures: number[] = [];

  const lock = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (state) {
      state.key.fill(0);
      state = null;
    }
  };
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(lock, idleMs);
    timer.unref();
  };
  const need = (): Unlocked => {
    if (!state) throw new VaultError("locked", "The vault is locked");
    touch();
    return state;
  };
  const save = (s: Unlocked) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, seal(s), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  };
  const throttle = () => {
    const now = Date.now();
    failures = failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (failures.length >= MAX_FAILURES) {
      const wait = Math.ceil((FAILURE_WINDOW_MS - (now - failures[0]!)) / 1000);
      throw new VaultError("throttled", `Too many wrong attempts. Try again in ${wait} seconds`);
    }
  };

  return {
    exists: () => existsSync(file),
    isUnlocked: () => state !== null,
    status: () => ({
      exists: existsSync(file),
      unlocked: state !== null,
      secrets: state ? Object.entries(state.data).map(([name, v]) => ({ name, updatedAt: v.updatedAt })).sort((a, b) => a.name.localeCompare(b.name)) : null,
    }),

    async create(passphrase) {
      if (existsSync(file)) throw new VaultError("exists", "A vault already exists");
      checkPassphrase(passphrase);
      const params = { logN, r: 8, p: 1 };
      const salt = randomBytes(16);
      const s: Unlocked = { key: await derive(passphrase, salt, params), salt, params, data: {} };
      save(s);
      lock();
      state = s;
      touch();
    },

    async unlock(passphrase) {
      if (!existsSync(file)) throw new VaultError("missing", "There is no vault yet");
      throttle();
      const raw = readFileSync(file);
      const { params, salt } = parseHeader(raw);
      const key = await derive(passphrase, salt, params);
      let data: Secrets;
      try {
        data = open(raw, key);
      } catch (e) {
        key.fill(0);
        failures.push(Date.now());
        throw e;
      }
      failures = [];
      lock();
      state = { key, salt, params, data };
      touch();
    },

    lock,

    async set(name, value) {
      if (!NAME.test(name)) throw new VaultError("bad_name", "Secret names use letters, digits and . _ : @ -");
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE) throw new VaultError("bad_name", "A secret needs a value of up to 10000 characters");
      const s = need();
      s.data[name] = { value, updatedAt: new Date().toISOString() };
      save(s);
    },

    async remove(name) {
      const s = need();
      if (!(name in s.data)) throw new VaultError("missing", "No such secret");
      delete s.data[name];
      save(s);
    },

    async use(name, fn) {
      const s = need();
      const entry = s.data[name];
      if (!entry) throw new VaultError("missing", "No such secret");
      return await fn(entry.value);
    },

    async changePassphrase(oldPassphrase, newPassphrase) {
      const s = need();
      throttle();
      const check = await derive(oldPassphrase, s.salt, s.params);
      const same = check.equals(s.key);
      check.fill(0);
      if (!same) {
        failures.push(Date.now());
        throw new VaultError("bad_passphrase", "Wrong passphrase");
      }
      checkPassphrase(newPassphrase);
      const salt = randomBytes(16);
      const key = await derive(newPassphrase, salt, s.params);
      s.key.fill(0);
      s.key = key;
      s.salt = salt;
      save(s);
    },
  };
}
