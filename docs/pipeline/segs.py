import geopandas as gpd, numpy as np, pandas as pd, shapely
c=gpd.read_parquet('work/contacts.parquet');u=gpd.read_parquet('work/units.parquet')
c=c[(c.contact_style!='FAULT_CONTACT')&c.map_symbol.fillna('').str.startswith('M')].explode(index_parts=False).reset_index(drop=True)
g=shapely.segmentize(c.geometry.values,40.0)
co,idx=shapely.get_coordinates(g,return_index=True)
same=idx[1:]==idx[:-1]
a=co[:-1][same];b=co[1:][same];ci=idx[:-1][same]
segs=shapely.linestrings(np.stack([a,b],1))
s=gpd.GeoDataFrame({'ci':ci},geometry=segs,crs=c.crs)
for k in ['map_symbol','contact_style','quadrangle_name','gq_number','county_name','contact_comments']: s[k]=c[k].values[ci]
mx=(a[:,0]+b[:,0])/2;my=(a[:,1]+b[:,1])/2
dx=b[:,0]-a[:,0];dy=b[:,1]-a[:,1];nn=np.hypot(dx,dy)+1e-9;nx=-dy/nn;ny=dx/nn
tree=shapely.STRtree(u.geometry.values)
def side(off):
    pts=shapely.points(mx+nx*off,my+ny*off)
    pi,ui=tree.query(pts,predicate='within')
    out=np.full(len(pts),'',dtype=object);out[pi]=u.map_symbol.values[ui];return out
s['L']=side(15);s['R']=side(-15)
s['pair']=['|'.join(sorted([x,y])) for x,y in zip(s.L,s.R)]
s['len']=nn
s.to_parquet('work/segs.parquet')
t=s.groupby(['quadrangle_name','map_symbol','pair']).len.sum().div(1000).round(1).reset_index()
t=t[t.len>=0.5]
t.to_csv('work/seg_pairs.csv',index=False);print(len(s))
