# Third-party licenses

## Vendored in this directory

| File | Package | Version | License |
|---|---|---|---|
| `marked.umd.js` | [marked](https://github.com/markedjs/marked) | 18.0.14 | MIT |
| `mermaid.min.js` | [mermaid](https://github.com/mermaid-js/mermaid) | 12.0.0 | MIT |

Versions are taken from `package-lock.json`; refresh them with `npm run vendor`.

## Production dependencies (`node_modules/` in the release tarball)

Generated from `package-lock.json` (non-dev packages); each license matches the package's own `package.json`.

| Package | Version | License |
|---|---|---|
| @hono/node-server | 2.1.3 | MIT |
| beautiful-mermaid | 1.1.3 | MIT |
| elkjs | 0.11.1 | EPL-2.0 |
| entities | 7.0.1 | BSD-2-Clause |
| hono | 4.13.12 | MIT |
| ws | 8.22.0 | MIT |
| zod | 4.6.5 | MIT |

`elkjs` is licensed under the Eclipse Public License 2.0 and `entities` under the BSD 2-Clause license; all others are MIT.

## Icons

The settings page icons are [Lucide](https://lucide.dev) 0.554.0 (ISC; portions derived from Feather, MIT). Only the path data of `settings`, `bell`, `file-text`, `clock`, `book-open`, `plug`, `chevron-left`, `square-pen`, `eye`, `git-compare`, `rotate-ccw`, `undo-2` and `save` is copied, into `public/icons.js`.

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2023 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2025.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The MIT License (MIT) (for portions derived from Feather)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
