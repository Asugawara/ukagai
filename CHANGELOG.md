# Changelog

## [0.10.0](https://github.com/Asugawara/ukagai/compare/v0.9.0...v0.10.0) (2026-10-24)


### Features

* ask the agent side questions from an Ask panel in the GUI ([71c4d73](https://github.com/Asugawara/ukagai/commit/71c4d73abe3df7718540990876bdf831b14ba9ce))
* ask the agent side questions from the TUI ([a59f7c7](https://github.com/Asugawara/ukagai/commit/a59f7c762b401293f48104561500afedf9563db1))
* let the server answer side questions from a forked agent session ([44f2d7e](https://github.com/Asugawara/ukagai/commit/44f2d7edf9a6f7aa448380e056746e762a8d2049))


### Bug Fixes

* count cached input in the side question token total ([325c2df](https://github.com/Asugawara/ukagai/commit/325c2df6e9578b2ea183afdb3c58a635e4664c89))
* keep the option cards from spilling over the left column below 900px ([d05b62a](https://github.com/Asugawara/ukagai/commit/d05b62a558f5e7ee71df9407e3a9fae5b786bb55))
* show a blocker's steps at the top of the left column ([d6a02ee](https://github.com/Asugawara/ukagai/commit/d6a02eee29d774bc36197a27410612496be14553))
* tell the side-question fork what is waiting on the human's screen ([8598e99](https://github.com/Asugawara/ukagai/commit/8598e99f867588933d5d70387b8e8b594e6cc5d8))

## [0.9.0](https://github.com/Asugawara/ukagai/compare/v0.8.0...v0.9.0) (2026-10-23)


### Features

* accept inline comments with answers, instructions and rejections, and store marked image crops ([238af7e](https://github.com/Asugawara/ukagai/commit/238af7e2af03f83f1d7b3f3862c2fbff6353d2b4))
* comment on an element of an embedded HTML page or a region of an image ([659f247](https://github.com/Asugawara/ukagai/commit/659f247d25b456058d3facf903872dd4b5a533d2))
* comment on selected text in the GUI and send the comments with the answer ([77a6764](https://github.com/Asugawara/ukagai/commit/77a6764e2854ab8f59f66d1107f83ed7b50cddf5))


### Bug Fixes

* hold the 1000-character note limit in the comment box and check restored drafts like the server ([ac4f164](https://github.com/Asugawara/ukagai/commit/ac4f164043ad85e78345246b816fdec2fa42f5cf))
* keep picking on when a page frame loads again, and keep badges out of the section path ([0b37781](https://github.com/Asugawara/ukagai/commit/0b377815f4ba2b2169de096a0a0e7b719ee6fa8d))
* keep the comment block whole when instructions are joined, validate restored drafts, and refuse control characters in comment paths ([bc33cc7](https://github.com/Asugawara/ukagai/commit/bc33cc73665fc04f09fd05e7d43172f8cb7f736b))

## [0.8.0](https://github.com/Asugawara/ukagai/compare/v0.7.0...v0.8.0) (2026-10-21)


### Features

* pop up plan files only when the Plans setting is on (default off), in the GUI and the TUI ([6618c83](https://github.com/Asugawara/ukagai/commit/6618c838640fd4f20e84aaadcfaa9ee03531aeac))


### Bug Fixes

* bring up a ready plan at once when the TUI's Plans setting is turned on ([653189f](https://github.com/Asugawara/ukagai/commit/653189fbfa0defbb61f2c8b13288438c96e91de2))

## [0.7.0](https://github.com/Asugawara/ukagai/compare/v0.6.0...v0.7.0) (2026-10-21)


### Features

* serve code snippets at GET /api/source ([142872d](https://github.com/Asugawara/ukagai/commit/142872d181f8a3570cdaaa32281a6c211c4a0b65))
* show file references as short chips with a snippet toggle ([2ee2cec](https://github.com/Asugawara/ukagai/commit/2ee2cec618b49626bf0cff68628586c7ed98204c))


### Bug Fixes

* cap the project root and refuse more secrets in /api/source ([436daf3](https://github.com/Asugawara/ukagai/commit/436daf324460230a7bef5f6f15c39b35ec3ddda7))
* chip generic extensions again and keep Enter on the answer after a snippet click ([c095003](https://github.com/Asugawara/ukagai/commit/c0950038c52f77e2b065368ba193f7a712886668))
* close the FIFO hang and the remaining secret-name and root gaps in /api/source ([cf063b8](https://github.com/Asugawara/ukagai/commit/cf063b8e614d9214b7fc7750e6df6cc70e0e5ebd))
* draw the toggle chevron and mark the hit line with a yellow tint and an edge bar ([2203a3c](https://github.com/Asugawara/ukagai/commit/2203a3cd1be7d0d80b95fceb878adc68668d7364))
* make the snippet toggle a visible, larger button ([61ffd24](https://github.com/Asugawara/ukagai/commit/61ffd24837b2aacd4b5f47e964c0311f96bcbe4f))
* make the snippet toggle work in cloned content and share one reference grammar ([c7e1e6f](https://github.com/Asugawara/ukagai/commit/c7e1e6f119db158969e915408fff47c9e951cf32))

## [0.6.0](https://github.com/Asugawara/ukagai/compare/v0.5.0...v0.6.0) (2026-10-21)


### Features

* show an AskUserQuestion option's preview on its card ([060982f](https://github.com/Asugawara/ukagai/commit/060982ff4e5658bf3d920bb94e78027875523835))


### Bug Fixes

* keep explanation content that a section reader does not use ([4c40d0a](https://github.com/Asugawara/ukagai/commit/4c40d0a26a91e79524cf1ea6b7fc3916a5f2feb8))
* mark a cut TUI preview line and strip C1 / bidi controls ([5724367](https://github.com/Asugawara/ukagai/commit/5724367fb63258c5942d45e185f429ea51a8ba25))

## [0.5.0](https://github.com/Asugawara/ukagai/compare/v0.4.0...v0.5.0) (2026-10-20)


### Features

* **contract:** add message-delivery types, constants and the claude.message_delivery setting ([8f75197](https://github.com/Asugawara/ukagai/commit/8f75197a8847e84c8e78a1688edaa26bcdeb0470))
* **gui:** say when an approved plan did not switch to auto mode ([27d51b5](https://github.com/Asugawara/ukagai/commit/27d51b5dca5ab0030b3cad079fa32067b52c3cf9))
* **gui:** show a toast for an instruction delivered as a message ([02ffb07](https://github.com/Asugawara/ukagai/commit/02ffb0757514169b6f7e1a07885eff764606fe57))
* **gui:** show message-delivery status and add the Settings toggle ([00942d0](https://github.com/Asugawara/ukagai/commit/00942d0e7732816d325ae001a07445f21b836591))
* **hook:** let the re-called ExitPlanMode through by its grant ([e5857de](https://github.com/Asugawara/ukagai/commit/e5857ded60f668cf190ea77423a98136b0d3044b))
* **hook:** register questions for message delivery and hold tools back while an answer is on its way ([286f081](https://github.com/Asugawara/ukagai/commit/286f081ab3310edf21e98db5c312745685b5bdc8))
* **install:** place the ukagai-mod skills-directory plugin ([56f63bf](https://github.com/Asugawara/ukagai/commit/56f63bf1cdd4069bd5b8c4dca8ec4bafe529df55))
* **mod:** deliver ukagai answers with prompt.submit ([75a5549](https://github.com/Asugawara/ukagai/commit/75a5549b7c87b20a6aff9adce767a16773610b42))
* **plugin:** ship the mod in the release tree and name it in hooks/claude.json ([8791abd](https://github.com/Asugawara/ukagai/commit/8791abd4ad132e4207ca06c2b16d3690beedd9d9))
* **serve:** deliver answers through a per-session inbox for the ukagai mod ([8951eb7](https://github.com/Asugawara/ukagai/commit/8951eb75173c0f57ac77c636c5557d386605147f))
* **serve:** deliver checkpoint replies and plan instructions through the mod's inbox ([20cb160](https://github.com/Asugawara/ukagai/commit/20cb160d2aaba4ce02997a18a10449162f998bac))
* **serve:** derive one-time plan grants from approvals sent as messages ([e58a64c](https://github.com/Asugawara/ukagai/commit/e58a64c15216e30e5c6a8af9898ce640d27afc6e))


### Bug Fixes

* **explain:** stop denying natural undo wording, standard names, diagrams outside a Diagram heading and callouts in the Recommendation ([6244bd1](https://github.com/Asugawara/ukagai/commit/6244bd19999208041b13dbf45392998cb83c8c1f))
* **gui:** ==mark== skips diagram text too, so a label such as a==b inside a diagram is not wrapped in an HTML &lt;mark&gt; that SVG does not draw ([5506d9b](https://github.com/Asugawara/ukagai/commit/5506d9bdcad48db12b53fd092cc978bb769186c5))
* **gui:** a diagram label that equals an option label, a Terms entry, a risk word or a number stays drawn: the text decorations no longer wrap SVG text in HTML spans, which SVG does not draw (pele draws the diagram before the decorations run) ([81e2e10](https://github.com/Asugawara/ukagai/commit/81e2e10903929d2eb0cd085cb097e6139b541569))
* **gui:** long lines in code blocks and diffs wrap instead of scrolling sideways (indentation kept, the add / del background covers the wrapped line) ([5f45733](https://github.com/Asugawara/ukagai/commit/5f45733f6b9f08ac0019c40ea29e41103c669cfb))
* **gui:** say why an answer that a newer plan or the re-call time limit kept from the agent was not delivered ([6d7d7a8](https://github.com/Asugawara/ukagai/commit/6d7d7a8e76bfc826b431fd3ff77248f5aaf4d048))
* **gui:** show that auto mode was not switched on for a plan that went back to the waiting hook ([019c251](https://github.com/Asugawara/ukagai/commit/019c251f6639e59da6e8314bb9db5396dcfe4cbc))
* **gui:** the HTML frame bar never breaks inside a word: in a narrow frame (container query) Open in new tab and Full screen show only their Lucide icon (text kept as title / aria-label) so the alt and the file name stay readable; if even that does not fit, the names end in an ellipsis and whole items wrap ([83925df](https://github.com/Asugawara/ukagai/commit/83925dfa95808107fcaacac1c14c82d532e7d3e0))
* **gui:** toast "auto mode was not switched on" once when a closed plan gets the flag ([3c605b4](https://github.com/Asugawara/ukagai/commit/3c605b49a896568ca58d3ea082429d92b1f8bae7))
* hand an "approve and auto" plan grant to one PermissionRequest, once, for 60 seconds, and keep the Codex bridge's plan ack as before ([211b33f](https://github.com/Asugawara/ukagai/commit/211b33f0e00f201a17765f6548b8e93a293a61b7))
* **hook:** answer ExitPlanMode's prompt only in plan mode, and leave a subagent's plan outside it as before ([7a6ccd9](https://github.com/Asugawara/ukagai/commit/7a6ccd96fc817244b26c99e72620d1382a24af4c))
* **hook:** do not use up the pending mode switch when a held-back tool is denied ([ccbf945](https://github.com/Asugawara/ukagai/commit/ccbf94574e994b0832185d0febb28832d42b2f15))
* **hook:** send the async and waiting denies as a red line plus hook context ([dc8b0ad](https://github.com/Asugawara/ukagai/commit/dc8b0ad92a370cdd2ec53497a75fb12a74bf86f2))
* **hooks:** give the synchronous hooks a 10 s timeout ([4102473](https://github.com/Asugawara/ukagai/commit/410247352cc2cc2bb3c98b4db80d8e0840e36cfd))
* **hook:** show one red line per deny and pass the instructions as hook context ([ce16453](https://github.com/Asugawara/ukagai/commit/ce1645314e77855d7fe16014d6e4e3bf52e77e99))
* **launcher:** skip the node version probe for a node that already passed it ([66c031e](https://github.com/Asugawara/ukagai/commit/66c031e6f021c90ff2f469c1af5296fcf17d8ff7))
* let a message-delivery plan grant pass only a re-call within 10 minutes of delivery, and write a handed grant off when the human types ([4c6945c](https://github.com/Asugawara/ukagai/commit/4c6945caa6527e30a621e4e860ca55aea69a78ef))
* **mod:** give a claimed item back when the session ends mid-poll, and reset on a disabled restart ([a4bebb5](https://github.com/Asugawara/ukagai/commit/a4bebb5ac2544b482a989016ff916b905ea54583))
* **mod:** keep delivering after /clear by starting a new session when session.end says clear ([4a58371](https://github.com/Asugawara/ukagai/commit/4a5837106dc19e9b456df612fa275c9cbe4a37d9))
* **serve:** count a failed prompt submit and close a dying mod's session ([1ba100d](https://github.com/Asugawara/ukagai/commit/1ba100d460a92f9f9dbb9ae72ca9dbf45ca0ab88))
* **serve:** drop the inner [ukagai] tag of each prefix in an inbox instruction ([4381afd](https://github.com/Asugawara/ukagai/commit/4381afd24987f24a5bdf0fadcf44bf8601612af6))
* **serve:** keep every joined checkpoint and each text's prefix in an inbox instruction, and let the bypass expire ([998e837](https://github.com/Asugawara/ukagai/commit/998e837d4e522ac2a405b91246ee4d134b2528cb))
* **serve:** keep instruction time limits on the store's clock, and hand out a waiting instruction once an approval without its grant is closed ([937ff5e](https://github.com/Asugawara/ukagai/commit/937ff5e66c08156420c2457673aa3223c5b2f7fa))
* **serve:** let only the main agent's plan supersede, and close an approval as lost when its grant goes while the mod submits it ([b898ba5](https://github.com/Asugawara/ukagai/commit/b898ba5861bfce680723fd6e5c999acd28ae9bad))
* **serve:** return inbox instructions to the queue when the mod is gone, and never drop one that is joined or claimed ([752e9ca](https://github.com/Asugawara/ukagai/commit/752e9ca2969c80cac505b6645771fa945f125c08))
* **serve:** write off plan grants when a newer plan or a non-plan-mode event comes, and never deliver an approval without one ([c263f6b](https://github.com/Asugawara/ukagai/commit/c263f6b0025e239dea80880a504fb26a9738a30c))
* **tui:** add the drop reason to the toast of an answer waiting for delivery ([22f986c](https://github.com/Asugawara/ukagai/commit/22f986c98b6b8caa895ba4fafd17aa55d2a1e00c))
* write off a delivered plan grant nobody handed yet when the human types after the delivery ([0808f69](https://github.com/Asugawara/ukagai/commit/0808f6971969f918213a7d6a6feca56df8c436d9))

## [0.4.0](https://github.com/Asugawara/ukagai/compare/v0.3.0...v0.4.0) (2026-10-19)


### Features

* **gui:** render Mermaid diagrams with pele instead of the vendored mermaid.js ([694ac3d](https://github.com/Asugawara/ukagai/commit/694ac3dbb0d8044690b89f5b542fff198452ec41))

## [0.3.0](https://github.com/Asugawara/ukagai/compare/v0.2.1...v0.3.0) (2026-10-16)


### Features

* **gui:** an embedded HTML page opens in real full screen with zoom, fit and modifier-wheel scrolling ([03650b6](https://github.com/Asugawara/ukagai/commit/03650b68225d9882191c8c4596775698031a8213))


### Bug Fixes

* **gui:** no script but ukagai's helper runs in the HTML frame, wherever the frame navigates ([7adc6b9](https://github.com/Asugawara/ukagai/commit/7adc6b9f114e3938894034f65b93fa970e080db3))
* **gui:** wheel zoom only in full screen, a missing HTML page shows its error, and the no-csp fallback is tested ([ce2edd1](https://github.com/Asugawara/ukagai/commit/ce2edd19853be5cea644b0b3aa45353b107863e6))
* **hook:** approving a plan with auto mode now switches to auto even when Claude Code restores acceptEdits; a hook-allowed ExitPlanMode brings back the pre-plan mode (acceptEdits after shift+tab from auto), where Edit / Write never prompt, so the PermissionRequest switch never ran. The checkpoint hook now forces one prompt on the first main-agent edit (server budget: once per approval) and drops the record when the session is already in auto ([1eb30c9](https://github.com/Asugawara/ukagai/commit/1eb30c9ee98279ca33339b57715430ce15e633d5))
* **serve:** a plan written right after start() is reported; start() now waits for the plan watcher's seed scan, which could take a file written meanwhile for one present at start and never announce it (flaky plan-ready test on macOS CI) ([ec3d8f4](https://github.com/Asugawara/ukagai/commit/ec3d8f43e506111ab6306680facb7e5c11f157f9))
* **serve:** an embedded HTML page can no longer leave /api/files now that scripts are allowed; the inline height settles ([f7fe2b9](https://github.com/Asugawara/ukagai/commit/f7fe2b93bd970feb5660698f39347a2f3755400f))

## [0.2.1](https://github.com/Asugawara/ukagai/compare/v0.2.0...v0.2.1) (2026-10-10)


### Bug Fixes

* **gui:** Enter sends the option under the cursor after a click on the copy button; a mouse-only helper button (tabindex=-1: copy, Show all, full width, version tabs) no longer keeps Enter / Space, which re-ran the button (a second copy) instead of answering ([1523d50](https://github.com/Asugawara/ukagai/commit/1523d501bc35197f9f1b348ad863dfd99472a18d))

## [0.2.0](https://github.com/Asugawara/ukagai/compare/v0.1.1...v0.2.0) (2026-10-09)


### Features

* **doctor:** report a custom skill version and whether the default changed since editing started; the settings guide and READMEs describe the sidebar and the Skill pane ([0478bef](https://github.com/Asugawara/ukagai/commit/0478bef60376b32d78a8070ecef4c44fc858f279))
* **hook:** SessionStart / SubagentStart copy the skill's reference/ into &lt;scratchpad&gt;/ukagai/skill/reference/ and the context names it ([7e6d247](https://github.com/Asugawara/ukagai/commit/7e6d247592e435f83091b5ad7affb5fdd06d9d6c))
* **hook:** when the user saved their own skill version, the SessionStart, plan-mode and deny texts point at it (Claude: a copy in &lt;scratchpad&gt;/ukagai/skill/ so no read prompt; Codex: the data-dir file), fail-open ([fb7acda](https://github.com/Asugawara/ukagai/commit/fb7acda2bafc762950aa46e51461d89d63998611))
* **install.sh:** only --version and --force; register on first install, refresh on upgrade ([2e9698e](https://github.com/Asugawara/ukagai/commit/2e9698ea3ab8514a429ed2b569b67fac37ff91a5))
* **install:** place and remove the whole skill directory (SKILL.md + reference/) instead of SKILL.md alone ([bdf2015](https://github.com/Asugawara/ukagai/commit/bdf2015a2e06da3759b7cba79d1153a0312408c0))
* **install:** register every agent found; re-registering keeps the registered options; the language comes from the locale and the Settings page ([e6bab78](https://github.com/Asugawara/ukagai/commit/e6bab78dd69d8cd125a3af291d5a5c28391f98d3))
* **serve:** a relative image / HTML path in a plan-block explanation or a plan approval is also resolved against the decision session's &lt;scratchpad&gt;/ukagai, after ~/.claude/plans; every candidate passes the same root / scratchpad checks, the standalone explanation scope and the plan= drawer are unchanged; spec and public/README updated ([1ae233f](https://github.com/Asugawara/ukagai/commit/1ae233fdd6fd81c5e0f045d884a322b259e20c4b))
* **serve:** the user's own version of the ukagai-explain skill in &lt;data-dir&gt;/skill/ (SKILL.md, base.md, meta.json) with GET / PUT / DELETE /api/skill and the skill.updated event ([4e536f3](https://github.com/Asugawara/ukagai/commit/4e536f3dac320fc165e4cfeca3c90bc55d4db449))
* **settings:** GitHub-style sidebar (General, Notifications, Plans, Progress checkpoints, Skill) with hash routing; Lucide icons vendored in public/icons.js; the back link drops the arrow glyph ([ebe7fce](https://github.com/Asugawara/ukagai/commit/ebe7fce775b201ca2fd8cb4b7bc2efa78a5f4f5e))
* **settings:** the Skill pane edits the whole ukagai-explain text (Edit / Preview / Diff from default tabs, Save with Cmd/Ctrl+S, Discard, Reset to default on a second click, unsaved indicator, live update from other tabs); the sanitizer moves to public/sanitize.js for both pages ([9ed0912](https://github.com/Asugawara/ukagai/commit/9ed09121035ab9fc3f06806d1b5bc1f3d175fd67))


### Bug Fixes

* **hook:** plan mode may write the scratchpad — mockups and screenshots go to &lt;scratchpad&gt;/ukagai and are referenced by absolute path from a plan; a visual choice is asked with AskUserQuestion before ExitPlanMode, never scheduled after approval; skill and spec aligned, the old 'only file you may write' / 'write no image' wording is gone and a test keeps it out ([c829170](https://github.com/Asugawara/ukagai/commit/c8291709236de0af526e77eba7dcba0f059eb327))
* **install:** trust keys under a symlinked parent of a missing Codex home; config.json in the registered data dir; nothing written when every agent failed ([75a3f43](https://github.com/Asugawara/ukagai/commit/75a3f43e3599ef32eeeee578501a49602c495f86))
* **install:** uninstall and the plugin cleanup report only what they removed, and remove an empty leftover skill directory; tests for the symlinked-checkout guard, the Codex no-copy path and the no-scratchpad path ([2a094b9](https://github.com/Asugawara/ukagai/commit/2a094b93fbbf8152083941268e944b509f7ee8ce))
* **settings:** deny reasons name only the custom skill path so real scratchpad paths no longer truncate Missing and the retry sentence; the Skill pane shows the real data-dir path from GET /api/skill; no false 'newer version' notice on reconnect; typing during a save is kept; hook-level deny tests and polling SSE tests ([38aa708](https://github.com/Asugawara/ukagai/commit/38aa7086719ac8aa1e34312a9715f735d50dc653))
* **settings:** no layout shift: the page shows once the sidebar and pane head are built, the scrollbar gutter is reserved, every pane shares one title and lede block, the Skill views have one fixed height, bold labels and the reset text keep their width, and late slots (path, saved time, newer-version notice) are reserved from the first paint; a GUI test measures the layout-shift score on load and pane switches ([5b72c0a](https://github.com/Asugawara/ukagai/commit/5b72c0a71df5e27c4baf5eddc8562afe4c5e6f22))
* **skill:** the passing example's diagram is a real sequence (the old 3-node flowchart passed only because dotted edges are not parsed); the table rule names the required columns; checks.md in the hook's report order with the recommend_name short forms and the phase-word conditions; writing.md gets an English headline pair; the skill test runs the validator on the examples, pins the LIMITS numbers and the one-link-per-reference rule ([8bb2a0d](https://github.com/Asugawara/ukagai/commit/8bb2a0da9d4a7110f7c4d613bea95834e5db5772))

## [0.1.1](https://github.com/Asugawara/ukagai/compare/v0.1.0...v0.1.1) (2026-10-08)


### Bug Fixes

* **install:** uninstall stops the server once no ukagai hooks remain (left running after a Claude-only or Codex-only uninstall; skipped for --settings / --project; dry-run says what it would do), doctor reports a server that never ran as 'not started yet' instead of two problems, README and guide say --codex --claude for both agents, what doctor shows after install, and that ~/.ukagai is kept on uninstall ([58fa6b1](https://github.com/Asugawara/ukagai/commit/58fa6b181226baba04b83fa9f8408afc3ea8e0f7))
* **install:** uninstall stops the server, doctor explains 'not started yet', README says --codex --claude ([9250666](https://github.com/Asugawara/ukagai/commit/925066670a6868793f2df6db515f3bd67676514a))
* **uninstall:** when the hook check throws and no server answers, say 'not running' instead of 'still running'; tests for the --project skip and the catch path; CLAUDE.md: PR titles carry no type prefix because release-please reads them for the merge commit ([367a92d](https://github.com/Asugawara/ukagai/commit/367a92d4e48b97b7a9376ecd5dc6edb30b39661c))

## 0.1.0 (2026-10-08)


### Features

* **dist:** bin/ukagai launcher (follows symlinks, finds Node &gt;= 22 via UKAGAI_NODE, node-path, PATH, version managers, a login shell), launcher-form hook registration (hookInvocation), ukagai --version, /healthz reports version and cli, POST /api/shutdown, autostart restarts a stale server, serve records node-path, doctor rows; tests and docs ([83249a2](https://github.com/Asugawara/ukagai/commit/83249a2635bcbf3ef63bc62adb487c218a3900c2))
* **dist:** Claude Code and Codex plugin files generated into the release stage (.claude-plugin/plugin.json + hooks/claude.json from buildHookEntries, root plugin.json + .codex-plugin/plugin.json + hooks/codex.json from CODEX_SPECS, never hooks/hooks.json), the two marketplaces (.claude-plugin/marketplace.json, .agents/plugins/marketplace.json → branch plugin), the hook names the skill ukagai:ukagai-explain inside a plugin, install / doctor detect an enabled ukagai plugin and drop the settings-side hooks and skill copy (--force keeps them), the release workflow pushes the stage tree to branch plugin; tests ([155d7df](https://github.com/Asugawara/ukagai/commit/155d7dfa243fb362cc853a594314c6c289c8a751))
* **dist:** install.sh (versioned install under ~/.local/share/ukagai with SHA256 verification, symlink swap, prune, --lang / --codex / --claude pass-through), scripts/build-release.sh staging the release tarball with production node_modules, MIT LICENSE, third-party licence list, package.json metadata ([dd5abff](https://github.com/Asugawara/ukagai/commit/dd5abffc0fe251e588765f1d5f42b9489f46da74))


### Bug Fixes

* **dist:** doctor --settings ignores the user-level plugin, the plugin branch is built from the release tag, Codex plugin detection accepts literal keys and the dotted / inline TOML forms, Claude plugin detection follows the settings precedence (local, project, user), install --dry-run names an enabled plugin, the stage script fails without write-plugin-files.mjs, tests strip the plugin env ([cfbaafc](https://github.com/Asugawara/ukagai/commit/cfbaafc83feb72eed1a96092bd2e52766dc420dc))
* **dist:** install.sh forwards --data-dir, checks the bin link before downloading, treats node-path failures as warnings, records the resolved node path, uses https-only curl / wget flags and a connect timeout, warns under root, spares young .tmp dirs, hints at a development server, UKAGAI_PORT for the healthz probe, --help on stdout; the launcher bounds the login-shell fallback without timeout(1), knows fnm's macOS directory and tolerates spaced SessionStart JSON; /healthz reports cli only when the file exists; GNU tar mtimes from SOURCE_DATE_EPOCH or the last commit; release workflow has issues: write; package workflow waits for the mirror and checks the fail-open stdout; an install.sh test suite against a local mirror; tests that can fail ([70ba9f2](https://github.com/Asugawara/ukagai/commit/70ba9f203e9c136a8758ac6616b659bc6cb763f8))
* **gui:** the header's pending button shows the count only (☰ N) with an accessible name, no "Pending" / "保留" word; tests and GUI notes ([61a6e0f](https://github.com/Asugawara/ukagai/commit/61a6e0f915feda652d806ce62bbbabd8ffa3dd26))
* **hook:** the hook's request and healthz timeouts use a referenced timer instead of AbortSignal.timeout, whose unref'd timer let a hanging request end the event loop before the abort fired (the autostart tests were cancelled on Node 22 in CI) ([a778371](https://github.com/Asugawara/ukagai/commit/a778371988a4a724b09aaca6c77ad4086ea305ec))
