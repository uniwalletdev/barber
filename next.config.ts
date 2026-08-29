import type { NextConfig } from "next";

const config: NextConfig = {
  // The queue is live data; nothing about it may be served from a static cache.
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
};

export default config;
