import fs from 'fs';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function importPincodes() {
  console.log("Starting PIN code import...");
  
  const fileStream = fs.createReadStream('IN.txt');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let batch = [];
  let totalImported = 0;

  for await (const line of rl) {
    const columns = line.split('\t');
    
    // GeoNames format: [0]Country, [1]PostalCode, [2]PlaceName, [3]State, [4]StateCode, [5]District
    const postalCode = columns[1];
    
    // Only process valid 6-digit Indian PIN codes
    if (/^[1-9][0-9]{5}$/.test(postalCode)) {
      batch.push({
        countryCode: "IN",
        postalCode: postalCode,
        placeName: columns[2] || null,
        state: columns[3] || null,
        district: columns[5] || null
      });
    }

    // Push to database in chunks of 2000 to avoid overloading memory
    if (batch.length >= 2000) {
      await prisma.India_valid_pincodes.createMany({
        data: batch,
        skipDuplicates: true // GeoNames has multiple places per PIN, we just need the PIN to exist once
      });
      totalImported += batch.length;
      console.log(`Imported ${totalImported} PIN codes...`);
      batch = []; // Clear the batch
    }
  }

  // Push any remaining records in the final batch
  if (batch.length > 0) {
    await prisma.India_valid_pincodes.createMany({
      data: batch,
      skipDuplicates: true
    });
    totalImported += batch.length;
  }

  console.log(`✅ Import Complete! Successfully saved ${totalImported} unique PIN codes to the database.`);
  await prisma.$disconnect();
}

importPincodes().catch(e => {
  console.error("Error during import:", e);
  prisma.$disconnect();
});