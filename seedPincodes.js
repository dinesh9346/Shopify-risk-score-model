import fs from 'fs';
import csv from 'csv-parser';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function importPincodes() {
  console.log("Reading the CSV file...");

  // We use a Map to efficiently deduplicate PIN codes in memory
  const uniquePincodes = new Map();

  // Step 1: Parse the CSV and keep only unique PIN codes
  await new Promise((resolve, reject) => {
    fs.createReadStream('pincode.csv') 
      .pipe(csv())
      .on('data', (row) => {
        // The government CSV headers are usually 'Pincode', 'OfficeName', etc.
        const postalCode = row.Pincode || row.pincode || row.PINCODE;

        // Only process valid 6-digit Indian PIN codes
        if (postalCode && /^[1-9][0-9]{5}$/.test(postalCode)) {
          
          // If we haven't seen this PIN yet, save the first post office we find for it.
          if (!uniquePincodes.has(postalCode)) {
            uniquePincodes.set(postalCode, {
              countryCode: "IN",
              postalCode: postalCode,
              placeName: row.OfficeName || row.officename || null,
              state: row.StateName || row.statename || null,
              district: row.District || row.district || null
            });
          }
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  const allRecords = Array.from(uniquePincodes.values());
  console.log(`Found ${allRecords.length} unique valid PIN codes. Starting database insert...`);

  // Step 2: Push to the database in chunks of 2000
  const chunkSize = 2000;
  let totalImported = 0;

  for (let i = 0; i < allRecords.length; i += chunkSize) {
    const batch = allRecords.slice(i, i + chunkSize);
    
    await prisma.India_valid_pincodes.createMany({
      data: batch,
      skipDuplicates: true // Acts as a final safety net
    });
    
    totalImported += batch.length;
    console.log(`Imported ${totalImported} / ${allRecords.length} PIN codes...`);
  }

  console.log(`Import Complete! Successfully saved ${totalImported} unique PIN codes to the database.`);
}

importPincodes()
  .catch(e => console.error("Error during import:", e))
  .finally(async () => {
    await prisma.$disconnect();
  });