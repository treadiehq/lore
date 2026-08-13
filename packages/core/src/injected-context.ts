export interface LoreContextDelimiters {
  readonly start: string;
  readonly end: string;
}

export const GENERIC_LORE_CONTEXT_DELIMITERS: LoreContextDelimiters = {
  start: "--- BEGIN RELEVANT ENGINEERING KNOWLEDGE ---",
  end: "--- END RELEVANT ENGINEERING KNOWLEDGE ---",
};

export const DEVIN_LORE_CONTEXT_DELIMITERS: LoreContextDelimiters = {
  start: "<<< RELEVANT ENGINEERING KNOWLEDGE >>>",
  end: "<<< END RELEVANT ENGINEERING KNOWLEDGE >>>",
};

export const GITHUB_LORE_CONTEXT_DELIMITERS: LoreContextDelimiters = {
  start: "<<< RELEVANT LORE ENGINEERING KNOWLEDGE >>>",
  end: "<<< END RELEVANT LORE ENGINEERING KNOWLEDGE >>>",
};

const LORE_CONTEXT_DELIMITERS = [
  GENERIC_LORE_CONTEXT_DELIMITERS,
  DEVIN_LORE_CONTEXT_DELIMITERS,
  GITHUB_LORE_CONTEXT_DELIMITERS,
] as const;

function marker(line: string): string {
  return line.replace(/\r$/u, "").trim();
}

export function stripLoreInjectedContext(value: string): string {
  const lines = value.split("\n");
  const output: string[] = [];
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const delimiters = LORE_CONTEXT_DELIMITERS.find(
      (candidate) => candidate.start === marker(line),
    );
    if (delimiters === undefined) {
      output.push(line);
      continue;
    }

    let endIndex = -1;
    for (
      let candidateIndex = index + 1;
      candidateIndex < lines.length;
      candidateIndex += 1
    ) {
      if (marker(lines[candidateIndex] ?? "") === delimiters.end) {
        endIndex = candidateIndex;
        break;
      }
    }
    if (endIndex === -1) {
      output.push(line);
      continue;
    }

    changed = true;
    index = endIndex;
  }

  return changed ? output.join("\n") : value;
}
