// ========= js/metrics/calc.js (hybrid refresh, slim + Crossbite) =========
import {
  vAdd, vSub, vDot, vCross, vLen, vNrm, centroid, projOnPlane,
  pick, collectLowerPosteriorBuccal, projectToFrame, framePretty as _framePretty,
  round1, dist3
} from './utils.js';

/* ======================================================================= */
/* ========== Module #1: Occlusal Frame（X=前后, Y=左右, Z=上下） ========== */
/* ======================================================================= */

// --- 小工具：右手系正交化（以 ez 为锚） ---
function _reOrthoRH(ex, ey, ez){
  ez = vNrm(ez);
  // ex 去掉与 ez 的分量并归一
  const proj = vDot(ex, ez);
  ex = vNrm([ ex[0]-ez[0]*proj, ex[1]-ez[1]*proj, ex[2]-ez[2]*proj ]);
  // 由右手系定义 ey
  ey = vNrm(vCross(ez, ex));
  return { ex, ey, ez };
}

// --- 几何版：点云稳健 PCA + 截尾重估，得到近似咬合平面法向 ez、平面主轴 e1/e2 ---
function _buildFrameFromGeometry(points, cfg={}){
  const warnings=[];
  if(!points || points.length < 50){
    return { frame:null, quality:'missing', warnings:['insufficient points (<50)'], used:{ n_in:0, n_all:points?.length||0 } };
  }
  const maxPoints = cfg.maxPoints ?? 6000;
  const trimPct   = cfg.trimPct   ?? 0.5;

  // 均匀抽样
  const nAll = points.length;
  let idx = Array.from({length:nAll}, (_,i)=>i);
  if(nAll > maxPoints){
    const step = nAll / maxPoints;
    idx = Array.from({length:maxPoints}, (_,k)=>Math.floor(k*step));
  }
  const P = idx.map(i=>points[i]);

  const c0 = centroid(P);
  const cov3 = (Q,c)=>{
    let xx=0,xy=0,xz=0, yy=0,yz=0, zz=0;
    for(const q of Q){
      const x=q[0]-c[0], y=q[1]-c[1], z=q[2]-c[2];
      xx+=x*x; xy+=x*y; xz+=x*z; yy+=y*y; yz+=y*z; zz+=z*z;
    }
    const s = 1/Q.length;
    return [[xx*s,xy*s,xz*s],[xy*s,yy*s,yz*s],[xz*s,yz*s,zz*s]];
  };
  const eigMaxVec = (A, avoid=null)=>{
    let v = [1,0,0];
    if(avoid){
      // 初始化时与 avoid 近正交
      v = [Math.random(),Math.random(),Math.random()];
      const pr = vDot(v, avoid);
      v = vNrm(vSub(v, [avoid[0]*pr, avoid[1]*pr, avoid[2]*pr]));
    }
    for(let it=0; it<16; it++){
      const w = [
        A[0][0]*v[0] + A[0][1]*v[1] + A[0][2]*v[2],
        A[1][0]*v[0] + A[1][1]*v[1] + A[1][2]*v[2],
        A[2][0]*v[0] + A[2][1]*v[1] + A[2][2]*v[2],
      ];
      if(avoid){
        const pr = vDot(w, avoid);
        w[0]-=avoid[0]*pr; w[1]-=avoid[1]*pr; w[2]-=avoid[2]*pr;
      }
      v = vNrm(w);
    }
    return vNrm(v);
  };

  // 第一次 PCA
  const A0  = cov3(P, c0);
  const e1_0 = eigMaxVec(A0);
  const e2_0 = eigMaxVec(A0, e1_0);
  let ez0 = vNrm(vCross(e1_0, e2_0));

  // 截尾重估（剔除离平面远的点）
  const distToPlane = (q, c, n)=>Math.abs(vDot(vSub(q,c), n));
  const dists = P.map(p=>distToPlane(p,c0,ez0));
  const order = dists.map((d,i)=>[d,i]).sort((a,b)=>a[0]-b[0]);
  const keepN = Math.max(100, Math.floor(order.length * Math.max(0.2, Math.min(0.9, trimPct))));
  const keptIdx = order.slice(0, keepN).map(x=>x[1]);
  const Pin = keptIdx.map(i=>P[i]);
  const cin = centroid(Pin);
  const A1  = cov3(Pin, cin);
  const e1  = eigMaxVec(A1);
  const e2  = eigMaxVec(A1, e1);
  let ez = vNrm(vCross(e1, e2)); // 法向

  // 在平面内找左右端 + 前端锚点
  const proj2 = (q)=>{ const v=vSub(q,cin); return {x:vDot(v,e1), y:vDot(v,e2), ref:q}; };
  const P2 = Pin.map(proj2);

  // 质心最远点 A，再找距 A 最远点 B
  const c2={x:0,y:0}; for(const p of P2){ c2.x+=p.x; c2.y+=p.y; } c2.x/=P2.length; c2.y/=P2.length;
  let iA=0, best=-1; for(let i=0;i<P2.length;i++){ const dx=P2[i].x-c2.x, dy=P2[i].y-c2.y; const d=dx*dx+dy*dy; if(d>best){best=d;iA=i;} }
  const farFrom = (arr, i0)=>{ let bi=0, bd=-1; const a=arr[i0]; for(let i=0;i<arr.length;i++){ const dx=arr[i].x-a.x, dy=arr[i].y-a.y; const d=dx*dx+dy*dy; if(d>bd){bd=d;bi=i;} } return bi; };
  const iB = farFrom(P2, iA);

  // 以 A,B 中点为基准，寻找最远点 F（近似前方）
  const M2={x:(P2[iA].x+P2[iB].x)/2, y:(P2[iA].y+P2[iB].y)/2};
  let iF=0, bestF=-1; for(let i=0;i<P2.length;i++){ const dx=P2[i].x-M2.x, dy=P2[i].y-M2.y; const d=dx*dx+dy*dy; if(d>bestF){bestF=d;iF=i;} }

  // 构造 ex/ey（未定号），再正交化为右手系
  const pA=P2[iA], pB=P2[iB], pF=P2[iF];
  const isALeft = pA.y >= pB.y;
  const pL = isALeft ? pA : pB;
  const pR = isALeft ? pB : pA;
  const y_dir2 = vNrm([pL.x - pR.x, pL.y - pR.y, 0]);      // 平面内左右向
  const x_dir2 = vNrm([pF.x - M2.x, pF.y - M2.y, 0]);      // 平面内前后向

  // 回到 3D
  let ex = vNrm([ e1[0]*x_dir2[0] + e2[0]*x_dir2[1], e1[1]*x_dir2[0] + e2[1]*x_dir2[1], e1[2]*x_dir2[0] + e2[2]*x_dir2[1] ]);
  let ey = vNrm([ e1[0]*y_dir2[0] + e2[0]*y_dir2[1], e1[1]*y_dir2[0] + e2[1]*y_dir2[1], e1[2]*y_dir2[0] + e2[2]*y_dir2[1] ]);
  ({ex,ey,ez} = _reOrthoRH(ex, ey, ez));

  // 原点选 M 的 3D 位置
  const origin = [
    cin[0] + e1[0]*M2.x + e2[0]*M2.y,
    cin[1] + e1[1]*M2.x + e2[1]*M2.y,
    cin[2] + e1[2]*M2.x + e2[2]*M2.y,
  ];

  // 平面拟合质量（RMS）
  const rms = Math.sqrt(order.slice(0, keepN).reduce((s,[d])=>s+d*d,0)/keepN);
  if(rms > 1.5) warnings.push(`large plane RMS ~ ${rms.toFixed(2)} mm`);

  return {
    frame:{ origin, ex, ey, ez },
    quality: warnings.length?'fallback':'ok',
    warnings,
    used:{ n_in:keepN, n_all:nAll, posterior_pair:[idx[keptIdx[iA]]??iA, idx[keptIdx[iB]]??iB], anterior_idx: idx[keptIdx[iF]]??iF }
  };
}

// --- 旧版（仅 landmarks）平面估计：无点云时的回退 ---
function _buildFrameFromLandmarks(landmarks){
  const warnings=[], used={};
  // posterior buccal 样本；不足则用全部点位
  let samples = collectLowerPosteriorBuccal(landmarks);
  used.sample_count = samples.length;
  if(samples.length < 3){
    warnings.push(`posterior buccal < 3, using all points`);
    samples = Object.values(landmarks).filter(p => Array.isArray(p) && p.length === 3);
  }
  if(samples.length < 3){
    return { frame:null, quality:'missing', warnings:['insufficient points'], used };
  }
  const o = centroid(samples);

  // 面积法估法向（与旧实现一致）
  let n=[0,0,0];
  for(let i=0;i<samples.length;i++){
    const vi=vSub(samples[i],o);
    for(let j=i+1;j<samples.length;j++){
      const vj=vSub(samples[j],o);
      n = vAdd(n, vCross(vi, vj));
    }
  }
  let ez = vLen(n) ? vNrm(n) : [0,0,1];

  // Y 初始方向（投影平均）
  let dir = samples.reduce((acc,p)=>vAdd(acc, projOnPlane(vSub(p,o), ez)), [0,0,0]);
  let ey = vLen(dir) ? vNrm(dir) : [1,0,0];

  // X = Y × Z；再回算 Y
  let ex = vNrm(vCross(ey, ez));
  ey = vNrm(vCross(ez, ex));
  return { frame:{ origin:o, ex, ey, ez }, quality:'fallback', warnings, used };
}

/**
 * 混合式坐标系：几何优先 + 少量关键点校准
 * @param landmarks 必填：用于少量校准点（11/31、33/43、16/26、36/46）
 * @param geomPoints 可选：STL 顶点点云 [[x,y,z],...]；提供时优先采用几何法
 * @param cfg 可选：{ maxPoints, trimPct }
 */
export function buildOcclusalFrame(landmarks, geomPoints=null, cfg={}){
  // 1) 主体：几何点云 → 稳健 frame；没有点云就用 landmarks 回退
  const base = Array.isArray(geomPoints) && geomPoints.length>50 && Array.isArray(geomPoints[0])
    ? _buildFrameFromGeometry(geomPoints, cfg)
    : _buildFrameFromLandmarks(landmarks);

  if(!base.frame) return base;

  let { origin, ex, ey, ez } = base.frame;
  const warnings = [...(base.warnings||[])];
  const used = { ...(base.used||{}), z_from:'geometry', y_from:'geometry', x_from:'geometry' };
  let quality = base.quality;

  // 2) Z 极性：用 11m/31m 或 21m/41m 的相对方向（上 - 下）校正 ez
  const U11 = pick(landmarks,['11m']), U21 = pick(landmarks,['21m']);
  const L31 = pick(landmarks,['31m']), L41 = pick(landmarks,['41m']);
  const Uc = (U11&&U21)? [(U11[0]+U21[0])/2,(U11[1]+U21[1])/2,(U11[2]+U21[2])/2] : (U11||U21);
  const Lc = (L31&&L41)? [(L31[0]+L41[0])/2,(L31[1]+L41[1])/2,(L31[2]+L41[2])/2] : (L31||L41);

  if(Uc && Lc){
    if (vDot(vSub(Uc,Lc), ez) < 0){
      ez = [-ez[0],-ez[1],-ez[2]]; // 翻转 Z
      ex = [-ex[0],-ex[1],-ex[2]]; // 同步翻转 X 保持右手系
      ({ex,ey,ez} = _reOrthoRH(ex, ey, ez));
    }
    used.z_from = 'incisors(11/21 vs 31/41)';
  }else{
    warnings.push('Z calibration skipped (need 11/21 & 31/41)');
    quality = quality==='ok' ? 'fallback' : quality;
  }

  // 3) Y 号向：33m→43m，保证 ey 指向 右→左
  const L33 = pick(landmarks, ['33m']) || pick(landmarks,['33mc']);
  const R43 = pick(landmarks, ['43m']) || pick(landmarks,['43mc']);
  if(L33 && R43){
    const yref = vSub(L33, R43); // 右→左
    if (vDot(yref, ey) < 0){
      ey = [-ey[0],-ey[1],-ey[2]];
      ex = vNrm(vCross(ey, ez));
    }
    used.y_from = 'canines(33→43)';
  }else{
    warnings.push('Y orientation skipped (need 33m & 43m)');
    quality = quality==='ok' ? 'fallback' : quality;
  }

  // 4) X 微调：前/后中线点在咬合平面内的方向
  const mid = (a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];

  const UFront = (U11 && U21) ? mid(U11,U21) : null;
  const LFront = (L31 && L41) ? mid(L31,L41) : null;
  let A = null, xFrom = [];
  if (UFront && LFront){ A = mid(UFront, LFront); xFrom.push('mid(mid11-21, mid31-41)'); }
  else if (UFront){ A = UFront; xFrom.push('mid(11,21)'); }
  else if (LFront){ A = LFront; xFrom.push('mid(31,41)'); }

  const L36 = pick(landmarks,['36mb']) || pick(landmarks,['36m']);
  const R46 = pick(landmarks,['46mb']) || pick(landmarks,['46m']);
  const U16 = pick(landmarks,['16mb']) || pick(landmarks,['16m']);
  const U26 = pick(landmarks,['26mb']) || pick(landmarks,['26m']);
  let P=null;
  if (L36 && R46){ P = mid(L36, R46); xFrom.push('mid(36,46)'); }
  else if (U16 && U26){ P = mid(U16, U26); xFrom.push('mid(16,26)'); }

  if (A && P){
    let dx = vSub(A, P);
    const h = vDot(dx, ez);
    dx = [ dx[0]-ez[0]*h, dx[1]-ez[1]*h, dx[2]-ez[2]*h ]; // 去垂直分量
    if (vLen(dx) > 1e-6){
      let exNew = vNrm(dx);
      if (vDot(exNew, ex) < 0) exNew = [-exNew[0], -exNew[1], -exNew[2]]; // 避免 180° 翻转
      ex = exNew;
      ({ex,ey,ez} = _reOrthoRH(ex, ey, ez));
      used.x_from = xFrom.join(' + ');
    }
  }else{
    warnings.push('X fine-tune skipped (need anterior & posterior midline points)');
    quality = quality==='ok' ? 'fallback' : quality;
  }

  const frame = { origin, ex, ey, ez };
  return { frame, quality, warnings, used };
}

export const framePretty = _framePretty; // 复用 utils 的文本化

/* ======================================================================= */
/* ========== Module #2: Spee（下颌曲度） — 保持既有语义 ================== */
/* ======================================================================= */
const _mid = (a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];

/**
 * Spee 曲线曲度（mm）
 * 端点弦：A=下中切牙近中切角代表点；B=最远中的下二磨远中颊尖(或回退)
 * 采样：33m,34b,35b,36mb,36db,37mb,37db,43m,44b,45b,46mb,46db,47mb,47db（位于 A-B 的 AP 区间）
 */
export function computeSpeeLowerDepth(landmarks, frame){
  const used = { samples:[], A_name:null, B_name:null };
  const warn = [];

  // A
  const P31ma = pick(landmarks, ['31ma']);
  const P41ma = pick(landmarks, ['41ma']);
  let A3D=null; let Aname=null;
  if(P31ma && P41ma){ A3D=_mid(P31ma,P41ma); Aname='mid(31ma,41ma)'; }
  else if(P31ma){ A3D=P31ma; Aname='31ma'; }
  else if(P41ma){ A3D=P41ma; Aname='41ma'; }
  else {
    const P31m = pick(landmarks, ['31m']);
    const P41m = pick(landmarks, ['41m']);
    if(P31m && P41m){ A3D=_mid(P31m,P41m); Aname='mid(31m,41m)'; warn.push('fallback A: ma missing, used m'); }
    else if(P31m){ A3D=P31m; Aname='31m'; warn.push('fallback A: ma missing, used 31m'); }
    else if(P41m){ A3D=P41m; Aname='41m'; warn.push('fallback A: ma missing, used 41m'); }
  }
  if(!A3D) return { depth_mm:null, chord:{A:null,B:null}, used, quality:'missing', method:'perp_to_chord_sagittal' };
  used.A_name = Aname;

  // B candidates
  const candB = ['37db','47db','37mb','47mb','36db','46db','36mb','46mb']
    .map(nm => ({ nm, p: pick(landmarks, [nm]) }))
    .filter(o => !!o.p);
  if(candB.length===0) return { depth_mm:null, chord:{A:A3D,B:null}, used, quality:'missing', method:'perp_to_chord_sagittal' };

  // X=AP，+X 向前；远中=后方 → 取 x 最小
  let Bpick = candB[0], Bx = projectToFrame(Bpick.p, frame).x;
  for(const c of candB){ const x = projectToFrame(c.p, frame).x; if(x < Bx){ Bx=x; Bpick=c; } }
  const B3D = Bpick.p; used.B_name = Bpick.nm;
  const chordNotes = (Bpick.nm.startsWith('37')||Bpick.nm.startsWith('47')) ? 'distal=second molar' : 'distal=fallback first molar';

  // 采样
  const names = ['33m','34b','35b','36mb','36db','37mb','37db','43m','44b','45b','46mb','46db','47mb','47db'];
  const S3D=[], A2=projectToFrame(A3D,frame), B2=projectToFrame(B3D,frame);
  const xmin=Math.min(A2.x,B2.x), xmax=Math.max(A2.x,B2.x);
  for(const nm of names){
    const p = pick(landmarks, [nm]);
    if(!p) continue;
    const pr = projectToFrame(p, frame);
    if(pr.x >= xmin-1e-6 && pr.x <= xmax+1e-6){ S3D.push(p); used.samples.push(nm); }
  }
  if(S3D.length<2) warn.push('few buccal samples between A and B');

  // 计算：矢状面内到弦的“向下”最大垂距
  const ux=B2.x-A2.x, uz=B2.z-A2.z, L=Math.hypot(ux,uz)||1e-9;
  const u={x:ux/L,z:uz/L}; let n={x:-u.z,z:u.x}; if(n.z>0){n.x=-n.x;n.z=-n.z;}
  const useVertical = Math.abs(n.z)<1e-3;
  let depth=0;
  const evalP=(p3)=>{
    const p = projectToFrame(p3, frame);
    const wx=p.x-A2.x, wz=p.z-A2.z, t=wx*u.x+wz*u.z;
    if(t<-1e-6 || t>L+1e-6) return;
    if(useVertical){
      const zc=A2.z+t*u.z; const dz=zc-p.z; if(dz>depth) depth=dz;
    }else{
      const d=wx*n.x+wz*n.z; if(d>depth) depth=d;
    }
  };
  for(const p of S3D) evalP(p);
  if(S3D.length<2){
    for(const nm of ['33m','43m','36mb','36db','46mb','46db','37mb','37db','47mb','47db']){
      const p=pick(landmarks,[nm]); if(p) evalP(p);
    }
  }

  return {
    depth_mm: round1(depth),
    chord: { A:A3D, B:B3D, notes: chordNotes },
    used,
    quality: warn.length?'fallback':'ok',
    method: useVertical ? 'vertical_fallback' : 'perp_to_chord_sagittal'
  };
}

/* ======================================================================= */
/* ========== Module #3: Bolton（前牙比 & 全牙比） ======================== */
/* ======================================================================= */
function mdWidthOfTooth(landmarks, toothFDI, opt={}){
  const mc = pick(landmarks, [toothFDI+'mc']);
  const dc = pick(landmarks, [toothFDI+'dc']);
  if(!mc || !dc) return { width:null };
  if(opt.use_plane && opt.frame){
    const a = projectToFrame(mc, opt.frame), b = projectToFrame(dc, opt.frame);
    return { width: Math.hypot(a.x-b.x, a.y-b.y) };
  }
  return { width: dist3(mc,dc) };
}

export function computeBolton(landmarks, cfg={}){
  const targets = { anterior:77.2, overall:91.3, ...(cfg.targets||{}) };
  const ANT_UP = ['13','12','11','21','22','23'];
  const ANT_LO = ['33','32','31','41','42','43'];
  const ALL_UP = ['16','15','14','13','12','11','21','22','23','24','25','26'];
  const ALL_LO = ['46','45','44','43','42','41','31','32','33','34','35','36'];
  const opt = { use_plane: !!cfg.use_plane, frame: cfg.frame };

  const sum = (list)=> {
    let S=0, ok=true, per={}, miss=[];
    for(const t of list){
      const { width } = mdWidthOfTooth(landmarks, t, opt);
      per[t] = width==null ? null : round1(width);
      if(width==null){ ok=false; miss.push(t); } else S+=width;
    }
    return { sum: ok?S:null, per, missing:miss };
  };

  const upA=sum(ANT_UP), loA=sum(ANT_LO);
  const upO=sum(ALL_UP), loO=sum(ALL_LO);

  const anterior = {
    upper_sum_mm: upA.sum==null?null:round1(upA.sum),
    lower_sum_mm: loA.sum==null?null:round1(loA.sum),
    ratio_pct: (upA.sum&&loA.sum)? round1(loA.sum/upA.sum*100): null,
    target_pct: targets.anterior,
    lower_excess_mm: (upA.sum&&loA.sum)? round1(loA.sum - targets.anterior/100*upA.sum): null,
    upper_excess_mm: (upA.sum&&loA.sum)? round1(upA.sum - (loA.sum*100/targets.anterior)): null,
    per_tooth_mm: { ...upA.per, ...loA.per },
    missing: [...upA.missing, ...loA.missing]
  };
  const overall = {
    upper_sum_mm: upO.sum==null?null:round1(upO.sum),
    lower_sum_mm: loO.sum==null?null:round1(loO.sum),
    ratio_pct: (upO.sum&&loO.sum)? round1(loO.sum/upO.sum*100): null,
    target_pct: targets.overall,
    lower_excess_mm: (upO.sum&&loO.sum)? round1(loO.sum - targets.overall/100*upO.sum): null,
    upper_excess_mm: (upO.sum&&loO.sum)? round1(upO.sum - (loO.sum*100/targets.overall)): null,
    per_tooth_mm: { ...upO.per, ...loO.per },
    missing: [...upO.missing, ...loO.missing]
  };
  return { anterior, overall };
}

/* ======================================================================= */
/* ========== Module #4: Crossbite_锁牙合（侧别判定） ===================== */
/* ======================================================================= */
/**
 * Crossbite / 锁牙合（侧别判定）
 * 规则（单侧）：
 *  - 正锁： mean(Upper-Lingual, buccalness) > mean(Lower-Buccal, buccalness) + t
 *  - 反锁： mean(Upper-Buccal, buccalness) < mean(Lower-Lingual, buccalness) - t
 * 其中 buccalness = sideSign * Y（左侧 +1，右侧 -1，使“数值越大=越颊侧”跨侧一致）
 *
 * @param landmarks  点位字典
 * @param frame      咬合坐标系（必须）
 * @param cfg        { threshold_mm=1.5, min_pairs=2 }
 * @return { left:{status, deltas, counts, used, warnings}, right:{...}, threshold_mm, quality, warnings }
 */
export function computeCrossbiteLock(landmarks, frame, cfg = {}){
  const t = cfg.threshold_mm ?? 1.5;
  const minPairs = cfg.min_pairs ?? 2;
  const warnings = [];
  if(!frame) return { left:null, right:null, threshold_mm:t, quality:'missing', warnings:['no frame'] };

  // ——— 工具：取首个存在的标记点；投影到 frame 取 y ———
  const pickOne = (names)=>{
    for(const nm of names){
      const p = landmarks?.[nm];
      if(Array.isArray(p) && p.length===3) return { name:nm, p };
    }
    return null;
  };
  const yOf = (p)=> projectToFrame(p, frame).y;

  // ——— 侧别定义与牙位列表（首选 4、5、6、7；按你的数据可增减）———
  const TEETH = {
    right: { // 1x / 4x
      upper: ['14','15','16','17'],
      lower: ['44','45','46','47'],
      sideSign: -1
    },
    left:  { // 2x / 3x
      upper: ['24','25','26','27'],
      lower: ['34','35','36','37'],
      sideSign: +1
    }
  };

  // ——— 每颗牙提取 buccal / lingual 的候选标记 ———
  const BUCCAL_CANDS  = (t)=>[`${t}mb`, `${t}db`, `${t}b`, `${t}bg`];
  const LINGUAL_CANDS = (t)=>[`${t}ml`, `${t}dl`, `${t}l`, `${t}lgb`];

  function collectSide(archList, which){
    const usedNames = [];
    const ys = [];
    for(const tooth of archList){
      const hit = pickOne(which==='buccal' ? BUCCAL_CANDS(tooth) : LINGUAL_CANDS(tooth));
      if(hit){ ys.push(yOf(hit.p)); usedNames.push(hit.name); }
    }
    return { ys, usedNames };
  }

  function sideEval(sideKey){
    const side = TEETH[sideKey];
    const sgn = side.sideSign;

    // 取四组：U-Lingual, U-Buccal, L-Lingual, L-Buccal
    const UL = collectSide(side.upper, 'lingual');
    const UB = collectSide(side.upper, 'buccal');
    const LL = collectSide(side.lower, 'lingual');
    const LB = collectSide(side.lower, 'buccal');

    const buccalize = arr => arr.map(y => sgn * y);
    const mean = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : NaN;

    const m_UL = mean(buccalize(UL.ys));
    const m_UB = mean(buccalize(UB.ys));
    const m_LL = mean(buccalize(LL.ys));
    const m_LB = mean(buccalize(LB.ys));

    const counts = { UL:UL.ys.length, UB:UB.ys.length, LL:LL.ys.length, LB:LB.ys.length };
    const used = { UL:UL.usedNames, UB:UB.usedNames, LL:LL.usedNames, LB:LB.usedNames };
    const sideWarnings = [];

    // 需要至少 minPairs 个有效牙位参与（任意组不足将降级为 fallback）
    const enoughA = counts.UL >= minPairs && counts.LB >= minPairs;
    const enoughB = counts.UB >= minPairs && counts.LL >= minPairs;
    if(!enoughA) sideWarnings.push(`few UL/LB points (need ≥${minPairs})`);
    if(!enoughB) sideWarnings.push(`few UB/LL points (need ≥${minPairs})`);

    // 两个关键差值（越大表示“更向颊侧”）
    const delta_UL_vs_LB = (Number.isFinite(m_UL) && Number.isFinite(m_LB)) ? (m_UL - m_LB) : null;
    const delta_UB_vs_LL = (Number.isFinite(m_UB) && Number.isFinite(m_LL)) ? (m_UB - m_LL) : null;

    // 判定
    let status = '无';
    if (enoughA && delta_UL_vs_LB!=null && delta_UL_vs_LB > t) status = '正锁';
    else if (enoughB && delta_UB_vs_LL!=null && delta_UB_vs_LL < -t) status = '反锁';
    else if ((!enoughA && !enoughB) || (delta_UL_vs_LB==null && delta_UB_vs_LL==null)) status = 'missing';

    return {
      status,
      deltas: {
        UL_vs_LB_mm: delta_UL_vs_LB==null ? null : round1(delta_UL_vs_LB),
        UB_vs_LL_mm: delta_UB_vs_LL==null ? null : round1(delta_UB_vs_LL)
      },
      counts,
      used,
      warnings: sideWarnings
    };
  }

  const right = sideEval('right');
  const left  = sideEval('left');

  const have = (right.status!=='missing') || (left.status!=='missing');
  const quality = have ? ((right.warnings.length||left.warnings.length)?'fallback':'ok') : 'missing';
  return { right, left, threshold_mm:t, quality, warnings };
}
/* ======================================================================= */
/* ========== Module #5: Midline_Alignment（牙列中线） ==================== */
/* ======================================================================= */
/**
 * 牙列中线（相对正中矢状面 Y=0 的横向偏移）
 * - 上中线点：优先 mid(11ma,21ma) → 退 mid(11m,21m) → 单点（11/21 任一）
 * - 下中线点：优先 mid(31ma,41ma) → 退 mid(31m,41m) → 单点（31/41 任一）
 * - 方向约定：frame.ey 指向 “右→左”，所以 y>0=左，y<0=右
 *
 * @param landmarks 点位字典
 * @param frame     咬合坐标系（必须）
 * @param cfg       { sagittal_threshold_mm?:number, align_threshold_mm?:number, center_tolerance_mm?:number }
 *                  - sagittal_threshold_mm: 判定“与人体中线是否偏移”的参考（默认 1.0 mm）
 *                  - align_threshold_mm: 判定“上下是否一致”的阈值（默认 1.0 mm）
 *                  - center_tolerance_mm: 判定“居中”的容差（默认 0.25 mm，仅用于文案）
 * @return {
 *   upper:{ y_mm, offset_mm, side, point, used_name, within_sagittal:boolean }|null,
 *   lower:{ ... }|null,
 *   diff_upper_lower_mm:number|null,
 *   agreement:'一致'|'不一致'|'missing',
 *   thresholds:{ sagittal_mm, align_mm, center_mm },
 *   quality:'ok'|'fallback'|'missing',
 *   warnings:string[]
 * }
 */
export function computeMidlineAlignment(landmarks, frame, cfg = {}){
  const tSag   = cfg.sagittal_threshold_mm ?? 1.0;  // “相对人体中线”是否偏移
  const tAlign = cfg.align_threshold_mm    ?? 1.0;  // “上下是否一致”
  const tZero  = cfg.center_tolerance_mm   ?? 0.25; // 文案上的“居中”容差
  const warnings = [];

  if(!frame) return {
    upper:null, lower:null, diff_upper_lower_mm:null,
    agreement:'missing',
    thresholds:{ sagittal_mm:tSag, align_mm:tAlign, center_mm:tZero },
    quality:'missing', warnings:['no frame']
  };

  const mid = (a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
  const getUpper = ()=>{
    const U11ma = pick(landmarks,['11ma']), U21ma = pick(landmarks,['21ma']);
    const U11m  = pick(landmarks,['11m' ]), U21m  = pick(landmarks,['21m' ]);
    if (U11ma && U21ma) return { p: mid(U11ma,U21ma), used:'mid(11ma,21ma)' };
    if (U11m  && U21m ) return { p: mid(U11m ,U21m ), used:'mid(11m,21m)' };
    if (U11m) return { p: U11m, used:'11m (single)' };
    if (U21m) return { p: U21m, used:'21m (single)' };
    if (U11ma) return { p: U11ma, used:'11ma (single)' };
    if (U21ma) return { p: U21ma, used:'21ma (single)' };
    return { p:null, used:null };
  };
  const getLower = ()=>{
    const L31ma = pick(landmarks,['31ma']), L41ma = pick(landmarks,['41ma']);
    const L31m  = pick(landmarks,['31m' ]), L41m  = pick(landmarks,['41m' ]);
    if (L31ma && L41ma) return { p: mid(L31ma,L41ma), used:'mid(31ma,41ma)' };
    if (L31m  && L41m ) return { p: mid(L31m ,L41m ), used:'mid(31m,41m)' };
    if (L31m) return { p: L31m, used:'31m (single)' };
    if (L41m) return { p: L41m, used:'41m (single)' };
    if (L31ma) return { p: L31ma, used:'31ma (single)' };
    if (L41ma) return { p: L41ma, used:'41ma (single)' };
    return { p:null, used:null };
  };

  const U = getUpper();
  const L = getLower();

  let quality = 'ok';
  if(!U.p) { warnings.push('upper midline landmarks missing'); quality = 'fallback'; }
  if(!L.p) { warnings.push('lower midline landmarks missing'); quality = 'fallback'; }
  if(!U.p && !L.p){ return {
      upper:null, lower:null, diff_upper_lower_mm:null,
      agreement:'missing',
      thresholds:{ sagittal_mm:tSag, align_mm:tAlign, center_mm:tZero },
      quality:'missing', warnings
    };
  }

  const sideLabel = (y)=> (y < -tZero ? '右偏' : (y > tZero ? '左偏' : '居中'));

  const upper = U.p ? (()=> {
    const pu = projectToFrame(U.p, frame);
    const y  = pu.y;
    return {
      y_mm: round1(y),
      offset_mm: round1(Math.abs(y)),
      side: sideLabel(y),
      point: U.p,
      used_name: U.used,
      within_sagittal: Math.abs(y) <= tSag
    };
  })() : null;

  const lower = L.p ? (()=> {
    const pl = projectToFrame(L.p, frame);
    const y  = pl.y;
    return {
      y_mm: round1(y),
      offset_mm: round1(Math.abs(y)),
      side: sideLabel(y),
      point: L.p,
      used_name: L.used,
      within_sagittal: Math.abs(y) <= tSag
    };
  })() : null;

  let diff=null, agreement='missing';
  if(upper && lower){
    diff = projectToFrame(U.p, frame).y - projectToFrame(L.p, frame).y; // + 表示“上更左”
    agreement = (Math.abs(diff) <= tAlign) ? '一致' : '不一致';
  }

  return {
    upper, lower,
    diff_upper_lower_mm: diff==null ? null : round1(diff),
    agreement,
    thresholds:{ sagittal_mm:tSag, align_mm:tAlign, center_mm:tZero },
    quality, warnings
  };
}
/* ======================================================================= */
/* ========== Module #6: Crowding_拥挤度（Gap + ALD 有符号） ============== */
/* ======================================================================= */
/**
 * 拥挤度两种量化同时给：
 *  - gap_sum_mm：相邻牙解剖邻接点（dc↔mc）在与咬合平面平行的平面（XY）上的距离之和（原算法）
 *  - ald_mm：有符号 ALD（available − required）
 *      available = gap_sum_mm（同上）
 *      required  = 该段牙齿 MD 径宽之和（mc↔dc）
 *    >0 = 间隙；<0 = 拥挤
 *
 * cfg = {
 *   arch: 'upper'|'lower'|'both' (默认 both),
 *   segment: 'anterior' (默认；如需自定义用 pairs/teeth 覆盖),
 *   use_plane: true     (true=在 XY 测量；false=3D),
 *   pairs?: Array<[string,string]>   // 自定义相邻对（用于 available/gap）
 *   teeth?: string[]                 // 自定义牙位序列（用于 required/ALD）
 *   min_pairs?: number  (默认3)，min_teeth?: number (默认4)
 * }
 */
export function computeCrowding(landmarks, frame, cfg = {}){
  const arch = cfg.arch || 'both';
  const segment = cfg.segment || 'anterior';
  const usePlane = cfg.use_plane !== false; // 默认 true
  const minPairs = cfg.min_pairs ?? 3;
  const minTeeth = cfg.min_teeth ?? 4;
  const globalWarnings = [];

  if(usePlane && !frame){
    return { upper:null, lower:null, quality:'missing', warnings:['no frame (use_plane=true)'] };
  }

  // 默认前牙序列（按患者视角：左→右）
  const U_ANT = ['23','22','21','11','12','13'];
  const L_ANT = ['33','32','31','41','42','43'];

  const buildPairsFromSeq = (seq)=> seq.slice(0, -1).map((_,i)=> [seq[i], seq[i+1]]);

  // —— 接触点/宽度工具 ——
  const getContact = (tooth, kind)=> {
    if(kind==='mc'){
      return pick(landmarks, [ `${tooth}mc`, `${tooth}mr`, `${tooth}m` ]);
    }else{ // 'dc'
      return pick(landmarks, [ `${tooth}dc`, `${tooth}dr` ]);
    }
  };
  const widthOf = (tooth)=>{
    const { width } = mdWidthOfTooth(landmarks, tooth, { use_plane:usePlane, frame });
    return width;
  };

  // —— 可用空间（available / gap）——
  const measurePairs = (pairs)=>{
    const per = {};
    const used = [];
    const missing = [];
    let sum = 0;

    for(const [L, R] of pairs){
      const pL = getContact(L, 'dc');
      const pR = getContact(R, 'mc');
      const key = `${L}-${R}`;
      if(!pL || !pR){
        per[key] = null;
        missing.push(key);
        continue;
      }
      let d;
      if(usePlane){
        const a = projectToFrame(pL, frame);
        const b = projectToFrame(pR, frame);
        d = Math.hypot(a.x - b.x, a.y - b.y); // 与咬合平面平行（忽略 Z）
      }else{
        d = dist3(pL, pR); // 3D
      }
      per[key] = round1(d);
      used.push({ pair:key, left_point:`${L}dc`, right_point:`${R}mc` });
      sum += d;
    }
    const nValid = Object.values(per).filter(v => typeof v === 'number').length;
    const warnings = [];
    if(missing.length) warnings.push(`missing contacts: ${missing.join(', ')}`);
    if(nValid < minPairs) warnings.push(`few valid pairs (${nValid} < ${minPairs})`);

    return {
      gap_sum_mm: nValid ? round1(sum) : null, // available
      per_pair_mm: per,
      pairs_used: used,
      missing_pairs: missing,
      n_pairs: nValid,
      warnings
    };
  };

  // —— 需求空间（required）——
  const measureTeeth = (teeth)=>{
    const per = {};
    let sum = 0; let nValid = 0; const miss = [];
    for(const t of teeth){
      const w = widthOf(t);
      if(w==null){ per[t]=null; miss.push(t); }
      else { per[t]=round1(w); sum+=w; nValid++; }
    }
    const warnings = [];
    if(miss.length) warnings.push(`missing widths: ${miss.join(', ')}`);
    if(nValid < minTeeth) warnings.push(`few valid teeth (${nValid} < ${minTeeth})`);
    return {
      required_sum_mm: nValid? round1(sum) : null,
      per_tooth_width_mm: per,
      missing_teeth: miss,
      n_teeth: nValid,
      warnings
    };
  };

  // —— 选择对/牙 ——（可被 cfg 覆盖）
  const defSeqU = (segment==='anterior') ? U_ANT : U_ANT; // 目前只做前牙段
  const defSeqL = (segment==='anterior') ? L_ANT : L_ANT;
  const upperPairs = cfg.pairs && arch!=='lower' ? cfg.pairs : buildPairsFromSeq(defSeqU);
  const lowerPairs = cfg.pairs && arch!=='upper' ? cfg.pairs : buildPairsFromSeq(defSeqL);
  const upperTeeth = cfg.teeth && arch!=='lower' ? cfg.teeth : defSeqU;
  const lowerTeeth = cfg.teeth && arch!=='upper' ? cfg.teeth : defSeqL;

  function assemble(pairs, teeth){
    const gap = measurePairs(pairs);
    const req = measureTeeth(teeth);

    const ald = (gap.gap_sum_mm!=null && req.required_sum_mm!=null)
      ? round1(gap.gap_sum_mm - req.required_sum_mm) : null;

    const signed_summary = (ald==null) ? null : (ald>=0 ? `间隙 +${round1(ald)} mm` : `拥挤 ${round1(-ald)} mm`);

    const method = usePlane ? 'plane_xy' : '3d';
    const warnings = [...gap.warnings, ...req.warnings];

    const quality =
      (gap.n_pairs===0 || req.n_teeth===0) ? 'missing'
      : (warnings.length ? 'fallback' : 'ok');

    // 简化：仅保留gap_sum_mm字段
    return {
      gap_sum_mm: gap.gap_sum_mm,
      required_sum_mm: req.required_sum_mm,
      ald_mm: ald,
      signed_summary,
      per_pair_mm: gap.per_pair_mm,
      per_tooth_width_mm: req.per_tooth_width_mm,
      pairs_used: gap.pairs_used,
      missing_pairs: gap.missing_pairs,
      missing_teeth: req.missing_teeth,
      n_pairs: gap.n_pairs,
      n_teeth: req.n_teeth,
      segment_teeth: teeth,
      method, quality, warnings
    };
  }

  const upper = (arch==='upper'||arch==='both') ? assemble(upperPairs, upperTeeth) : null;
  const lower = (arch==='lower'||arch==='both') ? assemble(lowerPairs, lowerTeeth) : null;

  // 汇总质量
  const parts = [upper, lower].filter(Boolean);
  let quality = 'missing'; const allWarn=[];
  if(parts.length){
    quality = parts.every(p=>p.quality==='ok') ? 'ok'
            : parts.some(p=>p.quality==='missing') ? 'missing'
            : 'fallback';
    for(const p of parts) allWarn.push(...(p.warnings||[]));
  }
  return { upper, lower, quality, warnings: allWarn };
}

/* ======================================================================= */
/* ========== Module #7: Molar_Relationship（磨牙关系：完全远中） ========= */
/* ======================================================================= */
/**
 * 判据（每侧）：
 *   上颌第一磨牙近中颊尖（16mb/26mb）与下颌第一磨牙近中边缘嵴中点（46mr/36mr；回退 mc）
 *   在 AP（X）方向“基本重合”，|ΔX| ≤ threshold_mm（默认 5mm） → “完全远中”
 * 仅输出是否“完全远中”，并给出 ΔX 数值与所用点位。
 */
export function computeMolarRelationship(landmarks, frame, cfg = {}){
  const t = cfg.threshold_mm ?? 5.0;
  const warnings = [];
  if(!frame) return { right:null, left:null, threshold_mm:t, quality:'missing', warnings:['no frame'] };

  const pickFirst = (names)=>{
    for(const nm of names){
      const p = pick(landmarks, [nm]);
      if(p) return { p, name:nm };
    }
    return { p:null, name:null };
  };

  const evalSide = ({ U_cand, L_cand })=>{
    const U = pickFirst(U_cand);
    const L = pickFirst(L_cand);
    const sideWarnings = [];
    if(!U.p) sideWarnings.push(`upper cusp missing (${U_cand.join('/')})`);
    if(!L.p) sideWarnings.push(`lower ridge missing (${L_cand.join('/')})`);
    if(!U.p || !L.p) return { status:'missing', delta_x_mm:null, used:{U_name:U.name, L_name:L.name}, warnings:sideWarnings };

    const ux = projectToFrame(U.p, frame).x;
    const lx = projectToFrame(L.p, frame).x;
    const dx = round1(ux - lx); // +：上更前，-：上更后
    const status = (Math.abs(dx) <= t) ? '完全远中' : '非完全远中';

    return { status, delta_x_mm:dx, used:{U_name:U.name, L_name:L.name}, warnings:sideWarnings };
  };

  // 右侧：16mb vs 46mr（回退 46mc）
  const right = evalSide({
    U_cand: ['16mb', '16db', '16bg'],
    L_cand: ['46mr', '46mc', '46m']
  });

  // 左侧：26mb vs 36mr（回退 36mc）
  const left = evalSide({
    U_cand: ['26mb', '26db', '26bg'],
    L_cand: ['36mr', '36mc', '36m']
  });

  const have = (right.status!=='missing') || (left.status!=='missing');
  const quality = have ? ((right.warnings.length||left.warnings.length)?'fallback':'ok') : 'missing';
  warnings.push(...right.warnings||[], ...left.warnings||[]);
  return { right, left, threshold_mm:t, quality, warnings };
}
// ─────────────────────────────────────────────────────────────────────────────
// Module #8 — Overbite_前牙覆𬌗（正中矢状面，切缘中点）
// 约定：OB = z_lower - z_upper（在咬合坐标系下、投影至 Y=0 后）；正=覆𬌗，负=开𬌗
// 依赖：frame={origin,ex,ey,ez}（单位向量，右手系），landmarks(单位:mm)
// 输入 landmarks 需包含 11/21/31/41 的切缘中点；可选 31/41 的龈缘中点用于冠高
// ─────────────────────────────────────────────────────────────────────────────
export function computeOverbite(landmarks, frame, options = {}) {
  const dec = options.dec ?? 2;

  // 允许外部传入 utils；否则用最小内置实现
  const U = options.utils ?? {
    dot: (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
    sub: (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]],
    dist: (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]),
    round: (x, k=2) => (x==null ? null : Math.round(x*10**k)/10**k),
    toLocal(p, f) {
      const v = this.sub(p, f.origin);
      return [this.dot(v, f.ex), this.dot(v, f.ey), this.dot(v, f.ez)];
    },
    toWorld(lp, f) { // 备用：本模块未用
      return [
        f.origin[0] + lp[0]*f.ex[0] + lp[1]*f.ey[0] + lp[2]*f.ez[0],
        f.origin[1] + lp[0]*f.ex[1] + lp[1]*f.ey[1] + lp[2]*f.ez[1],
        f.origin[2] + lp[0]*f.ex[2] + lp[1]*f.ey[2] + lp[2]*f.ez[2],
      ];
    },
    pick(landmarks, keys) {
      for (const k of keys) {
        const p = landmarks?.[k];
        if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) return {key:k, p};
      }
      return null;
    },
  };

  const sel = {
    // 上颌中切牙（切缘中点）
    U_right: options.selectors?.U_right ?? ["11m"],
    U_left : options.selectors?.U_left  ?? ["21m"],
    // 下颌中切牙（切缘中点）
    L_right: options.selectors?.L_right ?? ["41m"],
    L_left : options.selectors?.L_left  ?? ["31m"],
    // 下颌中切牙（龈缘/颈部中点，用于临床冠高；可选）
    L_crown_base_right: options.selectors?.L_crown_base_right ?? ["41bgb"],
    L_crown_base_left : options.selectors?.L_crown_base_left  ?? ["31bgb"],
  };

  const used = [];
  const warnings = [];
  const method = {
    plane: "mid-sagittal (Y=0) in occlusal frame",
    sign_convention: "OB = z_lower - z_upper; positive=overbite, negative=open bite",
    crown_height: "euclidean (incisal_mid -> gingival_mid) if provided",
    dec,
  };

  // 基础校验
  if (!frame?.origin || !frame?.ex || !frame?.ey || !frame?.ez) {
    return {
      kind: "Overbite_anterior",
      quality: "missing",
      value_mm: null,
      right_mm: null,
      left_mm: null,
      per_side: {},
      used, warnings: ["missing frame"], method,
    };
  }

  function projectToMidSagittal(localP) { return [localP[0], 0, localP[2]]; }

  function sideCalc(UpKeys, LwKeys, LwGingivalKeys) {
    const up = U.pick(landmarks, UpKeys);
    const lw = U.pick(landmarks, LwKeys);
    const ret = { ob_mm: null, crown_h_mm: null, ratio_ob_over_h: null, used: [], missing: [] };

    if (!up) ret.missing.push(UpKeys.join("|"));
    if (!lw) ret.missing.push(LwKeys.join("|"));
    if (!up || !lw) return ret;

    ret.used.push(up.key, lw.key);
    used.push(up.key, lw.key);

    // 到局部坐标并投影到正中矢状面
    const upL = projectToMidSagittal(U.toLocal(up.p, frame));
    const lwL = projectToMidSagittal(U.toLocal(lw.p, frame));

    // 关键定义：OB = z_lower - z_upper
    ret.ob_mm = lwL[2] - upL[2];

    // 临床冠高（可选）
    const g = U.pick(landmarks, LwGingivalKeys);
    if (g) {
      ret.used.push(g.key); used.push(g.key);
      ret.crown_h_mm = U.dist(lw.p, g.p); // 直接欧氏距离（常足够稳定）
      if (ret.crown_h_mm > 0) ret.ratio_ob_over_h = ret.ob_mm / ret.crown_h_mm;
    } else {
      ret.missing.push(LwGingivalKeys.join("|"));
    }

    // 常识性预警
    if (Math.abs(ret.ob_mm) > 20) warnings.push("overbite value exceeds 20 mm, please verify landmarks/frame");
    return ret;
  }

  const right = sideCalc(sel.U_right, sel.L_right, sel.L_crown_base_right);
  const left  = sideCalc(sel.U_left , sel.L_left , sel.L_crown_base_left);

  const haveR = right.ob_mm != null;
  const haveL = left.ob_mm != null;

  let quality = "ok";
  if (!haveR && !haveL) quality = "missing";
  else if (!(haveR && haveL)) quality = "fallback";

  const right_mm = U.round(right.ob_mm, dec);
  const left_mm  = U.round(left.ob_mm,  dec);
  const value_mm = (haveR && haveL)
    ? U.round(Math.max(right.ob_mm, left.ob_mm), dec)
    : U.round((haveR ? right.ob_mm : left.ob_mm), dec);

  const side_of_max =
    (haveR && haveL) ? (right.ob_mm >= left.ob_mm ? "right" : "left")
    : (haveR ? "right" : (haveL ? "left" : null));

  // 四舍五入衍生量
  if (right.crown_h_mm != null) right.crown_h_mm = U.round(right.crown_h_mm, dec);
  if (left .crown_h_mm != null) left .crown_h_mm = U.round(left .crown_h_mm, dec);
  if (right.ratio_ob_over_h != null) right.ratio_ob_over_h = U.round(right.ratio_ob_over_h, 3);
  if (left .ratio_ob_over_h != null) left .ratio_ob_over_h = U.round(left .ratio_ob_over_h, 3);

  // 汇总
  return {
    kind: "Overbite_anterior",
    value_mm, side_of_max,
    right_mm, left_mm,
    per_side: { right, left },
    quality,
    used: Array.from(new Set(used)),
    warnings,
    method,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module #9 — Overjet_前牙覆盖（正中矢状面，切缘中点→下颌切牙唇面，水平距离）
// 约定：OJ = x_upper - x_lower_labial（在咬合坐标系下、投影至 Y=0）；正=覆盖，负=反𬌗，≈0=对刃
// 优先使用“下中切牙唇面中点”作为下参考；无则用（切缘中点↔颈部唇侧中点）直线在同高处的线性插值；再无则退化为切缘点。
// 依赖：frame={origin,ex,ey,ez}（单位向量，右手系），landmarks(单位:mm)
// ─────────────────────────────────────────────────────────────────────────────
export function computeOverjet(landmarks, frame, options = {}) {
  const dec = options.dec ?? 2;
  const deep_mm = options.deep_mm ?? 12;       // 深覆盖阈值（可配置）
  const edge_eps = options.edge_eps ?? 0.2;    // 对刃判定（|OJ|≤edge_eps）

  // 允许外部传 utils；否则提供最小实现
  const U = options.utils ?? {
    dot: (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
    sub: (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]],
    round: (x, k=2) => (x==null ? null : Math.round(x*10**k)/10**k),
    toLocal(p, f) {
      const v = this.sub(p, f.origin);
      return [this.dot(v, f.ex), this.dot(v, f.ey), this.dot(v, f.ez)];
    },
    pick(landmarks, keys) {
      for (const k of keys) {
        const p = landmarks?.[k];
        if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) return {key:k, p};
      }
      return null;
    },
    uniq: (arr) => Array.from(new Set(arr)),
    clamp01: (t) => (t<0?0:(t>1?1:t)),
  };

  const sel = {
    // 上颌中切牙（切缘中点）
    U_right: options.selectors?.U_right ?? ["11m"],
    U_left : options.selectors?.U_left  ?? ["21m"],

    // 下颌中切牙：唇面“代表点”（优先）
    L_labial_right: options.selectors?.L_labial_right ?? [],
    L_labial_left : options.selectors?.L_labial_left  ?? [],

    // 退化路径所需：切缘 & 颈部唇侧中点（用于拟合唇面方向线）
    L_incisal_right: options.selectors?.L_incisal_right ?? ["41m"],
    L_incisal_left : options.selectors?.L_incisal_left  ?? ["31m"],
    L_cervical_right: options.selectors?.L_cervical_right ?? ["41bgb"],
    L_cervical_left : options.selectors?.L_cervical_left  ?? ["31bgb"],
  };

  const used = [];
  const warnings = [];
  const method = {
    plane: "mid-sagittal (Y=0) in occlusal frame",
    sign_convention: "OJ = x_upper - x_lower_labial; positive=overjet, negative=reverse",
    labial_source_priority: "line interp at same Z (m↔bgb) > incisal only",
    thresholds: { deep_mm, edge_eps },
    dec,
  };

  if (!frame?.origin || !frame?.ex || !frame?.ey || !frame?.ez) {
    return {
      kind: "Overjet_anterior",
      quality: "missing",
      value_mm: null,
      right_mm: null,
      left_mm: null,
      per_side: {},
      used, warnings: ["missing frame"], method, thresholds: { deep_mm, edge_eps },
    };
  }

  const projectToMidSagittal = (localP) => [localP[0], 0, localP[2]]; // (x,0,z)

  function sideCalc(UpKeys, L_labialKeys, L_incisalKeys, L_cervicalKeys) {
    const up = U.pick(landmarks, UpKeys);
    const ret = {
      oj_mm: null,
      x_upper: null, x_lower_labial: null,
      labial_source: null, // "labial_landmark" | "line_interp" | "incisal_only"
      flags: { reverse:false, edge_to_edge:false, deep:false },
      used: [], missing: []
    };
    if (!up) { ret.missing.push(UpKeys.join("|")); return ret; }
    ret.used.push(up.key); used.push(up.key);

    const upL = projectToMidSagittal(U.toLocal(up.p, frame));
    ret.x_upper = upL[0];

    // 1) 直接用唇面代表点
    const ll = U.pick(landmarks, L_labialKeys);
    if (ll) {
      ret.used.push(ll.key); used.push(ll.key);
      const llL = projectToMidSagittal(U.toLocal(ll.p, frame));
      ret.x_lower_labial = llL[0];
      ret.labial_source = "labial_landmark";
    } else {
      // 2) 用切缘与颈部唇侧中点拟合一条矢状线，并在与上切缘同高（同 z）处取线性插值
      const li = U.pick(landmarks, L_incisalKeys);
      const lc = U.pick(landmarks, L_cervicalKeys);
      if (li && lc) {
        ret.used.push(li.key, lc.key); used.push(li.key, lc.key);
        const liL = projectToMidSagittal(U.toLocal(li.p, frame));
        const lcL = projectToMidSagittal(U.toLocal(lc.p, frame));
        const dz = lcL[2] - liL[2];
        if (Math.abs(dz) < 1e-6) {
          // 基本平行于 X：直接取切缘点的 x 作为近似
          ret.x_lower_labial = liL[0];
          ret.labial_source = "incisal_only";
          warnings.push("lower labial line dz≈0; fell back to incisal_only");
        } else {
          const t = U.clamp01((upL[2] - liL[2]) / dz);
          ret.x_lower_labial = liL[0] + t * (lcL[0] - liL[0]);
          ret.labial_source = "line_interp";
        }
      } else if (li) {
        ret.used.push(li.key); used.push(li.key);
        ret.x_lower_labial = projectToMidSagittal(U.toLocal(li.p, frame))[0];
        ret.labial_source = "incisal_only";
        ret.missing.push(L_labialKeys.join("|"), L_cervicalKeys.join("|"));
      } else {
        ret.missing.push(L_labialKeys.join("|"), L_incisalKeys.join("|"), L_cervicalKeys.join("|"));
        return ret;
      }
    }

    // OJ = x_upper - x_lower_labial
    ret.oj_mm = ret.x_upper - ret.x_lower_labial;

    // 标记
    ret.flags.edge_to_edge = Math.abs(ret.oj_mm) <= edge_eps;
    ret.flags.reverse = ret.oj_mm < -edge_eps;
    ret.flags.deep = ret.oj_mm >= deep_mm;

    // 常识性预警
    if (Math.abs(ret.oj_mm) > 20) warnings.push("overjet value exceeds 20 mm, please verify landmarks/frame");
    return ret;
  }

  const right = sideCalc(
    sel.U_right, sel.L_labial_right, sel.L_incisal_right, sel.L_cervical_right
  );
  const left  = sideCalc(
    sel.U_left , sel.L_labial_left , sel.L_incisal_left , sel.L_cervical_left
  );

  const haveR = right.oj_mm != null;
  const haveL = left.oj_mm != null;

  let quality = "ok";
  if (!haveR && !haveL) quality = "missing";
  else if (!(haveR && haveL)) quality = "fallback";

  const right_mm = U.round(right.oj_mm, dec);
  const left_mm  = U.round(left.oj_mm,  dec);
  const value_mm = (haveR && haveL)
    ? U.round(Math.max(right.oj_mm, left.oj_mm), dec)
    : U.round((haveR ? right.oj_mm : left.oj_mm), dec);

  const side_of_max =
    (haveR && haveL) ? (right.oj_mm >= left.oj_mm ? "right" : "left")
    : (haveR ? "right" : (haveL ? "left" : null));

  // 四舍五入派生量
  if (right.x_upper != null) right.x_upper = U.round(right.x_upper, dec);
  if (left .x_upper != null) left .x_upper = U.round(left .x_upper, dec);
  if (right.x_lower_labial != null) right.x_lower_labial = U.round(right.x_lower_labial, dec);
  if (left .x_lower_labial != null) left .x_lower_labial = U.round(left .x_lower_labial, dec);

  return {
    kind: "Overjet_anterior",
    value_mm, side_of_max,
    right_mm, left_mm,
    per_side: { right, left },
    quality,
    used: U.uniq(used),
    warnings,
    method,
    thresholds: { deep_mm, edge_eps },
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// Module #10 — Arch_Width_牙弓宽度（前/中/后段）
// 说明：在咬合坐标系的咬合平面(XY)上测量双侧对应点的“横向距离”
// 主值：transverse_mm = |y_L - y_R|；同时返回 euclid_mm = √(Δx²+Δy²)
// 依赖：frame={origin,ex,ey,ez}；landmarks 单位 mm；arch='upper'|'lower'
// 回退：前磨缺失→回退第二前磨；磨牙MB缺失→回退DB/BC；质量标记 & warnings
// ─────────────────────────────────────────────────────────────────────────────
export function computeArchWidth(landmarks, frame, options = {}) {
  const arch = options.arch ?? "upper"; // 'upper' | 'lower'
  const dec = options.dec ?? 2;
  const ap_tol = options.ap_tol ?? 3.0; // 左右点前后位差 |Δx| 超过此值给出预警
  const want_euclid = options.want_euclid ?? false;

  const U = options.utils ?? {
    dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
    sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
    round:(x,k=2)=>(x==null?null:Math.round(x*10**k)/10**k),
    hypot:(dx,dy)=>Math.hypot(dx,dy),
    toLocal(p,f){ const v=this.sub(p,f.origin); return [this.dot(v,f.ex),this.dot(v,f.ey),this.dot(v,f.ez)]; },
    pick(landmarks, keys){
      for (const k of keys){
        const p=landmarks?.[k];
        if (Array.isArray(p)&&p.length===3&&p.every(Number.isFinite)) return {key:k,p};
      }
      return null;
    },
    uniq:(arr)=>Array.from(new Set(arr)),
  };

  if (!frame?.origin || !frame?.ex || !frame?.ey || !frame?.ez) {
    return { kind:"Arch_Width", arch, quality:"missing", used:[], warnings:["missing frame"], method:{} };
  }

  // —— 牙位候选（按优先顺序）——
  const SEL = (arch === "upper")
    ? {
        canine_L : [["23m"]],
        canine_R : [["13m"]],
        pm1_L    : [["24b"], ["25b"]], // 回退第二前磨
        pm1_R    : [["14b"], ["15b"]],
        molar1_L : [["26mb"], ["26db"], ["26bg"]],
        molar1_R : [["16mb"], ["16db"], ["16bg"]],
      }
    : {
        canine_L : [["33m"]],
        canine_R : [["43m"]],
        pm1_L    : [["34b"], ["35b"]],
        pm1_R    : [["44b"], ["45b"]],
        molar1_L : [["36mb"], ["36db"], ["36bg"]],
        molar1_R : [["46mb"], ["46db"], ["46bg"]],
      };

  const used = [];
  const warnings = [];
  const method = {
    plane: "occlusal XY (local frame)",
    primary: "transverse_mm = |y_left - y_right|",
    also: want_euclid ? "euclid_mm = hypot(Δx,Δy)" : "disabled",
    fallbacks: "PM1→PM2; M1 MB→DB/BG",
    thresholds: { ap_tol, dec },
    arch,
  };

  function pickWithFallback(candsLists){
    for (const keys of candsLists){
      const r = U.pick(landmarks, keys);
      if (r) return r;
    }
    return null;
  }

  function measurePair(sideL_lists, sideR_lists, tag){
    const L = pickWithFallback(sideL_lists);
    const R = pickWithFallback(sideR_lists);
    const info = { ok:false, tag, used:[], missing:[], points:{}, transverse_mm:null, euclid_mm:null, dx:null, dy:null, source:{} };

    if (!L) info.missing.push(sideL_lists.map(a=>a.join("|")).join(" || "));
    if (!R) info.missing.push(sideR_lists.map(a=>a.join("|")).join(" || "));
    if (!L || !R) return info;

    info.used.push(L.key, R.key); used.push(L.key, R.key);
    info.source.left = L.key; info.source.right = R.key;

    const Ll = U.toLocal(L.p, frame); const Rl = U.toLocal(R.p, frame);
    // 投影到XY（忽略Z）
    const Lxy = [Ll[0], Ll[1]]; const Rxy = [Rl[0], Rl[1]];
    info.points = { L_xy: [U.round(Lxy[0],dec), U.round(Lxy[1],dec)], R_xy: [U.round(Rxy[0],dec), U.round(Rxy[1],dec)] };

    const dx = Rxy[0] - Lxy[0];
    const dy = Rxy[1] - Lxy[1];
    info.dx = U.round(dx, dec); info.dy = U.round(dy, dec);

    info.transverse_mm = U.round(Math.abs(dy), dec);
    if (want_euclid) info.euclid_mm = U.round(U.hypot(dx,dy), dec);
    info.ok = true;

    if (Math.abs(dx) > ap_tol) warnings.push(`${tag}: anterior-posterior mismatch |Δx|=${U.round(Math.abs(dx),dec)}mm > ${ap_tol}mm`);
    if (Lxy[1]*Rxy[1] > 0) warnings.push(`${tag}: both sides appear on same lateral side (check frame/points)`);

    return info;
  }

  const canine   = measurePair(SEL.canine_L, SEL.canine_R, "canine_width");
  const pm1      = measurePair(SEL.pm1_L   , SEL.pm1_R   , "premolar1_width");
  const molar1   = measurePair(SEL.molar1_L, SEL.molar1_R, "molar1_width");

  let quality = "ok";
  const allOK = [canine, pm1, molar1].every(s => s.ok);
  const anyOK = [canine, pm1, molar1].some(s => s.ok);
  if (!anyOK) quality = "missing";
  else if (!allOK) quality = "fallback";

  return {
    kind: "Arch_Width",
    arch,
    canine_mm : canine.ok ? canine.transverse_mm : null,
    pm1_mm    : pm1.ok ? pm1.transverse_mm : null,
    molar1_mm : molar1.ok ? molar1.transverse_mm : null,
    details: {
      canine, premolar1: pm1, molar1,
      note: "primary value = transverse (|y_L - y_R|); see details.euclid_mm if needed"
    },
    quality,
    used: U.uniq(used),
    warnings,
    method,
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// Module #11 — Arch_Form_牙弓形态（曲线拟合 + 指标 + 三分类）
// 说明：在咬合平面(XY)收集“唇/颊外缘”点 → 排序成单调开曲线 → 采样成 polyline
// 指标：r_ic=ICW/IMW，r_ip1=IP1W/IMW，d_ant=前缘到M1连线的距/IMW，kappa_front≈前三点曲率
// 分类（启发式，后续可用数据再调）：Tapered (r_ic≤0.72) / Square (r_ic≥0.80) / Ovoid (else)
// 依赖：frame、landmarks、可选预计算宽度（preWidth）
// ─────────────────────────────────────────────────────────────────────────────
export function computeArchForm(landmarks, frame, options = {}) {
  const arch = options.arch ?? "upper";
  const dec = options.dec ?? 3;
  const sample_n = options.sample_n ?? 101;
  const preWidth = options.preWidth ?? null; // 可传入 computeArchWidth 的结果加速 & 一致

  const U = options.utils ?? {
    dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
    sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
    round:(x,k=3)=>(x==null?null:Math.round(x*10**k)/10**k),
    toLocal(p,f){ const v=this.sub(p,f.origin); return [this.dot(v,f.ex),this.dot(v,f.ey),this.dot(v,f.ez)]; },
    pick(landmarks, keys){
      for (const k of keys){
        const p=landmarks?.[k];
        if (Array.isArray(p)&&p.length===3&&p.every(Number.isFinite)) return {key:k,p};
      }
      return null;
    },
    uniq:(arr)=>Array.from(new Set(arr)),
    lerp:(a,b,t)=>a+(b-a)*t,
  };

  if (!frame?.origin || !frame?.ex || !frame?.ey || !frame?.ez) {
    return { kind:"Arch_Form", arch, quality:"missing", used:[], warnings:["missing frame"], method:{} };
  }

  // —— 外缘点位集合（可按需扩充）——
  const SEL = (arch === "upper")
    ? {
        incisors: [["11m"], ["12m"], ["21m"], ["22m"]],
        canines:  [["13m"], ["23m"]],
        post_R:   [["14b"], ["15b"], ["16mb"], ["17mb"]],
        post_L:   [["24b"], ["25b"], ["26mb"], ["27mb"]],
        M1_R:     [["16mb"], ["16db"], ["16bg"]],
        M1_L:     [["26mb"], ["26db"], ["26bg"]],
        C_R:      [["13m"]],
        C_L:      [["23m"]],
        P1_R:     [["14b"]],
        P1_L:     [["24b"]],
      }
    : {
        incisors: [["31m"], ["32m"], ["41m"], ["42m"]],
        canines:  [["33m"], ["43m"]],
        post_R:   [["44b"], ["45b"], ["46mb"], ["47mb"]],
        post_L:   [["34b"], ["35b"], ["36mb"], ["37mb"]],
        M1_R:     [["46mb"], ["46db"], ["46bg"]],
        M1_L:     [["36mb"], ["36db"], ["36bg"]],
        C_R:      [["43m"]],
        C_L:      [["33m"]],
        P1_R:     [["44b"]],
        P1_L:     [["34b"]],
      };

  const used = [];
  const warnings = [];
  const method = {
    plane: "occlusal XY (local frame)",
    ordering: "Right(posterior→anterior) + incisors + Left(anterior→posterior)",
    sampling: `${sample_n} points via linear resampling`,
    indices: ["r_ic=ICW/IMW", "r_ip1=IP1W/IMW", "d_ant/IMW", "kappa_front"],
    classification: {
      rule: "heuristic thresholds on r_ic (tunable)",
      tapered_at_most: 0.72,
      square_at_least: 0.80,
    },
    arch,
  };

  function takeAll(keysLists){
    const out=[];
    for (const keys of keysLists){
      const r = U.pick(landmarks, keys);
      if (r){
        const L = U.toLocal(r.p, frame);
        out.push({ key:r.key, xy:[L[0], L[1]] }); // (x,y)
        used.push(r.key);
      }
    }
    return out;
  }

  const pts_inc = takeAll(SEL.incisors);
  const pts_can = takeAll(SEL.canines);
  const pts_R   = takeAll(SEL.post_R);
  const pts_L   = takeAll(SEL.post_L);

  // —— 排序：以 x（前后）为主序 —— //
  const rightSorted = pts_R.sort((a,b)=>a.xy[0]-b.xy[0]);     // 后→前（小x到大x）
  const leftSorted  = pts_L.sort((a,b)=>b.xy[0]-a.xy[0]);     // 前→后（大x到小x）
  const incSorted   = pts_inc.sort((a,b)=>a.xy[0]-b.xy[0]);   // 左右顺序不重要

  const ordered = [...rightSorted, ...incSorted, ...leftSorted];
  const haveMin = (pts_can.length>=1) && (pts_R.length>=1) && (pts_L.length>=1) && (pts_inc.length>=2);
  let quality = haveMin ? "ok" : (ordered.length>=4 ? "fallback" : "missing");
  if (!haveMin) warnings.push("insufficient key points for reliable arch curve; classification confidence reduced");

  // —— 线性重采样为 sample_n 个点（按弧长比例） —— //
  function resamplePolyline(points, N){
    if (points.length===0) return [];
    if (points.length===1) return Array(N).fill(points[0]);
    const xs=points.map(p=>p.xy[0]), ys=points.map(p=>p.xy[1]);
    const segLen=[]; let total=0;
    for (let i=1;i<points.length;i++){
      const dx=xs[i]-xs[i-1], dy=ys[i]-ys[i-1];
      const l=Math.hypot(dx,dy); segLen.push(l); total+=l;
    }
    if (total===0) return Array(N).fill(points[0]);

    const cum=[0]; for (let i=0;i<segLen.length;i++) cum.push(cum[i]+segLen[i]);
    const out=[];
    for (let k=0;k<N;k++){
      const t = (k/(N-1))*total;
      // 找到段
      let i=0; while (i<cum.length-1 && cum[i+1]<t) i++;
      const t0=cum[i], t1=cum[i+1], loc = (t1===t0?0:(t-t0)/(t1-t0));
      const x = U.lerp(xs[i], xs[i+1], loc);
      const y = U.lerp(ys[i], ys[i+1], loc);
      out.push([U.round(x,dec), U.round(y,dec)]);
    }
    return out;
  }
  const curve_xy = resamplePolyline(ordered, sample_n);

  // —— 指标：ICW/IP1W/IMW、前缘深度、前缘曲率近似 —— //
  function getWidthFromPair(selL, selR){
    const L = U.pick(landmarks, selL[0]) || (selL[1] && U.pick(landmarks, selL[1]));
    const R = U.pick(landmarks, selR[0]) || (selR[1] && U.pick(landmarks, selR[1]));
    if (!L || !R) return null;
    const Ll = U.toLocal(L.p, frame), Rl = U.toLocal(R.p, frame);
    return Math.abs(Rl[1]-Ll[1]); // transverse
  }

  // 若有预计算宽度则复用，否则局部计算
  let ICW=null, IP1W=null, IMW=null;
  if (preWidth?.kind==="Arch_Width" && preWidth.arch===arch){
    ICW = preWidth.canine_mm ?? null;
    IP1W = preWidth.pm1_mm ?? null;
    IMW = preWidth.molar1_mm ?? null;
  } else {
    ICW = getWidthFromPair(SEL.C_L, SEL.C_R);
    IP1W = getWidthFromPair(SEL.P1_L, SEL.P1_R);
    // M1：允许 MB→DB/BC 回退
    const tryM1 = (SEL.M1_L[0] && SEL.M1_R[0]) ? getWidthFromPair(SEL.M1_L, SEL.M1_R) : null;
    IMW = tryM1;
  }

  let r_ic=null, r_ip1=null;
  if (IMW && IMW>0) {
    r_ic = ICW!=null ? U.round(ICW/IMW, 3) : null;
    r_ip1 = IP1W!=null ? U.round(IP1W/IMW, 3) : null;
  } else {
    warnings.push("IMW not available; ratios unavailable");
  }

  // 前缘点 = 曲线 x 最大的点；M1 连线用于深度基线
  function lineDistPoint(Lpt, Rpt, P){
    // 距离点到直线（通过 Lpt,Rpt）
    const [x1,y1]=Lpt, [x2,y2]=Rpt, [x0,y0]=P;
    const A=y1-y2, B=x2-x1, C=x1*y2-x2*y1;
    return Math.abs(A*x0 + B*y0 + C) / Math.hypot(A,B);
  }
  // 取 M1 左右点（若缺失，则用曲线两端作为近似）
  let M1L=null, M1R=null;
  {
    const pickL = U.pick(landmarks, SEL.M1_L[0]) || (SEL.M1_L[1] && U.pick(landmarks, SEL.M1_L[1])) || (SEL.M1_L[2] && U.pick(landmarks, SEL.M1_L[2]));
    const pickR = U.pick(landmarks, SEL.M1_R[0]) || (SEL.M1_R[1] && U.pick(landmarks, SEL.M1_R[1])) || (SEL.M1_R[2] && U.pick(landmarks, SEL.M1_R[2]));
    if (pickL && pickR){
      const L = U.toLocal(pickL.p, frame), R = U.toLocal(pickR.p, frame);
      M1L=[L[0],L[1]]; M1R=[R[0],R[1]]; used.push(pickL.key, pickR.key);
    } else if (curve_xy.length>=2){
      M1L = curve_xy[0]; M1R = curve_xy[curve_xy.length-1];
      warnings.push("M1 line approximated by curve endpoints");
    }
  }
  const anteriorIdx = curve_xy.length ? curve_xy.reduce((imax,pt,i,arr)=> pt[0]>(arr[imax][0]??-1e9)?i:imax, 0) : 0;
  const P_ant = curve_xy[anteriorIdx] ?? null;
  let d_ant = null, d_ant_ratio = null;
  if (P_ant && M1L && M1R){
    d_ant = lineDistPoint(M1L, M1R, P_ant);
    if (IMW && IMW>0) d_ant_ratio = U.round(d_ant/IMW, 3);
  }

  // 前缘曲率近似：取前端附近 3 个采样点（不足则 null）
  function curvature3(p0,p1,p2){
    const [x1,y1]=p0,[x2,y2]=p1,[x3,y3]=p2;
    const a=Math.hypot(x1-x2,y1-y2), b=Math.hypot(x2-x3,y2-y3), c=Math.hypot(x3-x1,y3-y1);
    const s=(a+b+c)/2, area=Math.max(1e-9, Math.sqrt(Math.max(0,s*(s-a)*(s-b)*(s-c))));
    const R = (a*b*c)/(4*area);
    return 1/R; // kappa
  }
  let kappa_front = null;
  if (curve_xy.length>=5){
    const i = Math.max(1, Math.min(anteriorIdx, curve_xy.length-3));
    kappa_front = U.round(curvature3(curve_xy[i-1], curve_xy[i], curve_xy[i+1]), 4);
  }

  // —— 三分类（启发式，可日后替换为模板最小残差） —— //
  let klass = null;
  if (r_ic != null){
    if (r_ic <= 0.72) klass = "Tapered";
    else if (r_ic >= 0.80) klass = "Square";
    else klass = "Ovoid";
  } else {
    klass = "Unknown";
    quality = (quality==="ok" ? "fallback" : quality);
    warnings.push("cannot classify without r_ic");
  }

  return {
    kind: "Arch_Form",
    arch,
    class: klass,
    curve_xy, // 俯视折线（已重采样）
    indices: {
      ICW: ICW!=null ? U.round(ICW,3) : null,
      IP1W: IP1W!=null ? U.round(IP1W,3) : null,
      IMW: IMW!=null ? U.round(IMW,3) : null,
      r_ic, r_ip1,
      d_ant: d_ant!=null ? U.round(d_ant,3) : null,
      d_ant_ratio,
      kappa_front,
    },
    anchors: { M1L, M1R, P_ant },
    quality,
    used: U.uniq(used),
    warnings,
    method,
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// Module #12 — Canine_Relationship_尖牙关系（无真值，三档代理）
// 定义：比较 上颌尖牙牙尖 U3c 与 下颌“DMR 代理点”的前后(AP, x轴)差：dx = x(U3c) - x(DMR_proxy)
// 分类：|dx|<=eps → 中性；dx>eps → 近中；dx<-eps → 远中
// 代理顺序：arch_curve 分位(α) > 直线分位(α) > 固定后移(β或0.02×IMW)
// 依赖：frame；landmarks；可选 options.archCurveLower（Module11.curve_xy，lower）与 options.preWidth（Module10，lower）
// ─────────────────────────────────────────────────────────────────────────────
export function computeCanineRelationship(landmarks, frame, options = {}) {
  const dec = options.dec ?? 2;
  const alpha = options.alpha ?? 0.38;     // L3→L4 的分位位置
  const eps = options.eps ?? 0.5;          // 中性容差 (mm)
  const beta_mm = options.beta_mm ?? 2.0;  // 无 L4 时的固定后移
  const use_imw_scale = options.use_imw_scale ?? true;
  const archCurve = options.archCurveLower ?? null; // 俯视 XY 折线（下颌）
  const preWidth = options.preWidth ?? null;        // 预计算宽度（下颌），用于 IMW

  const U = options.utils ?? {
    dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
    sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
    add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],
    mul:(a,s)=>[a[0]*s,a[1]*s,a[2]*s],
    hypot2:(dx,dy)=>dx*dx+dy*dy,
    round:(x,k=2)=>(x==null?null:Math.round(x*10**k)/10**k),
    toLocal(p,f){ const v=this.sub(p,f.origin); return [this.dot(v,f.ex),this.dot(v,f.ey),this.dot(v,f.ez)]; },
    pick(landmarks, keys){
      for (const k of keys){
        const p = landmarks?.[k];
        if (Array.isArray(p)&&p.length===3&&p.every(Number.isFinite)) return {key:k,p};
      }
      return null;
    },
    uniq:(arr)=>Array.from(new Set(arr)),
  };

  if (!frame?.origin || !frame?.ex || !frame?.ey || !frame?.ez) {
    return { kind:"Canine_Relationship", quality:"missing", used:[], warnings:["missing frame"], method:{} };
  }

  // —— 最小 selector（可按你字典增补别名）——
  const SEL = {
    U_R_cusp: ["13m"],
    U_L_cusp: ["23m"],
    L_R_cusp: ["43m"],
    L_L_cusp: ["33m"],
    L_R_P1b : ["44b"],
    L_L_P1b : ["34b"],
  };

  const used = [];
  const warnings = [];
  const method = {
    axis: "AP axis x in occlusal frame (XY plane)",
    proxy_order: "arch_curve_fraction > segment_fraction > fixed_offset",
    params: { alpha, eps, beta_mm, use_imw_scale, dec },
  };

  // —— 工具：在 polyline 上找最近点索引 —— //
  function nearestIdx(poly, pt){
    let best=0, bestD=Infinity;
    for (let i=0;i<poly.length;i++){
      const dx=poly[i][0]-pt[0], dy=poly[i][1]-pt[1];
      const d=U.hypot2(dx,dy); if (d<bestD){ bestD=d; best=i; }
    }
    return best;
  }

  // 沿折线从 i0→i1 的弧长分位 (0..1)，返回插值点
  function arcFractionPoint(poly, i0, i1, frac){
    if (!poly?.length) return null;
    if (i0===i1) return poly[i0];
    const step = i1>i0 ? 1 : -1;
    const total = (()=>{ let s=0; for(let i=i0;i!==i1;i+=step){ const a=poly[i],b=poly[i+step]; s+=Math.hypot(b[0]-a[0], b[1]-a[1]); } return s; })();
    if (total<=1e-9) return poly[i0];
    let target = total*frac, acc=0;
    for(let i=i0;i!==i1;i+=step){
      const a=poly[i], b=poly[i+step];
      const seg = Math.hypot(b[0]-a[0], b[1]-a[1]);
      if (acc+seg >= target){
        const t = (target-acc)/seg;
        return [ a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]) ];
      }
      acc+=seg;
    }
    return poly[i1];
  }

  function side(sideTag, UcKeys, LcKeys, Lp1Keys){
    const out = {
      side: sideTag, class: null, dx_mm: null, source: null,
      points: { U3c:null, L3c:null, L4b:null, DMR_proxy:null },
      quality: "ok", used: [], notes: []
    };

    const Uc = U.pick(landmarks, UcKeys);
    const L3 = U.pick(landmarks, LcKeys);
    if (!Uc || !L3){
      out.quality = "missing"; out.class = "未判定/缺失";
      if (!Uc) out.notes.push("missing U3 cusp");
      if (!L3) out.notes.push("missing L3 cusp");
      return out;
    }
    used.push(Uc.key, L3.key); out.used.push(Uc.key, L3.key);

    const Uloc = U.toLocal(Uc.p, frame); const L3loc = U.toLocal(L3.p, frame);
    const Uxy = [Uloc[0], Uloc[1]], L3xy = [L3loc[0], L3loc[1]];
    out.points.U3c = [U.round(Uxy[0],dec), U.round(Uxy[1],dec)];
    out.points.L3c = [U.round(L3xy[0],dec), U.round(L3xy[1],dec)];

    let DMRxy = null; let src = null;

    // 档 1：弧长分位（需曲线 & L4）
    const L4 = U.pick(landmarks, Lp1Keys);
    if (archCurve && L4){
      used.push(L4.key); out.used.push(L4.key);
      const L4loc = U.toLocal(L4.p, frame); const L4xy = [L4loc[0], L4loc[1]];
      out.points.L4b = [U.round(L4xy[0],dec), U.round(L4xy[1],dec)];

      const i0 = nearestIdx(archCurve, L3xy);
      const i1 = nearestIdx(archCurve, L4xy);
      const P = arcFractionPoint(archCurve, i0, i1, alpha);
      if (P){ DMRxy = P; src = "arch_curve_fraction"; }
    }

    // 档 2：直线分位
    if (!DMRxy && L4){
      const L4loc = U.toLocal(L4.p, frame); const L4xy = [L4loc[0], L4loc[1]];
      const dx = L4xy[0]-L3xy[0], dy = L4xy[1]-L3xy[1];
      DMRxy = [ L3xy[0] + alpha*dx, L3xy[1] + alpha*dy ];
      src = "segment_fraction";
    }

    // 档 3：固定后移
    if (!DMRxy){
      let beta = beta_mm;
      const imw = (preWidth?.kind==="Arch_Width" && preWidth.arch==="lower") ? preWidth.molar1_mm : null;
      if (use_imw_scale && imw && imw>0) beta = 0.02 * imw;
      DMRxy = [ L3xy[0] - beta, L3xy[1] ];
      src = "fixed_offset";
      if (!L4) out.notes.push("no L4; using fixed offset");
    }

    out.points.DMR_proxy = [U.round(DMRxy[0],dec), U.round(DMRxy[1],dec)];
    out.source = src;

    // 判别
    const dx = Uxy[0] - DMRxy[0];
    out.dx_mm = U.round(dx, dec);
    if (Math.abs(dx) <= eps) out.class = "中性关系";
    else if (dx > eps)       out.class = "近中关系";
    else                     out.class = "远中关系";

    return out;
  }

  const right = side("right", SEL.U_R_cusp, SEL.L_R_cusp, SEL.L_R_P1b);
  const left  = side("left" , SEL.U_L_cusp, SEL.L_L_cusp, SEL.L_L_P1b);

  let quality = "ok";
  const haveR = right.quality !== "missing";
  const haveL = left.quality  !== "missing";
  if (!haveR && !haveL) quality = "missing";
  else if (!(right.quality==="ok" && left.quality==="ok")) quality = "fallback";

  const summary_text =
    (haveR ? `右侧${right.class}` : "右侧缺失") + "，" +
    (haveL ? `左侧${left.class}`  : "左侧缺失");

  return {
    kind: "Canine_Relationship",
    summary_text,
    right, left,
    quality,
    used: U.uniq(used),
    warnings,
    method,
  };
}
