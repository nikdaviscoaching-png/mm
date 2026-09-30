import numpy as np, rasterio, geopandas as gpd, pandas as pd
from rasterio.features import rasterize
src=rasterio.open('data/dem/dem20.tif');T=src.transform;S=src.shape
u=gpd.read_parquet('work/units.parquet')
ABOVE=set('Msla Mslu Msg Msb Mbr Mbru Mbrl Mp Mpsl Msl Mba Mha Mbha Mmg Mmk Msw'.split())
BELOW=set('Mb Mbu Mbc Mbn Mbnf Mbf Mbm Mfp MDna MDc MDsb Msu'.split())
def cls(s):
    s=s or ''
    if s in ABOVE or (s.startswith('P') and len(s)>1): return 1
    if s=='Mbrn': return 3
    if s in BELOW or (s[:1] in 'DSO' and s!='Dump'): return 2
    return 0
u['k']=u.map_symbol.map(cls)
# also a Pennsylvanian flag (clastic diluent)
g=rasterize(((geom,int(k)) for geom,k in zip(u.geometry,u.k) if k>0),out_shape=S,transform=T,fill=0,dtype='uint8')
pen=rasterize(((geom,1) for geom,s in zip(u.geometry,u.map_symbol) if (s or '').startswith('P')),out_shape=S,transform=T,fill=0,dtype='uint8')
np.save('work/cls.npy',g);np.save('work/pen.npy',pen)
# symbol id grid
syms=sorted(set(u.map_symbol.fillna('')));sid={s:i+1 for i,s in enumerate(syms)}
sg=rasterize(((geom,sid[s or '']) for geom,s in zip(u.geometry,u.map_symbol.fillna(''))),out_shape=S,transform=T,fill=0,dtype='uint16')
np.save('work/symgrid.npy',sg);pd.Series(syms,index=range(1,len(syms)+1)).to_csv('work/symids.csv')
print(np.bincount(g.ravel()))
