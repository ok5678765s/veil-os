#!/usr/bin/env python3
"""Split the 4-in-1 cell (r3c3) into its four pieces (animated), and
trim the companion cells to content. Reports the in-cell geometry each
piece occupies so the CSS registry can place them correctly
(cell % -> CSS % via the 130% frame: css = 1.3*cell - 15)."""
from PIL import Image
import numpy as np
import glob, os, json

VIDEO_FRAMES = sorted(glob.glob('/tmp/decofix/frames/f*.png'))
OUT = '/home/z/my-project/public'
BG = np.array([26, 31, 37], dtype=np.float32)
OUT_SIZE = 300
COLS = [(14, 99), (114, 197), (214, 297), (313, 397), (414, 495)]
ROWS = [(10, 93), (112, 197), (211, 294), (315, 395), (412, 493)]

frames = [np.asarray(Image.open(f).convert('RGB')).astype(np.float32) for f in VIDEO_FRAMES]

def crop_cell(frame, r, c):
    y0, y1 = ROWS[r]; x0, x1 = COLS[c]
    crop = frame[y0:y1 + 1, x0:x1 + 1]
    return np.asarray(Image.fromarray(crop.astype(np.uint8))
                      .resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)).astype(np.float32)

def key_alpha(up):
    d = np.abs(up - BG).sum(axis=2)
    return np.clip((d - 25.0) / (55.0 - 25.0), 0.0, 1.0)

def keyed(up):
    a = key_alpha(up)[..., None]
    return Image.fromarray(np.concatenate([up, a * 255], axis=2).astype(np.uint8))

def union_bbox(alphas, x0, x1, y0, y1):
    """union of content (alpha>0.35) within cell-fraction box, across frames"""
    X0, X1 = int(x0 * OUT_SIZE), int(x1 * OUT_SIZE)
    Y0, Y1 = int(y0 * OUT_SIZE), int(y1 * OUT_SIZE)
    ys, xs, ys2, xs2 = [], [], [], []
    for a in alphas:
        sub = a[Y0:Y1, X0:X1]
        yy, xx = np.where(sub > 0.35)
        if len(yy):
            ys.append(yy.min() + Y0); ys2.append(yy.max() + Y0)
            xs.append(xx.min() + X0); xs2.append(xx.max() + X0)
    if not ys:
        return None
    return (min(xs), min(ys), max(xs2) + 1, max(ys2) + 1)

def save_piece(name, cell_frames, bbox, dur_ms, n=14):
    x0, y0, x1, y1 = bbox
    imgs = []
    for up in cell_frames:
        im = keyed(up).crop((x0, y0, x1, y1))
        imgs.append(im)
    p = f'{OUT}/deco-{name}.webp'
    imgs[0].save(p, save_all=True, append_images=imgs[1:], duration=dur_ms,
                 loop=0, lossless=False, quality=88, method=5)
    return p

report = {}

# ---- the 4-in-1 cell (r3c3): quadrant segmentation --------------------
r, c = 3, 3
cell_frames = [crop_cell(f, r, c) for f in frames]
alphas = [key_alpha(u) for u in cell_frames]
# quadrants in cell fractions (empty center means pieces never cross)
quads = {
    'earL':  (0.00, 0.50, 0.00, 0.42),
    'earR':  (0.50, 1.00, 0.00, 0.42),
    'contrL': (0.00, 0.50, 0.42, 1.00),
    'contrR': (0.50, 1.00, 0.42, 1.00),
}
for name, (x0, x1, y0, y1) in quads.items():
    bb = union_bbox(alphas, x0, x1, y0, y1)
    if bb is None:
        print(f'{name}: EMPTY'); continue
    bb = tuple(int(v) for v in bb)
    p = save_piece(name, cell_frames, bb, 199)
    cx0, cy0, cx1, cy1 = [v / OUT_SIZE for v in bb]
    report[name] = {
        'file': p, 'bbox_px': bb,
        'cell_pct': [round(cx0 * 100, 1), round(cy0 * 100, 1),
                     round(cx1 * 100, 1), round(cy1 * 100, 1)],
        'css_pct': [round(1.3 * cx0 * 100 - 15, 1), round(1.3 * cy0 * 100 - 15, 1),
                    round(1.3 * cx1 * 100 - 15, 1), round(1.3 * cy1 * 100 - 15, 1)],
        'size': os.path.getsize(p),
    }
    print(f"{name:7s} bbox={bb} cell%={report[name]['cell_pct']} css%={report[name]['css_pct']} "
          f"({os.path.getsize(p)//1024}KB)")

# ---- companions: trim to union bbox across frames ---------------------
companions = {'wolf': (3, 4), 'bunny': (1, 0), 'sprout': (0, 1), 'blackcat': (2, 0)}
for name, (r, c) in companions.items():
    cell_frames = [crop_cell(f, r, c) for f in frames]
    alphas = [key_alpha(u) for u in cell_frames]
    bb = union_bbox(alphas, 0, 1, 0, 1)
    bb = tuple(int(v) for v in bb)
    p = save_piece(name if name == 'blackcat' else name + 'full', cell_frames, bb, 199)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    report[name] = {'file': p, 'bbox_px': bb, 'trim_size': [w, h], 'size': os.path.getsize(p)}
    print(f"{name:8s} trimmed to {w}x{h} at {bb[:2]} ({os.path.getsize(p)//1024}KB)")

json.dump(report, open('/tmp/decofix/pieces_report.json', 'w'), indent=1)
print('\nreport saved')
