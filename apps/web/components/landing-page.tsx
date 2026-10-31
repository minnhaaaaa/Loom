"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { LoomSculpture } from "./loom-sculpture";
import { LandingIntro, type IntroPhase } from "./landing-intro";

if (typeof window !== "undefined") gsap.registerPlugin(useGSAP, ScrollTrigger);

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={diagonal ? "M5 15 15 5M5 5h10v10" : "M4 10h12m-5-5 5 5-5 5"}
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

export function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<IntroPhase>("loading");
  const [sceneReady, setSceneReady] = useState(false);
  const markSceneReady = useCallback(() => setSceneReady(true), []);
  const introComplete = phase === "complete";
  useGSAP(
    () => {
      if (!introComplete) return;
      const media = gsap.matchMedia();
      let active = true;
      media.add(
        "(prefers-reduced-motion: no-preference)",
        () => {
          gsap.to(".loom-hero-art", {
            y: 110,
            scale: 0.92,
            ease: "none",
            scrollTrigger: {
              trigger: ".loom-hero",
              start: "top top",
              end: "bottom top",
              scrub: 0.8,
            },
          });
          gsap.to(".loom-hero-title", {
            y: -55,
            ease: "none",
            scrollTrigger: {
              trigger: ".loom-hero",
              start: "top top",
              end: "bottom top",
              scrub: 0.8,
            },
          });
        },
        root,
      );
      void document.fonts.ready.then(() => {
        if (active) ScrollTrigger.refresh();
      });
      return () => {
        active = false;
        media.revert();
      };
    },
    { scope: root, dependencies: [introComplete], revertOnUpdate: true },
  );

  return (
    <div className="loom-landing" ref={root} data-intro-phase={phase}>
      <LandingIntro
        root={root}
        sceneReady={sceneReady}
        phase={phase}
        onPhaseChange={setPhase}
      />
      <noscript>
        <style>{`.loom-intro{display:none!important}.loom-landing .loom-site,.loom-landing .loom-hero-title,.loom-landing .loom-headline-letter,.loom-landing [data-entrance]{visibility:visible!important;opacity:1!important}`}</style>
      </noscript>
      <div className="loom-site">
        <a className="loom-skip" href="#loom-main">
          Skip to content
        </a>
        <header className="loom-nav" data-entrance>
          <Link href="/" className="loom-wordmark" aria-label="Loom home">
            LOOM
          </Link>
          <nav className="loom-nav-links" aria-label="Main navigation">
            <Link href="/login">Sign in</Link>
            <Link href="/register" className="loom-nav-action">
              Get started <Arrow diagonal />
            </Link>
          </nav>
        </header>

        <main id="loom-main" tabIndex={-1}>
          <section className="loom-hero" aria-labelledby="loom-hero-title">
            <div className="loom-hero-title">
              <p className="loom-label" data-entrance>
                For small analytics teams
              </p>
              <h1
                id="loom-hero-title"
                aria-label="Data requests. One workspace."
              >
                {["DATA REQUESTS.", "ONE WORKSPACE."].map((line) => (
                  <span
                    className="loom-headline-line"
                    aria-hidden="true"
                    key={line}
                  >
                    {Array.from(line).map((letter, index) => (
                      <span className="loom-headline-letter" key={index}>
                        {letter}
                      </span>
                    ))}
                  </span>
                ))}
              </h1>
            </div>
            <div className="loom-hero-art" data-entrance>
              <LoomSculpture onReady={markSceneReady} active={introComplete} />
            </div>
            <div className="loom-hero-actions" data-entrance>
              <Link href="/register" className="loom-button">
                Create your company <Arrow diagonal />
              </Link>
              <Link href="/login" className="loom-text-link">
                Sign in <Arrow diagonal />
              </Link>
            </div>
          </section>
        </main>

        <footer className="loom-footer" data-entrance>
          <Link href="/" aria-label="Loom home">
            LOOM
          </Link>
          <a
            href="https://github.com/minnhaaaaa/Loom"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open source <Arrow diagonal />
          </a>
        </footer>
      </div>
    </div>
  );
}
