import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  // Project site served under https://enixcode.github.io/light-run/.
  basePath: '/light-run',
  trailingSlash: true,
  // Static export cannot use the Next image optimizer.
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default withMDX(config);
