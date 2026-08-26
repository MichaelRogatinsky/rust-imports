import type { BunPlugin } from 'bun';
import type { CompileRustOptions, RustArtifact } from './types';
export type RustImportsRuntimeOptions = Omit<CompileRustOptions, 'allowedRoot'> & {
    /** The only directory from which Rust source imports may be loaded. */
    rootDir?: string;
};
export type RustImportsPluginOptions = RustImportsRuntimeOptions;
/** The caller's project root unless an explicit, narrower boundary is supplied. */
export declare const defaultRustRoot: string;
/**
 * Bun's runtime adapter for adjacent Rust modules.
 *
 * The plugin never mutates source imports. It resolves an imported `.rs` file,
 * asks the shared compiler for a content-addressed addon, and exposes that
 * addon's top-level properties through Bun's object loader.
 */
export declare function rustImportsPlugin(options?: RustImportsRuntimeOptions): BunPlugin;
/** True only for the relative or absolute filesystem imports owned by this plugin. */
export declare function isRustFileSpecifier(specifier: string): boolean;
/** Resolve and lexically constrain a Rust import without touching the filesystem. */
export declare function resolveRustImportPath(specifier: string, resolveDir: string, rootDir?: string): string;
/** Return an absolute path or throw when it escapes the configured source root. */
export declare function assertPathInsideRoot(sourcePath: string, rootDir: string): string;
/**
 * Resolve a source and verify its real path too, preventing symlink escapes from
 * the configured source root.
 */
export declare function resolveRustSource(specifier: string, resolveDir: string, rootDir?: string): Promise<string>;
/** Only expose names Bun can safely materialize as named ESM exports. */
export declare function isValidJavaScriptIdentifier(name: string): boolean;
/**
 * Shape CommonJS/N-API exports for Bun's object loader. The complete addon is
 * always available as the default export; safe enumerable string keys are also
 * exposed as named exports.
 */
export declare function shapeNativeExports(nativeExports: unknown): Record<string, unknown>;
/** Validate the compiler/runtime handoff before requiring native code. */
export declare function validateRustArtifact(artifact: RustArtifact, expectedSource: string, platform?: NodeJS.Platform, arch?: string): void;
