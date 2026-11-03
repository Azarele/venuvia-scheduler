import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` is a Node library; keep it out of the bundle.
  serverExternalPackages: ["pg"],
  // The browser test runs its own server; a separate build folder lets it run next to `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
