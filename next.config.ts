import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` is a Node library; keep it out of the bundle.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
