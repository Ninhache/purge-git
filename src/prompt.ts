import {
  autocompleteMultiselect,
  confirm,
  isCancel,
  multiselect,
  type Option,
} from "@clack/prompts";
import { type Candidate, preselected } from "./discover";

const SEARCH_FROM = 10;
const VISIBLE_ROWS = 12;

export async function pick<Value>(
  message: string,
  options: Option<Value>[],
  initialValues: Value[] = [],
): Promise<Value[] | null> {
  const prompt = options.length > SEARCH_FROM ? autocompleteMultiselect : multiselect;
  const answer = await prompt<Value>({
    message,
    options,
    initialValues,
    maxItems: VISIBLE_ROWS,
    required: false,
  });
  return isCancel(answer) ? null : answer;
}

export async function yes(message: string): Promise<boolean> {
  const answer = await confirm({ message, initialValue: true });
  return !isCancel(answer) && answer;
}

export function emailHint(candidate: Candidate): string {
  const used = candidate.commits > 0 ? `${candidate.commits} commits` : "on your account only";
  const names = candidate.names.length > 0 ? ` · ${candidate.names.join(", ")}` : "";
  const other = candidate.mine ? "" : " · other name";
  return `${used}${names} · ${candidate.sources.join("+")}${other}`;
}

export function pickEmails(found: Candidate[]): Promise<string[] | null> {
  return pick(
    "Which addresses should be rewritten? (space to tick, enter to confirm)",
    found.map((candidate) => ({
      value: candidate.email,
      label: candidate.email,
      hint: emailHint(candidate),
    })),
    found.filter(preselected).map((candidate) => candidate.email),
  );
}

export function confirmLocal(repos: number): Promise<boolean> {
  return yes(
    `Also read your ${repos} repos locally? It finds addresses GitHub no longer links to you, but clones every repo.`,
  );
}

export function pickOrgs(orgs: string[]): Promise<string[] | null> {
  return pick(
    "Which organizations should be rewritten too? Only repos you can push to are used. Other members' clones will break.",
    orgs.map((org) => ({ value: org, label: org })),
  );
}
