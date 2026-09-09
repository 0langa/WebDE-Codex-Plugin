import assert from "node:assert/strict";
import { promisify } from "node:util";
import test from "node:test";
import { htmlToText } from "html-to-text";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import nodemailer from "nodemailer";

test("updated mail libraries preserve a Unicode message and attachment without network access", async () => {
  const message = {
    from: "Sender <sender@example.test>",
    to: ["Recipient <recipient@example.test>"],
    subject: "Offline Grüße",
    text: "Hello from a local test.",
    html: "<p>Hello from a <strong>local test</strong>.</p>",
    attachments: [{ filename: "note.txt", content: Buffer.from("Attachment Grüße", "utf8") }],
  };
  const compiled = new MailComposer(message).compile();
  const draft = await promisify(compiled.build.bind(compiled))();
  // Stream transport builds the SMTP message in memory; it cannot deliver mail.
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const sent = await transport.sendMail(message);
  for (const source of [draft, sent.message]) {
    const parsed = await simpleParser(source);
    assert.equal(parsed.subject, message.subject);
    assert.equal(parsed.from.value[0].address, "sender@example.test");
    assert.equal(parsed.to.value[0].address, "recipient@example.test");
    assert.equal(parsed.text.trim(), message.text);
    assert.equal(htmlToText(parsed.html), message.text);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].filename, "note.txt");
    assert.equal(parsed.attachments[0].content.toString("utf8"), "Attachment Grüße");
  }
});
