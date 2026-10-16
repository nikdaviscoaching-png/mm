# Stacker 1.2.0

Focus stacking, light stacking, or both at once, for 5–10 tripod photos. Runs entirely in the browser, works offline once opened, and installs to the home screen like an app. Nothing is uploaded anywhere.

## Deploy (2 minutes)

This ZIP is the finished site: `index.html` is at the top level. Unzip it and put the folder on any **HTTPS** static host.

| Host | Steps |
|---|---|
| **Vercel** | New Project → drag the unzipped folder in (or `vercel --prod` inside it). `vercel.json` sets the headers. |
| **Netlify** | Sites → *Deploy manually* → drop the folder. `_headers` sets the headers. |
| **Cloudflare Pages** | Create a project → *Direct upload* → the folder. `_headers` sets the headers. |
| **GitHub Pages / S3 / any other static host** | Upload the files as they are. The host cannot send the headers, so the service worker adds them on the first reload (see below). |

Use the site's root (`https://your-site/`), not a sub-folder, if you can. Sub-folders work, but the install scope is then that folder.

### Install on iPhone / iPad
Open the site in **Safari** → **Share** → **Add to Home Screen**. Launch it from the icon. The first launch downloads about 2.5 MB and then needs no network.

### Install on Android / desktop
Chrome / Edge: ⋮ menu → *Install app*.

## Why the headers matter
RAW files (CR2/CR3, NEF, ARW, RAF, DNG, ORF, RW2…) are decoded by LibRaw compiled to WebAssembly, which needs shared memory, which browsers allow only on pages that are *cross-origin isolated* (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`). `vercel.json` / `_headers` send them. On hosts that cannot, `sw.js` re-serves the page with those headers and the app reloads itself once. JPEG, PNG, HEIC and WebP input never needs this.

## Using it
1. Tap **Add photos** (or drop them on desktop) and choose 5–10 photos from the tripod series.
2. Stacker detects whether they differ in focus, in light, or both and picks a method. You can change it.
3. Adjust the sliders; the preview updates in place. The ★ on a thumbnail picks the base frame.
4. **Save** offers *Full resolution* (the size of your photos, JPEG quality 95, 4:4:4, with EXIF), 12 MP, or 4 MP. Full resolution is exported in tiles, so it fits in phone memory.

Methods — focus: *Sharp* (default), *Clean*, *See-through*; light: *Reflections* (keeps your natural light and replaces glare, reflections and shadows from cleaner frames), *Balanced*, *HDR*, *Brightest*, *Darkest*, *Less noise*; and *Both*, which selects by sharpness only where the lighting of a frame can be trusted.

## Updating
Replace the files on the host. Installed copies pick up the new version the next time they are opened online and show an "Update ready" notice. The service worker is served with `no-cache`, and a new version is precached completely before it replaces the old one, so an update can never leave the app half-updated offline.

## Limits worth knowing
* Photos should come from a tripod or be close to it. Alignment corrects small shifts, scale (focus breathing) and rotation, not parallax.
* Working resolution during editing is capped (≤ 2048 px long side) to keep it responsive; **the saved file is rendered again from the full-resolution photos**.
* Browsers cap tab memory. On a 12 MP × 8 test the renderer peaked at about 600 MB, and 24 MP × 5 at about 550 MB. For very large pictures (over 30 MP) Save shows a warning and suggests 12 MP if the app restarts.
* Frames from different cameras or very different compositions are not supported.

## Files
`index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, `js/` (the app, the stacking engine and a worker), `vendor/` (LibRaw-wasm, exifr, piexifjs — see `THIRD_PARTY_NOTICES.txt`), `icons/`, `vercel.json`, `_headers`. `RESULTS.md` has the measured quality and speed; `CHANGELOG.md` has what changed since 1.1.1.
