/**
 * Photo Annotator Service — Tier 4 of the Hybrid OCR Pipeline
 * 
 * Uses Gemini 2.0 Flash for clinical photo and X-ray descriptions.
 * No text extraction — purely visual analysis and annotation.
 */

import { GoogleGenerativeAI, type Part } from '@google/generative-ai'

// --- Types ---

export interface PhotoAnnotationResult {
    success: boolean
    imageType: string
    extractedJson: Record<string, any>
    costEstimateCents: number
}

// --- Prompt ---

const ANNOTATION_PROMPT = `You are a medical image analyst. Describe this clinical photograph for a medical claims report.

For X-rays: describe what you see (implant position, alignment, bone condition, any abnormalities)
For wound photos: describe healing status, suture condition, any visible concerns  
For clinical photos: describe the anatomical area, visible condition, range of motion indicators
For intra-operative photos: describe the surgical field, implant placement, tissue condition

Return this exact JSON:
{
  "image_type": "xray" | "wound_photo" | "clinical_photo" | "intra_op_photo",
  "anatomical_region": string,
  "description": string (2-3 sentences, clinical language),
  "findings": string[] (list of key observations),
  "concerns": string[] | null (anything abnormal or noteworthy),
  "confidence": number
}

Return ONLY valid JSON, no markdown, no explanation.`

// --- Service ---

class PhotoAnnotatorService {
    private genAI: GoogleGenerativeAI
    private model: any

    constructor() {
        const apiKey = process.env.GEMINI_API_KEY
        if (!apiKey) throw new Error('[OCR PhotoAnnotator] GEMINI_API_KEY not set')

        this.genAI = new GoogleGenerativeAI(apiKey)
        this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
    }

    /**
     * Annotate a single clinical photo or X-ray.
     */
    async annotate(buffer: Buffer, mimeType: string): Promise<PhotoAnnotationResult> {
        try {
            const parts: Part[] = [
                { text: ANNOTATION_PROMPT },
                {
                    inlineData: {
                        mimeType: mimeType as any,
                        data: buffer.toString('base64'),
                    },
                },
            ]

            const result = await this.model.generateContent(parts)
            const responseText = result.response.text()

            const jsonStr = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
            const extractedJson = JSON.parse(jsonStr)

            console.log(`[OCR Photo] ✓ Annotated ${extractedJson.image_type}: ${extractedJson.anatomical_region}`)

            return {
                success: true,
                imageType: extractedJson.image_type || 'clinical_photo',
                extractedJson,
                costEstimateCents: 0.1, // ~$0.001 per image
            }
        } catch (error: any) {
            console.error(`[OCR Photo] ✗ Annotation failed:`, error.message)
            return {
                success: false,
                imageType: 'unknown',
                extractedJson: {},
                costEstimateCents: 0.1,
            }
        }
    }

    /**
     * Annotate multiple photos (processed individually for better results).
     */
    async annotateAll(
        images: { buffer: Buffer; mimeType: string }[]
    ): Promise<PhotoAnnotationResult[]> {
        const results: PhotoAnnotationResult[] = []

        // Process in batches of 3 to avoid rate limits
        const BATCH_SIZE = 3
        for (let i = 0; i < images.length; i += BATCH_SIZE) {
            const batch = images.slice(i, i + BATCH_SIZE)
            const batchResults = await Promise.all(
                batch.map(img => this.annotate(img.buffer, img.mimeType))
            )
            results.push(...batchResults)
        }

        return results
    }
}

export default new PhotoAnnotatorService()
