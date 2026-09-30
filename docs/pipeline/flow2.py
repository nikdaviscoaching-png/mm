import numpy as _np
if not hasattr(_np,"in1d"): _np.in1d=_np.isin
import numpy as np, rasterio, geopandas as gpd, pandas as pd
from rasterio.features import rasterize
from pysheds.grid import Grid
grid=Grid.from_raster('work/dem20b.tif');r=grid.read_raster('work/dem20b.tif')
f=grid.resolve_flats(grid.fill_depressions(grid.fill_pits(r)))
dirmap=(64,128,1,2,4,8,16,32)
fd=grid.flowdir(f,dirmap=dirmap)
import pickle
src=rasterio.open('data/dem/dem20.tif');T=src.transform;S=src.shape
segs=gpd.read_parquet('work/segs.parquet')
rules=pd.read_csv('work/rules.csv')
key=dict(((a,b,c),d) for a,b,c,d in zip(rules.quad,rules.line_symbol,rules.pair,rules.contact_class))
segs['cclass']=[key.get((q,s,p),'') for q,s,p in zip(segs.quadrangle_name,segs.map_symbol,segs.pair)]
segs[segs.cclass!=''].to_parquet('work/target_segs.parquet')
t=segs[segs.cclass.isin(['VERIFIED','VERIFIED_COMBINED','PROBABLE'])]
print(t.groupby('cclass').len.sum()/1000)
wC=rasterize(((g,l) for g,l in zip(t.geometry,t.len)),out_shape=S,transform=T,fill=0,dtype='float32',merge_alg=rasterio.enums.MergeAlg.add)
tv=t[t.cclass!='PROBABLE']
wV=rasterize(((g,l) for g,l in zip(tv.geometry,tv.len)),out_shape=S,transform=T,fill=0,dtype='float32',merge_alg=rasterio.enums.MergeAlg.add)
pen=np.load('work/pen.npy').astype('float32');cls=np.load('work/cls.npy')
dem=src.read(1)
# slope (degrees)
gy,gx=np.gradient(dem.astype('float64'),20.0);slope=np.degrees(np.arctan(np.hypot(gx,gy))).astype('float32')
np.save('work/slope.npy',slope)
out={}
def acc(w,name):
    R=grid.view(fd);ww=grid.view(fd).copy();ww[:]=w
    a=grid.accumulation(fd,dirmap=dirmap,weights=ww);out[name]=np.asarray(a).astype('float32')
acc(np.ones(S,'float32'),'n')
acc(wC,'contact')
acc(wV,'contactV')
acc(pen,'pen')
acc((cls==1).astype('float32'),'above')
acc(wC*slope,'cslope')
for k,v in out.items(): np.save(f'work/acc_{k}.npy',v)
np.save('work/fdir.npy',np.asarray(fd).astype(np.int16))
print('ok',{k:float(v.max()) for k,v in out.items()})
