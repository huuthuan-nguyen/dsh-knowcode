import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
const require = createRequire(import.meta.url);
/**
 * Built-in core languages pre-loaded at startup for instantaneous response.
 */
export const CORE_LANGUAGES = [
    'typescript',
    'tsx',
    'javascript',
    'python',
    'go',
    'rust',
    'c',
    'cpp',
    'java',
    'c_sharp',
    'ruby',
    'php',
    'solidity',
    'lua',
    'zig',
    'bash',
];
export class TreeSitterEngine {
    static initialized = false;
    static initPromise = null;
    static languages = new Map();
    static parsers = new Map();
    static customExtensions = new Map();
    static loadPromises = new Map();
    static wasmPathCache = new Map();
    /**
     * Timeout in microseconds for parser execution to prevent catastrophic grammar loops (1 second)
     */
    static PARSER_TIMEOUT_MICROS = 1_000_000;
    /**
     * Normalize language names (e.g. csharp -> c_sharp, shell -> bash)
     */
    static normalizeLanguageName(name) {
        const lower = name.toLowerCase().replace(/[\s-]/g, '_');
        if (lower === 'csharp' || lower === 'cs' || lower === 'c#')
            return 'c_sharp';
        if (lower === 'shell' || lower === 'sh' || lower === 'zsh')
            return 'bash';
        if (lower === 'golang')
            return 'go';
        if (lower === 'c++')
            return 'cpp';
        if (lower === 'js')
            return 'javascript';
        if (lower === 'ts')
            return 'typescript';
        if (lower === 'rb')
            return 'ruby';
        if (lower === 'py')
            return 'python';
        if (lower === 'kt')
            return 'kotlin';
        if (lower === 'sol')
            return 'solidity';
        if (lower === 'rs')
            return 'rust';
        return lower;
    }
    /**
     * Search for a WASM file for the specified language across:
     * 1. Environment variable KNOWCODE_GRAMMARS_DIR
     * 2. Local workspace .knowcode/grammars/
     * 3. User home ~/.knowcode/grammars/
     * 4. Bundled tree-sitter-wasms/out/ (cached in memory)
     */
    static resolveWasmPath(lang) {
        const norm = TreeSitterEngine.normalizeLanguageName(lang);
        if (this.wasmPathCache.has(norm)) {
            return this.wasmPathCache.get(norm);
        }
        const candidateFilenames = [
            `tree-sitter-${norm}.wasm`,
            `${norm}.wasm`,
            `tree-sitter-${lang}.wasm`,
            `${lang}.wasm`,
        ];
        // 1. Custom directory from environment
        const envDir = process.env.KNOWCODE_GRAMMARS_DIR;
        if (envDir && existsSync(envDir)) {
            for (const fn of candidateFilenames) {
                const full = join(envDir, fn);
                if (existsSync(full)) {
                    this.wasmPathCache.set(norm, full);
                    return full;
                }
            }
        }
        // 2. Project local directory .knowcode/grammars
        const localDir = resolve(process.cwd(), '.knowcode', 'grammars');
        if (existsSync(localDir)) {
            for (const fn of candidateFilenames) {
                const full = join(localDir, fn);
                if (existsSync(full)) {
                    this.wasmPathCache.set(norm, full);
                    return full;
                }
            }
        }
        // 3. User home directory ~/.knowcode/grammars
        const userDir = join(homedir(), '.knowcode', 'grammars');
        if (existsSync(userDir)) {
            for (const fn of candidateFilenames) {
                const full = join(userDir, fn);
                if (existsSync(full)) {
                    this.wasmPathCache.set(norm, full);
                    return full;
                }
            }
        }
        // 4. Bundled package tree-sitter-wasms
        // Note: tree-sitter-swift in tree-sitter-wasms 0.1.13 triggers a fatal V8 Turboshaft
        // compiler Zone OOM crash in Node.js 24 during tier-up. We exclude the bundled swift
        // grammar so .swift files safely fall back to the generic regex parser.
        if (norm !== 'swift') {
            for (const fn of candidateFilenames) {
                try {
                    const resolved = require.resolve(`tree-sitter-wasms/out/${fn}`);
                    if (existsSync(resolved)) {
                        this.wasmPathCache.set(norm, resolved);
                        return resolved;
                    }
                }
                catch {
                    // try next
                }
            }
        }
        this.wasmPathCache.set(norm, null);
        return null;
    }
    /**
     * Initialize Tree-sitter WebAssembly core and preload core languages.
     * Safe to call multiple times.
     */
    static async init() {
        if (this.initialized)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = (async () => {
            // 1. Initialize web-tree-sitter WASM runtime
            await Parser.init();
            // 2. Pre-load built-in core languages
            for (const langKey of CORE_LANGUAGES) {
                const wasmPath = TreeSitterEngine.resolveWasmPath(langKey);
                if (wasmPath) {
                    try {
                        const lang = await Parser.Language.load(wasmPath);
                        this.languages.set(langKey, lang);
                        const parser = new Parser();
                        parser.setLanguage(lang);
                        parser.setTimeoutMicros(TreeSitterEngine.PARSER_TIMEOUT_MICROS);
                        this.parsers.set(langKey, parser);
                    }
                    catch (err) {
                        console.warn(`[TreeSitter] Warning: Failed to load core grammar for ${langKey}:`, err);
                    }
                }
            }
            // 3. Auto-discover any custom wasm files in local or home grammars directory
            TreeSitterEngine.scanCustomGrammarDirs();
            this.initialized = true;
        })();
        return this.initPromise;
    }
    /**
     * Scan custom directories and register custom grammars
     */
    static scanCustomGrammarDirs() {
        const dirs = [
            process.env.KNOWCODE_GRAMMARS_DIR,
            resolve(process.cwd(), '.knowcode', 'grammars'),
            join(homedir(), '.knowcode', 'grammars'),
        ].filter((d) => Boolean(d && existsSync(d)));
        for (const dir of dirs) {
            try {
                const entries = readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile() && entry.name.endsWith('.wasm')) {
                        const langName = entry.name
                            .replace(/^tree-sitter-/, '')
                            .replace(/\.wasm$/, '');
                        // Auto register extension if simple name
                        this.registerExtension(`.${langName}`, langName);
                    }
                }
            }
            catch {
                // ignore scan errors
            }
        }
    }
    /**
     * Ensure a specific language grammar is loaded and ready for synchronous parsing.
     * Dynamically loads any language supported by Tree-sitter on demand.
     */
    static async ensureLanguage(lang) {
        const norm = TreeSitterEngine.normalizeLanguageName(lang);
        if (this.parsers.has(norm) || this.parsers.has(lang)) {
            return true;
        }
        if (this.loadPromises.has(norm)) {
            return this.loadPromises.get(norm);
        }
        const promise = (async () => {
            if (!this.initialized) {
                await this.init();
            }
            if (this.parsers.has(norm) || this.parsers.has(lang)) {
                return true;
            }
            const wasmPath = TreeSitterEngine.resolveWasmPath(norm);
            if (!wasmPath) {
                return false;
            }
            try {
                const language = await Parser.Language.load(wasmPath);
                this.languages.set(norm, language);
                if (norm !== lang)
                    this.languages.set(lang, language);
                const parser = new Parser();
                parser.setLanguage(language);
                parser.setTimeoutMicros(TreeSitterEngine.PARSER_TIMEOUT_MICROS);
                this.parsers.set(norm, parser);
                if (norm !== lang)
                    this.parsers.set(lang, parser);
                return true;
            }
            catch (err) {
                console.warn(`[TreeSitter] Unable to load grammar for "${lang}": ${err?.message ?? err}`);
                return false;
            }
        })();
        this.loadPromises.set(norm, promise);
        return promise;
    }
    /**
     * Ensure multiple languages are loaded in batch.
     */
    static async ensureLanguages(langs) {
        const list = Array.from(langs).filter(Boolean);
        await Promise.all(list.map((l) => this.ensureLanguage(l)));
    }
    /**
     * Register a custom Tree-sitter grammar WASM dynamically (from path or memory buffer).
     * Allows plugins or users to bring ANY Tree-sitter language grammar.
     */
    static async registerGrammar(lang, wasmPathOrBuffer, extensions) {
        if (!this.initialized) {
            await this.init();
        }
        const norm = TreeSitterEngine.normalizeLanguageName(lang);
        try {
            const language = await Parser.Language.load(wasmPathOrBuffer);
            this.languages.set(norm, language);
            if (norm !== lang)
                this.languages.set(lang, language);
            const parser = new Parser();
            parser.setLanguage(language);
            parser.setTimeoutMicros(TreeSitterEngine.PARSER_TIMEOUT_MICROS);
            this.parsers.set(norm, parser);
            if (norm !== lang)
                this.parsers.set(lang, parser);
            if (extensions) {
                for (const ext of extensions) {
                    this.registerExtension(ext, norm);
                }
            }
            return true;
        }
        catch (err) {
            console.warn(`[TreeSitter] Failed to register grammar for "${lang}":`, err?.message ?? err);
            return false;
        }
    }
    /**
     * Associate a file extension with a language name.
     */
    static registerExtension(extension, language) {
        const ext = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
        this.customExtensions.set(ext, TreeSitterEngine.normalizeLanguageName(language));
    }
    static getCustomExtension(extension) {
        return this.customExtensions.get(extension.toLowerCase());
    }
    static isReady() {
        return this.initialized;
    }
    static isLanguageLoaded(lang) {
        const norm = TreeSitterEngine.normalizeLanguageName(lang);
        return this.parsers.has(norm) || this.parsers.has(lang);
    }
    static getLanguage(lang) {
        const norm = TreeSitterEngine.normalizeLanguageName(lang);
        return this.languages.get(norm) ?? this.languages.get(lang);
    }
    static getParser(lang) {
        const norm = TreeSitterEngine.normalizeLanguageName(lang);
        return this.parsers.get(norm) ?? this.parsers.get(lang);
    }
    static getLoadedLanguages() {
        return Array.from(this.parsers.keys());
    }
    /**
     * Synchronously parse source code using the loaded Tree-sitter grammar.
     * If the language is not yet loaded, returns null.
     */
    static parse(language, source, filePath) {
        let grammarKey = TreeSitterEngine.normalizeLanguageName(language);
        if (grammarKey === 'typescript' && filePath?.endsWith('.tsx')) {
            grammarKey = 'tsx';
        }
        else if (grammarKey === 'javascript' && filePath?.endsWith('.jsx')) {
            grammarKey = 'javascript';
        }
        const parser = this.parsers.get(grammarKey) ?? this.parsers.get(language);
        if (!parser) {
            return null;
        }
        try {
            return parser.parse(source);
        }
        catch {
            return null;
        }
    }
}
// Auto-initialize core languages via top-level await
await TreeSitterEngine.init();
