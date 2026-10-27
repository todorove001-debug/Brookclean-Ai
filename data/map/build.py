import json,math
L0,L1,A0,A1=35.0,138.0,40.0,62.0
C=math.cos(math.radians(53));K=100
def P(p):return (round((p[0]-L0)*C*K),round((A1-p[1])*K))
def inb(p,m=0):return L0-m<=p[0]<=L1+m and A0-m<=p[1]<=A1+m
def dp(pts,eps):
    if len(pts)<3:return pts
    # итеративный Дуглас-Пекер
    keep=[False]*len(pts);keep[0]=keep[-1]=True;st=[(0,len(pts)-1)]
    while st:
        a,b=st.pop();ax,ay=pts[a];bx,by=pts[b];dx,dy=bx-ax,by-ay;L=math.hypot(dx,dy) or 1e-12;im=-1;dm=0
        for i in range(a+1,b):
            px,py=pts[i];d=abs(dy*px-dx*py+bx*ay-by*ax)/L if (dx or dy) else math.hypot(px-ax,py-ay)
            if d>dm:dm=d;im=i
        if dm>eps:keep[im]=True;st+=[(a,im),(im,b)]
    return [p for p,k in zip(pts,keep) if k]
def enc(pts,close=False):
    q=[P(p) for p in pts];o=[q[0]]
    for p in q[1:]:
        if p!=o[-1]:o.append(p)
    if len(o)<2:return ''
    s='M%d %d'%o[0]
    s+='l'+' '.join('%d %d'%(b[0]-a[0],b[1]-a[1]) for a,b in zip(o,o[1:]))
    return s+('z' if close else '')
def lines_of(g):
    if not g:return []
    t=g['type'];c=g['coordinates']
    return [c] if t=='LineString' else c if t=='MultiLineString' else []
def clip_line(l,m=0.5):
    out=[];cur=[]
    for p in l:
        if inb(p,m):cur.append(p)
        else:
            if len(cur)>1:out.append(cur)
            cur=[]
    if len(cur)>1:out.append(cur)
    return out
def polys_of(g):
    t=g['type'];c=g['coordinates']
    return [c] if t=='Polygon' else c
def clamp(p):return [min(max(p[0],L0-1),L1+1),min(max(p[1],A0-1),A1+1)]
out={}
# суша
s=[]
for f in json.load(open('ne_10m_land.geojson'))['features']:
    for poly in polys_of(f['geometry']):
        ring=poly[0]
        if not any(inb(p,1) for p in ring):continue
        r=dp([clamp(p) for p in ring],0.015)
        if len(r)>3:s.append(enc(r,True))
out['land']=''.join(s)
# озёра
s=[];lk=[]
for f in json.load(open('ne_10m_lakes.geojson'))['features']:
    pr=f['properties']
    if pr.get('scalerank',9)>6:continue
    for poly in polys_of(f['geometry']):
        ring=poly[0]
        if not any(inb(p) for p in ring):continue
        r=dp([clamp(p) for p in ring],0.01)
        if len(r)>3:s.append(enc(r,True))
        if pr.get('scalerank',9)<=2 and pr.get('name_ru'):
            xs=[p[0] for p in ring];ys=[p[1] for p in ring];lk.append([pr['name_ru'],(min(ys)+max(ys))/2,(min(xs)+max(xs))/2])
out['lakes']=''.join(s)
# реки
s=[];rv=[]
for f in json.load(open('ne_10m_rivers_lake_centerlines.geojson'))['features']:
    pr=f['properties']
    if pr.get('featurecla')!='River' or pr.get('scalerank',9)>6:continue
    for l in lines_of(f['geometry']):
        for c in clip_line(l):
            c=dp(c,0.01)
            if len(c)>1:s.append(enc(c))
out['rivers']=''.join(s)
# границы стран
s=[]
for f in json.load(open('ne_10m_admin_0_boundary_lines_land.geojson'))['features']:
    for l in lines_of(f['geometry']):
        for c in clip_line(l):
            c=dp(c,0.01)
            if len(c)>1:s.append(enc(c))
out['borders']=''.join(s)
# границы регионов России
s=[]
for f in json.load(open('ne_10m_admin_1_states_provinces_lines.geojson'))['features']:
    if f['properties'].get('ADM0_A3')!='RUS':continue
    for l in lines_of(f['geometry']):
        for c in clip_line(l):
            c=dp(c,0.012)
            if len(c)>1:s.append(enc(c))
out['regions']=''.join(s)
# дороги (без названий в данных): основные — отдельно
maj=[];mn=[]
for f in json.load(open('ne_10m_roads.geojson'))['features']:
    pr=f['properties']
    for l in lines_of(f['geometry']):
        for c in clip_line(l,0):
            c=dp(c,0.008)
            if len(c)<2:continue
            (maj if pr.get('type')=='Major Highway' or (pr.get('scalerank') or 9)<=4 else mn).append(enc(c))
out['roads']=''.join(maj);out['roads2']=''.join(mn)
# города
pl=[]
for f in json.load(open('ne_10m_populated_places.geojson'))['features']:
    pr=f['properties'];p=[pr['LONGITUDE'],pr['LATITUDE']]
    if not inb(p):continue
    if pr.get('ADM0NAME')!='Russia' and (pr.get('POP_MAX') or 0)<500000:continue
    x,y=P(p);pl.append([pr.get('NAME_RU') or pr['NAME'],x,y,round(pr.get('MIN_ZOOM') or 9,1),pr.get('POP_MAX') or 0])
pl.sort(key=lambda z:(z[3],-z[4]))
out['places']=[z[:4] for z in pl]
out['lakeNames']=[[n,*P([lo,la])] for n,la,lo in lk]
out['W']=round((L1-L0)*C*K);out['H']=round((A1-A0)*K);out['L0']=L0;out['A1']=A1;out['C']=C;out['K']=K
# маршрут по дорогам: точки коридора в тех же единицах
cr=json.load(open('corr_road.json'))
pts=dp(cr['pts'],0.004)  # индексы вершин коридора сохраняем отдельно
idxpts=[cr['pts'][i] for i in cr['idx']]
keep=set(map(tuple,pts))|set(map(tuple,idxpts))
full=[p for p in cr['pts'] if tuple(p) in keep]
ded=[];
for p in full:
    if not ded or ded[-1]!=p:ded.append(p)
idx=[];j=0
for v in idxpts:
    while tuple(ded[j])!=tuple(v):j+=1
    idx.append(j)
out['road']=[[round(p[1],4),round(p[0],4)] for p in ded];out['roadIdx']=idx
js=json.dumps(out,ensure_ascii=False,separators=(',',':'))
open('map2.json','w').write(js)
for k,v in out.items():print(k,len(json.dumps(v,ensure_ascii=False)))
print('total',len(js))
