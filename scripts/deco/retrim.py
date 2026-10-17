from PIL import Image, ImageDraw
import numpy as np, glob, os

files = sorted(glob.glob('/tmp/decofix/frames/f*.png'))
frames = [np.asarray(Image.open(f).convert('RGB')).astype(np.float32) for f in files]
BG = np.array([26,31,37], dtype=np.float32)
ROWS = [(10,93),(112,197),(211,294),(315,395),(412,493)]
COLS = [(14,99),(114,197),(214,297),(313,397),(414,495)]

def crop_cell(f, r, c):
    y0,y1 = ROWS[r]; x0,x1 = COLS[c]
    cr = f[y0:y1+1, x0:x1+1]
    return np.asarray(Image.fromarray(cr.astype(np.uint8)).resize((300,300), Image.LANCZOS)).astype(np.float32)

def alpha_of(up):
    d = np.abs(up-BG).sum(axis=2)
    return np.clip((d-25)/30, 0, 1)

def keyed(up):
    a = alpha_of(up)[...,None]
    return Image.fromarray(np.concatenate([up, a*255], axis=2).astype(np.uint8))

# 1) re-trim companions with union alpha > 0.62 (excludes faint glow haze)
for name, (r,c) in {'wolf':(3,4),'bunny':(1,0),'sprout':(0,1),'blackcat':(2,0)}.items():
    crops = [crop_cell(f, r, c) for f in frames]
    union = np.max([alpha_of(u) for u in crops], axis=0)
    mask = union > 0.62
    ys, xs = np.where(mask)
    x0,y0,x1,y1 = xs.min(), ys.min(), xs.max()+1, ys.max()+1
    idx = [min(39, int(k*40/14)) for k in range(14)]
    imgs = [keyed(crops[k]).crop((x0,y0,x1,y1)) for k in idx]
    out = f'/home/z/my-project/public/deco-{name}{"full" if name!="blackcat" else ""}.webp'
    imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=199, loop=0, lossless=False, quality=88, method=5)
    print(f'{name:9s} trim {x1-x0}x{y1-y0} at ({x0},{y0}) -> {out} {os.path.getsize(out)//1024}KB')

# 2) focused montage: flagged items at a BRIGHT frame (frame 35) + companions with manual positions
S = 170
def avatar():
    av = Image.new('RGBA', (S,S), (0,0,0,0))
    d = ImageDraw.Draw(av)
    d.ellipse([1,1,S-2,S-2], fill=(240,170,120,255))
    d.ellipse([int(S*0.32),int(S*0.30),int(S*0.46),int(S*0.44)], fill=(40,30,30,255))
    d.ellipse([int(S*0.54),int(S*0.30),int(S*0.68),int(S*0.44)], fill=(40,30,30,255))
    d.arc([int(S*0.36),int(S*0.52),int(S*0.64),int(S*0.74)], 20, 160, fill=(120,50,50,255), width=4)
    return av

def place(path, top, left, w, seek=None):
    b = avatar()
    im = Image.open(path).convert('RGBA')
    if getattr(im, 'is_animated', False):
        im.seek(seek if seek is not None else (im.n_frames-1)//2)
    wpx = w/100*S
    sc = wpx/im.width
    im = im.resize((max(1,int(im.width*sc)), max(1,int(im.height*sc))), Image.LANCZOS)
    b.alpha_composite(im, (int(left/100*S), int(top/100*S)))
    return b

def cellrender(r, c, fidx):
    up = crop_cell(frames[fidx], r, c)
    b = avatar()
    im = keyed(up)
    sc = 1.30*S/im.width
    im = im.resize((int(im.width*sc), int(im.height*sc)), Image.LANCZOS)
    b.alpha_composite(im, (int(-0.15*S), int(-0.15*S)))
    return b

items = [
    ('owl@f35',   cellrender(1,1,35)),
    ('sword@f35', cellrender(2,3,35)),
    ('batring@f35', cellrender(2,4,35)),
    ('cyber@f35', cellrender(1,4,35)),
    ('vrhalo@f35', cellrender(3,3,35)),
    ('wolf',  place('/home/z/my-project/public/deco-wolffull.webp', 26, 7.2, 85.6)),
    ('bunny', place('/home/z/my-project/public/deco-bunnyfull.webp', 31, 37.1, 25.8)),
    ('sprout',place('/home/z/my-project/public/deco-sproutfull.webp', 18, 21.2, 57.5)),
    ('blackcat', place('/home/z/my-project/public/deco-blackcat.webp', 30, 8, 40)),
]
COLSN = 5
rows = (len(items)+COLSN-1)//COLSN
M = Image.new('RGB', (COLSN*(S+8)+8, rows*(S+24)+8), (24,28,34))
dr = ImageDraw.Draw(M)
for i,(n,b) in enumerate(items):
    r,c = divmod(i, COLSN)
    M.paste(b, (8+c*(S+8), 8+r*(S+24)), b)
    dr.text((8+c*(S+8)+4, 8+r*(S+24)+S+4), n, fill=(200,200,200))
M.save('/tmp/decofix/montage_focus.png')
print('montage saved', M.size)
