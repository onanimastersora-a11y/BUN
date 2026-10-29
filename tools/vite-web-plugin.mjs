// Vite plugin for the web / iPhone build (vite build --mode web):
// adds the Home Screen meta tags, writes manifest.webmanifest and a service
// worker that precaches every file of the build.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function listFiles(dir, root = dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full, root) : [relative(root, full).replaceAll('\\', '/')];
  });
}

const HEAD = `
    <meta name="theme-color" content="#f6f2ec" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#15171c" media="(prefers-color-scheme: dark)" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="BUN" />
    <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />
    <meta name="description" content="BUN — lịch trình, checklist và thú cưng pixel nhắc việc." />`;

export default function webApp({ publicDir = 'public' } = {}) {
  return {
    name: 'bun-web-app',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace('content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"')
        .replace('</head>', `${HEAD}\n  </head>`);
    },
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(
          {
            name: 'BUN',
            short_name: 'BUN',
            description: 'Lịch trình, checklist và thú cưng pixel nhắc việc',
            lang: 'vi',
            start_url: './',
            scope: './',
            display: 'standalone',
            orientation: 'portrait',
            background_color: '#f6f2ec',
            theme_color: '#f6f2ec',
            icons: [
              { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
              { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
              { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
          },
          null,
          2,
        ),
      });
      // Fonts: only woff2 for the scripts BUN uses (the browser fetches others on demand).
      const wanted = (f) => !/\.(woff2?)$/.test(f) || (f.endsWith('.woff2') && /(latin|vietnamese|pixelify)/.test(f) && !/(cyrillic|greek)/.test(f));
      // No duplicates: cache.addAll() rejects the whole install if a URL appears twice.
      const files = [...new Set([...Object.keys(bundle), 'manifest.webmanifest', ...listFiles(publicDir)])].filter((f) => f !== 'index.html' && wanted(f));
      const version = Date.now().toString(36);
      const sw = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        // index.html itself is cached as './' (Cloudflare redirects /app/index.html to /app/).
        .replace('__FILES__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}
