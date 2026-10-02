#!/usr/bin/env node

const SUBCOMMANDS = ["serve", "hook", "install", "uninstall", "doctor", "tui"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const USAGE = `ukagai - 判断を 1 か所に集める hooks + GUI

使い方: ukagai <command> [options]

コマンド:
  serve      GUI と API の server を起動する
  hook       Claude Code の hook から呼ばれる(stdin に JSON)
  install    Claude Code の settings に hook と skill を登録する
  uninstall  install が登録したものだけを外す
  doctor     登録と接続の状態を診断する
  tui        ターミナルで判断に答える(GUI と同じ画面、vim 風キー)

オプション:
  -h, --help  この使い方を表示する
`;

const SETTINGS_OPTIONS = `  --settings <file>  対象の settings ファイル(既定: ~/.claude/settings.json)
                     指定すると skill は扱わない(扱うなら --skill)
  --project          <cwd>/.claude/ を対象にする
  --skill            --settings 指定時にも skill を扱う
  --no-skill         skill を扱わない
  -h, --help         この使い方を表示する
`;

const SERVER_OPTIONS = `  --server <url>     server の URL(既定以外なら hook にも渡す)
  --data-dir <dir>   token などの置き場(既定以外なら hook にも渡す)
`;

const HELP: Record<Subcommand, string> = {
  tui: `使い方: ukagai tui [options]

ターミナルで判断を表示し、キーボードだけで答える。server が起動している必要がある。

オプション:
  --server <url>     server の URL(既定: http://127.0.0.1:4818)
  --data-dir <dir>   token の置き場(既定: ~/.ukagai)
  -h, --help         この使い方を表示する

キー: j/k 移動  gg/G 先頭/末尾  Space 複数選択  Enter 送信  i 自由記述
      h/l・[ ] 保留の切替  b 一覧  y/a/n 計画の承認/auto/却下  q 終了
      PgUp/PgDn・ホイール 背景のスクロール  Tab 背景/判断の列の切替
      ←→・横ホイール・Home/End 幅超過の図の横スクロール  f 背景を全幅で表示
      . 長い推奨・計画の影響範囲の全文/折りたたみ
`,
  serve: `使い方: ukagai serve [options]

GUI と API の server を起動する。

オプション:
  --port <n>              待ち受けポート(既定: 4818)
  --host <host>           127.0.0.1 のみ(他は受け付けない)
  --data-dir <dir>        データの置き場(既定: ~/.ukagai)
  --lease-grace-ms <ms>   lease の猶予
  -h, --help              この使い方を表示する
`,
  hook: `使い方: ukagai hook [options]   (stdin に hook の JSON)

Claude Code の hook から呼ばれる。失敗しても何も出力せず exit 0。

オプション:
  --budget <sec>        hook の持ち時間
  --observe             観測のみ
  --server <url>        server の URL
  --data-dir <dir>      token の置き場
  -h, --help            この使い方を表示する
`,
  install: `使い方: ukagai install [options]

Claude Code の settings に hook を登録し、skill を配置する。

オプション:
  --observe          観測のみの hook にする
  --timeout <sec>    PreToolUse の timeout(15 以上、既定: 3600)
  --dry-run          差分だけ表示し、何も書かない
${SERVER_OPTIONS}${SETTINGS_OPTIONS}`,
  uninstall: `使い方: ukagai uninstall [options]

install が登録した hook と skill だけを外す。

オプション:
  --dry-run          差分だけ表示し、何も書かない
  --server <url>     settings の特定に使う(server の URL)
  --data-dir <dir>   settings の特定に使う(データの置き場)
${SETTINGS_OPTIONS}`,
  doctor: `使い方: ukagai doctor [options]

登録と接続の状態を診断する。

オプション:
  --server <url>     診断する server の URL(既定: http://127.0.0.1:4818)
  --data-dir <dir>   token などの置き場(既定: ~/.ukagai)
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
