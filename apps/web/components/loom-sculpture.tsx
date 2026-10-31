"use client";

import { useEffect, useRef, useState } from "react";

/** A studio-lit glass monolith, generated locally without external assets. */
export function LoomSculpture({
  onReady,
  active = true,
}: {
  onReady?: () => void;
  active?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<((paused: boolean) => void) | null>(null);
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
  const [paused, setPaused] = useState(false);

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
      ] = await Promise.all([
        import("three"),
        import("three/addons/postprocessing/EffectComposer.js"),
        import("three/addons/postprocessing/RenderPass.js"),
        import("three/addons/postprocessing/OutputPass.js"),
        import("three/addons/postprocessing/ShaderPass.js"),
        import("three/addons/geometries/RoundedBoxGeometry.js"),
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
      sculpture.rotation.set(0.07, -0.35, -0.035);
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
        color: "#51495e",
        metalness: 0,
        roughness: 0.13,
        transmission: 0.72,
        thickness: 0.9,
        ior: 1.52,
        attenuationColor: new THREE.Color("#43314f"),
        attenuationDistance: 0.65,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
        envMapIntensity: 1.1,
        specularIntensity: 1,
      });
      const geometry = new RoundedBoxGeometry(1.9, 3.6, 0.9, 6, 0.16);
      const monolith = new THREE.Mesh(geometry, glass);
      sculpture.add(monolith);
      cleanup.push(() => {
        geometry.dispose();
        glass.dispose();
      });
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

      // Keep the whole slab and its gentle float inside a generous studio crop.
      const bounds = new THREE.Box3().setFromObject(sculpture);
      const focalPoint = bounds.getCenter(new THREE.Vector3());
      const viewDirection = new THREE.Vector3(0, 0.25, 9).normalize();
      const cameraRight = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const cameraUp = new THREE.Vector3()
        .crossVectors(viewDirection, cameraRight)
        .normalize();
      const framingPoints: import("three").Vector3[] = [];
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z])
            framingPoints.push(new THREE.Vector3(x, y, z).sub(focalPoint));

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
      let frameId = 0,
        visible = true,
        userPaused = false,
        lost = false;
      let elapsed = 3.2,
        lastTime = 0;
      let pointerX = 0,
        pointerY = 0;
      const canAnimate = () =>
        !disposed &&
        activeRef.current &&
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
            (-0.35 +
              pointerX * 0.06 +
              Math.sin(elapsed * 0.22) * 0.055 -
              sculpture.rotation.y) *
            0.035;
          sculpture.rotation.x +=
            (0.07 + pointerY * 0.035 - sculpture.rotation.x) * 0.035;
          sculpture.position.y = Math.sin(elapsed * 0.55) * 0.035;
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
          ) * 1.28;
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
      aria-label="A dark glass monolith with softly illuminated violet edges."
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
            id="loom-glass-face"
            x1="300"
            y1="120"
            x2="480"
            y2="440"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#71667d" />
            <stop offset="0.2" stopColor="#26212e" />
            <stop offset="0.7" stopColor="#141119" />
            <stop offset="1" stopColor="#352440" />
          </linearGradient>
          <linearGradient
            id="loom-glass-edge"
            x1="470"
            y1="120"
            x2="500"
            y2="440"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#b99acd" />
            <stop offset="0.4" stopColor="#503367" />
            <stop offset="0.82" stopColor="#a268cb" />
            <stop offset="1" stopColor="#3c274d" />
          </linearGradient>
          <linearGradient
            id="loom-glass-reflection"
            x1="335"
            y1="100"
            x2="410"
            y2="300"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#f4e8ff" stopOpacity="0.45" />
            <stop offset="1" stopColor="#f4e8ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g transform="rotate(-2 400 280)">
          <path
            d="M324 105 473 119Q487 121 488 137L489 432Q488 447 475 450L447 456 323 422Q312 419 312 405V121Q312 105 324 105Z"
            fill="url(#loom-glass-edge)"
          />
          <path
            d="M324 105 450 133Q460 135 460 149V440Q460 455 447 453L323 422Q312 419 312 405V121Q312 105 324 105Z"
            fill="url(#loom-glass-face)"
            stroke="#8d779d"
            strokeWidth="0.8"
          />
          <path
            d="M326 112 386 125 386 427 325 413Q319 411 319 401V123Q319 111 326 112Z"
            fill="url(#loom-glass-reflection)"
          />
          <path
            d="M470 129 478 132Q482 134 482 142V430Q482 438 475 440"
            stroke="#cb9ced"
            strokeWidth="1"
            strokeOpacity="0.6"
          />
        </g>
      </svg>
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
