import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/env.js';

// Configura AWS SDK
const s3 = new AWS.S3({
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    region: config.AWS_REGION
});

// Sube la imagen a S3 y retorna la URL pública
export const uploadToPublicStorage = async (buffer, mimeType = "image/jpeg") => {
    const fileName = `comprobantes/${uuidv4()}.jpg`;
    const params = {
        Bucket: config.AWS_BUCKET_NAME,
        Key: fileName,
        Body: buffer,
        ContentType: mimeType
    };

    await s3.putObject(params).promise();

    // URL pública
    return `https://${config.AWS_BUCKET_NAME}.s3.${config.AWS_REGION}.amazonaws.com/${fileName}`;
};