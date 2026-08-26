# `rust-imports`

Import a Rust file beside TypeScript and use its top-level napi-rs exports as a
normal Bun module:

```ts
import { add } from './math.rs';

console.log(add(5, 7));
```

Until the package is published to a registry, install it directly from the Git
repository as a runtime dependency:

```sh
bun add https://github.com/MichaelRogatinsky/rust-imports.git
```

Git installs are pinned to a commit in `bun.lock`; run `bun update rust-imports`
when you intentionally want to adopt a newer repository revision.

## Requirements

- Bun 1.4 or newer.
- Rust and Cargo 1.83 or newer for a missing or stale native artifact.
- A working C linker for the host platform.
- Registry access on the first build so Cargo can download the pinned napi-rs v2
  dependency set.

The package currently builds native addons for the host operating system and
architecture. Rust source is trusted project code: compiling and inspecting an
addon can execute its native module initialization.

## Write an adjacent Rust module

`math.rs` needs no local Cargo manifest. The generated isolated crate supplies
`napi`, `napi-derive`, and `napi-build`:

```rust
use napi_derive::napi;

#[napi]
pub fn add(left: i32, right: i32) -> i32 {
    left + right
}
```

Import it from a neighboring TS or JS file:

```ts
import { add } from './math.rs';
```

## Register the Bun runtime adapter

The zero-configuration preload uses the current working directory as its source
boundary. Add it to `bunfig.toml` for development and tests:

```toml
preload = ["rust-imports/register"]

[test]
preload = ["rust-imports/register"]
```

The register entrypoint uses a process-global guard, so loading it more than once
does not install duplicate plugins.

For a narrower boundary or custom compiler options, create your own preload:

```ts
import { rustImportsPlugin } from 'rust-imports/runtime';

Bun.plugin(
  rustImportsPlugin({
    rootDir: import.meta.dir,
    release: false
  })
);
```

At runtime, the plugin validates the import path, reuses a verified artifact when
possible, and invokes Cargo when the artifact is missing or stale. If Cargo is not
available, it fails with a build instruction instead of silently loading an
unverified binary.

## TypeScript declarations

Enable arbitrary-extension declarations in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "allowArbitraryExtensions": true,
    "types": ["bun"]
  }
}
```

Compiling `math.rs` writes `math.d.rs.ts` beside it. TypeScript recognizes that
name as the declaration for `math.rs`. Generated declarations expose inspected
exports as `any`; a handwritten declaration without the generated marker is
preserved and can provide richer types.

Run the preparation step before a clean typecheck so the declaration exists.
Choose one project policy deliberately:

- commit generated or handwritten `*.d.rs.ts` files; or
- regenerate them before every typecheck and keep them ignored.

Install `@types/bun` in TypeScript consumers if it is not already part of the Bun
project setup.

## Prepare a dependency graph

The programmatic build adapter discovers reachable local TS/JS modules, compiles
their adjacent Rust imports, and does not mutate source by default:

```ts
import { prepareRustImports } from 'rust-imports/build';

const result = await prepareRustImports({
  entrypoints: ['server.ts'],
  rootDir: process.cwd(),
  release: true,
  rewrite: 'none'
});

console.log(result.artifacts);
```

The installed CLI exposes the same workflow:

```json
{
  "scripts": {
    "build:native": "rust-imports --entrypoint ./server.ts",
    "build:vercel": "rust-imports --entrypoint ./server.ts --release --rewrite=in-place"
  }
}
```

Useful CLI options:

```text
--entrypoint <file>       Repeatable entrypoint relative to --root
--root <directory>        Source boundary; defaults to the current directory
--cache-dir <directory>   Defaults to <root>/.rust-imports
--release | --debug       Select the Cargo profile
--force                   Ignore a valid cached artifact
--rewrite none|in-place   Compile only, or rewrite imports to generated proxies
```

`in-place` rewriting is for disposable build checkouts. Outside Vercel, the CLI
requires the explicit `--allow-source-mutation` acknowledgement. Rewriting is
transactional across the discovered import graph, changes only correlated import
specifiers, and never deletes `.rs` sources.

## Cache and generated artifacts

The default layout is:

```text
.rust-imports/
  artifacts/   content-addressed .mjs proxies and host .node addons
  crates/      generated isolated Cargo crates
  state/       verified dependency fingerprints
  target/      shared Cargo build output
```

Add `.rust-imports/` to `.gitignore`. It is a rebuildable cache and can be removed
when no build or Bun process is using it. Do not treat `*.d.rs.ts` the same way
unless the project regenerates declarations before typechecking. The package
never deletes Rust source files.

## Vercel

Run the release build and in-place rewrite from Vercel's custom build command so
function tracing sees ordinary `.mjs` proxies and adjacent `.node` files:

```json
{
  "bunVersion": "1.4.x",
  "buildCommand": "bun run build:vercel",
  "functions": {
    "server.ts": {
      "includeFiles": ".rust-imports/artifacts/**/*",
      "excludeFiles": "{.rust-imports/crates/**,.rust-imports/target/**,**/*.rs}"
    }
  }
}
```

The `build:vercel` script shown above rewrites only Vercel's disposable checkout.
The emitted proxy and native addon stay adjacent inside `artifacts/`, so Vercel's
file tracing preserves their relative load path. Ensure Rust 1.83+, Cargo, and a
linker are on the build image's `PATH`; native compilation is not a runtime
fallback on a packaged function.

For Vercel Services, place the same `buildCommand` and `functions` fields on the
service whose root contains the entrypoint.

## Public entrypoints

- `rust-imports` — curated runtime, build, compiler, and public types.
- `rust-imports/register` — guarded zero-config Bun preload.
- `rust-imports/runtime` — runtime plugin and runtime options.
- `rust-imports/build` — dependency-graph preparation.
- `rust-imports/compiler` — low-level single-module compilation.
- `rust-imports/types` — shared public TypeScript types.

## Version 0.1 limitations

- Builds only for the host platform and architecture; there is no cross compile.
- Generated declarations use `any`; rich napi-rs type generation is not included.
- Generated Cargo manifests do not accept custom dependency configuration.
- Build graph discovery follows local relative/absolute imports, not bare aliases.
- A plugin-unaware bundler must consume the explicit rewritten graph.

## Development

Install the locked development toolchain and run the complete local checks:

```sh
bun install --frozen-lockfile
bun test
bun run build
bun run smoke:pack
```

The generated `dist/` directory is committed because direct Git dependencies do
not reliably run package lifecycle builds. Regenerate it with `bun run build`
whenever the TypeScript source changes; CI rejects stale generated output.

The compiler safety tests build a tiny raw Node-API fixture with `rustc`; they do
not search a surrounding workspace for an installed native dependency or contact
the Cargo registry. CI runs these checks with Bun 1.4.0 and Rust 1.83.0.
