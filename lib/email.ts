import nodemailer from "nodemailer";
import { getServerEnv } from "@/lib/env";

export type AppEmail = { to: string; subject: string; text: string; attachments?: { filename: string; content: Buffer; contentType: string }[] };

const globalEmail = globalThis as unknown as { disetechOutbox?: AppEmail[] };

export async function sendEmail(message: AppEmail): Promise<void> {
  const env = getServerEnv();
  if (env.EMAIL_TRANSPORT === "memory") {
    (globalEmail.disetechOutbox ??= []).push({ ...message, attachments: message.attachments?.map((a) => ({ ...a, content: Buffer.from(a.content) })) });
    return;
  }
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  await transport.sendMail({ from: env.EMAIL_FROM, ...message });
}

export function getTestOutbox(): readonly AppEmail[] {
  if (getServerEnv().ENABLE_TEST_ENDPOINTS !== "true") throw new Error("Test outbox disabled");
  return globalEmail.disetechOutbox ?? [];
}

