from PIL import Image
import numpy as np, glob

files = sorted(glob.glob('/tmp/decofix/frames/f*.png'))
frames = [np.asarray(Image.open(f).convert('RGB')).astype(np.float32) for f in files]
BG = np.array([26,31,37], dtype=np.float32)
ROWS = [(10,93),(112,197),(211,294),(315,395),(412,493)]
COLS = [(14,99),(114,197),(214,297),(313,397),(414,495)]

def crop(f):
    y0,y1 = ROWS[3]; x0,x1 = COLS[3]
    c = f[y0:y1+1, x0:x1+1]
    return np.asarray(Image.fromarray(c.astype(np.uint8)).resize((300,300), Image.LANCZOS)).astype(np.float32)

cells = [crop(f) for f in frames]
dists = [np.abs(c-BG).sum(axis=2) for c in cells]

# union masks at several hard thresholds
for TH in [60, 100, 140, 180]:
    union = np.zeros((300,300), bool)
    for d in dists:
        union |= (d > TH)
    # radial profile around center 150,150
    yy, xx = np.mgrid[0:300, 0:300]
    rr = np.sqrt((xx-150)**2 + (yy-150)**2)
    prof = []
    for r0 in range(0, 150, 10):
        band = (rr >= r0) & (rr < r0+10)
        prof.append(f"r{r0:3d}:{union[band].mean():.2f}")
    # quadrant bboxes of content
    print(f"--- TH={TH} fill={union.mean():.3f}")
    print("   radial:", " ".join(prof))
    quads = {'earL':(0,150,0,130),'earR':(150,300,0,130),'contrL':(0,150,130,300),'contrR':(150,300,130,300)}
    for n,(xa,xb,ya,yb) in quads.items():
        sub = union[ya:yb, xa:xb]
        ys, xs = np.where(sub)
        if len(ys)==0:
            print(f"   {n}: EMPTY")
        else:
            print(f"   {n}: bbox=({xs.min()+xa},{ys.min()+ya})-({xs.max()+xa},{ys.max()+ya}) area={len(ys)}")

# brightness histogram of the ring band vs pieces at one frame
d = dists[30]
yy, xx = np.mgrid[0:300, 0:300]
rr = np.sqrt((xx-150)**2 + (yy-150)**2)
ring = d[(rr>100)&(rr<140)&(d>25)]
pieces = d[(rr<=100)&(d>25)]
print("ring band dist percentiles:", np.percentile(ring,[25,50,75,90]).round(0) if len(ring) else "none", "n=",len(ring))
print("inner   dist percentiles:", np.percentile(pieces,[25,50,75,90]).round(0) if len(pieces) else "none", "n=",len(pieces))
