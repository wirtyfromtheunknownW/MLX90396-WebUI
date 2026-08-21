/**
 * sfi_demo.js
 * Standalone SFI Joystick & Differential 3D Field Visualizer
 */

// --- Simulation State ---
let autoPattern = true;
let coilActive = false;
let animTime = 0;
let joyX = 0, joyY = 0, joyZ = 0;
let sens = [1.0, 1.0, 1.0, 1.0];
let stdTraceHistory = [];
let mlxTraceHistory = [];

let mainSceneObj = null;
let stdPlot = null;
let mlxPlot = null;

export function initSfiDemo() {
  const container = document.getElementById('canvas3d-container');
  if (!container || !window.THREE) return;

  // --- DOM Elements ---
  const btnPattern = document.getElementById('btn-pattern');
  const btnCoil = document.getElementById('btn-coil');
  const btnResetTrace = document.getElementById('btn-reset-trace');
  const coilLbl = document.getElementById('coil-readout-lbl');

  btnPattern?.addEventListener('click', () => {
    autoPattern = !autoPattern;
    btnPattern.style.opacity = autoPattern ? '1' : '0.5';
  });

  btnCoil?.addEventListener('click', () => {
    coilActive = !coilActive;
    if (coilActive) {
      btnCoil.classList.add('active');
      if (coilLbl) {
        coilLbl.innerText = 'Coil Status: INJECTING 5.0 mT STRAY FIELD!';
        coilLbl.style.color = 'var(--accent-red, #ff3366)';
      }
    } else {
      btnCoil.classList.remove('active');
      if (coilLbl) {
        coilLbl.innerText = 'Coil Status: INACTIVE (0 mT)';
        coilLbl.style.color = 'var(--text-muted, #94a3b8)';
      }
    }
  });

  btnResetTrace?.addEventListener('click', () => {
    stdTraceHistory = [];
    mlxTraceHistory = [];
    resetPlotLines();
  });

  [0, 1, 2, 3].forEach(idx => {
    const slider = document.getElementById(`sens-p${idx}`);
    const lbl = document.getElementById(`p${idx}-sens-lbl`);
    slider?.addEventListener('input', (e) => {
      sens[idx] = parseFloat(e.target.value);
      if (lbl) lbl.innerText = sens[idx].toFixed(2) + 'x';
    });
  });

  // --- MAIN 3D SCENE SETUP ---
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const width = container.clientWidth || 450;
  const height = container.clientHeight || 380;
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 1000);
  camera.position.set(0, 8.5, 12.5);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.5, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // Lights
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dirLight = new THREE.DirectionalLight(0x00d2ff, 1.4);
  dirLight.position.set(10, 25, 15);
  scene.add(dirLight);

  // 1. Blue Hemispherical Base
  const baseMesh = new THREE.Mesh(
    new THREE.SphereGeometry(5.2, 32, 16, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
    new THREE.MeshStandardMaterial({ color: 0x0a2540, roughness: 0.2, metalness: 0.5 })
  );
  scene.add(baseMesh);

  // Rim Accent
  const rimMesh = new THREE.Mesh(
    new THREE.TorusGeometry(5.25, 0.18, 16, 100),
    new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.9, roughness: 0.1 })
  );
  rimMesh.rotation.x = Math.PI / 2;
  scene.add(rimMesh);

  // Internal PCB
  const pcbMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(4.8, 4.8, 0.2, 32),
    new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.4 })
  );
  pcbMesh.position.y = 0.1;
  scene.add(pcbMesh);

  // IC Package
  const icMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.35, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.2 })
  );
  icMesh.position.y = 0.4;
  scene.add(icMesh);

  // Pin 1 Dot
  const pin1Dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  pin1Dot.position.set(-0.6, 0.59, -0.6);
  scene.add(pin1Dot);

  // 4 Hall Pixels (P0: BR, P1: TR, P2: TL, P3: BL)
  const cornerOffset = 0.62;
  const pCoords = [
    [cornerOffset, cornerOffset],
    [cornerOffset, -cornerOffset],
    [-cornerOffset, -cornerOffset],
    [-cornerOffset, cornerOffset]
  ];
  const pColors = [0x00ff88, 0x00d2ff, 0xa855f7, 0xd97706];
  const pixelMeshes = [];
  const pixelMats = [];

  pCoords.forEach((pt, i) => {
    const mat = new THREE.MeshStandardMaterial({ color: pColors[i], emissive: pColors[i], emissiveIntensity: 0.2 });
    const pxMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 16), mat);
    pxMesh.position.set(pt[0], 0.58, pt[1]);
    scene.add(pxMesh);
    pixelMeshes.push(pxMesh);
    pixelMats.push(mat);
  });

  // Joystick Assembly
  const domeRadius = 5.2;
  const joyAssembly = new THREE.Group();

  // Axial Magnet Disc
  const axialMagnetGroup = new THREE.Group();
  axialMagnetGroup.position.y = 0.61;

  const northPoleMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 0.25, 32),
    new THREE.MeshStandardMaterial({ color: 0xff1144, roughness: 0.2, metalness: 0.3 })
  );
  northPoleMesh.position.y = 0.125;
  axialMagnetGroup.add(northPoleMesh);

  const ringMesh = new THREE.Mesh(
    new THREE.TorusGeometry(0.91, 0.03, 16, 32),
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.9 })
  );
  ringMesh.rotation.x = Math.PI / 2;
  ringMesh.position.y = 0.25;
  axialMagnetGroup.add(ringMesh);

  const southPoleMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 0.25, 32),
    new THREE.MeshStandardMaterial({ color: 0x0088ff, roughness: 0.2, metalness: 0.3 })
  );
  southPoleMesh.position.y = 0.375;
  axialMagnetGroup.add(southPoleMesh);
  joyAssembly.add(axialMagnetGroup);

  // Shaft & Knob
  const shaftMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, 3.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.6 })
  );
  shaftMesh.position.y = 2.4;
  joyAssembly.add(shaftMesh);

  const knobMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.85, 0.65, 1.8, 24),
    new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.2 })
  );
  knobMesh.position.y = 4.2;
  joyAssembly.add(knobMesh);
  scene.add(joyAssembly);

  // Glass Dome
  const domeMesh = new THREE.Mesh(
    new THREE.SphereGeometry(domeRadius, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.5),
    new THREE.MeshPhysicalMaterial({
      color: 0x4a5568,
      transparent: true,
      opacity: 0.42,
      roughness: 0.15,
      transmission: 0.82,
      thickness: 0.8
    })
  );
  scene.add(domeMesh);

  // Raycasting / Dragging
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let isDraggingKnob = false;

  container.addEventListener('mousedown', (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / container.clientWidth) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / container.clientHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    if (raycaster.intersectObject(knobMesh).length > 0 || e.shiftKey) {
      isDraggingKnob = true;
      controls.enabled = false;
      autoPattern = false;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingKnob) return;
    const rect = renderer.domElement.getBoundingClientRect();
    joyX = Math.max(-1, Math.min(1, (((e.clientX - rect.left) / container.clientWidth) * 2 - 1) * 1.5));
    joyY = Math.max(-1, Math.min(1, (-((e.clientY - rect.top) / container.clientHeight) * 2 + 1) * 1.5));
  });

  window.addEventListener('mouseup', () => {
    if (isDraggingKnob) {
      isDraggingKnob = false;
      controls.enabled = true;
    }
  });

  mainSceneObj = { scene, camera, renderer, controls, container };

  // --- Sub-Plots ---
  stdPlot = create3DFieldPlot('canvas3d-std-plot', 0xff3366);
  mlxPlot = create3DFieldPlot('canvas3d-mlx-plot', 0x00ff88);

  // --- Animation Loop ---
  function animate() {
    requestAnimationFrame(animate);

    if (autoPattern) {
      animTime += 0.025;
      let cycle = (animTime % 24) / 24;

      if (cycle < 0.25) {
        let t = (cycle / 0.25) * Math.PI * 2;
        joyX = Math.cos(t) * 0.85; joyY = Math.sin(t) * 0.85; joyZ = 0;
      } else if (cycle < 0.50) {
        let t = ((cycle - 0.25) / 0.25) * Math.PI * 4;
        if (Math.sin(t) > 0) { joyX = Math.sin(t * 2) * 0.9; joyY = 0; }
        else { joyX = 0; joyY = Math.cos(t * 2) * 0.9; }
        joyZ = 0;
      } else if (cycle < 0.75) {
        joyX = Math.sin(animTime * 2) * 0.25; joyY = Math.cos(animTime * 2) * 0.25;
        joyZ = Math.sin((cycle - 0.50) * Math.PI * 8) * 0.8;
      } else {
        joyX = Math.sin(animTime * 1.7) * 0.75 + Math.cos(animTime * 0.5) * 0.2;
        joyY = Math.cos(animTime * 1.3) * 0.75 + Math.sin(animTime * 0.7) * 0.2;
        joyZ = Math.sin(animTime * 2.5) * 0.4;
      }
    }

    // Kinematics along Dome
    let tiltAngle = Math.sqrt(joyX * joyX + joyY * joyY) * 0.45;
    let tiltDir = Math.atan2(joyY, joyX);

    joyAssembly.position.set(
      Math.sin(tiltAngle) * Math.cos(tiltDir) * domeRadius,
      Math.cos(tiltAngle) * domeRadius + (joyZ * 0.3),
      Math.sin(tiltAngle) * Math.sin(tiltDir) * domeRadius
    );
    joyAssembly.rotation.z = -joyX * 0.35;
    joyAssembly.rotation.x = joyY * 0.35;

    const joyPosTxt = document.getElementById('joy-pos-text');
    if (joyPosTxt) {
      joyPosTxt.innerText = `Tilt X: ${(joyX * 22).toFixed(1)}° | Tilt Y: ${(joyY * 22).toFixed(1)}° | Press Z: ${(joyZ * 2.0).toFixed(1)} mm`;
    }

    // Magnetic Math
    let trueBx = joyX * 18.0;
    let trueBy = joyY * 18.0;
    let trueBz = 22.0 + joyZ * 10.0;

    let pSignals = [
      { bx: trueBx + trueBy * 0.2, by: trueBy - 5.0, bz: trueBz },
      { bx: trueBx + 5.0, by: trueBy + trueBx * 0.2, bz: trueBz },
      { bx: trueBx - trueBy * 0.2, by: trueBy + 5.0, bz: trueBz },
      { bx: trueBx - 5.0, by: trueBy - trueBx * 0.2, bz: trueBz }
    ];

    let noiseX = coilActive ? 6.0 + (Math.random() - 0.5) * 0.8 : 0;
    let noiseY = coilActive ? -5.5 + (Math.random() - 0.5) * 0.8 : 0;
    let noiseZ = coilActive ? 4.0 + (Math.random() - 0.5) * 0.5 : 0;

    let pMeasured = [];
    for (let i = 0; i < 4; i++) {
      pMeasured.push({
        bx: (pSignals[i].bx + noiseX) * sens[i],
        by: (pSignals[i].by + noiseY) * sens[i],
        bz: (pSignals[i].bz + noiseZ) * sens[i]
      });

      let totalMag = Math.sqrt(pMeasured[i].bx ** 2 + pMeasured[i].by ** 2 + pMeasured[i].bz ** 2);
      let intensity = Math.min(1.0, totalMag / 30.0);
      pixelMats[i].emissiveIntensity = 0.2 + intensity * 0.8;
      pixelMeshes[i].scale.set(1 + intensity * 0.3, 1, 1 + intensity * 0.3);

      const card = document.getElementById(`px-card-${i}`);
      if (card) card.style.borderColor = intensity > 0.6 ? 'var(--accent-green, #00ff88)' : 'var(--card-border, #1e293b)';
      
      const elBx = document.getElementById(`p${i}-bx`);
      const elBy = document.getElementById(`p${i}-by`);
      const elBz = document.getElementById(`p${i}-bz`);
      if (elBx) elBx.innerText = pMeasured[i].bx.toFixed(1);
      if (elBy) elBy.innerText = pMeasured[i].by.toFixed(1);
      if (elBz) elBz.innerText = pMeasured[i].bz.toFixed(1);
    }

    let stdBx = pMeasured[0].bx, stdBy = pMeasured[0].by, stdBz = pMeasured[0].bz;
    let mlxDBx = trueBx, mlxDBy = trueBy, mlxDBz = trueBz;

    const sBx = document.getElementById('std-read-bx');
    const sBy = document.getElementById('std-read-by');
    const sBz = document.getElementById('std-read-bz');
    if (sBx) sBx.innerText = stdBx.toFixed(1) + ' mT';
    if (sBy) sBy.innerText = stdBy.toFixed(1) + ' mT';
    if (sBz) sBz.innerText = stdBz.toFixed(1) + ' mT';

    const mBx = document.getElementById('mlx-read-dbx');
    const mBy = document.getElementById('mlx-read-dby');
    const mBz = document.getElementById('mlx-read-dbz');
    if (mBx) mBx.innerText = mlxDBx.toFixed(1) + ' mT';
    if (mBy) mBy.innerText = mlxDBy.toFixed(1) + ' mT';
    if (mBz) mBz.innerText = mlxDBz.toFixed(1) + ' mT';

    stdTraceHistory.push({ x: stdBx, y: stdBy, z: stdBz });
    mlxTraceHistory.push({ x: mlxDBx, y: mlxDBy, z: mlxDBz });

    if (stdTraceHistory.length > 120) stdTraceHistory.shift();
    if (mlxTraceHistory.length > 120) mlxTraceHistory.shift();

    if (stdPlot) update3DPlot(stdPlot, stdTraceHistory, true);
    if (mlxPlot) update3DPlot(mlxPlot, mlxTraceHistory, false);

    controls.update();
    renderer.render(scene, camera);
  }

  animate();
}

function create3DFieldPlot(elementId, ringColor) {
  const el = document.getElementById(elementId);
  if (!el) return null;

  const plotScene = new THREE.Scene();
  plotScene.background = new THREE.Color(0x020612);

  const w = el.clientWidth || 300;
  const h = el.clientHeight || 290;
  const plotCamera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
  plotCamera.position.set(9, 7, 10);

  const plotRenderer = new THREE.WebGLRenderer({ antialias: true });
  plotRenderer.setSize(w, h);
  el.appendChild(plotRenderer.domElement);

  const plotControls = new THREE.OrbitControls(plotCamera, plotRenderer.domElement);
  plotControls.enableDamping = true;
  plotControls.dampingFactor = 0.05;

  const gridHelper = new THREE.GridHelper(8, 8, 0x334155, 0x1e293b);
  gridHelper.position.y = -3;
  plotScene.add(gridHelper);

  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -3, 0), 4.2, 0xff3366));
  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -3, 0), 4.2, 0x00ff88));
  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -3, 0), 4.2, 0x00d2ff));

  const maxPoints = 120;
  const linePositions = new Float32Array(maxPoints * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: ringColor, linewidth: 2 });
  const lineMesh = new THREE.Line(lineGeo, lineMat);
  plotScene.add(lineMesh);

  const headMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 16, 16),
    new THREE.MeshBasicMaterial({ color: ringColor })
  );
  plotScene.add(headMesh);

  return {
    scene: plotScene, camera: plotCamera, renderer: plotRenderer, controls: plotControls,
    lineGeo, headMesh, maxPoints, el
  };
}

function update3DPlot(plot, history, isCorrupted) {
  const positions = plot.lineGeo.attributes.position.array;
  const len = history.length;

  for (let i = 0; i < plot.maxPoints; i++) {
    if (i < len) {
      positions[i * 3] = history[i].x * 0.18;
      positions[i * 3 + 1] = history[i].y * 0.18 - 3;
      positions[i * 3 + 2] = history[i].z * 0.18;
    } else {
      positions[i * 3] = 0; positions[i * 3 + 1] = -3; positions[i * 3 + 2] = 0;
    }
  }
  plot.lineGeo.attributes.position.needsUpdate = true;

  if (len > 0) {
    const last = history[len - 1];
    plot.headMesh.position.set(last.x * 0.18, last.y * 0.18 - 3, last.z * 0.18);
    plot.headMesh.material.color.setHex(isCorrupted && coilActive ? 0xff3366 : 0x00ff88);
  }

  plot.controls.update();
  plot.renderer.render(plot.scene, plot.camera);
}

function resetPlotLines() {
  [stdPlot, mlxPlot].forEach(p => {
    if (!p) return;
    const pos = p.lineGeo.attributes.position.array;
    pos.fill(0);
    p.lineGeo.attributes.position.needsUpdate = true;
  });
}

export function resizeSfiCanvases() {
  if (mainSceneObj && mainSceneObj.container) {
    const w = mainSceneObj.container.clientWidth;
    const h = mainSceneObj.container.clientHeight;
    if (w > 0 && h > 0) {
      mainSceneObj.camera.aspect = w / h;
      mainSceneObj.camera.updateProjectionMatrix();
      mainSceneObj.renderer.setSize(w, h);
    }
  }
  [stdPlot, mlxPlot].forEach(p => {
    if (p && p.el) {
      const w = p.el.clientWidth;
      const h = p.el.clientHeight;
      if (w > 0 && h > 0) {
        p.camera.aspect = w / h;
        p.camera.updateProjectionMatrix();
        p.renderer.setSize(w, h);
      }
    }
  });
}