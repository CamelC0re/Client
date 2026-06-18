import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        // Baked at build time. Only TRUE in the canonical CamelC0re/Client CI build (set in
        // build.yml from github.repository). Fork/test builds get FALSE → the auto-updater stays
        // off so a build a dev is testing is never clobbered; canonical builds update from
        // CamelC0re/Client. See updater/index.ts.
        __EVILLITE_CANONICAL__: JSON.stringify(process.env.EVILLITE_CANONICAL === 'true'),
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()]
    },
    renderer: {
      plugins: [],
      resolve: {
        alias: {
          "@static": resolve(__dirname, "static")
        }
      },
      ...(isDev && {
        server: {
          hmr: {
            protocol: 'ws',
            host: 'localhost',
            port: 5173
          },
          fs: {
            allow: ['..']
          },
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept'
          }
          // No Vite proxy: EvilLite loads evilquest.net (game, /api, /oauth, WS) through the
          // main-process protocol/webRequest handler, not the dev server. The inherited
          // RyeLite/HighLite proxy pointed /api + /socket.io at highspell.com and only caused
          // proxy errors here, so it's removed.
        }
      }),
      publicDir: resolve(__dirname, "static"),
      root: resolve(__dirname, 'src/renderer'),
      build: {
        rollupOptions: {
          input: {
            client: resolve(__dirname, 'src/renderer/client.html'),
            update: resolve(__dirname, 'src/renderer/update.html'),
            console: resolve(__dirname, 'src/renderer/console.html'),
            settings: resolve(__dirname, 'src/renderer/settings.html'),
          }
        }
      }
    }
  };
})
