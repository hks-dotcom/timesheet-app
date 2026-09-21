import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // We maintain CLAUDE.md by hand; don't let `next dev` append its own
  // generated agent-rules block to it.
  agentRules: false,
  // db/seedData.ts reads db/data/customers.csv at runtime (via
  // fs.readFileSync, not an import), so Next's file tracer can't discover
  // it on its own — every serverless function that can call buildSeed()
  // (any page, since ensureFreshDemoData() runs on every request) needs it
  // bundled alongside it for a Vercel deploy.
  outputFileTracingIncludes: {
    "/**": ["./db/data/customers.csv"],
  },
};

export default nextConfig;
