"use client";

import Link from "next/link";
import { useRef } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { LoomSculpture } from "./loom-sculpture";

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
  useGSAP(
    () => {
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
          gsap.from(".loom-product-reveal", {
            autoAlpha: 0,
            y: 32,
            duration: 0.9,
            stagger: 0.12,
            ease: "power2.out",
            scrollTrigger: {
              trigger: ".loom-product",
              start: "top 78%",
              once: true,
            },
          });
          gsap.from(".loom-example-row", {
            autoAlpha: 0,
            x: 18,
            duration: 0.7,
            stagger: 0.12,
            ease: "power2.out",
            scrollTrigger: {
              trigger: ".loom-product-example",
              start: "top 82%",
              once: true,
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
    { scope: root },
  );

  return (
    <div className="loom-landing" ref={root}>
      <a className="loom-skip" href="#loom-main">
        Skip to content
      </a>
      <header className="loom-nav">
        <Link href="/" className="loom-wordmark" aria-label="Loom home">
          LOOM
        </Link>
        <nav className="loom-nav-links" aria-label="Main navigation">
          <Link href="/#product" className="loom-product-link">
            Product
          </Link>
          <Link href="/login">Sign in</Link>
          <Link href="/register" className="loom-nav-action">
            Get started <Arrow diagonal />
          </Link>
        </nav>
      </header>

      <main id="loom-main">
        <section className="loom-hero" aria-labelledby="loom-hero-title">
          <div className="loom-hero-title">
            <p className="loom-label">For small analytics teams</p>
            <h1 id="loom-hero-title">
              DATA REQUESTS.
              <br />
              ONE WORKSPACE.
            </h1>
          </div>
          <div className="loom-hero-art">
            <LoomSculpture />
          </div>
          <div className="loom-hero-actions">
            <Link href="/register" className="loom-button">
              Create your company <Arrow diagonal />
            </Link>
            <Link href="/app?demo=1" className="loom-text-link">
              Explore sample <Arrow diagonal />
            </Link>
          </div>
        </section>

        <section
          className="loom-product"
          id="product"
          aria-labelledby="loom-product-title"
        >
          <div className="loom-product-copy loom-product-reveal">
            <h2 id="loom-product-title">
              REQUEST.
              <br />
              ASSIGN.
              <br />
              DELIVER.
            </h2>
            <p>
              Clear ownership.
              <br />
              Shared context.
              <br />
              Progress you can see.
            </p>
            <Link href="/app?demo=1" className="loom-text-link">
              Open the desk <Arrow diagonal />
            </Link>
          </div>
          <div
            className="loom-product-example loom-product-reveal"
            aria-label="Illustrative request workspace"
          >
            <div className="loom-example-header">
              <span>Requests</span>
              <span>Sample data</span>
            </div>
            <div className="loom-example-row">
              <span>Weekly revenue</span>
              <span className="loom-request-state">In progress</span>
            </div>
            <div className="loom-example-row">
              <span>Campaign performance</span>
              <span className="loom-request-state">Ready</span>
            </div>
            <div className="loom-example-row">
              <span>Retention cohorts</span>
              <span className="loom-request-state">Needs context</span>
            </div>
            <p className="loom-exasol-credit">
              Workflow insights, powered by Exasol.
            </p>
          </div>
          <div className="loom-product-action loom-product-reveal">
            <Link href="/register" className="loom-text-link">
              Start with your team <Arrow diagonal />
            </Link>
          </div>
        </section>
      </main>

      <footer className="loom-footer">
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
  );
}
