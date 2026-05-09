import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  serverExternalPackages: ["gl", "earcut", "@mongodb-js/zstd"],
};

export default nextConfig;
