export interface LxCommand {
  action: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse an `lx` CLI command string into structured form.
 */
export function parseLxCommand(input: string): LxCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("lx ")) return null;

  const rest = trimmed.slice(3).trim();
  if (!rest) return null;

  const tokens = tokenize(rest);
  if (tokens.length === 0) return null;

  const action = tokens[0];
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const flagName = token.slice(2);
      // Check if next token is a value (not a flag)
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        flags[flagName] = tokens[i + 1];
        i += 2;
      } else {
        flags[flagName] = true;
        i++;
      }
    } else {
      args.push(token);
      i++;
    }
  }

  return { action, args, flags };
}

/**
 * Tokenize a command string, respecting quoted strings.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const char of input) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " ") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);

  return tokens;
}

/**
 * Expand variables in a hook command template.
 */
export function expandHookCommand(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\$(\w+)/g, (match, name) => {
    return vars[name] ?? match;
  });
}
