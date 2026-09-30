import numpy as np, pandas as pd, geopandas as gpd, shapely, json, rasterio, os
from shapely.geometry import LineString, Point, mapping
OUT='shell/states/kentucky/map/data'
src=rasterio.open('data/dem/dem20.tif');T=src.transform;H,W=src.shape
v=pd.read_pickle('work/v_export.pkl')
pub=json.load(open('work/pubmeta.json'))
rules=pd.read_csv('work/rules.csv')
meaning={(a,b,c):d for a,b,c,d in zip(rules.quad,rules.line_symbol,rules.pair,rules.interpreted_meaning)}
def cells_ll(cells):
    r,c=np.divmod(np.asarray(cells),W);x,y=rasterio.transform.xy(T,r,c)
    g=gpd.GeoSeries(gpd.points_from_xy(np.atleast_1d(x),np.atleast_1d(y)),crs=32616).to_crs(4326)
    return [[round(p.x,5),round(p.y,5)] for p in g]
def f(x,n=1):
    try:
        x=float(x)
        return None if not np.isfinite(x) else round(x,n)
    except: return None
CL={'VERIFIED':'VERIFIED TARGET CONTACT','VERIFIED_COMBINED':'VERIFIED TARGET CONTACT (combined-unit top)','PROBABLE':'PROBABLE STRATIGRAPHIC EQUIVALENT'}
ABOVE={'Mbna|Mb|Msla':'Renfro Member (mapped Mbr on the GQ; merged into Slade Fm polygon Msla in KGS digital data)','Mbnc|Mb|Msla':'Renfro Member (Mbr on GQ-686)','Mbna|Mb|Mbr':'Renfro Member (Mbr)','Mbw|Mb|Mbr':'Renfro Member (Mbr)'}
def unit_above(row):
    if row.cclass=='VERIFIED_COMBINED': return 'St. Louis Limestone Member of Newman/Slade (Msla) above the combined Renfro+Nada unit (Mbrn)'
    return ABOVE.get(f"{row.map_symbol}|{row.pair}",'Renfro Member')
def unit_below(row):
    return {'Mbna':'Nada Member (Mbna), Borden Fm','Mbnc':'Nada and Cowbell Members, undivided (Mbnc), Borden Fm','Mbw':'Wildie Member (Mbw), Borden Fm'}.get(row.map_symbol,'Borden Fm') if row.cclass!='VERIFIED_COMBINED' else 'Renfro and Nada Members, undivided (Mbrn) — digital polygon Mb'
FAC={}
for q in ['Bighill','Berea','Johnetta']: FAC[q]="West of the projected Locust Branch Fault trend: thick Renfro (16.7–17.5 m) with a cherty, geodiferous basal dolomite 1.5–5 m thick (Dever 1999, sections 83, 87); silica (chalcedony+quartz) geodes replacing upper Nada dolostone at KSPG Stop 6B."
for q in ['Alcorn','Leighton','Panola']: FAC[q]="Along/east of the projected Locust Branch Fault trend: Renfro 6.3–9.7 m resting on Nada shale (Dever 1999, sections 88–95); brecciated dolomite with quartz bodies as far NE as Drip Rock; epigenetic Zn-Pb at Rock Lick Creek shows fluid flow on this trend."
for q in ['Irvine','Cobhill','Heidelberg','Stanton','Slade','Pomeroyton','Clay City','Levee','Frenchburg','Means','Scranton','Zachariah']: FAC[q]="Northeast part of the belt: Renfro thin (GQ legends: ~5–10 ft in Powell County) and mapped with the Nada; the Nada/Renfro contact lies only a few feet to ~10 m below the mapped line. Historic collecting centre (Irvine–Estill–Powell)."
FAC['Wildie']="Rockcastle County Wildie belt: upper-Nada lithosome (Wildie Member) beneath the Renfro south of the arbitrary Berea cutoff; quartz geodes documented in Renfro/Muldraugh-equivalent carbonates nearby."
def label(row):
    da=row.da_km2
    kind='hollow head' if da<0.05 else ('ravine / small hollow' if da<0.5 else ('branch' if da<5 else 'creek'))
    dn=[n for n in (row.downstream_names or []) if n!=row.nhd_name]
    if isinstance(row.nhd_name,str) and row.nhd_name: base=row.nhd_name
    else: base=f"Unnamed {kind}"
    return base+(f", tributary to {dn[0]}" if dn else ''), kind
def fcode_txt(fc):
    return {46003:'intermittent (NHD)',46006:'perennial (NHD)',55800:'artificial path (NHD)',46007:'ephemeral (NHD)'}.get(fc,'not in NHD — DEM-derived channel (likely ephemeral hollow)' if fc is None or fc!=fc else f'NHD FCode {fc}')
def gqcite(q):
    p=pub.get(q);return f"{p['meta']} (GQ-{p['gq']})" if p else q
def reasons(row):
    R=[];N=[]
    if row.cclass=='VERIFIED': R.append(f"Mapped Nada/Renfro contact on {row.quad7 or row.quadrangle_name} GQ (verified from the map legend)")
    elif row.cclass=='VERIFIED_COMBINED': R.append("Mapped top of the Renfro+Nada unit; target contact lies a few feet to ~10 m lower in the same channel"); N.append("Nada/Renfro contact not drawn separately on this quadrangle")
    else: N.append("Wildie Member = upper-Nada equivalent under a different name (probable, not verified)")
    if row.L_prim_km>=20: R.append(f"Large source supply: {row.L_prim_km:.1f} km of mapped target contact drains into the primary search reach")
    elif row.L_prim_km<5: N.append(f"Small source supply ({row.L_prim_km:.1f} km of contact upstream of reach end)")
    if row.density_km_per_km2>=5: R.append(f"Concentrated source: {row.density_km_per_km2:.1f} km of contact per km² of drainage (little dilution)")
    elif row.density_km_per_km2<2: N.append(f"Diluted: only {row.density_km_per_km2:.1f} km contact per km² drainage")
    if row.pen_prim<=0.2: R.append(f"Little Pennsylvanian sandstone upstream ({row.pen_prim*100:.0f}% of drainage) — fewer look-alike clasts")
    elif row.pen_prim>=0.6: N.append(f"{row.pen_prim*100:.0f}% of drainage is Pennsylvanian sandstone/conglomerate — abundant non-target gravel")
    if row.cslope_prim>=25: R.append(f"Steep slopes along the upstream contact (mean {row.cslope_prim:.0f}°) — active erosion/replenishment")
    elif row.cslope_prim<16: N.append(f"Gentle slopes on upstream contact (mean {row.cslope_prim:.0f}°) — slow replenishment")
    if row.incision_m>=30: R.append(f"Deeply incised channel at the contact ({row.incision_m:.0f} m below the ±200 m mean surface)")
    elif row.incision_m<10: N.append(f"Weak incision at the contact ({row.incision_m:.0f} m)")
    g=row.grad_prim
    if 0.005<=g<=0.04: R.append(f"Moderate reach gradient ({g*100:.1f}%) — gravel bars likely")
    elif g>0.08: N.append(f"Steep reach ({g*100:.1f}%) — few bars; search pools, boulder lags and bank toes")
    elif g<0.005: N.append(f"Low gradient ({g*100:.1f}%) — float may be buried in alluvium")
    if row.dist_outline_km==0: R.append("Inside the KGS general Kentucky-agate area outline")
    else: N.append(f"{row.dist_outline_km:.1f} km outside the KGS general agate area")
    if row.doc_nearest_km<=3: R.append(f"{row.doc_nearest_km:.1f} km from documented locality: {row.doc_nearest}")
    if isinstance(row.fault_dist_m,float) and row.fault_dist_m<300: R.append(f"Mapped fault {row.fault_dist_m:.0f} m away (reported only, not scored)")
    if row.nhd_fcode is None or row.nhd_fcode!=row.nhd_fcode: N.append("Source channel is not in NHD — likely dry except after rain")
    return R,N
def conf(row):
    return {'VERIFIED':'High','VERIFIED_COMBINED':'Moderate-high','PROBABLE':'Moderate'}[row.cclass]
def evq(row):
    if row.cclass=='VERIFIED' and row.doc_nearest_km<=5: return 'A — verified contact, documented technical locality within 5 km in the same facies belt'
    if row.cclass in ('VERIFIED','VERIFIED_COMBINED') and row.dist_outline_km==0: return 'B — verified contact inside KGS agate area; no measured section on this drainage'
    if row.cclass in ('VERIFIED','VERIFIED_COMBINED'): return 'C — verified contact outside the documented agate area'
    return 'C — probable equivalent'
props=[];tf=[];cf=[];reach=[]
for _,row in v.iterrows():
    lab,kind=label(row);R,N=reasons(row)
    q=row.quad7 or row.quadrangle_name
    p=dict(id=int(_),rank=None if row['rank']!=row['rank'] else int(row['rank']),priority=row.priority,score=f(row.score,1),
      lat=f(row.lat,4),lon=f(row.lon,4),county=row.county,quad=q,gq=f"GQ-{row.gq_number}",
      stream=lab,channel=kind,nhd=fcode_txt(row.nhd_fcode),
      contact_class=CL[row.cclass],geo_conf=conf(row),
      line_symbol=row.map_symbol,polygon_pair=row.pair,contact_style=row.contact_style,
      unit_below=unit_below(row),unit_above=unit_above(row),
      interpretation=meaning.get((row.quadrangle_name,row.map_symbol,row.pair),''),
      facies=FAC.get(row.quadrangle_name,''),
      elev_m=f(row.z,0),da_cross_km2=f(row.da_km2,3),
      L_prim_km=f(row.L_prim_km,1),DA_prim_km2=f(row.DA_prim_km2,2),density=f(row.density_km_per_km2,2),
      pen_pct=f(row.pen_prim*100,0),contact_slope_deg=f(row.cslope_prim,1),relief_1km_m=f(row.relief_1km,0),
      incision_m=f(row.incision_m,0),slope200_deg=f(row.slope200,1),grad300_pct=f(row.grad300*100,1),grad_prim_pct=f(row.grad_prim*100,1),
      prim_len_m=f(row.prim_len_m,0),ext_len_m=f(row.ext_len_m,0),
      S=f(row.S,3),D=f(row.D,3),E=f(row.E,3),I=f(row.I,3),Tt=f(row['T'],3),Rg=f(row.R,3),G=f(row.G,2),
      dist_outline_km=f(row.dist_outline_km,1),doc_nearest=row.doc_nearest,doc_nearest_km=f(row.doc_nearest_km,1),
      doc_on_reach=row.doc_on_reach,report_on_reach=row.report_on_reach,fault_dist_m=f(row.fault_dist_m,0),
      shares_reach_with_rank=None if row.shares_reach_with_rank!=row.shares_reach_with_rank or row.shares_reach_with_rank is None else int(row.shares_reach_with_rank),
      reasons=R,negatives=N,evidence_quality=evq(row),citation=gqcite(row.quadrangle_name))
    props.append(p)
    geom=dict(type='Point',coordinates=[p['lon'],p['lat']])
    cf.append(dict(type='Feature',geometry=geom,properties=p))
    if p['rank'] is not None and p['rank']<=120:
        path=row.path
        x0=[p['lon'],p['lat']];src_ll=[x0]+cells_ll(path[:row.jS+1]);pr_ll=[x0]+cells_ll(path[:row.jP+1]);ex_ll=cells_ll(path[row.jP:row.jE+1])
        p['walk_start']=pr_ll[-1][::-1];p['source_zone_end']=src_ll[-1][::-1]
        tf.append(dict(type='Feature',geometry=geom,properties=p))
        for kind_,ll in (('source',src_ll),('primary',pr_ll),('extended',ex_ll)):
            if len(ll)>=2: reach.append(dict(type='Feature',geometry=dict(type='LineString',coordinates=ll),properties=dict(rank=p['rank'],priority=p['priority'],kind=kind_)))
# compact crossings (all valid) — keep fewer props for size
keep=['id','rank','priority','score','lat','lon','county','quad','stream','contact_class','geo_conf','L_prim_km','DA_prim_km2','density','relief_1km_m','incision_m','grad_prim_pct','shares_reach_with_rank','line_symbol','polygon_pair','unit_below','unit_above','elev_m','da_cross_km2','nhd','gq','S','D','E','I','Tt','Rg','G']
cfc=[dict(type='Feature',geometry=x['geometry'],properties={k:x['properties'][k] for k in keep}) for x in cf if x['properties']['rank'] is None or x['properties']['rank']>120]
json.dump(dict(type='FeatureCollection',features=tf),open(f'{OUT}/targets.geojson','w'),separators=(',',':'))
json.dump(dict(type='FeatureCollection',features=cfc),open(f'{OUT}/crossings_valid.geojson','w'),separators=(',',':'))
json.dump(dict(type='FeatureCollection',features=reach),open(f'{OUT}/reaches.geojson','w'),separators=(',',':'))
pd.DataFrame(props).drop(columns=['reasons','negatives']).assign(reasons=[' | '.join(p['reasons']) for p in props],negatives=[' | '.join(p['negatives']) for p in props]).to_csv('work/out/valid_crossings_scored.csv',index=False)
print(len(tf),len(cfc),len(reach))
