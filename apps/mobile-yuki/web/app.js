import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const sceneHost = document.querySelector('#scene');
const status = document.querySelector('#status');
const cameraVideo = document.querySelector('#camera');
const liveArButton = document.querySelector('#liveArButton');
const motionButton = document.querySelector('#motionButton');
const toast = document.querySelector('#toast');
const connectionChip = document.querySelector('#connection');

async function detectSpatialArSupport() {
  let immersiveAr = false;
  let detail = 'navigator.xr unavailable';
  try {
    if (navigator.xr?.isSessionSupported) {
      immersiveAr = await navigator.xr.isSessionSupported('immersive-ar');
      detail = immersiveAr ? 'immersive-ar supported' : 'immersive-ar unsupported';
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  connectionChip.textContent = immersiveAr ? 'WEBXR AR READY' : 'CAMERA OVERLAY';
  fetch('./diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ immersiveAr, detail, userAgent: navigator.userAgent }),
  }).catch(() => {});
}

detectSpatialArSupport();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 0.3, 3.2);
camera.lookAt(0, 0.25, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.setAnimationLoop(render);
sceneHost.appendChild(renderer.domElement);

let cameraTexture = null;

scene.add(new THREE.HemisphereLight(0xcbd5ff, 0x24172e, 2.6));
const key = new THREE.DirectionalLight(0xffffff, 4.2);
key.position.set(2.5, 4, 3);
scene.add(key);
const rim = new THREE.DirectionalLight(0x805dff, 3.4);
rim.position.set(-3, 2, -2);
scene.add(rim);

const stage = new THREE.Group();
const stageBaseY = -0.52;
stage.position.set(0.28, stageBaseY, 0);
stage.scale.setScalar(0.84);
scene.add(stage);

const stateOrder = ['idle', 'listening', 'thinking', 'speaking'];
const stateLabels = { idle: 'Idle', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };
let stateIndex = 0;
let motionState = stateOrder[stateIndex];
let yuki = null;
let rig = null;
let faceMesh = null;
let cameraStream = null;
let rotationTarget = 0;
let scaleTarget = 0.84;

const boneNames = {
  hips: 'J_Bip_C_Hips', spine: 'J_Bip_C_Spine', chest: 'J_Bip_C_Chest', upperChest: 'J_Bip_C_UpperChest',
  neck: 'J_Bip_C_Neck', head: 'J_Bip_C_Head',
  leftShoulder: 'J_Bip_L_Shoulder', leftUpperArm: 'J_Bip_L_UpperArm', leftLowerArm: 'J_Bip_L_LowerArm', leftHand: 'J_Bip_L_Hand',
  rightShoulder: 'J_Bip_R_Shoulder', rightUpperArm: 'J_Bip_R_UpperArm', rightLowerArm: 'J_Bip_R_LowerArm', rightHand: 'J_Bip_R_Hand',
};

function createRig(root) {
  const result = { rest: new Map() };
  for (const [keyName, nodeName] of Object.entries(boneNames)) {
    const bone = root.getObjectByName(nodeName);
    if (bone) {
      result[keyName] = bone;
      result.rest.set(bone, bone.rotation.clone());
    }
  }
  return result;
}

function poseBone(targetRig, bone, x = 0, y = 0, z = 0) {
  if (!bone) return;
  const rest = targetRig.rest.get(bone);
  if (rest) bone.rotation.set(rest.x + x, rest.y + y, rest.z + z);
}

function resetRig(targetRig) {
  for (const [bone, rest] of targetRig.rest.entries()) bone.rotation.copy(rest);
}

function applyRigPose(targetRig, state, elapsed) {
  resetRig(targetRig);
  const breath = Math.sin(elapsed * 1.8) * 0.018;
  const nod = Math.sin(elapsed * 2.2) * 0.05;
  const gesture = Math.sin(elapsed * 3.2) * 0.22;
  const sway = Math.sin(elapsed * 1.2) * 0.03;
  const handPulse = Math.sin(elapsed * 4.1) * 0.14;

  poseBone(targetRig, targetRig.hips, 0, sway * 0.25, 0);
  poseBone(targetRig, targetRig.spine, breath * 0.4, sway * 0.16, 0);
  poseBone(targetRig, targetRig.chest, breath, sway * 0.35, 0);
  poseBone(targetRig, targetRig.upperChest, breath * 1.15, sway * 0.5, 0);

  if (state === 'listening') {
    poseBone(targetRig, targetRig.neck, -0.04, 0.1, -0.03);
    poseBone(targetRig, targetRig.head, -0.08, 0.16, -0.08);
    poseBone(targetRig, targetRig.leftShoulder, 0.08, 0.08, -0.18);
    poseBone(targetRig, targetRig.leftUpperArm, -0.42, 0.18, -0.88);
    poseBone(targetRig, targetRig.leftLowerArm, -0.64, 0.06, -0.22);
    poseBone(targetRig, targetRig.rightShoulder, 0.06, -0.06, 0.2);
    poseBone(targetRig, targetRig.rightUpperArm, 0.02, -0.12, 0.98);
    poseBone(targetRig, targetRig.rightLowerArm, -0.14, 0, 0.18);
  } else if (state === 'thinking') {
    poseBone(targetRig, targetRig.neck, -0.12, -0.04, 0.02);
    poseBone(targetRig, targetRig.head, -0.18, -0.08, 0.04);
    poseBone(targetRig, targetRig.rightShoulder, 0.14, -0.18, 0.28);
    poseBone(targetRig, targetRig.rightUpperArm, -0.8, -0.2, 0.68);
    poseBone(targetRig, targetRig.rightLowerArm, -1.05, 0.2, 0.28);
    poseBone(targetRig, targetRig.leftShoulder, 0.04, 0.04, -0.18);
    poseBone(targetRig, targetRig.leftUpperArm, -0.14, 0.1, -0.98);
    poseBone(targetRig, targetRig.leftLowerArm, -0.22, 0, -0.18);
  } else if (state === 'speaking') {
    poseBone(targetRig, targetRig.neck, nod * 0.45, gesture * 0.12, 0);
    poseBone(targetRig, targetRig.head, nod, gesture * 0.18, 0);
    poseBone(targetRig, targetRig.leftShoulder, 0.08 + handPulse * 0.2, 0.1, -0.14);
    poseBone(targetRig, targetRig.leftUpperArm, -0.42 + gesture * 0.3, 0.18, -0.72);
    poseBone(targetRig, targetRig.leftLowerArm, -0.56 + handPulse * 0.28, 0.1, -0.14);
    poseBone(targetRig, targetRig.rightShoulder, 0.06 - handPulse * 0.18, -0.08, 0.14);
    poseBone(targetRig, targetRig.rightUpperArm, -0.34 - gesture * 0.26, -0.16, 0.72);
    poseBone(targetRig, targetRig.rightLowerArm, -0.48 - handPulse * 0.24, -0.08, 0.14);
  } else {
    poseBone(targetRig, targetRig.neck, 0, 0.02, 0);
    poseBone(targetRig, targetRig.head, breath * 0.6, 0.04, 0);
    poseBone(targetRig, targetRig.leftShoulder, 0.02, 0.02, -0.12);
    poseBone(targetRig, targetRig.leftUpperArm, -0.12, 0.04, -1.02);
    poseBone(targetRig, targetRig.leftLowerArm, -0.12, 0, -0.12);
    poseBone(targetRig, targetRig.rightShoulder, 0.02, -0.02, 0.12);
    poseBone(targetRig, targetRig.rightUpperArm, -0.12, -0.04, 1.02);
    poseBone(targetRig, targetRig.rightLowerArm, -0.12, 0, 0.12);
  }
}

function setMorph(name, value) {
  if (!faceMesh?.morphTargetDictionary || !faceMesh.morphTargetInfluences) return;
  const index = faceMesh.morphTargetDictionary[name];
  if (index !== undefined) faceMesh.morphTargetInfluences[index] = value;
}

function updateFace(elapsed, state) {
  if (!faceMesh) return;
  const blinkPhase = elapsed % 4.4;
  const blink = blinkPhase < 0.18 ? Math.sin((blinkPhase / 0.18) * Math.PI) : 0;
  setMorph('Fcl_EYE_Close', blink);
  setMorph('Fcl_ALL_Joy', state === 'listening' ? 0.12 : state === 'speaking' ? 0.16 : 0.04);
  setMorph('Fcl_ALL_Surprised', state === 'listening' ? 0.08 : 0);
  const talk = state === 'speaking' ? 0.18 + Math.abs(Math.sin(elapsed * 7.5)) * 0.42 : 0;
  setMorph('Fcl_MTH_A', talk);
  setMorph('Fcl_MTH_I', state === 'speaking' ? Math.abs(Math.sin(elapsed * 5.4 + 1.1)) * 0.18 : 0);
}

new GLTFLoader().load('./models/Yuki.glb', (gltf) => {
  yuki = gltf.scene;
  const box = new THREE.Box3().setFromObject(yuki);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = 1.82 / Math.max(size.y, 0.001);
  yuki.scale.setScalar(scale);
  yuki.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  yuki.traverse((node) => {
    if (node.isMesh) {
      node.frustumCulled = false;
      node.material.side = THREE.DoubleSide;
      if (node.morphTargetDictionary?.Fcl_EYE_Close !== undefined) faceMesh = node;
    }
  });
  rig = createRig(yuki);
  stage.add(yuki);
  status.textContent = 'Yuki is animated and ready. Start the camera overlay.';
  showToast('Animated Yuki is ready');
}, undefined, (error) => {
  console.error(error);
  status.textContent = 'Yuki’s model could not load. Refresh to try again.';
});

const clock = new THREE.Clock();
let elapsed = 0;
function render() {
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  stage.rotation.y += (rotationTarget - stage.rotation.y) * 0.09;
  const scale = THREE.MathUtils.lerp(stage.scale.x, scaleTarget, 0.12);
  stage.scale.setScalar(scale);
  stage.position.y = stageBaseY + Math.sin(elapsed * 1.7) * (motionState === 'speaking' ? 0.012 : 0.006);
  if (rig) applyRigPose(rig, motionState, elapsed);
  updateFace(elapsed, motionState);
  renderer.autoClear = true;
  renderer.render(scene, camera);
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  updateCameraTextureCrop();
}
addEventListener('resize', resize);

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

liveArButton.addEventListener('click', async () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    cameraTexture?.dispose();
    cameraTexture = null;
    scene.background = null;
    cameraVideo.srcObject = null;
    document.body.classList.remove('camera-on');
    liveArButton.querySelector('b').textContent = 'Start Camera Overlay';
    status.textContent = 'Camera stopped. Yuki remains animated.';
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    cameraVideo.srcObject = cameraStream;
    await cameraVideo.play();
    cameraTexture = new THREE.VideoTexture(cameraVideo);
    cameraTexture.colorSpace = THREE.SRGBColorSpace;
    cameraTexture.wrapS = THREE.ClampToEdgeWrapping;
    cameraTexture.wrapT = THREE.ClampToEdgeWrapping;
    cameraTexture.matrixAutoUpdate = false;
    scene.background = cameraTexture;
    updateCameraTextureCrop();
    document.body.classList.add('camera-on');
    liveArButton.querySelector('b').textContent = 'Stop Camera Overlay';
    status.textContent = 'Camera overlay is active. Yuki is animated but not world-anchored AR yet.';
    showToast('Animated camera overlay');
  } catch (error) {
    console.error(error);
    showToast('Camera permission is required');
  }
});

function updateCameraTextureCrop() {
  if (!cameraTexture || !cameraVideo.videoWidth || !cameraVideo.videoHeight) return;
  const viewportAspect = innerWidth / innerHeight;
  const videoAspect = cameraVideo.videoWidth / cameraVideo.videoHeight;
  let repeatX = 1;
  let repeatY = 1;
  if (videoAspect > viewportAspect) repeatX = viewportAspect / videoAspect;
  else repeatY = videoAspect / viewportAspect;
  cameraTexture.matrix.setUvTransform((1 - repeatX) / 2, (1 - repeatY) / 2, repeatX, repeatY, 0, 0.5, 0.5);
}

cameraVideo.addEventListener('loadedmetadata', updateCameraTextureCrop);

if (new URLSearchParams(location.search).has('cameraTest')) {
  const testCanvas = document.createElement('canvas');
  testCanvas.width = 720;
  testCanvas.height = 1280;
  const context = testCanvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 720, 1280);
  gradient.addColorStop(0, '#72526f');
  gradient.addColorStop(0.55, '#26324b');
  gradient.addColorStop(1, '#0b1322');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 720, 1280);
  context.fillStyle = 'rgba(255,255,255,.14)';
  context.fillRect(70, 110, 250, 620);
  context.fillRect(390, 250, 250, 430);
  cameraTexture = new THREE.CanvasTexture(testCanvas);
  cameraTexture.colorSpace = THREE.SRGBColorSpace;
  scene.background = cameraTexture;
  document.body.classList.add('camera-on');
}

motionButton.addEventListener('click', () => {
  stateIndex = (stateIndex + 1) % stateOrder.length;
  motionState = stateOrder[stateIndex];
  const nextState = stateOrder[(stateIndex + 1) % stateOrder.length];
  motionButton.querySelector('b').textContent = `Show ${stateLabels[nextState]} Motion`;
  status.textContent = `Yuki is ${stateLabels[motionState].toLowerCase()}. Her body and face are animating live.`;
  showToast(`${stateLabels[motionState]} motion`);
});

let pointerX = 0;
let pointerStartRotation = 0;
let pinchDistance = 0;
sceneHost.addEventListener('pointerdown', (event) => {
  pointerX = event.clientX;
  pointerStartRotation = rotationTarget;
  sceneHost.setPointerCapture(event.pointerId);
});
sceneHost.addEventListener('pointermove', (event) => {
  if (!sceneHost.hasPointerCapture(event.pointerId)) return;
  rotationTarget = pointerStartRotation + (event.clientX - pointerX) * 0.009;
});
sceneHost.addEventListener('touchmove', (event) => {
  if (event.touches.length !== 2) return;
  const a = event.touches[0], b = event.touches[1];
  const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  if (pinchDistance) scaleTarget = THREE.MathUtils.clamp(scaleTarget * distance / pinchDistance, 0.55, 1.55);
  pinchDistance = distance;
}, { passive: true });
sceneHost.addEventListener('touchend', () => { pinchDistance = 0; });
