// ========= js/metrics/utils.js =========
// 轻量向量
export const vAdd=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
export const vSub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const vDot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const vCross=(a,b)=>[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const vLen=a=>Math.hypot(a[0],a[1],a[2]);
export const vNrm=a=>{const L=vLen(a)||1; return [a[0]/L,a[1]/L,a[2]/L];};
export const centroid = (arr)=>arr?.length ? arr.reduce((s,p)=>vAdd(s,p),[0,0,0]).map(x=>x/arr.length) : [0,0,0];
export const projOnPlane=(v,n)=>{const k=vDot(v,n); return vSub(v,[n[0]*k,n[1]*k,n[2]*k]);};
export const dist3=(a,b)=>Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
export const round1 = x => x==null ? null : Math.round(x*10)/10;

// 点位解析
export function lmPos(lm){
  if (!lm) return null;
  if (Array.isArray(lm.pos)) return lm.pos;
  const p = lm.position_model || lm.position || lm.xyz;
  return p ? [p.x, p.y, p.z] : null;
}
export function parseFDI(name=''){
  const m = String(name).match(/\b(1[1-8]|2[1-8]|3[1-8]|4[1-8])\b/);
  return m ? m[1] : null;
}
export function suffix(name=''){
  const t = String(name).toLowerCase();
  const fdi = parseFDI(t);
  if (!fdi) return '';
  return t.slice(t.indexOf(fdi) + fdi.length); // 'm','b','mb','db','bg',...
}
export function pick(landmarks, names){
  if (!landmarks || !names || names.length === 0) return null;
  
  // Check if landmarks is a dictionary (object with keys as landmark names)
  if (landmarks && typeof landmarks === 'object' && !Array.isArray(landmarks)) {
    // Dictionary format: { "11m": [x, y, z], "21m": [x, y, z], ... }
    const set = new Set((names||[]).map(s=>String(s).toLowerCase()));
    for (const [key, coords] of Object.entries(landmarks)) {
      const keyLower = String(key).toLowerCase();
      if (set.has(keyLower) && Array.isArray(coords) && coords.length === 3) {
        return coords;
      }
    }
    return null;
  }
  
  // Original array format: [{ name: "11m", position: [x,y,z] }, ...]
  const set = new Set((names||[]).map(s=>String(s).toLowerCase()));
  for(const lm of (landmarks||[])){
    const nm = String(lm.name||lm.id||'').toLowerCase();
    if(set.has(nm)) { const p=lmPos(lm); if(p) return p; }
  }
  return null;
}

// dict.json 支持（可选）
let _dictCache=null;
export async function loadDict(path='/dict.json'){
  if (_dictCache) return _dictCache;
  const res = await fetch(path);
  _dictCache = await res.json();
  return _dictCache;
}
export function setDict(obj){ _dictCache = obj; }
export function getDict(){ return _dictCache; }

// 下颌后牙颊侧功能点采样（用于咬合平面）。可利用 dict，但即使没有也能工作。
export function collectLowerPosteriorBuccal(landmarks){
  // 基本优先级：前磨牙 'b'；磨牙 'mb/db'，缺则 'bg'
  const prefs = [
    ['34b'], ['44b'], ['35b'], ['45b'],
    ['36mb','36db','36bg'], ['46mb','46db','46bg'],
    ['37mb','37db'], ['47mb','47db']
  ];
  const pts=[];
  for(const cand of prefs){
    const p = pick(landmarks, cand);
    if(p) pts.push(p);
  }
  // 兜底：扫所有下颌后牙，后缀含 mb/db/b/bg
  if (pts.length < 6) {
    for(const lm of (landmarks||[])){
      const nm = String(lm.name||'').toLowerCase();
      if (/^(3[3-8]|4[3-8])(mb|db|b|bg)$/.test(nm)){
        const p = lmPos(lm); if(p) pts.push(p);
      }
    }
  }
  return pts;
}

// 投影到咬合系
export function projectToFrame(p, frame){
  if(!p || !frame) return {x:NaN,y:NaN,z:NaN};
  const v = vSub(p, frame.origin);
  return { x: vDot(v, frame.ex), y: vDot(v, frame.ey), z: vDot(v, frame.ez) };
}
export function framePretty(frame){
  const r=v=>v.map(x=>(Math.round(x*100)/100).toFixed(2)).join(', ');
  return [`origin:[${r(frame.origin)}]`,`ex(AP):[${r(frame.ex)}]`,`ey(TR):[${r(frame.ey)}]`,`ez(V): [${r(frame.ez)}]`].join('\n');
}
