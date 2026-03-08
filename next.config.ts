import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config, { dev }) => {
    if (dev) {
      const existingIgnored = config.watchOptions?.ignored;
      const ignoredList = Array.isArray(existingIgnored)
        ? existingIgnored
        : existingIgnored
          ? [existingIgnored]
          : [];

      config.watchOptions = {
        ...config.watchOptions,
        // Helps on Windows when very large local datasets are present in-repo.
        ignored: [
          ...ignoredList,
          "**/data/raw/**",
          "**/data/processed/**",
        ],
      };
    }

    return config;
  },
};

export default nextConfig;
