// SPDX-License-Identifier: Apache-2.0
//
// Cloudflare Worker for the demo. Static files in web/ are served as Workers
// static assets, with the cross-origin isolation headers set in web/_headers.
// QEMU's .wasm (about 45 MB) is over the 25 MiB limit for a static asset, so
// it lives in R2 and is served from here, on the page's own origin, with the
// same headers.

const WASM = 'qemu-system-i386.wasm';

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== `/${WASM}`) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const object = request.method === 'HEAD'
      ? await env.WASM.head(WASM)
      : await env.WASM.get(WASM, { onlyIf: request.headers });
    if (!object) return new Response('Not found', { status: 404, headers: ISOLATION });

    const headers = new Headers(ISOLATION);
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', 'application/wasm');
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=3600');
    if (request.method === 'HEAD') {
      headers.set('Content-Length', String(object.size));
      return new Response(null, { headers });
    }
    // A conditional GET that matched: R2 returns the metadata without a body.
    if (!('body' in object)) return new Response(null, { status: 304, headers });
    return new Response(object.body, { headers });
  },
};
