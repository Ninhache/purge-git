import type { Config } from "./config";

export const AI_PRESET = "@ai";

export const AI_LINES = [
  "^Claude-Session:",
  "^Co-Authored-By:.*(claude|anthropic|copilot|cursor|openai|codex|gemini|devin|aider)",
  "Generated with \\[?Claude Code",
];

export function stripPatterns(config: Pick<Config, "stripLines">): string[] {
  const listed = config.stripLines ?? [AI_PRESET];
  return [...new Set(listed.flatMap((pattern) => (pattern === AI_PRESET ? AI_LINES : [pattern])))];
}

export function lineMatchers(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, "i"));
}

export function isLinePattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

export function strippable(message: string, matchers: RegExp[]): number {
  if (matchers.length === 0) return 0;
  return message
    .split("\n")
    .slice(1)
    .filter((line) => matchers.some((matcher) => matcher.test(line))).length;
}

export function messageCallback(patterns: string[]): string {
  const encoded = Buffer.from(JSON.stringify(patterns)).toString("base64");
  return [
    "import base64, json, re",
    `patterns = [re.compile(p.encode(), re.I) for p in json.loads(base64.b64decode(b"${encoded}"))]`,
    'lines = message.split(b"\\n")',
    "kept = lines[:1] + [line for line in lines[1:] if not any(p.search(line) for p in patterns)]",
    "if len(kept) == len(lines):",
    "  return message",
    'return b"\\n".join(kept).rstrip(b"\\n") + b"\\n"',
  ].join("\n");
}
