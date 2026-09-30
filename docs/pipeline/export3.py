import numpy as np, pandas as pd, geopandas as gpd, shapely, json, os
OUT='shell/states/kentucky/map/data'
pub=json.load(open('work/pubmeta.json'))
rules=pd.read_csv('work/rules.csv')
R={(a,b,c):(d,e) for a,b,c,d,e in zip(rules.quad,rules.line_symbol,rules.pair,rules.contact_class,rules.interpreted_meaning)}
b=gpd.read_parquet('work/bt_segs.parquet')
OTHER={'Mbh':('AMBIGUOUS','Top of Halls Gap Member (Mbh) under Renfro; the Wildie (upper-Nada equivalent) is absent or unmapped here, so the target horizon may be missing or included in an adjacent unit.'),
 'Mbl':('AMBIGUOUS','Borden member symbol Mbl (Shopville, GQ-282, Hatch 1964) beneath Renfro; not equated with the Nada in the legend reviewed.'),
 'Mbm':('NOT TARGET GEOLOGY','Muldraugh Member (Mbm) - carbonate/chert interval SW of the Nada belt (Bobtown GQ-1102); geodes here are a different horizon.'),
 'Mb':('AMBIGUOUS','Borden Formation undivided top (Clay City GQ-663): the Nada is not separately identified on the digital line.')}
def cls(r):
    k=(r.quadrangle_name,r.map_symbol,r.pair)
    if k in R: return R[k]
    if r.map_symbol in OTHER: return OTHER[r.map_symbol]
    if r.map_symbol=='Mbna': return ('AMBIGUOUS','Line coded Mbna, but the quadrangle legend was not verified as mapping the Nada/Renfro boundary; not used.')
    return ('AMBIGUOUS','Not interpreted as the target contact.')
b=b[b.pair.str.contains('Mb')]
cc=b.apply(cls,axis=1);b['cls']=[c[0] for c in cc];b['meaning']=[c[1] for c in cc]
g=b.dissolve(by=['ci','cls'],aggfunc='first').reset_index()
g['geometry']=shapely.line_merge(g.geometry.values)
g['geometry']=g.geometry.simplify(6)
g=g.to_crs(4326)
def cite(q):
    p=pub.get(q);return (f"{p['meta']}, GQ-{p['gq']}",f"https://pubs.usgs.gov/publication/gq{p['gq']}") if p else (q,'')
g['source_pub']=[cite(q)[0] for q in g.quadrangle_name];g['source_url']=[cite(q)[1] for q in g.quadrangle_name]
g['confidence']=g.cls.map({'VERIFIED':'High','VERIFIED_COMBINED':'Moderate-high','PROBABLE':'Moderate','AMBIGUOUS':'Not used','NOT TARGET GEOLOGY':'Not used'})
g['class_label']=g.cls.map({'VERIFIED':'VERIFIED TARGET CONTACT','VERIFIED_COMBINED':'VERIFIED TARGET CONTACT (combined-unit top)','PROBABLE':'PROBABLE STRATIGRAPHIC EQUIVALENT','AMBIGUOUS':'AMBIGUOUS','NOT TARGET GEOLOGY':'NOT TARGET GEOLOGY'})
cols=['quadrangle_name','gq_number','source_pub','source_url','map_symbol','pair','contact_style','contact_comments','meaning','class_label','confidence','geometry']
g=g[cols].rename(columns={'quadrangle_name':'quad','map_symbol':'original_line_symbol','pair':'polygon_pair_below_above'})
def dump(df,fn,prec=5):
    open(f'{OUT}/{fn}','w').write(df.to_json(drop_id=True,to_wgs84=True).replace('\n',''))
    gj=json.load(open(f'{OUT}/{fn}'))
    def rd(c): return [rd(x) for x in c] if isinstance(c[0],(list,tuple)) else [round(c[0],prec),round(c[1],prec)]
    for f_ in gj['features']:
        if f_['geometry']: f_['geometry']['coordinates']=rd(f_['geometry']['coordinates'])
    json.dump(gj,open(f'{OUT}/{fn}','w'),separators=(',',':'))
tgt=g[g.class_label.str.startswith(('VERIFIED','PROBABLE'))];oth=g[~g.index.isin(tgt.index)]
dump(tgt,'contact_target.geojson');dump(oth,'contact_other.geojson')
# units
u=gpd.read_parquet('work/units.parquet')
core=shapely.box(*gpd.GeoSeries([shapely.box(-84.62,37.22,-83.3,38.02)],crs=4326).to_crs(32616).total_bounds)
core2=shapely.box(*gpd.GeoSeries([shapely.box(-84.45,37.30,-83.55,37.95)],crs=4326).to_crs(32616).total_bounds)
u=u[u.intersects(core2)]
u['geometry']=u.geometry.buffer(0)
tq=set(rules.quad)
tb=u[u.quadrangle_name.isin(tq)&u.map_symbol.isin(['Mb','Mbnc'])].copy();tb['geometry']=tb.geometry.simplify(20)
tb=tb.dissolve(by='quadrangle_name').reset_index()[['quadrangle_name','geometry']]
def grp(n):
    n=(n or '').lower()
    if any(k in n for k in ['alluv','terrace','fluvial','fill','landslide','colluv','lacustrine']): return 'Quaternary / surficial'
    if 'renfro' in n: return 'Renfro Member (above target)'
    if 'borden' in n or 'nada' in n or 'cowbell' in n or 'nancy' in n or 'wildie' in n or 'halls gap' in n or 'muldraugh' in n: return 'Borden Formation (target Nada / Wildie at top)'
    if any(k in n for k in ['slade','newman','st. louis','ste. genevieve','salem','warsaw','paragon','pennington','fort payne','renfro']): return 'Slade / Newman / Paragon / Pennington (Mississippian carbonates, above)'
    if any(k in n for k in ['new albany','ohio shale','chattanooga','boyle','devon','sunbury','bedford','berea']): return 'Devonian - lowest Mississippian shales and Boyle Dolomite'
    if any(k in n for k in ['crab orchard','brassfield','silur']): return 'Silurian'
    if any(k in n for k in ['grundy','corbin','pikeville','four corners','hyden','princess','alvy','livingston','lee ','breathitt','rockcastle','conglomerate','pennsylv','sandstone','formation of']): return 'Pennsylvanian clastics'
    return 'Ordovician and other'
u['grp']=u.formation_name.map(grp)
ud=u[['grp','geometry']].dissolve(by='grp').reset_index()
ud['geometry']=ud.geometry.intersection(core2).simplify(30).buffer(0)
dump(ud,'geology_units.geojson',4);dump(tb,'geology_target_units.geojson',4)
# faults
fa=gpd.read_parquet('work/faults.parquet');fa=fa[fa.intersects(core)];fa['geometry']=fa.geometry.simplify(8)
dump(fa[['fault_name','feature_type','fault_throw','line_style','quadrangle_name','gq_number','geometry']],'faults.geojson')
# quads, counties
q=gpd.read_file('work/quads.geojson');dump(q,'quads.geojson')
c=gpd.read_file('data/raw/counties.geojson').to_crs(32616);c=c[c.intersects(core)];c['geometry']=c.geometry.simplify(30);dump(c[['NAME','geometry']],'counties.geojson')
# streams
fl=gpd.read_parquet('work/flowlines.parquet');fl=fl[fl.intersects(core)]
fl=fl[(fl.streamorde>=2)|fl.gnis_name.notna()];fl['geometry']=fl.geometry.simplify(15)
fl=fl[['gnis_name','fcode','streamorde','geometry']]
dump(fl,'streams.geojson',4)
for fn in os.listdir(OUT): print(fn,os.path.getsize(f'{OUT}/{fn}')//1024,'KB')
print(g.class_label.value_counts())
