import json, pandas as pd
pub=json.load(open('work/pubmeta.json'))
t=pd.read_csv('shell/datasets/ranked_targets.csv');c=pd.read_csv('shell/datasets/crossings_complete.csv')
RB='Renfro Member (Mbr) of Borden Fm'
Q=[
('Alcorn','Borden Fm members Nancy, Cowbell, Nada, Renfro (Renfro kept in Borden); Newman Ls above','Mbna (line) / Mbna|Mbr on GQ','Nada Member (Mbna)',RB,'VERIFIED TARGET CONTACT','Direct: Nada mapped under Renfro','Upper edge of Mbna = base of Renfro = TARGET','Legend OCR: separate Mbr and Mbna'),
('Berea','Borden: Nancy, Cowbell, Nada, Renfro','Mbna','Nada Member (Mbna)',RB,'VERIFIED TARGET CONTACT','Direct; glauconitic seam marks Nada top; Nada+underlying unit become Wildie south of quad','Upper edge of Mbna = base of Renfro','Legend OCR'),
('Bighill','Borden: Nancy, Cowbell, Nada, Renfro','Mbna','Nada Member (Mbna)',RB,'VERIFIED TARGET CONTACT','Direct','Upper edge of Mbna = base of Renfro','Legend OCR; KSPG Stop 6B in quad'),
('Panola','Borden: Nancy, Nada+Cowbell undivided (Mbnc), Renfro','Mbnc','Nada and Cowbell Members undivided (Mbnc)',RB,'VERIFIED TARGET CONTACT','Direct: upper edge of Mbnc is Nada top','Upper edge = base of Renfro; lower edge (Cowbell base) NOT target','Legend OCR; Renfro legend: quartz-filled geodes common near base'),
('Johnetta','Borden: Nancy, Cowbell, Nada, Wildie, Halls Gap, Renfro (transition quad)','Mbna and Mbw','Nada (Mbna) or Wildie (Mbw)',RB,'VERIFIED (Mbna) / PROBABLE (Mbw)','Nada top marked by glauconitic clay with phosphatic nodules; Nada laterally equivalent to Wildie + Halls Gap + upper Nancy','Upper edge of Mbna or Mbw = base of Renfro','Legend OCR'),
('Clay City','Borden: Cowbell (Mbc), Nada (Mbna), Renfro (Mbr)','Mb (generic digital code)','Nada Member (Mbna)',RB,'VERIFIED TARGET CONTACT','Direct; digital line coded Mb because Renfro merged into Msla polygon','Upper edge of Borden polygon = base of Renfro','Explanation box OCR (300 dpi crop)'),
('Levee','Borden: Cowbell, Nada (Mbna), Renfro (Mbr)','Mbna','Nada Member (Mbna)',RB,'VERIFIED TARGET CONTACT','Direct','Upper edge of Mbna = base of Renfro','Legend OCR'),
('Irvine','Borden: Nancy, Cowbell, Renfro+Nada undivided (Mbrn)','Mbrn (digital line Mbna)','Renfro and Nada Members undivided (Mbrn)','St. Louis Ls Mbr of Newman (in Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Combined: target lies one Renfro thickness below line','Upper edge of Mbrn = base of St. Louis (NOT exact target); target inside unit near top','Legend OCR'),
('Stanton','Borden: ... Mbrn','Mbrn','Mbrn','St. Louis Ls (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Renfro commonly ~5 ft: target within ~1.5 m of line','as Irvine','Legend OCR'),
('Slade','Borden: ... Mbrn (Nada type area)','Mbrn','Mbrn','St. Louis Ls (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Renfro ~10 ft: target ~3 m below line','as Irvine','Legend OCR'),
('Pomeroyton','Borden: ... Mbrn','Mbrn','Mbrn','St. Louis Ls (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Renfro ~10 ft','as Irvine','Legend OCR'),
('Heidelberg','Borden: ... Mbrn','Mbrn','Mbrn','Newman/Slade (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Combined','as Irvine','Legend OCR'),
('Cobhill','Borden: ... Mbrn','Mbrn','Mbrn','Newman/Slade (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Combined','as Irvine','Legend OCR'),
('Leighton','Borden: Nancy, Cowbell, Mbrn','Mbrn','Mbrn','Newman/Slade (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Combined; Nada = green & grayish-red shale, mid-unit glauconitic seam, silty dolomite near top','as Irvine','Explanation box OCR (300 dpi crop)'),
('Frenchburg','Borden: ... Mbrn','Mbrn','Mbrn','Newman/Slade (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Combined','as Irvine','Legend OCR'),
('Means','Borden: ... Mbrn','Mbrn','Mbrn','Newman/Slade (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Combined','as Irvine','Legend OCR'),
('Scranton','Borden: ... Mbrn','Mbrn','Mbrn','Newman/Slade (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Combined','as Irvine','Legend OCR'),
('Zachariah','Borden: ... Mbrn','Mbrn','Mbrn','Newman/Slade (Msla)','VERIFIED TARGET CONTACT (combined-unit top)','Combined','as Irvine','Legend OCR'),
('Wildie','Borden: Nancy, Halls Gap (Mbh), Wildie (Mbw), Renfro (Mbr); Mbrw undivided locally','Mbw','Wildie Member (Mbw)',RB+' (siliceous geodes in basal part)','PROBABLE STRATIGRAPHIC EQUIVALENT','Wildie + Halls Gap merge northward to form the Nada (Weir and others 1966); Wildie top carries a glauconitic siltstone like the Nada top','Upper edge of Mbw = base of Renfro; Mbh lines (Wildie absent/unmapped) AMBIGUOUS','Legend OCR'),
('Brodhead','Borden: Halls Gap under Renfro','Mbh','Halls Gap Member (Mbh)',RB,'AMBIGUOUS','Wildie (upper-Nada equivalent) absent or not mapped; target may be missing','Not used','Digital attributes + regional stratigraphy (Weir and others 1966)'),
('Crab Orchard','Borden: Halls Gap under Renfro','Mbh','Halls Gap (Mbh)',RB,'AMBIGUOUS','as Brodhead','Not used','Digital attributes'),
('Maretburg','Borden: Halls Gap under Renfro','Mbh','Halls Gap (Mbh)',RB,'AMBIGUOUS','as Brodhead','Not used','Digital attributes'),
('Mount Vernon','Borden: Halls Gap under Renfro','Mbh','Halls Gap (Mbh)',RB,'AMBIGUOUS','as Brodhead','Not used','Digital attributes'),
('Woodstock','Borden: Halls Gap under lower Renfro (Mbrl)','Mbh','Halls Gap (Mbh)','Renfro lower part (Mbrl)','AMBIGUOUS','as Brodhead','Not used','Digital attributes'),
('Shopville','Borden member Mbl under Renfro','Mbl','Borden member Mbl','Renfro (Mbr)','AMBIGUOUS','Not equated with Nada in material reviewed','Not used','Digital attributes'),
('Bobtown','Muldraugh Member (Mbm) under Salem-Warsaw','Mbm','Muldraugh Member (Mbm)','Salem and Warsaw (Msw)','NOT TARGET GEOLOGY','Muldraugh carbonate/chert (quartz geodes of a different interval)','Not used','Digital attributes'),
('Ezel','Pennington+Newman over Borden undivided','Mbna (digital)','Borden Fm undivided','Newman Ls','AMBIGUOUS','Column lists Renfro (0-14 ft) and Nada but map explanation shows Borden undivided; Renfro assignment on the line not confirmed','Not used','Legend OCR (partial)'),
('Sandgap','Only Renfro/upper units exposed','-','-','-','NOT TARGET GEOLOGY','No Nada/Renfro contact line on the digital map','-','Digital attributes'),
('McKee','Only Renfro/upper units exposed','-','-','-','NOT TARGET GEOLOGY','No Nada/Renfro contact line','-','Digital attributes'),
]
rows=[]
for q in Q:
    n=q[0];p=pub.get(n,{})
    meta=p.get('meta','').split(' | ')
    cq=c[c.quadrangle_name==n]
    rows.append(dict(quadrangle=n,gq=f"GQ-{p.get('gq','')}",authors=meta[1] if len(meta)>1 else '',year=meta[2] if len(meta)>2 else '',
        nomenclature=q[1],target_unit_symbol=q[2],unit_below=q[3],unit_above=q[4],classification=q[5],equivalence_notes=q[6],upper_lower_edge=q[7],
        verification_method=q[8],crossings_total=len(cq),crossings_valid=int(cq.used_for_ranking.sum()),ranked_top120=int((t.quad==n).sum()),citation_url=p.get('url','')))
df=pd.DataFrame(rows);df.to_csv('shell/docs/QUADRANGLE_TABLE.csv',index=False)
md=['# Quadrangle interpretation table\n','Every quadrangle whose digital KGS 1:24,000 geology has a Borden-top contact in the study area. Only VERIFIED and PROBABLE rows are used for ranking. Unit symbols were read from each GQ legend (OCR of the scanned USGS/KGS PDF), never inferred from symbol similarity.\n',
'| Quad | GQ | Authors, year | Target symbol | Unit below | Unit above | Class | Equivalence / edge | Crossings (valid/total) | Top-120 | Source |','|---|---|---|---|---|---|---|---|---|---|---|']
for r in rows:
    md.append(f"| {r['quadrangle']} | {r['gq']} | {r['authors']}, {r['year']} | {r['target_unit_symbol']} | {r['unit_below']} | {r['unit_above']} | {r['classification']} | {r['equivalence_notes']}. {r['upper_lower_edge']} | {r['crossings_valid']}/{r['crossings_total']} | {r['ranked_top120']} | [{r['gq']}]({r['citation_url']}) |")
open('shell/docs/QUADRANGLE_TABLE.md','w').write('\n'.join(md)+'\n\nThe full nomenclature column and verification method are in QUADRANGLE_TABLE.csv.\n')
print(df[['quadrangle','classification','crossings_valid','crossings_total','ranked_top120']].to_string())
