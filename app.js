// ========================================
// 転倒検知システム - Multi-Rule Detection
// ========================================

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusMain = document.getElementById('statusMain');
const startBtn = document.getElementById('startBtn');
const alertBtn = document.getElementById('alertBtn');
const resetBtn = document.getElementById('resetBtn');
const triggerAlert = document.getElementById('triggerAlert');

// ルール名
const ruleNames = {
  rule1: '体軸水平化',
  rule2: '頭部急落',
  rule3: '床面接近',
  rule4: '比率変化',
  rule5: '重心急落',
  rule6: '転倒後静止',
};

let triggerAlertTimeout = null;

// デバッグ要素
const dbg = {
  rule1: document.getElementById('dbgRule1'),
  rule2: document.getElementById('dbgRule2'),
  rule3: document.getElementById('dbgRule3'),
  rule4: document.getElementById('dbgRule4'),
  rule5: document.getElementById('dbgRule5'),
  rule6: document.getElementById('dbgRule6'),
};

// ルールチェックボックス
const ruleCheckboxes = {
  rule1: document.getElementById('rule1'),
  rule2: document.getElementById('rule2'),
  rule3: document.getElementById('rule3'),
  rule4: document.getElementById('rule4'),
  rule5: document.getElementById('rule5'),
  rule6: document.getElementById('rule6'),
};

// ルールステータス表示
const ruleStatus = {
  rule1: document.getElementById('rule1Status'),
  rule2: document.getElementById('rule2Status'),
  rule3: document.getElementById('rule3Status'),
  rule4: document.getElementById('rule4Status'),
  rule5: document.getElementById('rule5Status'),
  rule6: document.getElementById('rule6Status'),
};

// しきい値スライダー
const thresholds = {
  angle: document.getElementById('thresholdAngle'),
  headDrop: document.getElementById('thresholdHeadDrop'),
  floor: document.getElementById('thresholdFloor'),
  ratio: document.getElementById('thresholdRatio'),
  centerDrop: document.getElementById('thresholdCenterDrop'),
  lying: document.getElementById('thresholdLying'),
};

// 状態管理
const state = {
  isRunning: false,
  alertEnabled: true,
  currentStatus: 'unknown',

  history: [],
  maxHistoryLength: 30,

  fallDetectedTime: null,
  lyingStartTime: null,
  stillStartTime: null,

  // しきい値
  th: {
    angle: 55,
    headDrop: 0.20,
    floor: 0.55,
    ratio: 0.7,
    centerDrop: 0.15,
    lying: 10,
  },

  // 論理演算モード
  logicMode: 'count', // 'or', 'and', 'count'
};

// アラート音
let audioContext = null;

function playAlertSound() {
  if (!state.alertEnabled) return;
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.frequency.value = 880;
  oscillator.type = 'square';
  gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
  oscillator.start(audioContext.currentTime);
  oscillator.stop(audioContext.currentTime + 0.3);
}

// MediaPipe Pose
let pose = null;
let camera = null;

function initPose() {
  pose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
  });

  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: true,
    smoothSegmentation: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  pose.onResults(onPoseResults);
}

async function startCamera() {
  if (state.isRunning) return;

  try {
    // 画面サイズに合わせる
    const container = document.querySelector('.video-container');
    const w = container.clientWidth;
    const h = container.clientHeight;

    canvas.width = w;
    canvas.height = h;

    camera = new Camera(video, {
      onFrame: async () => {
        if (pose) await pose.send({ image: video });
      },
      width: w,
      height: h,
      facingMode: 'user',
    });

    await camera.start();
    state.isRunning = true;
    startBtn.textContent = 'カメラ停止';
    startBtn.classList.remove('btn-primary');
    startBtn.classList.add('btn-danger');
  } catch (error) {
    console.error('カメラ起動エラー:', error);
    alert('カメラを起動できませんでした: ' + error.message);
  }
}

function stopCamera() {
  if (camera) camera.stop();
  state.isRunning = false;
  startBtn.textContent = 'カメラ開始';
  startBtn.classList.add('btn-primary');
  startBtn.classList.remove('btn-danger');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateStatus('unknown', '停止中');
}

function onPoseResults(results) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (results.segmentationMask) {
    drawSilhouetteMirrored(results.segmentationMask);
  }

  if (!results.poseLandmarks) {
    updateStatus('unknown', '人物未検出');
    clearRuleStatus();
    return;
  }

  // ランドマーク鏡像反転
  const landmarks = results.poseLandmarks.map(p => ({
    x: 1 - p.x,
    y: p.y,
    z: p.z,
    visibility: p.visibility,
  }));

  drawBoundingBox(landmarks);

  const features = extractFeatures(landmarks);
  if (!features) {
    updateStatus('unknown', '特徴抽出失敗');
    return;
  }

  state.history.push({ ...features, timestamp: Date.now() });
  if (state.history.length > state.maxHistoryLength) {
    state.history.shift();
  }

  // ルール評価
  const ruleResults = evaluateRules(features);
  updateRuleStatus(ruleResults);

  // 転倒判定
  detectState(features, ruleResults);

  // デバッグ表示
  updateDebugInfo(features, ruleResults);
}

function drawSilhouetteMirrored(mask) {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d');

  tempCtx.save();
  tempCtx.scale(-1, 1);
  tempCtx.translate(-canvas.width, 0);
  tempCtx.drawImage(mask, 0, 0, canvas.width, canvas.height);
  tempCtx.restore();

  const maskData = tempCtx.getImageData(0, 0, canvas.width, canvas.height);
  const data = maskData.data;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 100) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 230;
    } else {
      data[i + 3] = 0;
    }
  }

  ctx.putImageData(maskData, 0, 0);
}

function drawBoundingBox(landmarks) {
  const visiblePoints = landmarks.filter(p => p.visibility > 0.5);
  if (visiblePoints.length < 5) return;

  const xs = visiblePoints.map(p => p.x * canvas.width);
  const ys = visiblePoints.map(p => p.y * canvas.height);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 2;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  ctx.fillStyle = '#ff0000';
  ctx.beginPath();
  ctx.arc(centerX, centerY, 8, 0, 2 * Math.PI);
  ctx.fill();
}

function extractFeatures(landmarks) {
  const nose = landmarks[0];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];

  if (leftShoulder.visibility < 0.3 || rightShoulder.visibility < 0.3 ||
      leftHip.visibility < 0.3 || rightHip.visibility < 0.3) {
    return null;
  }

  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
  const hipMidX = (leftHip.x + rightHip.x) / 2;
  const hipMidY = (leftHip.y + rightHip.y) / 2;

  // 体軸角度
  const dx = shoulderMidX - hipMidX;
  const dy = shoulderMidY - hipMidY;
  const bodyAngle = Math.abs(Math.atan2(dx, -dy) * (180 / Math.PI));

  // 頭の高さ
  const headHeight = nose.y;

  // 重心Y
  const visiblePoints = landmarks.filter(p => p.visibility > 0.5);
  const centerY = visiblePoints.reduce((sum, p) => sum + p.y, 0) / visiblePoints.length;

  // アスペクト比
  const xs = visiblePoints.map(p => p.x);
  const ys = visiblePoints.map(p => p.y);
  const bboxWidth = Math.max(...xs) - Math.min(...xs);
  const bboxHeight = Math.max(...ys) - Math.min(...ys);
  const aspectRatio = bboxHeight / bboxWidth;

  // 移動量
  let movement = 0;
  if (state.history.length > 0) {
    const prev = state.history[state.history.length - 1];
    movement = Math.sqrt(
      Math.pow(shoulderMidX - prev.shoulderMidX, 2) +
      Math.pow(shoulderMidY - prev.shoulderMidY, 2)
    );
  }

  return {
    bodyAngle,
    headHeight,
    centerY,
    aspectRatio,
    movement,
    shoulderMidX,
    shoulderMidY,
  };
}

// ====== ルール評価 ======
function evaluateRules(features) {
  const results = {
    rule1: false, rule2: false, rule3: false,
    rule4: false, rule5: false, rule6: false,
    // 数値も保存
    values: {}
  };

  const { bodyAngle, headHeight, centerY, aspectRatio, movement } = features;

  // ルール1: 体軸水平化
  results.values.v1 = bodyAngle;
  results.rule1 = bodyAngle > state.th.angle;

  // ルール3: 頭部床面接近
  results.values.v3 = headHeight;
  results.rule3 = headHeight > state.th.floor;

  // 過去との比較（8フレーム前）
  let headDrop = 0, ratioChange = 0, centerDrop = 0;
  if (state.history.length >= 8) {
    const old = state.history[state.history.length - 8];

    // ルール2: 頭部急落
    headDrop = headHeight - old.headHeight;
    results.rule2 = headDrop > state.th.headDrop;

    // ルール4: アスペクト比変化
    ratioChange = old.aspectRatio - aspectRatio;
    results.rule4 = ratioChange > state.th.ratio;

    // ルール5: 重心急落
    centerDrop = centerY - old.centerY;
    results.rule5 = centerDrop > state.th.centerDrop;
  }
  results.values.v2 = headDrop;
  results.values.v4 = ratioChange;
  results.values.v5 = centerDrop;

  // ルール6: 転倒後静止
  const isStill = movement < 0.008;
  if (isStill) {
    if (!state.stillStartTime) state.stillStartTime = Date.now();
  } else {
    state.stillStartTime = null;
  }
  const stillDuration = state.stillStartTime ? (Date.now() - state.stillStartTime) / 1000 : 0;
  results.values.v6 = stillDuration;
  results.rule6 = stillDuration > 1.0;

  return results;
}

// ルールステータス表示更新
function updateRuleStatus(results) {
  for (let i = 1; i <= 6; i++) {
    const key = `rule${i}`;
    const isEnabled = ruleCheckboxes[key].checked;
    const isTriggered = results[key];

    if (isEnabled && isTriggered) {
      ruleStatus[key].classList.add('active');
      ruleStatus[key].textContent = '!';
    } else {
      ruleStatus[key].classList.remove('active');
      ruleStatus[key].textContent = '';
    }
  }
}

function clearRuleStatus() {
  for (let i = 1; i <= 6; i++) {
    ruleStatus[`rule${i}`].classList.remove('active');
    ruleStatus[`rule${i}`].textContent = '';
  }
}

// 転倒判定
function detectState(features, ruleResults) {
  const now = Date.now();
  const { bodyAngle, movement } = features;

  // 有効なルールのトリガー数を数える
  let triggeredCount = 0;
  const triggeredRules = [];

  for (let i = 1; i <= 6; i++) {
    const key = `rule${i}`;
    if (ruleCheckboxes[key].checked && ruleResults[key]) {
      triggeredCount++;
      triggeredRules.push(i);
    }
  }

  // 有効なルール数
  let enabledCount = 0;
  for (let i = 1; i <= 6; i++) {
    if (ruleCheckboxes[`rule${i}`].checked) enabledCount++;
  }

  // 論理演算による転倒判定
  let isFalling = false;

  if (state.logicMode === 'or') {
    isFalling = triggeredCount >= 1;
  } else if (state.logicMode === 'and') {
    isFalling = triggeredCount === enabledCount && enabledCount > 0;
  } else if (state.logicMode === 'count') {
    isFalling = triggeredCount >= 2;
  }

  // 転倒検知
  if (isFalling && state.currentStatus !== 'fall') {
    state.fallDetectedTime = now;
    state.currentStatus = 'fall';
    updateStatus('fall', '⚠️ 転倒検知！');
    playAlertSound();
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200, 100, 200]);
    }
    // トリガーされたルールを中央に表示
    showTriggerAlert(triggeredRules.map(i => `rule${i}`));
    return;
  }

  // 臥床検知
  const isHorizontal = bodyAngle > state.th.angle;
  const stillDuration = state.stillStartTime ? (now - state.stillStartTime) / 1000 : 0;

  if (isHorizontal && stillDuration > 2) {
    if (!state.lyingStartTime) state.lyingStartTime = now;

    const lyingDuration = (now - state.lyingStartTime) / 1000;

    if (lyingDuration >= state.th.lying && state.currentStatus !== 'lying') {
      state.currentStatus = 'lying';
      updateStatus('lying', `⚠️ 長時間臥床 (${Math.floor(lyingDuration)}秒)`);
      playAlertSound();
      return;
    }

    if (state.currentStatus === 'lying') {
      updateStatus('lying', `⚠️ 長時間臥床 (${Math.floor(lyingDuration)}秒)`);
      return;
    }
  } else if (!isHorizontal) {
    state.lyingStartTime = null;
  }

  // 転倒後の回復
  if (state.fallDetectedTime) {
    const timeSinceFall = (now - state.fallDetectedTime) / 1000;

    if (timeSinceFall > 3 && !isHorizontal && bodyAngle < 40) {
      state.fallDetectedTime = null;
      state.currentStatus = 'standing';
      updateStatus('standing', '立位（回復）');
      return;
    }

    if (state.currentStatus === 'fall') {
      updateStatus('fall', `⚠️ 転倒検知！ (${Math.floor(timeSinceFall)}秒経過)`);
      return;
    }
  }

  // 通常状態
  const isMoving = movement > 0.008;

  if (!isHorizontal && bodyAngle < 45 && features.headHeight > 0.35 && !isMoving) {
    state.currentStatus = 'sitting';
    updateStatus('sitting', '座位');
    return;
  }

  if (isMoving) {
    state.currentStatus = 'moving';
    updateStatus('moving', '移動中');
    return;
  }

  if (!isHorizontal && bodyAngle < 40) {
    state.currentStatus = 'standing';
    updateStatus('standing', '立位');
    return;
  }

  if (isHorizontal) {
    state.currentStatus = 'lying';
    updateStatus('sitting', '臥位');
    return;
  }

  state.currentStatus = 'unknown';
  updateStatus('unknown', '判定中...');
}

function updateStatus(statusClass, text) {
  statusMain.className = `overlay-status status-${statusClass}`;
  statusMain.textContent = text;
}

// トリガーされたルールを画面中央に2秒表示
function showTriggerAlert(triggeredRuleKeys) {
  if (triggeredRuleKeys.length === 0) return;

  const names = triggeredRuleKeys.map(key => ruleNames[key]);
  triggerAlert.innerHTML = names.join('<br>');
  triggerAlert.classList.add('show');

  if (triggerAlertTimeout) {
    clearTimeout(triggerAlertTimeout);
  }

  triggerAlertTimeout = setTimeout(() => {
    triggerAlert.classList.remove('show');
  }, 2000);
}

function updateDebugInfo(features, ruleResults) {
  const v = ruleResults.values;
  const th = state.th;

  // ルール1: 体軸 現在値 > 閾値
  const r1 = `${v.v1.toFixed(0)}°>${th.angle}°`;
  dbg.rule1.textContent = r1;
  dbg.rule1.className = ruleResults.rule1 ? 'triggered-text' : '';

  // ルール2: 頭落下 現在値 > 閾値
  const r2 = `${v.v2.toFixed(2)}>${th.headDrop}`;
  dbg.rule2.textContent = r2;
  dbg.rule2.className = ruleResults.rule2 ? 'triggered-text' : '';

  // ルール3: 床接近 現在値 > 閾値
  const r3 = `${v.v3.toFixed(2)}>${th.floor}`;
  dbg.rule3.textContent = r3;
  dbg.rule3.className = ruleResults.rule3 ? 'triggered-text' : '';

  // ルール4: 比率変化 現在値 > 閾値
  const r4 = `${v.v4.toFixed(2)}>${th.ratio}`;
  dbg.rule4.textContent = r4;
  dbg.rule4.className = ruleResults.rule4 ? 'triggered-text' : '';

  // ルール5: 重心落下 現在値 > 閾値
  const r5 = `${v.v5.toFixed(2)}>${th.centerDrop}`;
  dbg.rule5.textContent = r5;
  dbg.rule5.className = ruleResults.rule5 ? 'triggered-text' : '';

  // ルール6: 静止時間 現在値 > 1秒
  const r6 = `${v.v6.toFixed(1)}s>1s`;
  dbg.rule6.textContent = r6;
  dbg.rule6.className = ruleResults.rule6 ? 'triggered-text' : '';
}

function resetState() {
  state.history = [];
  state.fallDetectedTime = null;
  state.lyingStartTime = null;
  state.stillStartTime = null;
  state.currentStatus = 'unknown';
  clearRuleStatus();
  updateStatus('unknown', 'リセット完了');
}

function updateThresholds() {
  state.th.angle = parseFloat(thresholds.angle.value);
  state.th.headDrop = parseFloat(thresholds.headDrop.value);
  state.th.floor = parseFloat(thresholds.floor.value);
  state.th.ratio = parseFloat(thresholds.ratio.value);
  state.th.centerDrop = parseFloat(thresholds.centerDrop.value);
  state.th.lying = parseFloat(thresholds.lying.value);

  document.getElementById('thresholdAngleVal').textContent = state.th.angle + '°';
  document.getElementById('thresholdHeadDropVal').textContent = state.th.headDrop.toFixed(2);
  document.getElementById('thresholdFloorVal').textContent = state.th.floor.toFixed(2);
  document.getElementById('thresholdRatioVal').textContent = state.th.ratio.toFixed(1);
  document.getElementById('thresholdCenterDropVal').textContent = state.th.centerDrop.toFixed(2);
  document.getElementById('thresholdLyingVal').textContent = state.th.lying;
}

// イベントリスナー
startBtn.addEventListener('click', () => {
  if (state.isRunning) stopCamera();
  else startCamera();
});

alertBtn.addEventListener('click', () => {
  state.alertEnabled = !state.alertEnabled;
  alertBtn.textContent = state.alertEnabled ? '🔊 ON' : '🔇 OFF';
  alertBtn.classList.toggle('off', !state.alertEnabled);
});

resetBtn.addEventListener('click', resetState);

// しきい値スライダー
Object.values(thresholds).forEach(slider => {
  slider.addEventListener('input', updateThresholds);
});

// 論理演算モード
document.querySelectorAll('input[name="logic"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    state.logicMode = e.target.value;
  });
});

// 初期化
initPose();
updateThresholds();

console.log('転倒検知システム（マルチルール版）初期化完了');
