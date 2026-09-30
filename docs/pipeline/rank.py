import numpy as np, rasterio, pandas as pd, geopandas as gpd, shapely, json
from shapely.geometry import LineString, Point
src=rasterio.open('data/dem/dem20.tif');T=src.transform;H,W=src.shape
acc={k:np.load(f'work/acc_{k}.npy').ravel() for k in ['n','contact','contactV','pen','cslope']}
nhd=np.load('work/nhdid.npy');fl=gpd.read_parquet('work/fl_all.parquet')
Z=src.read(1).ravel()
d=pd.read_pickle('work/cross_metrics.pkl')
VALID=['VERIFIED','VERIFIED_COMBINED','PROBABLE']
d['valid']=d.cclass.isin(VALID)
to4326=lambda xs,ys: gpd.GeoSeries(gpd.points_from_xy(xs,ys),crs=32616).to_crs(4326)
def cellxy(cells):
    r,c=np.divmod(np.asarray(cells),W);x,y=rasterio.transform.xy(T,r,c);return np.atleast_1d(x),np.atleast_1d(y)
def nhd_at(cell):
    r,c=divmod(int(cell),W)
    w=nhd[max(r-1,0):r+2,max(c-1,0):c+2].ravel();w=w[w>0]
    if len(w)==0: return None
    return int(np.bincount(w).argmax())-1
PRIM=1200.0;EXT=4000.0;BAND=15.0
recs=[]
for i,row in d.iterrows():
    path=row.path;dist=row.dist;zp=row.zpath;dap=row.dapath
    cp=row.pt
    # primary reach end: 1.2 km or before DA exceeds 60 km2 (river)
    jP=int(np.searchsorted(dist,PRIM));jP=min(jP,len(path)-1)
    big=np.flatnonzero(dap>60.0)
    if len(big) and big[0]<jP: jP=max(int(big[0]),1)
    jE=int(np.searchsorted(dist,EXT));jE=min(jE,len(path)-1)
    if len(big) and big[0]<jE: jE=max(int(big[0]),jP)
    # source zone: until z drops BAND m below crossing or 600 m
    z0=zp[0];js=np.flatnonzero((z0-zp)>=BAND);jS=int(js[0]) if len(js) else len(path)-1
    jS=min(jS,int(np.searchsorted(dist,600.0)),len(path)-1);jS=max(jS,1)
    e=path[jP]
    Lend=acc['contact'][e]/1000.0;LVend=acc['contactV'][e]/1000.0;DAend=acc['n'][e]*400/1e6
    pen_end=acc['pen'][e]/acc['n'][e]
    cs_end=acc['cslope'][e]/max(acc['contact'][e],1e-6)
    gradP=(zp[0]-zp[jP])/max(dist[jP],1)
    # names along primary/extended
    names=[];fc=None
    for k in list(range(0,jE+1,3)):
        j=nhd_at(path[k])
        if j is not None:
            nm=fl.gnis_name.values[j]
            if k<=3 and fc is None: fc=int(fl.fcode.values[j]) if fl.fcode.values[j]==fl.fcode.values[j] else None
            if nm and nm==nm and nm not in names: names.append(nm)
    j0=nhd_at(path[0])
    nm0=fl.gnis_name.values[j0] if j0 is not None else None
    if nm0!=nm0: nm0=None
    fc0=int(fl.fcode.values[j0]) if j0 is not None else None
    recs.append(dict(i=i,jP=jP,jE=jE,jS=jS,prim_len_m=float(dist[jP]),ext_len_m=float(dist[jE]),
        L_prim_km=Lend,LV_prim_km=LVend,DA_prim_km2=DAend,pen_prim=pen_end,cslope_prim=cs_end,grad_prim=gradP,
        nhd_name=nm0,nhd_fcode=fc0,downstream_names=names))
m=pd.DataFrame(recs).set_index('i')
d=d.join(m)
d.to_pickle('work/cross_reach.pkl')
print(d[d.valid][['L_prim_km','DA_prim_km2','pen_prim','cslope_prim','grad_prim','prim_len_m']].describe(percentiles=[.1,.5,.9,.97]).round(3).to_string())
