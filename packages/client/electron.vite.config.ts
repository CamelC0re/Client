import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
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
          fs: {
            allow: ['..']
          },
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept'
          },
          proxy: {
            '/socket.io': {
              target: 'https://server1.highspell.com:8888',
              changeOrigin: true,
              secure: true,
              headers: {
                'Origin': 'https://highspell.com',
                'Referer': 'https://highspell.com/'
              }
            },
            '/api': {
              target: 'https://highspell.com',
              changeOrigin: true,
              secure: true,
              headers: {
                'Origin': 'https://highspell.com',
                'Referer': 'https://highspell.com/'
              }
            }
          }
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
