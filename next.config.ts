import type { NextConfig } from 'next';

const isTauri = process.env.TAURI_BUILD === '1';

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // Tauri consumes a static export; the web deployment on Vercel keeps the
  // default server build.
  ...(isTauri ? { output: 'export' as const } : {}),
  images: { unoptimized: isTauri },
};

export default nextConfig;
