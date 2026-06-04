import * as esbuild from 'esbuild';

await esbuild.build({
    entryPoints: ['./src/index.ts'],
    bundle: true,
    target: 'esnext',
    format: 'esm',
    outfile: './dist/index.js',
    minify: true,
    keepNames: true,
    treeShaking: true,
    target: 'chrome138'
});