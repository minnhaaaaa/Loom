"use client";

import { useEffect } from "react";

/** Use a browser navigation: Next normalizes loopback hosts in server redirects. */
export function LocalOrigin({
  canonicalLoopback,
}: {
  canonicalLoopback: boolean;
}) {
  useEffect(() => {
    if (!canonicalLoopback || window.location.hostname !== "localhost") return;
    const target = new URL(window.location.href);
    target.hostname = "127.0.0.1";
    window.location.replace(target.href);
  }, [canonicalLoopback]);
  return null;
}
