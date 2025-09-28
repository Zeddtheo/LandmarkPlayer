import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

// ---- 全局对象（小而清晰） ----
let scene, camera, renderer, controls;
let stlMesh = null;                 // 当前牙弓网格
let landmarkMeshes = [];            // THREE.Mesh 小球集合
let landmarkLabels = [];             // 标签 Sprite 集合
let landmarks = [];                 // 内存中的点（model 坐标）
const state = { units: 'mm', coord_space: 'model', pointSizeMultiplier: 1, labelSizeMultiplier: 1, pointColor: '#1e90ff' }; // 约定

const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const dragState = { mesh: null, label: null, landmark: null };

// ---- 启动：创建三维场景 ----
init();
bindUI();
autoLoadDefaultFiles();

function init() {
  console.log('初始化3D场景...');
  const el = document.getElementById('viewer');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222222);

  const w = el.clientWidth || window.innerWidth;
  const h = el.clientHeight || window.innerHeight;

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
  camera.position.set(0, 50, 100);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  el.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // 灯光
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(100, 200, 100);
  dir.castShadow = true;
  scene.add(dir);

  // 坐标轴（可删）
  const axes = new THREE.AxesHelper(50);
  scene.add(axes);
  console.log('坐标轴已添加到场景');

  setupInteractionHandlers();
  window.addEventListener('resize', onResize);
  animate();
  console.log('3D场景初始化完成');
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function onResize() {
  const el = document.getElementById('viewer');
  camera.aspect = (el.clientWidth || window.innerWidth) / (el.clientHeight || window.innerHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(el.clientWidth || window.innerWidth, el.clientHeight || window.innerHeight);
}

// ---- UI 事件 ----
function bindUI() {
  const pointSizeRange = document.getElementById('point-size');
  const pointSizeValue = document.getElementById('point-size-value');
  const labelSizeRange = document.getElementById('label-size');
  const labelSizeValue = document.getElementById('label-size-value');
  const colorInput = document.getElementById('point-color');
  const clearStlButton = document.getElementById('clear-stl');
  const clearJsonButton = document.getElementById('clear-json');

  if (pointSizeRange && pointSizeValue) {
    const updatePointSize = (value) => {
      const numeric = Number(value) || 1;
      state.pointSizeMultiplier = numeric;
      pointSizeValue.textContent = numeric.toFixed(1);
      if (landmarks.length && stlMesh) renderLandmarkSpheres();
    };
    pointSizeRange.value = String(state.pointSizeMultiplier);
    updatePointSize(pointSizeRange.value || 1);
    pointSizeRange.addEventListener('input', (e) => updatePointSize(e.target.value));
  }

  if (labelSizeRange && labelSizeValue) {
    const updateLabelSize = (value) => {
      const numeric = Number(value) || 1;
      state.labelSizeMultiplier = numeric;
      labelSizeValue.textContent = numeric.toFixed(1);
      if (landmarks.length && stlMesh) renderLandmarkSpheres();
    };
    labelSizeRange.value = String(state.labelSizeMultiplier);
    updateLabelSize(labelSizeRange.value || 1);
    labelSizeRange.addEventListener('input', (e) => updateLabelSize(e.target.value));
  }

  if (colorInput) {
    colorInput.value = state.pointColor;
    const applyColor = (value) => {
      if (!value) return;
      state.pointColor = value;
      if (landmarks.length && stlMesh) renderLandmarkSpheres();
    };
    colorInput.addEventListener('input', (e) => applyColor(e.target.value));
  }

  if (clearStlButton) {
    clearStlButton.addEventListener('click', () => {
      clearMeshAndLandmarks();
      console.log('STL网格已清除');
    });
  }

  if (clearJsonButton) {
    clearJsonButton.addEventListener('click', () => {
      resetDragState();
      landmarks.length = 0;
      clearLandmarkMeshes();
      clearLandmarkLabels();
      console.log('标记数据已清除');
    });
  }

  document.getElementById('open-stl').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    await loadSTLFromArrayBuffer(buf);
  });

  document.getElementById('open-json').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const json = JSON.parse(text);
    loadLandmarksJSON(json);
  });

  document.getElementById('save-json').addEventListener('click', () => {
    const json = exportLandmarksJSON();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'landmarks.edited.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}
// ---- 加载 STL ----
async function loadSTLFromArrayBuffer(arrayBuffer) {
  console.log('开始加载STL文件...');
  clearMeshAndLandmarks(); // 切换模型时清理
  
  try {
    const loader = new STLLoader();
    const geom = loader.parse(arrayBuffer);
    console.log('STL几何体解析完成，顶点数:', geom.attributes.position.count);
    
    // 检查几何体边界框
    geom.computeBoundingBox();
    console.log('STL边界框:', geom.boundingBox);

    // 重要：不要 center()/scale()，保持与 JSON 对齐
    // 可选：如果法向缺失，补法向
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x9aa6b2, metalness: 0.1, roughness: 0.7
    });

    stlMesh = new THREE.Mesh(geom, mat);
    stlMesh.castShadow = true;
    stlMesh.receiveShadow = true;
    scene.add(stlMesh);
    stlMesh.updateMatrixWorld(true);

    console.log('STL网格已添加到场景');
    console.log('STL网格位置:', stlMesh.position);
    console.log('STL网格缩放:', stlMesh.scale);
    console.log('场景中的对象数量:', scene.children.length);

    // 自动取一个合适的相机距离
    fitCameraToObject(stlMesh);

    // 如果已经有 landmarks（先加载了 JSON），此刻把小球渲染出来
    if (landmarks.length) {
      console.log('渲染已有的landmarks:', landmarks.length);
      renderLandmarkSpheres();
    }
  } catch (error) {
    console.error('STL加载失败:', error);
  }
}

// 相机框选到模型
function fitCameraToObject(obj) {
  console.log('调整相机位置以适应模型');
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  
  console.log('模型边界框大小:', size);
  console.log('模型中心:', center);
  
  controls.target.copy(center);
  camera.position.copy(center.clone().add(new THREE.Vector3(size * 0.5, size * 0.5, size * 1.2)));
  camera.near = size / 1000;
  camera.far = size * 10;
  camera.updateProjectionMatrix();
  controls.update();
  
  console.log('相机位置已调整');
}

// ---- 加载 landmarks JSON 并显示 ----
function loadLandmarksJSON(json) {
  console.log('Loading JSON:', json);
  
  // 支持两种格式：简单格式 和 Slicer格式
  let landmarkData = [];
  
  if (json.landmarks && Array.isArray(json.landmarks)) {
    // 简单格式 { landmarks: [...] }
    landmarkData = json.landmarks;
    state.coord_space = json.coord_space || 'model';
    state.units = json.units || 'mm';
  } else if (json.markups && Array.isArray(json.markups) && json.markups.length > 0) {
    // Slicer格式 { markups: [{ controlPoints: [...] }] }
    const markup = json.markups[0];
    if (markup.controlPoints && Array.isArray(markup.controlPoints)) {
      landmarkData = markup.controlPoints.map(cp => ({
        id: cp.id,
        name: cp.label || cp.id,
        position: cp.position
      }));
      state.coord_space = markup.coordinateSystem === 'LPS' ? 'model' : 'model';
      state.units = markup.coordinateUnits || 'mm';
    }
  } else {
    console.warn('无效 landmarks json格式');
    return;
  }

  // 仅支持 coord_space=model（MVP 约定）
  if (state.coord_space !== 'model') {
    console.warn('当前仅支持 coord_space = "model" 的 JSON');
  }

  // 存到内存（model 坐标）
  landmarks = landmarkData
    .filter(it => Array.isArray(it.position) && it.position.length === 3)
    .map(it => ({
      id: it.id || it.name || cryptoRandomId(),
      name: it.name || it.id || 'lm',
      position_model: new THREE.Vector3(it.position[0], it.position[1], it.position[2])
    }));

  console.log(`Loaded ${landmarks.length} landmarks`);

  // 如果已经有 mesh，立即渲染小球
  if (stlMesh) renderLandmarkSpheres();
}

// 把 landmarks 渲染为小球
function renderLandmarkSpheres() {
  resetDragState();
  console.log('渲染landmark小球，数量:', landmarks.length);
  clearLandmarkMeshes();
  clearLandmarkLabels();

  if (!stlMesh) {
    console.warn('没有STL网格，无法渲染landmarks');
    return;
  }

  const box = new THREE.Box3().setFromObject(stlMesh);
  const size = box.getSize(new THREE.Vector3());
  const baseRadius = size.length() * 0.01 || 2.0;
  const labelBase = Math.max(baseRadius, 0.1);
  const pointScale = state.pointSizeMultiplier || 1;
  const labelScale = Math.max(state.labelSizeMultiplier || 1, 0.2);
  const sphereRadius = Math.max(labelBase * pointScale, 0.1);
  const color = state.pointColor || '#1e90ff';
  console.log('Landmark球体半径(基准/球):', baseRadius, sphereRadius);

  for (const lm of landmarks) {
    const pWorld = modelToWorld(lm.position_model);
    const geo = new THREE.SphereGeometry(sphereRadius, 16, 12);
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.1,
      roughness: 0.4
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(pWorld);
    sphere.userData.landmarkId = lm.id;
    sphere.userData.radius = sphereRadius;
    sphere.castShadow = true;
    landmarkMeshes.push(sphere);
    scene.add(sphere);

    const label = createLabelSprite(lm.name || lm.id, labelBase, labelScale);
    label.position.copy(pWorld);
    label.position.y += sphereRadius + labelBase * labelScale;
    label.userData.landmarkId = lm.id;
    label.userData.radius = sphereRadius;
    label.userData.labelScale = labelScale;
    label.userData.baseRadius = labelBase;
    landmarkLabels.push(label);
    scene.add(label);
  }

  console.log('成功渲染', landmarkMeshes.length, '个landmark球体');
}
// ---- 导出 JSON（与输入 schema 对齐）----
function exportLandmarksJSON() {
  // 以内存的 model 坐标为准导出
  return {
    coord_space: 'model',
    units: state.units || 'mm',
    landmarks: landmarks.map(lm => ({
      id: lm.id,
      name: lm.name,
      position: [lm.position_model.x, lm.position_model.y, lm.position_model.z]
    }))
  };
}

// ---- 工具函数 ----
function modelToWorld(v3_model) {
  if (!stlMesh) return v3_model.clone();
  const m = stlMesh.matrixWorld;
  return v3_model.clone().applyMatrix4(m);
}

function worldToModel(v3_world) {
  if (!stlMesh) return v3_world.clone();
  const inv = new THREE.Matrix4().copy(stlMesh.matrixWorld).invert();
  return v3_world.clone().applyMatrix4(inv);
}

function clearMeshAndLandmarks() {
  resetDragState();
  if (stlMesh) { scene.remove(stlMesh); stlMesh.geometry.dispose(); stlMesh.material.dispose(); stlMesh = null; }
  clearLandmarkMeshes();
  clearLandmarkLabels();
}

function clearLandmarkMeshes() {
  for (const m of landmarkMeshes) {
    scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  }
  landmarkMeshes.length = 0;
}

function clearLandmarkLabels() {
  for (const label of landmarkLabels) {
    scene.remove(label);
    if (label.material.map) label.material.map.dispose();
    label.material.dispose();
  }
  landmarkLabels.length = 0;
}

function createLabelSprite(text, baseRadius, labelScale = 1) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const fontSize = 64;
  const padding = 24;

  context.font = `${fontSize}px "Segoe UI", sans-serif`;
  const metrics = context.measureText(text);
  canvas.width = Math.ceil(metrics.width + padding * 2);
  canvas.height = Math.ceil(fontSize + padding * 2);

  context.font = `${fontSize}px "Segoe UI", sans-serif`;
  context.fillStyle = 'rgba(15, 23, 42, 0.85)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  const scaleMultiplier = Math.max(labelScale, 0.2);
  const reference = Math.max(baseRadius, 0.1);
  const scale = reference * 3.5 * scaleMultiplier;
  const aspect = canvas.height / canvas.width;
  sprite.scale.set(scale, scale * aspect, 1);
  return sprite;
}
function setupInteractionHandlers() {
  if (!renderer || !renderer.domElement) return;
  if (setupInteractionHandlers._initialized) return;
  setupInteractionHandlers._initialized = true;

  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('dblclick', handleDoubleClick);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('pointerup', handlePointerUp);
}

function handlePointerDown(event) {
  if (event.button !== 0) return;
  if (event.detail > 1) return;
  if (!renderer || !stlMesh || !landmarkMeshes.length) return;

  updatePointerFromEvent(event);
  const hit = pickLandmarkMesh();
  if (!hit) return;

  const landmarkId = hit.object.userData.landmarkId;
  dragState.mesh = hit.object;
  dragState.label = findLabelById(landmarkId);
  dragState.landmark = findLandmarkById(landmarkId);

  controls.enabled = false;
  renderer.domElement.style.cursor = 'grabbing';
  event.target.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function handlePointerMove(event) {
  if (!dragState.mesh || !stlMesh) return;

  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  const intersection = raycaster.intersectObject(stlMesh, true)[0];
  if (!intersection) return;

  dragState.mesh.position.copy(intersection.point);
  dragState.mesh.updateMatrixWorld();

  const sphereRadius = dragState.mesh.userData.radius || 1;
  const labelScale = dragState.label?.userData?.labelScale || 1;
  const labelBase = dragState.label?.userData?.baseRadius || Math.max(sphereRadius, 0.1);
  if (dragState.label) {
    dragState.label.position.copy(intersection.point);
    dragState.label.position.y += sphereRadius + labelBase * labelScale;
  }

  if (dragState.landmark && dragState.landmark.position_model) {
    dragState.landmark.position_model.copy(worldToModel(intersection.point));
  }

  event.preventDefault();
}

function handlePointerUp(event) {
  if (!dragState.mesh) return;
  renderer?.domElement?.releasePointerCapture?.(event.pointerId);
  resetDragState();
  event.preventDefault();
}

function handleDoubleClick(event) {
  if (!renderer) return;

  updatePointerFromEvent(event);
  const hit = pickLandmarkMesh();
  if (!hit) return;

  const target = findLandmarkById(hit.object.userData.landmarkId);
  if (!target) return;

  event.preventDefault();
  const nextName = window.prompt('输入新的点名称', target.name || target.id);
  if (nextName == null) return;

  const trimmed = nextName.trim();
  if (!trimmed || trimmed === target.name) return;

  target.name = trimmed;
  renderLandmarkSpheres();
}

function updatePointerFromEvent(event) {
  if (!renderer || !renderer.domElement) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickLandmarkMesh() {
  if (!landmarkMeshes.length) return null;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(landmarkMeshes, false);
  return hits.length ? hits[0] : null;
}

function findLabelById(id) {
  return landmarkLabels.find(label => label.userData.landmarkId === id) || null;
}

function findLandmarkById(id) {
  return landmarks.find(lm => lm.id === id) || null;
}

function resetDragState() {
  if (!dragState.mesh && !dragState.label && !dragState.landmark) return;
  dragState.mesh = null;
  dragState.label = null;
  dragState.landmark = null;
  if (controls) controls.enabled = true;
  if (renderer && renderer.domElement) renderer.domElement.style.cursor = 'default';
}

function cryptoRandomId() {
  return (crypto?.randomUUID?.() || ('lm_' + Math.random().toString(36).slice(2, 10)));
}

async function loadDemoCase(caseId = '1_L') {
  try {
    console.log(`开始加载演示案例: ${caseId}`);
    const stlUrl = `assets/${caseId}.stl`;
    const jsonUrl = `assets/${caseId}.json`;

    const stlResponse = await fetch(stlUrl);
    if (!stlResponse.ok) {
      throw new Error(`无法获取演示 STL: ${stlUrl} (${stlResponse.status})`);
    }
    const stlBuffer = await stlResponse.arrayBuffer();
    await loadSTLFromArrayBuffer(stlBuffer);
    console.log(`STL(${caseId}) 加载完成`);

    const jsonResponse = await fetch(jsonUrl);
    if (!jsonResponse.ok) {
      console.warn(`未找到演示 JSON: ${jsonUrl}`);
      return { stlLoaded: true, jsonLoaded: false };
    }
    const jsonText = await jsonResponse.text();
    const json = JSON.parse(jsonText);
    loadLandmarksJSON(json);
    console.log(`JSON(${caseId}) 加载完成`);

    return { stlLoaded: true, jsonLoaded: true };
  } catch (error) {
    console.error(`演示数据加载失败 (${caseId}):`, error);
    throw error;
  }
}
// ---- 自动加载默认文件 ----
async function autoLoadDefaultFiles() {\r\n  try {\r\n    console.log('尝试自动加载默认文件...');\r\n    await loadDemoCase('1_L');
  } catch (error) {
    console.error('自动加载文件失败:', error);
    console.log('请手动使用文件选择器加载STL和JSON文件');
  }
}

if (typeof window !== 'undefined') {
  window.LandmarkDemo = window.LandmarkDemo || {};
  window.LandmarkDemo.loadCase = loadDemoCase;
}

