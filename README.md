# Open Wall

Historic public-domain art on one endless wall: about 10,000 paintings, prints and drawings from 1860–1930, drawn by the GPU. Re-hang the collection by colour or by time, filter by medium or artist, and step into any work. The room takes on its colour.

**Live:** https://open-wall.pablopsoto.dev

## The collection

Open-access works from seven museums: the Cleveland Museum of Art, the National Gallery of Art (Washington), SMK (National Gallery of Denmark), the Belvedere (Vienna, via Europeana), the Rijksmuseum, the Finnish National Gallery and Nationalmuseum (Stockholm, via Europeana). The artworks are public domain; Belvedere photographs are CC BY-SA 4.0 and credited on each work.

## Stack

- three.js on WebGL2: every work is an instance of one quad, sampled from packed WebP atlas sheets; sharper images stream in as works grow on screen.
- A Cloudflare Worker serves the site, proxies museum images (most museum CDNs send no CORS headers) and keeps the curator's decisions in D1.
- `/admin.html`: a password-protected curator for deciding what hangs on the wall.

## Run it

```sh
npm install
npm run dev        # local site
npm run data       # rebuild the collection, palettes and atlases from the museums' APIs
npm run texts      # rebuild descriptions and histories
npm run deploy     # build and deploy to Cloudflare
```

The curator needs `ADMIN_PASSWORD`: in `.dev.vars` locally, `wrangler secret put ADMIN_PASSWORD` in production.

---

Designed and built by Pablo Pérez — [@pablopsoto](https://www.instagram.com/pablopsoto/)
