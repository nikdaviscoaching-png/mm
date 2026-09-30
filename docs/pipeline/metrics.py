import numpy as np, rasterio, pandas as pd, geopandas as gpd, shapely
from scipy.ndimage import maximum_filter, minimum_filter, uniform_filter
src=rasterio.open('data/dem/dem20.tif');T=src.transform;H,W=src.shape
dem=src.read(1).astype('float32')
di=np.load('work/down.npy')
acc={k:np.load(f'work/acc_{k}.npy').ravel() for k in ['n','contact','contactV','pen','above','cslope']}
slope=np.load('work/slope.npy')
relief=(maximum_filter(dem,size=51)-minimum_filter(dem,size=51))  # ~1 km window (±500 m)
mean400=uniform_filter(dem,size=21)  # ±200 m
slope200=uniform_filter(slope,size=21)
Z=dem.ravel();R=relief.ravel();M=mean400.ravel();S2=slope200.ravel()
cr=pd.read_pickle('work/gcross_cls.pkl')
rules=pd.read_csv('work/rules.csv')
offs=dict(zip(rules.quad,rules.get('renfro_m',pd.Series([np.nan]*len(rules)))))
def cxy(k):
    r,c=divmod(int(k),W);x,y=rasterio.transform.xy(T,r,c);return x,y
recs=[]
for i,row in cr.iterrows():
    k=int(row.k)
    # walk downstream up to 10 km
    path=[k];dist=[0.0];cur=k
    while len(path)<700:
        d=di[cur]
        if d<0: break
        r0,c0=divmod(cur,W);r1,c1=divmod(int(d),W)
        dist.append(dist[-1]+(28.28 if (r0!=r1 and c0!=c1) else 20.0));path.append(int(d));cur=int(d)
        if dist[-1]>10000: break
    path=np.array(path);dist=np.array(dist)
    # upstream metrics: take max over first 3 cells (captures contact cells at crossing)
    kk=path[:3]
    da=acc['n'][path[0]]*400/1e6
    cu=acc['contact'][kk].max()/1000.0;cv=acc['contactV'][kk].max()/1000.0
    n0=acc['n'][path[0]]
    pen=acc['pen'][path[0]]/n0;above=acc['above'][path[0]]/n0
    cs=acc['cslope'][kk].max()/max(acc['contact'][kk].max(),1e-6)
    z0=Z[k]
    zpath=Z[path];dapath=acc['n'][path]*400/1e6
    def at(dm):
        j=np.searchsorted(dist,dm);j=min(j,len(path)-1);return j
    j3=at(300);grad300=(z0-zpath[j3])/max(dist[j3],1)
    j1=at(1000);grad1k=(z0-zpath[j1])/max(dist[j1],1)
    recs.append(dict(i=i,da_km2=da,contact_up_km=cu,contactV_up_km=cv,pen_frac=pen,cap_frac=above,
        contact_slope_deg=cs,z=float(z0),relief_1km=float(R[k]),incision_m=float(M[k]-z0),slope200=float(S2[k]),
        grad300=grad300,grad1k=grad1k,path=path,dist=dist,zpath=zpath,dapath=dapath))
m=pd.DataFrame(recs).set_index('i')
out=cr.drop(columns=['path']).join(m)
out.to_pickle('work/cross_metrics.pkl');print(out[['da_km2','contact_up_km','relief_1km','incision_m','grad300']].describe().to_string())
