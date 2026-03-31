import { PrismaClient } from "@prisma/client";

function modifyDatabaseUrl(url, connectionLimit = 5) {
  if (!url) return url;
  // Remove existing connection_limit if present
  const urlWithoutLimit = url.replace(/[?&]connection_limit=\d+/, '');

  // Add or update connection_limit
  const separator = urlWithoutLimit.includes('?') ? '&' : '?';
  return `${urlWithoutLimit}${separator}connection_limit=${connectionLimit}`;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    const modifiedUrl = modifyDatabaseUrl(process.env.DATABASE_URL, 5);

    global.prismaGlobal = new PrismaClient({
      datasources: {
        db: {
          url: modifiedUrl,
        },
      },
      log: [],
    });
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient({
  datasources: {
    db: {
      url: modifyDatabaseUrl(process.env.DATABASE_URL, 5),
    },
  },
  log: [],
});

export default prisma;
