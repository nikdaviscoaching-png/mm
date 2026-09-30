import numpy as np, rasterio, pandas as pd, geopandas as gpd, shapely
src=rasterio.open('data/dem/dem20.tif');T=src.transform;H,W=src.shape
cr=pd.read_pickle('work/gcross.pkl');di=np.load('work/down.npy')
cr=cr[cr.kind=='AB'].reset_index(drop=True)
def xy(k):
    r,c=np.divmod(k,W);x,y=rasterio.transform.xy(T,r,c);return np.array(x),np.array(y)
cr['xa'],cr['ya']=xy(cr.ka.values);cr['xb'],cr['yb']=xy(cr.k.values)
# path between ka and k
paths=[]
for ka,k in zip(cr.ka,cr.k):
    p=[ka];n=0
    while p[-1]!=k and n<2000: p.append(di[p[-1]]);n+=1
    paths.append(p)
cr['path']=paths
segs=gpd.read_parquet('work/segs.parquet')
B='Mb Mbu Mbc Mbn Mbnf Mbf Mbm Mbh Mbrn'.split();A='Msla Mslu Msg Msb Mbr Mbru Mbrl Mp Mpsl Msl Msw'.split()
def isbt(p):
    x,y=(p.split('|')+[''])[:2]
    return (x in B and (y in A or y.startswith('P'))) or (y in B and (x in A or x.startswith('P')))
bt=segs[segs.pair.map(isbt)].reset_index(drop=True)
rules=pd.read_csv('work/rules.csv')
key=dict(((a,b,c),(d,e)) for a,b,c,d,e in zip(rules.quad,rules.line_symbol,rules.pair,rules.contact_class,rules.interpreted_meaning))
def rule(q,s,p):
    if (q,s,p) in key: return key[(q,s,p)]
    return ('UNRESOLVED','')
bt['cclass']=[rule(q,s,p)[0] for q,s,p in zip(bt.quadrangle_name,bt.map_symbol,bt.pair)]
bt.to_parquet('work/bt_segs.parquet')
tree=shapely.STRtree(bt.geometry.values)
lines=[]
for p in paths:
    r,c=np.divmod(np.array(p),W);x,y=rasterio.transform.xy(T,r,c)
    x=np.atleast_1d(x);y=np.atleast_1d(y)
    lines.append(shapely.linestrings(np.c_[x,y]) if len(x)>1 else shapely.Point(x[0],y[0]).buffer(1).exterior)
cr['pathgeom']=lines
near=tree.query_nearest(lines,max_distance=150,return_distance=True,all_matches=False)
(ii,jj),dd=near
cr['seg']=-1;cr['segdist']=np.nan
cr.loc[ii,'seg']=jj;cr.loc[ii,'segdist']=dd
ok=cr.seg>=0
for k in ['quadrangle_name','map_symbol','pair','cclass','contact_style','gq_number','county_name']:
    cr[k]=None;cr.loc[ok,k]=bt[k].values[cr.seg[ok]]
cr.loc[~ok,'cclass']='NO_MAPPED_CONTACT_NEAR'
# crossing point: intersection of path with segment's line, else nearest point on path to segment
pts=[]
for p,s in zip(cr.pathgeom,cr.seg):
    if s<0: pts.append(shapely.line_interpolate_point(p,0.5,normalized=True));continue
    g=bt.geometry.values[s]
    x=shapely.intersection(p,g)
    if not x.is_empty: pts.append(shapely.get_point(shapely.get_parts(x)[0],0) if x.geom_type!='Point' else x)
    else: pts.append(shapely.ops.nearest_points(p,g)[0])
cr['pt']=pts
cr.drop(columns=['pathgeom']).to_pickle('work/gcross_cls.pkl')
pd.set_option('display.width',200,'display.max_rows',200)
print(cr.groupby(['quadrangle_name','map_symbol','cclass'],dropna=False).size().to_string())
print(cr.cclass.value_counts(dropna=False))
