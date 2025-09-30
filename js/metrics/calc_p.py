import numpy as np
import json, os
from typing import List, Dict, Optional, Tuple

# ==========================================
# Public API: generate_metrics
# 输入：上/下 STL + 上/下 JSON
# 输出：JSON
# ==========================================
def generate_metrics(
    upper_stl_path: str,
    lower_stl_path: str,
    upper_json_path: str,
    lower_json_path: str,
    out_path: str = "",
    cfg: Optional[Dict] = None
) -> Dict:
    """
    返回形如：
    {
      "Arch_Form_牙弓形态*": "尖圆形✅",
      "Arch_Width_牙弓宽度*": "上牙弓较窄 ✅",
      ... 共 11 条 ...
    }
    若提供 out_path，则同时写盘（UTF-8，无转义）。
    """
    cfg = cfg or {}

    # 1) 读取 landmarks（复用上面提供的 I/O 小函数）
    lm_upper = _load_landmarks_json(upper_json_path)
    lm_lower = _load_landmarks_json(lower_json_path)
    landmarks = _merge_landmarks(lm_upper, lm_lower)

    # 2) 读取并合并 STL 点云（可为空；假设已配准）
    geom_points = _combine_and_sample_points(
        upper_stl_path, lower_stl_path,
        max_points=cfg.get('max_points', 8000)
    )

    # 3) 咬合坐标系
    frame_res = build_occlusal_frame(landmarks, geom_points=geom_points, cfg=cfg.get('frame'))
    frame = frame_res.get('frame')
    if frame is None:
        kv = {"错误": "坐标系缺失，无法生成报告"}
        if out_path:
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(kv, f, ensure_ascii=False, indent=2)
        return kv

    # 4) 生成 brief 列表，并转成 {键: 值}
    brief_lines = make_brief_report(landmarks, frame)
    kv = _brief_lines_to_kv(brief_lines)

    # 5) 可选落盘
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(kv, f, ensure_ascii=False, indent=2)

    return kv

# =======================================================================
# Module #0: Occlusal Frame
# Input: landmarks (Dict), geom_points (Optional[List])
# Output: Dict containing 'frame', 'quality', 'warnings', 'used'
# Description: Constructs the occlusal coordinate system.
#   - Uses molars (e.g., '26mb', '16mb') and incisors ('21m', '11m') to define axes.
#   - Falls back to PCA on 'geom_points' if key landmarks are missing.
# =======================================================================
EPS = 1e-8

# ---------- vector utils ----------
def v_len(v): return float(np.linalg.norm(v))
def v_dot(a,b): return float(np.dot(a,b))
def v_cross(a,b): return np.cross(a,b)
def v_nrm(v):
    n = v_len(v)
    return (v / n) if n > EPS else None
def proj_to_plane(v, n):  # n 必须单位化
    return v - n * v_dot(v, n)
def centroid(arr: List[np.ndarray]) -> Optional[np.ndarray]:
    arr = [a for a in arr if a is not None]
    return (np.mean(np.stack(arr, axis=0), axis=0) if arr else None)

# ---------- picking helpers ----------
def _is_xyz(p) -> bool:
    return bool(isinstance(p, (list, tuple, np.ndarray)) and len(p) == 3 and np.isfinite(p).all())

def pick_with_name(landmarks: Dict, candidates: List[str]) -> Optional[Dict]:
    for k in candidates:
        p = landmarks.get(k)
        if _is_xyz(p):
            return {'name': k, 'p': np.array(p, dtype=float)}
    return None

# ---------- 正交收尾：强制正交 + 右手 ----------
def _re_ortho_rh(ex: Optional[np.ndarray], ey: Optional[np.ndarray], ez: Optional[np.ndarray]) -> Dict[str, Optional[np.ndarray]]:
    if ex is None or ey is None or ez is None:
        return {'ex': None, 'ey': None, 'ez': None}
    
    ez_n = v_nrm(ez)
    if ez_n is None:
        return {'ex': None, 'ey': None, 'ez': None}

    ex_n = v_nrm(ex - ez_n * v_dot(ex, ez_n))
    if ex_n is None:
        ex_n = v_nrm(v_cross(ey, ez_n))

    ey_n = v_nrm(v_cross(ez_n, ex_n)) if ex_n is not None else None
    
    return {'ex': ex_n, 'ey': ey_n, 'ez': ez_n}

# ---------- geometry-first plane estimation (two-pass PCA with trimming) ----------
def _build_frame_from_geometry(points: Optional[List[np.ndarray]], cfg: Optional[Dict] = None) -> Optional[Dict]:
    if not points or len(points) < 50:
        return None
    cfg = cfg or {}
    max_points = int(cfg.get('maxPoints', 6000))
    trim_pct  = float(np.clip(cfg.get('trimPct', 0.5), 0.2, 0.9))

    P = np.array(points, dtype=float)
    if len(P) > max_points:
        idx = np.random.choice(len(P), size=max_points, replace=False)  # 随机下采样避免结构性偏差
        P = P[idx]

    # 粗 PCA
    c0 = np.mean(P, axis=0)
    X = P - c0
    cov = np.cov(X, rowvar=False)
    w, V = np.linalg.eigh(cov)
    V = V[:, np.argsort(w)[::-1]]
    e1, e2 = V[:,0], V[:,1]
    ez0 = v_nrm(v_cross(e1, e2))  # 初估法向

    # 按法向距截尾，二次 PCA
    d = np.abs(X @ ez0) if ez0 is not None else np.zeros(len(X))
    keep_n = max(100, int(len(d) * trim_pct))
    P_trim = P[np.argsort(d)[:keep_n]]
    c1 = np.mean(P_trim, axis=0)
    X1 = P_trim - c1
    cov1 = np.cov(X1, rowvar=False)
    w1, V1 = np.linalg.eigh(cov1)
    V1 = V1[:, np.argsort(w1)[::-1]]
    e1_1, e2_1 = V1[:,0], V1[:,1]
    ez = v_nrm(v_cross(e1_1, e2_1))

    # 正交收尾（以几何面法向为准）
    d2 = _re_ortho_rh(e1_1, e2_1, ez)
    ex_g, ey_g, ez_g = d2['ex'], d2['ey'], d2['ez']

    warnings = []
    lam = np.sort(w1)[::-1]
    if lam[2] > EPS:
        ratio = lam[1] / lam[2]
        if ratio < 1.3:
            warnings.append(f"weak plane separation in PCA (λ2/λ3≈{ratio:.2f})")

    return {
        'frame': {'origin': c1, 'ex': ex_g, 'ey': ey_g, 'ez': ez_g},
        'quality': 'ok',
        'warnings': warnings,
        'used': {'n_in': int(keep_n), 'n_all': int(len(points))}
    }

# ---------- 主函数 ----------
def build_occlusal_frame(
    landmarks: Dict,
    geom_points: Optional[List[np.ndarray]] = None,
    cfg: Optional[Dict] = None,
    selectors: Optional[Dict[str, List[str]]] = None,
) -> Dict:
    """
    landmarks: { landmark_name -> [x,y,z] }
    geom_points: 点云（可选）。>=50 则用于估计咬合平面与原点（几何基座）
    selectors: 可覆盖默认候选（严格对齐字典命名）
    """
    cfg = cfg or {}
    warnings: List[str] = []
    used_names: List[str] = []
    used_meta: Dict[str, Optional[str]] = {'plane': None, 'z_from': None, 'y_from': None, 'x_from': None}
    quality = 'ok'

    # —— 默认候选（严格对齐你的字典命名）——
    sel = {
        # 左/右第一磨牙（上或下均可）：只用 mb / db / bg
        'L6': ['26mb','26db','26bg','36mb','36db','36bg'],
        'R6': ['16mb','16db','16bg','46mb','46db','46bg'],
        # 上/下切牙：m / ma
        'U11': ['11m','11ma'],
        'U21': ['21m','21ma'],
        'L31': ['31m','31ma'],
        'L41': ['41m','41ma'],
        # 下颌犬牙：m / mc（用于 Y 极性）
        'L33': ['33m','33mc'],
        'R43': ['43m','43mc'],
    }
    if selectors:
        sel.update({k: v for k, v in selectors.items() if isinstance(v, list)})

    # 0) 几何基座：优先用点云决定“面与原点”
    base = _build_frame_from_geometry(geom_points, cfg) if (geom_points and len(geom_points) >= 50) else None
    if base and base.get('frame'):
        origin = np.array(base['frame']['origin'], dtype=float)
        ez = np.array(base['frame']['ez'], dtype=float)
        warnings.extend(base.get('warnings', []))
        used_meta['plane'] = 'geometry'
    else:
        origin, ez = None, None
        quality = 'fallback'
        warnings.append("geometry plane unavailable; using landmarks only")

    # 1) 取关键地标
    L6 = pick_with_name(landmarks, sel['L6']);  R6 = pick_with_name(landmarks, sel['R6'])
    U11 = pick_with_name(landmarks, sel['U11']); U21 = pick_with_name(landmarks, sel['U21'])
    L31 = pick_with_name(landmarks, sel['L31']); L41 = pick_with_name(landmarks, sel['L41'])
    L33 = pick_with_name(landmarks, sel['L33']); R43 = pick_with_name(landmarks, sel['R43'])
    for p in [L6,R6,U11,U21,L31,L41,L33,R43]:
        if p: used_names.append(p['name'])

    if not (L6 and R6):
        if base and base.get('frame'):
            warnings.append('missing left/right molars for transverse axis; returned geometry frame')
            return {'frame': base['frame'], 'quality': 'fallback', 'warnings': warnings, 'used': {'plane':'geometry', 'landmarks': used_names}}
        return {'frame': None, 'quality': 'missing', 'warnings': warnings + ['missing left/right molars for transverse axis'], 'used': {'plane': None, 'landmarks': used_names}}

    # 2) 面内初始方向：ey（右→左），ex（磨牙中点→切牙中点）
    ey_raw = v_nrm(L6['p'] - R6['p'])     # R→L
    mid_molar = 0.5 * (L6['p'] + R6['p'])

    inc_pts = [x['p'] for x in [U11,U21,L31,L41] if x]
    mid_incisal = centroid(inc_pts)
    if mid_incisal is None:
        cn_pts = [x['p'] for x in [L33, R43] if x]
        mid_incisal = centroid(cn_pts)
        warnings.append("incisal mid missing; used canines mid as proxy")
        quality = 'fallback'
    ex_raw = v_nrm(mid_incisal - mid_molar) if mid_incisal is not None else None

    # 退化/共线护栏
    if (ey_raw is None) or (ex_raw is None) or (abs(v_dot(ex_raw, ey_raw)) > 0.98):
        if base and base.get('frame'):
            warnings.append("ex/ey nearly colinear or missing; used geometry axes")
            return {'frame': base['frame'], 'quality': 'fallback', 'warnings': warnings, 'used': {'plane':'geometry', 'landmarks': used_names}}
        return {'frame': None, 'quality': 'missing', 'warnings': warnings + ['cannot form stable in-plane axes'], 'used': {'plane': None, 'landmarks': used_names}}

    # 3) 把 ex/ey 投到几何面（若有）；否则用 ex×ey 定 ez，并正交收尾
    if ez is not None:
        exp = v_nrm(proj_to_plane(ex_raw, ez)) if ex_raw is not None else None
        eyp = v_nrm(proj_to_plane(ey_raw, ez)) if ey_raw is not None else None
        d = _re_ortho_rh(exp, eyp, ez)
        ex, ey, ez = d['ex'], d['ey'], d['ez']
        if origin is None:
            origin = mid_molar if mid_incisal is None else 0.5 * (mid_molar + mid_incisal)
    else:
        ez0 = v_nrm(v_cross(ex_raw, ey_raw))
        d = _re_ortho_rh(ex_raw, ey_raw, ez0)
        ex, ey, ez = d['ex'], d['ey'], d['ez']
        origin = mid_molar if mid_incisal is None else 0.5 * (mid_molar + mid_incisal)
        quality = 'fallback'
        used_meta['plane'] = 'landmarks'

    if ex is None or ey is None or ez is None:
        return {'frame': None, 'quality': 'missing', 'warnings': warnings + ['failed to orthogonalize axes'], 'used': {'plane': used_meta['plane'], 'landmarks': used_names}}

    # 4) 极性校准：Z（上）、Y（右→左为正）
    Uc = centroid([x['p'] for x in [U11,U21] if x])
    Lc = centroid([x['p'] for x in [L31,L41] if x])
    if Uc is not None and Lc is not None and ez is not None:
        if v_dot(Uc - Lc, ez) < 0:
            ez = -ez
            ex = -ex if ex is not None else None # 保持右手
            d = _re_ortho_rh(ex, ey, ez); ex, ey, ez = d['ex'], d['ey'], d['ez']
        used_meta['z_from'] = 'incisors(upper - lower)'
    else:
        warnings.append("Z polarity skipped (insufficient incisors)")
        quality = 'fallback'

    if L33 and R43 and ey is not None:
        desired = L33['p'] - R43['p']  # 右->左（与 ey 定义一致）
        if v_dot(desired, ey) < 0:
            ey = -ey
            ex = v_nrm(v_cross(ey, ez)) if ez is not None else None
            d = _re_ortho_rh(ex, ey, ez); ex, ey, ez = d['ex'], d['ey'], d['ez']
        used_meta['y_from'] = 'canines(33→43)'
    else:
        warnings.append("Y polarity skipped (missing canines)")
        quality = 'fallback'

    # 5) X 微调：A=切牙中点，P=磨牙中点；A-P 投影到面，保证“前为 +X”
    A, P = mid_incisal, mid_molar
    if (A is not None) and (P is not None) and ez is not None and ex is not None:
        dxp = v_nrm(proj_to_plane(A - P, ez))
        if dxp is not None:
            ex_new = dxp if v_dot(dxp, ex) >= 0 else -dxp
            d = _re_ortho_rh(ex_new, ey, ez); ex, ey, ez = d['ex'], d['ey'], d['ez']
            used_meta['x_from'] = 'A(mid incisors) - P(mid molars)'
        else:
            warnings.append("X fine-tune skipped (degenerate A-P)")
            quality = 'fallback'
    else:
        warnings.append("X fine-tune skipped (missing A or P)")
        quality = 'fallback'

    # 6) 原点：优先几何质心；否则 A/P 中点或 P
    if origin is None:
        origin = P if A is None else (0.5 * (A + P) if P is not None else A)

    frame = {'origin': origin, 'ex': ex, 'ey': ey, 'ez': ez}
    return {
        'frame': frame,
        'quality': quality,
        'warnings': warnings,
        'used': {**used_meta, 'landmarks': used_names}
    }

# =======================================================================
# Module #1: Arch Form
# =======================================================================
def compute_arch_form(
    landmarks: Dict[str, List[float]],
    frame: Dict,
    arch: str = 'upper',           # 目前按上颌实现；留接口
    dec: int = 2,
    # 阈值可按人群微调
    th_icim_tapered: float = 0.72,
    th_icim_square:  float = 0.80,
    th_adic_tapered: float = 0.80,
    th_adic_square:  float = 0.60,
) -> Dict:
    """
    Module: #1 Arch Form
    Input: landmarks, frame
    Output: Dict {'form', 'indices', 'used', 'summary_text', 'quality'}
    Method: Calculates ICW (inter-canine width), IMW (inter-molar width), AD (arch depth) to classify form. Uses points: 13m, 23m, 16mb, 26mb, 11m, 21m, 12m, 22m.
    """
    def _is_xyz(p): return isinstance(p,(list,tuple,np.ndarray)) and len(p)==3 and np.isfinite(p).all()
    def _get(nm):
        p = landmarks.get(nm);  return np.asarray(p,float) if _is_xyz(p) else None
    def _xy(p):
        v = np.asarray(p,float) - np.asarray(frame['origin'],float)
        ex = np.asarray(frame['ex'],float); ey = np.asarray(frame['ey'],float)
        return float(v.dot(ex)), float(v.dot(ey))   # x=前后, y=左右(左+右-)

    if arch != 'upper' or not frame or any(k not in frame for k in ('origin','ex','ey','ez')):
        return {'form':'缺失','indices':{},'used':{},'summary_text':'Arch_Form_牙弓形态*: 缺失','quality':'missing'}

    used = {}
    # 取关键点（严格用字典键，含回退）
    def _pick_first(names: List[str]):
        for nm in names:
            p = _get(nm)
            if p is not None: return nm, p
        return None, None

    # 尖牙与磨牙
    nm13, p13 = _pick_first(['13m'])
    nm23, p23 = _pick_first(['23m'])
    nm16, p16 = _pick_first(['16mb','16db','16bg'])
    nm26, p26 = _pick_first(['26mb','26db','26bg'])
    # 切牙（前缘中点；用 11m/21m 必要时合并 12m/22m 求质心）
    P_inc = [ _get('11m'), _get('21m'), _get('12m'), _get('22m') ]
    P_inc = [p for p in P_inc if p is not None]
    pInc = np.mean(np.stack(P_inc,axis=0),axis=0) if P_inc else None
    pCanMid = None
    if p13 is not None and p23 is not None:
        pCanMid = 0.5*(p13+p23)

    used.update({'13':nm13,'23':nm23,'16':nm16,'26':nm26,'incisors':[nm for nm,_ in [("11m",_get('11m')),("21m",_get('21m')),("12m",_get('12m')),("22m",_get('22m'))] if _get(nm) is not None]})

    # 缺失检查
    if (p13 is None or p23 is None) or (p16 is None or p26 is None) or (pInc is None):
        return {'form':'缺失','indices':{},'used':used,'summary_text':'Arch_Form_牙弓形态*: 缺失','quality':'missing'}

    # 计算 ICW / IMW / AD
    x13,y13 = _xy(p13); x23,y23 = _xy(p23)
    x16,y16 = _xy(p16); x26,y26 = _xy(p26)
    xInc,_  = _xy(pInc)
    xCan,_  = _xy(pCanMid)

    ICW = abs(y13 - y23)
    IMW = abs(y16 - y26)
    AD  = max(0.0, xInc - xCan)   # 负值视为 0（理论上不应为负）

    ICW_IMW = (ICW/IMW) if IMW > 1e-6 else None
    AD_ICW  = (AD/ICW)  if ICW > 1e-6 else None

    quality = 'ok'
    if ICW_IMW is None or AD_ICW is None:
        quality = 'fallback'

    # 分类规则（可调）
    form = '卵圆形'
    if (ICW_IMW is not None and ICW_IMW <= th_icim_tapered) or (AD_ICW is not None and AD_ICW >= th_adic_tapered):
        form = '尖圆形'
    if (ICW_IMW is not None and ICW_IMW >= th_icim_square) or (AD_ICW is not None and AD_ICW <= th_adic_square):
        form = '方圆形'

    idx = {
        'ICW_mm': round(ICW, dec),
        'IMW_mm': round(IMW, dec),
        'AD_mm':  round(AD , dec),
        'ICW_IMW': round(ICW_IMW, dec) if ICW_IMW is not None else None,
        'AD_ICW':  round(AD_ICW , dec) if AD_ICW  is not None else None,
    }

    return {
        'form': form,
        'indices': idx,
        'used': used,
        'summary_text': f'Arch_Form_牙弓形态*: {form}',
        'quality': quality
    }

# =======================================================================
# Module #2: Arch Width
# =======================================================================
def compute_arch_width(
    landmarks: Dict[str, List[float]],
    frame: Dict,
    dec: int = 1,
    ap_tol_mm: float = 4.0,         # 若 |Δx| 超过此阈值，提示可能失真
    narrow_delta_mm: float = 2.0    # 判定“上牙弓较窄”的每段最小差值
) -> Dict:
    """
    Module: #2 Arch Width
    Input: landmarks, frame
    Output: Dict {'upper', 'lower', 'diff_UL_mm', 'upper_is_narrow', 'summary_text', 'quality'}
    Method: Measures transverse width at canine, premolar, and molar sections for both arches. Uses points: 13m/23m, 14b/24b, 16mb/26mb and their lower counterparts.
    """
    def _is_xyz(p):
        return isinstance(p,(list,tuple,np.ndarray)) and len(p)==3 and np.isfinite(p).all()
    def _get(nm):
        p = landmarks.get(nm)
        return np.asarray(p,float) if _is_xyz(p) else None
    def _to_local(p):
        v = np.asarray(p,float) - np.asarray(frame['origin'],float)
        ex = np.asarray(frame['ex'],float); ey = np.asarray(frame['ey'],float)
        return float(v.dot(ex)), float(v.dot(ey))  # x(AP), y(Transverse)

    if not frame or any(k not in frame for k in ('origin','ex','ey','ez')):
        return {'upper':None,'lower':None,'diff_UL_mm':None,'upper_is_narrow':None,
                'summary_text':'Arch_Width_牙弓宽度*: 缺失','quality':'missing'}

    # 选择器（严格用字典键）
    U = {
        'ant': (['13m'], ['23m']),
        'mid': (['14b'], ['24b']),
        'post': (['16mb','16db','16bg'], ['26mb','26db','26bg']),
    }
    L = {
        'ant': (['33m'], ['43m']),
        'mid': (['34b'], ['44b']),
        'post': (['36mb','36db','36bg'], ['46mb','46db','46bg']),
    }

    def _pick_first(names: List[str]):
        for nm in names:
            p = _get(nm)
            if p is not None:
                return nm, p
        return None, None

    def _pair_width(section_key: str, side_def: Dict[str, tuple]):
        # 返回该段的主宽度(|Δy|)、欧氏、|Δx|与警告、用到的标签
        left_names, right_names = side_def[section_key]
        nmL, pL = _pick_first(left_names)
        nmR, pR = _pick_first(right_names)
        used = {'left': nmL, 'right': nmR}
        warnings = []
        if pL is None or pR is None:
            return None, None, None, used, warnings
        xL,yL = _to_local(pL); xR,yR = _to_local(pR)
        dx, dy = abs(xR-xL), abs(yR-yL)
        if dx > ap_tol_mm:
            warnings.append(f'{section_key}: |Δx|={dx:.1f}mm > {ap_tol_mm}mm，宽度可能失真')
        euclid = float(np.hypot(dx, dy))
        return float(dy), float(euclid), float(dx), used, warnings

    def _arch(side_def):
        out = {'anterior_mm': None, 'middle_mm': None, 'posterior_mm': None,
               'euclid_mm': {'anterior':None,'middle':None,'posterior':None},
               'dx_mm': {'anterior':None,'middle':None,'posterior':None},
               'used': {'anterior':None,'middle':None,'posterior':None}, 'warnings': []}
        for key, pretty in [('ant','anterior'),('mid','middle'),('post','posterior')]:
            dy, dE, dx, used, warns = _pair_width(key, side_def)
            out[f'{pretty}_mm'] = None if dy is None else float(np.round(dy, dec))
            out['euclid_mm'][pretty] = None if dE is None else float(np.round(dE, dec))
            out['dx_mm'][pretty] = None if dx is None else float(np.round(dx, dec))
            out['used'][pretty] = used
            out['warnings'].extend(warns)
        return out

    upper = _arch(U)
    lower = _arch(L)

    # 差值（上-下）
    diffs = {}
    segs_ok = 0
    votes_narrow = 0
    for pretty in ['anterior','middle','posterior']:
        u = upper[f'{pretty}_mm']; l = lower[f'{pretty}_mm']
        diffs[pretty] = None if (u is None or l is None) else float(np.round(u - l, dec))
        if diffs[pretty] is not None:
            segs_ok += 1
            if (u - l) < -narrow_delta_mm:
                votes_narrow += 1

    # 判定“上牙弓较窄”
    upper_is_narrow = None
    if segs_ok >= 2:
        upper_is_narrow = (votes_narrow >= 2)  # 至少两段满足 U < L − δ
    quality = 'ok'
    if (upper['warnings'] or lower['warnings']):
        quality = 'fallback'
    if segs_ok == 0:
        quality = 'missing'

    # 文案
    if upper_is_narrow is None:
        summary = 'Arch_Width_牙弓宽度*: 缺失'
    else:
        summary = 'Arch_Width_牙弓宽度*: 上牙弓较窄' if upper_is_narrow else 'Arch_Width_牙弓宽度*: 未见上牙弓较窄'

    return {
        'upper': upper,
        'lower': lower,
        'diff_UL_mm': diffs,              # 每段 U-L（负表示上比下窄）
        'upper_is_narrow': upper_is_narrow,
        'thresholds': {'ap_tol_mm': float(ap_tol_mm), 'narrow_delta_mm': float(narrow_delta_mm)},
        'summary_text': summary,
        'quality': quality
    }

# -----------------------------------------------------------------------
# Module #3: Bolton Ratio
# Input: landmarks, frame (optional), cfg (optional)
# Output: Dict {'kind', 'anterior', 'overall', 'quality', 'used', 'summary_text'}
# Method: Calculates anterior and overall Bolton ratios by summing mesiodistal widths (mc-dc) of teeth.
# -----------------------------------------------------------------------
def compute_bolton(
    landmarks: Dict[str, List[float]],
    frame: Optional[Dict] = None,
    cfg: Optional[Dict] = None
) -> Dict:
    cfg = cfg or {}
    mode = cfg.get('mode', 'plane')        # 'plane' or '3d'
    dec  = int(cfg.get('dec', 2))
    target_A = float(cfg.get('target_anterior', 77.2))
    target_O = float(cfg.get('target_overall', 91.3))
    tol_A    = float(cfg.get('tol_anterior', 2.0))
    tol_O    = float(cfg.get('tol_overall', 2.0))
    min_A    = int(cfg.get('min_anterior', 5))  # 至少6颗中的5颗
    min_O    = int(cfg.get('min_overall', 10))  # 至少12颗中的10颗

    def _is_xyz(p):
        return isinstance(p, (list, tuple, np.ndarray)) and len(p) == 3 and np.isfinite(p).all()

    def _pick(nm):
        p = landmarks.get(nm)
        return np.asarray(p, float) if _is_xyz(p) else None

    def _width_md(tooth: str) -> Tuple[Optional[float], Optional[str]]:
        """返回 (宽度mm, 使用的键名串)；按 cfg['mode'] 在 XY 或 3D 量 mc↔dc"""
        pm = _pick(f'{tooth}mc'); pd = _pick(f'{tooth}dc')
        if pm is None or pd is None:
            return None, None
        if mode == 'plane' and frame:
            # 投影到XY平面再算距离（与 JS 默认口径一致）
            o = np.asarray(frame['origin'], float)
            ex = np.asarray(frame['ex'], float); ey = np.asarray(frame['ey'], float)
            vm = pm - o; vd = pd - o
            m_xy = np.array([vm.dot(ex), vm.dot(ey)], float)
            d_xy = np.array([vd.dot(ex), vd.dot(ey)], float)
            w = float(np.linalg.norm(m_xy - d_xy))
        else:
            # 3D 欧氏距离
            w = float(np.linalg.norm(pm - pd))
        return w, f'{tooth}mc-{tooth}dc'

    # 牙位列表（FDI）：不含第二磨牙
    upper_overall = ['16','15','14','13','12','11','21','22','23','24','25','26']
    lower_overall = ['36','35','34','33','32','31','41','42','43','44','45','46']
    upper_anterior = ['13','12','11','21','22','23']
    lower_anterior = ['33','32','31','41','42','43']

    def _sum_width(tooth_list: List[str]):
        s, used, missing = 0.0, [], []
        for t in tooth_list:
            w, tag = _width_md(t)
            if w is None:
                missing.append(t)
            else:
                s += w; used.append(tag)
        return s, used, missing

    # 计算汇总
    UO, used_UO, miss_UO = _sum_width(upper_overall)
    LO, used_LO, miss_LO = _sum_width(lower_overall)
    UA, used_UA, miss_UA = _sum_width(upper_anterior)
    LA, used_LA, miss_LA = _sum_width(lower_anterior)

    used = {
        'upper_overall': used_UO, 'lower_overall': used_LO,
        'upper_anterior': used_UA, 'lower_anterior': used_LA,
        'missing': list(set(miss_UO + miss_LO + miss_UA + miss_LA)),
        'mode': mode
    }

    quality = 'ok'
    if (len(used_UA) < min_A) or (len(used_LA) < min_A):
        quality = 'fallback'
    if (len(used_UO) < min_O) or (len(used_LO) < min_O):
        quality = 'fallback'

    def _pack(sumU, sumL, target, tol, nU, nL):
        if sumU <= 1e-6 or nU == 0 or nL == 0:
            return {
                'ratio': None, 'target': target, 'tol': tol,
                'sum_upper_mm': round(sumU, dec), 'sum_lower_mm': round(sumL, dec),
                'discrep_mm': None, 'status': '缺失', 'n_upper': nU, 'n_lower': nL
            }
        ratio = (sumL / sumU) * 100.0
        discrep = sumL - (sumU * target / 100.0)  # >0 下颌牙量过大；<0 上颌牙量过大
        # 判定
        if abs(ratio - target) <= tol:
            status = '正常'
        elif ratio > target + tol:
            status = '下颌牙量过大'
        else:
            status = '上颌牙量过大'
        return {
            'ratio': round(ratio, dec), 'target': target, 'tol': tol,
            'sum_upper_mm': round(sumU, dec), 'sum_lower_mm': round(sumL, dec),
            'discrep_mm': round(discrep, dec), 'status': status,
            'n_upper': nU, 'n_lower': nL
        }

    anterior = _pack(UA, LA, target_A, tol_A, len(used_UA), len(used_LA))
    overall  = _pack(UO, LO, target_O, tol_O, len(used_UO), len(used_LO))

    # 总结文本（可选）
    if anterior['status'] == '正常' and overall['status'] == '正常':
        summary = '正常bolton'
    else:
        parts = []
        if anterior['status'] != '正常':
            dirA = '下颌' if anterior['discrep_mm'] and anterior['discrep_mm'] > 0 else '上颌'
            parts.append(f'前牙比{anterior["status"]}（{dirA}差 {abs(anterior["discrep_mm"] or 0):.2f}mm）')
        if overall['status'] != '正常':
            dirO = '下颌' if overall['discrep_mm'] and overall['discrep_mm'] > 0 else '上颌'
            parts.append(f'全牙比{overall["status"]}（{dirO}差 {abs(overall["discrep_mm"] or 0):.2f}mm）')
        summary = '；'.join(parts)

    return {
        'kind': 'Bolton_Ratio',
        'anterior': anterior,
        'overall': overall,
        'quality': quality if (anterior['ratio'] is not None and overall['ratio'] is not None) else 'missing',
        'used': used,
        'summary_text': summary
    }

# =======================================================================
# Module #4: Canine Relationship
# =======================================================================
def compute_canine_relationship(
    landmarks: Dict[str, List[float]],
    frame: Dict,
    dec: int = 1,
    alpha: float = 0.35,      # 弓段比例（m → 同侧第一前磨牙mc）
    beta_mm: float = 1.5,     # 固定后退（仅X）
    tol_edge_mm: float = 0.5, # 尖对尖容差
    complete_mm: float = 2.0  # 完全近/远中阈值
) -> Dict:
    """
    Module: #4 Canine Relationship
    Input: landmarks, frame
    Output: Dict {'right', 'left', 'summary_text', 'quality', 'params'}
    Method: Compares the anteroposterior position (X-axis) of upper canine (13m/23m) with a proxy for the lower canine embrasure.
    """
    def _is_xyz(p): 
        return isinstance(p,(list,tuple,np.ndarray)) and len(p)==3 and np.isfinite(p).all()
    def _get(nm):
        p = landmarks.get(nm)
        return (np.asarray(p,float) if _is_xyz(p) else None)
    def _x(p):
        v = p - np.asarray(frame['origin'],float)
        ex = np.asarray(frame['ex'],float)
        return float(v.dot(ex))

    if not frame or any(k not in frame for k in ('origin','ex','ey','ez')):
        return {'right':None,'left':None,'summary_text':'Canine_Relationship_尖牙关系*: 缺失','quality':'missing','params':{'alpha':alpha,'beta_mm':beta_mm,'tol_edge_mm':tol_edge_mm,'complete_mm':complete_mm}}

    def lower_dmr_proxy(side: str):
        """
        side: 'right' or 'left'
        右侧用 43/44，左侧用 33/34
        返回 (x_proxy, source, used_names)
        """
        if side == 'right':
            can_nm, prem_mc_nm, dc_nm = '43m', '44mc', '43dc'
        else:
            can_nm, prem_mc_nm, dc_nm = '33m', '34mc', '33dc'

        p_can, p_mc, p_dc = _get(can_nm), _get(prem_mc_nm), _get(dc_nm)
        used = {'canine_m': can_nm if p_can is not None else None,
                'premolar_mc': prem_mc_nm if p_mc is not None else None,
                'canine_dc': dc_nm if p_dc is not None else None}

        if p_can is None:
            return None, 'missing', used

        x_can = _x(p_can)
        # A) 弓段比例
        if p_mc is not None:
            x_proxy = x_can + alpha * (_x(p_mc) - x_can)
            return x_proxy, 'arch_alpha', used
        # B) 线段内插（m→dc）
        if p_dc is not None:
            x_proxy = x_can + 0.5 * (_x(p_dc) - x_can)
            return x_proxy, 'line_interp', used
        # C) 固定后退
        x_proxy = x_can - beta_mm
        return x_proxy, 'shift_beta', used

    def classify(dx: Optional[float]) -> str:
        if dx is None: return '缺失'
        if abs(dx) <= tol_edge_mm:
            if dx < 0:  return '远中尖对尖'
            if dx > 0:  return '近中尖对尖'
            return '尖对尖'
        if dx <= -complete_mm: return '完全远中'
        if dx >=  complete_mm: return '完全近中'
        return '远中' if dx < 0 else '近中'

    def one_side(upper_nm: str, side: str):
        U = _get(upper_nm)
        xU = _x(U) if U is not None else None
        xL, src, used = lower_dmr_proxy(side)
        if (xU is None) or (xL is None):
            return {'dx_mm': None, 'label': '缺失', 'source': src, 'used': {'upper': upper_nm, **used}}
        dx = xU - xL  # +为近中，−为远中
        return {
            'dx_mm': float(np.round(dx, dec)),
            'label': classify(dx),
            'source': src,
            'used': {'upper': upper_nm, **used}
        }

    right = one_side('13m', 'right')
    left  = one_side('23m', 'left')

    # 质量与汇总文案
    if right['dx_mm'] is None and left['dx_mm'] is None:
        quality = 'missing'
        summary = 'Canine_Relationship_尖牙关系*: 缺失'
    else:
        quality = 'ok' if ('缺失' not in (right['label'], left['label'])) else 'fallback'
        r_txt = right['label'] if right['label'] != '缺失' else '缺失'
        l_txt = left['label']  if left ['label'] != '缺失' else '缺失'
        summary = f"Canine_Relationship_尖牙关系*: 右侧{r_txt}，左侧{l_txt}"

    return {
        'right': right,
        'left': left,
        'summary_text': summary,
        'quality': quality,
        'params': {'alpha': float(alpha), 'beta_mm': float(beta_mm), 'tol_edge_mm': float(tol_edge_mm), 'complete_mm': float(complete_mm)}
    }

# =======================================================================
# Module #5: Crossbite
# Input: landmarks, frame
# Output: Dict {'right', 'left', 'summary_text', 'threshold_mm', 'quality', 'used'}
# Method: Compares the transverse position (Y-axis) of buccal and lingual cusps of posterior teeth (premolars and molars) on each side.
# =======================================================================
def compute_crossbite(
    landmarks: Dict,
    frame: Dict,
    threshold_mm: float = 1.5,
    min_pairs: int = 2,
) -> Dict:
    """
    Crossbite_锁牙合（按侧判定）
    规则（在 Y 轴“颊向度”上比较，左侧 +，右侧 −）：
      正锁： mean(UL) 比 mean(LB) 更颊向，且配对数>=min_pairs，差值 > threshold_mm
      反锁： mean(LL) 比 mean(UB) 更颊向，且配对数>=min_pairs，差值 > threshold_mm
    颊侧候选：mb, db, b, bg；舌侧候选：ml, dl, l, lgb
    返回 status: '无' | '正锁' | '反锁' | 'missing'
    """
    def _is_xyz(p):
        return isinstance(p,(list,tuple,np.ndarray)) and len(p)==3 and np.isfinite(p).all()
    def _get(nm):
        p = landmarks.get(nm)
        return np.asarray(p,float) if _is_xyz(p) else None
    def _y_local(p):
        v = p - np.asarray(frame['origin'],float)
        ey = np.asarray(frame['ey'],float)
        return float(v.dot(ey))

    if not frame or any(k not in frame for k in ('origin','ex','ey','ez')):
        return {'right':None,'left':None,'summary_text':'Crossbite_锁牙合: 缺失','threshold_mm':threshold_mm,'quality':'missing','used':{'points':[]}}

    # 牙位（FDI）
    U_right, L_right = ['14','15','16','17'], ['44','45','46','47']
    U_left , L_left  = ['24','25','26','27'], ['34','35','36','37']

    BUCCAL  = ['mb','db','b','bg']    # 颊侧
    LINGUAL = ['ml','dl','l','lgb']   # 舌侧（不含 lb，按你们字典）

    used_pts: List[str] = []

    def side_eval(U_list: List[str], L_list: List[str], side: str):
        # 收集每颗牙的代表点Y值（各取一个候选，随后做均值）
        UL, UB, LL, LB = [], [], [], []
        for t in U_list:
            yL = None; yB = None
            for sfx in LINGUAL:
                p = _get(f'{t}{sfx}')
                if p is not None: yL = _y_local(p); used_pts.append(f'{t}{sfx}'); break
            for sfx in BUCCAL:
                p = _get(f'{t}{sfx}')
                if p is not None: yB = _y_local(p); used_pts.append(f'{t}{sfx}'); break
            if yL is not None: UL.append(yL)
            if yB is not None: UB.append(yB)
        for t in L_list:
            yL = None; yB = None
            for sfx in LINGUAL:
                p = _get(f'{t}{sfx}')
                if p is not None: yL = _y_local(p); used_pts.append(f'{t}{sfx}'); break
            for sfx in BUCCAL:
                p = _get(f'{t}{sfx}')
                if p is not None: yB = _y_local(p); used_pts.append(f'{t}{sfx}'); break
            if yL is not None: LL.append(yL)
            if yB is not None: LB.append(yB)

        # 侧向符号：左侧 +1（Y向左为正），右侧 -1（Y向右为负）
        sgn = +1.0 if side == 'left' else -1.0

        # 计算均值与可用配对数
        m_UL = np.mean(UL) if UL else None
        m_UB = np.mean(UB) if UB else None
        m_LL = np.mean(LL) if LL else None
        m_LB = np.mean(LB) if LB else None
        pairs_scissor = min(len(UL), len(LB))  # UL ↔ LB
        pairs_cross   = min(len(UB), len(LL))  # UB ↔ LL

        # 判定（优先判断正锁；若不满足再判断反锁）
        status = '无'; margin = 0.0
        channel = None
        if pairs_scissor >= min_pairs and (m_UL is not None) and (m_LB is not None):
            val_scissor = sgn * (m_UL - m_LB)
            if val_scissor > threshold_mm:
                status = '正锁'; margin = val_scissor; channel = 'UL>LB'
        if status == '无' and pairs_cross >= min_pairs and (m_UB is not None) and (m_LL is not None):
            val_cross = sgn * (m_LL - m_UB)
            if val_cross > threshold_mm:
                status = '反锁'; margin = val_cross; channel = 'LL>UB'

        # 数据不足时返回 missing
        if (pairs_scissor < min_pairs) and (pairs_cross < min_pairs):
            status = 'missing'

        return {
            'status': status,
            'margin_mm': round(float(margin), 2),
            'pairs_scissor': int(pairs_scissor),
            'pairs_cross': int(pairs_cross),
            'channel': channel,
            'means': {
                'UL': round(float(m_UL),2) if m_UL is not None else None,
                'UB': round(float(m_UB),2) if m_UB is not None else None,
                'LL': round(float(m_LL),2) if m_LL is not None else None,
                'LB': round(float(m_LB),2) if m_LB is not None else None,
            }
        }

    right = side_eval(U_right, L_right, 'right')
    left  = side_eval(U_left , L_left , 'left')

    # 汇总
    if right['status'] == 'missing' and left['status'] == 'missing':
        summary = 'Crossbite_锁牙合: 缺失'
        quality = 'missing'
    elif right['status'] == '无' and left['status'] == '无':
        summary = 'Crossbite_锁牙合: 无'
        quality = 'ok'
    else:
        parts = []
        if right['status'] != '无' and right['status'] != 'missing':
            parts.append(f'右侧{right["status"]}')
        if left['status']  != '无' and left['status']  != 'missing':
            parts.append(f'左侧{left["status"]}')
        summary = 'Crossbite_锁牙合: ' + '，'.join(parts) if parts else 'Crossbite_锁牙合: 无'
        quality = 'ok' if ('missing' not in (right['status'], left['status'])) else 'fallback'

    return {
        'right': right,
        'left': left,
        'summary_text': summary,
        'threshold_mm': float(threshold_mm),
        'min_pairs': int(min_pairs),
        'quality': quality,
        'used': {'points': list(dict.fromkeys(used_pts))}
    }

# =======================================================================
# Module #6: Crowding
# =======================================================================
def compute_crowding(
    landmarks: Dict[str, List[float]],
    frame: Optional[Dict] = None,
    arch: str = 'both',          # 'upper' | 'lower' | 'both'
    use_plane: bool = True,      # True: 在XY平面量（与JS一致）；False: 3D
    dec: int = 1,                # 小数位
    min_pairs: int = 3,          # 至少3个相邻对参与
    min_teeth: int = 4,          # 至少4颗牙参与宽度
) -> Dict:
    """
    Module: #6 Crowding
    Input: landmarks, frame (optional)
    Output: Dict {'upper', 'lower', 'summary_text', 'quality'}
    Method: Calculates Arch Length Discrepancy (ALD) for anterior segments by comparing available space (sum of contact point distances) with required space (sum of tooth widths). Uses points: 23-13 (upper) and 33-43 (lower) series, including mc, mr, m, dc, dr.
    """
    def _is_xyz(p): return isinstance(p,(list,tuple,np.ndarray)) and len(p)==3 and np.isfinite(p).all()
    def _get(nm):
        p = landmarks.get(nm)
        return np.asarray(p,float) if _is_xyz(p) else None

    def _to_xy(p):
        if not use_plane or frame is None:  # 3D 直接返回
            return np.asarray(p,float)
        o = np.asarray(frame['origin'],float)
        ex = np.asarray(frame['ex'],float); ey = np.asarray(frame['ey'],float)
        v = np.asarray(p,float) - o
        return np.array([v.dot(ex), v.dot(ey)], float)  # 仅用 XY

    # 前牙序列（FDI）
    U_ANT = ['23','22','21','11','12','13']   # 上
    L_ANT = ['33','32','31','41','42','43']   # 下

    def _build_pairs(seq):  # 相邻牙对：[(23,22),(22,21),...]
        return list(zip(seq[:-1], seq[1:]))

    def _get_contact(tooth: str, kind: str):
        # JS 回退顺序：mc -> [mc, mr, m]；dc -> [dc, dr]
        if kind == 'mc':
            for sfx in ['mc','mr','m']:
                p = _get(f'{tooth}{sfx}')
                if p is not None: return p, f'{tooth}{sfx}'
        else:  # 'dc'
            for sfx in ['dc','dr']:
                p = _get(f'{tooth}{sfx}')
                if p is not None: return p, f'{tooth}{sfx}'
        return None, None

    def _width_md(tooth: str) -> Optional[float]:
        pm,_ = _get_contact(tooth, 'mc'); pd,_ = _get_contact(tooth, 'dc')
        if pm is None or pd is None: return None
        if use_plane and frame is not None:
            a, b = _to_xy(pm), _to_xy(pd)
            return float(np.linalg.norm(a - b))
        else:
            return float(np.linalg.norm(pm - pd))

    def _measure_pairs(pairs: List[Tuple[str, str]]):
        per, used, missing = {}, [], []
        s = 0.0
        for L, R in pairs:
            pL, tagL = _get_contact(L, 'dc')
            pR, tagR = _get_contact(R, 'mc')
            key = f'{L}-{R}'
            if pL is None or pR is None:
                per[key] = None; missing.append(key); continue
            if use_plane and frame is not None:
                a, b = _to_xy(pL), _to_xy(pR)
                d = float(np.hypot(a[0]-b[0], a[1]-b[1]))
            else:
                d = float(np.linalg.norm(pL - pR))
            per[key] = round(d, dec); s += d
            used.append({'pair': key, 'left_point': tagL, 'right_point': tagR})
        n_valid = sum(1 for v in per.values() if isinstance(v,(int,float)))
        warns = []
        if n_valid < min_pairs:
            warns.append(f'few valid adjacent pairs ({n_valid} < {min_pairs})')
        return {
            'gap_sum_mm': round(s, dec) if n_valid>0 else None,
            'per_pair_mm': per,
            'pairs_used': used,
            'missing_pairs': missing,
            'n_pairs': n_valid,
            'warnings': warns
        }

    def _measure_teeth(teeth: List[str]):
        per, miss = {}, []
        s = 0.0; n = 0
        for t in teeth:
            w = _width_md(t)
            if w is None: per[t]=None; miss.append(t)
            else: per[t]=round(w, dec); s += w; n += 1
        warns = []
        if n < min_teeth:
            warns.append(f'few valid teeth ({n} < {min_teeth})')
        return {
            'required_sum_mm': round(s, dec) if n>0 else None,
            'per_tooth_width_mm': per,
            'missing_teeth': miss,
            'n_teeth': n,
            'warnings': warns
        }

    def _assemble(seq: List[str]):
        pairs = _build_pairs(seq)
        gap = _measure_pairs(pairs)
        req = _measure_teeth(seq)
        ald = None
        if gap['gap_sum_mm'] is not None and req['required_sum_mm'] is not None:
            ald = round(gap['gap_sum_mm'] - req['required_sum_mm'], dec)
        summary = None
        if ald is not None:
            summary = (f"间隙 +{abs(ald):.{dec}f} mm" if ald >= 0
                       else f"拥挤 {abs(ald):.{dec}f} mm")
        quality = ('missing' if (gap['n_pairs']==0 or req['n_teeth']==0)
                   else ('fallback' if (gap['warnings'] or req['warnings']) else 'ok'))
        return {
            'gap_sum_mm': gap['gap_sum_mm'],
            'required_sum_mm': req['required_sum_mm'],
            'ald_mm': ald,
            'summary': summary,
            'n_pairs': gap['n_pairs'], 'n_teeth': req['n_teeth'],
            'warnings': gap['warnings'] + req['warnings'],
            'quality': quality,
        }

    upper = _assemble(U_ANT) if arch in ('upper','both') else None
    lower = _assemble(L_ANT) if arch in ('lower','both') else None

    # 汇总质量
    parts = [p for p in (upper,lower) if p is not None]
    quality = 'missing'
    if parts:
        if any(p['quality']=='ok' for p in parts): quality = 'ok'
        elif any(p['quality']=='fallback' for p in parts): quality = 'fallback'

    # 一句话输出（就是你要的两段）
    out_lines = []
    if upper and upper['summary']: out_lines.append(f"上牙列{upper['summary']}")
    if lower and lower['summary']: out_lines.append(f"下牙列{lower['summary']}")
    summary_text = ' '.join(out_lines) if out_lines else 'Crowding_拥挤度: 缺失'

    return {
        'upper': upper,
        'lower': lower,
        'summary_text': summary_text,
        'arch': arch,
        'use_plane': use_plane,
        'quality': quality
    }

# =======================================================================
# Module #7: Curve_of_Spee
# Input: landmarks, frame
# Output: Dict {'depth_mm', 'used', 'quality'}
# Method: Measures the maximum perpendicular distance from the lower cusp tips to a chord from the incisors (31/41) to the most posterior molar (37/47).
# =======================================================================
def compute_spee(landmarks: Dict, frame: Dict, dec: int = 1) -> Optional[float]:
    if not frame or any(k not in frame for k in ('origin','ex','ez')):
        return None

    origin = np.asarray(frame['origin'], float)
    ex = np.asarray(frame['ex'], float)   # AP 轴
    ez = np.asarray(frame['ez'], float)   # Vertical 轴
    EPS = 1e-9

    def _get(nm):
        p = landmarks.get(nm)
        if isinstance(p, (list, tuple, np.ndarray)) and len(p)==3 and np.isfinite(p).all():
            return np.asarray(p, float)
        return None
    def _pick(names: List[str]):
        for nm in names:
            p = _get(nm)
            if p is not None: return p
        return None
    def _xz(p):
        v = p - origin
        return float(v.dot(ex)), float(v.dot(ez))

    # A：下切牙前端
    p31ma, p41ma = _get('31ma'), _get('41ma')
    if p31ma is not None and p41ma is not None:
        A = 0.5*(p31ma+p41ma)
    else:
        A = _pick(['31ma','41ma','31m','41m'])
    if A is None: return None
    Ax, Az = _xz(A)

    # B：后端（x 最小）
    B_cands = ['37db','47db','37mb','47mb','36db','46db','36mb','46mb']
    B = None; minx = None
    for nm in B_cands:
        p = _get(nm)
        if p is None: continue
        x, _ = _xz(p)
        if (minx is None) or (x < minx):
            minx, B = x, p
    if B is None: return None
    Bx, Bz = _xz(B)

    # 采样（仅取 x ∈ [Ax,Bx]）
    samples = ['33m','34b','35b','36mb','36db','37mb','37db',
               '43m','44b','45b','46mb','46db','47mb','47db']
    xmin, xmax = (Ax, Bx) if Ax <= Bx else (Bx, Ax)

    # 弦向量与法向（在 XZ）
    ux, uz = (Bx-Ax), (Bz-Az)
    L = (ux*ux + uz*uz)**0.5
    if L < EPS: return None
    ux, uz = ux/L, uz/L           # 单位弦向量
    nx, nz = -uz, ux              # 垂直于弦（朝“下”为正）
    if nz > 0: nx, nz = -nx, -nz  # 让 n 指向 z 负方向
    use_vertical = abs(nz) < 1e-3 # 垂线几乎水平 → 用竖直回退

    depth = 0.0
    for nm in samples:
        p = _get(nm)
        if p is None: continue
        x, z = _xz(p)
        if x < xmin - 1e-6 or x > xmax + 1e-6:  # 不在弦的 x 区间，忽略
            continue
        wx, wz = (x-Ax), (z-Az)
        t = wx*ux + wz*uz  # 弧长参数（单位：mm）
        if t < -1e-6 or t > L + 1e-6:  # 超出弦端，忽略
            continue
        if use_vertical:
            zc = Az + t*uz
            d = zc - z          # 正号 = 点在弦下方
        else:
            d = wx*nx + wz*nz   # 正号 = 点在弦下方
        if d > depth: depth = d

    return float(np.round(depth, dec))

# =======================================================================
# Module #8: Midline Alignment
# =======================================================================
def compute_midline_alignment(
    landmarks: Dict[str, List[float]],
    frame: Dict,
    threshold_mm: float = 1.0,
    dec: int = 1
) -> Dict:
    """
    Module: #8 Midline Alignment
    Input: landmarks, frame
    Output: Dict {'is_pass', 'upper', 'lower', 'quality', 'summary_text'}
    Method: Measures the transverse deviation (Y-axis) of the upper (11-21) and lower (31-41) midline points from the frame's sagittal plane. Uses points: 11ma, 21ma, 11m, 21m, 31ma, 41ma, 31m, 41m.
    """
    def _is_xyz(p):
        return isinstance(p,(list,tuple,np.ndarray)) and len(p)==3 and np.isfinite(p).all()
    def _pick(nm):
        p = landmarks.get(nm)
        return np.asarray(p,float) if _is_xyz(p) else None
    def _mid2(a, b):
        if a is not None and b is not None: return 0.5*(a+b)
        return a if a is not None else b  
    def _y_local(p):
        v = p - np.asarray(frame['origin'],float)
        ey = np.asarray(frame['ey'],float)
        return float(v.dot(ey))

    if not frame or any(k not in frame for k in ('origin','ex','ey','ez')):
        return {
            'kind':'Midline_Alignment',
            'is_pass': False,
            'upper': {'right_mm': None, 'dir': None, 'signed_y_mm': None},
            'lower': {'right_mm': None, 'dir': None, 'signed_y_mm': None},
            'threshold_mm': threshold_mm,
            'quality': 'missing',
        }

    U = _mid2(_pick('11ma'), _pick('21ma'))
    if U is None:
        U = _mid2(_pick('11m'), _pick('21m'))
    L = _mid2(_pick('31ma'), _pick('41ma'))
    if L is None:
        L = _mid2(_pick('31m'), _pick('41m'))

    quality = 'ok'
    if U is None or L is None:
        return {
            'kind':'Midline_Alignment',
            'is_pass': False,
            'upper': {'right_mm': None, 'dir': None, 'signed_y_mm': None},
            'lower': {'right_mm': None, 'dir': None, 'signed_y_mm': None},
            'threshold_mm': threshold_mm,
            'quality': 'missing',
        }

    Uy = _y_local(U)
    Ly = _y_local(L)

    def _pack(y):
        if abs(y) < 1e-6:
            dir_txt = '居中'
        elif y < 0:
            dir_txt = '右偏'
        else:
            dir_txt = '左偏'
        # 右偏多少（左偏则记 0）
        right_mm = max(0.0, -y)
        return {
            'right_mm': float(np.round(right_mm, dec)),
            'dir': dir_txt,
            'signed_y_mm': float(np.round(y, dec)),
        }

    up  = _pack(Uy)
    low = _pack(Ly)

    # 是否合格：上下两者绝对偏移均 ≤ 阈值
    is_pass = (abs(Uy) <= threshold_mm) and (abs(Ly) <= threshold_mm)

    return {
        'kind': 'Midline_Alignment',
        'is_pass': bool(is_pass),
        'upper': up,
        'lower': low,
        'threshold_mm': float(threshold_mm),
        'quality': quality,
        'summary_text': f"上中线{up['dir']}{abs(up['signed_y_mm']):.{dec}f}mm 下中线{low['dir']}{abs(low['signed_y_mm']):.{dec}f}mm"
    }

# =======================================================================
# Module #9: Molar Relationship
# =======================================================================
def compute_molar_relationship(
    landmarks: Dict[str, List[float]],
    frame: Dict,
    dec: int = 1
) -> Dict:
    """
    Module: #9 Molar Relationship
    Input: landmarks, frame
    Output: Dict {'right', 'left', 'range_mm', 'quality', 'summary_text'}
    Method: Calculates the anteroposterior difference (X-axis) between upper (16/26) and lower (46/36) first molar buccal cusps to determine Angle Class II. Uses points: 16mb, 26mb, 46mb, 36mb and fallbacks.
    """
    # --- 可配置参数 ---
    # 定义“完全远中关系”的区间 (单位 mm)
    # 临床上，一个完整的II类远中关系约为一个前磨牙宽度(~7mm)，尖对尖约为3.5mm。
    # 因此，我们将 [2.5, 7.5] 定义为“完全远中”的合理区间。
    COMPLETE_DISTAL_RANGE = {'min': 2.5, 'max': 7.5}

    # --- 辅助函数 ---
    def _is_xyz(p):
        return isinstance(p, (list, tuple, np.ndarray)) and len(p) == 3 and np.isfinite(p).all()

    def _pick(names: List[str]):
        for nm in names:
            p = landmarks.get(nm)
            if _is_xyz(p):
                return nm, np.asarray(p, float)
        return None, None

    def _x_local(p):
        v = p - np.asarray(frame['origin'], float)
        ex = np.asarray(frame['ex'], float)
        return float(v.dot(ex))

    # --- 主逻辑 ---
    if not frame or any(k not in frame for k in ('origin', 'ex', 'ey', 'ez')):
        return {
            'right': None, 'left': None,
            'range_mm': COMPLETE_DISTAL_RANGE, 'quality': 'missing',
            'summary_text': 'Molar_Relationship_磨牙关系*: 缺失'
        }

    # --- 地标点拾取 ---
    # 右侧: 上16mb(颊尖) vs 下46mb(颊尖)
    uR_name, uR = _pick(['16mb', '16db', '16bg'])
    lR_name, lR = _pick(['46mb', '46bg']) # 下颌改为颊尖，更符合安氏分类比较
    # 左侧: 上26mb(颊尖) vs 下36mb(颊尖)
    uL_name, uL = _pick(['26mb', '26db', '26bg'])
    lL_name, lL = _pick(['36mb', '36bg'])

    quality = 'ok'
    if (uR is None or lR is None) or (uL is None or lL is None):
        quality = 'fallback'
    if (uR is None or lR is None) and (uL is None or lL is None):
        quality = 'missing'


    def _side_eval(u_name, u_p, l_name, l_p):
        if u_p is None or l_p is None:
            return {
                'is_complete_distal': None,
                'dx_mm': None,
                'used': {'upper': u_name, 'lower': l_name}
            }
        
        # 修正核心逻辑: dx > 0 代表上颌靠前 (远中关系 / Class II)
        dx = _x_local(u_p) - _x_local(l_p)
        
        # 修正判断条件
        is_comp = (dx >= COMPLETE_DISTAL_RANGE['min']) and (dx <= COMPLETE_DISTAL_RANGE['max'])
        
        return {
            'is_complete_distal': bool(is_comp),
            'dx_mm': float(np.round(dx, dec)),
            'used': {'upper': u_name, 'lower': l_name}
        }

    right = _side_eval(uR_name, uR, lR_name, lR)
    left  = _side_eval(uL_name, uL, lL_name, lL)

    # --- 生成总结文本 ---
    def _word(s):
        if s['is_complete_distal'] is None: return '缺失'
        return '完全远中' if s['is_complete_distal'] else '非完全远中'

    summary = f"Molar_Relationship_磨牙关系*: 右侧{_word(right)} 左侧{_word(left)}"

    return {
        'right': right,
        'left': left,
        'range_mm': COMPLETE_DISTAL_RANGE,
        'quality': quality,
        'summary_text': summary
    }

# =======================================================================
# Module #10: Overbite
# =======================================================================
def compute_overbite(
    landmarks: Dict[str, List[float]],
    frame: Dict,
    dec: int = 1,
    # 口径阈值（可按人群调参）
    normal_low_mm: float = 1.0,   # 正常下限
    normal_high_mm: float = 4.0,  # 正常上限
    deep_mm: float = 5.0          # ≥ 深覆
) -> Dict:
    """
    Module: #10 Overbite
    Input: landmarks, frame
    Output: Dict {'value_mm', 'category', 'summary_text', 'quality', ...}
    Method: Measures the vertical overlap (Z-axis) between upper (11/21) and lower (41/31) incisal edges. Uses points: 11m, 11ma, 21m, 21ma, 41m, 31m.
    """
    def _is_xyz(p): 
        return isinstance(p,(list,tuple,np.ndarray)) and len(p)==3 and np.isfinite(p).all()
    def _get(nm):
        p = landmarks.get(nm); 
        return np.asarray(p,float) if _is_xyz(p) else None
    def _z_local(p):
        v = p - np.asarray(frame['origin'],float)
        ez = np.asarray(frame['ez'],float)
        return float(v.dot(ez))
    def _euclid(a,b):
        return float(np.linalg.norm(np.asarray(a,float)-np.asarray(b,float)))

    if not frame or any(k not in frame for k in ('origin','ex','ey','ez')):
        return {'value_mm': None, 'side_of_max': None, 'right_mm': None, 'left_mm': None,
                'ratios': {'right': None, 'left': None},
                'crown_heights_mm': {'right': None, 'left': None},
                'category': '缺失', 'summary_text': 'Overbite_前牙覆𬌗*: 缺失', 'quality': 'missing',
                'used': {}}

    # 取点（优先 m，切角 ma 作为回退仅在上中切牙；下切牙用 m）
    U11 = _get('11m')
    if U11 is None:
        U11 = _get('11ma')
    U21 = _get('21m')
    if U21 is None:
        U21 = _get('21ma')
    L41 = _get('41m')
    L31 = _get('31m')

    quality = 'ok'
    if (U11 is None or L41 is None) or (U21 is None or L31 is None):
        quality = 'fallback'

    def _side(U, L):
        if U is None or L is None: return None
        return (_z_local(U) - _z_local(L))  # 上减下；通常为正；负则视为开𬌗口径

    right = _side(U11, L41)
    left  = _side(U21, L31)

    # 下中切牙冠高（欧氏距离，m ↔ bgb）
    CH_right = (_euclid(L41, _get('41bgb')) if (L41 is not None and _get('41bgb') is not None) else None)
    CH_left  = (_euclid(L31, _get('31bgb')) if (L31 is not None and _get('31bgb') is not None) else None)

    ratio_right = (right / CH_right) if (right is not None and CH_right and CH_right>1e-6) else None
    ratio_left  = (left  / CH_left ) if (left  is not None and CH_left  and CH_left >1e-6) else None

    # 汇总值：取 |值| 最大侧
    candidates = []
    if right is not None: candidates.append(('right', right))
    if left  is not None: candidates.append(('left',  left))
    if not candidates:
        return {'value_mm': None, 'side_of_max': None, 'right_mm': None, 'left_mm': None,
                'ratios': {'right': None, 'left': None},
                'crown_heights_mm': {'right': None, 'left': None},
                'category': '缺失', 'summary_text': 'Overbite_前牙覆𬌗*: 缺失', 'quality': 'missing',
                'used': {}}

    side_of_max, value = max(candidates, key=lambda kv: abs(kv[1]))
    # 分类
    if value < 0:
        category = '开𬌗'
    elif value >= deep_mm:
        category = '深覆'
    elif normal_low_mm <= value <= normal_high_mm:
        category = '正常'
    else:
        # 介于 0~1 或 4~5 之间的“轻度异常”，可按需归类为“偏小/偏大”
        category = '正常' if (0.8 <= value <= 4.5) else '偏离'

    # 文案（取对应侧的比值）
    ratio_pick = ratio_right if side_of_max=='right' else ratio_left
    ratio_txt = (f"{ratio_pick:.2f}" if isinstance(ratio_pick,(int,float)) else "—")
    summary = f"Overbite_前牙覆𬌗*: {category}（{abs(value):.{dec}f}mm；比 {ratio_txt}）"

    return {
        'value_mm': float(np.round(value, dec)),
        'side_of_max': side_of_max,
        'right_mm': float(np.round(right, dec)) if right is not None else None,
        'left_mm' : float(np.round(left , dec)) if left  is not None else None,
        'ratios': {
            'right': float(np.round(ratio_right, 2)) if ratio_right is not None else None,
            'left' : float(np.round(ratio_left , 2)) if ratio_left  is not None else None,
        },
        'crown_heights_mm': {
            'right': float(np.round(CH_right, dec)) if CH_right is not None else None,
            'left' : float(np.round(CH_left , dec)) if CH_left  is not None else None,
        },
        'category': category,
        'summary_text': summary,
        'quality': quality,
        'used': {
            'upper_right': '11m/11ma', 'lower_right': '41m',
            'upper_left' : '21m/21ma', 'lower_left' : '31m',
            'lower_bgb': ['31bgb','41bgb']
        }
    }

# =======================================================================
# Module #11: Overjet
# =======================================================================
def compute_overjet(
    landmarks: Dict[str, List[float]],
    frame: Dict,
    dec: int = 1,
    zero_tol_mm: float = 0.3,   # |OJ| ≤ 0.3 视为“对刃”
    normal_low_mm: float = 1.0, # 正常 1–4 mm（可调）
    normal_high_mm: float = 4.0,
    deep_mm: float = 5.0        # ≥5 mm 视为“深覆盖”
) -> Dict:
    """
    Module: #11 Overjet
    Input: landmarks, frame
    Output: Dict {'value_mm', 'category', 'summary_text', 'quality', ...}
    Method: Measures the horizontal overlap (X-axis) between the upper incisal edge and the lower incisor labial face. Uses points: 11m, 11ma, 21m, 21ma, 41m, 31m, 41bgb, 31bgb.
    """
    def _is_xyz(p): 
        return isinstance(p,(list,tuple,np.ndarray)) and len(p)==3 and np.isfinite(p).all()
    def _get(nm):
        p = landmarks.get(nm); 
        return np.asarray(p,float) if _is_xyz(p) else None
    def _xz(p):
        v = np.asarray(p,float) - np.asarray(frame['origin'],float)
        ex = np.asarray(frame['ex'],float); ez = np.asarray(frame['ez'],float)
        return float(v.dot(ex)), float(v.dot(ez))

    if not frame or any(k not in frame for k in ('origin','ex','ey','ez')):
        return {'value_mm': None, 'category': '缺失', 'side_of_max': None,
                'right_mm': None, 'left_mm': None, 'per_side': {},
                'summary_text': 'Overjet_前牙覆盖*: 缺失', 'quality': 'missing'}

    # ---- 单侧计算 ----
    def side_oj(U_nm: List[str], Lm_nm: str, Lbgb_nm: str):
        # 上切缘：优先 m，回退 ma
        U = _get(U_nm[0])
        if U is None:
            U = _get(U_nm[1])
        Lm = _get(Lm_nm)
        Lbgb = _get(Lbgb_nm)
        if U is None or Lm is None:
            return None, {'source':'missing', 'clamped': None}

        xU, zU = _xz(U)
        xLm, zLm = _xz(Lm)

        # 有 bgb → 线性插值到同高；否则仅切缘
        if Lbgb is not None:
            xLb, zLb = _xz(Lbgb)
            dz = (zLb - zLm)
            if abs(dz) < 1e-6:
                # 几乎同高，退化为切缘点
                xLlab = xLm
                meta = {'source':'incisal_only', 'clamped': None}
            else:
                t = (zU - zLm) / dz
                clamped = False
                if t < 0.0: t = 0.0; clamped = True
                if t > 1.0: t = 1.0; clamped = True
                xLlab = xLm + t * (xLb - xLm)
                meta = {'source': ('line_interp_clamped' if clamped else 'line_interp'),
                        'clamped': clamped}
        else:
            xLlab = xLm
            meta = {'source':'incisal_only', 'clamped': None}

        oj = xU - xLlab
        return oj, meta

    right, metaR = side_oj(['11m','11ma'], '41m', '41bgb')
    left , metaL = side_oj(['21m','21ma'], '31m', '31bgb')

    quality = 'ok'
    per_side = {'right': metaR, 'left': metaL}
    if (metaR['source'] in ('incisal_only','missing')) or (metaL['source'] in ('incisal_only','missing')):
        quality = 'fallback'

    # 汇总值：取 |值| 最大的一侧
    candidates = []
    if right is not None: candidates.append(('right', right))
    if left  is not None: candidates.append(('left',  left))
    if not candidates:
        return {'value_mm': None, 'category': '缺失', 'side_of_max': None,
                'right_mm': None, 'left_mm': None, 'per_side': per_side,
                'summary_text': 'Overjet_前牙覆盖*: 缺失', 'quality': 'missing'}

    side_of_max, value = max(candidates, key=lambda kv: abs(kv[1]))

    # 分类
    if abs(value) <= zero_tol_mm:
        category = '对刃'
    elif value < -zero_tol_mm:
        category = '反𬌗'
    elif value >= deep_mm:
        category = '深覆盖'
    elif normal_low_mm <= value <= normal_high_mm:
        category = '正常'
    else:
        category = '偏离'

    # 结果
    val_round = float(np.round(value, dec))
    right_round = (float(np.round(right, dec)) if right is not None else None)
    left_round  = (float(np.round(left , dec)) if left  is not None else None)
    summary = f"Overjet_前牙覆盖*: {abs(val_round):.{dec}f}mm_{category}"

    return {
        'value_mm': val_round,
        'category': category,
        'side_of_max': side_of_max,
        'right_mm': right_round,
        'left_mm' : left_round,
        'per_side': per_side,
        'summary_text': summary,
        'quality': quality
    }

# =========================
# API for brief report
# =========================
def _fmt_mm(val, dec=1, tight=True):
    if val is None: return None
    v = round(float(val), dec)
    if abs(v - int(v)) < 1e-9: v = int(v)
    return f"{v}mm" if tight else f"{v} mm"

def report_arch_form(landmarks, frame):
    r = compute_arch_form(landmarks, frame)
    ok = (r.get('form') not in (None, '缺失'))
    return f"Arch_Form_牙弓形态*: {r.get('form','缺失')}{'✅' if ok else '⚠️'}"

def report_arch_width(landmarks, frame):
    r = compute_arch_width(landmarks, frame, dec=1)
    ok = (r.get('quality') != 'missing')
    return f"Arch_Width_牙弓宽度*: {'上牙弓较窄' if r.get('upper_is_narrow') else ('未见上牙弓较窄' if r.get('upper_is_narrow') is not None else '缺失')} {'✅' if ok else '⚠️'}"

def report_bolton(landmarks, frame):
    r = compute_bolton(landmarks, frame, cfg={'mode':'plane'})
    # 外显只要“正常 / 非正常”总结：两项都“正常”才算正常
    both_ok = (r['anterior'].get('status') == '正常' and r['overall'].get('status') == '正常')
    ok = (r.get('quality') != 'missing')
    return f"Bolton_Ratio_Bolton比*: {'正常' if both_ok else r.get('summary_text','异常')} {'✅' if ok else '⚠️'}"

def report_canine(landmarks, frame):
    r = compute_canine_relationship(landmarks, frame)
    ok = (r.get('quality') != 'missing')
    # 示例文案：右侧远中尖对尖，左侧完全远中
    return f"Canine_Relationship_尖牙关系*: {r['summary_text'].split('*:')[-1].strip()} {'✅' if ok else '⚠️'}"

def report_crossbite(landmarks, frame):
    r = compute_crossbite(landmarks, frame, threshold_mm=1.5, min_pairs=2)
    ok = (r.get('quality') != 'missing')
    return f"{r['summary_text']} {'✅' if ok else '⚠️'}"

def report_crowding(landmarks, frame):
    r = compute_crowding(landmarks, frame, arch='both', use_plane=True, dec=1)
    ok = (r.get('quality') != 'missing')
    # 统一去掉 + 号与多余空格，贴近示例
    up = r['upper']; lw = r['lower']
    def _one(x, arch_name):
        if not x or x.get('ald_mm') is None: return None
        val = abs(x['ald_mm'])
        tag = "间隙" if x['ald_mm'] >= 0 else "拥挤"
        return f"{arch_name}{tag}{_fmt_mm(val, dec=1, tight=True)}"
    parts = [p for p in [_one(up, '上牙列'), _one(lw, '下牙列')] if p]
    text = ''.join(parts) if parts else '缺失'
    return f"Crowding_拥挤度*:{text} {'✅' if ok else '⚠️'}"

def report_spee(landmarks, frame):
    val = compute_spee(landmarks, frame, dec=1)
    ok = (val is not None)
    return f"Curve_of_Spee_Spee曲线*: {_fmt_mm(val, dec=1, tight=True) if ok else '缺失'}{'✅' if ok else '⚠️'}"

def report_midline_alignment(landmarks, frame):
    r = compute_midline_alignment(landmarks, frame, threshold_mm=1.0, dec=1)
    ok = (r.get('quality') != 'missing')
    def _one(side):
        s = r[side]['signed_y_mm']
        # 右偏=负，左偏=正
        dir_txt = '右偏' if s is not None and s < 0 else ('左偏' if s is not None and s > 0 else '居中')
        mag = _fmt_mm(abs(s), dec=0, tight=True) if s is not None else None
        return f"{'上' if side=='upper' else '下'}中线{dir_txt}{mag if mag else ''}"
    text = f"{_one('upper')} {_one('lower')}" if ok else '缺失'
    return f"Midline_Alignment_牙列中线*:{text} {'✅' if ok else '⚠️'}"

def report_molar_relationship(landmarks, frame):
    r = compute_molar_relationship(landmarks, frame, dec=1)
    ok = (r.get('quality') != 'missing')
    def _word(s):
        if not s or s['is_complete_distal'] is None: return '缺失'
        return '完全远中' if s['is_complete_distal'] else '非完全远中'
    text = f"右侧{_word(r.get('right'))} 左侧{_word(r.get('left'))}"
    return f"Molar_Relationship_磨牙关系*: {text} {'✅' if ok else '⚠️'}"

def report_overbite(landmarks, frame):
    r = compute_overbite(landmarks, frame, dec=1)
    ok = (r.get('quality') != 'missing')
    # 外显只保留类型
    return f"Overbite_前牙覆𬌗*: {r.get('category','缺失')} {'✅' if ok else '⚠️'}"

def report_overjet(landmarks, frame):
    r = compute_overjet(landmarks, frame, dec=1)
    ok = (r.get('quality') != 'missing')
    # r['summary_text'] 形如 "Overjet_前牙覆盖*: 12.0mm_深覆盖"
    tail = r['summary_text'].split('*:')[-1].strip() if ok else '缺失'
    # 去掉 12.0 → 12
    import re
    tail = re.sub(r'(\d+)\.0(mm)', r'\1\2', tail)
    return f"Overjet_前牙覆盖*: {tail} {'✅' if ok else '⚠️'}"

def make_brief_report(landmarks, frame):
    return [
        report_arch_form(landmarks, frame),
        report_arch_width(landmarks, frame),
        report_bolton(landmarks, frame),
        report_canine(landmarks, frame),
        report_crossbite(landmarks, frame),
        report_crowding(landmarks, frame),
        report_spee(landmarks, frame),
        report_midline_alignment(landmarks, frame),
        report_molar_relationship(landmarks, frame),
        report_overbite(landmarks, frame),
        report_overjet(landmarks, frame),
    ]

# ================================
# I/O helpers (STL + Landmarks)
# ================================
import json, os, numpy as np
from typing import Dict, List, Optional

def _load_landmarks_json(path: str) -> Dict[str, List[float]]:
    """读取 Slicer Markups JSON，提取 {label: position} 字典。"""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    out = {}
    # 健壮性检查：确保路径存在且结构符合预期
    if not data or 'markups' not in data or not data['markups']:
        return out
    
    # 通常只有一个 markup list，但可以遍历以防万一
    for markup in data['markups']:
        if 'controlPoints' not in markup:
            continue
        for cp in markup['controlPoints']:
            label = cp.get('label')
            pos = cp.get('position')
            if label and isinstance(pos, list) and len(pos) == 3:
                try:
                    out[str(label)] = [float(pos[0]), float(pos[1]), float(pos[2])]
                except (ValueError, TypeError):
                    pass  # 忽略无法转换的坐标
    return out

def _merge_landmarks(*dicts: Dict[str, List[float]]) -> Dict[str, List[float]]:
    """简单合并（后者覆盖前者）。上下颌 FDI 编码本身不冲突，一般不会覆盖。"""
    out = {}
    for d in dicts:
        out.update(d or {})
    return out

def _load_stl_points(path: str) -> Optional[np.ndarray]:
    """尽量读取 STL 顶点点云。优先 trimesh；回退 numpy-stl；都不可用则返回 None。"""
    if not path or not os.path.exists(path):
        return None
    try:
        import trimesh  # type: ignore
        m = trimesh.load(path, force='mesh')
        if hasattr(m, 'vertices'):
            P = np.asarray(m.vertices, dtype=float)
            return P[np.isfinite(P).all(axis=1)]
    except Exception:
        pass
    try:
        from stl import mesh  # type: ignore
        m = mesh.Mesh.from_file(path)
        P = m.vectors.reshape(-1, 3)
        return P[np.isfinite(P).all(axis=1)]
    except Exception:
        return None

def _combine_and_sample_points(upper_stl: Optional[str], lower_stl: Optional[str],
                               max_points: int = 8000) -> Optional[List[np.ndarray]]:
    """合并上下 STL 点并下采样为列表（给 build_occlusal_frame 的 geom_points）。"""
    Pu = _load_stl_points(upper_stl) if upper_stl else None
    Pl = _load_stl_points(lower_stl) if lower_stl else None
    if Pu is None and Pl is None:
        return None
    P = Pu if Pl is None else (Pl if Pu is None else np.vstack([Pu, Pl]))
    if len(P) > max_points:
        idx = np.random.choice(len(P), size=max_points, replace=False)
        P = P[idx]
    return [P[i] for i in range(len(P))]

# ==========================================
# Public API: analyze_case_brief (核心接口)
# ==========================================
# ==========================================
# 把 brief 列表转换为 {键: 值} 的字典
# 例如 "Arch_Form_牙弓形态*: 尖圆形✅"
#  -> 键: "Arch_Form_牙弓形态*", 值: "尖圆形✅"
# 例如 "Crossbite_锁牙合: 无 ✅"
#  -> 键: "Crossbite_锁牙合", 值: "无 ✅"
# ==========================================
def _brief_lines_to_kv(brief_lines):
    kv = {}
    for line in (brief_lines or []):
        line = (line or "").strip()
        if not line:
            continue
        if "*:" in line:
            k, v = line.split("*:", 1)
            key = (k.strip() + "*")
            val = v.strip()
        elif ":" in line:
            k, v = line.split(":", 1)
            key = k.strip()
            val = v.strip()
        else:
            # 没有冒号的非常规行，整行作为值
            key = line
            val = ""
        kv[key] = val
    return kv



# ==========================
# 可选：命令行入口（直接落盘）
# ==========================
if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Ortho analysis → brief key-value JSON")
    ap.add_argument("--upper_stl", required=True)
    ap.add_argument("--lower_stl", required=True)
    ap.add_argument("--upper_json", required=True)
    ap.add_argument("--lower_json", required=True)
    ap.add_argument("--out", required=True, help="输出 JSON 路径")
    args = ap.parse_args()

    kv = generate_metrics(args.upper_stl, args.lower_stl, args.upper_json, args.lower_json, out_path=args.out)
    print(f"saved to: {args.out} ({len(kv)} items)")


