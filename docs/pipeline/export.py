import numpy as np, pandas as pd, geopandas as gpd, shapely, json, rasterio, os
from shapely.geometry import LineString, Point, mapping
OUT='shell/states/kentucky/map/data';os.makedirs(OUT,exist_ok=True)
src=rasterio.open('data/dem/dem20.tif');T=src.transform;H,W=src.shape
v=pd.read_pickle('work/scored.pkl')
allc=pd.read_pickle('work/cross_reach.pkl') if os.path.exists('work/cross_reach.pkl') else None
counties=gpd.read_file('data/raw/counties.geojson').to_crs(32616)
quads=gpd.read_file('work/quads.geojson').to_crs(32616)
faults=gpd.read_parquet('work/faults.parquet')
pub=json.load(open('work/pubmeta.json'))
area=gpd.read_file('data/raw/kgs_agate_area.geojson')
dever=json.load(open('work/dever_sections.json'))
tr=lambda g: gpd.GeoSeries(g,crs=32616).to_crs(4326)
def cells_xy(cells):
    r,c=np.divmod(np.asarray(cells),W);x,y=rasterio.transform.xy(T,r,c);return np.atleast_1d(x),np.atleast_1d(y)
def r4(x): return None if x is None or (isinstance(x,float) and not np.isfinite(x)) else round(float(x),4)
def rn(x,n=1): return None if x is None or (isinstance(x,float) and not np.isfinite(x)) else round(float(x),n)
# county & quad join
def join_poly(pts,polys,col):
    g=gpd.GeoDataFrame(geometry=list(pts),crs=32616)
    j=gpd.sjoin(g,polys[[col,'geometry']],predicate='within',how='left')
    j=j[~j.index.duplicated()]
    return j[col].values
v['county']=join_poly(v.pt,counties,'NAME')
v['quad7']=join_poly(v.pt,quads,'quad')
ll=tr(list(v.pt));v['lat']=[p.y for p in ll];v['lon']=[p.x for p in ll]
ftree=shapely.STRtree(faults.geometry.values)
fi,fd=ftree.query_nearest(list(v.pt),return_distance=True,all_matches=False)
v['fault_dist_m']=np.nan;v.iloc[fi[0],v.columns.get_loc('fault_dist_m')]=fd
# documented technical occurrences
DOC=[]
for s in dever:
    n=s['section']
    txt={83:"Cherty and geodiferous dolomite 1.5-5 m thick in basal Renfro; Renfro 16.7-17.5 m (west of projected Locust Branch Fault trend).",
         87:"Cherty and geodiferous dolomite 1.5-5 m thick in basal Renfro; Renfro 16.7-17.5 m.",
         95:"Brecciated dolomite with quartz bodies in the Renfro (northeasternmost reported).",
         89:"Renfro 7.8 m on Nada shale; 1.2-m mineralized zone (sphalerite, galena, calcite) 2.6 m below top; 'Platinum Mine' prospect. Evidence of fluid flow along the projected Locust Branch Fault trend.",
         74:"Muldraugh and Salem-Warsaw correlatives (8.2-9.4 m) with chert and geodes. CONTRAST: quartz geodes in a NON-target interval southwest of the Nada/Renfro belt.",
         75:"Muldraugh and Salem-Warsaw correlatives with chert and geodes. CONTRAST: non-target interval."}.get(n)
    if not txt: continue
    DOC.append(dict(id=f"Dever-{n}",name=f"Section {n} - {s['name']}",lat=s['lat'],lon=s['lon'],county=s['county'],quad=s['quad'],
        kind='contrast (non-target interval)' if n in (74,75) else 'technical measured section',
        evidence=txt,position=f"Carter coordinates {s['carter']} converted with the KGS Carter 1-minute section grid; position uncertainty roughly 100 m.",
        citation="Dever, G.R., Jr., 1999, Tectonic implications of erosional and depositional features in upper Meramecian and lower Chesterian (Mississippian) rocks of south-central and east-central Kentucky: KGS Bulletin 5, Series XI",url="https://www.uky.edu/KGS/pdf/b11_05.pdf"))
DOC.append(dict(id="KSPG-6B",name="KSPG 2013 Stop 6B - Bighill roadcut, US-421",lat=37.52888,lon=-84.21138,county="Madison",quad="Bighill",kind='technical field-trip stop',
    evidence="'The upper dolostone bed contains randomly arranged silica (chalcedony and quartz) geodes that appear to replace dolostone.' Uppermost Borden: Nada Member, Wildie Member (commonly mapped as Nada), lower Renfro.",
    position="Coordinates as published for Stops 6A/6B (37 deg 31' 43.98\" N, 84 deg 12' 40.98\" W).",
    citation="Ettensohn, F.R., and others, 2013, KSPG field trip guidebook: The Early-Middle Mississippian Borden-Grainger-Fort Payne delta/basin complex",url="https://kgs.uky.edu/kgsweb/olops/pub/kgs/KSPG%202013%20guidebook.pdf"))
docdf=pd.DataFrame(DOC)
dpts=gpd.GeoSeries(gpd.points_from_xy(docdf.lon,docdf.lat),crs=4326).to_crs(32616)
TECH=[i for i,k in enumerate(docdf.kind) if not k.startswith('contrast')]
# report-based (secondary) named streams
fl=gpd.read_parquet('work/fl_all.parquet')
REP=[("Rock Lick Creek","Jackson","Mindat.org Kentucky chalcedony/agate locality list names 'Station Camp Creek; South Fork; Rock Lick Creek, Jackson County'.","https://www.mindat.org/locentry-1080948.html"),
     ("Station Camp Creek","Jackson","Mindat.org list (Jackson County entry); collector blog describes collecting access along Station Camp Creek.","https://www.mindat.org/locentry-1080948.html"),
     ("South Fork Station Camp Creek","Jackson","Mindat.org list names 'South Fork' with Station Camp Creek, Jackson County.","https://www.mindat.org/locentry-1080948.html"),
     ("Middle Fork Station Camp Creek",None,"Collector blog reports geodes/agate from side streams of Middle Fork Station Camp Creek, from upper Nada blue-green shale under the Renfro.","https://vanstockum.blog/2024/02/15/10358/"),
     ("Drowning Creek",None,"Collector blog reports a Drowning Creek-area roadcut exposing the horizon (road-cut, not creek, observation).","https://vanstockum.blog/2024/02/15/10358/")]
repfeats=[]
cty=counties.set_index('NAME')
for name,co,txt,url in REP:
    s=fl[fl.gnis_name==name]
    if co: s=s[s.intersects(cty.loc[co].geometry)]
    if len(s)==0: continue
    g=tr(shapely.line_merge(shapely.union_all(s.geometry.values)).simplify(15))
    repfeats.append(dict(type='Feature',geometry=json.loads(gpd.GeoSeries(g).to_json())['features'][0]['geometry'],
        properties=dict(name=name,precision='Named-stream level only - the report gives no point location. Whole NHD stream shown.',evidence=txt,source=url,quality='secondary / collector report - not used in scoring')))
repfeats.append(dict(type='Feature',geometry=dict(type='Point',coordinates=[-84.2033,37.5536]),properties=dict(name='Big Hill (Madison County)',precision='Place-name level only (approximate community location)',evidence="Mindat.org chalcedony/agate list names 'Big Hill, Madison County'.",source='https://www.mindat.org/locentry-1080948.html',quality='secondary / collector report - not used in scoring')))
json.dump(dict(type='FeatureCollection',features=repfeats),open(f'{OUT}/evidence_reports.geojson','w'))
# documented geojson
docfe=[dict(type='Feature',geometry=dict(type='Point',coordinates=[round(r.lon,5),round(r.lat,5)]),properties={k:r[k] for k in docdf.columns if k not in('lat','lon')}) for _,r in docdf.iterrows()]
json.dump(dict(type='FeatureCollection',features=docfe),open(f'{OUT}/evidence_documented.geojson','w'))
a=area.iloc[0]
json.dump(dict(type='FeatureCollection',features=[dict(type='Feature',geometry=mapping(a.geometry.simplify(0.0003)),properties=dict(name='KGS general location of Kentucky agates',source='KGS Kentucky Mineral Resources Information database (T.N. Sparks, KGS, unpublished area outline)',url='https://kgs.uky.edu/kymineral/',note='Area outline of reported agate occurrence; used as the regional-evidence input (R) in scoring.'))]),open(f'{OUT}/evidence_kgs_area.geojson','w'))
# relation of each crossing to documented evidence
ext_lines=[]
for _,row in v.iterrows():
    x,y=cells_xy(row.path[:row.jE+1]);ext_lines.append(LineString(np.c_[x,y]) if len(x)>1 else Point(x[0],y[0]))
v['_ext']=ext_lines
dtech=dpts.iloc[TECH].values
dd=np.array([[p.distance(q) for q in dtech] for p in v.pt])
v['doc_nearest_km']=dd.min(1)/1000;v['doc_nearest']=[docdf.iloc[TECH[j]]['name'] for j in dd.argmin(1)]
ed=np.array([[l.distance(q) for q in dtech] for l in v._ext])
v['doc_on_reach']=[', '.join(docdf.iloc[TECH[j]]['name'] for j in np.flatnonzero(r<=500)) for r in ed]
repl=[shapely.geometry.shape(f['geometry']) for f in repfeats]
repl=gpd.GeoSeries(repl,crs=4326).to_crs(32616).values
rn_=[f['properties']['name'] for f in repfeats]
v['report_on_reach']=[', '.join(n for n,g in zip(rn_,repl) if l.distance(g)<=100) for l in v._ext]
v.to_pickle('work/v_export.pkl')
print('ok',len(v))
