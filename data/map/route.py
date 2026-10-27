import json,math,heapq,collections
R=6371
def hv(a,b):
    la1,lo1,la2,lo2=map(math.radians,(a[1],a[0],b[1],b[0]))
    h=math.sin((la2-la1)/2)**2+math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))
corr=json.load(open('ne/corr.json'))
W=[(c[2],c[1]) for c in corr]   # lon,lat
roads=json.load(open('ne/ne_10m_roads.geojson'))
nodes={};adj=collections.defaultdict(list)
def key(p):return (round(p[0],3),round(p[1],3))
def near_corr(p):
    # грубо: в пределах 1.2° от ломаной коридора (по вершинам и серединам)
    for i in range(len(W)-1):
        a,b=W[i],W[i+1]
        for t in (0,.25,.5,.75,1):
            x=a[0]+(b[0]-a[0])*t;y=a[1]+(b[1]-a[1])*t
            if abs(p[0]-x)<1.4 and abs(p[1]-y)<0.9:return True
    return False
cnt=0
for f in roads['features']:
    g=f['geometry']
    if not g:continue
    lines=g['coordinates'] if g['type']=='MultiLineString' else [g['coordinates']]
    for l in lines:
        if not any(near_corr(p) for p in l[::max(1,len(l)//5)]+[l[-1]]):continue
        cnt+=1
        for a,b in zip(l,l[1:]):
            ka,kb=key(a),key(b)
            if ka==kb:continue
            nodes[ka]=a;nodes[kb]=b
            d=hv(a,b);adj[ka].append((kb,d));adj[kb].append((ka,d))
print('lines',cnt,'nodes',len(nodes))
# сшиваем концы линий, которые не совпали точно (до 3 км)
deg={k:len(v) for k,v in adj.items()}
ends=[k for k,v in deg.items() if v==1]
grid=collections.defaultdict(list)
for k in nodes:grid[(int(k[0]*10),int(k[1]*10))].append(k)
added=0
for k in ends:
    gx,gy=int(k[0]*10),int(k[1]*10);best=None;bd=3
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            for k2 in grid[(gx+dx,gy+dy)]:
                if k2==k or any(k2==n for n,_ in adj[k]):continue
                d=hv(nodes[k],nodes[k2])
                if d<bd:bd=d;best=k2
    if best:adj[k].append((best,bd*1.5));adj[best].append((k,bd*1.5));added+=1
print('stitched',added)
keys=list(nodes)
def nearest(p):
    gx,gy=int(p[0]*10),int(p[1]*10);best=None;bd=1e9
    for r in range(0,8):
        for dx in range(-r,r+1):
            for dy in range(-r,r+1):
                if max(abs(dx),abs(dy))!=r:continue
                for k in grid[(gx+dx,gy+dy)]:
                    d=hv(p,nodes[k])
                    if d<bd:bd=d;best=k
        if best and bd<r*8:break
    return best,bd
def dijkstra(s,t,limit):
    dist={s:0};prev={};pq=[(0,s)];T=nodes[t]
    while pq:
        d,u=heapq.heappop(pq)
        if u==t:break
        if d>dist.get(u,1e18):continue
        for v,w in adj[u]:
            nd=d+w
            if nd<dist.get(v,1e18) and hv(nodes[v],T)<limit:
                dist[v]=nd;prev[v]=u;heapq.heappush(pq,(nd,v))
    if t not in dist:return None,None
    path=[t]
    while path[-1]!=s:path.append(prev[path[-1]])
    return [nodes[k] for k in reversed(path)],dist[t]
out=[list(W[0])];idx=[0];report=[]
for i in range(len(W)-1):
    a,b=W[i],W[i+1];ka,da=nearest(a);kb,db=nearest(b);straight=hv(a,b)
    seg=None
    if ka and kb and da<25 and db<25:
        seg,d=dijkstra(ka,kb,straight*1.6+60)
        if seg and d>straight*1.3+25:seg=None
    if seg:
        pts=[list(a)]+[list(p) for p in seg]+[list(b)]
        report.append((corr[i][0],corr[i+1][0],round(straight),round(d),'road'))
    else:
        pts=[list(a),list(b)];report.append((corr[i][0],corr[i+1][0],round(straight),None,'STRAIGHT',round(da),round(db)))
    out+=pts[1:];idx.append(len(out)-1)
for r in report:print(r)
json.dump({'pts':out,'idx':idx},open('ne/corr_road.json','w'))
print(len(out))
