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
