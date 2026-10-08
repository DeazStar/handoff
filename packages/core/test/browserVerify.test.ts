import { describe, expect, it } from "vitest";
import { verifyContact, verifyContactFromBrowser, type VerifyDeps } from "../src/index.js";

const mailOk: Pick<VerifyDeps, "hasMail"> = { hasMail: async () => true };
const noMail: Pick<VerifyDeps, "hasMail"> = { hasMail: async () => false };
const q = "APPLY VIA EMAIL recruitment@devsdata.com";
const base = { email: "recruitment@devsdata.com", sourceUrl: "https://devsdata.com/careers/job/x/", quote: q, companyDomain: "devsdata.com" };

describe("verifyContact says why it refused", () => {
  const deps = (over: Partial<VerifyDeps>): VerifyDeps => ({ hasMail: async () => true, fetchPage: async () => "", ...over });
  it("separates an unreadable page from an address that is not on a page it could read", async () => {
    const blocked = await verifyContact({ email: "a@x.example", sourceUrl: "https://x.example/c" }, deps({ fetchPage: async () => { throw new Error("the page returned 403"); } }));
    expect(blocked).toMatchObject({ ok: false, code: "unreadable" });
    const absent = await verifyContact({ email: "a@x.example", sourceUrl: "https://x.example/c" }, deps({ fetchPage: async () => "<p>no address here</p>" }));
    expect(absent).toMatchObject({ ok: false, code: "not_on_page" });
    expect(await verifyContact({ email: "nope" }, deps({}))).toMatchObject({ code: "invalid" });
    expect(await verifyContact({ email: "a@x.example" }, deps({ hasMail: async () => false }))).toMatchObject({ code: "no_mail" });
  });
});

describe("verifyContactFromBrowser", () => {
  it("accepts a quote with the address, a page on the company's site and an address at that site", async () => {
    expect(await verifyContactFromBrowser(base, mailOk)).toEqual({ ok: true, email: "recruitment@devsdata.com" });
    expect(await verifyContactFromBrowser({ ...base, sourceUrl: "https://www.devsdata.com/he/careers/", email: "Recruitment@DevsData.com" }, mailOk)).toMatchObject({ ok: true });
    expect(await verifyContactFromBrowser({ ...base, sourceUrl: "https://careers.devsdata.com/x" }, mailOk)).toMatchObject({ ok: true });
  });

  it("accepts an address written the way pages hide it", async () => {
    expect(await verifyContactFromBrowser({ ...base, quote: "Write to recruitment [at] devsdata [dot] com" }, mailOk)).toMatchObject({ ok: true });
  });

  it("refuses a quote that does not contain the address, or is the wrong size", async () => {
    expect(await verifyContactFromBrowser({ ...base, quote: "APPLY VIA EMAIL, details below" }, mailOk)).toMatchObject({ ok: false, code: "not_on_page" });
    expect(await verifyContactFromBrowser({ ...base, quote: "recruitment@devsdata.com extra" + "x".repeat(400) }, mailOk)).toMatchObject({ ok: false });
    expect(await verifyContactFromBrowser({ ...base, quote: "a@b" }, mailOk)).toMatchObject({ ok: false });
    // a longer address that merely contains this one is not the same address
    expect(await verifyContactFromBrowser({ ...base, quote: "write to xrecruitment@devsdata.com today" }, mailOk)).toMatchObject({ ok: false });
  });

  it("refuses a page that is not the company's own site", async () => {
    const r = await verifyContactFromBrowser({ ...base, sourceUrl: "https://jobs.example.org/devsdata" }, mailOk);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/not the company's own site/);
    expect(await verifyContactFromBrowser({ ...base, sourceUrl: "https://notdevsdata.com/x" }, mailOk)).toMatchObject({ ok: false });
  });

  it("refuses an address that is not at the company's domain, such as free mail", async () => {
    const r = await verifyContactFromBrowser({ ...base, email: "someone@gmail.com", quote: "Contact someone@gmail.com for details" }, mailOk);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/not at the company's own domain/);
  });

  it("refuses a domain that takes no mail, a non-web link and a bad address", async () => {
    expect(await verifyContactFromBrowser(base, noMail)).toMatchObject({ ok: false, code: "no_mail" });
    expect(await verifyContactFromBrowser({ ...base, sourceUrl: "javascript:alert(1)" }, mailOk)).toMatchObject({ ok: false });
    expect(await verifyContactFromBrowser({ ...base, email: "not-an-email" }, mailOk)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("falls back to the page's own host when the company's domain is not recorded", async () => {
    expect(await verifyContactFromBrowser({ ...base, companyDomain: undefined }, mailOk)).toMatchObject({ ok: true });
    expect(await verifyContactFromBrowser({ ...base, companyDomain: undefined, email: "x@other.example", quote: "write x@other.example" }, mailOk)).toMatchObject({ ok: false });
  });
});
