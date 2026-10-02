#!/usr/bin/env node

const SUBCOMMANDS = ["serve", "hook", "install", "uninstall", "doctor", "tui"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const USAGE = `ukagai - hooks + GUI that gather Claude Code's decisions in one place

Usage: ukagai <command> [options]

Commands:
  serve      Start the GUI and API server
  hook       Called from Claude Code hooks (JSON on stdin)
  install    Register the hooks and skill in Claude Code settings
  uninstall  Remove only what install registered
  doctor     Diagnose registration and connectivity
  tui        Answer decisions in the terminal (same screen as the GUI, vim-style keys)

Options:
  -h, --help  Show this help
`;

const SETTINGS_OPTIONS = `  --settings <file>  Target settings file (default: ~/.claude/settings.json)
                     The skill is left alone when this is given (use --skill to include it)
  --project          Target <cwd>/.claude/
  --skill            Handle the skill even with --settings
  --no-skill         Leave the skill alone
  -h, --help         Show this help
`;

const SERVER_OPTIONS = `  --server <url>     Server URL (passed to the hook too when not the default)
  --data-dir <dir>   Where the token etc. live (passed to the hook too when not the default)
`;

const HELP: Record<Subcommand, string> = {
  tui: `Usage: ukagai tui [options]

Show decisions in the terminal and answer with the keyboard only. The server must be running.

Options:
  --server <url>     Server URL (default: http://127.0.0.1:4818)
  --data-dir <dir>   Where the token lives (default: ~/.ukagai)
  --lang <en|ja>     Display language (default: the config.json setting)
  -h, --help         Show this help

Keys: j/k move  gg/G top/bottom  Space multi-select  Enter submit  i free text
      h/l, [ ] switch pending decision  b list  y/a/n approve / auto / reject a plan  q quit
      PgUp/PgDn, wheel scroll the background  Tab switch background / decision column
      Left/Right, horizontal wheel scroll a wide diagram (Home/End when the background column is focused)  f show the background full-width
      c copy the blocker command  Ctrl-C quit  Ctrl-U/D half-page the background
      . expand / collapse a long recommendation or plan scope
`,
  serve: `Usage: ukagai serve [options]

Start the GUI and API server.

Options:
  --port <n>              Listening port (default: 4818)
  --host <host>           127.0.0.1 only (anything else is rejected)
  --data-dir <dir>        Data directory (default: ~/.ukagai)
  --lease-grace-ms <ms>   Lease grace period (default: 10000)
  -h, --help              Show this help
`,
  hook: `Usage: ukagai hook [options]   (hook JSON on stdin)

Called from Claude Code hooks. Prints nothing and exits 0 even on failure.

Options:
  --budget <sec>        Time the hook may take (default: 590)
  --observe             Observe only
  --no-autostart        Do not auto-start the server on SessionStart
  --server <url>        Server URL (default: http://127.0.0.1:4818)
  --data-dir <dir>      Where the token lives (default: ~/.ukagai)
  --deny-template <A|B> Wording style of the deny reason (default: A)
  --poll-timeout-ms <ms>  Length of one long-poll (for tests)
  -h, --help            Show this help
`,
  install: `Usage: ukagai install [options]

Register the hooks in Claude Code settings and place the skill.

Options:
  --lang <en|ja>     Display language of the GUI / TUI, written to <data-dir>/config.json
                     (asked interactively on a TTY when omitted; an existing config is kept otherwise)
  --observe          Install observe-only hooks
  --no-autostart     Install hooks that do not auto-start the server on SessionStart
  --timeout <sec>    PreToolUse timeout (15 or more, default: 3600)
  --dry-run          Print the diff only; write nothing
${SERVER_OPTIONS}${SETTINGS_OPTIONS}`,
  uninstall: `Usage: ukagai uninstall [options]

Remove only the hooks and skill that install registered. Arguments other than those that locate the settings are ignored.
<data-dir>/config.json is kept.

Options:
  --dry-run          Print the diff only; write nothing
  --server <url>     Used to locate the settings (server URL)
  --data-dir <dir>   Used to locate the settings (data directory)
${SETTINGS_OPTIONS}`,
  doctor: `Usage: ukagai doctor [options]

Diagnose registration and connectivity. Arguments other than those that locate the settings are ignored.

Options:
  --server <url>     Server URL to diagnose (default: http://127.0.0.1:4818)
  --data-dir <dir>   Where the token etc. live (default: ~/.ukagai)
${SETTINGS_OPTIONS}`,
};

function isSubcommand(name: string): name is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(name);
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!isSubcommand(name)) {
    process.stderr.write(`ukagai: unknown command: ${name} (try --help)\n`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(HELP[name]);
    return 0;
  }
  if (name === "hook") {
    // Fail-open: if loading fails, stdout stays empty and the exit code is 0
    try {
      const mod = (await import("./hook/index.js")) as { run: (argv: string[]) => Promise<number> };
      return await mod.run(rest);
    } catch (err) {
      process.stderr.write(`ukagai hook: ${err instanceof Error ? err.message : String(err)}\n`);
      return 0;
    }
  }
  const mod = (await import(`./${name}/index.js`)) as {
    run: (argv: string[]) => Promise<number>;
  };
  return mod.run(rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`ukagai: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
