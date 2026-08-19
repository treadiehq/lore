export const NATIVE_CODING_AGENT_NAMES = [
  "claude",
  "codex",
  "opencode",
] as const;

export type NativeCodingAgentName =
  (typeof NATIVE_CODING_AGENT_NAMES)[number];

const NATIVE_CODING_AGENTS = new Set<string>(NATIVE_CODING_AGENT_NAMES);

export function isNativeCodingAgent(
  agent: string,
): agent is NativeCodingAgentName {
  return NATIVE_CODING_AGENTS.has(agent);
}
