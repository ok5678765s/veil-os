#!/usr/bin/env python3
"""Re-extract avatar decorations from the owner's picker-grid video.

Fixes vs the previous round:
  1. CORRECT cell geometry — cells are ~84px content bands between the
     flat-background gutters (the previous round used a uniform 100.4px
     grid, which shifted every decoration ~5% right/down on the avatar).
  2. ANIMATED output — each cell's animation loop is detected and
     exported as an animated WebP (the source mp4 has live animations).
  3. The 4-in-1 cell (r3c3) is split into its four pieces, each keeping
     its true in-cell position (mapped through the 130% frame) so each
     piece sits on its own side of the avatar.
  4. A new item joins the catalog: the black cat companion (cell r2c0).

Usage: python3 extract.py
"""
from PIL import Image
import numpy as np
import glob, os, json

VIDEO_FRAMES = sorted(glob.glob('/tmp/decofix/frames/f*.png'))
OUT = '/home/z/my-project/public'
BG = np.array([26, 31, 37], dtype=np.float32)
OUT_SIZE = 300          # matches previous extraction scale
N_FRAMES = 14           # frames per animation loop

# true content bands (from gutter analysis of the flat background)
COLS = [(14, 99), (114, 197), (214, 297), (313, 397), (414, 495)]
ROWS = [(10, 93), (112, 197), (211, 294), (315, 395), (412, 493)]

# cell -> decoration id
CELLS = {
    (0, 0): 'arch', (0, 1): 'sprout', (0, 2): 'clover', (0, 3): 'visor', (0, 4): 'dragon',
    (1, 0): 'bunny', (1, 1): 'owl', (1, 2): 'seal', (1, 3): 'fur', (1, 4): 'cyber',
    (2, 0): 'blackcat', (2, 1): 'fight', (2, 2): 'stars', (2, 3): 'sword', (2, 4): 'batring',
    (3, 0): 'orb', (3, 1): 'wreath', (3, 2): 'potion', (3, 3): 'split', (3, 4): 'wolf',
    (4, 0): 'y2025', (4, 1): 'santa', (4, 2): 'snowglobe', (4, 3): 'lightning', (4, 4): 'owlord',
}

def load_frames():
    return [np.asarray(Image.open(f).convert('RGB')).astype(np.float32)
            for f in VIDEO_FRAMES]

def bg_key(up):
    """soft color-distance ramp to the flat background -> alpha 0..1"""
    d = np.abs(up - BG).sum(axis=2)
    return np.clip((d - 25.0) / (55.0 - 25.0), 0.0, 1.0)

def crop_cell(frame, r, c):
    y0, y1 = ROWS[r]; x0, x1 = COLS[c]
    crop = frame[y0:y1 + 1, x0:x1 + 1]
    return np.asarray(Image.fromarray(crop.astype(np.uint8))
                      .resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)).astype(np.float32)

def loop_window(frames, r, c):
    """Find (i, j): the loop cut for this cell's animation.

    Endpoint matching alone is fooled by flash/ramp effects (a dark
    phase matches another dark phase and hides the bright phase
    entirely — lightning exported as an empty 2KB file). So a detected
    window is only trusted when it covers >= 40% of the clip AND its
    mean art fill is at least 55% of the clip's max — otherwise we
    export the full clip and let the effect restart on loop."""
    T = len(frames)
    crops = [crop_cell(f, r, c) for f in frames]
    small = [c[::4, ::4].ravel() for c in crops]
    BGs = np.abs(BG).sum()
    fills = [(np.abs(c - BG).sum(axis=2) > 60).mean() for c in crops]
    det = (0, T - 1)
    found = False
    for span in range(T - 1, 2, -1):
        thresh = 2.0 + 0.5 * (span / T)
        for i in range(0, T - span):
            j = i + span
            if np.abs(small[i] - small[j]).mean() < thresh:
                det = (i, j); found = True; break
        if found: break
    if not found:
        return (0, T - 1)
    i, j = det
    span = j - i
    mean_fill = np.mean(fills[i:j + 1])
    max_fill = max(np.mean(fills[k:k + span]) for k in range(0, T - span, max(1, span // 4)))
    if span < 0.4 * T or mean_fill < 0.55 * max_fill:
        return (0, T - 1)
    return det

def sample_idx(i, j, n):
    """n frame indices evenly across [i, j) — the loop replays j->i."""
    if j - i <= n:
        return list(range(i, j)) or [i]
    step = (j - i) / n
    return [min(j - 1, int(i + k * step)) for k in range(n)]

def keyed_frame(up):
    a = bg_key(up)[..., None]
    out = np.concatenate([up, a * 255], axis=2)
    return Image.fromarray(out.astype(np.uint8), 'RGBA')

def save_anim(name, frames_rgba, duration_ms):
    p = f'{OUT}/deco-{name}.webp'
    frames_rgba[0].save(p, save_all=True, append_images=frames_rgba[1:],
                        duration=duration_ms, loop=0, lossless=False,
                        quality=88, method=5)
    return p

def save_static(name, rgba):
    p = f'{OUT}/deco-{name}.png'
    rgba.save(p)
    return p

def main():
    frames = load_frames()
    T = len(frames)
    report = {}
    for (r, c), name in CELLS.items():
        # temporal deviation -> static or animated?
        samp = frames[::4]
        crops = [crop_cell(f, r, c) for f in samp]
        med = np.median(np.stack(crops), axis=0)
        dev = np.abs(np.stack(crops) - med).mean()
        i, j = loop_window(frames, r, c)
        idx = sample_idx(i, j, N_FRAMES)
        dur = round((j - i) / 14.0 * 1000 / len(idx))
        dur = max(80, min(400, dur))
        if name == 'split':
            report['split'] = {'window': [int(i), int(j)], 'dev': float(dev)}
            continue
        if dev < 0.6:  # static art — single PNG
            img = keyed_frame(crop_cell(frames[i], r, c))
            p = save_static(name, img)
            report[name] = {'file': p, 'kind': 'static', 'dev': float(dev), 'size': os.path.getsize(p)}
            print(f'{name:10s} STATIC  dev={dev:.2f} -> {p} ({os.path.getsize(p)//1024}KB)')
            continue
        frs = [keyed_frame(crop_cell(frames[k], r, c)) for k in idx]
        p = save_anim(name, frs, dur)
        report[name] = {'file': p, 'kind': 'anim', 'frames': len(idx), 'dur': dur,
                        'window': [int(i), int(j)], 'dev': float(dev), 'size': os.path.getsize(p)}
        print(f'{name:10s} ANIM    dev={dev:4.1f} window={i}->{j} ({(j-i)/14:.2f}s) {len(idx)}f@{dur}ms '
              f'-> {p} ({os.path.getsize(p)//1024}KB)')
    json.dump(report, open('/tmp/decofix/extract_report.json', 'w'), indent=1)
    print('\nreport saved')

if __name__ == '__main__':
    main()
