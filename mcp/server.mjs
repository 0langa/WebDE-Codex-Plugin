import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { htmlToText } from "html-to-text";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import nodemailer from "nodemailer";
import * as z from "zod/v4";
import { loadRuntimeConfig } from "./auth-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));

const server = new McpServer({
  name: "webde-access",
  version,
  instructions:
    "Use this server for private WEB.DE mailbox access via IMAP and SMTP: list folders, search/read mail, manage messages, create drafts, send, reply, forward, and save attachments.",
});

async function withImapClient(work) {
  const config = await loadRuntimeConfig({ pluginRoot });
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.email,
      pass: config.password,
    },
    logger: false,
  });

  await client.connect();
  try {
    return await work(client, config);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function withMailbox(client, mailbox, options, work) {
  await client.mailboxOpen(mailbox, options);
  try {
    return await work();
  } finally {
    await client.mailboxClose().catch(() => {});
  }
}

function getSmtpTransport(config) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    requireTLS: !config.smtpSecure,
    auth: {
      user: config.email,
      pass: config.password,
    },
  });
}

function fromAddress(config) {
  return config.defaultFromName ? `"${config.defaultFromName.replaceAll('"', '\\"')}" <${config.email}>` : config.email;
}

function isInsidePath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveFileAttachment(attachment, config) {
  const resolvedPath = path.resolve(attachment.path);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Attachment file does not exist: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Attachment path is not a file: ${resolvedPath}`);
  }
  if (stats.size > config.maxAttachmentBytes) {
    throw new Error(`Attachment exceeds WEBDE_MAX_ATTACHMENT_MB: ${resolvedPath}`);
  }

  const realPath = fs.realpathSync(resolvedPath);
  if (
    config.allowedAttachmentRoots.length &&
    !config.allowedAttachmentRoots.some((root) => isInsidePath(root, realPath))
  ) {
    throw new Error(`Attachment is outside WEBDE_ALLOWED_ATTACHMENT_ROOTS: ${resolvedPath}`);
  }

  return {
    path: realPath,
    filename: attachment.filename || path.basename(resolvedPath),
    contentType: attachment.contentType || undefined,
  };
}

function buildOutgoingAttachments(inlineAttachments, fileAttachments, config) {
  const combined = [];

  for (const attachment of inlineAttachments || []) {
    if (Buffer.byteLength(attachment.content) > config.maxAttachmentBytes) {
      throw new Error(`Attachment exceeds WEBDE_MAX_ATTACHMENT_MB: ${attachment.filename}`);
    }
    combined.push({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType || undefined,
    });
  }

  for (const attachment of fileAttachments || []) {
    combined.push(resolveFileAttachment(attachment, config));
  }

  return combined.length ? combined : undefined;
}

async function buildMessage({ from, to, cc, bcc, subject, text, html, replyTo, headers, attachments, messageId, keepBcc = false }) {
  const composer = new MailComposer({
    from,
    to,
    cc: cc?.length ? cc : undefined,
    bcc: bcc?.length ? bcc : undefined,
    replyTo: replyTo || undefined,
    subject,
    text,
    html: html || undefined,
    headers,
    attachments,
    messageId,
  });

  const compiled = composer.compile();
  compiled.keepBcc = keepBcc;
  return promisify(compiled.build.bind(compiled))();
}

function makeTextResult(message, structuredContent = undefined) {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    structuredContent,
  };
}

function stringifyNumberLike(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value ?? null;
}

function makeJsonSafe(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Set) {
    return [...value].map(makeJsonSafe);
  }
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, item]) => [key, makeJsonSafe(item)]));
  }
  if (Array.isArray(value)) {
    return value.map(makeJsonSafe);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, makeJsonSafe(item)]));
  }
  return value ?? null;
}

function describeError(error) {
  if (error && typeof error === "object") {
    const parts = [];
    if (typeof error.message === "string" && error.message.trim()) {
      parts.push(error.message.trim());
    }
    if (typeof error.responseText === "string" && error.responseText.trim()) {
      parts.push(error.responseText.trim());
    } else if (typeof error.response === "string" && error.response.trim()) {
      parts.push(error.response.trim());
    }
    if (error.cause && typeof error.cause === "object") {
      if (typeof error.cause.code === "string" && error.cause.code.trim()) {
        parts.push(error.cause.code.trim());
      }
      if (typeof error.cause.message === "string" && error.cause.message.trim()) {
        parts.push(error.cause.message.trim());
      }
    }
    return [...new Set(parts)].join(": ") || "Unknown error";
  }
  return String(error);
}

async function runTool(action) {
  try {
    return await action();
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `WEB.DE request failed: ${describeError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

function setToArray(value) {
  if (!value) {
    return [];
  }
  if (value instanceof Set) {
    return [...value];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function addressList(addresses) {
  return (addresses || [])
    .map((address) => ({
      name: address.name || "",
      address: address.address || "",
    }))
    .filter((address) => address.address);
}

function parsedAddressList(addressObject) {
  return (addressObject?.value || [])
    .map((address) => ({
      name: address.name || "",
      address: address.address || "",
    }))
    .filter((address) => address.address);
}

function firstAddress(addressObject) {
  return parsedAddressList(addressObject)[0]?.address || "";
}

function textFromHtml(html) {
  if (typeof html !== "string" || !html.trim()) {
    return "";
  }

  try {
    return htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      ],
    }).trim();
  } catch {
    return html
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

function parsedMessageText(parsed) {
  if (typeof parsed?.text === "string" && parsed.text.trim()) {
    return parsed.text;
  }

  return textFromHtml(parsed?.html || "");
}

function parsedMessageTextSource(parsed) {
  if (typeof parsed?.text === "string" && parsed.text.trim()) {
    return "text";
  }
  if (typeof parsed?.html === "string" && parsed.html.trim()) {
    return "html";
  }
  return "none";
}

function messageSummary(msg) {
  return {
    seq: msg.seq,
    uid: msg.uid,
    subject: msg.envelope?.subject || "",
    messageId: msg.envelope?.messageId || "",
    inReplyTo: msg.envelope?.inReplyTo || "",
    date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
    internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
    from: addressList(msg.envelope?.from),
    to: addressList(msg.envelope?.to),
    cc: addressList(msg.envelope?.cc),
    flags: setToArray(msg.flags),
    size: msg.size ?? null,
    attachments: collectAttachmentParts(msg.bodyStructure),
  };
}

function collectAttachmentParts(node, parts = []) {
  if (!node) {
    return parts;
  }

  const disposition = (node.disposition || "").toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name || "";
  const type = (node.type || "").toLowerCase();
  const isDisplayBody = type === "text/plain" || type === "text/html";
  const isAttachment = Boolean(node.part && (disposition === "attachment" || filename || (!isDisplayBody && !node.childNodes?.length)));

  if (isAttachment) {
    parts.push({
      part: node.part,
      filename: filename || defaultPartFilename(node),
      contentType: node.type || "application/octet-stream",
      size: node.size ?? null,
      disposition: node.disposition || "",
    });
  }

  for (const child of node.childNodes || []) {
    collectAttachmentParts(child, parts);
  }

  return parts;
}

function defaultPartFilename(node) {
  const extensionByType = {
    "text/calendar": ".ics",
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "text/html": ".html",
  };
  const extension = extensionByType[(node.type || "").toLowerCase()] || "";
  return `part-${node.part}${extension}`;
}

function buildSearchObject(input, options = {}) {
  const omit = new Set(options.omit || []);
  const query = {};
  if (input.unseen) query.seen = false;
  if (input.seen) query.seen = true;
  if (input.flagged) query.flagged = true;
  if (input.from) query.from = input.from;
  if (input.to) query.to = input.to;
  if (input.cc) query.cc = input.cc;
  if (input.subject && !omit.has("subject")) query.subject = input.subject;
  if (input.text) query.text = input.text;
  if (input.body) query.body = input.body;
  if (input.since) query.since = input.since;
  if (input.before) query.before = input.before;
  if (input.on) query.on = input.on;
  if (input.uid) query.uid = input.uid;
  return Object.keys(query).length ? query : { all: true };
}

async function filterIdsBySubject(client, ids, subject) {
  if (!subject || !ids.length) {
    return ids;
  }

  const needle = subject.toLocaleLowerCase();
  const matched = [];
  for await (const msg of client.fetch(
    ids,
    {
      uid: true,
      envelope: true,
    },
    { uid: true },
  )) {
    if ((msg.envelope?.subject || "").toLocaleLowerCase().includes(needle)) {
      matched.push(msg.uid);
    }
  }
  return matched;
}

function normalizeLimit(limit, fallback) {
  if (!limit) {
    return fallback;
  }
  return Math.max(1, Math.min(limit, 500));
}

async function fetchParsedMessage(client, mailbox, uid, config) {
  return withMailbox(client, mailbox, { readOnly: !config.markReadOnFetch }, async () => {
    const msg = await client.fetchOne(
      String(uid),
      {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        size: true,
        bodyStructure: true,
        source: { maxLength: config.maxSourceBytes },
      },
      { uid: true },
    );

    if (!msg) {
      throw new Error(`Message UID ${uid} was not found in ${mailbox}.`);
    }

    const parsed = await simpleParser(msg.source || Buffer.alloc(0));
    return { msg, parsed };
  });
}

function sanitizeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim() || "attachment";
}

function ensureInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside attachment directory: ${child}`);
  }
}

function uniqueFilePath(directory, filename) {
  const parsed = path.parse(sanitizeFilename(filename));
  let candidate = path.join(directory, `${parsed.name}${parsed.ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function defaultDownloadFilename(uid, part, contentType) {
  const extensionByType = {
    "text/calendar": ".ics",
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "text/html": ".html",
    "message/rfc822": ".eml",
  };
  const extension = extensionByType[(contentType || "").toLowerCase()] || "";
  return `message-${uid}-part-${part}${extension}`;
}

function replyRecipients(parsed, config, replyAll) {
  const own = config.email.toLowerCase();
  const seen = new Set();
  const add = (list) => {
    const recipients = [];
    for (const item of list) {
      const address = item.address?.trim();
      if (!address || address.toLowerCase() === own || seen.has(address.toLowerCase())) {
        continue;
      }
      seen.add(address.toLowerCase());
      recipients.push(address);
    }
    return recipients;
  };

  const primary = parsedAddressList(parsed.replyTo).length ? parsedAddressList(parsed.replyTo) : parsedAddressList(parsed.from);
  const to = add(primary);
  const cc = replyAll ? add([...parsedAddressList(parsed.to), ...parsedAddressList(parsed.cc)]) : [];
  return { to, cc };
}

function prefixedSubject(subject, prefix) {
  const clean = subject || "";
  return clean.toLowerCase().startsWith(`${prefix.toLowerCase()}:`) ? clean : `${prefix}: ${clean}`.trim();
}

function quoteOriginal(parsed) {
  const from = firstAddress(parsed.from) || "unknown sender";
  const date = parsed.date ? new Date(parsed.date).toISOString() : "unknown date";
  const body = parsedMessageText(parsed);
  return `\n\nOn ${date}, ${from} wrote:\n${body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")}`;
}

async function sendMailAndMaybeSaveSent(config, message) {
  const attachments = buildOutgoingAttachments(message.attachments, message.fileAttachments, config);
  const transport = getSmtpTransport(config);
  const messageId = `<${globalThis.crypto.randomUUID()}@web.de>`;
  const mail = {
    from: fromAddress(config),
    to: message.to,
    cc: message.cc?.length ? message.cc : undefined,
    bcc: message.bcc?.length ? message.bcc : undefined,
    replyTo: message.replyTo || undefined,
    subject: message.subject,
    text: message.text,
    html: message.html || undefined,
    headers: message.headers,
    attachments,
    messageId,
  };

  const result = await transport.sendMail(mail);
  let sentAppend = null;

  if (message.saveSentCopy ?? config.saveSentCopy) {
    const raw = await buildMessage({ ...mail, keepBcc: true });
    sentAppend = await withImapClient((client, nestedConfig) =>
      client.append(nestedConfig.folders.sent, raw, ["\\Seen"]),
    );
  }

  return {
    messageId: result.messageId ?? null,
    accepted: result.accepted ?? [],
    rejected: result.rejected ?? [],
    response: result.response ?? null,
    sentCopy: sentAppend
      ? {
          mailbox: config.folders.sent,
          uid: stringifyNumberLike(sentAppend.uid),
          uidValidity: stringifyNumberLike(sentAppend.uidValidity),
        }
      : null,
  };
}

const emailSchema = z.array(z.string().email()).min(1);
const optionalEmailListSchema = z.array(z.string().email()).optional();
const mailboxSchema = z.string().min(1);
const uidSchema = z.number().int().positive();
const uidListSchema = z.array(uidSchema).min(1).max(100);
const attachmentSchema = z
  .array(
    z.object({
      filename: z.string().min(1),
      content: z.string(),
      contentType: z.string().optional(),
    }),
  )
  .optional();
const fileAttachmentSchema = z
  .array(
    z.object({
      path: z.string().min(1),
      filename: z.string().min(1).optional(),
      contentType: z.string().optional(),
    }),
  )
  .optional();

server.registerTool(
  "check_webde_connection",
  {
    title: "Check WEB.DE Connection",
    description: "Verify IMAP access, configured mailbox names, and SMTP access for sending.",
    inputSchema: {},
  },
  async () =>
    runTool(() =>
      withImapClient(async (client, config) => {
        const mailboxes = await client.list();
        const folderChecks = {};

        for (const [key, mailbox] of Object.entries(config.folders)) {
          try {
            const status = await client.status(mailbox, {
              messages: true,
              unseen: true,
              uidNext: true,
              uidValidity: true,
            });
            folderChecks[key] = {
              mailbox,
              ok: true,
              messages: stringifyNumberLike(status.messages),
              unseen: stringifyNumberLike(status.unseen),
              uidNext: stringifyNumberLike(status.uidNext),
              uidValidity: stringifyNumberLike(status.uidValidity),
            };
          } catch (error) {
            folderChecks[key] = { mailbox, ok: false, error: describeError(error) };
          }
        }

        const transport = getSmtpTransport(config);
        await transport.verify();

        return makeTextResult(
          `Connected to ${config.email}. IMAP verified at ${config.imapHost}:${config.imapPort}. SMTP verified at ${config.smtpHost}:${config.smtpPort}.`,
          {
            email: config.email,
            imapHost: config.imapHost,
            imapPort: config.imapPort,
            imapSecure: config.imapSecure,
            smtpHost: config.smtpHost,
            smtpPort: config.smtpPort,
            smtpSecure: config.smtpSecure,
            folders: folderChecks,
            availableMailboxes: mailboxes.map((mailbox) => mailbox.path),
          },
        );
      }),
    ),
);

server.registerTool(
  "list_webde_mailboxes",
  {
    title: "List WEB.DE Mailboxes",
    description: "List all folders/mailboxes available through WEB.DE IMAP.",
    inputSchema: {},
  },
  async () =>
    runTool(() =>
      withImapClient(async (client) => {
        const mailboxes = await client.list();
        return makeTextResult(`Found ${mailboxes.length} WEB.DE mailboxes.`, {
          mailboxes: mailboxes.map((mailbox) => ({
            path: mailbox.path,
            name: mailbox.name,
            delimiter: mailbox.delimiter,
            flags: setToArray(mailbox.flags),
            specialUse: mailbox.specialUse || "",
            subscribed: Boolean(mailbox.subscribed),
            listed: Boolean(mailbox.listed),
          })),
        });
      }),
    ),
);

server.registerTool(
  "get_webde_mailbox_status",
  {
    title: "Get WEB.DE Mailbox Status",
    description: "Get message counts and UID metadata for a WEB.DE mailbox.",
    inputSchema: {
      mailbox: mailboxSchema,
    },
  },
  async ({ mailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const status = await client.status(mailbox, {
          messages: true,
          recent: true,
          unseen: true,
          uidNext: true,
          uidValidity: true,
          highestModseq: true,
        });

        return makeTextResult(`Status loaded for ${mailbox}.`, {
          mailbox,
          messages: stringifyNumberLike(status.messages),
          recent: stringifyNumberLike(status.recent),
          unseen: stringifyNumberLike(status.unseen),
          uidNext: stringifyNumberLike(status.uidNext),
          uidValidity: stringifyNumberLike(status.uidValidity),
          highestModseq: stringifyNumberLike(status.highestModseq),
        });
      }),
    ),
);

server.registerTool(
  "get_webde_quota",
  {
    title: "Get WEB.DE Quota",
    description: "Get storage quota information reported by the WEB.DE IMAP server.",
    inputSchema: {
      mailbox: z.string().optional(),
    },
  },
  async ({ mailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const quota = await client.getQuota(mailbox || undefined);
        return makeTextResult(quota ? "Loaded WEB.DE quota information." : "WEB.DE did not return quota information.", {
          mailbox: mailbox || null,
          quota: makeJsonSafe(quota),
        });
      }),
    ),
);

server.registerTool(
  "search_webde_messages",
  {
    title: "Search WEB.DE Messages",
    description: "Search a WEB.DE mailbox and return message summaries. Uses IMAP search terms.",
    inputSchema: {
      mailbox: mailboxSchema.default("INBOX"),
      text: z.string().optional(),
      subject: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      cc: z.string().optional(),
      body: z.string().optional(),
      since: z.string().optional(),
      before: z.string().optional(),
      on: z.string().optional(),
      uid: z.string().optional(),
      unseen: z.boolean().optional(),
      seen: z.boolean().optional(),
      flagged: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  },
  async (input) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, input.mailbox, { readOnly: true }, async () => {
          const searchObject = buildSearchObject(input, { omit: input.subject ? ["subject"] : [] });
          const searchedIds = (await client.search(searchObject, { uid: true })) || [];
          const ids = await filterIdsBySubject(client, searchedIds, input.subject);
          const limit = normalizeLimit(input.limit, config.maxFetchMessages);
          const selectedIds = ids.slice(-limit).reverse();
          const messages = [];

          if (selectedIds.length) {
            for await (const msg of client.fetch(
              selectedIds,
              {
                uid: true,
                flags: true,
                envelope: true,
                internalDate: true,
                size: true,
                bodyStructure: true,
              },
              { uid: true },
            )) {
              messages.push(messageSummary(msg));
            }
          }

          messages.sort((a, b) => selectedIds.indexOf(a.uid) - selectedIds.indexOf(b.uid));

          return makeTextResult(`Found ${ids.length} matching messages in ${input.mailbox}; returning ${messages.length}.`, {
            mailbox: input.mailbox,
            totalMatches: ids.length,
            returned: messages.length,
            messages,
          });
        }),
      ),
    ),
);

server.registerTool(
  "export_webde_message",
  {
    title: "Export WEB.DE Message",
    description: "Export a full raw WEB.DE message as a local .eml file.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      filename: z.string().min(1).optional(),
    },
  },
  async ({ mailbox, uid, filename }) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, mailbox, { readOnly: true }, async () => {
          fs.mkdirSync(config.attachmentDownloadDir, { recursive: true });
          const msg = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
          if (!msg) {
            throw new Error(`Message UID ${uid} was not found in ${mailbox}.`);
          }

          const { meta, content } = await client.download(String(uid), undefined, {
            uid: true,
            maxBytes: config.maxSourceBytes,
          });
          const subject = msg.envelope?.subject ? sanitizeFilename(msg.envelope.subject).slice(0, 80) : `message-${uid}`;
          const outputPath = uniqueFilePath(config.attachmentDownloadDir, filename || `${subject}-${uid}.eml`);
          ensureInside(config.attachmentDownloadDir, outputPath);
          await pipeline(content, fs.createWriteStream(outputPath));

          return makeTextResult(`Exported ${mailbox}/${uid} to ${outputPath}.`, {
            mailbox,
            uid,
            outputPath,
            filename: path.basename(outputPath),
            contentType: meta.contentType || "message/rfc822",
            expectedSize: meta.expectedSize ?? null,
          });
        }),
      ),
    ),
);

server.registerTool(
  "read_webde_message",
  {
    title: "Read WEB.DE Message",
    description: "Read and parse a WEB.DE message body by mailbox and UID.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      includeHtml: z.boolean().default(false),
    },
  },
  async ({ mailbox, uid, includeHtml }) =>
    runTool(() =>
      withImapClient(async (client, config) => {
        const { msg, parsed } = await fetchParsedMessage(client, mailbox, uid, config);
        const summary = messageSummary(msg);
        const text = parsedMessageText(parsed);
        return makeTextResult(`Loaded message ${uid} from ${mailbox}: ${summary.subject || "(no subject)"}.`, {
          mailbox,
          uid,
          ...summary,
          parsed: {
            subject: parsed.subject || "",
            messageId: parsed.messageId || "",
            inReplyTo: parsed.inReplyTo || "",
            references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
            date: parsed.date ? new Date(parsed.date).toISOString() : null,
            from: parsedAddressList(parsed.from),
            to: parsedAddressList(parsed.to),
            cc: parsedAddressList(parsed.cc),
            bcc: parsedAddressList(parsed.bcc),
            replyTo: parsedAddressList(parsed.replyTo),
            text,
            textSource: parsedMessageTextSource(parsed),
            hasHtmlBody: typeof parsed.html === "string" && parsed.html.trim().length > 0,
            html: includeHtml ? parsed.html || "" : "",
            attachments: (parsed.attachments || []).map((attachment, index) => ({
              index,
              filename: attachment.filename || `attachment-${index + 1}`,
              contentType: attachment.contentType || "application/octet-stream",
              size: attachment.size ?? attachment.content?.length ?? null,
              contentId: attachment.contentId || "",
              related: Boolean(attachment.related),
            })),
          },
        });
      }),
    ),
);

server.registerTool(
  "download_webde_attachment",
  {
    title: "Download WEB.DE Attachment",
    description: "Download one attachment/body part from a WEB.DE message to the configured local attachment directory.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      part: z.string().min(1),
      filename: z.string().min(1).optional(),
    },
  },
  async ({ mailbox, uid, part, filename }) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, mailbox, { readOnly: true }, async () => {
          fs.mkdirSync(config.attachmentDownloadDir, { recursive: true });
          const { meta, content } = await client.download(String(uid), part, {
            uid: true,
            maxBytes: config.maxAttachmentBytes,
          });
          const outputPath = uniqueFilePath(
            config.attachmentDownloadDir,
            filename || meta.filename || defaultDownloadFilename(uid, part, meta.contentType),
          );
          ensureInside(config.attachmentDownloadDir, outputPath);
          await pipeline(content, fs.createWriteStream(outputPath));
          const downloadedSize = fs.statSync(outputPath).size;

          return makeTextResult(`Downloaded attachment part ${part} from ${mailbox}/${uid}.`, {
            mailbox,
            uid,
            part,
            outputPath,
            filename: path.basename(outputPath),
            contentType: meta.contentType || "application/octet-stream",
            size: downloadedSize,
            expectedSize: downloadedSize,
          });
        }),
      ),
    ),
);

server.registerTool(
  "create_webde_draft",
  {
    title: "Create WEB.DE Draft",
    description: "Create a draft email in the configured WEB.DE drafts folder without sending it.",
    inputSchema: {
      to: emailSchema,
      subject: z.string().default(""),
      text: z.string().default(""),
      html: z.string().optional(),
      cc: optionalEmailListSchema,
      bcc: optionalEmailListSchema,
      replyTo: z.string().email().optional(),
      attachments: attachmentSchema,
      fileAttachments: fileAttachmentSchema,
    },
  },
  async ({ to, subject, text, html, cc, bcc, replyTo, attachments, fileAttachments }) => {
    if (!text.trim() && !(html && html.trim())) {
      throw new Error("Provide either plain text or HTML content for the draft.");
    }

    return runTool(() =>
      withImapClient(async (client, config) => {
        const message = await buildMessage({
          from: fromAddress(config),
          to,
          cc,
          bcc,
          replyTo,
          subject,
          text,
          html,
          attachments: buildOutgoingAttachments(attachments, fileAttachments, config),
          keepBcc: true,
          headers: {
            "X-Unsent": "1",
          },
        });

        const appendResult = await client.append(config.folders.drafts, message, ["\\Draft"]);
        if (!appendResult) {
          throw new Error("WEB.DE did not confirm the draft append request.");
        }

        return makeTextResult(`Draft saved to ${config.folders.drafts} for ${to.join(", ")}.`, {
          mailbox: config.folders.drafts,
          uid: stringifyNumberLike(appendResult.uid),
          uidValidity: stringifyNumberLike(appendResult.uidValidity),
          subject,
          to,
          cc: cc || [],
          bcc: bcc || [],
          attachmentCount: (attachments?.length || 0) + (fileAttachments?.length || 0),
        });
      }),
    );
  },
);

server.registerTool(
  "send_webde_email",
  {
    title: "Send WEB.DE Email",
    description: "Send an email through the connected WEB.DE account using SMTP.",
    inputSchema: {
      to: emailSchema,
      subject: z.string().default(""),
      text: z.string().default(""),
      html: z.string().optional(),
      cc: optionalEmailListSchema,
      bcc: optionalEmailListSchema,
      replyTo: z.string().email().optional(),
      attachments: attachmentSchema,
      fileAttachments: fileAttachmentSchema,
      saveSentCopy: z.boolean().optional(),
    },
  },
  async ({ to, subject, text, html, cc, bcc, replyTo, attachments, fileAttachments, saveSentCopy }) => {
    if (!text.trim() && !(html && html.trim())) {
      throw new Error("Provide either plain text or HTML content for the email.");
    }

    return runTool(async () => {
      const config = await loadRuntimeConfig({ pluginRoot });
      const result = await sendMailAndMaybeSaveSent(config, {
        to,
        subject,
        text,
        html,
        cc,
        bcc,
        replyTo,
        attachments,
        fileAttachments,
        saveSentCopy,
      });

      return makeTextResult(`Email sent to ${to.join(", ")} from ${config.email}.`, result);
    });
  },
);

server.registerTool(
  "reply_webde_email",
  {
    title: "Reply To WEB.DE Email",
    description: "Reply or reply-all to an existing WEB.DE message by mailbox and UID.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      text: z.string().default(""),
      html: z.string().optional(),
      replyAll: z.boolean().default(false),
      includeOriginal: z.boolean().default(true),
      cc: optionalEmailListSchema,
      bcc: optionalEmailListSchema,
      attachments: attachmentSchema,
      fileAttachments: fileAttachmentSchema,
      saveSentCopy: z.boolean().optional(),
    },
  },
  async ({ mailbox, uid, text, html, replyAll, includeOriginal, cc, bcc, attachments, fileAttachments, saveSentCopy }) => {
    if (!text.trim() && !(html && html.trim())) {
      throw new Error("Provide either plain text or HTML content for the reply.");
    }

    return runTool(() =>
      withImapClient(async (client, config) => {
        const { parsed } = await fetchParsedMessage(client, mailbox, uid, config);
        const recipients = replyRecipients(parsed, config, replyAll);
        if (!recipients.to.length) {
          throw new Error("No reply recipient could be inferred from the original message.");
        }

        const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
        const messageId = parsed.messageId || "";
        const result = await sendMailAndMaybeSaveSent(config, {
          to: recipients.to,
          cc: [...recipients.cc, ...(cc || [])],
          bcc,
          subject: prefixedSubject(parsed.subject, "Re"),
          text: `${text}${includeOriginal ? quoteOriginal(parsed) : ""}`,
          html,
          attachments,
          fileAttachments,
          saveSentCopy,
          headers: {
            ...(messageId ? { "In-Reply-To": messageId } : {}),
            ...(references.length || messageId ? { References: [...references, messageId].filter(Boolean).join(" ") } : {}),
          },
        });

        return makeTextResult(`Reply sent for ${mailbox}/${uid}.`, {
          original: { mailbox, uid, subject: parsed.subject || "" },
          to: recipients.to,
          cc: [...recipients.cc, ...(cc || [])],
          ...result,
        });
      }),
    );
  },
);

server.registerTool(
  "forward_webde_email",
  {
    title: "Forward WEB.DE Email",
    description: "Forward an existing WEB.DE message by mailbox and UID.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      to: emailSchema,
      text: z.string().default(""),
      html: z.string().optional(),
      cc: optionalEmailListSchema,
      bcc: optionalEmailListSchema,
      includeOriginalAttachments: z.boolean().default(false),
      attachments: attachmentSchema,
      fileAttachments: fileAttachmentSchema,
      saveSentCopy: z.boolean().optional(),
    },
  },
  async ({
    mailbox,
    uid,
    to,
    text,
    html,
    cc,
    bcc,
    includeOriginalAttachments,
    attachments,
    fileAttachments,
    saveSentCopy,
  }) =>
    runTool(() =>
      withImapClient(async (client, config) => {
        const { parsed } = await fetchParsedMessage(client, mailbox, uid, config);
        const originalAttachments = includeOriginalAttachments
          ? (parsed.attachments || []).map((attachment, index) => ({
              filename: attachment.filename || `forwarded-attachment-${index + 1}`,
              content: attachment.content,
              contentType: attachment.contentType || undefined,
            }))
          : [];

        const forwardText = `${text || ""}\n\n---------- Forwarded message ---------\nFrom: ${firstAddress(parsed.from)}\nDate: ${
          parsed.date ? new Date(parsed.date).toISOString() : ""
        }\nSubject: ${parsed.subject || ""}\nTo: ${parsedAddressList(parsed.to)
          .map((address) => address.address)
          .join(", ")}\n\n${parsedMessageText(parsed)}`;

        const result = await sendMailAndMaybeSaveSent(config, {
          to,
          cc,
          bcc,
          subject: prefixedSubject(parsed.subject, "Fwd"),
          text: forwardText,
          html,
          attachments: [...(attachments || []), ...originalAttachments],
          fileAttachments,
          saveSentCopy,
        });

        return makeTextResult(`Forwarded ${mailbox}/${uid} to ${to.join(", ")}.`, {
          original: { mailbox, uid, subject: parsed.subject || "" },
          to,
          includedOriginalAttachments: originalAttachments.length,
          ...result,
        });
      }),
    ),
);

server.registerTool(
  "mark_webde_messages",
  {
    title: "Mark WEB.DE Messages",
    description: "Mark WEB.DE messages as read, unread, starred, or unstarred by UID.",
    inputSchema: {
      mailbox: mailboxSchema,
      uids: uidListSchema,
      action: z.enum(["read", "unread", "star", "unstar"]),
    },
  },
  async ({ mailbox, uids, action }) =>
    runTool(() =>
      withImapClient((client) =>
        withMailbox(client, mailbox, { readOnly: false }, async () => {
          const flag = action === "read" || action === "unread" ? "\\Seen" : "\\Flagged";
          const add = action === "read" || action === "star";
          const ok = add
            ? await client.messageFlagsAdd(uids, [flag], { uid: true })
            : await client.messageFlagsRemove(uids, [flag], { uid: true });

          return makeTextResult(`Marked ${uids.length} message(s) in ${mailbox} as ${action}.`, {
            mailbox,
            uids,
            action,
            ok,
          });
        }),
      ),
    ),
);

server.registerTool(
  "move_webde_messages",
  {
    title: "Move WEB.DE Messages",
    description: "Move WEB.DE messages from one mailbox to another by UID.",
    inputSchema: {
      sourceMailbox: mailboxSchema,
      destinationMailbox: mailboxSchema,
      uids: uidListSchema,
    },
  },
  async ({ sourceMailbox, destinationMailbox, uids }) =>
    runTool(() =>
      withImapClient((client) =>
        withMailbox(client, sourceMailbox, { readOnly: false }, async () => {
          const result = await client.messageMove(uids, destinationMailbox, { uid: true });
          return makeTextResult(`Moved ${uids.length} message(s) from ${sourceMailbox} to ${destinationMailbox}.`, {
            sourceMailbox,
            destinationMailbox,
            uids,
            uidMap: result?.uidMap ? Object.fromEntries(result.uidMap) : null,
          });
        }),
      ),
    ),
);

server.registerTool(
  "delete_webde_messages",
  {
    title: "Delete WEB.DE Messages",
    description: "Move WEB.DE messages to trash, or permanently delete them when permanent is true.",
    inputSchema: {
      mailbox: mailboxSchema,
      uids: uidListSchema,
      permanent: z.boolean().default(false),
    },
  },
  async ({ mailbox, uids, permanent }) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, mailbox, { readOnly: false }, async () => {
          if (permanent) {
            const ok = await client.messageDelete(uids, { uid: true });
            return makeTextResult(`Permanently deleted ${uids.length} message(s) from ${mailbox}.`, {
              mailbox,
              uids,
              permanent: true,
              ok,
            });
          }

          const result = await client.messageMove(uids, config.folders.trash, { uid: true });
          return makeTextResult(`Moved ${uids.length} message(s) from ${mailbox} to ${config.folders.trash}.`, {
            mailbox,
            trashMailbox: config.folders.trash,
            uids,
            permanent: false,
            uidMap: result?.uidMap ? Object.fromEntries(result.uidMap) : null,
          });
        }),
      ),
    ),
);

server.registerTool(
  "copy_webde_messages",
  {
    title: "Copy WEB.DE Messages",
    description: "Copy WEB.DE messages from one mailbox to another by UID.",
    inputSchema: {
      sourceMailbox: mailboxSchema,
      destinationMailbox: mailboxSchema,
      uids: uidListSchema,
    },
  },
  async ({ sourceMailbox, destinationMailbox, uids }) =>
    runTool(() =>
      withImapClient((client) =>
        withMailbox(client, sourceMailbox, { readOnly: false }, async () => {
          const result = await client.messageCopy(uids, destinationMailbox, { uid: true });
          return makeTextResult(`Copied ${uids.length} message(s) from ${sourceMailbox} to ${destinationMailbox}.`, {
            sourceMailbox,
            destinationMailbox,
            uids,
            uidMap: result?.uidMap ? Object.fromEntries(result.uidMap) : null,
          });
        }),
      ),
    ),
);

server.registerTool(
  "create_webde_mailbox",
  {
    title: "Create WEB.DE Mailbox",
    description: "Create a WEB.DE folder/mailbox.",
    inputSchema: {
      mailbox: mailboxSchema,
    },
  },
  async ({ mailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const result = await client.mailboxCreate(mailbox);
        return makeTextResult(`Created WEB.DE mailbox ${mailbox}.`, {
          mailbox,
          created: Boolean(result),
          result,
        });
      }),
    ),
);

server.registerTool(
  "rename_webde_mailbox",
  {
    title: "Rename WEB.DE Mailbox",
    description: "Rename a WEB.DE folder/mailbox.",
    inputSchema: {
      mailbox: mailboxSchema,
      newMailbox: mailboxSchema,
    },
  },
  async ({ mailbox, newMailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const result = await client.mailboxRename(mailbox, newMailbox);
        return makeTextResult(`Renamed WEB.DE mailbox ${mailbox} to ${newMailbox}.`, {
          mailbox,
          newMailbox,
          renamed: Boolean(result),
          result,
        });
      }),
    ),
);

server.registerTool(
  "set_webde_mailbox_subscription",
  {
    title: "Set WEB.DE Mailbox Subscription",
    description: "Subscribe or unsubscribe a WEB.DE mailbox in IMAP.",
    inputSchema: {
      mailbox: mailboxSchema,
      subscribed: z.boolean(),
    },
  },
  async ({ mailbox, subscribed }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const ok = subscribed ? await client.mailboxSubscribe(mailbox) : await client.mailboxUnsubscribe(mailbox);
        return makeTextResult(`${subscribed ? "Subscribed to" : "Unsubscribed from"} WEB.DE mailbox ${mailbox}.`, {
          mailbox,
          subscribed,
          ok,
        });
      }),
    ),
);

server.registerTool(
  "delete_webde_mailbox",
  {
    title: "Delete WEB.DE Mailbox",
    description: "Delete a WEB.DE folder/mailbox. This is for user-created folders, not system folders.",
    inputSchema: {
      mailbox: mailboxSchema,
    },
  },
  async ({ mailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const protectedNames = new Set(["INBOX", "Gesendet", "Entwurf", "Entwürfe", "Papierkorb", "Spam", "Postausgang"]);
        if (protectedNames.has(mailbox)) {
          throw new Error(`Refusing to delete protected mailbox: ${mailbox}`);
        }
        const result = await client.mailboxDelete(mailbox);
        return makeTextResult(`Deleted WEB.DE mailbox ${mailbox}.`, {
          mailbox,
          deleted: Boolean(result),
          result,
        });
      }),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
