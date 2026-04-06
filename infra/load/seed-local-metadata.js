const crypto = require('node:crypto');
const mongoose = require('mongoose');

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/eeetik';
const sampleUrl =
  process.env.LOCAL_SAMPLE_TIKTOK_URL ||
  'https://www.tiktok.com/@loadtest/video/7350000000000000000';
const fallbackUniqueId =
  process.env.LOCAL_SAMPLE_UNIQUE_ID ||
  `local-load-${crypto
    .createHash('sha1')
    .update(sampleUrl)
    .digest('hex')
    .slice(0, 16)}`;

async function seedLocalMetadata() {
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  if (!db) {
    throw new Error('MongoDB connection was not initialized');
  }

  const now = new Date();
  const metadataCollection = db.collection('tiktok_metadata');
  const downloadLogCollection = db.collection('download_logs');

  await metadataCollection.updateOne(
    { sourceUrl: sampleUrl },
    {
      $set: {
        postType: 'video',
        title: 'Local load test fixture',
        authorName: 'load-test',
        thumbnailKey: null,
        imageKeys: [],
        originalVideoUrl: 'https://cdn.example.invalid/video.mp4',
        originalAudioUrl: 'https://cdn.example.invalid/audio.mp3',
        originalImageUrls: [],
        rawMetadata: {
          seededFor: 'k6-local',
          updatedAt: now.toISOString(),
        },
        updatedAt: now,
      },
      $setOnInsert: {
        uniqueId: fallbackUniqueId,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  const seededMetadata = await metadataCollection.findOne({ sourceUrl: sampleUrl });
  if (!seededMetadata?.uniqueId) {
    throw new Error('Failed to resolve seeded metadata uniqueId');
  }

  await downloadLogCollection.deleteMany({ uniqueId: seededMetadata.uniqueId });

  console.log(`Seeded metadata URL: ${sampleUrl}`);
  console.log(`Seeded uniqueId: ${seededMetadata.uniqueId}`);
}

seedLocalMetadata()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
