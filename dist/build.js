import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compileRustModule } from './compiler';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const EXTENSION_CANDIDATES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/**
 * Compile every Rust module reachable from local TS/JS imports.
 *
 * This adapter does not bundle. In its default mode it discovers and compiles
 * only. `rewrite: 'in-place'` changes actual import-specifier tokens to point
 * at generated JavaScript proxies, leaving the Rust sources intact.
 */
export async function prepareRustImports(options) {
    if (options.entrypoints.length === 0) {
        throw new Error('prepareRustImports requires at least one entrypoint');
    }
    const rewrite = options.rewrite ?? 'none';
    if (rewrite !== 'none' && rewrite !== 'in-place') {
        throw new Error(`Unknown Rust import rewrite mode: ${String(rewrite)}`);
    }
    const rootDir = await canonicalDirectory(options.rootDir);
    const entrypoints = [];
    for (const entrypoint of options.entrypoints) {
        const requested = isAbsolute(entrypoint) ? resolve(entrypoint) : resolve(rootDir, entrypoint);
        assertInsideRoot(rootDir, requested, `Entrypoint ${entrypoint}`);
        const canonical = await canonicalFile(requested, rootDir, `Entrypoint ${entrypoint}`);
        if (!isSourceModule(canonical)) {
            throw new Error(`Entrypoint is not a TS/JS module: ${canonical}`);
        }
        entrypoints.push(canonical);
    }
    const compiler = options.compile ?? compileRustModule;
    const compileOptions = {
        allowedRoot: rootDir,
        cacheDir: options.cacheDir,
        release: options.release,
        force: options.force,
        cargo: options.cargo,
        env: options.env
    };
    const records = new Map();
    const artifactsBySource = new Map();
    const queue = [...entrypoints];
    const queued = new Set(queue);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const filePath = queue[cursor];
        if (records.has(filePath))
            continue;
        const source = await readFile(filePath, 'utf8');
        const scanned = scanImports(filePath, source);
        const matchedTokens = rewrite === 'in-place'
            ? matchScannedImports(scanned, locateImportSpecifierTokens(source))
            : [];
        const rewrites = [];
        for (let index = 0; index < scanned.length; index += 1) {
            const item = scanned[index];
            if (!isLocalSpecifier(item.path))
                continue;
            const rustImport = rustPathFromSpecifier(item.path);
            if (rustImport != null) {
                const rustPath = await resolveRustImport(filePath, rustImport, rootDir);
                let artifact = artifactsBySource.get(rustPath);
                if (!artifact) {
                    artifact = await compiler(rustPath, compileOptions);
                    validateCompilerArtifact(artifact, rustPath);
                    artifactsBySource.set(rustPath, artifact);
                }
                if (rewrite === 'in-place') {
                    const token = matchedTokens[index];
                    if (!token) {
                        throw new Error(`Could not safely locate the ${JSON.stringify(item.path)} import token in ${filePath}`);
                    }
                    const proxySpecifier = relativeModuleSpecifier(dirname(filePath), artifact.proxyPath);
                    rewrites.push({
                        start: token.start,
                        end: token.end,
                        replacement: quoteSpecifier(proxySpecifier, token.quote)
                    });
                }
                continue;
            }
            const dependency = await resolveSourceImport(filePath, item.path, rootDir);
            if (dependency && !records.has(dependency) && !queued.has(dependency)) {
                queue.push(dependency);
                queued.add(dependency);
            }
        }
        records.set(filePath, { path: filePath, source, rewrites });
    }
    const rewrittenFiles = [];
    if (rewrite === 'in-place') {
        rewrittenFiles.push(...(await transactionallyRewriteSources(rootDir, records.values())));
    }
    return {
        entrypoints,
        files: [...records.keys()],
        artifacts: [...artifactsBySource.values()],
        rewrittenFiles
    };
}
function scanImports(filePath, source) {
    const transpiler = new Bun.Transpiler({ loader: loaderFor(filePath) });
    return transpiler.scanImports(source);
}
function loaderFor(filePath) {
    switch (extname(filePath).toLowerCase()) {
        case '.tsx':
            return 'tsx';
        case '.ts':
        case '.mts':
        case '.cts':
            return 'ts';
        case '.jsx':
            return 'jsx';
        default:
            return 'js';
    }
}
async function resolveRustImport(importer, specifier, rootDir) {
    const requested = resolveImportPath(importer, specifier);
    assertInsideRoot(rootDir, requested, `Rust import ${JSON.stringify(specifier)} from ${importer}`);
    return canonicalFile(requested, rootDir, `Rust import ${JSON.stringify(specifier)} from ${importer}`);
}
async function resolveSourceImport(importer, specifier, rootDir) {
    const requested = resolveImportPath(importer, specifier);
    assertInsideRoot(rootDir, requested, `Local import ${JSON.stringify(specifier)} from ${importer}`);
    const requestedExtension = extname(requested).toLowerCase();
    const candidates = [requested];
    if (requestedExtension === '') {
        for (const extension of EXTENSION_CANDIDATES)
            candidates.push(`${requested}${extension}`);
        for (const extension of EXTENSION_CANDIDATES)
            candidates.push(join(requested, `index${extension}`));
    }
    else if (requestedExtension === '.js') {
        candidates.push(requested.slice(0, -3) + '.ts', requested.slice(0, -3) + '.tsx');
    }
    else if (requestedExtension === '.mjs') {
        candidates.push(requested.slice(0, -4) + '.mts');
    }
    else if (requestedExtension === '.cjs') {
        candidates.push(requested.slice(0, -4) + '.cts');
    }
    for (const candidate of candidates) {
        assertInsideRoot(rootDir, candidate, `Local import ${JSON.stringify(specifier)} from ${importer}`);
        if (!(await isRegularFile(candidate)))
            continue;
        if (!isSourceModule(candidate))
            return null;
        return canonicalFile(candidate, rootDir, `Local import ${JSON.stringify(specifier)} from ${importer}`);
    }
    // Explicit asset imports are not part of the TS/JS dependency graph.
    if (requestedExtension !== '' && !SOURCE_EXTENSIONS.has(requestedExtension))
        return null;
    throw new Error(`Could not resolve local module ${JSON.stringify(specifier)} imported by ${importer}`);
}
function resolveImportPath(importer, specifier) {
    return isAbsolute(specifier) ? resolve(specifier) : resolve(dirname(importer), specifier);
}
function isLocalSpecifier(specifier) {
    return (specifier === '.' ||
        specifier === '..' ||
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        isAbsolute(specifier));
}
function rustPathFromSpecifier(specifier) {
    // Query/hash modifiers do not describe a concrete native source file and
    // would be ambiguous after rewriting.
    const modifier = specifier.search(/[?#]/);
    if (modifier >= 0) {
        if (extname(specifier.slice(0, modifier)).toLowerCase() === '.rs') {
            throw new Error(`Rust source imports cannot contain query or hash modifiers: ${specifier}`);
        }
        return null;
    }
    return extname(specifier).toLowerCase() === '.rs' ? specifier : null;
}
function validateCompilerArtifact(artifact, sourcePath) {
    if (resolve(artifact.sourcePath) !== sourcePath) {
        throw new Error(`Rust compiler returned an artifact for ${artifact.sourcePath}, expected ${sourcePath}`);
    }
    if (!isAbsolute(artifact.nodePath) || extname(artifact.nodePath) !== '.node') {
        throw new Error(`Rust compiler returned an invalid native artifact path: ${artifact.nodePath}`);
    }
    if (!isAbsolute(artifact.proxyPath) || !['.js', '.mjs', '.cjs'].includes(extname(artifact.proxyPath))) {
        throw new Error(`Rust compiler returned an invalid proxy path: ${artifact.proxyPath}`);
    }
}
function isSourceModule(filePath) {
    return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}
async function canonicalDirectory(path) {
    const resolved = resolve(path);
    const canonical = await realpath(resolved);
    const info = await stat(canonical);
    if (!info.isDirectory())
        throw new Error(`Rust import root is not a directory: ${resolved}`);
    return canonical;
}
async function canonicalFile(path, rootDir, label) {
    let canonical;
    try {
        canonical = await realpath(path);
    }
    catch (error) {
        throw new Error(`${label} does not exist: ${path}`, { cause: error });
    }
    assertInsideRoot(rootDir, canonical, label);
    const info = await stat(canonical);
    if (!info.isFile())
        throw new Error(`${label} is not a file: ${canonical}`);
    return canonical;
}
function assertInsideRoot(rootDir, path, label) {
    const rel = relative(rootDir, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`${label} escapes rootDir ${rootDir}: ${path}`);
    }
}
async function isRegularFile(path) {
    try {
        return (await stat(path)).isFile();
    }
    catch (error) {
        if (isMissingPathError(error))
            return false;
        throw error;
    }
}
function isMissingPathError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'ENOENT' ||
            error.code === 'ENOTDIR'));
}
function relativeModuleSpecifier(fromDir, target) {
    let specifier = relative(fromDir, target).split(sep).join('/');
    if (!specifier.startsWith('./') && !specifier.startsWith('../'))
        specifier = `./${specifier}`;
    return specifier;
}
async function transactionallyRewriteSources(rootDir, records) {
    const targets = [...records].filter((record) => record.rewrites.length > 0);
    if (targets.length === 0)
        return [];
    // Validate and render the entire graph before creating even temporary files.
    const staged = [];
    for (const record of targets) {
        const { current, mode } = await validateRewriteTarget(rootDir, record);
        staged.push({
            path: record.path,
            original: current,
            replacement: applyRewrites(record.path, current, record.rewrites),
            mode,
            temporaryPath: temporaryPathFor(record.path, 'stage'),
            committed: false
        });
    }
    let commitStarted = false;
    try {
        // Stage every replacement beside its target so each later rename is atomic
        // and remains on the same filesystem.
        for (const item of staged) {
            await writeFile(item.temporaryPath, item.replacement, {
                encoding: 'utf8',
                mode: item.mode
            });
        }
        // Staging can take time. Recheck every target before changing any source.
        for (const item of staged) {
            await assertRewriteTargetUnchanged(rootDir, item.path, item.original);
        }
        commitStarted = true;
        for (const item of staged) {
            // Also close the window between the graph-wide check and this target's
            // individual commit. A later stale target triggers rollback of earlier
            // commits rather than silently overwriting it.
            await assertRewriteTargetUnchanged(rootDir, item.path, item.original);
            await rename(item.temporaryPath, item.path);
            item.committed = true;
        }
        return staged.map((item) => item.path);
    }
    catch (error) {
        const rollbackErrors = [];
        if (commitStarted) {
            for (const item of [...staged].reverse()) {
                if (!item.committed)
                    continue;
                try {
                    await restoreCommittedRewrite(rootDir, item);
                }
                catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
        }
        await cleanupStagedFiles(staged);
        if (!commitStarted)
            throw error;
        const message = `Failed to commit Rust import rewrites: ${errorMessage(error)}` +
            (rollbackErrors.length === 0
                ? '; previously committed files were restored'
                : `; ${rollbackErrors.length} rollback operation(s) also failed`);
        if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors], message);
        }
        throw new Error(message, { cause: error });
    }
    finally {
        await cleanupStagedFiles(staged);
    }
}
async function restoreCommittedRewrite(rootDir, item) {
    const temporary = temporaryPathFor(item.path, 'rollback');
    try {
        // Prepare the original first, then perform the conditional check as close
        // as possible to the atomic replacement. This avoids a long write window
        // between observing the committed value and restoring it.
        await writeFile(temporary, item.original, { encoding: 'utf8', mode: item.mode });
        let canonical;
        try {
            canonical = await canonicalFile(item.path, rootDir, `Rollback target ${item.path}`);
        }
        catch (error) {
            throw new Error(`Refusing to roll back ${item.path}; its path changed after this transaction committed it`, { cause: error });
        }
        if (canonical !== item.path || (await readFile(item.path, 'utf8')) !== item.replacement) {
            throw new Error(`Refusing to roll back ${item.path}; its contents or path changed after this transaction committed it`);
        }
        await rename(temporary, item.path);
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
async function validateRewriteTarget(rootDir, record) {
    const canonical = await canonicalFile(record.path, rootDir, `Rewrite target ${record.path}`);
    if (canonical !== record.path) {
        throw new Error(`Rewrite target changed while preparing Rust imports: ${record.path}`);
    }
    const current = await readFile(record.path, 'utf8');
    if (current !== record.source) {
        throw new Error(`Refusing to overwrite ${record.path}; it changed while Rust imports were prepared`);
    }
    return { current, mode: (await stat(record.path)).mode };
}
async function assertRewriteTargetUnchanged(rootDir, path, original) {
    const canonical = await canonicalFile(path, rootDir, `Rewrite target ${path}`);
    if (canonical !== path || (await readFile(path, 'utf8')) !== original) {
        throw new Error(`Refusing to overwrite ${path}; it changed before Rust imports were committed`);
    }
}
function applyRewrites(path, source, changes) {
    const rewrites = [...changes].sort((left, right) => right.start - left.start);
    let output = source;
    let previousStart = source.length + 1;
    for (const rewrite of rewrites) {
        if (rewrite.start < 0 || rewrite.end > source.length || rewrite.start >= rewrite.end) {
            throw new Error(`Invalid import rewrite range for ${path}`);
        }
        if (rewrite.end > previousStart) {
            throw new Error(`Overlapping import rewrites for ${path}`);
        }
        output = output.slice(0, rewrite.start) + rewrite.replacement + output.slice(rewrite.end);
        previousStart = rewrite.start;
    }
    return output;
}
function temporaryPathFor(path, phase) {
    return join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.rust-imports-${phase}`);
}
async function cleanupStagedFiles(staged) {
    await Promise.allSettled(staged.filter((item) => !item.committed).map((item) => rm(item.temporaryPath, { force: true })));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function quoteSpecifier(value, quote) {
    let escaped = value.replaceAll('\\', '\\\\');
    if (quote === '`') {
        escaped = escaped.replaceAll('`', '\\`').replaceAll('${', '\\${');
    }
    else {
        escaped = escaped.replaceAll(quote, `\\${quote}`);
    }
    return `${quote}${escaped}${quote}`;
}
function matchScannedImports(scanned, tokens) {
    const matches = new Array(scanned.length);
    const used = new Set();
    let minimumStart = 0;
    for (let scanIndex = 0; scanIndex < scanned.length; scanIndex += 1) {
        const item = scanned[scanIndex];
        const kind = scannedKind(item.kind);
        if (!kind)
            continue;
        let tokenIndex = tokens.findIndex((token, index) => !used.has(index) &&
            token.start >= minimumStart &&
            token.kind === kind &&
            token.value === item.path);
        if (tokenIndex < 0) {
            tokenIndex = tokens.findIndex((token, index) => !used.has(index) && token.kind === kind && token.value === item.path);
        }
        if (tokenIndex < 0)
            continue;
        used.add(tokenIndex);
        matches[scanIndex] = tokens[tokenIndex];
        minimumStart = tokens[tokenIndex].end;
    }
    return matches;
}
function scannedKind(kind) {
    switch (kind) {
        case 'import-statement':
            return 'static';
        case 'dynamic-import':
            return 'dynamic';
        case 'require-call':
            return 'require';
        default:
            return null;
    }
}
/**
 * Finds only grammar-shaped import string tokens. Bun's scanner remains the
 * authority on which imports exist; these positions are correlated with its
 * output before any source is changed.
 */
function locateImportSpecifierTokens(source) {
    const tokens = lexJavaScript(source);
    const specifiers = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.kind !== 'identifier')
            continue;
        if (token.value === 'require') {
            if (tokens[index - 1]?.value === '.')
                continue;
            const open = tokens[index + 1];
            const value = tokens[index + 2];
            if (open?.value === '(' && value?.kind === 'string') {
                specifiers.push(toSpecifierToken('require', value));
            }
            continue;
        }
        if (token.value === 'import') {
            if (tokens[index - 1]?.value === '.')
                continue;
            const next = tokens[index + 1];
            if (next?.kind === 'string') {
                specifiers.push(toSpecifierToken('static', next));
                continue;
            }
            if (next?.value === '(' && tokens[index + 2]?.kind === 'string') {
                specifiers.push(toSpecifierToken('dynamic', tokens[index + 2]));
                continue;
            }
            const from = findFromSpecifier(tokens, index + 1);
            if (from)
                specifiers.push(toSpecifierToken('static', from));
            continue;
        }
        if (token.value === 'export') {
            const from = findFromSpecifier(tokens, index + 1);
            if (from)
                specifiers.push(toSpecifierToken('static', from));
        }
    }
    return specifiers.sort((left, right) => left.start - right.start);
}
function findFromSpecifier(tokens, start) {
    for (let index = start; index < tokens.length && index < start + 512; index += 1) {
        const token = tokens[index];
        if (token.value === ';')
            return null;
        if (token.kind === 'identifier' &&
            token.value === 'from' &&
            tokens[index + 1]?.kind === 'string') {
            return tokens[index + 1];
        }
    }
    return null;
}
function toSpecifierToken(kind, token) {
    if (token.kind !== 'string' || token.value == null || token.quote == null) {
        throw new Error('Internal Rust import token mismatch');
    }
    return {
        kind,
        value: token.value,
        start: token.start,
        end: token.end,
        quote: token.quote
    };
}
function lexJavaScript(source) {
    const tokens = [];
    function scanCode(start, stopAtTemplateBrace) {
        let index = start;
        let braceDepth = 0;
        while (index < source.length) {
            const char = source[index];
            if (isWhitespace(char)) {
                index += 1;
                continue;
            }
            if (char === '/' && source[index + 1] === '/') {
                index = skipLineComment(source, index + 2);
                continue;
            }
            if (char === '/' && source[index + 1] === '*') {
                index = skipBlockComment(source, index + 2);
                continue;
            }
            if (char === "'" || char === '"') {
                const token = scanQuotedString(source, index, char);
                tokens.push(token);
                index = token.end;
                continue;
            }
            if (char === '`') {
                index = scanTemplate(index);
                continue;
            }
            if (isIdentifierStart(char)) {
                const end = scanIdentifier(source, index + 1);
                tokens.push({ kind: 'identifier', value: source.slice(index, end), start: index, end });
                index = end;
                continue;
            }
            if (char === '/' && canStartRegularExpression(tokens.at(-1))) {
                const end = skipRegularExpression(source, index + 1);
                tokens.push({ kind: 'other', start: index, end });
                index = end;
                continue;
            }
            if (stopAtTemplateBrace && char === '}' && braceDepth === 0)
                return index + 1;
            if (char === '{')
                braceDepth += 1;
            if (char === '}' && braceDepth > 0)
                braceDepth -= 1;
            tokens.push({ kind: 'punctuation', value: char, start: index, end: index + 1 });
            index += 1;
        }
        return index;
    }
    function scanTemplate(start) {
        let index = start + 1;
        let hasInterpolation = false;
        while (index < source.length) {
            const char = source[index];
            if (char === '\\') {
                index += 2;
                continue;
            }
            if (char === '`') {
                const end = index + 1;
                if (!hasInterpolation) {
                    tokens.push({
                        kind: 'string',
                        value: decodeStringContents(source.slice(start + 1, index)),
                        start,
                        end,
                        quote: '`'
                    });
                }
                return end;
            }
            if (char === '$' && source[index + 1] === '{') {
                if (!hasInterpolation)
                    tokens.push({ kind: 'other', start, end: index + 2 });
                hasInterpolation = true;
                index = scanCode(index + 2, true);
                continue;
            }
            index += 1;
        }
        return index;
    }
    scanCode(0, false);
    return tokens;
}
function scanQuotedString(source, start, quote) {
    let index = start + 1;
    while (index < source.length) {
        if (source[index] === '\\') {
            index += 2;
            continue;
        }
        if (source[index] === quote) {
            return {
                kind: 'string',
                value: decodeStringContents(source.slice(start + 1, index)),
                start,
                end: index + 1,
                quote
            };
        }
        index += 1;
    }
    return { kind: 'other', start, end: source.length };
}
function decodeStringContents(raw) {
    let decoded = '';
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char !== '\\') {
            decoded += char;
            continue;
        }
        const escaped = raw[++index];
        if (escaped == null)
            break;
        switch (escaped) {
            case '\n':
                break;
            case '\r':
                if (raw[index + 1] === '\n')
                    index += 1;
                break;
            case 'n':
                decoded += '\n';
                break;
            case 'r':
                decoded += '\r';
                break;
            case 't':
                decoded += '\t';
                break;
            case 'b':
                decoded += '\b';
                break;
            case 'f':
                decoded += '\f';
                break;
            case 'v':
                decoded += '\v';
                break;
            case '0':
                decoded += '\0';
                break;
            case 'x': {
                const hex = raw.slice(index + 1, index + 3);
                if (/^[\da-fA-F]{2}$/.test(hex)) {
                    decoded += String.fromCodePoint(Number.parseInt(hex, 16));
                    index += 2;
                }
                else {
                    decoded += escaped;
                }
                break;
            }
            case 'u': {
                const braced = raw[index + 1] === '{';
                const close = braced ? raw.indexOf('}', index + 2) : -1;
                const hex = braced ? raw.slice(index + 2, close) : raw.slice(index + 1, index + 5);
                if (/^[\da-fA-F]+$/.test(hex) && (!braced || close >= 0)) {
                    decoded += String.fromCodePoint(Number.parseInt(hex, 16));
                    index = braced ? close : index + 4;
                }
                else {
                    decoded += escaped;
                }
                break;
            }
            default:
                decoded += escaped;
        }
    }
    return decoded;
}
function skipLineComment(source, start) {
    let index = start;
    while (index < source.length && source[index] !== '\n' && source[index] !== '\r')
        index += 1;
    return index;
}
function skipBlockComment(source, start) {
    const end = source.indexOf('*/', start);
    return end < 0 ? source.length : end + 2;
}
function skipRegularExpression(source, start) {
    let index = start;
    let characterClass = false;
    while (index < source.length) {
        const char = source[index];
        if (char === '\\') {
            index += 2;
            continue;
        }
        if (char === '[')
            characterClass = true;
        if (char === ']')
            characterClass = false;
        if (char === '/' && !characterClass) {
            index += 1;
            while (/[a-z]/i.test(source[index] ?? ''))
                index += 1;
            return index;
        }
        if (char === '\n' || char === '\r')
            return index;
        index += 1;
    }
    return index;
}
function canStartRegularExpression(previous) {
    if (!previous)
        return true;
    if (previous.kind === 'identifier') {
        return new Set([
            'await',
            'case',
            'delete',
            'do',
            'else',
            'in',
            'instanceof',
            'of',
            'return',
            'throw',
            'typeof',
            'void',
            'yield'
        ]).has(previous.value ?? '');
    }
    return new Set(['(', '[', '{', ',', ';', ':', '=', '!', '?', '&', '|', '+', '-', '*', '%', '^', '~', '<', '>']).has(previous.value ?? '');
}
function scanIdentifier(source, start) {
    let index = start;
    while (index < source.length && isIdentifierContinue(source[index]))
        index += 1;
    return index;
}
function isIdentifierStart(char) {
    return char != null && /[A-Za-z_$]/.test(char);
}
function isIdentifierContinue(char) {
    return char != null && /[A-Za-z0-9_$]/.test(char);
}
function isWhitespace(char) {
    return char != null && /\s/.test(char);
}
