import numpy as np, pandas as pd, geopandas as gpd, shapely
from shapely.geometry import Point
d=pd.read_pickle('work/cross_reach.pkl')
v=d[d.valid].copy()
area=gpd.read_file('data/raw/kgs_agate_area.geojson').to_crs(32616).geometry.iloc[0]
v['x']=[p.x for p in v.pt];v['y']=[p.y for p in v.pt]
v['dist_outline_km']=[0.0 if area.contains(Point(x,y)) else area.exterior.distance(Point(x,y))/1000 for x,y in zip(v.x,v.y)]
clip=lambda a: np.clip(a,0,1)
v['S']=clip(np.log1p(v.L_prim_km)/np.log1p(40))
dens=v.L_prim_km/v.DA_prim_km2
v['density_km_per_km2']=dens
size=np.where(v.DA_prim_km2<=25,1.0,np.clip(1-0.6*np.log10(v.DA_prim_km2/25)/np.log10(8),0.4,1))
v['D']=clip(dens/6)*(1-0.35*v.pen_prim)*size
v['E']=clip((v.cslope_prim-12)/20)
v['I']=0.5*clip((v.relief_1km-80)/140)+0.5*clip(v.incision_m/40)
g=v.grad_prim
v['T']=np.select([g<0.003,g<=0.04,g<=0.12],[0.5,1.0,1-0.6*(g-0.04)/0.08],0.4)
r=v.dist_outline_km
v['R']=np.select([r==0,r<=5,r<=15],[1.0,0.75,0.5],0.3)
v['G']=v.cclass.map({'VERIFIED':1.0,'VERIFIED_COMBINED':0.95,'PROBABLE':0.85})
Wt=dict(S=.25,D=.20,E=.10,I=.15,T=.10,R=.20)
v['score']=100*v.G*sum(v[k]*w for k,w in Wt.items())
v=v.sort_values('score',ascending=False)
used={};usedP={};acc_xy={};rank=0;ranks=[];share=[]
for i,row in v.iterrows():
    cells=row.path[:row.jP+1];ecells=row.path[:row.jE+1]
    ov=[used[c] for c in cells if c in used]
    frac=len(ov)/max(len(cells),1)
    ovE=[usedP[c] for c in ecells if c in usedP]
    near=False;k0=None
    for kk in set(ov+ovE):
        px,py=acc_xy[kk]
        if ((row.x-px)**2+(row.y-py)**2)**0.5<2000: near=True;k0=kk;break
    if frac<0.40 and not near:
        rank+=1;ranks.append(rank);share.append(None);acc_xy[rank]=(row.x,row.y)
        for c in ecells: used.setdefault(c,rank)
        for c in cells: usedP.setdefault(c,rank)
    else:
        ranks.append(None);share.append(k0 if k0 is not None else pd.Series(ov).mode().iloc[0])
v['rank']=ranks;v['shares_reach_with_rank']=share
def tier(rk):
    if rk!=rk or rk is None: return 'VALID LOWER-PRIORITY CROSSING'
    if rk<=10: return 'TOP PRIORITY'
    if rk<=40: return 'STRONG TARGET'
    if rk<=120: return 'MODERATE TARGET'
    return 'VALID LOWER-PRIORITY CROSSING'
v['priority']=[tier(x) for x in v['rank']]
v.to_pickle('work/scored.pkl')
pd.set_option('display.width',250,'display.max_rows',80)
print(v[v['rank'].notna()].head(45)[['rank','score','quadrangle_name','cclass','nhd_name','downstream_names','L_prim_km','DA_prim_km2','density_km_per_km2','relief_1km','incision_m','grad_prim','dist_outline_km']].round(2).to_string())
print(v.priority.value_counts())
