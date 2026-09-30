import requests, json, math
secs={82:("Morrill","Rockcastle","Bighill",100,'S',1800,'E',19,'M-64'),
83:("Bighill (US-421 roadcut)","Madison","Bighill",1800,'N',1650,'W',19,'M-64'),
84:("Tilday Mountain","Madison","Bighill",500,'S',700,'E',1,'M-64'),
85:("Wolf Gap Mountain","Madison","Bighill",400,'N',600,'W',16,'N-65'),
86:("Little Clover Creek","Jackson","Johnetta",700,'N',2150,'E',24,'L-65'),
87:("Owsley Fork","Jackson","Bighill",2450,'S',50,'E',17,'M-65'),
88:("Cane Branch","Jackson","Alcorn",1100,'N',700,'E',14,'M-66'),
89:("Rock Lick Creek ('Platinum Mine' prospect)","Jackson","Alcorn",2800,'N',600,'E',13,'M-66'),
92:("Pond School","Jackson","Leighton",2500,'S',1100,'W',8,'M-67'),
93:("Station Camp Creek (KY-1209 roadcut)","Jackson","Leighton",2800,'S',450,'W',15,'M-68'),
94:("War Fork","Jackson","McKee",1900,'S',1400,'W',5,'L-68'),
95:("Drip Rock (KY-89 roadcut)","Estill","Leighton",900,'N',700,'W',23,'N-67'),
96:("Zion Mountain","Estill","Panola",2050,'N',1700,'E',14,'N-66'),
97:("Big Round Mountain","Estill","Panola",300,'N',50,'E',6,'N-66'),
98:("Grindstone Hollow","Estill","Irvine",3000,'S',2250,'W',8,'O-67'),
99:("Sweet Lick Branch","Estill","Irvine",2200,'N',600,'W',9,'O-67'),
100:("Tipton Ridge","Estill","Irvine",2800,'S',2150,'E',14,'O-68'),
101:("Furnace Fork","Estill","Cobhill",400,'S',700,'E',13,'O-68'),
104:("Hatton Hollow","Lee","Cobhill",1100,'S',1000,'W',9,'N-69'),
105:("Big Sinking Creek","Lee","Cobhill",600,'N',1100,'W',10,'N-69'),
113:("Mountain Parkway (Nada type area)","Powell","Slade",1300,'N',1800,'W',11,'P-70'),
74:("Renfro Valley South","Rockcastle","Wildie/Mount Vernon",2700,'N',2000,'W',15,'K-63'),
75:("Lake Linville","Rockcastle","Wildie",1900,'N',1300,'E',10,'K-62'),
77:("Sigmon Cemetery","Rockcastle","Wildie",1400,'N',500,'W',25,'L-63'),
}
out=[]
for n,(name,co,q,ns,nsref,ew,ewref,sec,blk) in secs.items():
    r=requests.get("https://kgs.uky.edu/arcgis/rest/services/Base/KYQuadBoundaries/MapServer/7/query",params=dict(where=f"CC5LABEL='{blk}' AND SECTION={sec}",outFields="*",outSR=4326,f="json"),timeout=60).json()
    if not r.get('features'): print('miss',n);continue
    ring=r['features'][0]['geometry']['rings'][0]
    xs=[p[0] for p in ring];ys=[p[1] for p in ring]
    W,E,S,N=min(xs),max(xs),min(ys),max(ys)
    lat0=(S+N)/2;ftlat=1/364000.0;ftlon=1/(364000.0*math.cos(math.radians(lat0)))
    lat=N-ns*ftlat if nsref=='N' else S+ns*ftlat
    lon=W+ew*ftlon if ewref=='W' else E-ew*ftlon
    out.append(dict(section=n,name=name,county=co,quad=q,lat=round(lat,5),lon=round(lon,5),carter=f"{ns:,} ft F{nsref}L x {ew:,} ft F{ewref}L, {sec}-{blk}"))
    print(n,name,round(lat,4),round(lon,4))
json.dump(out,open('work/dever_sections.json','w'),indent=1)
