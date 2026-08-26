import type { CompileRustOptions, RustArtifact } from './types';
export type RustImportRewriteMode = 'none' | 'in-place';
export type RustModuleCompiler = (sourcePath: string, options: CompileRustOptions) => Promise<RustArtifact>;
export type PrepareRustImportsOptions = {
    /** Entry modules, absolute or relative to `rootDir`. */
    entrypoints: string[];
    /** Boundary for source discovery and all source mutations. */
    rootDir: string;
    cacheDir?: string;
    release?: boolean;
    force?: boolean;
    /** Cargo executable forwarded to the shared compiler. */
    cargo?: string;
    /** Additional Cargo environment variables forwarded to the shared compiler. */
    env?: CompileRustOptions['env'];
    /**
     * `none` only compiles. `in-place` also atomically updates the source imports.
     * Source mutation is deliberately opt-in.
     */
    rewrite?: RustImportRewriteMode;
    /** Compiler override for embedding and tests. */
    compile?: RustModuleCompiler;
};
export type PrepareRustImportsResult = {
    /** Canonical absolute entrypoint paths. */
    entrypoints: string[];
    /** Canonical absolute TS/JS files reached from the entrypoints. */
    files: string[];
    /** One artifact per reached Rust source. */
    artifacts: RustArtifact[];
    /** Files changed when `rewrite` is `in-place`. */
    rewrittenFiles: string[];
};
/**
 * Compile every Rust module reachable from local TS/JS imports.
 *
 * This adapter does not bundle. In its default mode it discovers and compiles
 * only. `rewrite: 'in-place'` changes actual import-specifier tokens to point
 * at generated JavaScript proxies, leaving the Rust sources intact.
 */
export declare function prepareRustImports(options: PrepareRustImportsOptions): Promise<PrepareRustImportsResult>;
