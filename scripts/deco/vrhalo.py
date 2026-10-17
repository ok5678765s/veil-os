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

def keyed(up):
    d = np.abs(up-BG).sum(axis=2)
    a = np.clip((d-25)/30, 0, 1)
    return Image.fromarray(np.concatenate([up, a[...,None]*255], axis=2).astype(np.uint8))

# 1) VR halo = full cell (3,3), 14 frames over the full clip
idx = [min(39, int(k*40/14)) for k in range(14)]
imgs = [keyed(crop_cell(frames[k], 3, 3)) for k in idx]
p = '/home/z/my-project/public/deco-vrhalo.webp'
imgs[0].save(p, save_all=True, append_images=imgs[1:], duration=199, loop=0, lossless=False, quality=88, method=5)
print('vrhalo', os.path.getsize(p)//1024, 'KB')

# 2) full-catalog montage: every fullCell-worn item on a synthetic avatar
S = 150
def avatar():
    av = Image.new('RGBA', (S, S), (0,0,0,0))
    d = ImageDraw.Draw(av)
    d.ellipse([1,1,S-2,S-2], fill=(240,170,120,255))
    d.ellipse([int(S*0.32),int(S*0.30),int(S*0.46),int(S*0.44)], fill=(40,30,30,255))
    d.ellipse([int(S*0.54),int(S*0.30),int(S*0.68),int(S*0.44)], fill=(40,30,30,255))
    d.arc([int(S*0.36),int(S*0.52),int(S*0.64),int(S*0.74)], 20, 160, fill=(120,50,50,255), width=4)
    return av

def fullcell_render(path):
    b = avatar()
    im = Image.open(path).convert('RGBA')
    if getattr(im, 'is_animated', False): im.seek(3)  # a mid-animation frame
    sc = 1.30*S/im.width
    im = im.resize((int(im.width*sc), int(im.height*sc)), Image.LANCZOS)
    b.alpha_composite(im, (int(-0.15*S), int(-0.15*S)))
    return b

names = ['arch','clover','visor','dragon','owl','seal','fur','cyber','fight','stars',
         'sword','batring','orb','wreath','potion','y2025','santa','snowglobe',
         'lightning','owlord','vrhalo','wolf','bunny','sprout','blackcat']
COLSN = 6
rows = (len(names)+COLSN-1)//COLSN
M = Image.new('RGB', (COLSN*(S+8)+8, rows*(S+24)+8), (24,28,34))
dr = ImageDraw.Draw(M)
for i, n in enumerate(names):
    path = f'/home/z/my-project/public/deco-{n}.webp' if n!='seal' else '/home/z/my-project/public/deco-seal.png'
    try:
        b = fullcell_render(path)
        r, c = divmod(i, COLSN)
        M.paste(b, (8+c*(S+8), 8+r*(S+24)), b)
        dr.text((8+c*(S+8)+4, 8+r*(S+24)+S+4), n, fill=(200,200,200))
    except Exception as e:
        print('ERR', n, e)
M.save('/tmp/decofix/montage_final.png')
print('montage saved', M.size)
