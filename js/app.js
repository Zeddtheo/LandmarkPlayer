import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
// 导入将在运行时动态进行，避免静态导入错误

// ---- 全局对象（小而清晰） ----
let scene, camera, renderer, controls;
let mainGroup = null;               // 主显示组（包含所有可视化对象）
let stlMesh = null;                 // 当前牙弓网格
let landmarkMeshes = [];            // THREE.Mesh 小球集合
let landmarkLabels = [];             // 标签 Sprite 集合
let landmarks = [];                 // 内存中的点（model 坐标）
let coordFrame = null;              // 当前构建的坐标系
let coordAxisHelper = null;         // 坐标轴显示对象
const state = { 
  units: 'mm', 
  coord_space: 'model', 
  pointSizeMultiplier: 1, 
  labelSizeMultiplier: 1, 
  pointColor: '#1e90ff',
  showCoordAxis: false 
}; // 约定

const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const dragState = { mesh: null, label: null, landmark: null };

// ---- 启动：创建三维场景 ----
init();
bindUI();

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

  // 创建主显示组
  mainGroup = new THREE.Group();
  scene.add(mainGroup);
  console.log('主显示组已创建');

  // 坐标轴（可删）
  const axes = new THREE.AxesHelper(50);
  scene.add(axes);
  console.log('坐标轴已添加到场景');

  setupInteractionHandlers();
  window.addEventListener('resize', onResize);
  animate();
  console.log('3D场景初始化完成');
  
  // 在场景初始化完成后再加载默认文件
  setTimeout(() => {
    autoLoadDefaultFiles();
  }, 500);
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
  
  // 坐标轴显示按钮
  const showCoordAxisBtn = document.getElementById('show-coord-axis-btn');
  if (showCoordAxisBtn) {
    showCoordAxisBtn.addEventListener('click', () => {
      toggleCoordAxisDisplay();
    });
  }
  
  // 坐标系测试面板事件 (暂时禁用，使用新的分析系统)
  // bindCoordTestPanel();
  
  // 新的界面按钮事件
  bindNewInterfaceEvents();
}

// 新界面事件绑定
function bindNewInterfaceEvents() {
  const metricsType = document.getElementById('metrics-type');
  const executeMetrics = document.getElementById('execute-metrics');
  
  // 指标计算执行
  executeMetrics?.addEventListener('click', () => {
    const selectedType = metricsType?.value;
    
    switch(selectedType) {
      case 'module-1':
        executeModule1();
        break;
        
      case 'module-2':
        executeModule2();
        break;
        
      case 'module-3':
        executeModule3();
        break;
        
      case 'module-4':
        executeModule4();
        break;
        
      case 'module-5':
        executeModule5();
        break;
        
      case 'module-6':
        executeModule6();
        break;
        
      case 'module-7':
        executeModule7();
        break;
        
      case 'module-8':
        executeModule8();
        break;
        
      case 'module-9':
        executeModule9();
        break;
        
      case 'module-10':
        executeModule10();
        break;
        
      case 'module-11':
        executeModule11();
        break;
        
      default:
        alert('请先选择一个指标计算类型');
    }
  });
  

  // 右上角清除按钮
  const clearAnalysisBtn = document.getElementById('clear-analysis');
  clearAnalysisBtn?.addEventListener('click', () => clearAllAnalysis());

  // 手动居中按钮
  const centerViewBtn = document.getElementById('center-view-btn');
  centerViewBtn?.addEventListener('click', () => {
    centerMainGroup();
  });

  // 重置视图按钮
  const resetViewBtn = document.getElementById('reset-view-btn');
  resetViewBtn?.addEventListener('click', () => {
    resetView();
  });
}

// 旧的测试面板功能已被新的分析系统替代
/*
function bindCoordTestPanel() {
  // ... 旧代码已注释掉 ...
}
*/

function setTestingState(isTesting) {
  const buttons = document.querySelectorAll('#coord-test-panel button');
  buttons.forEach(btn => {
    if (btn.classList.contains('panel-close')) return;
    btn.disabled = isTesting;
    if (isTesting) {
      btn.style.opacity = '0.6';
    } else {
      btn.style.opacity = '';
    }
  });
  
  if (isTesting) {
    const resultsDiv = document.getElementById('test-results');
    if (resultsDiv) {
      resultsDiv.innerHTML = '<p style="color:#fcd34d;text-align:center;margin:20px 0;">🧪 测试进行中...</p>';
    }
  }
}

function clearTestResults() {
  const resultsDiv = document.getElementById('test-results');
  const summaryDiv = document.getElementById('test-summary');
  
  if (resultsDiv) {
    resultsDiv.innerHTML = '<p style="color:#94a3b8;text-align:center;margin:20px 0;">点击上方按钮开始测试</p>';
  }
  
  if (summaryDiv) {
    summaryDiv.style.display = 'none';
  }
}

function displayBatchTestResults(results) {
  const resultsDiv = document.getElementById('test-results');
  const summaryDiv = document.getElementById('test-summary');
  
  if (!resultsDiv || !results || !results.length) return;

  // 更新统计摘要
  const successful = results.filter(r => r.success);
  const valid = successful.filter(r => r.validation && r.validation.valid);
  const totalLandmarks = successful.reduce((sum, r) => sum + r.landmarks, 0);
  const totalFdiCoverage = successful.reduce((sum, r) => sum + (r.keyPoints?.fdiCoverage || 0), 0);

  if (summaryDiv) {
    summaryDiv.style.display = 'block';
    
    document.getElementById('total-count').textContent = results.length;
    document.getElementById('success-count').textContent = successful.length;
    document.getElementById('valid-count').textContent = valid.length;
    document.getElementById('avg-landmarks').textContent = successful.length > 0 ? 
      (totalLandmarks / successful.length).toFixed(1) : '0';
    document.getElementById('avg-fdi').textContent = successful.length > 0 ? 
      ((totalFdiCoverage / successful.length) * 100).toFixed(1) + '%' : '0%';
      
    // 更新统计颜色
    const successElement = document.getElementById('success-count');
    const validElement = document.getElementById('valid-count');
    
    if (successful.length === results.length) {
      successElement.className = 'stat-value stat-good';
    } else if (successful.length > 0) {
      successElement.className = 'stat-value stat-warn';
    } else {
      successElement.className = 'stat-value stat-bad';
    }
    
    if (valid.length === successful.length) {
      validElement.className = 'stat-value stat-good';
    } else if (valid.length > 0) {
      validElement.className = 'stat-value stat-warn';
    } else {
      validElement.className = 'stat-value stat-bad';
    }
  }

  // 显示详细结果
  const html = results.map(result => {
    if (!result.success) {
      return `
        <div class="test-result error">
          <div class="result-header">
            ❌ ${result.case.name}
          </div>
          <div class="result-details">
            <div style="color:#fca5a5;">错误: ${result.error}</div>
          </div>
        </div>
      `;
    }

    const { validation, quality, keyPoints } = result;
    const statusIcon = quality.status === 'ok' ? '🟢' : quality.status === 'fallback' ? '🟡' : '🔴';
    const validIcon = validation.valid ? '✅' : '❌';
    
    return `
      <div class="test-result success">
        <div class="result-header">
          ${validIcon} ${result.case.name} ${statusIcon}
        </div>
        <div class="result-details">
          <div class="metric">
            <span>标记点数量:</span>
            <span class="metric-good">${result.landmarks}</span>
          </div>
          <div class="metric">
            <span>坐标系有效性:</span>
            <span class="${validation.valid ? 'metric-good' : 'metric-bad'}">${validation.valid ? '有效' : '无效'}</span>
          </div>
          <div class="metric">
            <span>正交性:</span>
            <span class="${validation.orthogonal ? 'metric-good' : 'metric-bad'}">${validation.orthogonal ? '✓' : '✗'}</span>
          </div>
          <div class="metric">
            <span>单位向量:</span>
            <span class="${validation.unit ? 'metric-good' : 'metric-bad'}">${validation.unit ? '✓' : '✗'}</span>
          </div>
          <div class="metric">
            <span>右手坐标系:</span>
            <span class="${validation.rightHanded ? 'metric-good' : 'metric-bad'}">${validation.rightHanded ? '✓' : '✗'}</span>
          </div>
          <div class="metric">
            <span>FDI覆盖率:</span>
            <span class="metric-good">${(keyPoints.fdiCoverage * 100).toFixed(1)}%</span>
          </div>
          ${quality.warnings && quality.warnings.length > 0 ? 
            `<div style="color:#fcd34d;margin-top:6px;">⚠️ ${quality.warnings.join(', ')}</div>` : ''
          }
          <div class="frame-vectors">
            ${framePretty(result.frame)}
          </div>
        </div>
      </div>
    `;
  }).join('');

  resultsDiv.innerHTML = html;
}

function displaySingleTestResult(result) {
  const resultsDiv = document.getElementById('test-results');
  if (!resultsDiv) return;

  if (!result.success) {
    resultsDiv.innerHTML = `
      <div class="test-result error">
        <div class="result-header">
          ❌ 测试失败 (${result.caseId})
        </div>
        <div class="result-details">
          <div style="color:#fca5a5;">错误: ${result.error}</div>
        </div>
      </div>
    `;
    return;
  }

  const { validation, quality, keyPoints } = result;
  const statusIcon = quality.status === 'ok' ? '🟢' : quality.status === 'fallback' ? '🟡' : '🔴';
  const validIcon = validation.valid ? '✅' : '❌';

  resultsDiv.innerHTML = `
    <div class="test-result success">
      <div class="result-header">
        ${validIcon} 单个病例测试结果 (${result.caseId}) ${statusIcon}
      </div>
      <div class="result-details">
        <div class="metric">
          <span>标记点数量:</span>
          <span class="metric-good">${result.landmarks}</span>
        </div>
        <div class="metric">
          <span>坐标系有效性:</span>
          <span class="${validation.valid ? 'metric-good' : 'metric-bad'}">${validation.valid ? '有效' : '无效'}</span>
        </div>
        <div class="metric">
          <span>质量状态:</span>
          <span class="${quality.status === 'ok' ? 'metric-good' : quality.status === 'fallback' ? 'metric-warn' : 'metric-bad'}">
            ${quality.status === 'ok' ? '优秀' : quality.status === 'fallback' ? '可用' : '问题'}
          </span>
        </div>
        <div class="metric">
          <span>正交性:</span>
          <span class="${validation.orthogonal ? 'metric-good' : 'metric-bad'}">${validation.orthogonal ? '✓' : '✗'}</span>
        </div>
        <div class="metric">
          <span>单位向量:</span>
          <span class="${validation.unit ? 'metric-good' : 'metric-bad'}">${validation.unit ? '✓' : '✗'}</span>
        </div>
        <div class="metric">
          <span>右手坐标系:</span>
          <span class="${validation.rightHanded ? 'metric-good' : 'metric-bad'}">${validation.rightHanded ? '✓' : '✗'}</span>
        </div>
        <div class="metric">
          <span>FDI覆盖率:</span>
          <span class="metric-good">${(keyPoints.fdiCoverage * 100).toFixed(1)}%</span>
        </div>
        <div class="metric">
          <span>样本点数:</span>
          <span class="metric-good">${keyPoints.samplePoints}</span>
        </div>
        <div class="metric">
          <span>切牙中点:</span>
          <span class="${keyPoints.hasIncisors ? 'metric-good' : 'metric-bad'}">${keyPoints.hasIncisors ? '✓' : '✗'}</span>
        </div>
        <div class="metric">
          <span>犬牙方向:</span>
          <span class="${keyPoints.hasCanines ? 'metric-good' : 'metric-bad'}">${keyPoints.hasCanines ? '✓' : '✗'}</span>
        </div>
        ${quality.warnings && quality.warnings.length > 0 ? 
          `<div style="color:#fcd34d;margin-top:6px;">⚠️ ${quality.warnings.join(', ')}</div>` : ''
        }
        <div class="frame-vectors">
          ${result.framePretty}
        </div>
      </div>
    </div>
  `;
}

async function testCurrentLandmarks() {
  if (!landmarks || landmarks.length === 0) {
    alert('当前没有加载标记点数据');
    return;
  }

  try {
    console.log('🧪 测试当前标记点数据...');
    
    // 转换为calc.js期望的格式
    const landmarkData = landmarks.map(lm => ({
      id: lm.id,
      name: lm.name,
      position_model: lm.position_model
    }));

    const { buildOcclusalFrame } = await import('./metrics/calc.js');
    const result = buildOcclusalFrame(landmarkData);
    
    if (!result.frame) {
      throw new Error(`坐标系构建失败: ${result.quality.warnings.join(', ')}`);
    }

    // 验证坐标系
    const validation = validateCurrentFrame(result.frame);
    
    const testResult = {
      success: true,
      caseId: 'current',
      landmarks: landmarkData.length,
      frame: result.frame,
      quality: result.quality,
      validation,
      keyPoints: {
        samplePoints: result.used.sample_count || 0,
        hasIncisors: !!result.used.incisor_mid,
        hasCanines: !!result.used.canine_dir,
        fdiCoverage: calculateFdiCoverage(landmarkData)
      },
      framePretty: framePretty(result.frame)
    };

    displaySingleTestResult(testResult);
    
  } catch (error) {
    console.error('❌ 当前数据测试失败:', error);
    showTestError(`当前数据测试失败: ${error.message}`);
  }
}

function validateCurrentFrame(frame) {
  if (!frame || !frame.ex || !frame.ey || !frame.ez) {
    return { valid: false, error: 'Invalid frame structure' };
  }
  
  const { ex, ey, ez } = frame;
  
  // 向量工具函数
  const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vLen = (v) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  const vCross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  
  // 检查正交性
  const dotXY = Math.abs(vDot(ex, ey));
  const dotXZ = Math.abs(vDot(ex, ez));
  const dotYZ = Math.abs(vDot(ey, ez));
  
  const orthogonalThreshold = 0.01;
  const isOrthogonal = dotXY < orthogonalThreshold && dotXZ < orthogonalThreshold && dotYZ < orthogonalThreshold;
  
  // 检查单位向量
  const lenX = vLen(ex);
  const lenY = vLen(ey);
  const lenZ = vLen(ez);
  
  const unitThreshold = 0.01;
  const isUnit = Math.abs(lenX - 1) < unitThreshold && Math.abs(lenY - 1) < unitThreshold && Math.abs(lenZ - 1) < unitThreshold;
  
  // 检查右手坐标系
  const cross = vCross(ex, ey);
  const rightHandedness = vDot(cross, ez);
  const isRightHanded = rightHandedness > 0.9;
  
  return {
    valid: isOrthogonal && isUnit && isRightHanded,
    orthogonal: isOrthogonal,
    unit: isUnit,
    rightHanded: isRightHanded,
    metrics: {
      orthogonality: { dotXY, dotXZ, dotYZ },
      unitLength: { lenX, lenY, lenZ },
      handedness: rightHandedness
    }
  };
}

function calculateFdiCoverage(landmarkData) {
  const fdiPattern = /\b(1[1-8]|2[1-8]|3[1-8]|4[1-8])\b/;
  const fdiPoints = landmarkData.filter(lm => {
    const name = String(lm.name || lm.id || '');
    return fdiPattern.test(name);
  });
  
  return fdiPoints.length / landmarkData.length;
}

function showTestError(message) {
  const resultsDiv = document.getElementById('test-results');
  if (resultsDiv) {
    resultsDiv.innerHTML = `
      <div class="test-result error">
        <div class="result-header">
          ❌ 测试错误
        </div>
        <div class="result-details">
          <div style="color:#fca5a5;">${message}</div>
        </div>
      </div>
    `;
  }
}

async function toggleCoordAxisDisplay() {
  // 直接调用新的咬合坐标系分析
  await executeOcclusalFrameAnalysis();
}

// 在标记点渲染完成后自动尝试构建坐标系
// 计算并应用主组的居中偏移（方案A：仅可视化层居中）
function centerMainGroup() {
  if (!mainGroup) {
    console.warn('⚠️ 主组不存在，无法居中');
    return;
  }

  // 重置主组位置
  mainGroup.position.set(0, 0, 0);
  
  // 计算主组的包围盒
  const box = new THREE.Box3().setFromObject(mainGroup);
  
  if (box.isEmpty()) {
    console.log('ℹ️ 主组为空，无需居中');
    return;
  }
  
  // 计算包围盒中心作为偏移
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  
  // 设置主组位置为偏移的负值，实现居中
  mainGroup.position.copy(center.negate());
  
  console.log('✅ 主组已居中');
  console.log('📊 偏移量:', mainGroup.position);
  console.log('� 尺寸:', size);
  console.log('🎯 原始中心:', center.clone().negate());
  console.log('👥 子对象数量:', mainGroup.children.length);
  
  // 显示简单的用户提示
  showTemporaryMessage('已居中显示', 2000);
  
  // 更新相机以适应居中后的内容
  setTimeout(() => {
    if (mainGroup.children.length > 0) {
      fitCameraToObject(mainGroup);
    }
  }, 50);
}

// 重置视图到默认状态
function resetView() {
  if (!mainGroup) {
    console.warn('⚠️ 主组不存在，无法重置视图');
    return;
  }

  // 重置主组位置
  mainGroup.position.set(0, 0, 0);
  
  // 重置相机和控制器
  camera.position.set(0, 50, 100);
  controls.target.set(0, 0, 0);
  controls.update();
  
  console.log('✅ 视图已重置到默认状态');
  showTemporaryMessage('视图已重置', 2000);
}

// 显示模块结果面板
function showModuleResult(moduleName, result, formattedText) {
  let resultPanel = document.getElementById('module-results-panel');
  if (!resultPanel) {
    resultPanel = document.createElement('div');
    resultPanel.id = 'module-results-panel';
    resultPanel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 400px;
      max-height: 60vh;
      overflow-y: auto;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 8px;
      padding: 16px;
      z-index: 100;
      font-size: 13px;
      line-height: 1.4;
      color: #e2e8f0;
      backdrop-filter: blur(8px);
    `;
    document.body.appendChild(resultPanel);
  }

  const qualityColor = result.quality === 'ok' ? '#22c55e' : 
                      result.quality === 'fallback' ? '#f59e0b' : '#ef4444';

  resultPanel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h3 style="margin: 0; color: #60a5fa; font-size: 16px;">📊 ${moduleName}</h3>
      <button onclick="clearModuleResults()" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 18px; padding: 0; width: 20px; height: 20px;">×</button>
    </div>
    <div style="background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 6px; padding: 12px;">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
        <span style="background: ${qualityColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">
          ${result.quality?.toUpperCase() || 'N/A'}
        </span>
        ${result.warnings?.length ? `<span style="color: #fbbf24; font-size: 11px;">⚠️ ${result.warnings.length} warnings</span>` : ''}
      </div>
      <div style="font-family: monospace; font-size: 12px; white-space: pre-line; color: #cbd5e1;">
${formattedText}
      </div>
    </div>
  `;
}

// 清除模块结果面板
function clearModuleResults() {
  const resultPanel = document.getElementById('module-results-panel');
  if (resultPanel) {
    resultPanel.remove();
  }
}

// === 结果格式化函数 ===

// 格式化咬合坐标系结果
function formatOcclusalFrameResult(result) {
  if (!result.frame) {
    return `构建失败
原因: ${result.warnings?.join(', ') || '未知错误'}`;
  }

  const { origin, ex, ey, ez } = result.frame;
  return `坐标系构建成功

原点: (${origin.map(v => v.toFixed(2)).join(', ')})
X轴(前后): (${ex.map(v => v.toFixed(3)).join(', ')})
Y轴(左右): (${ey.map(v => v.toFixed(3)).join(', ')})
Z轴(上下): (${ez.map(v => v.toFixed(3)).join(', ')})

数据源: ${result.used?.z_from || 'N/A'}
质量: ${result.quality}
${result.warnings?.length ? '\n警告:\n' + result.warnings.map(w => `• ${w}`).join('\n') : ''}`;
}

// 格式化Spee曲线结果
function formatSpeeCurveResult(result) {
  if (result.depth_mm === null) {
    return `计算失败
原因: ${result.used?.A_name ? '缺少B点' : '缺少A点标记'}`;
  }

  return `Spee曲线深度: ${result.depth_mm} mm

端点信息:
• A点: ${result.used?.A_name || 'N/A'}
• B点: ${result.used?.B_name || 'N/A'}
• 弦长注释: ${result.chord?.notes || 'N/A'}

采样点: ${result.used?.samples?.length || 0} 个
方法: ${result.method}
${result.used?.samples?.length ? '\n采样标记:\n' + result.used.samples.join(', ') : ''}`;
}

// 格式化Bolton比例结果
function formatBoltonResult(result) {
  const { anterior, overall } = result;
  
  let text = 'Bolton比例分析\n\n';
  
  // 前牙比
  text += `前牙比 (目标: ${anterior.target_pct}%)\n`;
  if (anterior.ratio_pct !== null) {
    text += `实际比例: ${anterior.ratio_pct}%\n`;
    text += `上颌总和: ${anterior.upper_sum_mm} mm\n`;
    text += `下颌总和: ${anterior.lower_sum_mm} mm\n`;
    text += `下颌${anterior.lower_excess_mm >= 0 ? '过量' : '不足'}: ${Math.abs(anterior.lower_excess_mm)} mm\n`;
  } else {
    text += `计算失败 - 缺少: ${anterior.missing.join(', ')}\n`;
  }
  
  text += '\n';
  
  // 全牙比
  text += `全牙比 (目标: ${overall.target_pct}%)\n`;
  if (overall.ratio_pct !== null) {
    text += `实际比例: ${overall.ratio_pct}%\n`;
    text += `上颌总和: ${overall.upper_sum_mm} mm\n`;
    text += `下颌总和: ${overall.lower_sum_mm} mm\n`;
    text += `下颌${overall.lower_excess_mm >= 0 ? '过量' : '不足'}: ${Math.abs(overall.lower_excess_mm)} mm\n`;
  } else {
    text += `计算失败 - 缺少: ${overall.missing.join(', ')}\n`;
  }
  
  return text;
}

// 格式化锁牙合结果
function formatCrossbiteResult(result) {
  if (result.quality === 'missing') {
    return `锁牙合分析失败
原因: ${result.warnings?.join(', ') || '数据不足'}`;
  }

  let text = `锁牙合分析 (阈值: ${result.threshold_mm} mm)\n\n`;
  
  // 右侧
  if (result.right) {
    text += `右侧: ${result.right.status}\n`;
    if (result.right.deltas) {
      text += `  UL vs LB: ${result.right.deltas.UL_vs_LB_mm || 'N/A'} mm\n`;
      text += `  UB vs LL: ${result.right.deltas.UB_vs_LL_mm || 'N/A'} mm\n`;
    }
    text += `  有效点数: UL:${result.right.counts?.UL || 0} UB:${result.right.counts?.UB || 0} LL:${result.right.counts?.LL || 0} LB:${result.right.counts?.LB || 0}\n`;
  }

  text += '\n';

  // 左侧
  if (result.left) {
    text += `左侧: ${result.left.status}\n`;
    if (result.left.deltas) {
      text += `  UL vs LB: ${result.left.deltas.UL_vs_LB_mm || 'N/A'} mm\n`;
      text += `  UB vs LL: ${result.left.deltas.UB_vs_LL_mm || 'N/A'} mm\n`;
    }
    text += `  有效点数: UL:${result.left.counts?.UL || 0} UB:${result.left.counts?.UB || 0} LL:${result.left.counts?.LL || 0} LB:${result.left.counts?.LB || 0}\n`;
  }

  return text;
}

// 格式化牙列中线结果
function formatMidlineResult(result) {
  if (result.quality === 'missing') {
    return `牙列中线分析失败
原因: ${result.warnings?.join(', ') || '缺少标记点'}`;
  }

  let text = `牙列中线分析\n\n`;
  
  if (result.upper) {
    text += `上颌中线: ${result.upper.side} (${result.upper.y_mm} mm)\n`;
    text += `  偏移量: ${result.upper.offset_mm} mm\n`;
    text += `  标记点: ${result.upper.used_name}\n`;
    text += `  矢状面内: ${result.upper.within_sagittal ? '是' : '否'}\n`;
  }

  text += '\n';

  if (result.lower) {  
    text += `下颌中线: ${result.lower.side} (${result.lower.y_mm} mm)\n`;
    text += `  偏移量: ${result.lower.offset_mm} mm\n`;
    text += `  标记点: ${result.lower.used_name}\n`;
    text += `  矢状面内: ${result.lower.within_sagittal ? '是' : '否'}\n`;
  }

  if (result.diff_upper_lower_mm !== null) {
    text += `\n上下一致性: ${result.agreement}\n`;
    text += `上下差值: ${result.diff_upper_lower_mm} mm`;
  }

  return text;
}

// 格式化拥挤度结果
function formatCrowdingResult(result) {
  if (result.quality === 'missing') {
    return `拥挤度分析失败
原因: ${result.warnings?.join(', ') || '数据不足'}`;
  }

  let text = `拥挤度分析\n\n`;
  
  if (result.upper) {
    text += `上颌拥挤度: ${result.upper.sum_mm || 'N/A'} mm\n`;
    text += `  有效牙对: ${result.upper.n_pairs} 对\n`;
    text += `  测量方法: ${result.upper.method}\n`;
    if (result.upper.missing_pairs?.length) {
      text += `  缺失牙对: ${result.upper.missing_pairs.join(', ')}\n`;
    }
  }

  text += '\n';

  if (result.lower) {
    text += `下颌拥挤度: ${result.lower.sum_mm || 'N/A'} mm\n`;
    text += `  有效牙对: ${result.lower.n_pairs} 对\n`;
    text += `  测量方法: ${result.lower.method}\n`;
    if (result.lower.missing_pairs?.length) {
      text += `  缺失牙对: ${result.lower.missing_pairs.join(', ')}\n`;
    }
  }

  return text;
}

// 格式化磨牙关系结果
function formatMolarRelationshipResult(result) {
  if (!result) return '无数据';
  
  let text = `阈值: ${result.threshold_mm} mm\n`;
  text += `质量: ${result.quality}\n\n`;
  
  if (result.right) {
    text += `右侧磨牙关系: ${result.right.status}\n`;
    if (result.right.delta_x_mm !== null) {
      text += `  AP差值: ${result.right.delta_x_mm} mm\n`;
    }
    text += `  上颌点位: ${result.right.used.U_name || 'N/A'}\n`;
    text += `  下颌点位: ${result.right.used.L_name || 'N/A'}\n`;
  }
  
  text += '\n';
  
  if (result.left) {
    text += `左侧磨牙关系: ${result.left.status}\n`;
    if (result.left.delta_x_mm !== null) {
      text += `  AP差值: ${result.left.delta_x_mm} mm\n`;
    }
    text += `  上颌点位: ${result.left.used.U_name || 'N/A'}\n`;
    text += `  下颌点位: ${result.left.used.L_name || 'N/A'}\n`;
  }
  
  return text;
}

// 格式化前牙覆𬌗结果
function formatOverbiteResult(result) {
  if (!result) return '无数据';
  
  let text = `质量: ${result.quality}\n\n`;
  
  if (result.pairs && result.pairs.length > 0) {
    text += '各牙位覆𬌗:\n';
    result.pairs.forEach(pair => {
      text += `  ${pair.upper_tooth}-${pair.lower_tooth}: ${pair.overbite_mm || 'N/A'} mm\n`;
    });
    text += '\n';
  }
  
  if (result.average_mm !== null) {
    text += `平均覆𬌗: ${result.average_mm} mm\n`;
  }
  
  if (result.warnings && result.warnings.length > 0) {
    text += `\n警告: ${result.warnings.join(', ')}`;
  }
  
  return text;
}

// 格式化前牙覆盖结果
function formatOverjetResult(result) {
  if (!result) return '无数据';
  
  let text = `质量: ${result.quality}\n\n`;
  
  if (result.pairs && result.pairs.length > 0) {
    text += '各牙位覆盖:\n';
    result.pairs.forEach(pair => {
      text += `  ${pair.upper_tooth}-${pair.lower_tooth}: ${pair.overjet_mm || 'N/A'} mm\n`;
    });
    text += '\n';
  }
  
  if (result.average_mm !== null) {
    text += `平均覆盖: ${result.average_mm} mm\n`;
  }
  
  if (result.warnings && result.warnings.length > 0) {
    text += `\n警告: ${result.warnings.join(', ')}`;
  }
  
  return text;
}

// 格式化牙弓宽度结果
function formatArchWidthResult(result) {
  if (!result) return '无数据';
  
  let text = `质量: ${result.quality}\n\n`;
  
  if (result.upper) {
    text += '上颌牙弓宽度:\n';
    if (result.upper.canine_width_mm !== null) {
      text += `  尖牙宽度: ${result.upper.canine_width_mm} mm\n`;
    }
    if (result.upper.premolar_width_mm !== null) {
      text += `  前磨牙宽度: ${result.upper.premolar_width_mm} mm\n`;
    }
    if (result.upper.molar_width_mm !== null) {
      text += `  磨牙宽度: ${result.upper.molar_width_mm} mm\n`;
    }
    text += '\n';
  }
  
  if (result.lower) {
    text += '下颌牙弓宽度:\n';
    if (result.lower.canine_width_mm !== null) {
      text += `  尖牙宽度: ${result.lower.canine_width_mm} mm\n`;
    }
    if (result.lower.premolar_width_mm !== null) {
      text += `  前磨牙宽度: ${result.lower.premolar_width_mm} mm\n`;
    }
    if (result.lower.molar_width_mm !== null) {
      text += `  磨牙宽度: ${result.lower.molar_width_mm} mm\n`;
    }
  }
  
  if (result.warnings && result.warnings.length > 0) {
    text += `\n警告: ${result.warnings.join(', ')}`;
  }
  
  return text;
}

// 格式化牙弓形态结果
function formatArchFormResult(result) {
  if (!result) return '无数据';
  
  let text = `质量: ${result.quality}\n\n`;
  
  if (result.upper) {
    text += '上颌牙弓形态:\n';
    if (result.upper.classification) {
      text += `  分类: ${result.upper.classification}\n`;
    }
    if (result.upper.curve_type) {
      text += `  曲线类型: ${result.upper.curve_type}\n`;
    }
    if (result.upper.width_depth_ratio !== null) {
      text += `  宽深比: ${result.upper.width_depth_ratio}\n`;
    }
    text += '\n';
  }
  
  if (result.lower) {
    text += '下颌牙弓形态:\n';
    if (result.lower.classification) {
      text += `  分类: ${result.lower.classification}\n`;
    }
    if (result.lower.curve_type) {
      text += `  曲线类型: ${result.lower.curve_type}\n`;
    }
    if (result.lower.width_depth_ratio !== null) {
      text += `  宽深比: ${result.lower.width_depth_ratio}\n`;
    }
  }
  
  if (result.warnings && result.warnings.length > 0) {
    text += `\n警告: ${result.warnings.join(', ')}`;
  }
  
  return text;
}

// 显示临时消息
function showTemporaryMessage(message, duration = 3000) {
  // 创建消息元素
  let msgElement = document.getElementById('temp-message');
  if (!msgElement) {
    msgElement = document.createElement('div');
    msgElement.id = 'temp-message';
    msgElement.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(34, 197, 94, 0.9);
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
      pointer-events: none;
      backdrop-filter: blur(8px);
      border: 1px solid rgba(34, 197, 94, 0.3);
    `;
    document.body.appendChild(msgElement);
  }
  
  msgElement.textContent = message;
  msgElement.style.display = 'block';
  
  // 清除之前的定时器
  if (msgElement.timeoutId) {
    clearTimeout(msgElement.timeoutId);
  }
  
  // 设置新的定时器
  msgElement.timeoutId = setTimeout(() => {
    msgElement.style.display = 'none';
  }, duration);
}

function onLandmarksRendered() {
  // 计算并应用居中偏移
  centerMainGroup();
  
  if (landmarks.length > 0) {
    // 异步构建坐标系，不阻塞渲染
    setTimeout(async () => {
      await buildCoordSystemForCurrentLandmarks();
      
      // 如果用户已经开启了坐标轴显示，更新显示
      if (state.showCoordAxis) {
        updateCoordAxisDisplay();
      }
    }, 100);
  }
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
    mainGroup.add(stlMesh);
    stlMesh.updateMatrixWorld(true);

    console.log('STL网格已添加到主组');
    console.log('STL网格位置:', stlMesh.position);
    console.log('STL网格缩放:', stlMesh.scale);
    console.log('场景中的对象数量:', scene.children.length);

    // 居中显示
    centerMainGroup();

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
  
  if (!obj || obj.children.length === 0) {
    console.log('对象为空，跳过相机调整');
    return;
  }
  
  const box = new THREE.Box3().setFromObject(obj);
  
  if (box.isEmpty()) {
    console.log('包围盒为空，跳过相机调整');
    return;
  }
  
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  
  console.log('模型边界框大小:', size);
  console.log('模型中心:', center);
  
  // 设置控制器目标为包围盒中心
  controls.target.copy(center);
  
  // 设置相机位置，保持合适的距离
  const cameraDistance = Math.max(size * 1.5, 50); // 确保最小距离
  camera.position.copy(center.clone().add(new THREE.Vector3(
    cameraDistance * 0.3, 
    cameraDistance * 0.3, 
    cameraDistance * 0.8
  )));
  
  // 设置相机的近远平面
  camera.near = Math.max(size / 1000, 0.1);
  camera.far = size * 20;
  camera.updateProjectionMatrix();
  controls.update();
  
  console.log('相机位置已调整到:', camera.position);
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
    // 在新的居中系统下，直接使用原始模型坐标
    const pModel = lm.position_model;
    const geo = new THREE.SphereGeometry(sphereRadius, 16, 12);
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.1,
      roughness: 0.4
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(pModel);
    sphere.userData.landmarkId = lm.id;
    sphere.userData.radius = sphereRadius;
    sphere.castShadow = true;
    landmarkMeshes.push(sphere);
    mainGroup.add(sphere);

    const label = createLabelSprite(lm.name || lm.id, labelBase, labelScale);
    label.position.copy(pModel);
    label.position.y += sphereRadius + labelBase * labelScale;
    label.userData.landmarkId = lm.id;
    label.userData.radius = sphereRadius;
    label.userData.labelScale = labelScale;
    label.userData.baseRadius = labelBase;
    landmarkLabels.push(label);
    mainGroup.add(label);
  }

  console.log('成功渲染', landmarkMeshes.length, '个landmark球体');
  
  // 标记点渲染完成后的回调
  onLandmarksRendered();
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
  if (stlMesh) { mainGroup.remove(stlMesh); stlMesh.geometry.dispose(); stlMesh.material.dispose(); stlMesh = null; }
  clearLandmarkMeshes();
  clearLandmarkLabels();
  clearCoordAxis();
  
  // 清除后重置主组位置
  if (mainGroup) {
    mainGroup.position.set(0, 0, 0);
  }
}

function clearCoordAxis() {
  if (coordAxisHelper) {
    mainGroup.remove(coordAxisHelper);
    coordAxisHelper.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    });
    coordAxisHelper = null;
    
    // 移除坐标轴后重新居中
    centerMainGroup();
  }
  coordFrame = null;
}

function clearLandmarkMeshes() {
  for (const m of landmarkMeshes) {
    mainGroup.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  }
  landmarkMeshes.length = 0;
}

function clearLandmarkLabels() {
  for (const label of landmarkLabels) {
    mainGroup.remove(label);
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

// ---- 坐标轴可视化 ----
function createCoordAxisHelper(frame, scale = 20) {
  if (!frame || !frame.origin || !frame.ex || !frame.ey || !frame.ez) {
    console.warn('Invalid frame for coordinate axis helper');
    return null;
  }

  // 验证数值有效性
  const validateVector = (vec, name) => {
    if (!Array.isArray(vec) || vec.length !== 3) {
      console.error(`Invalid ${name} vector:`, vec);
      return false;
    }
    for (let i = 0; i < 3; i++) {
      if (!isFinite(vec[i])) {
        console.error(`NaN or Infinity in ${name}[${i}]:`, vec[i]);
        return false;
      }
    }
    return true;
  };

  if (!validateVector(frame.origin, 'origin') ||
      !validateVector(frame.ex, 'ex') ||
      !validateVector(frame.ey, 'ey') ||
      !validateVector(frame.ez, 'ez')) {
    console.error('坐标系数据包含无效值，无法创建坐标轴');
    return null;
  }

  // 验证缩放值
  if (!isFinite(scale) || scale <= 0) {
    console.warn('Invalid scale value:', scale, 'using default 20');
    scale = 20;
  }

  const group = new THREE.Group();
  
  try {
    const origin = new THREE.Vector3(...frame.origin);
    const ex = new THREE.Vector3(...frame.ex).multiplyScalar(scale);
    const ey = new THREE.Vector3(...frame.ey).multiplyScalar(scale);
    const ez = new THREE.Vector3(...frame.ez).multiplyScalar(scale);
    
    // 再次验证计算后的向量
    const isVectorValid = (vec) => isFinite(vec.x) && isFinite(vec.y) && isFinite(vec.z);
    
    if (!isVectorValid(origin) || !isVectorValid(ex) || !isVectorValid(ey) || !isVectorValid(ez)) {
      console.error('计算后的向量含有无效值:');
      console.error('origin:', origin, 'ex:', ex, 'ey:', ey, 'ez:', ez);
      return null;
    }

    // 使用更安全的方式创建线条几何体
    const createSafeLine = (start, end, color, name) => {
      const startPoint = start.clone();
      const endPoint = start.clone().add(end);
      
      // 验证端点
      if (!isFinite(startPoint.x) || !isFinite(startPoint.y) || !isFinite(startPoint.z) ||
          !isFinite(endPoint.x) || !isFinite(endPoint.y) || !isFinite(endPoint.z)) {
        console.error(`❌ ${name}轴端点包含无效值:`, 
          `起点(${startPoint.x}, ${startPoint.y}, ${startPoint.z})`, 
          `终点(${endPoint.x}, ${endPoint.y}, ${endPoint.z})`);
        return null;
      }
      
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array([
        startPoint.x, startPoint.y, startPoint.z,
        endPoint.x, endPoint.y, endPoint.z
      ]);
      
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({ color: color, linewidth: 3 });
      
      console.log(`✅ ${name}轴创建成功: (${startPoint.x.toFixed(2)}, ${startPoint.y.toFixed(2)}, ${startPoint.z.toFixed(2)}) -> (${endPoint.x.toFixed(2)}, ${endPoint.y.toFixed(2)}, ${endPoint.z.toFixed(2)})`);
      
      return new THREE.Line(geometry, material);
    };

    // X轴 - 红色 (前后方向 Anterior-Posterior)
    const xLine = createSafeLine(origin, ex, 0xff0000, 'X');
    if (xLine) group.add(xLine);

    // Y轴 - 绿色 (左右方向 Transverse)  
    const yLine = createSafeLine(origin, ey, 0x00ff00, 'Y');
    if (yLine) group.add(yLine);

    // Z轴 - 蓝色 (上下方向 Vertical)
    const zLine = createSafeLine(origin, ez, 0x0000ff, 'Z');
    if (zLine) group.add(zLine);

    // 坐标轴标签
    const labelScale = scale * 0.03;
    
    // X轴标签
    const xLabel = createAxisLabel('X (AP)', labelScale);
    xLabel.position.copy(origin.clone().add(ex).add(new THREE.Vector3(2, 2, 2)));
    group.add(xLabel);

    // Y轴标签  
    const yLabel = createAxisLabel('Y (TR)', labelScale);
    yLabel.position.copy(origin.clone().add(ey).add(new THREE.Vector3(2, 2, 2)));
    group.add(yLabel);

    // Z轴标签
    const zLabel = createAxisLabel('Z (V)', labelScale);
    zLabel.position.copy(origin.clone().add(ez).add(new THREE.Vector3(2, 2, 2)));
    group.add(zLabel);

    // 原点标记
    const originGeometry = new THREE.SphereGeometry(scale * 0.05, 8, 6);
    const originMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const originSphere = new THREE.Mesh(originGeometry, originMaterial);
    originSphere.position.copy(origin);
    group.add(originSphere);

    // 原点标签
    const originLabel = createAxisLabel('Origin', labelScale);
    originLabel.position.copy(origin.clone().add(new THREE.Vector3(0, scale * 0.15, 0)));
    group.add(originLabel);

    return group;

  } catch (error) {
    console.error('创建坐标轴时发生错误:', error);
    return null;
  }
}

function createAxisLabel(text, scale = 1) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const fontSize = 48;
  const padding = 12;

  context.font = `bold ${fontSize}px "Arial", sans-serif`;
  const metrics = context.measureText(text);
  canvas.width = Math.ceil(metrics.width + padding * 2);
  canvas.height = Math.ceil(fontSize + padding * 2);

  // 重新设置字体（canvas重置后需要）
  context.font = `bold ${fontSize}px "Arial", sans-serif`;
  
  // 背景
  context.fillStyle = 'rgba(0, 0, 0, 0.7)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  
  // 文字
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({ 
    map: texture, 
    transparent: true,
    depthTest: false 
  });
  const sprite = new THREE.Sprite(material);
  
  sprite.renderOrder = 10;
  const spriteScale = scale * 2;
  const aspect = canvas.height / canvas.width;
  sprite.scale.set(spriteScale, spriteScale * aspect, 1);
  
  return sprite;
}

function updateCoordAxisDisplay() {
  // 清除旧的坐标轴
  if (coordAxisHelper) {
    mainGroup.remove(coordAxisHelper);
    coordAxisHelper.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    });
    coordAxisHelper = null;
  }

  // 如果显示坐标轴且有有效坐标系，创建新的坐标轴
  if (state.showCoordAxis && coordFrame && coordFrame.frame) {
    console.log('🎨 准备显示坐标轴...');
    
    // 详细验证坐标系数据
    const frame = coordFrame.frame;
    console.log('坐标系数据检查:');
    console.log('  原点:', frame.origin);
    console.log('  X轴:', frame.ex);
    console.log('  Y轴:', frame.ey); 
    console.log('  Z轴:', frame.ez);
    
    // 验证所有值都是有限数值
    const allVectors = [
      { name: 'origin', vec: frame.origin },
      { name: 'ex', vec: frame.ex },
      { name: 'ey', vec: frame.ey },
      { name: 'ez', vec: frame.ez }
    ];
    
    let hasInvalidData = false;
    for (const {name, vec} of allVectors) {
      if (!Array.isArray(vec) || vec.length !== 3) {
        console.error(`❌ ${name} 不是有效的3D向量:`, vec);
        hasInvalidData = true;
        continue;
      }
      
      for (let i = 0; i < 3; i++) {
        if (!isFinite(vec[i])) {
          console.error(`❌ ${name}[${i}] 包含无效值:`, vec[i]);
          hasInvalidData = true;
        }
      }
    }
    
    if (hasInvalidData) {
      console.error('❌ 坐标系数据包含无效值，无法显示坐标轴');
      return;
    }
    
    const scale = getScaleForCoordAxis();
    console.log('坐标轴缩放比例:', scale);
    
    if (!isFinite(scale) || scale <= 0) {
      console.error('❌ 无效的缩放比例:', scale);
      return;
    }
    
    coordAxisHelper = createCoordAxisHelper(coordFrame.frame, scale);
    if (coordAxisHelper) {
      mainGroup.add(coordAxisHelper);
      console.log('✅ 坐标轴已成功添加到主组');
      
      // 添加坐标轴后重新居中
      centerMainGroup();
    } else {
      console.error('❌ 坐标轴创建失败');
    }
  }
}

function getScaleForCoordAxis() {
  if (!stlMesh) return 20;
  
  const box = new THREE.Box3().setFromObject(stlMesh);
  const size = box.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  return maxDimension * 0.3; // 坐标轴长度为模型最大尺寸的30%
}

// 显示坐标轴的3D可视化
function displayCoordinateAxis(frame) {
  if (!frame || !frame.origin || !frame.ex || !frame.ey || !frame.ez) {
    console.error('❌ 无效的坐标系数据');
    return;
  }

  // 清除之前的坐标轴
  const existingAxis = mainGroup.getObjectByName('CoordinateAxis');
  if (existingAxis) {
    mainGroup.remove(existingAxis);
  }

  try {
    const axisGroup = new THREE.Group();
    axisGroup.name = 'CoordinateAxis';

    const origin = new THREE.Vector3(...frame.origin);
    const axisLength = 20; // 坐标轴长度

    // 创建三个轴的方向向量
    const xAxis = new THREE.Vector3(...frame.ex).multiplyScalar(axisLength);
    const yAxis = new THREE.Vector3(...frame.ey).multiplyScalar(axisLength);
    const zAxis = new THREE.Vector3(...frame.ez).multiplyScalar(axisLength);

    // X轴 (前后, 红色)
    const xGeometry = new THREE.BufferGeometry().setFromPoints([
      origin,
      origin.clone().add(xAxis)
    ]);
    const xMaterial = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 3 });
    const xLine = new THREE.Line(xGeometry, xMaterial);
    axisGroup.add(xLine);

    // Y轴 (左右, 绿色)
    const yGeometry = new THREE.BufferGeometry().setFromPoints([
      origin,
      origin.clone().add(yAxis)
    ]);
    const yMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 3 });
    const yLine = new THREE.Line(yGeometry, yMaterial);
    axisGroup.add(yLine);

    // Z轴 (上下, 蓝色)
    const zGeometry = new THREE.BufferGeometry().setFromPoints([
      origin,
      origin.clone().add(zAxis)
    ]);
    const zMaterial = new THREE.LineBasicMaterial({ color: 0x0000ff, linewidth: 3 });
    const zLine = new THREE.Line(zGeometry, zMaterial);
    axisGroup.add(zLine);

    // 添加标签
    const createAxisLabel = (text, position, color) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = 128;
      canvas.height = 64;
      
      context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      context.font = 'Bold 24px Arial';
      context.textAlign = 'center';
      context.fillText(text, 64, 40);
      
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.SpriteMaterial({ map: texture });
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(position);
      sprite.scale.set(8, 4, 1);
      
      return sprite;
    };

    axisGroup.add(createAxisLabel('X(AP)', origin.clone().add(xAxis.multiplyScalar(1.2)), 0xff0000));
    axisGroup.add(createAxisLabel('Y(LR)', origin.clone().add(yAxis.multiplyScalar(1.2)), 0x00ff00));
    axisGroup.add(createAxisLabel('Z(SI)', origin.clone().add(zAxis.multiplyScalar(1.2)), 0x0000ff));

    // 原点标记
    const originGeometry = new THREE.SphereGeometry(1, 8, 8);
    const originMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const originSphere = new THREE.Mesh(originGeometry, originMaterial);
    originSphere.position.copy(origin);
    axisGroup.add(originSphere);

    mainGroup.add(axisGroup);
    console.log('✅ 坐标轴显示成功');
    
    // 添加坐标轴后重新居中
    centerMainGroup();

  } catch (error) {
    console.error('❌ 坐标轴显示失败:', error);
  }
}

async function buildCoordSystemForCurrentLandmarks() {
  if (!landmarks || landmarks.length === 0) {
    console.warn('没有标记点数据，无法构建坐标系');
    return null;
  }

  try {
    // 转换为calc.js期望的格式并验证数据有效性
    const landmarkData = landmarks.map(lm => {
      const pos = lm.position_model;
      if (!pos || !isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) {
        console.warn(`⚠️ 标记点 ${lm.name} 位置数据无效:`, pos);
        return null;
      }
      return {
        id: lm.id,
        name: lm.name,
        position: [pos.x, pos.y, pos.z]
      };
    }).filter(Boolean); // 过滤掉无效的标记点

    if (landmarkData.length === 0) {
      console.error('❌ 所有标记点的位置数据都无效');
      return null;
    }

    console.log(`🧪 为当前${landmarkData.length}个有效标记点构建坐标系...`);
    console.log('📊 标记点样例:', landmarkData.slice(0, 5).map(lm => `${lm.name}: [${lm.position.map(x => x.toFixed(2)).join(', ')}]`));
    
    // 输出调试信息：检查标记点名称模式
    console.log('🔍 标记点名称模式分析:');
    const namePatterns = {};
    landmarkData.forEach(lm => {
      const fdi = lm.name.match(/\b(1[1-8]|2[1-8]|3[1-8]|4[1-8])\b/);
      if (fdi) {
        const suffix = lm.name.toLowerCase().slice(lm.name.toLowerCase().indexOf(fdi[1]) + fdi[1].length);
        const pattern = `${fdi[1]}${suffix}`;
        namePatterns[pattern] = (namePatterns[pattern] || 0) + 1;
      }
    });
    console.log('  发现的FDI模式:', Object.keys(namePatterns).slice(0, 10).join(', '));
    console.log('  下颌后牙相关:', Object.keys(namePatterns).filter(p => p.startsWith('3') || p.startsWith('4')).slice(0, 10).join(', '));
    
    // 直接调用新的咬合坐标系构建函数
    const { buildOcclusalFrame } = await import('./metrics/calc.js');
    const result = buildOcclusalFrame(landmarkData);
    
    if (!result.frame) {
      console.warn('坐标系构建失败:', result.quality.warnings.join(', '));
      return null;
    }

    // 验证坐标系数据有效性
    const validateFrameData = (frame) => {
      const vectors = ['origin', 'ex', 'ey', 'ez'];
      for (const vecName of vectors) {
        const vec = frame[vecName];
        if (!Array.isArray(vec) || vec.length !== 3) {
          console.error(`Invalid ${vecName}: not a 3D array`, vec);
          return false;
        }
        for (let i = 0; i < 3; i++) {
          if (!isFinite(vec[i])) {
            console.error(`Invalid ${vecName}[${i}]: ${vec[i]}`);
            return false;
          }
        }
      }
      return true;
    };

    if (!validateFrameData(result.frame)) {
      console.error('❌ 坐标系数据包含无效值，无法显示坐标轴');
      return null;
    }

    console.log('✅ 坐标系构建成功');
    console.log('质量状态:', result.quality.status);
    
    if (result.quality.warnings.length > 0) {
      console.log('⚠️ 警告:', result.quality.warnings.join(', '));
    }

    console.log('坐标系向量:');
    console.log(`  原点: [${result.frame.origin.map(x => x.toFixed(2)).join(', ')}]`);
    console.log(`  X轴(前后): [${result.frame.ex.map(x => x.toFixed(3)).join(', ')}]`);
    console.log(`  Y轴(左右): [${result.frame.ey.map(x => x.toFixed(3)).join(', ')}]`);
    console.log(`  Z轴(上下): [${result.frame.ez.map(x => x.toFixed(3)).join(', ')}]`);

    coordFrame = result;
    return result;
    
  } catch (error) {
    console.error('❌ 坐标系构建错误:', error);
    return null;
  }
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
async function autoLoadDefaultFiles() {
  try {
    console.log('尝试自动加载默认文件...');
    await loadDemoCase('1_L');
  } catch (error) {
    console.error('自动加载文件失败:', error);
    console.log('请手动使用文件选择器加载STL和JSON文件');
  }
}

// === 模块1: 咬合坐标系分析 ===
async function executeOcclusalFrameAnalysis() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  try {
    console.log('📊 执行咬合坐标系分析...');
    const { buildOcclusalFrame, framePretty } = await import('./metrics/calc.js');
    
    const landmarkData = landmarks.map(lm => ({
      name: lm.name,
      position_model: lm.position_model
    }));
    
    const result = buildOcclusalFrame(landmarkData);
    
    if (result.frame) {
      console.log('✅ 咬合坐标系构建成功:');
      console.log(framePretty(result.frame));
      console.log('状态:', result.quality.status);
      console.log('警告:', result.quality.warnings);
      
      // 显示坐标轴
      displayCoordinateAxis(result.frame);
      
      // 显示结果面板
      showAnalysisResult('咬合坐标系分析', {
        '构建状态': result.quality.status === 'ok' ? '✅ 成功' : '⚠️ 回退',
        '样本点数': result.used.sample_count || '未知',
        '切牙校准': result.used.incisor_mid ? '✅ 已校准' : '❌ 未校准',
        '犬牙定向': result.used.canine_dir ? '✅ 已定向' : '⚠️ 回退',
        '警告数量': result.quality.warnings.length
      });
      
      // 存储坐标系供其他分析使用
      window.currentOcclusalFrame = result.frame;
      
    } else {
      console.error('❌ 咬合坐标系构建失败:', result.quality.warnings);
      alert(`坐标系构建失败: ${result.quality.warnings.join(', ')}`);
    }
    
  } catch (error) {
    console.error('❌ 咬合坐标系分析错误:', error);
    alert(`分析错误: ${error.message}`);
  }
}

// === 模块2: Spee曲线分析 ===
async function executeSpeeCurveAnalysis() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  try {
    console.log('📈 执行Spee曲线分析...');
    const { buildOcclusalFrame, computeSpeeLowerDepth } = await import('./metrics/calc.js');
    
    const landmarkData = landmarks.map(lm => ({
      name: lm.name,
      position_model: lm.position_model
    }));
    
    // 确保有坐标系
    let frame = window.currentOcclusalFrame;
    if (!frame) {
      console.log('🔧 首先构建咬合坐标系...');
      const frameResult = buildOcclusalFrame(landmarkData);
      if (!frameResult.frame) {
        alert('需要先构建咬合坐标系');
        return;
      }
      frame = frameResult.frame;
      window.currentOcclusalFrame = frame;
    }
    
    const result = computeSpeeLowerDepth(landmarkData, frame);
    
    if (result.depth_mm !== null) {
      console.log('✅ Spee曲线分析完成:');
      console.log(`  曲线深度: ${result.depth_mm}mm`);
      console.log(`  端点: ${result.used.A_name} → ${result.used.B_name}`);
      console.log(`  样本点: ${result.used.samples.join(', ')}`);
      console.log(`  质量: ${result.quality}, 方法: ${result.method}`);
      
      // 显示Spee曲线3D可视化
      await displaySpeeCurveVisualization(result, landmarkData, frame);
      
      showAnalysisResult('Spee曲线分析', {
        '曲线深度': `${result.depth_mm}mm`,
        '前端点': result.used.A_name,
        '后端点': result.used.B_name,
        '样本点数': result.used.samples.length,
        '分析质量': result.quality,
        '计算方法': result.method === 'vertical_fallback' ? '垂直回退' : '弦垂距'
      });
      
    } else {
      console.error('❌ Spee曲线分析失败: 无法计算深度');
      alert('Spee曲线分析失败: 缺少必要的标记点');
    }
    
  } catch (error) {
    console.error('❌ Spee曲线分析错误:', error);
    alert(`分析错误: ${error.message}`);
  }
}

// Spee曲线3D可视化
async function displaySpeeCurveVisualization(result, landmarkData, frame) {
  if (!result.chord.A || !result.chord.B) {
    console.warn('⚠️ Spee曲线端点不完整，无法显示可视化');
    return;
  }

  try {
    // 清除之前的Spee曲线可视化
    const existingSpee = mainGroup.getObjectByName('SpeeCurveVisualization');
    if (existingSpee) {
      mainGroup.remove(existingSpee);
    }

    const speeGroup = new THREE.Group();
    speeGroup.name = 'SpeeCurveVisualization';

    // 获取端点A和B的3D坐标
    const pointA = new THREE.Vector3(...result.chord.A);
    const pointB = new THREE.Vector3(...result.chord.B);

    // 1. 绘制弦线（A到B）- 使用管道几何体使其更粗更明显
    const direction = pointB.clone().sub(pointA).normalize();
    const chordLength = pointA.distanceTo(pointB);
    
    const chordTubeGeometry = new THREE.TubeGeometry(
      new THREE.LineCurve3(pointA, pointB),
      2, // 分段数
      0.5, // 管道半径
      4, // 径向分段数
      false // 不封闭
    );
    const chordMaterial = new THREE.MeshBasicMaterial({ 
      color: 0xff6b35, // 橙色
      transparent: true,
      opacity: 0.8
    });
    const chordTube = new THREE.Mesh(chordTubeGeometry, chordMaterial);
    speeGroup.add(chordTube);

    // 2. 标记端点A和B
    const endPointGeometry = new THREE.SphereGeometry(1.5, 8, 8);
    
    // 端点A（前端）
    const pointAMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 }); // 绿色
    const pointASphere = new THREE.Mesh(endPointGeometry, pointAMaterial);
    pointASphere.position.copy(pointA);
    speeGroup.add(pointASphere);

    // 端点B（后端）  
    const pointBMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 }); // 红色
    const pointBSphere = new THREE.Mesh(endPointGeometry, pointBMaterial);
    pointBSphere.position.copy(pointB);
    speeGroup.add(pointBSphere);

    // 3. 显示采样点
    const { pick, projectToFrame } = await import('./metrics/utils.js');
    result.used.samples.forEach((sampleName, index) => {
      const samplePoint3D = pick(landmarkData, [sampleName]);
      if (samplePoint3D) {
        // 创建发光的采样点
        const sampleGeometry = new THREE.SphereGeometry(1.0, 8, 8);
        const sampleMaterial = new THREE.MeshBasicMaterial({ 
          color: 0xffff00, // 黄色
          transparent: true,
          opacity: 0.9
        });
        const sampleSphere = new THREE.Mesh(sampleGeometry, sampleMaterial);
        sampleSphere.position.set(...samplePoint3D);
        speeGroup.add(sampleSphere);
        
        // 添加外层光晕效果
        const glowGeometry = new THREE.SphereGeometry(1.5, 8, 8);
        const glowMaterial = new THREE.MeshBasicMaterial({
          color: 0xffff00,
          transparent: true,
          opacity: 0.3
        });
        const glowSphere = new THREE.Mesh(glowGeometry, glowMaterial);
        glowSphere.position.set(...samplePoint3D);
        speeGroup.add(glowSphere);
      }
    });

    // 4. 计算并显示最深点（垂距最大的点）
    if (result.depth_mm > 0) {
      // 重新计算找到最深点
      const A2 = projectToFrame(result.chord.A, frame);
      const B2 = projectToFrame(result.chord.B, frame);  
      const ux = B2.x - A2.x, uz = B2.z - A2.z;
      const L = Math.hypot(ux, uz) || 1e-9;
      const u = {x: ux/L, z: uz/L};
      let n = {x: -u.z, z: u.x};
      if (n.z > 0) { n.x = -n.x; n.z = -n.z; }
      
      let maxDepth = 0;
      let deepestPoint = null;
      
      result.used.samples.forEach(sampleName => {
        const point3D = pick(landmarkData, [sampleName]);
        if (point3D) {
          const p = projectToFrame(point3D, frame);
          const wx = p.x - A2.x, wz = p.z - A2.z;
          const t = wx * u.x + wz * u.z;
          
          if (t >= -1e-6 && t <= L + 1e-6) {
            let depth;
            if (Math.abs(n.z) < 1e-3) {
              // 垂直回退
              const zc = A2.z + t * u.z;
              depth = zc - p.z;
            } else {
              // 弦垂距
              depth = wx * n.x + wz * n.z;
            }
            
            if (depth > maxDepth) {
              maxDepth = depth;
              deepestPoint = point3D;
            }
          }
        }
      });
      
      // 显示最深点
      if (deepestPoint) {
        const deepGeometry = new THREE.SphereGeometry(1.2, 8, 8);
        const deepMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff }); // 紫色
        const deepSphere = new THREE.Mesh(deepGeometry, deepMaterial);
        deepSphere.position.set(...deepestPoint);
        speeGroup.add(deepSphere);
        
        // 从最深点向弦线做垂线
        const deepPoint = new THREE.Vector3(...deepestPoint);
        const projectedPoint = projectPointToLine(deepPoint, pointA, pointB);
        
        // 使用管道几何体创建更明显的深度线
        const depthTubeGeometry = new THREE.TubeGeometry(
          new THREE.LineCurve3(deepPoint, projectedPoint),
          2, // 分段数
          0.3, // 管道半径
          4, // 径向分段数
          false // 不封闭
        );
        const depthLineMaterial = new THREE.MeshBasicMaterial({ 
          color: 0xff00ff, // 紫色
          transparent: true,
          opacity: 0.7
        });
        const depthTube = new THREE.Mesh(depthTubeGeometry, depthLineMaterial);
        speeGroup.add(depthTube);
      }
    }

    // 5. 添加标签
    const createLabel = (text, position, color) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = 256;
      canvas.height = 128;
      
      context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      context.font = 'Bold 20px Arial';
      context.textAlign = 'center';
      context.fillText(text, 128, 64);
      
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.SpriteMaterial({ map: texture });
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(position);
      sprite.scale.set(10, 5, 1);
      
      return sprite;
    };

    speeGroup.add(createLabel(`A: ${result.used.A_name}`, pointA.clone().add(new THREE.Vector3(0, 5, 0)), 0x00ff00));
    speeGroup.add(createLabel(`B: ${result.used.B_name}`, pointB.clone().add(new THREE.Vector3(0, 5, 0)), 0xff0000));
    speeGroup.add(createLabel(`深度: ${result.depth_mm}mm`, pointA.clone().add(pointB).multiplyScalar(0.5).add(new THREE.Vector3(0, 8, 0)), 0xffffff));

    mainGroup.add(speeGroup);
    console.log('✅ Spee曲线3D可视化已显示');
    
    // 添加新对象后重新居中
    centerMainGroup();

  } catch (error) {
    console.error('❌ Spee曲线可视化失败:', error);
  }
}

// 辅助函数：将点投影到直线上
function projectPointToLine(point, lineStart, lineEnd) {
  const lineVec = lineEnd.clone().sub(lineStart);
  const pointVec = point.clone().sub(lineStart);
  const lineLength = lineVec.length();
  
  if (lineLength === 0) return lineStart.clone();
  
  const t = pointVec.dot(lineVec) / (lineLength * lineLength);
  const clampedT = Math.max(0, Math.min(1, t));
  
  return lineStart.clone().add(lineVec.multiplyScalar(clampedT));
}

// 清除Spee曲线可视化
function clearSpeeCurveVisualization() {
  const existingSpee = mainGroup.getObjectByName('SpeeCurveVisualization');
  if (existingSpee) {
    mainGroup.remove(existingSpee);
    console.log('✅ Spee曲线可视化已清除');
    
    // 移除对象后重新居中
    centerMainGroup();
  } else {
    console.log('ℹ️ 没有找到Spee曲线可视化对象');
  }
}

// === 模块执行函数 ===

// 模块1: 咬合坐标系
async function executeModule1() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  console.log('🎯 执行模块1: 咬合坐标系构建');
  showTemporaryMessage('正在构建咬合坐标系...', 1000);

  try {
    // 动态导入calc模块
    const { buildOcclusalFrame } = await import('./metrics/calc.js');
    
    // 获取STL点云（如果有）- 使用原始几何体坐标
    const geomPoints = stlMesh?.geometry?.attributes?.position ? 
      Array.from({ length: stlMesh.geometry.attributes.position.count }, (_, i) => [
        stlMesh.geometry.attributes.position.getX(i),
        stlMesh.geometry.attributes.position.getY(i),
        stlMesh.geometry.attributes.position.getZ(i)
      ]) : null;

    console.log('📊 STL点云信息:', geomPoints ? `${geomPoints.length}个顶点` : '无STL数据');

    // 将landmarks转换为calc模块期望的格式
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        // 从FDI名称提取基础名称（移除可能的后缀）
        const baseName = lm.name || lm.id;
        landmarkDict[baseName] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    console.log('📍 处理后的landmarks字典:', Object.keys(landmarkDict));

    // 构建坐标系
    const result = buildOcclusalFrame(landmarkDict, geomPoints);
    console.log('📊 坐标系构建结果:', result);

    if (result.frame) {
      coordFrame = result;
      // 显示坐标轴
      updateCoordAxisDisplay();
      showTemporaryMessage('咬合坐标系构建完成 ✓', 2000);
      
      // 显示结果面板
      showModuleResult('咬合坐标系', result, formatOcclusalFrameResult(result));
    } else {
      showTemporaryMessage('坐标系构建失败', 2000);
      showModuleResult('咬合坐标系', result, '构建失败：缺少足够的标记点');
    }
  } catch (error) {
    console.error('❌ 模块1执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块2: Spee曲线
async function executeModule2() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  if (!coordFrame?.frame) {
    alert('请先构建咬合坐标系（模块1）');
    return;
  }

  console.log('🎯 执行模块2: Spee曲线分析');
  showTemporaryMessage('正在计算Spee曲线...', 1000);

  try {
    // 动态导入calc模块
    const { computeSpeeLowerDepth } = await import('./metrics/calc.js');
    
    // 将landmarks转换为字典格式
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const result = computeSpeeLowerDepth(landmarkDict, coordFrame.frame);
    console.log('📊 Spee曲线结果:', result);

    // 显示3D可视化
    if (result.depth_mm !== null) {
      await displaySpeeCurveVisualization(result, landmarks, coordFrame.frame);
      showTemporaryMessage(`Spee曲线深度: ${result.depth_mm}mm ✓`, 2000);
    } else {
      showTemporaryMessage('Spee曲线计算失败', 2000);
    }

    // 显示结果面板
    showModuleResult('Spee曲线', result, formatSpeeCurveResult(result));
  } catch (error) {
    console.error('❌ 模块2执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块3: Bolton比例
async function executeModule3() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  console.log('🎯 执行模块3: Bolton比例分析');
  showTemporaryMessage('正在计算Bolton比例...', 1000);

  try {
    // 动态导入calc模块
    const { computeBolton } = await import('./metrics/calc.js');
    
    // 将landmarks转换为字典格式
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const cfg = coordFrame?.frame ? { use_plane: true, frame: coordFrame.frame } : {};
    const result = computeBolton(landmarkDict, cfg);
    console.log('📊 Bolton比例结果:', result);

    showTemporaryMessage('Bolton比例计算完成 ✓', 2000);
    showModuleResult('Bolton比例', result, formatBoltonResult(result));
  } catch (error) {
    console.error('❌ 模块3执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块4: 锁牙合
async function executeModule4() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  if (!coordFrame?.frame) {
    alert('请先构建咬合坐标系（模块1）');
    return;
  }

  console.log('🎯 执行模块4: 锁牙合分析');
  showTemporaryMessage('正在分析锁牙合...', 1000);

  try {
    // 动态导入calc模块
    const { computeCrossbiteLock } = await import('./metrics/calc.js');
    
    // 将landmarks转换为字典格式
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const result = computeCrossbiteLock(landmarkDict, coordFrame.frame);
    console.log('📊 锁牙合结果:', result);

    showTemporaryMessage('锁牙合分析完成 ✓', 2000);
    showModuleResult('锁牙合', result, formatCrossbiteResult(result));
  } catch (error) {
    console.error('❌ 模块4执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块5: 牙列中线
async function executeModule5() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  if (!coordFrame?.frame) {
    alert('请先构建咬合坐标系（模块1）');
    return;
  }

  console.log('🎯 执行模块5: 牙列中线分析');
  showTemporaryMessage('正在分析牙列中线...', 1000);

  try {
    // 动态导入calc模块
    const { computeMidlineAlignment } = await import('./metrics/calc.js');
    
    // 将landmarks转换为字典格式
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const result = computeMidlineAlignment(landmarkDict, coordFrame.frame);
    console.log('📊 牙列中线结果:', result);

    // 显示3D可视化
    await displayMidlineVisualization(result, coordFrame.frame);
    
    showTemporaryMessage('牙列中线分析完成 ✓', 2000);
    showModuleResult('牙列中线', result, formatMidlineResult(result));
  } catch (error) {
    console.error('❌ 模块5执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块6: 拥挤度
async function executeModule6() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  console.log('🎯 执行模块6: 拥挤度分析');
  showTemporaryMessage('正在计算拥挤度...', 1000);

  try {
    // 动态导入calc模块
    const { computeCrowding } = await import('./metrics/calc.js');
    
    // 将landmarks转换为字典格式
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const cfg = coordFrame?.frame ? { use_plane: true } : { use_plane: false };
    const result = computeCrowding(landmarkDict, coordFrame.frame, cfg);
    console.log('📊 拥挤度结果:', result);

    showTemporaryMessage('拥挤度分析完成 ✓', 2000);
    showModuleResult('拥挤度', result, formatCrowdingResult(result));
  } catch (error) {
    console.error('❌ 模块6执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块7: 磨牙关系
async function executeModule7() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  if (!coordFrame || !coordFrame.frame) {
    alert('请先执行咬合坐标系构建');
    return;
  }

  showTemporaryMessage('正在分析磨牙关系...', 1000);

  try {
    const { computeMolarRelationship } = await import('./metrics/calc.js');
    
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const result = computeMolarRelationship(landmarkDict, coordFrame.frame);
    console.log('📊 磨牙关系结果:', result);

    showTemporaryMessage('磨牙关系分析完成 ✓', 2000);
    showModuleResult('磨牙关系', result, formatMolarRelationshipResult(result));
  } catch (error) {
    console.error('❌ 模块7执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块8: 前牙覆𬌗
async function executeModule8() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  if (!coordFrame || !coordFrame.frame) {
    alert('请先执行咬合坐标系构建');
    return;
  }

  showTemporaryMessage('正在计算前牙覆𬌗...', 1000);

  try {
    const { computeOverbite } = await import('./metrics/calc.js');
    
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const result = computeOverbite(landmarkDict, coordFrame.frame);
    console.log('📊 前牙覆𬌗结果:', result);

    showTemporaryMessage('前牙覆𬌗分析完成 ✓', 2000);
    showModuleResult('前牙覆𬌗', result, formatOverbiteResult(result));
  } catch (error) {
    console.error('❌ 模块8执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块9: 前牙覆盖
async function executeModule9() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  if (!coordFrame || !coordFrame.frame) {
    alert('请先执行咬合坐标系构建');
    return;
  }

  showTemporaryMessage('正在计算前牙覆盖...', 1000);

  try {
    const { computeOverjet } = await import('./metrics/calc.js');
    
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const result = computeOverjet(landmarkDict, coordFrame.frame);
    console.log('📊 前牙覆盖结果:', result);

    showTemporaryMessage('前牙覆盖分析完成 ✓', 2000);
    showModuleResult('前牙覆盖', result, formatOverjetResult(result));
  } catch (error) {
    console.error('❌ 模块9执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块10: 牙弓宽度
async function executeModule10() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  if (!coordFrame || !coordFrame.frame) {
    alert('请先执行咬合坐标系构建');
    return;
  }

  showTemporaryMessage('正在计算牙弓宽度...', 1000);

  try {
    const { computeArchWidth } = await import('./metrics/calc.js');
    
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const result = computeArchWidth(landmarkDict, coordFrame.frame);
    console.log('📊 牙弓宽度结果:', result);

    showTemporaryMessage('牙弓宽度分析完成 ✓', 2000);
    showModuleResult('牙弓宽度', result, formatArchWidthResult(result));
  } catch (error) {
    console.error('❌ 模块10执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 模块11: 牙弓形态
async function executeModule11() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  if (!coordFrame || !coordFrame.frame) {
    alert('请先执行咬合坐标系构建');
    return;
  }

  showTemporaryMessage('正在分析牙弓形态...', 1000);

  try {
    const { computeArchForm } = await import('./metrics/calc.js');
    
    const landmarkDict = {};
    landmarks.forEach(lm => {
      if (lm.position_model) {
        landmarkDict[lm.name || lm.id] = [
          lm.position_model.x,
          lm.position_model.y,
          lm.position_model.z
        ];
      }
    });

    const result = computeArchForm(landmarkDict, coordFrame.frame);
    console.log('📊 牙弓形态结果:', result);

    showTemporaryMessage('牙弓形态分析完成 ✓', 2000);
    showModuleResult('牙弓形态', result, formatArchFormResult(result));
  } catch (error) {
    console.error('❌ 模块11执行失败:', error);
    showTemporaryMessage('执行失败', 2000);
  }
}

// 清除所有分析
function clearAllAnalysis() {
  // 清除坐标轴
  clearCoordAxis();
  
  // 清除Spee曲线
  clearSpeeCurveVisualization();
  
  // 清除中线可视化
  clearMidlineVisualization();
  
  // 清除结果面板
  clearModuleResults();
  
  showTemporaryMessage('所有分析已清除', 2000);
}

// === 牙列中线3D可视化 ===

async function displayMidlineVisualization(result, frame) {
  if (!result || (!result.upper && !result.lower)) {
    console.log('❌ 无中线数据可视化');
    return;
  }

  try {
    // 清除之前的中线可视化
    const existingMidline = mainGroup.getObjectByName('MidlineVisualization');
    if (existingMidline) {
      mainGroup.remove(existingMidline);
    }

    const midlineGroup = new THREE.Group();
    midlineGroup.name = 'MidlineVisualization';

    // 创建矢状面参考线（Y=0平面上的一条线）
    const origin = new THREE.Vector3(...frame.origin);
    const zAxis = new THREE.Vector3(...frame.ez).multiplyScalar(30);
    const sagittalLineGeometry = new THREE.BufferGeometry().setFromPoints([
      origin.clone().sub(zAxis),
      origin.clone().add(zAxis)
    ]);
    const sagittalLineMaterial = new THREE.LineBasicMaterial({ 
      color: 0x666666, 
      linewidth: 2,
      transparent: true,
      opacity: 0.6
    });
    const sagittalLine = new THREE.Line(sagittalLineGeometry, sagittalLineMaterial);
    midlineGroup.add(sagittalLine);

    // 上颌中线
    if (result.upper?.point) {
      const upperPoint = new THREE.Vector3(...result.upper.point);
      const upperColor = Math.abs(result.upper.y_mm) <= 0.5 ? 0x22c55e : 
                        Math.abs(result.upper.y_mm) <= 2.0 ? 0xf59e0b : 0xef4444;
      
      // 中线点标记
      const upperSphereGeometry = new THREE.SphereGeometry(1.5, 16, 12);
      const upperSphereMaterial = new THREE.MeshStandardMaterial({ 
        color: upperColor,
        metalness: 0.1,
        roughness: 0.4
      });
      const upperSphere = new THREE.Mesh(upperSphereGeometry, upperSphereMaterial);
      upperSphere.position.copy(upperPoint);
      midlineGroup.add(upperSphere);

      // 从中线点到矢状面的偏移线（投影到Y=0的矢状面）
      const { projectToFrame } = await import('./metrics/utils.js');
      const proj = projectToFrame(result.upper.point, frame);
      const projectedPoint = new THREE.Vector3(
        frame.origin[0] + frame.ex[0] * proj.x + frame.ez[0] * proj.z,
        frame.origin[1] + frame.ex[1] * proj.x + frame.ez[1] * proj.z,
        frame.origin[2] + frame.ex[2] * proj.x + frame.ez[2] * proj.z
      );
      
      const offsetLineGeometry = new THREE.BufferGeometry().setFromPoints([
        upperPoint, projectedPoint
      ]);
      const offsetLineMaterial = new THREE.LineDashedMaterial({ 
        color: upperColor, 
        linewidth: 2,
        dashSize: 1,
        gapSize: 0.5
      });
      const offsetLine = new THREE.Line(offsetLineGeometry, offsetLineMaterial);
      offsetLine.computeLineDistances();
      midlineGroup.add(offsetLine);

      // 标签
      const upperLabel = createLabel(`上中线: ${result.upper.y_mm}mm`, upperPoint.clone().add(new THREE.Vector3(0, 5, 0)), upperColor);
      midlineGroup.add(upperLabel);
    }

    // 下颌中线
    if (result.lower?.point) {
      const lowerPoint = new THREE.Vector3(...result.lower.point);
      const lowerColor = Math.abs(result.lower.y_mm) <= 0.5 ? 0x22c55e : 
                        Math.abs(result.lower.y_mm) <= 2.0 ? 0xf59e0b : 0xef4444;
      
      // 中线点标记
      const lowerSphereGeometry = new THREE.SphereGeometry(1.5, 16, 12);
      const lowerSphereMaterial = new THREE.MeshStandardMaterial({ 
        color: lowerColor,
        metalness: 0.1,
        roughness: 0.4
      });
      const lowerSphere = new THREE.Mesh(lowerSphereGeometry, lowerSphereMaterial);
      lowerSphere.position.copy(lowerPoint);
      midlineGroup.add(lowerSphere);

      // 从中线点到矢状面的偏移线（投影到Y=0的矢状面）
      const { projectToFrame } = await import('./metrics/utils.js');
      const proj = projectToFrame(result.lower.point, frame);
      const projectedPoint = new THREE.Vector3(
        frame.origin[0] + frame.ex[0] * proj.x + frame.ez[0] * proj.z,
        frame.origin[1] + frame.ex[1] * proj.x + frame.ez[1] * proj.z,
        frame.origin[2] + frame.ex[2] * proj.x + frame.ez[2] * proj.z
      );
      
      const offsetLineGeometry = new THREE.BufferGeometry().setFromPoints([
        lowerPoint, projectedPoint
      ]);
      const offsetLineMaterial = new THREE.LineDashedMaterial({ 
        color: lowerColor, 
        linewidth: 2,
        dashSize: 1,
        gapSize: 0.5
      });
      const offsetLine = new THREE.Line(offsetLineGeometry, offsetLineMaterial);
      offsetLine.computeLineDistances();
      midlineGroup.add(offsetLine);

      // 标签
      const lowerLabel = createLabel(`下中线: ${result.lower.y_mm}mm`, lowerPoint.clone().add(new THREE.Vector3(0, -5, 0)), lowerColor);
      midlineGroup.add(lowerLabel);
    }

    // 连接上下中线
    if (result.upper?.point && result.lower?.point) {
      const upperPoint = new THREE.Vector3(...result.upper.point);
      const lowerPoint = new THREE.Vector3(...result.lower.point);
      
      const connectionGeometry = new THREE.BufferGeometry().setFromPoints([upperPoint, lowerPoint]);
      const connectionColor = result.agreement === '一致' ? 0x22c55e : 0xef4444;
      const connectionMaterial = new THREE.LineBasicMaterial({ 
        color: connectionColor,
        linewidth: 3,
        transparent: true,
        opacity: 0.7
      });
      const connectionLine = new THREE.Line(connectionGeometry, connectionMaterial);
      midlineGroup.add(connectionLine);

      // 中点标签显示一致性
      const midPoint = upperPoint.clone().add(lowerPoint).multiplyScalar(0.5);
      const alignmentLabel = createLabel(
        `${result.agreement} (Δ${Math.abs(result.diff_upper_lower_mm)}mm)`, 
        midPoint.clone().add(new THREE.Vector3(8, 0, 0)), 
        connectionColor
      );
      midlineGroup.add(alignmentLabel);
    }

    mainGroup.add(midlineGroup);
    console.log('✅ 牙列中线3D可视化已显示');

    // 添加后重新居中
    centerMainGroup();

  } catch (error) {
    console.error('❌ 牙列中线可视化失败:', error);
  }
}

// 清除牙列中线可视化
function clearMidlineVisualization() {
  const existingMidline = mainGroup.getObjectByName('MidlineVisualization');
  if (existingMidline) {
    mainGroup.remove(existingMidline);
    console.log('✅ 牙列中线可视化已清除');
    centerMainGroup();
  }
}

// === 模块3: Bolton比例分析 ===
async function executeBoltonAnalysis() {
  if (!landmarks || landmarks.length === 0) {
    alert('请先加载JSON标记数据');
    return;
  }

  try {
    console.log('📏 执行Bolton比例分析...');
    const { computeBolton } = await import('./metrics/calc.js');
    
    const landmarkData = landmarks.map(lm => ({
      name: lm.name,
      position_model: lm.position_model
    }));
    
    const result = computeBolton(landmarkData, {
      use_plane: !!window.currentOcclusalFrame,
      frame: window.currentOcclusalFrame
    });
    
    console.log('✅ Bolton比例分析完成:');
    console.log('前牙比例:', result.anterior);
    console.log('全牙比例:', result.overall);
    
    const anteriorStatus = result.anterior.ratio_pct ? 
      (Math.abs(result.anterior.ratio_pct - result.anterior.target_pct) < 2 ? '✅ 正常' : '⚠️ 异常') : '❌ 无数据';
    const overallStatus = result.overall.ratio_pct ? 
      (Math.abs(result.overall.ratio_pct - result.overall.target_pct) < 2 ? '✅ 正常' : '⚠️ 异常') : '❌ 无数据';
    
    showAnalysisResult('Bolton比例分析', {
      '前牙比例': result.anterior.ratio_pct ? `${result.anterior.ratio_pct}%` : '无数据',
      '前牙状态': anteriorStatus,
      '前牙缺失': result.anterior.missing.length ? result.anterior.missing.join(',') : '无',
      '全牙比例': result.overall.ratio_pct ? `${result.overall.ratio_pct}%` : '无数据',
      '全牙状态': overallStatus,
      '全牙缺失': result.overall.missing.length ? result.overall.missing.join(',') : '无'
    });
    
  } catch (error) {
    console.error('❌ Bolton比例分析错误:', error);
    alert(`分析错误: ${error.message}`);
  }
}

// === 综合分析 ===
async function executeComprehensiveAnalysis() {
  console.log('🔬 执行综合分析...');
  
  // 依次执行所有分析
  await executeOcclusalFrameAnalysis();
  await new Promise(resolve => setTimeout(resolve, 500)); // 短暂延迟
  
  await executeSpeeCurveAnalysis();
  await new Promise(resolve => setTimeout(resolve, 500));
  
  await executeBoltonAnalysis();
  
  console.log('✅ 综合分析完成');
}



function showAnalysisResult(title, data) {
  // 清除之前的结果面板
  const existingPanels = document.querySelectorAll('.analysis-result-panel');
  existingPanels.forEach(panel => panel.remove());
  
  // 创建新的结果显示面板
  const resultPanel = document.createElement('div');
  resultPanel.className = 'analysis-result-panel';
  resultPanel.style.cssText = `
    position: fixed;
    top: 120px;
    right: 20px;
    width: 320px;
    max-height: 70vh;
    overflow-y: auto;
    background: rgba(15, 23, 42, 0.95);
    color: #e2e8f0;
    border: 1px solid rgba(148, 163, 184, 0.4);
    border-radius: 10px;
    padding: 20px;
    font-size: 13px;
    z-index: 1002;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(10px);
    animation: slideIn 0.3s ease-out;
  `;

  // 添加动画
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    .analysis-result-panel::-webkit-scrollbar {
      width: 6px;
    }
    .analysis-result-panel::-webkit-scrollbar-track {
      background: rgba(148, 163, 184, 0.1);
      border-radius: 3px;
    }
    .analysis-result-panel::-webkit-scrollbar-thumb {
      background: rgba(148, 163, 184, 0.3);
      border-radius: 3px;
    }
  `;
  document.head.appendChild(style);

  // 获取合适的图标
  const getIcon = (title) => {
    if (title.includes('坐标系')) return '📊';
    if (title.includes('Spee')) return '📈';
    if (title.includes('Bolton')) return '📏';
    return '🔬';
  };

  let html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px solid rgba(96, 165, 250, 0.3);">
      <h3 style="margin: 0; color: #60a5fa; font-size: 16px;">${getIcon(title)} ${title}</h3>
      <button onclick="this.parentElement.parentElement.remove()" 
              style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 20px; padding: 0; width: 24px; height: 24px; border-radius: 50%; transition: all 0.2s;" 
              onmouseover="this.style.background='rgba(239, 68, 68, 0.2)'; this.style.color='#ef4444';" 
              onmouseout="this.style.background='none'; this.style.color='#94a3b8';">×</button>
    </div>
  `;

  for (const [key, value] of Object.entries(data)) {
    // 根据值的内容选择颜色
    let valueColor = '#86efac'; // 默认绿色
    if (String(value).includes('❌') || String(value).includes('异常') || String(value).includes('失败')) {
      valueColor = '#f87171'; // 红色
    } else if (String(value).includes('⚠️') || String(value).includes('回退') || String(value).includes('警告')) {
      valueColor = '#fbbf24'; // 黄色
    } else if (String(value).includes('✅') || String(value).includes('成功') || String(value).includes('正常')) {
      valueColor = '#34d399'; // 绿色
    }

    html += `
      <div style="display: flex; justify-content: space-between; align-items: center; margin: 10px 0; padding: 8px 0; border-bottom: 1px solid rgba(148, 163, 184, 0.08);">
        <span style="color: #cbd5e1; font-weight: 500;">${key}:</span>
        <span style="font-weight: 600; color: ${valueColor}; text-align: right;">${value}</span>
      </div>
    `;
  }

  // 添加时间戳
  const now = new Date().toLocaleTimeString();
  html += `
    <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(148, 163, 184, 0.2); text-align: center;">
      <small style="color: #94a3b8;">分析时间: ${now}</small>
    </div>
  `;

  resultPanel.innerHTML = html;
  document.body.appendChild(resultPanel);

  // 3秒后自动淡出提示
  setTimeout(() => {
    if (resultPanel.parentNode) {
      resultPanel.style.transition = 'opacity 0.5s ease-out';
      resultPanel.style.opacity = '0.8';
    }
  }, 3000);
}

// 自动测试所有案例
async function autoTestAllCases() {
  const cases = ['1_L', '1_U', '2_L', '2_U'];
  
  for (const caseId of cases) {
    console.log(`\n🧪 === 自动测试案例 ${caseId} ===`);
    
    try {
      // 清除之前的数据
      landmarks.length = 0;
      if (stlMesh) {
        scene.remove(stlMesh);
        stlMesh = null;
      }
      clearLandmarkSpheres();
      
      // 加载STL
      const stlResponse = await fetch(`./assets/${caseId}.stl`);
      const stlArrayBuffer = await stlResponse.arrayBuffer();
      const stlGeometry = stlLoader.parse(stlArrayBuffer);
      stlMesh = new THREE.Mesh(stlGeometry, materialSTL);
      mainGroup.add(stlMesh);
      
      // 加载JSON
      const jsonResponse = await fetch(`./assets/${caseId}.json`);
      const json = await jsonResponse.json();
      loadLandmarksJSON(json);
      
      console.log(`✅ ${caseId}: 加载了 ${landmarks.length} 个标记点`);
      
      // 测试坐标系构建
      const coordResult = await buildCoordSystemForCurrentLandmarks();
      if (coordResult) {
        console.log(`✅ ${caseId}: 坐标系构建成功`);
      } else {
        console.log(`❌ ${caseId}: 坐标系构建失败`);
      }
      
      // 等待一下
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error(`❌ ${caseId}: 测试失败:`, error);
    }
  }
  
  console.log('\n🏁 自动测试完成');
}

if (typeof window !== 'undefined') {
  window.LandmarkDemo = window.LandmarkDemo || {};
  window.LandmarkDemo.loadCase = loadDemoCase;
  window.LandmarkDemo.autoTestAllCases = autoTestAllCases;
  
  // 新的分析函数
  window.executeOcclusalFrameAnalysis = executeOcclusalFrameAnalysis;
  window.executeSpeeCurveAnalysis = executeSpeeCurveAnalysis;
  window.executeBoltonAnalysis = executeBoltonAnalysis;
  window.executeComprehensiveAnalysis = executeComprehensiveAnalysis;
  window.clearSpeeCurveVisualization = clearSpeeCurveVisualization;
  window.clearModuleResults = clearModuleResults;
}

