import { PrismaClient } from "@prisma/client";

function modifyDatabaseUrl(url, connectionLimit = 1) {
  if (!url) return url;
  // Remove existing connection_limit if present
  const urlWithoutLimit = url.replace(/[?&]connection_limit=\d+/, '');

  // Add or update connection_limit
  const separator = urlWithoutLimit.includes('?') ? '&' : '?';
  return `${urlWithoutLimit}${separator}connection_limit=${connectionLimit}`;
}

const connectionLimit = process.env.NODE_ENV === "production" ? 5 : 1;
const databaseUrl = modifyDatabaseUrl(process.env.DATABASE_URL, connectionLimit);

const prisma = globalThis.prisma ?? new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
  log: [],
});

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}

export default prisma;
