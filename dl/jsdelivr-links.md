# Veil OS — jsDelivr version downloads

Every front version of Veil OS served from the GitHub repo `ok5678765s/veil-os@main`
via jsDelivr. `m1`–`m10`, `site`, and `cdn` are byte-identical mirror copies of the
same app (kept so every previously-shared public link stays alive). `site/` holds the
shared assets the mirrors reference.

## One-click bundle

| What | Link |
|---|---|
| **All fronts in one zip (2.0 MB)** | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/dl/veil-os-fronts.zip |
| SHA-256 checksum | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/dl/veil-os-fronts.zip.sha256 |

The zip contains: root `index.html`/`index.xhtml`, the full `site/` app (minus the
heavy `wp-*` wallpaper media), `cdn/`, and all ten `m1`–`m10` mirrors — 349 files.
Wallpapers are downloadable individually from the links below.

## Per-mirror entry points

Every mirror serves the same pages. Replace `mN` with any of
`m1 m2 m3 m4 m5 m6 m7 m8 m9 m10` (or `site` / `cdn`) in any URL below.

| Page | URL pattern |
|---|---|
| Home | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/index.html |
| Chat | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/chat.html |
| AI | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/ai.html |
| Music | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/music.html |
| Stream | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/stream.html |
| Arcade | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/arcade.html |
| Wallpapers | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/wallpapers.html |
| Links | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/links.html |
| History | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/history.html |
| Updates | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/updates.html |
| Settings | https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/m10/settings.html |

Each also exists as `.xhtml` (XML-strict variant): swap the extension.

## Shared assets (needed by every mirror)

- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/assets/os.js
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/assets/live.js
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/assets/app.css
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/assets/veil.css
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/assets/veil.js
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/assets/icon.svg
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/assets/fonts/ (directory)

## Wallpapers (individual downloads)

- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-apocalyptic.png
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-aluminium.jpg
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-lake.jpg
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-spiderman.jpg
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-jellyfish.jpg
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-cubes.jpg
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-minecraft-bee.png
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-minecraft-blocks.jpg
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-minecraft-earth.mp4
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-cherry-blossom.mp4
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-mobile-video.mp4
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-mobile-video2.mp4
- https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/wp-trionda-ball.mp4

## Version pinning

`@main` always serves the latest push. For an immutable snapshot, pin a commit SHA:
`https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@<sha>/dl/veil-os-fronts.zip`
