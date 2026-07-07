const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');

let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    if (!process.env.B2_KEY_ID || !process.env.B2_APP_KEY || !process.env.B2_ENDPOINT) {
      throw new Error("Missing Backblaze B2 Environment Variables!");
    }
    
    s3Client = new S3Client({
      endpoint: process.env.B2_ENDPOINT,
      region: 'us-east-1', // B2 uses us-east-1 as default for S3 compat
      credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APP_KEY
      }
    });
  }
  return s3Client;
}

const BUCKET_NAME = process.env.B2_BUCKET_NAME;

async function uploadFileToB2(localFilePath, destinationKey) {
  const client = getS3Client();
  const fileStream = fs.createReadStream(localFilePath);
  const stat = fs.statSync(localFilePath);
  
  const uploadParams = {
    Bucket: BUCKET_NAME,
    Key: destinationKey,
    Body: fileStream,
    ContentLength: stat.size,
  };

  await client.send(new PutObjectCommand(uploadParams));
  return destinationKey;
}

async function listVideosFromB2() {
  const client = getS3Client();
  let isTruncated = true;
  let continuationToken = undefined;
  const files = [];

  while (isTruncated) {
    const params = {
      Bucket: BUCKET_NAME,
      ContinuationToken: continuationToken,
    };
    const response = await client.send(new ListObjectsV2Command(params));
    
    if (response.Contents) {
      for (const item of response.Contents) {
        files.push({
          name: item.Key,
          size: item.Size,
          lastModified: item.LastModified
        });
      }
    }
    
    isTruncated = response.IsTruncated;
    continuationToken = response.NextContinuationToken;
  }
  
  return files;
}

async function getPresignedVideoUrl(key) {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key
  });
  
  // URL valid for 12 hours
  return await getSignedUrl(client, command, { expiresIn: 43200 });
}

module.exports = {
  uploadFileToB2,
  listVideosFromB2,
  getPresignedVideoUrl
};
