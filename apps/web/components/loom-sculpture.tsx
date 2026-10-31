"use client";

import { useEffect, useRef, useState } from "react";

/** A rotating box-shaped loom, generated locally without external assets. */
export function LoomSculpture({
  onReady,
  active = true,
}: {
  onReady?: () => void;
  active?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const readyCallback = useRef(onReady);
  const readyReported = useRef(false);
  const activeRef = useRef(active);
  const syncRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    readyCallback.current = onReady;
  }, [onReady]);
  useEffect(() => {
    activeRef.current = active;
    syncRef.current?.();
  }, [active]);

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    let disposed = false;
    const cleanup: Array<() => void> = [];
    const reportReady = () => {
      if (disposed || readyReported.current) return;
      readyReported.current = true;
      readyCallback.current?.();
    };
    const release = () => {
      for (const dispose of cleanup.splice(0).reverse()) dispose();
    };

    async function createScene() {
      const [
        THREE,
        { EffectComposer },
        { RenderPass },
        { OutputPass },
        { ShaderPass },
        { RoundedBoxGeometry },
        { mergeGeometries },
      ] = await Promise.all([
        import("three"),
        import("three/addons/postprocessing/EffectComposer.js"),
        import("three/addons/postprocessing/RenderPass.js"),
        import("three/addons/postprocessing/OutputPass.js"),
        import("three/addons/postprocessing/ShaderPass.js"),
        import("three/addons/geometries/RoundedBoxGeometry.js"),
        import("three/addons/utils/BufferGeometryUtils.js"),
      ]);
      if (disposed || !host) return;
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "low-power",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.9;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.setAttribute("aria-hidden", "true");
      renderer.domElement.dataset.loomRenderer = "webgl";
      host.appendChild(renderer.domElement);
      cleanup.push(() => {
        renderer.dispose();
        renderer.domElement.remove();
      });

      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#090909");
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
      camera.position.set(7.7, 5.6, 10.3);
      camera.lookAt(0, 0, 0);
      const sculpture = new THREE.Group();
      sculpture.rotation.set(0.12, -0.48, 0);
      scene.add(sculpture);
      function makeEnvironment() {
        const generator = new THREE.PMREMGenerator(renderer);
        const studio = new THREE.Scene();
        studio.background = new THREE.Color("#08070b");
        const panels: import("three").Mesh[] = [];
        function softbox(
          width: number,
          height: number,
          color: string,
          intensity: number,
          position: [number, number, number],
        ) {
          const panel = new THREE.Mesh(
            new THREE.PlaneGeometry(width, height),
            new THREE.MeshBasicMaterial({
              color: new THREE.Color(color).multiplyScalar(intensity),
            }),
          );
          panel.position.set(...position);
          panel.lookAt(0, 0, 0);
          studio.add(panel);
          panels.push(panel);
        }
        // Broad studio cards form clean reflections across the glass face and
        // rounded edges. They are environment-only, never visible in the scene.
        softbox(2.7, 6.5, "#f4ebff", 4.2, [-4, 2.5, 5]);
        softbox(2.6, 7, "#aa65ed", 0.65, [4, 0.5, -5]);
        softbox(5, 1.6, "#e7dcf5", 2.8, [0, 5, 1]);
        softbox(3.5, 5, "#645779", 0.9, [3, -1, 5]);
        try {
          return generator.fromScene(studio, 0.035, 0.1, 30);
        } finally {
          for (const panel of panels) {
            panel.geometry.dispose();
            (panel.material as import("three").Material).dispose();
          }
          generator.dispose();
        }
      }
      let environment = makeEnvironment();
      cleanup.push(() => environment.dispose());
      scene.environment = environment.texture;

      const glass = new THREE.MeshPhysicalMaterial({
        color: "#40334e",
        metalness: 0,
        roughness: 0.12,
        transmission: 0.72,
        thickness: 0.28,
        ior: 1.52,
        attenuationColor: new THREE.Color("#43314f"),
        attenuationDistance: 0.7,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
        envMapIntensity: 1.1,
        specularIntensity: 1,
      });
      const geometries = new Set<import("three").BufferGeometry>();
      const materials = new Set<import("three").Material>([glass]);
      cleanup.push(() => {
        geometries.forEach((geometry) => geometry.dispose());
        materials.forEach((material) => material.dispose());
      });
      function addMesh(
        geometry: import("three").BufferGeometry,
        material: import("three").Material,
      ) {
        geometries.add(geometry);
        materials.add(material);
        const mesh = new THREE.Mesh(geometry, material);
        sculpture.add(mesh);
        return mesh;
      }

      // Twelve smoked-glass rails keep a clear cubic silhouette while leaving
      // the interior open. Rounded edges catch the studio's violet reflections.
      const rails: import("three").BufferGeometry[] = [];
      for (const a of [-1.31, 1.31]) {
        for (const b of [-1.31, 1.31]) {
          rails.push(
            new RoundedBoxGeometry(0.18, 2.8, 0.18, 4, 0.06).translate(a, 0, b),
            new RoundedBoxGeometry(2.62, 0.18, 0.18, 4, 0.06).translate(
              0,
              a,
              b,
            ),
            new RoundedBoxGeometry(0.18, 0.18, 2.62, 4, 0.06).translate(
              a,
              b,
              0,
            ),
          );
        }
      }
      addMesh(mergeGeometries(rails), glass);
      rails.forEach((rail) => rail.dispose());

      const warpMaterial = new THREE.MeshStandardMaterial({
        color: "#bba2d2",
        emissive: "#8953b5",
        emissiveIntensity: 0.28,
        metalness: 0.25,
        roughness: 0.4,
      });
      const weftMaterial = new THREE.MeshStandardMaterial({
        color: "#9875b3",
        emissive: "#67358e",
        emissiveIntensity: 0.18,
        metalness: 0.12,
        roughness: 0.55,
      });
      const warpThreads: import("three").BufferGeometry[] = [];
      const weftThreads: import("three").BufferGeometry[] = [];
      const warpCount = 25;
      const rowCount = 29;
      for (let face = 0; face < 4; face++) {
        const angle = (face * Math.PI) / 2;
        for (let column = 0; column < warpCount; column++) {
          warpThreads.push(
            new THREE.CylinderGeometry(0.008, 0.008, 2.44, 6)
              .translate(-1.17 + (column / (warpCount - 1)) * 2.34, 0, 1.31)
              .rotateY(angle),
          );
        }
        // Alternating over-and-under geometry forms a partly woven panel on
        // each side. The open upper warp makes the box recognizably a loom.
        for (let row = 0; row < rowCount; row++) {
          const points = Array.from({ length: 97 }, (_, index) => {
            const t = index / 96;
            return new THREE.Vector3(
              -1.17 + t * 2.34,
              -1.18 + (row / (rowCount - 1)) * 1.45,
              1.31 + Math.cos((t * (warpCount - 1) + row) * Math.PI) * 0.019,
            );
          });
          weftThreads.push(
            new THREE.TubeGeometry(
              new THREE.CatmullRomCurve3(points),
              96,
              0.011,
              5,
              false,
            ).rotateY(angle),
          );
        }
      }
      addMesh(mergeGeometries(warpThreads), warpMaterial);
      addMesh(mergeGeometries(weftThreads), weftMaterial);
      warpThreads.forEach((thread) => thread.dispose());
      weftThreads.forEach((thread) => thread.dispose());

      const key = new THREE.DirectionalLight("#eee4fa", 1.4);
      key.position.set(-3, 5, 5);
      scene.add(key);
      const rim = new THREE.DirectionalLight("#b777f4", 2.2);
      rim.position.set(4, 1, -3);
      scene.add(rim);

      const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
        samples: 4,
        type: THREE.HalfFloatType,
      });
      const composer = new EffectComposer(renderer, renderTarget);
      cleanup.push(() => {
        composer.passes.forEach((pass) => pass.dispose());
        composer.dispose();
      });
      composer.addPass(new RenderPass(scene, camera));
      composer.addPass(new OutputPass());
      // Match the CSS canvas after tone mapping, preserving the
      // sculpture's highlights while preventing a visible black rectangle.
      composer.addPass(
        new ShaderPass({
          uniforms: {
            tDiffuse: { value: null },
            blackLevel: { value: 9 / 255 },
          },
          vertexShader: `varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
          fragmentShader: `uniform sampler2D tDiffuse;
          uniform float blackLevel;
          varying vec2 vUv;
          void main() {
            gl_FragColor = texture2D(tDiffuse, vUv);
            gl_FragColor.rgb = max(gl_FragColor.rgb, vec3(blackLevel));
          }`,
        }),
      );

      // A rotation-independent envelope prevents clipping at any point in a
      // full turn, including the narrow mobile crop.
      const focalPoint = new THREE.Vector3();
      const viewDirection = new THREE.Vector3(0, 0.22, 1).normalize();
      const cameraRight = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const cameraUp = new THREE.Vector3()
        .crossVectors(viewDirection, cameraRight)
        .normalize();
      const framingPoints: import("three").Vector3[] = [];
      for (const x of [-2, 2])
        for (const y of [-1.63, 1.63])
          for (const z of [-2.16, 2.16])
            framingPoints.push(new THREE.Vector3(x, y, z));

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
      let frameId = 0,
        visible = true,
        lost = false;
      let lastTime = 0;
      const canAnimate = () =>
        !disposed &&
        activeRef.current &&
        !lost &&
        visible &&
        !document.hidden &&
        !reduced.matches;
      function draw(time: number, animate: boolean) {
        if (disposed || lost) return;
        if (animate) {
          const delta = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
          lastTime = time;
          sculpture.rotation.y =
            (sculpture.rotation.y + delta * 0.28) % (Math.PI * 2);
        }
        composer.render();
        if (!readyReported.current) {
          setReady(true);
          reportReady();
        }
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
        const verticalTangent = Math.tan(
          THREE.MathUtils.degToRad(camera.fov / 2),
        );
        const horizontalTangent = verticalTangent * camera.aspect;
        const distance =
          Math.max(
            ...framingPoints.map(
              (point) =>
                point.dot(viewDirection) +
                Math.max(
                  Math.abs(point.dot(cameraRight)) / horizontalTangent,
                  Math.abs(point.dot(cameraUp)) / verticalTangent,
                ),
            ),
          ) * 1.08;
        camera.position
          .copy(focalPoint)
          .addScaledVector(viewDirection, distance);
        camera.lookAt(focalPoint);
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
      const contextLost = (event: Event) => {
        event.preventDefault();
        lost = true;
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0;
        setReady(false);
        reportReady();
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
      syncRef.current = syncAnimation;
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
        syncRef.current = null;
      });
      resize();
      syncAnimation();
    }
    void createScene().catch(() => {
      // The static illustration preserves the meaning on devices without WebGL.
      release();
      if (!disposed) {
        setReady(false);
        reportReady();
      }
    });
    return () => {
      disposed = true;
      release();
    };
  }, []);

  return (
    <figure
      className={`loom-sculpture ${ready ? "is-ready" : ""}`}
      aria-label="A box-shaped dark glass loom with violet threads woven across its faces."
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
            id="loom-box-rail"
            x1="270"
            y1="160"
            x2="520"
            y2="420"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#8e7aa0" />
            <stop offset="0.45" stopColor="#332a3e" />
            <stop offset="1" stopColor="#a06eca" />
          </linearGradient>
        </defs>
        <g stroke="#ae89cb" strokeWidth="0.85" opacity="0.65">
          {Array.from({ length: 23 }, (_, index) => {
            const t = (index + 1) / 24;
            return (
              <g key={index}>
                <path d={`M${275 + 159 * t} ${206 + 58 * t}v160`} />
                <path d={`M${434 + 91 * t} ${264 - 59 * t}v160`} />
                <path
                  d={`M275 ${366 - 98 * t} 434 ${424 - 98 * t} 525 ${365 - 98 * t}`}
                />
              </g>
            );
          })}
        </g>
        <g stroke="url(#loom-box-rail)" strokeWidth="9" strokeLinejoin="round">
          <path d="M275 206 372 151 525 205 434 264Z" />
          <path d="M275 206V366L434 424 525 365V205M434 264V424" />
          <path d="M372 151V311L275 366M372 311 525 365" opacity="0.4" />
        </g>
      </svg>
    </figure>
  );
}
