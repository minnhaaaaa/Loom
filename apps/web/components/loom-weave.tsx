"use client";

import { useId, useRef } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

if (typeof window !== "undefined") gsap.registerPlugin(useGSAP);

const columns = Array.from({ length: 25 }, (_, i) => 384 + i * 18);
const rows = Array.from({ length: 17 }, (_, i) => 154 + i * 12);

/** A flat weaving draft: alternate warp crossings sit above the weft. */
export function LoomWeave({ active }: { active: boolean }) {
  const root = useRef<SVGSVGElement>(null);
  const id = useId().replaceAll(":", "");
  useGSAP(
    () => {
      if (!active) return;
      const media = gsap.matchMedia();
      media.add(
        "(prefers-reduced-motion: no-preference)",
        () => {
          gsap.from(".loom-thread-weft", {
            opacity: 0,
            duration: 1.25,
            stagger: 0.035,
            ease: "power2.out",
          });
          gsap.fromTo(
            ".loom-thread-highlight",
            {
              attr: { "stroke-dashoffset": 1300 },
              opacity: 0,
            },
            {
              attr: { "stroke-dashoffset": -1300 },
              opacity: 0.85,
              duration: 3.4,
              ease: "sine.inOut",
            },
          );
        },
        root,
      );
      return () => media.revert();
    },
    { scope: root, dependencies: [active], revertOnUpdate: true },
  );

  return (
    <svg
      ref={root}
      className="loom-weave"
      viewBox="0 0 1200 500"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={`${id}-fade`} cx="50%" cy="49%" r="58%">
          <stop offset="0.24" stopColor="white" />
          <stop offset="0.66" stopColor="white" stopOpacity="0.72" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}-mask`}>
          <rect width="1200" height="500" fill={`url(#${id}-fade)`} />
        </mask>
        <linearGradient
          id={`${id}-warp`}
          x1="0"
          y1="0"
          x2="0"
          y2="500"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5d426e" stopOpacity="0" />
          <stop offset="0.3" stopColor="#9c73bc" stopOpacity="0.5" />
          <stop offset="0.5" stopColor="#ddc6ef" />
          <stop offset="0.72" stopColor="#8b64a3" stopOpacity="0.6" />
          <stop offset="1" stopColor="#5d426e" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id={`${id}-weft`}
          x1="0"
          y1="0"
          x2="1200"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#7e409e" stopOpacity="0" />
          <stop offset="0.25" stopColor="#a274c5" stopOpacity="0.5" />
          <stop offset="0.48" stopColor="#c294e2" />
          <stop offset="0.68" stopColor="#a274c5" stopOpacity="0.6" />
          <stop offset="1" stopColor="#7e409e" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g mask={`url(#${id}-mask)`}>
        <g stroke={`url(#${id}-warp)`} strokeWidth="1">
          {columns.map((x, i) => {
            const top = 120 + i * 40;
            const bottom = 200 + i * 33;
            return (
              <path
                key={x}
                d={`M ${top} -60 C ${top} 44, ${x} 65, ${x} 154 L ${x} 346 C ${x} 429, ${bottom} 440, ${bottom} 570`}
                opacity={i % 4 === 0 ? 0.9 : 0.48}
              />
            );
          })}
        </g>
        <g stroke={`url(#${id}-weft)`} strokeWidth="1.15">
          {rows.map((y, i) => (
            <path
              className="loom-thread-weft"
              key={y}
              d={`M -80 ${50 + i * 25} C 160 ${50 + i * 25}, 270 ${y}, 384 ${y} L 816 ${y} C 950 ${y}, 1030 ${10 + i * 28}, 1280 ${10 + i * 28}`}
              opacity={i % 4 === 0 ? 0.95 : 0.58}
            />
          ))}
        </g>
        <g strokeLinecap="round">
          {columns.flatMap((x, column) =>
            rows
              .filter((_, row) => (row + column) % 2 === 0)
              .map((y) => (
                <g key={`${x}-${y}`}>
                  <path
                    d={`M ${x} ${y - 3} V ${y + 3}`}
                    stroke="#090909"
                    strokeWidth="4"
                  />
                  <path
                    d={`M ${x} ${y - 4} V ${y + 4}`}
                    stroke={`url(#${id}-warp)`}
                    strokeWidth="1"
                    opacity={column % 4 === 0 ? 0.95 : 0.66}
                  />
                </g>
              )),
          )}
        </g>
        <path
          className="loom-thread-highlight"
          d="M -80 250 C 160 250, 270 250, 384 250 L 816 250 C 950 250, 1030 234, 1280 234"
          stroke="#f0ddff"
          strokeWidth="1.3"
          strokeDasharray="90 1600"
          strokeDashoffset="-1300"
          opacity="0"
        />
      </g>
    </svg>
  );
}
