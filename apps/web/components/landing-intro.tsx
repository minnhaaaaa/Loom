"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

export type IntroPhase =
  "loading" | "wordmark" | "headline" | "revealing" | "complete";

/** An optional, synthesized glass chime. Never delays the visual sequence. */
function chime(context: AudioContext) {
  if (context.state !== "running") return;
  const now = context.currentTime;
  [1046.5, 2093, 3139.5].forEach((frequency, index) => {
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.075 / (index + 1), now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2 - index * 0.15);
    tone.connect(gain);
    gain.connect(context.destination);
    tone.start(now);
    tone.stop(now + 1.3);
    tone.onended = () => {
      tone.disconnect();
      gain.disconnect();
    };
  });
}

export function LandingIntro({
  root,
  sceneReady,
  phase,
  onPhaseChange,
}: {
  root: RefObject<HTMLDivElement | null>;
  sceneReady: boolean;
  phase: IntroPhase;
  onPhaseChange: (phase: IntroPhase) => void;
}) {
  const [fontsReady, setFontsReady] = useState(false);
  const [deadlineReached, setDeadlineReached] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [soundAvailable, setSoundAvailable] = useState(true);
  const audio = useRef<AudioContext | null>(null);
  const soundEnabled = useRef(false);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const finished = useRef(false);
  const started = useRef(false);
  const mounted = useRef(false);
  const focusAfterIntro = useRef(false);
  const introIsOpen = phase !== "complete";

  const finish = useCallback(
    (focusContent = false) => {
      if (finished.current) return;
      finished.current = true;
      focusAfterIntro.current =
        focusContent ||
        Boolean(
          root.current
            ?.querySelector(".loom-intro")
            ?.contains(document.activeElement),
        );
      timeline.current?.kill();
      const context = audio.current;
      audio.current = null;
      soundEnabled.current = false;
      void context?.close().catch(() => {});
      const elements = root.current?.querySelectorAll(
        ".loom-hero-title, .loom-headline-letter, [data-entrance]",
      );
      if (elements)
        gsap.set(elements, { clearProps: "opacity,visibility,transform" });
      onPhaseChange("complete");
    },
    [onPhaseChange, root],
  );

  useEffect(() => {
    mounted.current = true;
    let live = true;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const respectMotion = () => {
      if (motion.matches) finish();
    };
    motion.addEventListener("change", respectMotion);
    if (motion.matches || window.location.hash) finish();
    void document.fonts.ready.then(() => {
      if (live) setFontsReady(true);
    });
    // A failed asset must never trap someone behind the opening screen.
    const deadline = window.setTimeout(() => setDeadlineReached(true), 5000);
    return () => {
      mounted.current = false;
      live = false;
      window.clearTimeout(deadline);
      motion.removeEventListener("change", respectMotion);
      const context = audio.current;
      audio.current = null;
      soundEnabled.current = false;
      void context?.close().catch(() => {});
    };
  }, [finish]);

  useEffect(() => {
    if (!introIsOpen) {
      if (!focusAfterIntro.current) return;
      // Run after the previous effect restores the page's interactive state.
      const frame = requestAnimationFrame(() => {
        if (!mounted.current) return;
        focusAfterIntro.current = false;
        root.current
          ?.querySelector<HTMLElement>("main")
          ?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    const previous = document.body.style.overflow;
    const site = root.current?.querySelector<HTMLElement>(".loom-site");
    const previousInert = site?.inert ?? false;
    if (site) site.inert = true;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(true);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previous;
      if (site) site.inert = previousInert;
      document.removeEventListener("keydown", escape);
    };
  }, [introIsOpen, finish, root]);

  const ready = (fontsReady && sceneReady) || deadlineReached;
  useGSAP(
    () => {
      if (!ready || finished.current || started.current) return;
      started.current = true;
      const heading = root.current
        ?.querySelector("h1")
        ?.getBoundingClientRect();
      const headlineOffset = heading
        ? window.innerHeight / 2 - heading.top - heading.height / 2
        : 0;
      onPhaseChange("wordmark");
      timeline.current = gsap
        .timeline({ onComplete: () => finish() })
        .to(
          ".loom-intro-letter",
          { display: "inline", opacity: 1, duration: 0.001, stagger: 0.16 },
          0.12,
        )
        .call(
          () => {
            try {
              if (soundEnabled.current && audio.current) chime(audio.current);
            } catch {
              // Audio may become unavailable after a successful user gesture.
              soundEnabled.current = false;
              setSoundOn(false);
              setSoundAvailable(false);
            }
          },
          [],
          0.68,
        )
        .to(
          ".loom-intro-word",
          { autoAlpha: 0, y: -8, duration: 0.35, ease: "power2.in" },
          1.2,
        )
        .call(() => onPhaseChange("headline"))
        .to(".loom-intro-screen", { autoAlpha: 0, duration: 0.35 })
        .set(".loom-hero-title", { autoAlpha: 1, y: headlineOffset })
        .to(".loom-headline-letter", {
          opacity: 1,
          duration: 0.001,
          stagger: 0.045,
        })
        .call(() => onPhaseChange("revealing"), [], "+=0.65")
        .to(".loom-hero-title", { y: 0, duration: 0.8, ease: "power3.inOut" })
        .fromTo(
          "[data-entrance]",
          { autoAlpha: 0, y: 10 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.8,
            stagger: 0.06,
            ease: "power2.out",
          },
          "<+=0.2",
        );
    },
    { scope: root, dependencies: [ready] },
  );

  async function toggleSound() {
    if (finished.current || !mounted.current) return;
    if (soundEnabled.current) {
      soundEnabled.current = false;
      setSoundOn(false);
      return;
    }
    try {
      // Creation/resume stays inside this click, as required by browser autoplay policy.
      if (!audio.current || audio.current.state === "closed")
        audio.current = new AudioContext();
      const context = audio.current;
      await context.resume();
      if (!mounted.current || finished.current || audio.current !== context)
        return;
      const enabled = context.state === "running";
      soundEnabled.current = enabled;
      setSoundOn(enabled);
      setSoundAvailable(enabled);
    } catch {
      if (!mounted.current || finished.current) return;
      soundEnabled.current = false;
      setSoundAvailable(false);
    }
  }

  if (!introIsOpen) return null;
  return (
    <div className="loom-intro" aria-label="Loom opening">
      <div className="loom-intro-screen">
        <div
          className="loom-intro-loading"
          role="status"
          hidden={phase !== "loading"}
        >
          <span className="loom-loading-line" aria-hidden="true" />
          Loading
        </div>
        <div
          className="loom-intro-word"
          role="img"
          aria-label="Loom"
          hidden={phase === "loading"}
        >
          <span aria-hidden="true">
            {"LOOM".split("").map((letter, index) => (
              <span className="loom-intro-letter" key={index}>
                {letter}
              </span>
            ))}
          </span>
          <span className="loom-intro-caret" aria-hidden="true" />
        </div>
      </div>
      <div className="loom-intro-controls">
        <button
          type="button"
          onClick={() => void toggleSound()}
          aria-pressed={soundOn}
          disabled={!soundAvailable}
        >
          {!soundAvailable
            ? "Sound unavailable"
            : soundOn
              ? "Sound on"
              : "Enable sound"}
        </button>
        <button type="button" onClick={() => finish(true)}>
          Skip intro
        </button>
      </div>
    </div>
  );
}
