# Prepare UTM layers: units (domain), flowlines, catchments
import geopandas as gpd, pandas as pd, numpy as np
from shapely.geometry import box
dom=box(-84.62,37.18,-83.38,37.98)
u=gpd.read_file('data/raw/units.geojson');u=u[u.intersects(dom)].to_crs(32616)
u['geometry']=u.geometry.buffer(0)
u.to_parquet('work/units.parquet')
fl=gpd.read_file('data/raw/flowlines.geojson').to_crs(32616)
fl.to_parquet('work/flowlines.parquet')
ca=gpd.read_file('data/raw/catchments.geojson').to_crs(32616)
ca.to_parquet('work/catchments.parquet')
c=gpd.read_file('data/raw/contacts.geojson');c=c[c.intersects(dom)].to_crs(32616);c.to_parquet('work/contacts.parquet')
f=gpd.read_file('data/raw/faults.geojson').to_crs(32616);f.to_parquet('work/faults.parquet')
print(len(u),len(fl),len(ca),len(c),len(f))
print(fl.ftype.value_counts().head(), fl.fcode.value_counts().head(8))
