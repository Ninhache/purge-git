import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { PurgeError } from "./errors";

const REPO_NAME = /^[A-Za-z0-9._-]+$/;

export const configSchema = z.object({
  owner: z.string().regex(REPO_NAME),
  identity: z.object({
    name: z.string().min(1),
    email: z.email(),
  }),
  oldEmails: z.array(z.email()).min(1),
  orgs: z.array(z.string().regex(REPO_NAME)).optional(),
});

export type Config = z.infer<typeof configSchema>;

export const TEMPLATE: z.input<typeof configSchema> = {
  owner: "your-login",
  identity: { name: "Your Name", email: "12345+your-login@users.noreply.github.com" },
  oldEmails: ["old@example.com"],
};

export function isRepoName(value: string): boolean {
  return REPO_NAME.test(value) && value !== "." && value !== "..";
}

export async function loadConfig(path: string): Promise<Config> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    throw new PurgeError(`No config at ${path}. Run \`purge-git init\` and fill it in.`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new PurgeError(`${path} is readable by others. Run \`chmod 600 ${path}\`.`);
  }
  const parsed = configSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    throw new PurgeError(`Invalid config ${path}: ${z.prettifyError(parsed.error)}`);
  }
  const identity = parsed.data.identity.email.toLowerCase();
  if (parsed.data.oldEmails.some((email) => email.toLowerCase() === identity)) {
    throw new PurgeError("The identity email cannot be one of the old emails.");
  }
  return parsed.data;
}

export type ConfigState = "none" | "template" | "custom";

export async function configState(path: string): Promise<ConfigState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return "none";
  }
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(TEMPLATE) ? "template" : "custom";
  } catch {
    return "custom";
  }
}

export async function writeConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(path, 0o600).catch(() => undefined);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeTemplate(path: string): Promise<boolean> {
  if ((await configState(path)) !== "none") return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(TEMPLATE, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return true;
}
