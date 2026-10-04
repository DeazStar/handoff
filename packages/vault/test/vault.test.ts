import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultError, createVault } from "../src/index.js";

const PASS = "correct horse battery";
let dir: string;
const fresh = (opts = {}) => createVault(dir, { logN: 10, ...opts });
const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as VaultError).code; }
  return "no error";
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vault-")); });
afterEach(() => vi.useRealTimers());

describe("creating and unlocking", () => {
  it("starts empty, creates an unlocked vault, and survives a restart", async () => {
    const v = fresh();
    expect(v.status()).toEqual({ exists: false, unlocked: false, secrets: null });
    await v.create(PASS);
    expect(v.status()).toEqual({ exists: true, unlocked: true, secrets: [] });
    await v.set("mail.smtp", "s3cret-value");
    v.lock();
    expect(v.status()).toEqual({ exists: true, unlocked: false, secrets: null });

    const again = fresh(); // a new process
    expect(again.isUnlocked()).toBe(false);
    await again.unlock(PASS);
    expect(again.status().secrets!.map((s) => s.name)).toEqual(["mail.smtp"]);
    expect(await again.use("mail.smtp", (x) => x.length)).toBe("s3cret-value".length);
  });

  it("refuses a second vault, a missing vault, and weak passphrases", async () => {
    const v = fresh();
    expect(await code(v.unlock(PASS))).toBe("missing");
    expect(await code(v.create("short"))).toBe("weak_passphrase");
    expect(await code(v.create("aaaaaaaaaaaaaaaa"))).toBe("weak_passphrase");
    await v.create(PASS);
    expect(await code(v.create(PASS))).toBe("exists");
  });

  it("rejects a wrong passphrase without revealing anything", async () => {
    const v = fresh();
    await v.create(PASS);
    v.lock();
    expect(await code(v.unlock("wrong passphrase!"))).toBe("bad_passphrase");
    expect(v.isUnlocked()).toBe(false);
  });

  it("slows down repeated wrong guesses", async () => {
    const v = fresh();
    await v.create(PASS);
    v.lock();
    for (let i = 0; i < 5; i++) expect(await code(v.unlock(`guess number ${i} xx`))).toBe("bad_passphrase");
    expect(await code(v.unlock(PASS))).toBe("throttled"); // even the right one waits
  });
});

describe("secrets", () => {
  it("only works while unlocked", async () => {
    const v = fresh();
    await v.create(PASS);
    await v.set("a", "1");
    v.lock();
    expect(await code(v.set("b", "2"))).toBe("locked");
    expect(await code(v.remove("a"))).toBe("locked");
    expect(await code(v.use("a", () => 0))).toBe("locked");
  });

  it("has no way to read a value back except through use()", async () => {
    const v = fresh();
    await v.create(PASS);
    await v.set("mail.smtp", "hunter2-hunter2");
    expect(Object.keys(v).sort()).toEqual(["changePassphrase", "create", "exists", "isUnlocked", "lock", "remove", "set", "status", "unlock", "use"]);
    expect(JSON.stringify(v.status())).not.toContain("hunter2");
  });

  it("checks names and values, and reports a missing secret", async () => {
    const v = fresh();
    await v.create(PASS);
    expect(await code(v.set("bad name!", "x"))).toBe("bad_name");
    expect(await code(v.set("ok", ""))).toBe("bad_name");
    expect(await code(v.set("ok", "x".repeat(10_001)))).toBe("bad_name");
    expect(await code(v.use("nope", () => 0))).toBe("missing");
    expect(await code(v.remove("nope"))).toBe("missing");
    await v.set("ok", "1");
    await v.remove("ok");
    expect(v.status().secrets).toEqual([]);
  });

  it("replaces a secret and keeps its name", async () => {
    const v = fresh();
    await v.create(PASS);
    await v.set("mail.smtp", "one");
    await v.set("mail.smtp", "two");
    expect(await v.use("mail.smtp", (x) => x)).toBe("two");
    expect(v.status().secrets).toHaveLength(1);
  });
});

describe("the file", () => {
  it("is private, encrypted, and left tidy", async () => {
    const v = fresh();
    await v.create(PASS);
    await v.set("mail.smtp", "plaintext-marker-12345");
    const file = join(dir, "vault.enc");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(file);
    expect(bytes.includes("plaintext-marker-12345")).toBe(false);
    expect(bytes.includes("mail.smtp")).toBe(false);
    expect(readdirSync(dir)).toEqual(["vault.enc"]); // no temp file left
  });

  it("uses a new nonce on every write", async () => {
    const v = fresh();
    await v.create(PASS);
    const nonce = () => readFileSync(join(dir, "vault.enc")).subarray(24, 36).toString("hex");
    const a = nonce();
    await v.set("a", "1");
    const b = nonce();
    await v.set("a", "1");
    expect(new Set([a, b, nonce()]).size).toBe(3);
  });

  it("detects tampering and unrecognised files", async () => {
    const v = fresh();
    await v.create(PASS);
    await v.set("a", "1");
    v.lock();
    const file = join(dir, "vault.enc");
    const good = readFileSync(file);
    for (const at of [good.length - 1, 30, 5]) { // ciphertext, nonce, cost setting
      const bad = Buffer.from(good);
      bad[at] = bad[at]! ^ 0xff;
      writeFileSync(file, bad);
      expect(["bad_passphrase", "corrupt"]).toContain(await code(fresh().unlock(PASS)));
    }
    writeFileSync(file, "not a vault at all, just some text bytes here");
    expect(await code(fresh().unlock(PASS))).toBe("corrupt");
    writeFileSync(file, good);
    await fresh().unlock(PASS); // the untouched file still opens
  });
});

describe("locking", () => {
  it("locks itself after the idle time, and use() keeps it alive", async () => {
    vi.useFakeTimers();
    const v = fresh({ idleMs: 1000 });
    await v.create(PASS);
    await v.set("a", "1");
    vi.advanceTimersByTime(800);
    await v.use("a", () => 0);
    vi.advanceTimersByTime(800);
    expect(v.isUnlocked()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(v.isUnlocked()).toBe(false);
  });
});

describe("changing the passphrase", () => {
  it("re-encrypts: the old passphrase stops working, the new one opens the same secrets", async () => {
    const v = fresh();
    await v.create(PASS);
    await v.set("a", "kept");
    const before = readFileSync(join(dir, "vault.enc")).subarray(8, 24).toString("hex");
    expect(await code(v.changePassphrase("not the passphrase", "a brand new passphrase"))).toBe("bad_passphrase");
    expect(await code(v.changePassphrase(PASS, "short"))).toBe("weak_passphrase");
    await v.changePassphrase(PASS, "a brand new passphrase");
    expect(readFileSync(join(dir, "vault.enc")).subarray(8, 24).toString("hex")).not.toBe(before); // new salt
    v.lock();
    expect(await code(fresh().unlock(PASS))).toBe("bad_passphrase");
    const n = fresh();
    await n.unlock("a brand new passphrase");
    expect(await n.use("a", (x) => x)).toBe("kept");
  });
});

describe("what errors say", () => {
  it("never include a secret or a passphrase", async () => {
    const v = fresh();
    await v.create(PASS);
    await v.set("a", "very-secret-value-xyz");
    v.lock();
    const messages: string[] = [];
    for (const attempt of [() => v.unlock("guess-passphrase-xyz"), () => v.use("a", () => 0), () => v.set("a", "very-secret-value-xyz")]) {
      try { await attempt(); } catch (e) { messages.push((e as Error).message); }
    }
    expect(messages.join(" ")).not.toMatch(/very-secret-value-xyz|guess-passphrase-xyz|correct horse/);
    expect(messages.every((m) => m.length > 0)).toBe(true);
  });
});
