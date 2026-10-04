import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { beforeEach, describe, expect, it } from "vitest";
import { createVault, type Vault } from "@jobhunt/vault";
import { MailError, createMailer, type SmtpLogin } from "../src/mail.js";

const PASS = "correct horse battery";
const PASSWORD = "abcdwxyzabcdwxyz";
let vault: Vault;
let logins: SmtpLogin[];

const recording = () => (login: SmtpLogin) => {
  logins.push(login);
  return nodemailer.createTransport({ jsonTransport: true });
};
const mailer = (opts = {}) => createMailer(vault, { transportFactory: recording(), dryRun: true, ...opts });
const hello = { to: "hr@acme.example", subject: "Application: Backend Engineer, Ada Lovelace", text: "Hello,\n\nI would like to apply.\n\nAda" };
const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as MailError).code ?? "other"; }
  return "no error";
};

beforeEach(async () => {
  vault = createVault(mkdtempSync(join(tmpdir(), "mail-")), { logN: 10 });
  await vault.create(PASS);
  await vault.set("mail.smtp", JSON.stringify({ host: "smtp.gmail.com", port: 465, user: "ada@example.com", password: PASSWORD }));
  logins = [];
});

describe("sending", () => {
  it("builds a plain text message from the stored login, with BCC and Reply-To", async () => {
    const r = await mailer().send({ ...hello, fromName: "Ada Lovelace", bcc: ["ada@example.com"], attachments: [{ filename: "Ada-CV.pdf", content: Buffer.from("%PDF-1.4 test") }] });
    expect(r.dryRun).toBe(true);
    const m = JSON.parse(r.preview!);
    expect(m.from).toEqual({ address: "ada@example.com", name: "Ada Lovelace" });
    expect(m.to).toEqual([{ address: "hr@acme.example", name: "" }]);
    expect(m.bcc).toEqual([{ address: "ada@example.com", name: "" }]);
    expect(m.replyTo).toEqual([{ address: "ada@example.com", name: "" }]);
    expect(m.subject).toBe(hello.subject);
    expect(m.text).toBe(hello.text);
    expect(m.html).toBeUndefined(); // plain text only
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ filename: "Ada-CV.pdf", contentType: "application/pdf" });
    expect(Buffer.from(m.attachments[0].content, "base64").toString()).toBe("%PDF-1.4 test");
  });

  it("gives the password to the transport and nowhere else", async () => {
    const r = await mailer().send(hello);
    expect(logins).toEqual([{ host: "smtp.gmail.com", port: 465, user: "ada@example.com", password: PASSWORD }]);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(r.preview).not.toContain(PASSWORD);
  });

  it("cleans attachment names", async () => {
    const r = await mailer().send({ ...hello, attachments: [{ filename: "../../etc/passwd\r\n.pdf", content: Buffer.from("x") }] });
    const name = JSON.parse(r.preview!).attachments[0].filename;
    expect(name).not.toMatch(/[\\/\r\n]/);
  });
});

describe("what it refuses", () => {
  it("needs the vault unlocked and the login saved", async () => {
    await vault.remove("mail.smtp");
    expect(await code(mailer().send(hello))).toBe("not_configured");
    vault.lock();
    expect(await code(mailer().send(hello))).toBe("locked"); // the vault's own code
  });

  it("refuses a damaged saved login", async () => {
    await vault.set("mail.smtp", "not json");
    expect(await code(mailer().send(hello))).toBe("not_configured");
  });

  it("refuses bad addresses and header injection before touching the network", async () => {
    const m = mailer();
    for (const bad of [{ to: "nobody" }, { to: "a@b" }, { to: "a@b.c\r\nBcc: evil@x.example" }, { to: "Ada <a@b.example>" }, { to: "a@b.example, c@d.example" }]) {
      expect(await code(m.send({ ...hello, ...bad })), JSON.stringify(bad)).toBe("invalid");
    }
    expect(await code(m.send({ ...hello, subject: "Hi\r\nBcc: evil@x.example" }))).toBe("invalid");
    expect(await code(m.send({ ...hello, subject: "  " }))).toBe("invalid");
    expect(await code(m.send({ ...hello, fromName: "Ada\nBcc: evil@x.example" }))).toBe("invalid");
    expect(await code(m.send({ ...hello, replyTo: "bad" }))).toBe("invalid");
    expect(await code(m.send({ ...hello, bcc: ["a@b.example", "c@d.example", "e@f.example", "g@h.example"] }))).toBe("invalid");
    expect(await code(m.send({ ...hello, text: "   " }))).toBe("invalid");
    expect(await code(m.send({ ...hello, text: "x".repeat(20_001) }))).toBe("invalid");
    expect(await code(m.send({ ...hello, attachments: [{ filename: "big.pdf", content: Buffer.alloc(5 * 1024 * 1024 + 1) }] }))).toBe("invalid");
    expect(logins).toEqual([]); // the login was never even read
  });
});

describe("when sending fails", () => {
  const failing = (err: object) => () => ({ sendMail: async () => { throw err; }, close() {} }) as never;
  const cases: [string, string][] = [["EAUTH", "auth"], ["ETIMEDOUT", "unreachable"], ["ENOTFOUND", "unreachable"], ["EENVELOPE", "rejected"], ["EWHATEVER", "failed"]];

  for (const [from, to] of cases) {
    it(`${from} becomes "${to}" with fixed text that does not echo the server`, async () => {
      const m = createMailer(vault, { transportFactory: failing({ code: from, message: `535 secret-from-server ${PASSWORD}`, response: `user ada@example.com ${PASSWORD}` }) });
      let err: MailError | undefined;
      try { await m.send(hello); } catch (e) { err = e as MailError; }
      expect(err?.code).toBe(to);
      expect(err?.message).not.toMatch(/secret-from-server|abcdwxyz|ada@example/);
    });
  }

  it("closes the transport even when sending fails", async () => {
    let closed = 0;
    const m = createMailer(vault, { transportFactory: () => ({ sendMail: async () => { throw { code: "EAUTH" }; }, close: () => { closed++; } }) as never });
    await code(m.send(hello));
    expect(closed).toBe(1);
  });
});
