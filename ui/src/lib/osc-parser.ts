export interface OscEvent {
  code: number;
  param?: string;
  data: string;
}

export interface OscHook {
  osc: number;
  param?: string;
  when?: string;
  run: string;
}

/**
 * Parse an OSC escape sequence from terminal output.
 * Format: ESC ] code ; data BEL  or  ESC ] code ; data ST
 */
export function parseOsc(input: string): OscEvent | null {
  // Match OSC: \x1b] followed by content, terminated by \x07 (BEL) or \x1b\\ (ST)
  const match = input.match(/\x1b\](\d+);(.*?)(?:\x07|\x1b\\)/);
  if (!match) return null;

  const code = parseInt(match[1], 10);
  const rawData = match[2];

  // For OSC 133, the first character after ; is the param (e.g., "D;0" or "E;git switch main")
  if (code === 133 && rawData.length > 0) {
    const semiIdx = rawData.indexOf(";");
    if (semiIdx >= 0) {
      return {
        code,
        param: rawData.substring(0, semiIdx),
        data: rawData.substring(semiIdx + 1),
      };
    }
    return { code, param: rawData, data: "" };
  }

  return { code, data: rawData };
}

/**
 * Evaluate a hook condition against an OSC event.
 */
function evaluateCondition(when: string, event: OscEvent): boolean {
  try {
    // Build context variables based on OSC type
    const vars: Record<string, string> = {};

    if (event.code === 133 && event.param === "D") {
      vars.exitCode = event.data;
    }
    if (event.code === 133 && event.param === "E") {
      vars.command = event.data;
    }
    if (event.code === 7) {
      vars.path = event.data;
    }
    // OSC 9 / 99: notification message
    if (event.code === 9 || event.code === 99) {
      vars.message = event.data;
    }
    // OSC 777: format is "notify;title;body"
    if (event.code === 777) {
      const parts = event.data.split(";");
      vars.message = parts.slice(1).join(";") || event.data;
    }

    // Create a safe evaluation context
    const fn = new Function(
      ...Object.keys(vars),
      `return (${when});`,
    );
    return !!fn(...Object.values(vars));
  } catch {
    return false;
  }
}

/**
 * Match hooks against an OSC event, returning all matched hooks.
 */
export function matchHook(hooks: OscHook[], event: OscEvent): OscHook[] {
  return hooks.filter((hook) => {
    // Match OSC code
    if (hook.osc !== event.code) return false;

    // Match param if specified
    if (hook.param !== undefined && hook.param !== event.param) return false;

    // Evaluate condition if specified
    if (hook.when) {
      return evaluateCondition(hook.when, event);
    }

    return true;
  });
}
