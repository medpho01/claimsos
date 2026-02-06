import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

class S3Service {
    private client: S3Client
    private bucket: string

    constructor() {
        this.client = new S3Client({
            region: process.env.AWS_REGION || 'ap-south-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
            },
        })
        this.bucket = process.env.AWS_S3_BUCKET || 'hospital-app-images'
    }

    /**
     * Generate S3 key following folder structure: hospital/panel/patient/docType/timestamp_filename
     */
    generateKey(
        hospitalId: string,
        panelId: string,
        patientId: string,
        documentType: string,
        fileName: string
    ): string {
        const timestamp = Date.now()
        const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')

        return `${hospitalId}/${panelId}/${patientId}/${documentType}/${timestamp}_${sanitizedFileName}`
    }

    /**
     * Upload file to S3
     * @returns S3 key and public URL
     */
    async upload(
        key: string,
        buffer: Buffer,
        mimeType: string
    ): Promise<{ s3Key: string; s3Url: string }> {
        try {
            await this.client.send(
                new PutObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                    Body: buffer,
                    ContentType: mimeType,
                    ServerSideEncryption: 'AES256', // Encrypt at rest
                })
            )

            const s3Url = `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`

            console.log(`[S3] ✓ Uploaded: ${key}`)
            return { s3Key: key, s3Url }
        } catch (error: any) {
            console.error(`[S3] ✗ Upload failed:`, error.message)
            throw new Error(`S3 upload failed: ${error.message}`)
        }
    }

    /**
     * Get presigned URL for secure temporary access (1 hour expiry)
     */
    async getPresignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
            })

            const url = await getSignedUrl(this.client, command, { expiresIn })
            return url
        } catch (error: any) {
            console.error(`[S3] ✗ Presigned URL generation failed:`, error.message)
            throw new Error(`Failed to generate presigned URL: ${error.message}`)
        }
    }

    /**
     * Delete file from S3
     */
    async delete(key: string): Promise<void> {
        try {
            await this.client.send(
                new DeleteObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                })
            )

            console.log(`[S3] ✓ Deleted: ${key}`)
        } catch (error: any) {
            console.error(`[S3] ✗ Delete failed:`, error.message)
            throw new Error(`S3 delete failed: ${error.message}`)
        }
    }

    /**
     * List files in a patient's folder
     */
    async listPatientFiles(
        hospitalId: string,
        panelId: string,
        patientId: string,
        documentType?: string
    ): Promise<any[]> {
        try {
            const prefix = documentType
                ? `${hospitalId}/${panelId}/${patientId}/${documentType}/`
                : `${hospitalId}/${panelId}/${patientId}/`

            const command = new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix,
            })

            const response = await this.client.send(command)
            return response.Contents || []
        } catch (error: any) {
            console.error(`[S3] ✗ List files failed:`, error.message)
            return []
        }
    }

    /**
     * Download file from S3 (returns buffer)
     */
    async download(key: string): Promise<Buffer> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
            })

            const response = await this.client.send(command)
            const stream = response.Body as any

            // Convert stream to buffer
            const chunks: Uint8Array[] = []
            for await (const chunk of stream) {
                chunks.push(chunk)
            }

            return Buffer.concat(chunks)
        } catch (error: any) {
            console.error(`[S3] ✗ Download failed:`, error.message)
            throw new Error(`S3 download failed: ${error.message}`)
        }
    }
}

export default new S3Service()
