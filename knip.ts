const config = {
  workspaces: {
    "apps/runtime": {
      entry: ["prisma/seed.ts"],
      project: ["src/**/*.ts", "prisma/**/*.ts", "test/**/*.ts"],
    },
    "apps/web": {
      entry: ["src/routeTree.gen.ts"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "apps/desktop": {
      entry: [],
      project: [],
    },
    "packages/shared-types": {
      project: ["src/**/*.ts"],
    },
    "packages/orchestrator-core": {
      project: ["src/**/*.ts"],
    },
    "packages/chat-timeline-core": {
      project: ["src/**/*.ts"],
    },
  },
};

export default config;
