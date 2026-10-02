#!/usr/bin/env node

const SUBCOMMANDS = ["serve", "hook", "install", "uninstall", "doctor"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const USAGE = `ukagai - 判断を 1 か所に集める hooks + GUI

使い方: ukagai <command> [options]

コマンド:
  serve      GUI と API の server を起動する
  hook       Claude Code の hook から呼ばれる(stdin に JSON)
  install    Claude Code の settings に hook と skill を登録する
  uninstall  install が登録したものだけを外す
  doctor     登録と接続の状態を診断する

オプション:
  -h, --help  この使い方を表示する
`;

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
  if (name === "hook") {
    // フェイルオープン: 読み込みに失敗しても stdout は空、exit 0
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
