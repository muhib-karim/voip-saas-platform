// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
    });
}

// Vite resolves "./App" to App.jsx before App.tsx and vite.config.js before
// vite.config.ts. While a JavaScript copy of the app lived next to the
// TypeScript one, the production bundle was built from the JavaScript copy and
// none of the type-checked, tested code was shipped.
describe('there is exactly one application source tree', () => {
    it('has no .js or .jsx modules under src/', () => {
        const shadows = walk(path.join(root, 'src'))
            .filter((file) => /\.(js|jsx|mjs|cjs)$/.test(file))
            .map((file) => path.relative(root, file));

        expect(shadows).toEqual([]);
    });

    it('has a single Vite config, the TypeScript one', () => {
        const configs = fs.readdirSync(root).filter((name) => /^vite\.config\./.test(name));
        expect(configs).toEqual(['vite.config.ts']);
    });

    it('index.html boots the TypeScript entry point', () => {
        const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
        expect(html).toContain('src="/src/main.tsx"');
        expect(fs.existsSync(path.join(root, 'src/main.tsx'))).toBe(true);
    });

    it('every stylesheet under src/ is imported by something', () => {
        const files = walk(path.join(root, 'src'));
        const sources = files.filter((file) => /\.(ts|tsx)$/.test(file));
        const imported = new Set<string>();
        for (const file of sources) {
            const text = fs.readFileSync(file, 'utf8');
            for (const match of text.matchAll(/import\s+['"](\.[^'"]+\.css)['"]/g)) {
                imported.add(path.resolve(path.dirname(file), match[1]));
            }
        }

        const orphans = files
            .filter((file) => file.endsWith('.css') && !imported.has(file))
            .map((file) => path.relative(root, file));

        expect(orphans).toEqual([]);
    });
});
