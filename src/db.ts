import { PrismaClient } from "@prisma/client";

// Single shared client for the whole process, per APPLICATION_DESIGN.md §3.1's "one deployable,
// internally modular" service — every domain module imports this rather than constructing its
// own client.
export const db = new PrismaClient();
