from PIL import Image, ImageDraw

S = 150
def avatar():
    av = Image.new('RGBA', (S, S), (0,0,0,0))
    d = ImageDraw.Draw(av)
    d.ellipse([1,1,S-2,S-2], fill=(240,170,120,255))
    d.ellipse([int(S*0.32),int(S*0.30),int(S*0.46),int(S*0.44)], fill=(40,30,30,255))
    d.ellipse([int(S*0.54),int(S*0.30),int(S*0.68),int(S*0.44)], fill=(40,30,30,255))
    d.arc([int(S*0.36),int(S*0.52),int(S*0.64),int(S*0.74)], 20, 160, fill=(120,50,50,255), width=4)
    return av

def render(path, top, left, w):
    box = avatar()
    im = Image.open(path).convert('RGBA')
    if getattr(im, 'is_animated', False): im.seek(0)
    wpx = w/100*S
    sc = wpx/im.width
    im = im.resize((max(1,int(im.width*sc)), max(1,int(im.height*sc))), Image.LANCZOS)
    box.alpha_composite(im, (int(left/100*S), int(top/100*S)))
    return box

# quadrant piece CSS positions from the pieces.py report:
# earL  cell% [5.0,0.0,50.0,42.0] -> css [-8.5,-15.0,50.0,39.6]
# earR  cell% [50.0,0.0,95.3,42.0] -> css [50.0,-15.0,108.9,39.6]
# contrL cell% [0.0,42.0,50.0,100.0] -> css [-15.0,39.6,50.0,115.0]
# contrR cell% [50.0,42.0,100.0,100.0] -> css [50.0,39.6,115.0,115.0]
items = [
    ('earL',  '/home/z/my-project/public/deco-earL.webp',  -15.0,  -8.5,  58.5),
    ('earR',  '/home/z/my-project/public/deco-earR.webp',  -15.0,  50.0,  58.9),
    ('contrL','/home/z/my-project/public/deco-contrL.webp', 39.6, -15.0,  65.0),
    ('contrR','/home/z/my-project/public/deco-contrR.webp', 39.6,  50.0,  65.0),
    ('full',  '/home/z/my-project/public/deco-santa.webp',   -15,   -15,  130),  # placeholder fullCell example
]
# also render the FULL 4-in-1 cell as fullCell for comparison — use frame 30 of the cell
import numpy as np, glob
files = sorted(glob.glob('/tmp/decofix/frames/f*.png'))
fr = np.asarray(Image.open(files[30]).convert('RGB')).astype(np.float32)
ROWS = [(10,93),(112,197),(211,294),(315,395),(412,493)]
COLS = [(14,99),(114,197),(214,297),(313,397),(414,495)]
y0,y1 = ROWS[3]; x0,x1 = COLS[3]
crop = fr[y0:y1+1, x0:x1+1]
up = np.asarray(Image.fromarray(crop.astype(np.uint8)).resize((300,300), Image.LANCZOS)).astype(np.float32)
d = np.abs(up - np.array([26,31,37],dtype=np.float32)).sum(axis=2)
a = np.clip((d-25)/30, 0, 1)
cellimg = Image.fromarray(np.concatenate([up, a[...,None]*255], axis=2).astype(np.uint8))
cellimg.save('/tmp/decofix/cell33_new.png')

M = Image.new('RGB', (6*(S+10)+10, S+40), (24,28,34))
dr = ImageDraw.Draw(M)
for i,(name, path, top, left, w) in enumerate(items[:4]):
    b = render(path, top, left, w)
    M.paste(b, (10+i*(S+10), 10), b)
    dr.text((10+i*(S+10)+10, S+16), name, fill=(220,220,220))
# full cell as 5th
b = avatar()
im = cellimg
wpx = 1.30*S
sc = wpx/im.width
im2 = im.resize((int(im.width*sc), int(im.height*sc)), Image.LANCZOS)
b.alpha_composite(im2, (int(-0.15*S), int(-0.15*S)))
M.paste(b, (10+4*(S+10), 10), b)
dr.text((10+4*(S+10)+10, S+16), 'FULL-CELL', fill=(220,220,220))
M.save('/tmp/decofix/montage_split.png')
print('saved', M.size)
