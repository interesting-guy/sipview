import { collection, getDocs, doc, getDoc, query, orderBy } from 'firebase/firestore';
import { db } from './firebase';
import type { SIP } from '@/types/sip';
import { sampleSips } from '@/data/sample-sips'; // For potential seeding example

const SIPS_COLLECTION = 'sips';

export async function getAllSips(): Promise<SIP[]> {
  try {
    const sipsCollection = collection(db, SIPS_COLLECTION);
    // Order by creation date or ID by default
    const sipsQuery = query(sipsCollection, orderBy('createdAt', 'desc'));
    const sipsSnapshot = await getDocs(sipsQuery);
    
    if (sipsSnapshot.empty) {
      // Optional: Basic seeding if collection is empty (for demo purposes)
      // In a real app, seeding should be a separate, deliberate process.
      // console.log("SIPs collection is empty. Consider seeding with sample data.");
      // You could call a seedFunction here if desired for a quick demo setup.
      // await seedSampleData(); // Example: see below
      // And then re-fetch:
      // const seededSnapshot = await getDocs(sipsQuery);
      // return seededSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SIP));
      return []; // Return empty or sample data if desired
    }

    const sips = sipsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        // Ensure date fields are strings if they are Timestamps
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt,
        updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt,
        mergedAt: data.mergedAt?.toDate ? data.mergedAt.toDate().toISOString() : data.mergedAt,
      } as SIP;
    });
    return sips;
  } catch (error) {
    console.error("Error fetching all SIPs:", error);
    // It's good practice to inform the user or log this error appropriately.
    // For now, we'll return an empty array to prevent app crash.
    return [];
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  try {
    const sipDocRef = doc(db, SIPS_COLLECTION, id);
    const sipSnapshot = await getDoc(sipDocRef);

    if (sipSnapshot.exists()) {
      const data = sipSnapshot.data();
      return {
        id: sipSnapshot.id,
        ...data,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt,
        updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt,
        mergedAt: data.mergedAt?.toDate ? data.mergedAt.toDate().toISOString() : data.mergedAt,
      } as SIP;
    } else {
      console.warn(`SIP with id ${id} not found.`);
      return null;
    }
  } catch (error) {
    console.error(`Error fetching SIP with id ${id}:`, error);
    return null;
  }
}

// Example seeding function (call deliberately, not on every empty fetch)
// import { writeBatch } from 'firebase/firestore';
// export async function seedSampleData() {
//   const sipsCollection = collection(db, SIPS_COLLECTION);
//   const existingSips = await getDocs(sipsCollection);
//   if (!existingSips.empty) {
//     console.log("Data already exists. Seeding skipped.");
//     return;
//   }

//   const batch = writeBatch(db);
//   sampleSips.forEach(sipData => {
//     const docRef = doc(sipsCollection, sipData.id);
//     // Convert string dates to Firestore Timestamps for proper querying if needed
//     const firestoreSipData = {
//       ...sipData,
//       createdAt: new Date(sipData.createdAt),
//       updatedAt: new Date(sipData.updatedAt),
//       mergedAt: sipData.mergedAt ? new Date(sipData.mergedAt) : undefined,
//     };
//     batch.set(docRef, firestoreSipData);
//   });

//   try {
//     await batch.commit();
//     console.log("Sample SIPs successfully seeded to Firestore.");
//   } catch (error) {
//     console.error("Error seeding sample SIPs:", error);
//   }
// }

// To use the seeding function, you might expose it via an API route or a CLI command.
// For example, in a Next.js API route (e.g., /api/seed-data):
// export default async function handler(req, res) {
//   if (req.method === 'POST') {
//     try {
//       await seedSampleData();
//       res.status(200).json({ message: 'Data seeded successfully' });
//     } catch (error) {
//       res.status(500).json({ message: 'Error seeding data', error: error.message });
//     }
//   } else {
//     res.setHeader('Allow', ['POST']);
//     res.status(405).end(`Method ${req.method} Not Allowed`);
//   }
// }
// Then you could trigger this with a POST request to /api/seed-data.
// Remember to secure such an endpoint appropriately in a production environment.
