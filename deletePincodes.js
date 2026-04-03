import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function deleteAllPincodes() {
  console.log("Starting deletion... This might take a few seconds.");
  
  try {
    // deleteMany({}) with an empty object tells Prisma to delete EVERY row in this table
    const result = await prisma.india_valid_pincodes.deleteMany({});
    
    console.log(` Success! Wiped ${result.count} PIN codes from the database.`);
  } catch (error) {
    console.error("Error deleting PIN codes:", error);
  } finally {
    await prisma.$disconnect();
  }
}

deleteAllPincodes();