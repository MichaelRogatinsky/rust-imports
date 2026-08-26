import type { CompileRustOptions, RustArtifact } from './types';
export type { CompileRustOptions, RustArtifact } from './types';
/**
 * Compile one Rust source module into a host napi-rs addon and generate the
 * JavaScript/TypeScript files needed to consume it as a module.
 */
export declare function compileRustModule(sourcePath: string, options: CompileRustOptions): Promise<RustArtifact>;
/** Resolve and validate a Rust source without permitting symlink escapes. */
export declare function resolveRustSourcePath(sourcePath: string, allowedRoot: string): Promise<string>;
/** Generate the isolated Cargo manifest used for a source module. */
export declare function generateCargoToml(packageName: string): string;
/** Generate a crate root that includes the imported file at its real location. */
export declare function generateRustLib(sourcePath: string): string;
/** Generate the stable ESM surface around a native CommonJS addon. */
export declare function generateProxyModule(nodeFileName: string, exportNames: readonly string[]): string;
/** Generate the declaration TypeScript resolves for an arbitrary `.rs` extension. */
export declare function generateDeclarationModule(exportNames: readonly string[]): string;
/** Name of Cargo's host dynamic-library output for a crate. */
export declare function cargoDynamicLibraryName(packageName: string, platform?: NodeJS.Platform): string;
/** Deterministically hash path/content pairs plus the native build identity. */
export declare function fingerprintRustInputs(inputs: ReadonlyArray<{
    path: string;
    contents: string | Uint8Array;
}>, configKey: string): string;
