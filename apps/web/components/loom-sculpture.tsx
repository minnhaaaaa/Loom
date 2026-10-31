"use client";

import { useEffect, useRef, useState } from "react";

/** A procedural loom. No remote models, textures, or tracking requests. */
export function LoomSculpture() {
  const mountRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<((paused: boolean) => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    let disposed = false;
    const cleanup: Array<() => void> = [];
    const release = () => {
      for (const dispose of cleanup.splice(0).reverse()) dispose();
    };

    async function createScene() {
      const [
        THREE,
        { EffectComposer },
        { RenderPass },
        { UnrealBloomPass },
        { OutputPass },
        { RoomEnvironment },
      ] = await Promise.all([
        import("three"),
        import("three/addons/postprocessing/EffectComposer.js"),
        import("three/addons/postprocessing/RenderPass.js"),
        import("three/addons/postprocessing/UnrealBloomPass.js"),
        import("three/addons/postprocessing/OutputPass.js"),
        import("three/addons/environments/RoomEnvironment.js"),
      ]);
      if (disposed || !host) return;
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "low-power",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.setAttribute("aria-hidden", "true");
      renderer.domElement.dataset.loomRenderer = "webgl";
      host.appendChild(renderer.domElement);
      cleanup.push(() => {
        renderer.dispose();
        renderer.domElement.remove();
      });

      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#080e0d");
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
      camera.position.set(7.7, 5.6, 10.3);
      camera.lookAt(0, 0, 0);
      const sculpture = new THREE.Group();
      sculpture.rotation.y = -0.12;
      scene.add(sculpture);
      function makeEnvironment() {
        const generator = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        try {
          return generator.fromScene(room, 0.04);
        } finally {
          room.dispose();
          generator.dispose();
        }
      }
      let environment = makeEnvironment();
      cleanup.push(() => environment.dispose());
      scene.environment = environment.texture;

      const metal = new THREE.MeshStandardMaterial({
        color: "#233b2e",
        metalness: 0.86,
        roughness: 0.38,
        envMapIntensity: 0.65,
      });
      const graphite = new THREE.MeshStandardMaterial({
        color: "#17221d",
        metalness: 0.74,
        roughness: 0.38,
      });
      const edge = new THREE.MeshStandardMaterial({
        color: "#89967b",
        metalness: 0.9,
        roughness: 0.23,
      });
      const glass = new THREE.MeshPhysicalMaterial({
        color: "#bbd2bc",
        metalness: 0.15,
        roughness: 0.14,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        clearcoat: 1,
      });
      const colors = ["#d8edaa", "#bce766", "#e7c58c", "#a6d4c1"];
      const threadMaterials = colors.map(
        (color) =>
          new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 1.25,
            metalness: 0.25,
            roughness: 0.35,
          }),
      );
      const weftMaterial = new THREE.MeshStandardMaterial({
        color: "#bcd79c",
        emissive: "#8dac67",
        emissiveIntensity: 0.55,
        metalness: 0.35,
        roughness: 0.35,
      });
      const pulseMaterial = new THREE.MeshBasicMaterial({ color: "#f2ffd2" });
      const light = new THREE.DirectionalLight("#eef4dd", 2.2);
      light.position.set(-3, 7, 4);
      scene.add(light);
      const rim = new THREE.DirectionalLight("#c2f189", 1.7);
      rim.position.set(3, 2, -5);
      scene.add(rim);
      const fill = new THREE.DirectionalLight("#8aa8b1", 0.8);
      fill.position.set(1, -2, 5);
      scene.add(fill);

      cleanup.push(() => {
        [
          metal,
          graphite,
          edge,
          glass,
          weftMaterial,
          pulseMaterial,
          ...threadMaterials,
        ].forEach((material) => material.dispose());
      });
      const allGeometries = new Set<import("three").BufferGeometry>();
      cleanup.push(() =>
        allGeometries.forEach((geometry) => geometry.dispose()),
      );
      function addMesh(
        geometry: import("three").BufferGeometry,
        material: import("three").Material,
        x = 0,
        y = 0,
        z = 0,
      ) {
        allGeometries.add(geometry);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        sculpture.add(mesh);
        return mesh;
      }
      function roundedPath(
        shape: import("three").Shape | import("three").Path,
        width: number,
        height: number,
        radius: number,
      ) {
        const left = -width / 2,
          bottom = -height / 2;
        shape.moveTo(left + radius, bottom);
        shape.lineTo(left + width - radius, bottom);
        shape.quadraticCurveTo(
          left + width,
          bottom,
          left + width,
          bottom + radius,
        );
        shape.lineTo(left + width, bottom + height - radius);
        shape.quadraticCurveTo(
          left + width,
          bottom + height,
          left + width - radius,
          bottom + height,
        );
        shape.lineTo(left + radius, bottom + height);
        shape.quadraticCurveTo(
          left,
          bottom + height,
          left,
          bottom + height - radius,
        );
        shape.lineTo(left, bottom + radius);
        shape.quadraticCurveTo(left, bottom, left + radius, bottom);
      }
      const arch = new THREE.Shape();
      roundedPath(arch, 3.5, 2.8, 0.48);
      const hole = new THREE.Path();
      roundedPath(hole, 2.96, 2.28, 0.31);
      arch.holes.push(hole);
      const archGeometry = new THREE.ExtrudeGeometry(arch, {
        depth: 0.2,
        bevelEnabled: true,
        bevelThickness: 0.065,
        bevelSize: 0.065,
        bevelSegments: 3,
        curveSegments: 10,
      });
      archGeometry.center();
      for (const x of [-0.95, 1.0]) {
        const frame = addMesh(archGeometry, metal, x, 0, 0);
        frame.rotation.y = Math.PI / 2;
      }
      for (const z of [-1.64, 1.64]) {
        for (const y of [-1.23, 1.23]) {
          const rail = addMesh(
            new THREE.CylinderGeometry(0.07, 0.07, 1.94, 12),
            edge,
            0.025,
            y,
            z,
          );
          rail.rotation.z = Math.PI / 2;
        }
        for (const x of [-0.95, 1]) {
          addMesh(new THREE.BoxGeometry(0.5, 0.14, 0.46), graphite, x, -1.5, z);
        }
      }
      for (const x of [-1.05, 1.1]) {
        const roller = addMesh(
          new THREE.CylinderGeometry(0.2, 0.2, 3.05, 36),
          graphite,
          x,
          -0.16,
          0,
        );
        roller.rotation.x = Math.PI / 2;
        for (const z of [-1.49, 1.49]) {
          const cap = addMesh(
            new THREE.CylinderGeometry(0.24, 0.24, 0.12, 32),
            edge,
            x,
            -0.16,
            z,
          );
          cap.rotation.x = Math.PI / 2;
        }
      }
      // Individually routed warp threads meet the guide, then form a regular weave.
      const curves: import("three").CatmullRomCurve3[] = [];
      const pulses: import("three").Mesh[] = [];
      for (let index = 0; index < 17; index++) {
        const z = (index - 8) * 0.15;
        const startY = 0.9 * Math.sin(index * 1.8) + ((index % 3) - 1) * 0.25;
        const points = [
          new THREE.Vector3(-5.35, startY, z * 1.75),
          new THREE.Vector3(
            -3.9,
            startY * 0.75 + 0.28 * Math.cos(index),
            z * 1.7,
          ),
          new THREE.Vector3(-2.25, 0.2 + startY * 0.3, z * 1.18),
          new THREE.Vector3(-1.05, 0.07, z),
        ];
        for (let step = 0; step <= 32; step++) {
          const x = -0.8 + step * 0.175;
          const wave =
            x > 0.45 ? Math.sin((x - 0.45) * 15 + index * Math.PI) * 0.027 : 0;
          const fall = x > 3.6 ? Math.pow(x - 3.6, 2) * 0.21 : 0;
          points.push(new THREE.Vector3(x, 0.07 + wave - fall, z));
        }
        const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
        curves.push(curve);
        addMesh(
          new THREE.TubeGeometry(curve, 160, 0.015, 5, false),
          threadMaterials[index % colors.length],
        );
        if (index % 3 === 0) {
          const pulse = addMesh(
            new THREE.SphereGeometry(0.032, 8, 6),
            pulseMaterial,
          );
          pulses.push(pulse);
        }
        const guide = addMesh(
          new THREE.TorusGeometry(0.1, 0.025, 8, 16),
          glass,
          -0.65,
          0.07,
          z,
        );
        guide.rotation.y = Math.PI / 2;
      }
      for (let row = 0; row < 24; row++) {
        const x = 0.6 + row * 0.175;
        const fall = x > 3.6 ? Math.pow(x - 3.6, 2) * 0.21 : 0;
        const points = Array.from({ length: 49 }, (_, index) => {
          const z = -1.2 + (index / 48) * 2.4;
          return new THREE.Vector3(
            x,
            0.07 +
              Math.sin(((z + 1.2) / 0.15) * Math.PI + row * Math.PI) * 0.027 -
              fall,
            z,
          );
        });
        addMesh(
          new THREE.TubeGeometry(
            new THREE.CatmullRomCurve3(points),
            96,
            0.009,
            4,
            false,
          ),
          weftMaterial,
        );
      }
      const shuttle = addMesh(
        new THREE.CapsuleGeometry(0.07, 0.5, 4, 12),
        edge,
        0.45,
        0.2,
        0,
      );
      shuttle.rotation.z = Math.PI / 2;
      const shuttleLight = addMesh(
        new THREE.SphereGeometry(0.045, 10, 8),
        threadMaterials[1],
        0.45,
        0.3,
        0,
      );

      const composer = new EffectComposer(renderer);
      cleanup.push(() => {
        composer.passes.forEach((pass) => pass.dispose());
        composer.dispose();
      });
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        0.18,
        0.28,
        1.25,
      );
      composer.addPass(bloom);
      composer.addPass(new OutputPass());

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
      let frameId = 0,
        visible = true,
        userPaused = false,
        lost = false;
      let elapsed = 3.2,
        lastTime = 0;
      let pointerX = 0,
        pointerY = 0;
      const pulsePoint = new THREE.Vector3();
      const canAnimate = () =>
        !disposed &&
        !lost &&
        visible &&
        !document.hidden &&
        !reduced.matches &&
        !userPaused;
      function draw(time: number, animate: boolean) {
        if (disposed || lost) return;
        if (animate) {
          elapsed += lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
          lastTime = time;
          sculpture.rotation.y +=
            (-0.12 + pointerX * 0.08 - sculpture.rotation.y) * 0.035;
          sculpture.rotation.x +=
            (pointerY * 0.04 - sculpture.rotation.x) * 0.035;
        }
        // Hold briefly at the review guide before continuing through the loom.
        const cycle = (elapsed % 12) / 12;
        const progress =
          cycle < 0.37
            ? cycle
            : cycle < 0.48
              ? 0.37
              : 0.37 + (cycle - 0.48) * (0.63 / 0.52);
        pulses.forEach((pulse, index) => {
          const t = (progress + index * 0.13) % 1;
          curves[index * 3].getPointAt(t, pulsePoint);
          pulse.position.copy(pulsePoint);
          pulse.scale.setScalar(0.85 + Math.sin(t * Math.PI) * 0.5);
        });
        shuttle.position.z = Math.sin(elapsed * 0.75) * 1.2;
        shuttleLight.position.z = shuttle.position.z;
        composer.render();
      }
      function frame(time: number) {
        frameId = 0;
        if (!canAnimate()) return;
        draw(time, true);
        frameId = requestAnimationFrame(frame);
      }
      function syncAnimation() {
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0;
        lastTime = 0;
        if (canAnimate()) frameId = requestAnimationFrame(frame);
        else draw(performance.now(), false);
      }
      function resize() {
        if (!host || disposed || lost) return;
        const { width, height } = host.getBoundingClientRect();
        if (width < 1 || height < 1) return;
        renderer.setSize(width, height);
        composer.setSize(width, height);
        camera.aspect = width / height;
        // Keep every loose thread inside the framing on a narrow viewport.
        camera.position
          .set(7.7, 5.6, 10.3)
          .multiplyScalar(camera.aspect < 1.2 ? 1.25 : 1);
        camera.lookAt(0, -0.1, 0);
        camera.updateProjectionMatrix();
        draw(performance.now(), false);
      }
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      const intersection = new IntersectionObserver(
        ([entry]) => {
          visible = entry.isIntersecting;
          syncAnimation();
        },
        { rootMargin: "80px" },
      );
      intersection.observe(host);
      const pointer = (event: PointerEvent) => {
        if (reduced.matches || event.pointerType === "touch") return;
        const bounds = host.getBoundingClientRect();
        pointerX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
        pointerY = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
      };
      const pointerLeave = () => {
        pointerX = 0;
        pointerY = 0;
      };
      const contextLost = (event: Event) => {
        event.preventDefault();
        lost = true;
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0;
        setReady(false);
      };
      const contextRestored = () => {
        if (disposed) return;
        try {
          // Generated environment pixels do not survive a GPU context reset.
          environment.dispose();
          environment = makeEnvironment();
          scene.environment = environment.texture;
          composer.reset();
          lost = false;
          resize();
          syncAnimation();
          setReady(true);
        } catch {
          lost = true;
          setReady(false);
        }
      };
      controlRef.current = (value) => {
        userPaused = value;
        syncAnimation();
      };
      host.addEventListener("pointermove", pointer);
      host.addEventListener("pointerleave", pointerLeave);
      renderer.domElement.addEventListener("webglcontextlost", contextLost);
      renderer.domElement.addEventListener(
        "webglcontextrestored",
        contextRestored,
      );
      document.addEventListener("visibilitychange", syncAnimation);
      reduced.addEventListener("change", syncAnimation);
      cleanup.push(() => {
        cancelAnimationFrame(frameId);
        observer.disconnect();
        intersection.disconnect();
        host.removeEventListener("pointermove", pointer);
        host.removeEventListener("pointerleave", pointerLeave);
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          contextLost,
        );
        renderer.domElement.removeEventListener(
          "webglcontextrestored",
          contextRestored,
        );
        document.removeEventListener("visibilitychange", syncAnimation);
        reduced.removeEventListener("change", syncAnimation);
        controlRef.current = null;
      });
      resize();
      syncAnimation();
      setReady(true);
    }
    void createScene().catch(() => {
      // The static illustration preserves the meaning on devices without WebGL.
      release();
      if (!disposed) setReady(false);
    });
    return () => {
      disposed = true;
      release();
    };
  }, []);

  return (
    <figure
      className={`loom-sculpture ${ready ? "is-ready" : ""}`}
      aria-label="An illuminated loom turns loose request threads into an orderly woven ribbon."
    >
      <div className="loom-sculpture-stage" ref={mountRef} />
      <svg
        className="loom-sculpture-fallback"
        viewBox="0 0 800 560"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id="loom-metal"
            x1="240"
            y1="140"
            x2="550"
            y2="430"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#718771" />
            <stop offset="0.42" stopColor="#293c32" />
            <stop offset="1" stopColor="#0c1913" />
          </linearGradient>
          <linearGradient
            id="loom-thread"
            x1="40"
            y1="220"
            x2="730"
            y2="360"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#bce766" stopOpacity="0" />
            <stop offset="0.25" stopColor="#d8edaa" />
            <stop offset="0.8" stopColor="#d8edaa" />
            <stop offset="1" stopColor="#d8edaa" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g transform="translate(0 10) rotate(-10 400 280)">
          <path
            d="M280 155 Q280 130 305 138 L445 180 Q465 186 465 208 L465 401 Q465 425 440 417 L301 376 Q280 370 280 345Z"
            stroke="url(#loom-metal)"
            strokeWidth="27"
          />
          {Array.from({ length: 17 }, (_, i) => (
            <path
              key={i}
              d={`M20 ${125 + i * 18} C150 ${70 + i * 19}, 195 ${245 + i * 3}, 300 ${235 + i * 5} L700 ${330 + i * 5}`}
              stroke="url(#loom-thread)"
              strokeWidth="1.8"
            />
          ))}
          {Array.from({ length: 25 }, (_, i) => (
            <path
              key={i}
              d={`M${450 + i * 9} ${271 + i * 3} L${420 + i * 9} ${348 + i * 3}`}
              stroke="#cee2a3"
              strokeOpacity="0.5"
              strokeWidth="1.2"
            />
          ))}
          <path
            d="M385 118 Q385 94 410 101 L550 143 Q570 149 570 171 L570 364 Q570 388 545 380 L406 339 Q385 333 385 308Z"
            stroke="url(#loom-metal)"
            strokeWidth="24"
          />
          <path
            d="M295 145 L402 108 M454 192 L560 155 M289 357 L396 320 M450 410 L556 373"
            stroke="#6d806a"
            strokeWidth="7"
          />
        </g>
      </svg>
      <figcaption className="loom-sculpture-caption">
        <span className="loom-signal" /> Many loose ends. One clear thread.
      </figcaption>
      {ready && (
        <button
          className="loom-motion-control"
          type="button"
          aria-label={paused ? "Play loom animation" : "Pause loom animation"}
          aria-pressed={paused}
          onClick={() => {
            const next = !paused;
            setPaused(next);
            controlRef.current?.(next);
          }}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
      )}
    </figure>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.5 4v8m5-8v8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m6 3.5 6 4.5-6 4.5v-9Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  );
}
