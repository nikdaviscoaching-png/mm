import numpy as np, rasterio, pandas as pd, geopandas as gpd, shapely, time
src=rasterio.open('data/dem/dem20.tif');T=src.transform;H,W=src.shape
fd=np.load('work/fdir.npy');acc=np.load('work/acc_n.npy');cls=np.load('work/cls.npy')
# downstream index
dr={64:(-1,0),128:(-1,1),1:(0,1),2:(1,1),4:(1,0),8:(1,-1),16:(0,-1),32:(-1,-1)}
di=np.full(H*W,-1,np.int64)
rr,cc=np.indices((H,W))
for d,(a,b) in dr.items():
    m=fd==d
    r2=rr[m]+a;c2=cc[m]+b;ok=(r2>=0)&(r2<H)&(c2>=0)&(c2<W)
    src_idx=(rr[m]*W+cc[m])[ok];di[src_idx]=(r2*W+c2)[ok]
np.save('work/down.npy',di)
TH=25
ch=np.flatnonzero(acc.ravel()>=TH)
order=ch[np.argsort(acc.ravel()[ch],kind='stable')]
C=cls.ravel();A=acc.ravel()
state=np.zeros(H*W,np.int8);last=np.full(H*W,-1,np.int64);gap=np.zeros(H*W,np.int32);bestacc=np.zeros(H*W,np.float32)
cross=[]
t0=time.time()
Cl=C.tolist()
for k in order.tolist():
    c=Cl[k]
    st=state[k];la=last[k];gp=gap[k]
    if c==1 or c==2 or c==3:
        if st!=0 and st!=c:
            cross.append((k,la,gp,int(st),c))
        st=c;la=k;gp=0
    else:
        gp+=1
    d=di[k]
    if d>=0 and A[k]>bestacc[d]:
        bestacc[d]=A[k];state[d]=st;last[d]=la;gap[d]=gp
print(len(order),time.time()-t0)
cr=pd.DataFrame(cross,columns=['k','ka','gap','from','to'])
cr['kind']=cr['from'].map({1:'A',2:'B',3:'N'})+cr['to'].map({1:'A',2:'B',3:'N'})
print(cr.kind.value_counts())
cr.to_pickle('work/gcross.pkl')
